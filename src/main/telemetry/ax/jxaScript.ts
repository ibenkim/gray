/**
 * Long-lived JXA sensor for macOS input + Accessibility.
 *
 * Emits one NDJSON line per observation on **real stdout**. `console.log` must
 * never be used here: under `osascript -l JavaScript` it writes to stderr, so the
 * host would never receive a single line.
 *
 * Line kinds (pb = NSPasteboard changeCount, metadata only):
 *   {k:'ready', trusted, monitors}   — handshake + capability report
 *   {k:'ax', …, valueTail?}          — focused element / window sample (on change)
 *   {k:'key', code, chars, base, …}  — a physical key press
 *   {k:'click', x, y, role, label, …}— a mouse press with its Accessibility target
 *   {k:'copy', app, pb, cut, text, types} — clipboard after a verified in-scope Cmd/Ctrl+C (cut: X)
 *   {k:'stats', keys, clicks}        — monitor callback counters (debug heartbeat)
 *
 * Non-secure text fields include `valueTail` (last ≤160 chars of AXValue) so the
 * host can recover typing when NSEvent monitors are silent. Secure fields (role or subrole
 * AXSecureTextField, or global secure input) never include a value, tail, length or chars;
 * an unavailable secure-input check counts as secure. The host aggregates and redacts.
 */
/**
 * Parent lifetime (M2). The sensor must stop reading once the host is gone: after the
 * parent exits the child is re-parented (getppid changes, usually to launchd = 1), and
 * writes to the closed stdout pipe throw. Either condition exits before another read.
 * Exported so a no-capture fixture can exercise it without starting any monitor.
 */
export const JXA_PARENT_LIFETIME = `
ObjC.import('stdlib');
ObjC.import('unistd');
var PARENT_PID = 0;
try { PARENT_PID = parseInt($.getenv('GRAY_JXA_PARENT_PID'), 10) || 0; } catch (eEnv) {}
function parentAlive() {
  var p = $.getppid();
  return p !== 1 && (PARENT_PID === 0 || p === PARENT_PID);
}
function exitIfOrphaned() {
  if (!parentAlive()) $.exit(0);
}
`

/**
 * App scope (M3-C), checked before any content read. Mirrors `appInScope` in ../providers.ts
 * (host re-checks at ingest). No/invalid policy, unknown or excluded app = read nothing.
 */
const JXA_SCOPE_POLICY = `
var SCOPE = null;
try { SCOPE = JSON.parse(String($.getenv('GRAY_JXA_SCOPE'))); } catch (eScope) { SCOPE = null; }
function appAllowed(name) {
  if (!SCOPE || !SCOPE.self || !SCOPE.deny || !name) return false;
  var lower = String(name).toLowerCase();
  var i;
  for (i = 0; i < SCOPE.self.length; i++) if (lower === SCOPE.self[i]) return false;
  for (i = 0; i < SCOPE.deny.length; i++) if (lower.indexOf(SCOPE.deny[i]) !== -1) return false;
  if (!SCOPE.allow) return true;
  for (i = 0; i < SCOPE.allow.length; i++) if (lower.indexOf(SCOPE.allow[i]) !== -1) return true;
  return false;
}
`

export const JXA_SENSOR_SCRIPT = `
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');
${JXA_PARENT_LIFETIME}
${JXA_SCOPE_POLICY}
var STDOUT = $.NSFileHandle.fileHandleWithStandardOutput;

function writeLine(text) {
  try {
    var str = $.NSString.alloc.initWithUTF8String(text + "\\n");
    STDOUT.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
  } catch (e) {
    /* stdout closed: the host is gone, so stop sampling entirely */
    $.exit(0);
  }
}

function emit(obj) {
  try { writeLine(JSON.stringify(obj)); } catch (e) {}
}

var SAMPLE_MS = 400;
/* ~60Hz so short clicks are not missed between polls. */
var PUMP_SECONDS = 0.016;
var MAX_ANCESTORS = 3;

/* Roles whose AXValue is user-entered text. Secure fields: nothing. Others: length + tail. */
var TEXT_ROLES = {
  AXTextField: 1, AXTextArea: 1, AXComboBox: 1, AXSearchField: 1, AXSecureTextField: 1
};
/* Roles whose AXValue is a safe label (e.g. a button's own title). */
var LABEL_VALUE_ROLES = {
  AXButton: 1, AXMenuItem: 1, AXMenuButton: 1, AXPopUpButton: 1, AXRadioButton: 1,
  AXCheckBox: 1, AXLink: 1, AXStaticText: 1, AXTab: 1
};

/* ── secure input (password fields) ── */
var secureBound = false;
try {
  ObjC.bindFunction('IsSecureEventInputEnabled', ['bool', []]);
  secureBound = true;
} catch (e) {}

/* Fail closed: without a working check, input counts as secure. */
function secureInputActive() {
  if (!secureBound) return true;
  try { return $.IsSecureEventInputEnabled() ? true : false; } catch (e) { return true; }
}

function isSecureRole(role, subrole) {
  return role === 'AXSecureTextField' || subrole === 'AXSecureTextField';
}

/* AX errors that prove an attribute is absent (an ordinary field has no subrole). Any other
   failure leaves the element's security unproven. */
var AX_NO_VALUE = -25212;
var AX_ATTRIBUTE_UNSUPPORTED = -25205;
function axProbe(el, name) {
  if (!el) return { ok: false };
  try {
    var out = Ref();
    var err = $.AXUIElementCopyAttributeValue(el, cfstr(name), out);
    if (err === 0) return { ok: true, value: out[0] };
    if (err === AX_NO_VALUE || err === AX_ATTRIBUTE_UNSUPPORTED) return { ok: true, value: null };
  } catch (e) {}
  return { ok: false };
}

/* Fail closed: an element is ordinary only when its role is known and its subrole is either
   known or provably absent. Unknown, unreadable or missing context counts as secure. */
function elementSecure(el) {
  var role = axProbe(el, 'AXRole');
  var roleText = role.ok && role.value != null ? jsString(role.value) : null;
  if (roleText == null) return true;
  var subrole = axProbe(el, 'AXSubrole');
  if (!subrole.ok) return true;
  if (subrole.value == null) return isSecureRole(roleText, null);
  // Present but unconvertible is not evidence of an ordinary field.
  var subroleText = jsString(subrole.value);
  if (subroleText == null) return true;
  return isSecureRole(roleText, subroleText);
}

/* The focused element itself, not the last sample (focus race). No focus = unproven. */
function focusedSecure() {
  if (secureInputActive()) return true;
  var focus = axProbe(systemWide(), 'AXFocusedUIElement');
  if (!focus.ok || focus.value == null) return true;
  return elementSecure(focus.value);
}

/* ── frontmost app via NSWorkspace (no Apple Events, safe per-keystroke) ── */
function frontApp() {
  try {
    var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!app) return { name: null, bundleId: null };
    var name = null, bundleId = null;
    try { name = String(app.localizedName.js); } catch (e) {}
    try { bundleId = String(app.bundleIdentifier.js); } catch (e2) {}
    return { name: name || null, bundleId: bundleId || null };
  } catch (e3) {
    return { name: null, bundleId: null };
  }
}

/* ── pasteboard (M3-B): changeCount is metadata; content is read only for a verified copy ── */
function pasteboardCount() {
  try { return Number($.NSPasteboard.generalPasteboard.changeCount); } catch (e) { return null; }
}

/*
 * A copy is attributed to the chord's app only when the pasteboard changes exactly once while
 * that app stays frontmost and in scope; no change (no-op copy), several writers, an app switch
 * or a change during the read discards it. Content is read once, here, never on a timer.
 * ponytail: macOS exposes no pasteboard writer, so a background app writing during a no-op copy
 * is still attributed to the front app.
 */
var COPY_SETTLE_MS = 500;
var COPY_TEXT_MAX = 20000;
var pendingCopy = null;

function checkCopy() {
  if (!pendingCopy) return;
  var front = frontApp();
  /* Expired, or the chord's app left the front even briefly: provenance is lost. */
  if (Date.now() > pendingCopy.deadline || front.name !== pendingCopy.app || !appAllowed(front.name)) {
    pendingCopy = null;
    return;
  }
  var pb = pasteboardCount();
  if (pb === pendingCopy.pb) return;
  var copy = pendingCopy;
  pendingCopy = null;
  if (pb !== copy.pb + 1 || secureInputActive()) return;
  var text = null;
  var types = [];
  try {
    var board = $.NSPasteboard.generalPasteboard;
    var s = board.stringForType($.NSPasteboardTypeString);
    if (s) text = String(s.js).slice(0, COPY_TEXT_MAX);
    var t = board.types;
    for (var i = 0; t && i < t.count; i++) types.push(String(t.objectAtIndex(i).js));
  } catch (e) {
    return;
  }
  if (pasteboardCount() !== pb) return;
  emit({ k: 'copy', app: copy.app, appBundleId: copy.bundleId, pb: pb, cut: copy.cut === true, text: text, types: types });
}

/* ── Accessibility C API: resolves the element under the pointer ── */
var CF_UTF8 = 0x08000100;
var systemWideEl = null;

function systemWide() {
  if (!systemWideEl) {
    try { systemWideEl = $.AXUIElementCreateSystemWide(); } catch (e) { systemWideEl = null; }
  }
  return systemWideEl;
}

function cfstr(text) {
  return $.CFStringCreateWithCString($(), text, CF_UTF8);
}

function axCopy(el, name) {
  if (!el) return null;
  try {
    var out = Ref();
    if ($.AXUIElementCopyAttributeValue(el, cfstr(name), out) !== 0) return null;
    return out[0];
  } catch (e) {
    return null;
  }
}

/**
 * Convert CFString / NSString / JS primitive to a real string.
 * Never return "[object Ref]" — that means the ObjC bridge failed to unwrap.
 */
function jsString(val) {
  if (val === undefined || val === null) return null;
  try {
    if (typeof val === 'string') return val.length ? val : null;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  } catch (e0) {}
  try {
    if (val.js !== undefined && typeof val.js === 'string') {
      return val.js.length ? val.js : null;
    }
  } catch (e1) {}
  try {
    var ns = $.NSString.stringWithString(val);
    if (ns && ns.js !== undefined) {
      var fromNs = String(ns.js);
      if (fromNs && fromNs.indexOf('[object ') !== 0) return fromNs;
    }
  } catch (e2) {}
  try {
    var unwrapped = ObjC.unwrap(val);
    if (unwrapped === null || unwrapped === undefined) return null;
    if (typeof unwrapped === 'string') return unwrapped.length ? unwrapped : null;
    if (unwrapped && typeof unwrapped.js === 'string') {
      return unwrapped.js.length ? unwrapped.js : null;
    }
    var text = String(unwrapped);
    if (!text.length || text.indexOf('[object ') === 0) return null;
    return text;
  } catch (e3) {
    return null;
  }
}

function axString(el, name) {
  var raw = axCopy(el, name);
  if (raw == null) return null;
  return jsString(raw);
}

function elementAtPoint(x, y) {
  var sys = systemWide();
  if (!sys) return null;
  try {
    var out = Ref();
    if ($.AXUIElementCopyElementAtPosition(sys, x, y, out) !== 0) return null;
    return out[0];
  } catch (e) {
    return null;
  }
}

/** Name of the app owning an AX element (process metadata only), or null. */
function elementAppName(el) {
  try {
    var pid = Ref();
    if ($.AXUIElementGetPid(el, pid) !== 0) return null;
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid[0]);
    return app ? String(app.localizedName.js) : null;
  } catch (e) {
    return null;
  }
}

/**
 * The in-scope element under the pointer, or null. The front app and the element's own app
 * (a background window can be another app's) must both be in scope; an unresolvable owner is
 * unknown and therefore denied.
 */
function scopedElementAt(pt, front) {
  if (!pt || !appAllowed(front.name)) return null;
  var el = elementAtPoint(pt.x, pt.y);
  if (!el) return null;
  var owner = elementAppName(el);
  if (!owner || !appAllowed(owner)) return null;
  return el;
}

/** Identity of a clicked element: role + best label + ancestor + list context. */
function describeElement(el) {
  if (!el) return null;
  var role = axString(el, 'AXRole');
  if (!role) return null;

  var identifier = axString(el, 'AXIdentifier');
  var label =
    axString(el, 'AXTitle') ||
    axString(el, 'AXDescription') ||
    identifier;

  /* A button's AXValue is its caption; a text field's AXValue is private content. */
  if (!label && LABEL_VALUE_ROLES[role] && !TEXT_ROLES[role]) {
    var asLabel = axString(el, 'AXValue');
    if (asLabel && asLabel.length <= 80) label = asLabel;
  }

  var valueLength = null;
  if (TEXT_ROLES[role] && !elementSecure(el) && !secureInputActive()) {
    var val = axString(el, 'AXValue');
    valueLength = val ? val.length : 0;
  }

  var enabled = null;
  try {
    var en = Ref();
    if ($.AXUIElementCopyAttributeValue(el, cfstr('AXEnabled'), en) === 0) {
      enabled = !!en[0];
    }
  } catch (eEn) {}

  var path = [];
  var cur = el;
  var containerRole = null;
  var containerLabel = null;
  var rowIndex = null;
  var siblingCount = null;
  var windowBounds = null;
  /* The clicked element's own window: its frame and title identify where the point belongs. */
  var windowTitle = null;
  for (var i = 0; i < MAX_ANCESTORS + 4 && path.length < 8; i++) {
    cur = axCopy(cur, 'AXParent');
    if (!cur) break;
    var pRole = axString(cur, 'AXRole');
    var pLabel = axString(cur, 'AXTitle') || axString(cur, 'AXDescription');
    if (pLabel) path.push(pLabel.slice(0, 80));
    if (!windowBounds && pRole === 'AXWindow') {
      windowBounds = axFrameBounds(cur);
      windowTitle = axString(cur, 'AXTitle');
    }
    if (!containerRole && pRole && /AX(Table|List|Outline|ScrollArea|Grid|Row|Cell)/.test(pRole)) {
      containerRole = pRole;
      containerLabel = pLabel ? pLabel.slice(0, 120) : null;
      try {
        var kids = Ref();
        if ($.AXUIElementCopyAttributeValue(cur, cfstr('AXChildren'), kids) === 0 && kids[0]) {
          siblingCount = kids[0].length;
          for (var si = 0; si < kids[0].length; si++) {
            if (kids[0][si] && el && $.CFEqual(kids[0][si], el)) {
              rowIndex = si;
              break;
            }
          }
        }
      } catch (eKids) {}
    }
  }
  if (!windowBounds && role === 'AXWindow') {
    windowBounds = axFrameBounds(el);
    windowTitle = axString(el, 'AXTitle');
  }

  return {
    role: role,
    subrole: axString(el, 'AXSubrole'),
    identifier: identifier ? identifier.slice(0, 120) : null,
    label: label ? label.slice(0, 120) : null,
    valueLength: valueLength,
    enabled: enabled,
    path: path,
    bounds: axFrameBounds(el),
    windowBounds: windowBounds,
    windowTitle: windowTitle ? windowTitle.slice(0, 300) : null,
    containerRole: containerRole,
    containerLabel: containerLabel,
    rowIndex: rowIndex,
    siblingCount: siblingCount
  };
}

/** Best-effort CGRect from AXFrame (top-left origin). */
function axFrameBounds(el) {
  if (!el) return null;
  try {
    var out = Ref();
    if ($.AXUIElementCopyAttributeValue(el, cfstr('AXFrame'), out) !== 0) return null;
    var axv = out[0];
    if (!axv) return null;
    var rect = Ref();
    /* kAXValueCGRectType === 3 */
    if (!$.AXValueGetValue(axv, 3, rect)) return null;
    var r = rect[0];
    if (!r) return null;
    var x = Math.round(r.origin.x);
    var y = Math.round(r.origin.y);
    var w = Math.round(r.size.width);
    var h = Math.round(r.size.height);
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w < 0 || h < 0) return null;
    return { x: x, y: y, width: w, height: h };
  } catch (e) {
    return null;
  }
}

/* ── periodic focus/selection sample via System Events ── */
function attr(el, name) {
  try {
    if (!el) return null;
    var v = el.attributes.byName(name);
    if (!v) return null;
    return jsString(v.value());
  } catch (e) {
    return null;
  }
}

function attrLen(el, name) {
  try {
    if (!el) return null;
    var v = el.attributes.byName(name);
    if (!v) return null;
    var text = jsString(v.value());
    if (text === null) return null;
    return text.length;
  } catch (e) {
    return null;
  }
}

/** Last chars of a text field — host diffs these when key monitors are silent. */
var VALUE_TAIL_MAX = 160;
function attrTail(el, name) {
  try {
    if (!el) return null;
    var v = el.attributes.byName(name);
    if (!v) return null;
    var text = jsString(v.value());
    if (text === null) return null;
    if (!text.length) return '';
    return text.length > VALUE_TAIL_MAX ? text.slice(-VALUE_TAIL_MAX) : text;
  } catch (e) {
    return null;
  }
}

function labelOf(el) {
  if (!el) return null;
  return attr(el, 'AXTitle') || attr(el, 'AXDescription') || attr(el, 'AXIdentifier') || null;
}

function collectAncestors(el, max) {
  var path = [];
  var cur = el;
  var depth = 0;
  while (cur && depth < max + 2 && path.length < max) {
    try {
      var parent = cur.attributes.byName('AXParent');
      if (!parent) break;
      cur = parent.value();
      if (!cur) break;
      var lab = labelOf(cur);
      if (lab) path.push(lab.slice(0, 80));
      depth++;
    } catch (e) {
      break;
    }
  }
  return path;
}

function selectedLabels(win) {
  var out = [];
  if (!win) return out;
  try {
    var rows = win.attributes.byName('AXSelectedRows');
    if (rows) {
      var arr = rows.value();
      if (arr) {
        for (var i = 0; i < Math.min(arr.length, 5); i++) {
          var lab = labelOf(arr[i]);
          if (lab) out.push(lab.slice(0, 120));
        }
      }
    }
  } catch (e) {}
  if (out.length) return out;
  try {
    var kids = win.attributes.byName('AXSelectedChildren');
    if (kids) {
      var arr2 = kids.value();
      if (arr2) {
        for (var j = 0; j < Math.min(arr2.length, 5); j++) {
          var lab2 = labelOf(arr2[j]);
          if (lab2) out.push(lab2.slice(0, 120));
        }
      }
    }
  } catch (e2) {}
  return out;
}

/** Frame of a System Events UI element via AXPosition/AXSize. */
function frameOfSe(el) {
  if (!el) return null;
  try {
    var posAttr = el.attributes.byName('AXPosition');
    var sizeAttr = el.attributes.byName('AXSize');
    if (!posAttr || !sizeAttr) return null;
    var pos = posAttr.value();
    var size = sizeAttr.value();
    if (!pos || !size) return null;
    var x = Math.round(Number(pos.x !== undefined ? pos.x : pos[0]));
    var y = Math.round(Number(pos.y !== undefined ? pos.y : pos[1]));
    var w = Math.round(Number(size.width !== undefined ? size.width : size[0]));
    var h = Math.round(Number(size.height !== undefined ? size.height : size[1]));
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h) || w < 0 || h < 0) return null;
    return { x: x, y: y, width: w, height: h };
  } catch (e) {
    return null;
  }
}

/** Collect AXSheet / AXDialog / AXDrawer titles for error/completion signals. */
function collectDialogs(win) {
  var out = [];
  if (!win) return out;
  try {
    var kidsAttr = win.attributes.byName('AXChildren');
    if (!kidsAttr) return out;
    var kids = kidsAttr.value();
    if (!kids) return out;
    for (var i = 0; i < Math.min(kids.length, 40) && out.length < 8; i++) {
      var kid = kids[i];
      var role = attr(kid, 'AXRole');
      if (role === 'AXSheet' || role === 'AXDialog' || role === 'AXDrawer' || role === 'AXPopover') {
        var lab = labelOf(kid) || role;
        if (lab) out.push(String(lab).slice(0, 80));
      }
    }
  } catch (e) {}
  return out;
}

function sample() {
  try {
    var se = Application('System Events');
    var procs = se.applicationProcesses.whose({ frontmost: true });
    if (!procs || procs.length === 0) return null;
    var proc = procs[0];
    var appName = jsString(proc.name());
    var bundleId = null;
    try { bundleId = String(proc.bundleIdentifier()); } catch (e) {}
    if (!appAllowed(appName)) return { k: 'ax', outOfScope: true };

    var win = null;
    try {
      var wins = proc.windows();
      if (wins && wins.length > 0) win = wins[0];
    } catch (e2) {}

    var windowTitle = win ? (attr(win, 'AXTitle') || null) : null;
    var documentTitle = win ? (attr(win, 'AXDocument') || windowTitle) : null;

    var focused = null;
    try {
      var fe = proc.attributes.byName('AXFocusedUIElement');
      if (fe) focused = fe.value();
    } catch (e3) {}

    var role = focused ? attr(focused, 'AXRole') : null;
    var subrole = focused ? attr(focused, 'AXSubrole') : null;
    // System Events identity plus the native fail-closed check, before any value read.
    var secure = isSecureRole(role, subrole) || focusedSecure();
    var valueLength = null;
    var valueTail = null;
    if (focused && TEXT_ROLES[role] && !secure) {
      valueTail = attrTail(focused, 'AXValue');
      if (valueTail == null) {
        valueLength = null;
      } else if (valueTail.length < VALUE_TAIL_MAX) {
        valueLength = valueTail.length;
      } else {
        valueLength = attrLen(focused, 'AXValue');
      }
    }

    var dialogs = collectDialogs(win);
    var errorState = null;
    if (dialogs.length) {
      errorState = dialogs[0];
    }

    return {
      k: 'ax',
      appName: appName,
      appBundleId: bundleId,
      windowTitle: windowTitle,
      documentTitle: documentTitle,
      elementRole: role,
      elementSubrole: subrole,
      elementLabel: focused ? labelOf(focused) : null,
      valueLength: valueLength,
      valueTail: secure ? null : valueTail,
      elementPath: focused ? collectAncestors(focused, MAX_ANCESTORS) : [],
      selectedLabels: selectedLabels(win),
      secure: secure,
      bounds: focused ? frameOfSe(focused) : null,
      dialogs: dialogs,
      errorState: errorState,
      pb: pasteboardCount()
    };
  } catch (err) {
    return { k: 'ax', error: String(err) };
  }
}

var lastKey = null;

function keyOf(s) {
  if (!s || s.error) return null;
  return [
    s.appName || '',
    s.appBundleId || '',
    s.windowTitle || '',
    s.documentTitle || '',
    s.elementRole || '',
    s.elementSubrole || '',
    s.elementLabel || '',
    String(s.valueLength == null ? '' : s.valueLength),
    (s.selectedLabels || []).join('|'),
    (s.elementPath || []).join('>'),
    (s.dialogs || []).join('|'),
    s.errorState || '',
    String(s.pb)
  ].join('\\x1f');
}

function emitSample() {
  var s = sample();
  if (!s) return;
  if (s.outOfScope) {
    /* Nothing read or emitted; returning to an in-scope app samples afresh. */
    lastKey = null;
    return;
  }
  if (s.error) {
    emit({ k: 'fault', where: 'ax_sample' });
    return;
  }
  var k = keyOf(s);
  if (!k || k === lastKey) return;
  lastKey = k;
  emit(s);
}

/* ── input monitors ── */
var monitors = [];
/* JXA GC's anonymous handler blocks unless we keep JS refs — tokens alone are not enough. */
var monitorHandlers = [];
var monitorsOk = false;
var pendingSampleAt = 0;
var keyCallbacks = 0;
var clickCallbacks = 0;

/** Ask for a fresh AX sample shortly after input, once the UI has settled. */
function scheduleSample(delayMs) {
  var at = Date.now() + delayMs;
  if (!pendingSampleAt || at < pendingSampleAt) pendingSampleAt = at;
}

function onKey(evt) {
  try {
    keyCallbacks += 1;
    var front = frontApp();
    if (!appAllowed(front.name)) return;
    var flags = 0;
    try { flags = evt.modifierFlags; } catch (e) {}
    var secure = focusedSecure();

    var chars = null;
    var base = null;
    if (!secure) {
      try { var c = evt.characters; if (c) chars = String(c.js); } catch (e2) {}
      try { var b = evt.charactersIgnoringModifiers; if (b) base = String(b.js); } catch (e3) {}
    }

    emit({
      k: 'key',
      code: evt.keyCode,
      chars: chars,
      base: base,
      cmd: (flags & $.NSEventModifierFlagCommand) !== 0,
      opt: (flags & $.NSEventModifierFlagOption) !== 0,
      ctrl: (flags & $.NSEventModifierFlagControl) !== 0,
      shift: (flags & $.NSEventModifierFlagShift) !== 0,
      repeat: evt.isARepeat ? true : false,
      secure: secure,
      app: front.name,
      appBundleId: front.bundleId,
      pb: pasteboardCount()
    });
    var chord = (flags & ($.NSEventModifierFlagCommand | $.NSEventModifierFlagControl)) !== 0;
    var b0 = base ? base.toLowerCase() : '';
    if (chord && !secure && (b0 === 'c' || b0 === 'x')) {
      var pb0 = pasteboardCount();
      if (pb0 !== null) {
        pendingCopy = { pb: pb0, app: front.name, bundleId: front.bundleId, cut: b0 === 'x', deadline: Date.now() + COPY_SETTLE_MS };
      }
    }
    scheduleSample(140);
  } catch (err) {
    emit({ k: 'fault', where: 'key' });
  }
}

function pointOf(evt) {
  try {
    var loc = $.CGEventGetLocation(evt.CGEvent);
    return { x: Math.round(loc.x), y: Math.round(loc.y) };
  } catch (e) {}
  try {
    /* Fallback: NSEvent coordinates are bottom-left origin; AX/CG are top-left. */
    var m = $.NSEvent.mouseLocation;
    var h = $.CGDisplayBounds($.CGMainDisplayID()).size.height;
    return { x: Math.round(m.x), y: Math.round(h - m.y) };
  } catch (e2) {}
  return null;
}

/*
 * One accepted event per physical press, by press identity: a polled edge proves its button went
 * down inside (previous poll, this poll] on the system-uptime clock that also stamps NSEvent
 * timestamps. A monitor press of the same button stamped inside that interval is the same press.
 * The poll copy is held one pump so the monitor copy (real count and modifiers) can claim it;
 * a monitor copy arriving after the poll copy was emitted is dropped as the late duplicate;
 * a poll edge whose press the monitor already delivered is suppressed. A different button, or a
 * press outside the interval, is never a duplicate. Both remembered lists are bounded.
 */
var MATCH_EPS = 0.005;
var REMEMBER_S = 10;
var REMEMBER_MAX = 16;
var heldPolls = [];
var releasedPolls = [];
var monitorPresses = [];
var pollSuppressed = 0;
var monitorLateDuplicates = 0;
var correlationDropped = 0;

function uptime() {
  try {
    var t = Number($.NSProcessInfo.processInfo.systemUptime);
    return isFinite(t) ? t : null;
  } catch (e) { return null; }
}

function within(ts, p) {
  return ts !== null && ts > p.after - MATCH_EPS && ts <= p.upTo + MATCH_EPS;
}

/* Keep a remembered list bounded in age and length; losses are counted, never silent. */
function remember(list, item, now) {
  list.push(item);
  while (list.length && (list.length > REMEMBER_MAX || (now !== null && now - list[0].at > REMEMBER_S))) {
    if (list.length > REMEMBER_MAX) correlationDropped += 1;
    list.shift();
  }
}

/* Which copy of this monitor press was already polled: 'held', 'released' or null. */
function matchPoll(button, ts) {
  for (var i = 0; i < heldPolls.length; i++) {
    var h = heldPolls[i];
    /* Without a timestamp the held same-button edge is the only candidate (one pump old). */
    if (h.button === button && (ts === null || within(ts, h))) {
      heldPolls.splice(i, 1);
      pollSuppressed += 1;
      return 'held';
    }
  }
  for (var j = 0; j < releasedPolls.length; j++) {
    if (releasedPolls[j].button === button && within(ts, releasedPolls[j])) {
      releasedPolls.splice(j, 1);
      monitorLateDuplicates += 1;
      return 'released';
    }
  }
  return null;
}

function onMouse(evt, button) {
  try {
    clickCallbacks += 1;
    var ts = null;
    try { ts = Number(evt.timestamp); if (!isFinite(ts)) ts = null; } catch (eTs) {}
    var copy = matchPoll(button, ts);
    /* Its polled copy was already emitted: this press is recorded once. */
    if (copy === 'released') return;
    if (copy === null && ts !== null) remember(monitorPresses, { button: button, ts: ts, at: ts }, ts);
    /* Polled presses still held happened no later than this one: emit them first (order). */
    releaseHeldPolls();
    var front = frontApp();
    if (!appAllowed(front.name)) return;
    var pt = pointOf(evt);
    var el = scopedElementAt(pt, front);
    if (pt && !el) return;
    var target = describeElement(el);
    var count = 1;
    try { count = evt.clickCount || 1; } catch (e) {}
    var flags = 0;
    try { flags = evt.modifierFlags; } catch (eFlags) {}

    emit({
      k: 'click',
      button: button,
      count: count,
      x: pt ? pt.x : null,
      y: pt ? pt.y : null,
      cmd: (flags & $.NSEventModifierFlagCommand) !== 0,
      opt: (flags & $.NSEventModifierFlagOption) !== 0,
      ctrl: (flags & $.NSEventModifierFlagControl) !== 0,
      shift: (flags & $.NSEventModifierFlagShift) !== 0,
      app: front.name,
      appBundleId: front.bundleId,
      role: target ? target.role : null,
      subrole: target ? target.subrole : null,
      identifier: target ? target.identifier : null,
      label: target ? target.label : null,
      valueLength: target ? target.valueLength : null,
      enabled: target ? target.enabled : null,
      path: target ? target.path : [],
      bounds: target ? target.bounds : null,
      windowBounds: target ? target.windowBounds : null,
      windowTitle: target ? target.windowTitle : null,
      containerRole: target ? target.containerRole : null,
      containerLabel: target ? target.containerLabel : null,
      rowIndex: target ? target.rowIndex : null,
      siblingCount: target ? target.siblingCount : null
    });
    scheduleSample(160);
  } catch (err) {
    emit({ k: 'fault', where: 'click' });
  }
}

var lastScrollEmitAt = 0;
function onScroll(evt) {
  try {
    var now = Date.now();
    if (now - lastScrollEmitAt < 200) return;
    lastScrollEmitAt = now;
    var dx = 0;
    var dy = 0;
    try { dx = evt.scrollingDeltaX || 0; } catch (e1) {}
    try { dy = evt.scrollingDeltaY || 0; } catch (e2) {}
    if (!dx && !dy) return;
    var front = frontApp();
    if (!appAllowed(front.name)) return;
    var pt = pointOf(evt);
    var el = scopedElementAt(pt, front);
    if (pt && !el) return;
    var target = describeElement(el);
    emit({
      k: 'scroll',
      axis: Math.abs(dy) >= Math.abs(dx) ? 'vertical' : 'horizontal',
      delta: Math.abs(dy) >= Math.abs(dx) ? dy : dx,
      x: pt ? pt.x : null,
      y: pt ? pt.y : null,
      app: front.name,
      appBundleId: front.bundleId,
      role: target ? target.role : null,
      label: target ? target.label : null,
      windowBounds: target ? target.windowBounds : null,
      windowTitle: target ? target.windowTitle : null,
      containerRole: target ? target.containerRole : null,
      containerLabel: target ? target.containerLabel : null
    });
  } catch (err) {
    emit({ k: 'fault', where: 'scroll' });
  }
}

function installMonitors() {
  try {
    /* Each callback reads AX/input: never once the host is gone. */
    var keyHandler = function (evt) { exitIfOrphaned(); onKey(evt); };
    var mouseHandler = function (evt) {
      exitIfOrphaned();
      var button = 'left';
      try { if (evt.type === $.NSEventTypeRightMouseDown) button = 'right'; } catch (e) {}
      onMouse(evt, button);
    };
    var scrollHandler = function (evt) { exitIfOrphaned(); onScroll(evt); };
    monitorHandlers.push(keyHandler);
    monitorHandlers.push(mouseHandler);
    monitorHandlers.push(scrollHandler);

    var keyMonitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(
      $.NSEventMaskKeyDown,
      keyHandler
    );
    var mouseMonitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(
      $.NSEventMaskLeftMouseDown | $.NSEventMaskRightMouseDown,
      mouseHandler
    );
    var scrollMonitor = null;
    try {
      scrollMonitor = $.NSEvent.addGlobalMonitorForEventsMatchingMaskHandler(
        $.NSEventMaskScrollWheel,
        scrollHandler
      );
    } catch (eScroll) {}
    /* Retain tokens AND handlers: releasing either removes/breaks the monitor. */
    if (keyMonitor) monitors.push(keyMonitor);
    if (mouseMonitor) monitors.push(mouseMonitor);
    if (scrollMonitor) monitors.push(scrollMonitor);
    monitorsOk = monitors.length >= 2;
  } catch (e) {
    monitorsOk = false;
  }
  return monitorsOk;
}

/* Global event monitors are delivered on a run loop, which needs an app object. */
try {
  $.NSApplication.sharedApplication;
  /*
   * Accessory (not Prohibited): some macOS versions silently drop NSEvent global
   * monitor callbacks for prohibited-policy helpers even when AXIsProcessTrusted.
   * Accessory stays dock-icon-free and never steals focus.
   */
  try {
    $.NSApp.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  } catch (ePol) {
    try { $.NSApp.setActivationPolicy($.NSApplicationActivationPolicyProhibited); } catch (e2) {}
  }
  try { $.NSApp.finishLaunching(); } catch (e3) {}
} catch (e) {}

var trusted = false;
try { trusted = $.AXIsProcessTrusted() ? true : false; } catch (e) {}

installMonitors();
emit({ k: 'ready', trusted: trusted, monitors: monitorsOk, secureApi: secureBound });

function sleepSeconds(seconds) {
  try { $.NSThread.sleepForTimeInterval(seconds); } catch (e) {}
}

var nextSampleAt = 0;
var nextStatsAt = Date.now() + 2500;
/*
 * Fallback when NSEvent global mouse monitors install but never fire (common for
 * osascript helpers): poll pressedMouseButtons and synthesize click edges.
 */
var lastMouseButtons = 0;
var lastPollAt = uptime();
var pollClicks = 0;

function readMouseButtons() {
  /* NSEvent.pressedMouseButtons is often an NSNumber under JXA — coerce carefully. */
  try {
    var raw = $.NSEvent.pressedMouseButtons;
    var n = Number(ObjC.unwrap(raw));
    if (isFinite(n)) return n;
    n = Number(raw);
    if (isFinite(n)) return n;
  } catch (e) {}
  /* HID system state sees clicks even when NSEvent poll is blind. */
  try {
    var left = $.CGEventSourceButtonState(1, 0) ? 1 : 0;
    var right = $.CGEventSourceButtonState(1, 1) ? 2 : 0;
    return left | right;
  } catch (e2) {}
  return null;
}

function polledClick(button) {
  var front = frontApp();
  if (!appAllowed(front.name)) return null;
  var pt = null;
  try {
    var m = $.NSEvent.mouseLocation;
    var h = $.CGDisplayBounds($.CGMainDisplayID()).size.height;
    pt = { x: Math.round(m.x), y: Math.round(h - m.y) };
  } catch (ePt) {}
  var el = scopedElementAt(pt, front);
  if (pt && !el) return null;
  var target = describeElement(el);
  return {
    k: 'click',
    button: button,
    /* A polled edge observes neither click count nor modifiers: report them unknown. */
    count: null,
    x: pt ? pt.x : null,
    y: pt ? pt.y : null,
    cmd: null,
    opt: null,
    ctrl: null,
    shift: null,
    app: front.name,
    appBundleId: front.bundleId,
    role: target ? target.role : null,
    subrole: target ? target.subrole : null,
    identifier: target ? target.identifier : null,
    label: target ? target.label : null,
    valueLength: target ? target.valueLength : null,
    enabled: target ? target.enabled : null,
    path: target ? target.path : [],
    bounds: target ? target.bounds : null,
    windowBounds: target ? target.windowBounds : null,
    windowTitle: target ? target.windowTitle : null,
    containerRole: target ? target.containerRole : null,
    containerLabel: target ? target.containerLabel : null,
    rowIndex: target ? target.rowIndex : null,
    siblingCount: target ? target.siblingCount : null,
    via: 'poll'
  };
}

/* After a pump: held polled edges no monitor delivery claimed are emitted (remembered briefly). */
function releaseHeldPolls() {
  var held = heldPolls;
  heldPolls = [];
  for (var i = 0; i < held.length; i++) {
    if (!held[i].click) continue;
    pollClicks += 1;
    clickCallbacks += 1;
    /* Only an edge with a known interval can be recognised later; one without is not kept. */
    if (isFinite(held[i].after) && isFinite(held[i].upTo)) remember(releasedPolls, held[i], held[i].at);
    emit(held[i].click);
    scheduleSample(160);
  }
}

/*
 * A polled edge: suppressed if the monitor already delivered this press, else held one pump.
 * Degraded (no clock): the edge has no interval, so it is never compared with remembered
 * monitor presses and never remembered itself; only a same-button monitor delivery during its
 * one-pump hold claims it. Such edges are counted (pollUnidentified).
 */
var pollUnidentified = 0;
function pollEdge(button, after, upTo) {
  if (!isFinite(after) || !isFinite(upTo)) {
    pollUnidentified += 1;
    heldPolls.push({ button: button, after: after, upTo: upTo, at: null, click: polledClick(button) });
    return;
  }
  for (var i = 0; i < monitorPresses.length; i++) {
    if (monitorPresses[i].button === button && within(monitorPresses[i].ts, { after: after, upTo: upTo })) {
      monitorPresses.splice(i, 1);
      pollSuppressed += 1;
      return;
    }
  }
  heldPolls.push({ button: button, after: after, upTo: upTo, at: upTo, click: polledClick(button) });
}

function pollMouseButtons() {
  try {
    var buttons = readMouseButtons();
    if (buttons === null) return;
    var leftDown = (buttons & 1) !== 0;
    var rightDown = (buttons & 2) !== 0;
    var wasLeft = (lastMouseButtons & 1) !== 0;
    var wasRight = (lastMouseButtons & 2) !== 0;
    var now = uptime();
    var after = lastPollAt;
    lastPollAt = now;
    /* No clock: the edge cannot be identified, so only the held same-button rule applies. */
    var from = after === null || now === null ? -Infinity : after;
    var to = now === null ? Infinity : now;
    if (leftDown && !wasLeft) pollEdge('left', from, to);
    if (rightDown && !wasRight) pollEdge('right', from, to);
    lastMouseButtons = buttons;
  } catch (ePoll) {}
}

while (true) {
  exitIfOrphaned();
  if (monitorsOk) {
    /*
     * Pump the run loop so monitor callbacks fire. runUntilDate can return early
     * when no input source is ready, so top up the remainder with a real sleep to
     * avoid spinning the CPU.
     */
    var began = Date.now();
    try {
      $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(PUMP_SECONDS));
    } catch (e) {
      monitorsOk = false;
    }
    var spent = Date.now() - began;
    if (spent < PUMP_SECONDS * 1000) sleepSeconds((PUMP_SECONDS * 1000 - spent) / 1000);
  } else {
    sleepSeconds(PUMP_SECONDS);
  }

  exitIfOrphaned();
  releaseHeldPolls();
  pollMouseButtons();
  checkCopy();

  var now = Date.now();
  if (pendingSampleAt && now >= pendingSampleAt) {
    pendingSampleAt = 0;
    emitSample();
    nextSampleAt = now + SAMPLE_MS;
  } else if (now >= nextSampleAt) {
    emitSample();
    nextSampleAt = now + SAMPLE_MS;
  }
  if (now >= nextStatsAt) {
    emit({
      k: 'stats',
      keys: keyCallbacks,
      clicks: clickCallbacks,
      pollClicks: pollClicks,
      pollSuppressed: pollSuppressed,
      monitorLateDuplicates: monitorLateDuplicates,
      correlationDropped: correlationDropped,
      pollUnidentified: pollUnidentified,
      monitors: monitorsOk
    });
    nextStatsAt = now + 2500;
  }
}
`
