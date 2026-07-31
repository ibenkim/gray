/**
 * Long-lived JXA actuator: reads JSON command lines from stdin, writes JSON result lines.
 * Commands: activateApp, openUrl, pressElement, keystroke, query, ping, quit.
 */
export const JXA_ACTUATOR_SCRIPT = `
ObjC.import('stdlib');

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

function walkPress(root, role, label, maxDepth) {
  var queue = [{ el: root, depth: 0 }];
  while (queue.length) {
    var item = queue.shift();
    var el = item.el;
    if (!el || item.depth > maxDepth) continue;
    var elRole = attr(el, 'AXRole');
    var elLabel = labelOf(el);
    var roleOk = !role || (elRole && String(elRole).toLowerCase() === String(role).toLowerCase());
    if (roleOk && labelMatches(elLabel, label)) {
      try {
        el.actions.byName('AXPress').perform();
        return { ok: true, matchedLabel: elLabel, matchedRole: elRole };
      } catch (e) {
        return { ok: false, error: 'press_failed' };
      }
    }
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
    } catch (e2) {}
  }
  return { ok: false, error: 'element_not_found' };
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
      var cur = Application.currentApplication();
      cur.includeStandardAdditions = true;
      cur.doShellScript('open ' + shellQuote(url));
      return { id: id, ok: true };
    }

    if (type === 'pressElement') {
      var proc = findProcess(cmd.appName, cmd.appBundleId) || frontProcess();
      if (!proc) return { id: id, ok: false, error: 'app_not_found' };
      try { proc.frontmost = true; } catch (e) {}
      var wins = proc.windows();
      if (!wins || wins.length === 0) return { id: id, ok: false, error: 'no_window' };
      var result = walkPress(wins[0], cmd.elementRole || null, cmd.elementLabel || '', 8);
      result.id = id;
      return result;
    }

    if (type === 'keystroke') {
      var ks = doKeystroke(cmd.chord);
      ks.id = id;
      return ks;
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
    console.log(JSON.stringify(result));
    if (cmd.type === 'quit') {
      $.exit(0);
    }
  }
}
`
