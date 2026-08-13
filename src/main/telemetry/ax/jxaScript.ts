/**
 * Long-lived JXA sensor for macOS input + Accessibility.
 *
 * Emits one NDJSON line per observation on **real stdout**. `console.log` must
 * never be used here: under `osascript -l JavaScript` it writes to stderr, so the
 * host would never receive a single line.
 *
 * Line kinds:
 *   {k:'ready', trusted, monitors}   — handshake + capability report
 *   {k:'ax', …, valueTail?}          — focused element / window sample (on change)
 *   {k:'key', code, chars, base, …}  — a physical key press
 *   {k:'click', x, y, role, label, …}— a mouse press with its Accessibility target
 *   {k:'stats', keys, clicks}        — monitor callback counters (debug heartbeat)
 *
 * Non-secure text fields include `valueTail` (last ≤160 chars of AXValue) so the
 * host can recover typing when NSEvent monitors are silent. Secure fields never
 * include a tail. The host aggregates and redacts before storage.
 */
export const JXA_SENSOR_SCRIPT = `
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

var STDOUT = $.NSFileHandle.fileHandleWithStandardOutput;

function writeLine(text) {
  try {
    var str = $.NSString.alloc.initWithUTF8String(text + "\\n");
    STDOUT.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
  } catch (e) {
    /* host will notice the silence */
  }
}

function emit(obj) {
  try { writeLine(JSON.stringify(obj)); } catch (e) {}
}

var SAMPLE_MS = 400;
/* ~60Hz so short clicks are not missed between polls. */
var PUMP_SECONDS = 0.016;
var MAX_ANCESTORS = 3;

/* Roles whose AXValue is user-entered text. Secure fields: length only. Others: length + tail. */
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

function secureInputActive() {
  if (!secureBound) return false;
  try { return $.IsSecureEventInputEnabled() ? true : false; } catch (e) { return false; }
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
  if (TEXT_ROLES[role]) {
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
  for (var i = 0; i < MAX_ANCESTORS + 4 && path.length < 8; i++) {
    cur = axCopy(cur, 'AXParent');
    if (!cur) break;
    var pRole = axString(cur, 'AXRole');
    var pLabel = axString(cur, 'AXTitle') || axString(cur, 'AXDescription');
    if (pLabel) path.push(pLabel.slice(0, 80));
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

  return {
    role: role,
    subrole: axString(el, 'AXSubrole'),
    identifier: identifier ? identifier.slice(0, 120) : null,
    label: label ? label.slice(0, 120) : null,
    valueLength: valueLength,
    enabled: enabled,
    path: path,
    bounds: axFrameBounds(el),
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
    var appName = String(proc.name());
    var bundleId = null;
    try { bundleId = String(proc.bundleIdentifier()); } catch (e) {}

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
    var secure = role === 'AXSecureTextField' || secureInputActive();
    var valueLength = null;
    var valueTail = null;
    if (focused && TEXT_ROLES[role]) {
      if (secure) {
        valueLength = attrLen(focused, 'AXValue');
      } else {
        valueTail = attrTail(focused, 'AXValue');
        if (valueTail == null) {
          valueLength = null;
        } else if (valueTail.length < VALUE_TAIL_MAX) {
          valueLength = valueTail.length;
        } else {
          valueLength = attrLen(focused, 'AXValue');
        }
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
      elementSubrole: focused ? attr(focused, 'AXSubrole') : null,
      elementLabel: focused ? labelOf(focused) : null,
      valueLength: valueLength,
      valueTail: secure ? null : valueTail,
      elementPath: focused ? collectAncestors(focused, MAX_ANCESTORS) : [],
      selectedLabels: selectedLabels(win),
      secure: secure,
      bounds: focused ? frameOfSe(focused) : null,
      dialogs: dialogs,
      errorState: errorState
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
    s.errorState || ''
  ].join('\\x1f');
}

function emitSample() {
  var s = sample();
  if (!s) return;
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
    var flags = 0;
    try { flags = evt.modifierFlags; } catch (e) {}
    var secure = secureInputActive();

    var chars = null;
    var base = null;
    if (!secure) {
      try { var c = evt.characters; if (c) chars = String(c.js); } catch (e2) {}
      try { var b = evt.charactersIgnoringModifiers; if (b) base = String(b.js); } catch (e3) {}
    }

    var front = frontApp();
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
      appBundleId: front.bundleId
    });
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

function onMouse(evt, button) {
  try {
    clickCallbacks += 1;
    var pt = pointOf(evt);
    var target = pt ? describeElement(elementAtPoint(pt.x, pt.y)) : null;
    var front = frontApp();
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
    var pt = pointOf(evt);
    var target = pt ? describeElement(elementAtPoint(pt.x, pt.y)) : null;
    var front = frontApp();
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
      containerRole: target ? target.containerRole : null,
      containerLabel: target ? target.containerLabel : null
    });
  } catch (err) {
    emit({ k: 'fault', where: 'scroll' });
  }
}

function installMonitors() {
  try {
    var keyHandler = function (evt) { onKey(evt); };
    var mouseHandler = function (evt) {
      var button = 'left';
      try { if (evt.type === $.NSEventTypeRightMouseDown) button = 'right'; } catch (e) {}
      onMouse(evt, button);
    };
    var scrollHandler = function (evt) { onScroll(evt); };
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

function emitPolledClick(button) {
  pollClicks += 1;
  clickCallbacks += 1;
  var pt = null;
  try {
    var m = $.NSEvent.mouseLocation;
    var h = $.CGDisplayBounds($.CGMainDisplayID()).size.height;
    pt = { x: Math.round(m.x), y: Math.round(h - m.y) };
  } catch (ePt) {}
  var target = pt ? describeElement(elementAtPoint(pt.x, pt.y)) : null;
  var front = frontApp();
  emit({
    k: 'click',
    button: button,
    count: 1,
    x: pt ? pt.x : null,
    y: pt ? pt.y : null,
    cmd: false,
    opt: false,
    ctrl: false,
    shift: false,
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
    containerRole: target ? target.containerRole : null,
    containerLabel: target ? target.containerLabel : null,
    rowIndex: target ? target.rowIndex : null,
    siblingCount: target ? target.siblingCount : null,
    via: 'poll'
  });
  scheduleSample(160);
}

function pollMouseButtons() {
  try {
    var buttons = readMouseButtons();
    if (buttons === null) return;
    var leftDown = (buttons & 1) !== 0;
    var rightDown = (buttons & 2) !== 0;
    var wasLeft = (lastMouseButtons & 1) !== 0;
    var wasRight = (lastMouseButtons & 2) !== 0;
    if (leftDown && !wasLeft) emitPolledClick('left');
    if (rightDown && !wasRight) emitPolledClick('right');
    lastMouseButtons = buttons;
  } catch (ePoll) {}
}

while (true) {
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

  pollMouseButtons();

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
      monitors: monitorsOk
    });
    nextStatsAt = now + 2500;
  }
}
`
