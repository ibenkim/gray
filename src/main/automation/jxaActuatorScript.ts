/**
 * Long-lived JXA actuator: reads JSON command lines from stdin, writes JSON result lines.
 * Commands: activateApp, openUrl, pressElement, keystroke, query, ping, quit.
 *
 * Replies go through writeLine (NSFileHandle stdout). `console.log` must never be
 * used here: under `osascript -l JavaScript` it writes to stderr, so the host would
 * never see a single reply.
 */
export const JXA_ACTUATOR_SCRIPT = `
ObjC.import('stdlib');
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

var STDOUT = $.NSFileHandle.fileHandleWithStandardOutput;

function writeLine(text) {
  try {
    var str = $.NSString.alloc.initWithUTF8String(text + "\\n");
    STDOUT.writeData(str.dataUsingEncoding($.NSUTF8StringEncoding));
  } catch (e) {
    /* nothing useful to do — host will time out the command */
  }
}

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

function labelOf(el) {
  if (!el) return null;
  return attr(el, 'AXTitle') || attr(el, 'AXDescription') || attr(el, 'AXIdentifier') || null;
}

function labelMatches(actual, expected) {
  if (!expected || !actual) return false;
  var a = String(actual).toLowerCase();
  var e = String(expected).toLowerCase();
  return a === e || a.indexOf(e) !== -1 || e.indexOf(a) !== -1;
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\\\''") + "'";
}

/**
 * Open URL in a fresh tab when the browser exposes AppleScript tabs.
 * Falls back to {ok:false} so the caller can use \`open\`.
 */
function openUrlInNewTab(url, preferredApp) {
  /* Chrome-family AppleScript can create a tab without reusing the front one. */
  var candidates = [];
  if (preferredApp) candidates.push(String(preferredApp));
  candidates.push('Google Chrome', 'Chromium', 'Microsoft Edge', 'Brave Browser', 'Arc');
  var seen = {};
  for (var i = 0; i < candidates.length; i++) {
    var name = candidates[i];
    if (!name || seen[name]) continue;
    seen[name] = 1;
    try {
      var app = Application(name);
      app.activate();
      if (!app.windows().length) {
        app.Window().make();
      }
      var win = app.windows[0];
      win.tabs.push(app.Tab({ url: url }));
      try { win.activeTabIndex = win.tabs().length; } catch (eIdx) {}
      return { ok: true };
    } catch (e) {
      /* try next browser */
    }
  }
  return { ok: false };
}

function clickAtPoint(x, y, button, count, mods) {
  try {
    var pt = $.CGPointMake(Number(x), Number(y));
    var downType = button === 'right' ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
    var upType = button === 'right' ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
    var buttonType = button === 'right' ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
    var n = Math.max(1, Math.min(10, Number(count) || 1));
    var flags = 0;
    try {
      if (mods) {
        if (mods.cmd) flags |= $.kCGEventFlagMaskCommand;
        if (mods.opt) flags |= $.kCGEventFlagMaskAlternate;
        if (mods.ctrl) flags |= $.kCGEventFlagMaskControl;
        if (mods.shift) flags |= $.kCGEventFlagMaskShift;
      }
    } catch (eFlags) {}
    /* Move first — many web UIs ignore down/up that never hovered the target. */
    var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, pt, buttonType);
    if (flags) $.CGEventSetFlags(move, flags);
    $.CGEventPost($.kCGHIDEventTap, move);
    try { $.NSThread.sleepForTimeInterval(0.03); } catch (eSleep0) {}
    for (var c = 1; c <= n; c++) {
      var down = $.CGEventCreateMouseEvent($(), downType, pt, buttonType);
      $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, c);
      if (flags) $.CGEventSetFlags(down, flags);
      $.CGEventPost($.kCGHIDEventTap, down);
      try { $.NSThread.sleepForTimeInterval(0.04); } catch (eSleep1) {}
      var up = $.CGEventCreateMouseEvent($(), upType, pt, buttonType);
      $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, c);
      if (flags) $.CGEventSetFlags(up, flags);
      $.CGEventPost($.kCGHIDEventTap, up);
      if (c < n) {
        try { $.NSThread.sleepForTimeInterval(0.05); } catch (eSleep2) {}
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'click_failed' };
  }
}

function scrollAtPoint(x, y, axis, delta) {
  try {
    var pt = $.CGPointMake(Number(x), Number(y));
    var move = $.CGEventCreateMouseEvent($(), $.kCGEventMouseMoved, pt, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, move);
    try { $.NSThread.sleepForTimeInterval(0.02); } catch (eSleep) {}
    var d = Number(delta) || 0;
    /* CGEventCreateScrollWheelEvent: units, wheelCount, wheel1 (vertical), wheel2 (horizontal) */
    var wheel1 = axis === 'horizontal' ? 0 : Math.round(d);
    var wheel2 = axis === 'horizontal' ? Math.round(d) : 0;
    var scroll = $.CGEventCreateScrollWheelEvent($(), $.kCGScrollEventUnitLine, 2, wheel1, wheel2);
    $.CGEventPost($.kCGHIDEventTap, scroll);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'scroll_failed' };
  }
}

function frontProcess() {
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ frontmost: true });
  if (!procs || procs.length === 0) return null;
  return procs[0];
}

function findProcess(appName, bundleId) {
  var se = Application('System Events');
  var procs = se.applicationProcesses();
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    try {
      var name = String(p.name());
      var bid = '';
      try { bid = String(p.bundleIdentifier()); } catch (e) {}
      if (bundleId && bid && bid.toLowerCase() === String(bundleId).toLowerCase()) return p;
      if (appName && name.toLowerCase() === String(appName).toLowerCase()) return p;
    } catch (e2) {}
  }
  return null;
}

function pickWindow(proc, windowTitle) {
  try {
    var wins = proc.windows();
    if (!wins || wins.length === 0) return null;
    if (windowTitle) {
      var want = String(windowTitle).toLowerCase();
      for (var i = 0; i < wins.length; i++) {
        try {
          var t = String(wins[i].name() || '');
          if (t.toLowerCase().indexOf(want) !== -1 || want.indexOf(t.toLowerCase()) !== -1) {
            return wins[i];
          }
        } catch (eT) {}
      }
    }
    return wins[0];
  } catch (e) {
    return null;
  }
}

function windowFrame(win) {
  if (!win) return null;
  try {
    var posAttr = win.attributes.byName('AXPosition');
    var sizeAttr = win.attributes.byName('AXSize');
    if (!posAttr || !sizeAttr) return null;
    var pos = posAttr.value();
    var size = sizeAttr.value();
    if (!pos || !size) return null;
    var x = Math.round(Number(pos.x !== undefined ? pos.x : pos[0]));
    var y = Math.round(Number(pos.y !== undefined ? pos.y : pos[1]));
    var w = Math.round(Number(size.width !== undefined ? size.width : size[0]));
    var h = Math.round(Number(size.height !== undefined ? size.height : size[1]));
    if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) return null;
    return { x: x, y: y, width: w, height: h };
  } catch (e) {
    return null;
  }
}

function walkPressOnce(root, role, label, maxDepth, requireRole) {
  var queue = [{ el: root, depth: 0 }];
  while (queue.length) {
    var item = queue.shift();
    var el = item.el;
    if (!el || item.depth > maxDepth) continue;
    var elRole = attr(el, 'AXRole');
    var elLabel = labelOf(el);
    var roleOk =
      !requireRole ||
      !role ||
      (elRole && String(elRole).toLowerCase() === String(role).toLowerCase());
    if (roleOk && labelMatches(elLabel, label)) {
      try {
        el.actions.byName('AXPress').perform();
        return { ok: true, matchedLabel: elLabel, matchedRole: elRole };
      } catch (e) {
        /* keep searching — another match may press */
      }
    }
    try {
      var kids = el.attributes.byName('AXChildren');
      if (kids) {
        var arr = kids.value();
        if (arr) {
          for (var i = 0; i < Math.min(arr.length, 120); i++) {
            queue.push({ el: arr[i], depth: item.depth + 1 });
          }
        }
      }
    } catch (e2) {}
  }
  return null;
}

function walkPress(root, role, label, maxDepth) {
  /* Prefer exact role+label, then label-only — Chrome omnibox roles drift. */
  var hit = walkPressOnce(root, role, label, maxDepth, true);
  if (hit) return hit;
  if (role) {
    hit = walkPressOnce(root, role, label, maxDepth, false);
    if (hit) return hit;
  }
  return { ok: false, error: 'element_not_found' };
}

/** Walk an elementPath of menu/ancestor labels (outer → inner). */
function pressByPath(root, pathLabels, maxDepth) {
  if (!pathLabels || !pathLabels.length) return null;
  var cur = root;
  for (var i = 0; i < pathLabels.length; i++) {
    var want = String(pathLabels[i] || '');
    if (!want) continue;
    var hit = walkPressOnce(cur, null, want, maxDepth, false);
    if (!hit || !hit.ok) return null;
  }
  return { ok: true };
}

function pressInProcess(proc, role, label, path, windowTitle) {
  /* Menu bar first — AXMenuItem lives outside windows. */
  try {
    var bars = proc.menuBars();
    if (bars && bars.length) {
      if (path && path.length) {
        var byPath = pressByPath(bars[0], path.slice().reverse(), 10);
        if (byPath && byPath.ok) return byPath;
      }
      var menuHit = walkPress(bars[0], role, label, 10);
      if (menuHit && menuHit.ok) return menuHit;
    }
  } catch (eMenu) {}

  var win = pickWindow(proc, windowTitle);
  if (!win) return { ok: false, error: 'no_window' };
  if (path && path.length) {
    var pathHit = pressByPath(win, path.slice().reverse(), 12);
    if (pathHit && pathHit.ok) return pathHit;
  }
  return walkPress(win, role, label, 12);
}

function elementExists(root, role, label, maxDepth) {
  var queue = [{ el: root, depth: 0 }];
  while (queue.length) {
    var item = queue.shift();
    var el = item.el;
    if (!el || item.depth > maxDepth) continue;
    var elRole = attr(el, 'AXRole');
    var elLabel = labelOf(el);
    var roleOk = !role || (elRole && String(elRole).toLowerCase() === String(role).toLowerCase());
    if (roleOk && labelMatches(elLabel, label)) return true;
    try {
      var kids = el.attributes.byName('AXChildren');
      if (kids) {
        var arr = kids.value();
        if (arr) {
          for (var i = 0; i < Math.min(arr.length, 80); i++) {
            queue.push({ el: arr[i], depth: item.depth + 1 });
          }
        }
      }
    } catch (e) {}
  }
  return false;
}

var KEY_CODES = {
  'return': 36, 'enter': 36, 'tab': 48, 'escape': 53, 'esc': 53,
  'delete': 51, 'backspace': 51, 'space': 49,
  'up': 126, 'down': 125, 'left': 123, 'right': 124
};

function parseChord(chord) {
  var parts = String(chord || '').split('+');
  var mods = { command: false, option: false, control: false, shift: false };
  var key = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim().toLowerCase();
    if (p === 'cmd' || p === 'command' || p === 'meta') mods.command = true;
    else if (p === 'opt' || p === 'option' || p === 'alt') mods.option = true;
    else if (p === 'ctrl' || p === 'control') mods.control = true;
    else if (p === 'shift') mods.shift = true;
    else key = parts[i].trim();
  }
  return { mods: mods, key: key };
}

function doKeystroke(chord) {
  var se = Application('System Events');
  var parsed = parseChord(chord);
  var using = [];
  if (parsed.mods.command) using.push('command down');
  if (parsed.mods.option) using.push('option down');
  if (parsed.mods.control) using.push('control down');
  if (parsed.mods.shift) using.push('shift down');
  var keyLower = parsed.key.toLowerCase();
  if (KEY_CODES[keyLower] !== undefined) {
    if (using.length) se.keyCode(KEY_CODES[keyLower], { using: using });
    else se.keyCode(KEY_CODES[keyLower]);
  } else if (parsed.key.length === 1) {
    if (using.length) se.keystroke(parsed.key, { using: using });
    else se.keystroke(parsed.key);
  } else if (parsed.key.length > 1) {
    if (using.length) se.keystroke(parsed.key, { using: using });
    else se.keystroke(parsed.key);
  } else {
    return { ok: false, error: 'unsupported_chord' };
  }
  return { ok: true };
}

function handle(cmd) {
  var id = cmd.id || null;
  var type = cmd.type;
  try {
    if (type === 'ping') return { id: id, ok: true, type: 'pong' };
    if (type === 'quit') return { id: id, ok: true, type: 'quit' };

    if (type === 'activateApp') {
      var appName = cmd.appName || null;
      var bundleId = cmd.appBundleId || null;
      try {
        var app = bundleId ? Application(bundleId) : Application(appName);
        app.activate();
      } catch (e) {
        var proc = findProcess(appName, bundleId);
        if (!proc) return { id: id, ok: false, error: 'app_not_found' };
        try { proc.frontmost = true; } catch (e2) {
          return { id: id, ok: false, error: 'activate_failed' };
        }
      }
      return { id: id, ok: true };
    }

    if (type === 'openUrl') {
      var url = cmd.url;
      if (!url || typeof url !== 'string') return { id: id, ok: false, error: 'invalid_url' };
      if (url.indexOf('http://') !== 0 && url.indexOf('https://') !== 0) {
        return { id: id, ok: false, error: 'invalid_url' };
      }
      /* Prefer a NEW browser tab — \`open <url>\` reuses the frontmost tab. */
      var opened = openUrlInNewTab(url, cmd.appName || null);
      if (opened.ok) return { id: id, ok: true };
      var cur = Application.currentApplication();
      cur.includeStandardAdditions = true;
      cur.doShellScript('open ' + shellQuote(url));
      return { id: id, ok: true };
    }

    if (type === 'clickAt') {
      var cx = cmd.x;
      var cy = cmd.y;
      if (typeof cx !== 'number' || typeof cy !== 'number') {
        return { id: id, ok: false, error: 'missing_point' };
      }
      var clicked = clickAtPoint(
        cx,
        cy,
        cmd.button === 'right' ? 'right' : 'left',
        cmd.count,
        cmd.modifiers || null
      );
      clicked.id = id;
      return clicked;
    }

    if (type === 'scrollAt') {
      var sx = cmd.x;
      var sy = cmd.y;
      if (typeof sx !== 'number' || typeof sy !== 'number') {
        return { id: id, ok: false, error: 'missing_point' };
      }
      var scrolled = scrollAtPoint(
        sx,
        sy,
        cmd.axis === 'horizontal' ? 'horizontal' : 'vertical',
        cmd.delta
      );
      scrolled.id = id;
      return scrolled;
    }

    if (type === 'windowBounds') {
      var procB = findProcess(cmd.appName, cmd.appBundleId) || frontProcess();
      if (!procB) return { id: id, ok: false, error: 'app_not_found' };
      try { procB.frontmost = true; } catch (eB) {}
      var winB = pickWindow(procB, cmd.windowTitle || null);
      var frame = windowFrame(winB);
      if (!frame) return { id: id, ok: false, error: 'no_window' };
      return { id: id, ok: true, bounds: frame };
    }

    if (type === 'pressElement') {
      var proc = findProcess(cmd.appName, cmd.appBundleId) || frontProcess();
      if (!proc) return { id: id, ok: false, error: 'app_not_found' };
      try { proc.frontmost = true; } catch (e) {}
      var result = pressInProcess(
        proc,
        cmd.elementRole || null,
        cmd.elementLabel || '',
        cmd.elementPath || null,
        cmd.windowTitle || null
      );
      result.id = id;
      return result;
    }

    if (type === 'keystroke') {
      var ks = doKeystroke(cmd.chord);
      ks.id = id;
      return ks;
    }

    /* Type literal characters via System Events — never touches the clipboard. */
    if (type === 'typeText') {
      var text = cmd.text;
      if (typeof text !== 'string' || !text.length) {
        return { id: id, ok: false, error: 'missing_text' };
      }
      if (text.length > 500) {
        return { id: id, ok: false, error: 'text_too_long' };
      }
      try {
        var seType = Application('System Events');
        seType.keystroke(text);
        return { id: id, ok: true };
      } catch (eType) {
        return { id: id, ok: false, error: 'type_failed' };
      }
    }

    if (type === 'query') {
      var cond = cmd.waitCondition;
      var value = cmd.waitValue || '';
      if (cond === 'app_frontmost') {
        var fp = frontProcess();
        var name = fp ? String(fp.name()) : '';
        return { id: id, ok: !!value && name.toLowerCase() === String(value).toLowerCase(), matched: name };
      }
      if (cond === 'window_title_contains') {
        var fp2 = frontProcess();
        if (!fp2) return { id: id, ok: false };
        var wins2 = fp2.windows();
        var title = '';
        try { if (wins2 && wins2.length) title = String(wins2[0].name()); } catch (e) {}
        return { id: id, ok: title.toLowerCase().indexOf(String(value).toLowerCase()) !== -1, matched: title };
      }
      if (cond === 'element_exists') {
        var proc2 = findProcess(cmd.appName, cmd.appBundleId) || frontProcess();
        if (!proc2) return { id: id, ok: false };
        var wins3 = proc2.windows();
        if (!wins3 || wins3.length === 0) return { id: id, ok: false };
        var exists = elementExists(wins3[0], cmd.elementRole || null, cmd.elementLabel || value, 8);
        return { id: id, ok: exists };
      }
      return { id: id, ok: false, error: 'unknown_condition' };
    }

    return { id: id, ok: false, error: 'unknown_command' };
  } catch (err) {
    return { id: id, ok: false, error: 'exception' };
  }
}

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
while (true) {
  var data = stdin.availableData;
  if (!data || data.length === 0) {
    $.exit(0);
  }
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
  if (!str) continue;
  var chunks = str.split('\\n');
  for (var i = 0; i < chunks.length; i++) {
    var chunk = chunks[i].replace(/\\r$/, '').trim();
    if (!chunk) continue;
    var cmd;
    try { cmd = JSON.parse(chunk); } catch (e) { continue; }
    var result = handle(cmd);
    writeLine(JSON.stringify(result));
    if (cmd.type === 'quit') {
      $.exit(0);
    }
  }
}
`
