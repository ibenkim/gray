/**
 * Long-lived JXA script for Accessibility sampling.
 * Samples every 400ms (or immediately when stdin receives a poke byte).
 * Writes one JSON line per *changed* sample to stdout.
 * Never includes AXValue contents — only length.
 */
export const JXA_AX_SCRIPT = `
ObjC.import('stdlib');

var lastKey = null;
var INTERVAL_MS = 400;

function attr(el, name) {
  try {
    if (!el) return null;
    var v = el.attributes.byName(name);
    if (!v) return null;
    var val = v.value();
    if (val === undefined || val === null) return null;
    return String(val);
  } catch (e) {
    return null;
  }
}

function attrLen(el, name) {
  try {
    if (!el) return null;
    var v = el.attributes.byName(name);
    if (!v) return null;
    var val = v.value();
    if (val === undefined || val === null) return null;
    return String(val).length;
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
    var subrole = focused ? attr(focused, 'AXSubrole') : null;
    var elementLabel = focused ? labelOf(focused) : null;
    var valueLength = focused ? attrLen(focused, 'AXValue') : null;
    var elementPath = focused ? collectAncestors(focused, 3) : [];
    var selected = selectedLabels(win);

    return {
      appName: appName,
      appBundleId: bundleId,
      windowTitle: windowTitle,
      documentTitle: documentTitle,
      elementRole: role,
      elementSubrole: subrole,
      elementLabel: elementLabel,
      valueLength: valueLength,
      elementPath: elementPath,
      selectedLabels: selected
    };
  } catch (err) {
    return { error: String(err) };
  }
}

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
    (s.elementPath || []).join('>')
  ].join('\\x1f');
}

function emit() {
  var s = sample();
  if (!s || s.error) return;
  var k = keyOf(s);
  if (!k || k === lastKey) return;
  lastKey = k;
  console.log(JSON.stringify(s));
}

function tick() {
  emit();
  delay(INTERVAL_MS / 1000);
  tick();
}

// Initial sample then loop. Pokes via stdin are handled by restarting emit from
// the host writing a newline — we also poll stdin with a short delay.
ObjC.import('Foundation');
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
function drainPokes() {
  try {
    var data = stdin.availableData;
    if (data && data.length > 0) {
      lastKey = null;
      emit();
    }
  } catch (e) {}
}

function loop() {
  emit();
  drainPokes();
  delay(INTERVAL_MS / 1000);
  loop();
}

loop();
`
