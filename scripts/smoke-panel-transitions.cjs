/* eslint-disable */
'use strict'
/**
 * TEST-ONLY isolated native smoke for pill/panel transitions (M1-HF2).
 *
 * Runs the production pill renderer build (out/renderer), production preload (out/preload)
 * and the production transition controller (src/main/windowTransitions.ts, transpiled here)
 * in a real Electron window, with:
 *   - a fresh userData/session dir under GRAY_UI_FIXTURE_DIR (refuses to start otherwise),
 *   - no dotenv, store, outbox, login, telemetry, capture, network or protocol handlers,
 *   - synthetic, app-window-only input (webContents.sendInputEvent) and a scripted fake
 *     cursor for the drag poller (the real pointer is never read or moved),
 *   - app-window-only screenshots (webContents.capturePage), never the desktop.
 *
 *   GRAY_UI_FIXTURE_DIR=$(mktemp -d /tmp/gray-hf2-ui.XXXXXX)
 *   env -u ELECTRON_RUN_AS_NODE OPENAI_API_KEY= GRAY_UI_FIXTURE_DIR="$GRAY_UI_FIXTURE_DIR" \
 *     /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
 *     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/smoke-panel-transitions.cjs
 *
 * M1-HF2-R1: `--scenario=pill-lifecycle --renderer-mode=development|production` instead bundles
 * the actual renderer entry (src/renderer/src/main.tsx, StrictMode kept) into the fixture dir
 * with the installed esbuild and React's runtime explicitly selected, then drives the real
 * provider/pill with synthetic input. A test-only react-dom/client shim records the root so the
 * harness can unmount/remount it in-page. Unknown flags refuse to run.
 *
 * M1-HF3-B: every scenario uses the production Record dropdown wiring (controller factory +
 * relay) with the stationary pill. `--scenario=anchored-dropdown` mounts the actual renderer
 * entry (GhostPill, RecordPanel in the #record-dropdown route, production CSS) in both React
 * modes beside an underlying synthetic probe window. It counts every native pill
 * frame/visibility operation, traces pill frames, records computed styles and synthetic-window
 * screenshots, injects load/never-ready/crash failures at the native boundary, and samples
 * CPU/working set of this app's own processes (fake capture/provider data only). Optional env: GRAY_HF3A_SAMPLE_SECONDS (default 60), GRAY_HF3A_MANUAL_SECONDS
 * (opt-in native click check by a person; never synthesized).
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
const FX = process.env.GRAY_UI_FIXTURE_DIR || ''

// A harness error must report and exit, never raise Electron's modal error dialog.
process.on('uncaughtException', (err) => {
  console.error('[smoke] uncaught', err && err.stack ? err.stack : err)
  app.exit(3)
})
process.on('unhandledRejection', (err) => {
  console.error('[smoke] unhandled rejection', err && err.stack ? err.stack : err)
})

function refuse(msg) {
  console.error('[smoke] refusing to start: ' + msg)
  app.exit(2)
}

// ── Flags (unknown flags refuse; no flags = the default production visual smoke) ──
const ARGS = {}
for (const a of process.argv.slice(2)) {
  const m = /^--(renderer-mode|scenario)=(.+)$/.exec(a)
  if (!m) refuse('unknown argument ' + a)
  else ARGS[m[1]] = m[2]
}
const SCENARIO = ARGS.scenario || 'default'
const RENDERER_MODE = ARGS['renderer-mode'] || 'production'
if (!['default', 'pill-lifecycle', 'anchored-dropdown'].includes(SCENARIO)) refuse('unknown --scenario ' + SCENARIO)
if (!['development', 'production'].includes(RENDERER_MODE)) refuse('unknown --renderer-mode ' + RENDERER_MODE)
if (SCENARIO === 'default' && RENDERER_MODE !== 'production') refuse('the default smoke uses the production build; use --scenario=pill-lifecycle')
const intEnv = (k, d) => (process.env[k] ? (/^\d+$/.test(process.env[k]) ? Number(process.env[k]) : (refuse(k + ' must be a whole number of seconds'), d)) : d)
const SAMPLE_SECONDS = intEnv('GRAY_HF3A_SAMPLE_SECONDS', 60)
const MANUAL_SECONDS = intEnv('GRAY_HF3A_MANUAL_SECONDS', 0)

// ── Isolation gate (before anything else touches disk/profile) ──
const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp'].map((p) => fs.realpathSync(p))
if (!FX || !path.isAbsolute(FX) || !fs.existsSync(FX)) refuse('GRAY_UI_FIXTURE_DIR must be an existing absolute temp dir')
const fxReal = fs.existsSync(FX) ? fs.realpathSync(FX) : ''
if (fxReal && !tmpRoots.some((r) => fxReal.startsWith(r + path.sep))) refuse('fixture dir must be under a temp root')
if (fxReal && fs.readdirSync(fxReal).length > 0) refuse('fixture dir must be empty (use a fresh mktemp -d)')
if (process.env.OPENAI_API_KEY) refuse('OPENAI_API_KEY must be empty')
for (const f of ['out/renderer/index.html', 'out/preload/index.js']) {
  if (!fs.existsSync(path.join(ROOT, f))) refuse(`missing build output ${f} (run npm run build)`)
}
app.setName('gray-ui-smoke')
// Chromium's own seatbelt sandbox cannot initialize nested inside sandbox-exec (which is what
// denies network for this run). Test-only: disable the inner sandbox; only local files load.
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
for (const [k, sub] of [['userData', 'userData'], ['sessionData', 'sessionData'], ['logs', 'logs'], ['crashDumps', 'crash']]) {
  const dir = path.join(fxReal, sub)
  fs.mkdirSync(dir, { recursive: true })
  app.setPath(k, dir)
}
const SHOTS = path.join(fxReal, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })

// ── Production controller, transpiled from source for this test only ──
function loadTs(file) {
  const ts = require(path.join(ROOT, 'node_modules/typescript'))
  const src = fs.readFileSync(file, 'utf8')
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  const m = new Module(file)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(out, file)
  return m.exports
}
const CONTROLLER_SRC = path.join(ROOT, 'src/main/windowTransitions.ts')
const T = loadTs(CONTROLLER_SRC)
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16)
const identity = {
  controller: sha(CONTROLLER_SRC),
  rendererHtml: sha(path.join(ROOT, 'out/renderer/index.html')),
  preload: sha(path.join(ROOT, 'out/preload/index.js')),
  electron: process.versions.electron,
  hasBackdrops: !!T.BACKDROP_WINDOW_OPTIONS
}

// ── Counted timers and settlement tracking (instrumentation only) ──
const live = { timeouts: new Set(), intervals: new Set() }
const timers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(() => {
      live.timeouts.delete(t)
      fn()
    }, ms)
    live.timeouts.add(t)
    return t
  },
  clearTimeout: (t) => {
    live.timeouts.delete(t)
    clearTimeout(t)
  },
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms)
    live.intervals.add(t)
    return t
  },
  clearInterval: (t) => {
    live.intervals.delete(t)
    clearInterval(t)
  }
}
let pending = 0
let cursor = { x: 0, y: 0 }
let pill = null
let workspace = null
const backdrops = { pill: null, panel: null }
let boundsUpdates = 0
/** Native focus losses (the harness runs on a live desktop; another app can take focus). */
let nativeBlurs = 0
let externalBlurRetries = 0
let backdropUpdates = 0

function countWin(win, kind) {
  const setBounds = win.setBounds.bind(win)
  const setPosition = win.setPosition.bind(win)
  win.setBounds = (...a) => {
    kind === 'pill' ? boundsUpdates++ : backdropUpdates++
    return setBounds(...a)
  }
  win.setPosition = (...a) => {
    kind === 'pill' ? boundsUpdates++ : backdropUpdates++
    return setPosition(...a)
  }
}

// M1-HF3-B: the production Record dropdown wiring (factory + relay) drives every scenario.
const ctl = T.createWindowTransitions({
  pill: () => pill,
  workAreaNear: (p) => screen.getDisplayNearestPoint(p).workArea,
  cursor: () => cursor,
  persistAnchor: () => {},
  timers,
  createDropdown: () => dropdownWiring.create(),
  onDropdownClosed: (e) => dropdownWiring.notifyClosed(e)
})
const tracked = new Proxy(ctl, {
  get(target, key) {
    const v = target[key]
    if (typeof v !== 'function') return v
    return (...args) => {
      const r = v.apply(target, args)
      if (r && typeof r.then === 'function') {
        pending++
        r.then(
          () => pending--,
          () => pending--
        )
      }
      return r
    }
  }
})

// ── Synthetic fixtures for every non-window channel the production preload calls ──
const recordings = [
  { sessionId: 'tsess_ui_failed', startedAt: '2026-10-01T10:00:00.000Z', saveState: 'complete', canRetrySave: false, reviewState: 'approved', interpretationState: 'failed', interpretationErrorCode: 'OPENAI_UNKNOWN_EVIDENCE', interpretationMessage: 'Workflow processing returned unsupported evidence references. Your recording was saved and can be retried.', approvedAt: '2026-10-01T10:05:00.000Z', approvedModel: 'synthetic-model', approvalCurrent: false },
  { sessionId: 'tsess_ui_partial', startedAt: '2026-10-01T09:00:00.000Z', saveState: 'complete', canRetrySave: false, reviewState: 'approved', interpretationState: 'complete', partial: true, workflowId: 'wf_ui_partial', approvedAt: '2026-10-01T09:05:00.000Z', approvedModel: 'synthetic-model', approvalCurrent: true },
  { sessionId: 'tsess_ui_legacy', startedAt: '2026-09-30T09:00:00.000Z', saveState: 'legacy_unverified', canRetrySave: false, reviewState: 'pending', interpretationState: 'not_started' }
]
const preview = {
  sessionId: 'tsess_ui_failed', revision: 2, digest: 'f'.repeat(64), provider: 'openai', model: 'synthetic-model',
  purpose: 'Interpret this recording into a draft workflow', stages: 'Classify, then extract.',
  payloadText: JSON.stringify({ acts: [{ i: 1, c: 'act', ids: ['e0'], a: 'FixtureApp', e: 'Submit' }] }, null, 2),
  bytes: 90, actionCount: 1, elided: false, categories: ['Recorded actions'], exclusions: ['Screenshots and screen video', 'Raw microphone audio'], legacyUnverified: false
}
const snapshot = {
  version: 1, workflows: [], runs: [], activity: [], suggestion: null, discardedSuggestionIds: [],
  recordSettings: { recordMode: 'one-app', narrate: false, selectedAppId: 'chrome' }, pillPosition: null,
  onboardingComplete: true, onboardingStep: 'done', session: null, team: null, micSkipped: true,
  permissionToastDismissedAt: null, lastPermissionRevokeAt: null
}
const fixtures = {
  'store:getSnapshot': () => snapshot,
  'permissions:get': () => ({ screen: 'granted', accessibility: 'granted', microphone: 'granted' }),
  'telemetry:getStatus': () => ({ recording: false, paused: false, sessionId: null, sequence: 0, startedAt: null, processing: false }),
  'telemetry:listRecordings': () => recordings,
  'telemetry:getRecording': (_e, id) => ({ ok: true, recording: recordings.find((r) => r.sessionId === id) }),
  'telemetry:prepareReview': (_e, id) => ({ ok: true, preview: { ...preview, sessionId: id }, recording: recordings.find((r) => r.sessionId === id) }),
  'workspace:open': (_e, focus) => openWorkspace(focus)
}
// window:hideForRestore stays listed so the harness can still run against pre-R1 sources.
const handled = new Set(['window:setBounds', 'window:hideForRestore', 'window:restorePill', 'pill:dragStart', 'pill:dragEnd', 'dropdown:open', 'dropdown:close', 'dropdown:dragStart', 'dropdown:dragEnd'])
const preloadSrc = fs.readFileSync(path.join(ROOT, 'out/preload/index.js'), 'utf8')
const channels = new Set([...preloadSrc.matchAll(/invoke\(\s*["']([^"']+)["']/g)].map((m) => m[1]))
for (const ch of channels) {
  if (handled.has(ch)) continue
  ipcMain.handle(ch, (...args) => (fixtures[ch] ? fixtures[ch](...args) : undefined))
}
ipcMain.on('window:setIgnoreMouseEvents', () => {})
// Every transition request is logged; `holdNext` delays one acknowledgement (after main has
// applied it, as a slow renderer round trip would) so a lifetime can end while it is pending.
const ipcLog = []
let holdNext = null
const countingIpc = {
  handle: (ch, fn) =>
    ipcMain.handle(ch, async (...a) => {
      const entry = { ch, arg: a[1], t: Date.now() }
      ipcLog.push(entry)
      const r = await fn(...a)
      if (holdNext && holdNext.match(entry)) {
        const h = holdNext
        holdNext = null
        h.entry = entry
        h.received()
        await h.gate
      }
      return r
    }),
  on: (...a) => ipcMain.on(...a)
}
T.registerTransitionIpc(countingIpc, (wc) => BrowserWindow.fromWebContents(wc), tracked, () => pill)

// The real dropdown factory builds its child through this constructor so the harness can
// count the child's native operations; options and loading are the production ones.
let ddChild = null
const dd = { created: 0, shows: 0, hides: 0, bounds: 0, live: new Set(), maxLive: 0, tShow: 0 }
function ChildWindow(opts) {
  const win = new BrowserWindow(opts)
  ddChild = win
  dd.created++
  dd.live.add(win)
  dd.maxLive = Math.max(dd.maxLive, dd.live.size)
  dd.lastOptions = { show: opts.show, transparent: opts.transparent, hasShadow: opts.hasShadow, additionalArguments: opts.webPreferences.additionalArguments, preload: path.relative(ROOT, opts.webPreferences.preload) }
  win.on('closed', () => {
    dd.live.delete(win)
    if (ddChild === win) ddChild = null
  })
  const show = win.show.bind(win)
  win.show = () => ((dd.shows++, (dd.tShow = Date.now())), show())
  const hide = win.hide.bind(win)
  win.hide = () => (dd.hides++, hide())
  const setBounds = win.setBounds.bind(win)
  win.setBounds = (...a) => (dd.bounds++, setBounds(...a))
  return win
}
const dropdownWiring = T.createRecordDropdownWiring({
  ipc: countingIpc,
  BrowserWindow: ChildWindow,
  preload: path.join(ROOT, 'out/preload/index.js'),
  load: (win) => win.loadFile(rendererHtml, { hash: T.RECORD_DROPDOWN_HASH }),
  pill: () => pill,
  ctl: () => tracked
})
const ddVisible = () => !!ddChild && !ddChild.isDestroyed() && ddChild.isVisible()
async function childDom() {
  if (!ddChild || ddChild.isDestroyed()) return null
  return ddChild.webContents.executeJavaScript(`(() => {
    const p = document.querySelector('.record-panel')
    const r = p && p.getBoundingClientRect()
    const cs = p && getComputedStyle(p)
    const scroller = document.querySelector('.record-dropdown')
    return {
      panel: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      style: cs ? { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor, shadow: cs.boxShadow, background: cs.backgroundColor, filter: cs.filter } : null,
      scroll: scroller ? { client: scroller.clientHeight, scroll: scroller.scrollHeight } : null,
      record: (() => { const b = document.querySelector('.btn-record'); return b ? { disabled: b.disabled } : null })(),
      hint: !!document.querySelector('.record-hint-warn'),
      mode: (document.querySelector('.segment-active') || {}).textContent || null,
      apps: document.querySelectorAll('.app-row').length,
      font: getComputedStyle(document.body).fontFamily,
      ghostBridge: typeof window.ghostBridge,
      vw: innerWidth, vh: innerHeight
    }
  })()`)
}

// The harness owns its exit; recreating the pill must not quit the app.
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const preloadPath = path.join(ROOT, 'out/preload/index.js')
let rendererHtml = path.join(ROOT, 'out/renderer/index.html')

function createPill(anchor) {
  const bounds = { x: anchor.x - T.PILL_W, y: anchor.y - T.PILL_H, width: T.PILL_W, height: T.PILL_H }
  ctl.setAnchor(anchor)
  pill = new BrowserWindow({
    ...bounds,
    ...T.PILL_WINDOW_OPTIONS,
    webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true }
  })
  pill.setWindowButtonVisibility(false)
  pill.setAlwaysOnTop(true, 'floating')
  countWin(pill, 'pill')
  ctl.attachPill(pill, {})
  pill.on('blur', () => nativeBlurs++)
  if (T.BACKDROP_WINDOW_OPTIONS) {
    for (const k of ['pill', 'panel']) {
      const b = new BrowserWindow({ ...T.BACKDROP_WINDOW_OPTIONS })
      b.setIgnoreMouseEvents(true)
      b.setAlwaysOnTop(true, 'floating')
      b.setOpacity(0)
      b.loadURL('about:blank')
      b.showInactive()
      countWin(b, 'backdrop')
      backdrops[k] = b
    }
    pill.moveTop()
  }
  return pill.loadFile(rendererHtml)
}

function openWorkspace(focus) {
  if (!workspace) {
    workspace = new BrowserWindow({
      width: 879, height: 621, frame: false, transparent: true, resizable: false, hasShadow: false,
      webPreferences: { preload: preloadPath, sandbox: false, contextIsolation: true }
    })
    workspace.webContents.once('did-finish-load', () => workspace.webContents.send('workspace:focus', focus))
    workspace.loadFile(rendererHtml, { hash: 'workspace' })
  } else {
    workspace.webContents.send('workspace:focus', focus)
  }
}

async function dom(win = pill) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.ghost-root')
    const p = document.querySelector('.pill')
    const m = document.querySelector('.morph-panel')
    const card = m && m.firstElementChild
    const pr = p && p.getBoundingClientRect()
    const mr = m && m.getBoundingClientRect()
    const cr = card && card.getBoundingClientRect()
    const slot = document.querySelector('.panel-slot')
    const sr = slot && slot.getBoundingClientRect()
    return {
      root: root ? root.className : '',
      pill: pr ? { x: pr.x, y: pr.y, w: pr.width, h: pr.height } : null,
      panel: mr ? { x: mr.x, y: mr.y, w: mr.width, h: mr.height, opacity: Number(getComputedStyle(m).opacity) } : null,
      card: cr ? { x: cr.x, y: cr.y, w: cr.width, h: cr.height, cls: card.className } : null,
      slot: sr ? { x: sr.x, y: sr.y, w: sr.width, h: sr.height } : null,
      vw: innerWidth, vh: innerHeight
    }
  })()`)
}

function snap() {
  return {
    bounds: pill.getBounds(),
    visible: pill.isVisible(),
    ctl: ctl.inspect(),
    dropdown: { visible: ddVisible(), live: dd.live.size },
    backdrops: Object.values(backdrops).filter(Boolean).map((b) => ({ visible: b.isVisible(), opacity: b.getOpacity(), bounds: b.getBounds() })),
    timers: live.timeouts.size + live.intervals.size,
    pending
  }
}

function send(type, x, y, extra = {}) {
  pill.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra })
}

async function clickPill() {
  // A native click on the pill (acceptFirstMouse) makes it the key window first.
  if (!pill.isFocused()) {
    pill.focus()
    await sleep(15)
  }
  const d = await dom()
  if (!d.pill) return false
  const x = d.pill.x + d.pill.w / 2
  const y = d.pill.y + d.pill.h / 2
  send('mouseDown', x, y)
  send('mouseUp', x, y)
  return true
}

/** Synthetic drag of the pill by (dx, dy) screen px using the scripted cursor. */
async function dragPill(dx, dy, opts = {}) {
  const d = await dom()
  const b = pill.getBounds()
  const lx = d.pill.x + d.pill.w / 2
  const ly = d.pill.y + d.pill.h / 2
  cursor = { x: b.x + lx, y: b.y + ly }
  send('mouseDown', lx, ly)
  send('mouseMove', lx + 6, ly, { button: undefined })
  await sleep(40)
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    cursor = { x: b.x + lx + (dx * i) / steps, y: b.y + ly + (dy * i) / steps }
    await sleep(20)
  }
  if (opts.beforeRelease) await opts.beforeRelease()
  if (opts.noRelease) return
  const nb = pill.getBounds()
  send('mouseUp', cursor.x - nb.x, cursor.y - nb.y)
  await sleep(60)
}

/** Window bottom-right of the visible pill capsule (the user-visible anchor). */
function visibleAnchor() {
  const s = ctl.inspect()
  return s.anchor ? { ...s.anchor } : null
}

/** Minimal PNG (RGBA/RGB, 8-bit, non-interlaced) alpha decoder for app-window captures. */
function decodePng(buf) {
  const zlib = require('zlib')
  let pos = 8
  let w = 0, h = 0, ct = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      ct = data[9]
    }
    if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const bpp = ct === 6 ? 4 : 3
  const stride = w * bpp
  const out = Buffer.alloc(h * stride)
  let prev = Buffer.alloc(stride)
  for (let y = 0, i = 0; y < h; y++) {
    const f = raw[i++]
    const line = Buffer.from(raw.subarray(i, i + stride))
    i += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0
      const up = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + up) & 255
      else if (f === 3) line[x] = (line[x] + ((a + up) >> 1)) & 255
      else if (f === 4) {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)) & 255
      }
    }
    line.copy(out, y * stride)
    prev = line
  }
  return { w, h, alpha: (x, y) => (bpp === 4 ? out[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4 + 3] : 255) }
}

async function capture(name, win = pill) {
  const img = await win.webContents.capturePage()
  const png = img.toPNG()
  fs.writeFileSync(path.join(SHOTS, name + '.png'), png)
  const dec = decodePng(png) // device pixels — ground truth of what was written
  const dip = win.getContentBounds()
  const scale = Math.round(dec.w / Math.max(1, dip.width))
  return { size: { width: dip.width, height: dip.height }, scale, alpha: dec.alpha }
}

const report = { identity, display: null, scenarios: {} }
const failures = []
function fail(scenario, kind, detail) {
  failures.push({ scenario, kind, detail })
}

/** Invariants for a settled idle pill. */
async function checkIdle(scenario, expectedAnchor) {
  await sleep(700)
  const s = snap()
  const d = await dom()
  if (!/ghost-root-pill/.test(d.root) || s.ctl.mode !== 'pill') fail(scenario, 'stale_mode', { root: d.root, mode: s.ctl.mode })
  if (!s.visible || s.bounds.x < -10000) fail(scenario, 'hidden_or_parked', s.bounds)
  if (s.bounds.height > T.PILL_H + 4) fail(scenario, 'tall_idle_frame', s.bounds)
  const br = { x: s.bounds.x + s.bounds.width, y: s.bounds.y + s.bounds.height }
  if (expectedAnchor && (Math.abs(br.x - expectedAnchor.x) > 1 || Math.abs(br.y - expectedAnchor.y) > 1)) {
    fail(scenario, 'teleport', { expected: expectedAnchor, actual: br })
  }
  if (d.pill && (d.pill.x < -0.5 || d.pill.y < -0.5 || d.pill.x + d.pill.w > d.vw + 0.5 || d.pill.y + d.pill.h > d.vh + 0.5)) {
    fail(scenario, 'clipped_pill', { pill: d.pill, vw: d.vw, vh: d.vh })
  }
  for (const b of s.backdrops) {
    if (b.visible && b.opacity > 0 && !s.visible) fail(scenario, 'ghost_backdrop', b)
  }
  if (s.ctl.dragging) fail(scenario, 'stuck_gesture', {})
  if (s.pending > 0) fail(scenario, 'unsettled_promise', { pending: s.pending })
  if (s.timers > 0) fail(scenario, 'owned_timer_after_settle', { timers: s.timers })
  if (ddVisible() || s.ctl.dropdown.open) fail(scenario, 'dropdown_still_open', { visible: ddVisible(), open: s.ctl.dropdown.open })
  return { s, d }
}

/**
 * Open (M1-HF3): the Record dropdown child is visible beside an unchanged, still pill-mode
 * capsule, and the real RecordPanel fits inside the child (fitted heights scroll).
 */
async function checkOpen(scenario) {
  await sleep(700)
  const s = snap()
  const d = await dom()
  const c = await childDom()
  const ddBounds = ddChild && !ddChild.isDestroyed() ? ddChild.getBounds() : null
  if (!ddVisible() || !s.ctl.dropdown.open || !/ghost-root-pill/.test(d.root) || !c || !c.panel) {
    fail(scenario, 'not_open', { root: d.root, open: s.ctl.dropdown.open, visible: ddVisible(), panel: c && c.panel })
  }
  if (s.bounds.height > T.PILL_H + 4 || s.bounds.width > 260) fail(scenario, 'pill_reshaped_on_open', s.bounds)
  if (c && c.panel && (c.panel.x < -0.5 || c.panel.y < -0.5 || c.panel.x + c.panel.w > c.vw + 0.5)) {
    fail(scenario, 'clipped_panel', { panel: c.panel, vw: c.vw, vh: c.vh })
  }
  if (s.pending > 0) fail(scenario, 'unsettled_promise', { pending: s.pending })
  return { s, d, c, ddBounds }
}

/** Return to a settled idle pill (so one scenario's defect is not recounted by the next). */
async function ensureIdle() {
  for (let i = 0; i < 3; i++) {
    const d = await dom()
    if (/ghost-root-pill/.test(d.root) && !ddVisible() && pill.getBounds().height <= T.PILL_H + 4) return
    if (ddVisible()) await clickPill()
    await sleep(800)
  }
}

async function run() {
  await app.whenReady()
  const primary = screen.getPrimaryDisplay()
  report.display = { scaleFactor: primary.scaleFactor, bounds: primary.bounds, workArea: primary.workArea, displays: screen.getAllDisplays().length }
  const wa = primary.workArea
  const bottomAnchor = { x: wa.x + wa.width - 40, y: wa.y + wa.height - 40 }
  await createPill(bottomAnchor)
  await sleep(1200)
  pill.focus()

  // 1. Visual states: idle, mid-open (backdrop vs fading content), open, mid-close.
  {
    const sc = 'visual_states'
    const idle = await capture('idle_above')
    const cornerA = idle.alpha(1, 1)
    const centerA = idle.alpha(Math.round((idle.size.width * idle.scale) / 2), Math.round((idle.size.height * idle.scale) / 2))
    await clickPill()
    await sleep(45)
    const mid = snap()
    const midDom = await dom()
    const midShot = await capture('opening_above')
    const panelBd = mid.backdrops[1]
    const flash = !!(panelBd && panelBd.visible && panelBd.opacity > 0 && midDom.panel && midDom.panel.opacity < 1)
    if (flash) fail(sc, 'backdrop_visible_while_content_fading', { contentOpacity: midDom.panel.opacity })
    const open = await checkOpen(sc)
    // The dropdown is its own window: capture it (synthetic Gray window only) and the
    // unchanged pill. Corner of the paper panel (CSS radius 20) must be transparent.
    const openShot = await capture('open_above_dropdown', ddChild)
    const pillWhileOpen = await capture('open_above_pill')
    const panelTopLeft = open.c && open.c.panel
      ? openShot.alpha(Math.round((open.c.panel.x + 1) * openShot.scale), Math.round((open.c.panel.y + 1) * openShot.scale))
      : null
    const pillCornerWhileOpen = pillWhileOpen.alpha(1, 1)
    if (pillCornerWhileOpen > 32) fail(sc, 'square_pill_corner_while_open', { alpha: pillCornerWhileOpen })
    const exposure = open.s.backdrops.filter((b) => b.visible && b.opacity > 0).map((b) => ({
      bounds: b.bounds,
      note: 'native backdrop window inset 1px inside a CSS radius-20/10 silhouette; any native corner radius < ~16.6px (panel) shows material outside the paper corner'
    }))
    await clickPill()
    await sleep(90)
    const closing = snap()
    await capture('closing_above')
    const closed = await checkIdle(sc, bottomAnchor)
    report.scenarios[sc] = {
      idleCornerAlpha: cornerA, idleCenterAlpha: centerA,
      midOpen: { backdrops: mid.backdrops, contentOpacity: midDom.panel ? midDom.panel.opacity : null, root: midDom.root },
      openPanelCornerAlpha: panelTopLeft, pillCornerWhileOpen, backdropExposure: exposure, dropdownStyle: open.c && open.c.style, dropdownBounds: open.ddBounds,
      closing: { mode: closing.ctl.mode, bounds: closing.bounds, backdrops: closing.backdrops },
      closedBounds: closed.s.bounds,
      openDom: open.d,
      openChild: open.c,
      captureScale: idle.scale
    }
    if (cornerA > 32) fail(sc, 'square_pill_corner', { alpha: cornerA })
    if (panelTopLeft != null && panelTopLeft > 32) fail(sc, 'square_panel_corner', { alpha: panelTopLeft })
  }

  // 2. 20 open/close cycles.
  {
    const sc = 'open_close_20'
    const before = failures.length
    const t0 = Date.now()
    const b0 = boundsUpdates
    const bd0 = backdropUpdates
    for (let i = 0; i < 20; i++) {
      await clickPill()
      await checkOpen(sc)
      await clickPill()
      await checkIdle(sc, bottomAnchor)
    }
    report.scenarios[sc] = { failures: failures.length - before, elapsedMs: Date.now() - t0, boundsUpdatesPerCycle: (boundsUpdates - b0) / 20, backdropUpdatesPerCycle: (backdropUpdates - bd0) / 20 }
  }

  // 3. Rapid open → close → open: latest request wins, coherent final state.
  {
    const sc = 'rapid_open_close_open'
    await ensureIdle()
    const before = failures.length
    await clickPill()
    await sleep(30)
    await clickPill()
    await sleep(30)
    await clickPill()
    const r = await checkOpen(sc)
    report.scenarios[sc] = { failures: failures.length - before, finalRoot: r.d.root, finalMode: r.s.ctl.mode, finalBounds: r.s.bounds }
    await ensureIdle()
    await checkIdle(sc, bottomAnchor)
  }

  // 4. Close → new open → late close completion must not demote the new open.
  {
    const sc = 'close_then_open_stale_completion'
    await ensureIdle()
    const before = failures.length
    await clickPill()
    await sleep(600)
    await clickPill() // close starts (fade timer pending)
    await sleep(20)
    await clickPill() // user re-opens quickly
    const r = await checkOpen(sc)
    report.scenarios[sc] = { failures: failures.length - before, finalRoot: r.d.root, finalMode: r.s.ctl.mode, finalBounds: r.s.bounds }
    await ensureIdle()
    await checkIdle(sc, bottomAnchor)
  }

  // 5. 20 drag-release cycles; final anchor must be the latest placement.
  {
    const sc = 'drag_release_20'
    await ensureIdle()
    const before = failures.length
    const b0 = boundsUpdates
    const bd0 = backdropUpdates
    let expected = visibleAnchor()
    for (let i = 0; i < 20; i++) {
      const dx = i % 2 ? 37 : -37
      await dragPill(dx, i % 3 ? -11 : 11)
      expected = { x: pill.getBounds().x + pill.getBounds().width, y: pill.getBounds().y + pill.getBounds().height }
      if (ctl.inspect().dragging) fail(sc, 'stuck_gesture', { cycle: i })
      const d = await dom()
      if (!/ghost-root-pill/.test(d.root)) fail(sc, 'post_drag_activation', { cycle: i, root: d.root })
    }
    // Open/close after the drags must come back to the latest drop point, not an older rect.
    await clickPill()
    await checkOpen(sc)
    await clickPill()
    await checkIdle(sc, expected)
    report.scenarios[sc] = { failures: failures.length - before, boundsUpdatesPerDrag: (boundsUpdates - b0) / 20, backdropUpdatesPerDrag: (backdropUpdates - bd0) / 20, finalAnchor: expected }
  }

  // 6. Drag the open panel, then close: restore must use the dropped location.
  {
    const sc = 'drag_open_then_close'
    await ensureIdle()
    const before = failures.length
    await clickPill()
    const o = await checkOpen(sc)
    const rel = (p, c) => ({ dx: c.x - p.x, dy: c.y - p.y })
    const before0 = o.ddBounds ? rel(pill.getBounds(), o.ddBounds) : null
    await dragPill(-60, -30)
    const b = pill.getBounds()
    // The dropdown moved with the pill (same offset) and stayed open.
    const after0 = ddChild ? rel(b, ddChild.getBounds()) : null
    if (!ddVisible() || JSON.stringify(before0) !== JSON.stringify(after0)) fail(sc, 'dropdown_did_not_follow_drag', { before0, after0, visible: ddVisible() })
    const expected = { x: b.x + b.width, y: b.y + b.height }
    await clickPill()
    await checkIdle(sc, expected)
    report.scenarios[sc] = { failures: failures.length - before, expected, offsetBefore: before0, offsetAfter: after0 }
  }

  // 7. Blur during a drag (no release delivered): the gesture must end.
  {
    const sc = 'blur_during_drag'
    await ensureIdle()
    const before = failures.length
    await dragPill(30, 0, { noRelease: true })
    const draggingBefore = ctl.inspect().dragging
    pill.webContents.executeJavaScript('window.dispatchEvent(new Event("blur"))')
    pill.blur()
    await sleep(300)
    const stuck = ctl.inspect().dragging
    if (stuck) fail(sc, 'stuck_gesture_after_blur', {})
    cursor = { x: cursor.x + 200, y: cursor.y }
    await sleep(100)
    report.scenarios[sc] = { failures: failures.length - before, draggingBeforeBlur: draggingBefore, draggingAfterBlur: stuck }
    // Clean up a stuck gesture (before-fix) so later scenarios stay comparable.
    if (stuck) {
      const nb = pill.getBounds()
      send('mouseUp', cursor.x - nb.x, cursor.y - nb.y)
      await sleep(100)
    }
    pill.focus()
    await sleep(200)
  }

  // 8. Close while dragging the open panel (Escape), then release.
  {
    const sc = 'close_while_dragging'
    await ensureIdle()
    const before = failures.length
    await clickPill()
    await checkOpen(sc)
    let dropped = null
    await dragPill(-40, 0, {
      beforeRelease: async () => {
        pill.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        pill.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        await sleep(450)
      }
    })
    const b = pill.getBounds()
    dropped = { x: b.x + b.width, y: b.y + b.height }
    await checkIdle(sc, dropped)
    report.scenarios[sc] = { failures: failures.length - before, dropped }
  }

  // 9. Collapsed ↔ expanded panel state (editor), and post-drag click on a clickable pill.
  {
    const sc = 'collapsed_expanded_post_drag_click'
    const before = failures.length
    pill.webContents.send('pill:openEditor')
    await sleep(700)
    const expanded = await dom()
    await capture('editor_expanded')
    await pill.webContents.executeJavaScript(`document.querySelector('[title="Collapse"]')?.click()`)
    await sleep(700)
    const collapsed = await dom()
    await capture('editor_collapsed')
    await dragPill(25, 0)
    await sleep(500)
    const afterDrag = await dom()
    const reopened = !/ghost-root-pill/.test(afterDrag.root)
    if (reopened) fail(sc, 'post_drag_click_expanded_panel', { root: afterDrag.root })
    report.scenarios[sc] = { failures: failures.length - before, expandedRoot: expanded.root, collapsedRoot: collapsed.root, afterDragRoot: afterDrag.root }
  }

  // 10. Below placement near the top of the work area.
  {
    const sc = 'below_placement'
    const before = failures.length
    pill.destroy()
    pill = null
    for (const k of ['pill', 'panel']) {
      backdrops[k]?.destroy()
      backdrops[k] = null
    }
    await sleep(200)
    const topAnchor = { x: wa.x + wa.width - 40, y: wa.y + 60 }
    await createPill(topAnchor)
    await sleep(1200)
    pill.focus()
    await clickPill()
    const open = await checkOpen(sc)
    const shot = await capture('open_below_dropdown', ddChild)
    const placement = open.s.ctl.dropdown.placement
    const below = open.ddBounds && open.ddBounds.y >= open.s.bounds.y + open.s.bounds.height
    if (placement !== 'below' || !below) fail(sc, 'placement', { placement, dropdown: open.ddBounds, pill: open.s.bounds })
    const c = open.c
    const panelCorner = c && c.panel ? shot.alpha(Math.round((c.panel.x + 1) * shot.scale), Math.round((c.panel.y + c.panel.h - 2) * shot.scale)) : null
    if (panelCorner != null && panelCorner > 32) fail(sc, 'square_panel_corner', { alpha: panelCorner })
    await clickPill()
    await checkIdle(sc, topAnchor)
    report.scenarios[sc] = { failures: failures.length - before, placement, panelBottomLeftAlpha: panelCorner, openChild: c, dropdownBounds: open.ddBounds, pillBounds: open.s.bounds }
  }

  // 11. Library / review navigation with failure and partial labels (synthetic summaries).
  {
    const sc = 'library_review_labels'
    openWorkspace({})
    await sleep(1500)
    const listText = await workspace.webContents.executeJavaScript('document.body.innerText')
    await capture('library', workspace)
    openWorkspace({ sessionId: 'tsess_ui_failed' })
    await sleep(800)
    const reviewText = await workspace.webContents.executeJavaScript('document.body.innerText')
    await capture('review_failed', workspace)
    const checks = {
      failedLabel: listText.includes('Interpretation failed'),
      partialLabel: listText.includes('Interpreted (partial)'),
      legacyLabel: listText.includes('completeness unverified'),
      reReviewReason: reviewText.includes('previous version of this review'),
      approveButton: reviewText.includes('Approve and send for interpretation')
    }
    for (const [k, ok] of Object.entries(checks)) if (!ok) fail(sc, 'missing_label', { k })
    report.scenarios[sc] = checks
  }

  // ── Teardown: no owned timer/window may survive ──
  workspace?.destroy()
  pill?.destroy()
  for (const k of ['pill', 'panel']) backdrops[k]?.destroy()
  await sleep(300)
  report.teardown = { ownedTimers: live.timeouts.size + live.intervals.size, pendingPromises: pending, windows: BrowserWindow.getAllWindows().length, dropdownsCreated: dd.created, maxLiveDropdowns: dd.maxLive, liveDropdowns: dd.live.size }
  if (report.teardown.ownedTimers > 0) fail('teardown', 'owned_timer', report.teardown)
  if (dd.live.size || dd.maxLive > 1) fail('teardown', 'dropdown_leftover', report.teardown)
  report.failures = failures
  report.failureCounts = failures.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] || 0) + 1), acc), {})
  fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
  console.log('SMOKE-REPORT ' + JSON.stringify({ identity, display: report.display, failureCounts: report.failureCounts, teardown: report.teardown, scenarios: report.scenarios }))
  app.exit(failures.length ? 1 : 0)
}

// ── M1-HF2-R1 pill lifecycle (development and production React, StrictMode kept) ──

async function bundleRenderer(mode) {
  const esbuild = require(path.join(ROOT, 'node_modules/esbuild'))
  const outdir = path.join(fxReal, 'renderer-' + mode)
  const shim = `
    import real from 'react-dom/client'
    let last = null
    export function createRoot(el, opts) {
      const root = real.createRoot(el, opts)
      const render = root.render.bind(root)
      root.render = (node) => { last = { el, node, root }; return render(node) }
      return root
    }
    export const hydrateRoot = real.hydrateRoot
    export default { ...real, createRoot }
    window.__grayHarness = {
      unmount() { last.root.unmount() },
      mount() { const r = real.createRoot(last.el); last.root = r; r.render(last.node) }
    }`
  const shimPlugin = {
    name: 'harness-root-shim',
    setup(build) {
      build.onResolve({ filter: /^react-dom\/client$/ }, (args) =>
        args.namespace === 'harness' ? undefined : { path: 'react-dom-client-shim', namespace: 'harness' }
      )
      build.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ contents: shim, loader: 'js', resolveDir: ROOT }))
    }
  }
  await esbuild.build({
    entryPoints: { main: path.join(ROOT, 'src/renderer/src/main.tsx') },
    outdir,
    bundle: true,
    format: 'iife',
    minify: false,
    jsx: 'automatic',
    jsxDev: mode === 'development',
    define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
    loader: { '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file' },
    assetNames: 'assets/[name]-[hash]',
    plugins: [shimPlugin],
    logLevel: 'silent'
  })
  const html = path.join(outdir, 'index.html')
  fs.writeFileSync(html, '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><title>Ghost</title><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script src="main.js"></script></body></html>')
  const js = fs.readFileSync(path.join(outdir, 'main.js'), 'utf8')
  return {
    html,
    // esbuild keeps source path comments when not minified: the bundled React runtime file.
    reactDom: (/node_modules\/react-dom\/cjs\/(react-dom\.[a-z.]+)\.js/.exec(js) || [])[1] || 'unknown',
    strictMode: /import_react\d*\.default\.StrictMode/.test(js),
    rendererSource: sha(path.join(ROOT, 'src/renderer/src/state/WorkflowContext.tsx'))
  }
}

// M1-HF3: the pill opens/closes its dropdown through main; it never resizes for it.
const isOpenReq = (e) => e.ch === 'dropdown:open'
const isCloseReq = (e) => e.ch === 'dropdown:close'
const isPillSync = (e) => e.ch === 'window:setBounds' && e.arg && e.arg.mode === 'pill' && !e.arg.pillDrive
const since = (i, pred) => ipcLog.slice(i).filter(pred).length
const rootClass = async () => (await dom()).root

async function waitFor(pred, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return true
    await sleep(25)
  }
  return false
}

/**
 * One ordinary closed→open click: exactly one open request and a visible dropdown. An open
 * dropdown correctly closes on window blur; if a native blur (another app on this live
 * desktop taking focus) closed it, retry once and count it rather than fail.
 */
async function clickOpens(sc, label) {
  let i = ipcLog.length
  for (let attempt = 0; attempt < 2; attempt++) {
    i = ipcLog.length
    const b0 = nativeBlurs
    await clickPill()
    await sleep(700)
    if (ddVisible() || nativeBlurs === b0 || attempt === 1) break
    externalBlurRetries++
    await sleep(500)
  }
  const r = await checkOpen(sc)
  const opens = since(i, isOpenReq)
  if (opens !== 1) fail(sc, 'open_requests', { label, opens })
  return { label, opens, root: r.d.root, dropdown: !!(r.c && r.c.panel) }
}

async function closesTo(sc, how, anchor) {
  const i = ipcLog.length
  await how()
  const r = await checkIdle(sc, anchor)
  return { closes: since(i, isCloseReq), root: r.d.root }
}

function holdOne(match) {
  let release
  let received
  const h = { match, gate: new Promise((r) => (release = r)), release: () => release() }
  h.arrived = new Promise((r) => (received = r))
  h.received = received
  holdNext = h
  return h
}

async function runLifecycle() {
  // Bounded: a stuck step reports instead of hanging.
  setTimeout(() => {
    fail('watchdog', 'timeout', {})
    report.failures = failures
    fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
    console.log('SMOKE-REPORT ' + JSON.stringify({ watchdog: true, scenarios: report.scenarios, failures }))
    app.exit(4)
  }, 240000).unref()
  await app.whenReady()
  const primary = screen.getPrimaryDisplay()
  report.display = { scaleFactor: primary.scaleFactor, workArea: primary.workArea, displays: screen.getAllDisplays().length }
  const bundle = await bundleRenderer(RENDERER_MODE)
  rendererHtml = bundle.html
  report.identity = { ...identity, rendererMode: RENDERER_MODE, ...bundle, html: undefined }
  if (bundle.reactDom !== (RENDERER_MODE === 'development' ? 'react-dom.development' : 'react-dom.production.min')) {
    refuse('bundled React runtime ' + bundle.reactDom + ' does not match --renderer-mode=' + RENDERER_MODE)
    return
  }
  if (!bundle.strictMode) fail('identity', 'strict_mode_missing', {})
  const wa = primary.workArea
  const anchor = { x: wa.x + wa.width - 40, y: wa.y + wa.height - 40 }
  const sc = 'pill-lifecycle'
  const steps = {}
  report.scenarios[sc] = steps

  // Mount: the provider syncs the pill size once per renderer lifetime (M1-HF3 de-duplicates
  // the StrictMode effect replay, so the stationary pill gets no redundant native call).
  await createPill(anchor)
  await sleep(1200)
  pill.focus()
  steps.mount = { initialPillSync: since(0, isPillSync), bridge: await pill.webContents.executeJavaScript('typeof window.ghostBridge.openDropdown'), firstAck: await pill.webContents.executeJavaScript('window.ghostBridge.setBounds(94, 24, "pill", {}).then((a) => Object.keys(a).sort().join(","))') }
  if (steps.mount.initialPillSync < 1 || steps.mount.bridge !== 'function') fail(sc, 'mount', steps.mount)
  await checkIdle(sc, anchor)
  // A synthetic app window that takes focus for outside-dismissal (never always-on-top).
  const outside = new BrowserWindow({ x: wa.x + 40, y: wa.y + 40, width: 200, height: 120, frame: false, skipTaskbar: true, show: true })
  outside.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:#e8e6df">synthetic</body>'))
  const outsideFocus = async () => {
    outside.focus()
    await waitFor(async () => !ddVisible(), 1500)
  }

  // 1. First ordinary click opens; second closes.
  steps.firstClick = await clickOpens(sc, 'first')
  steps.secondClick = await closesTo(sc, clickPill, anchor)

  // 2. Ten open/close pairs.
  {
    const i = ipcLog.length
    const before = failures.length
    for (let n = 0; n < 10; n++) {
      await clickOpens(sc, 'pair' + n)
      await closesTo(sc, clickPill, anchor)
    }
    steps.pairs10 = { presses: 20, opens: since(i, isOpenReq), closes: since(i, isCloseReq), failures: failures.length - before }
  }

  // 3. Escape and blur close, each followed by an ordinary reopen.
  await clickOpens(sc, 'pre-escape')
  steps.escape = await closesTo(sc, async () => {
    pill.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    pill.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }, anchor)
  steps.afterEscape = await clickOpens(sc, 'after-escape')
  steps.escapeInDropdown = await closesTo(sc, async () => {
    ddChild.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ddChild.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  }, anchor)
  steps.afterEscapeInDropdown = await clickOpens(sc, 'after-escape-in-dropdown')
  // Outside dismissal is main's focus group: focus moves to another (synthetic) window.
  steps.blur = await closesTo(sc, outsideFocus, anchor)
  steps.afterBlur = await clickOpens(sc, 'after-blur')
  await closesTo(sc, clickPill, anchor)

  // 4. Drag, then the next ordinary click opens (the drag's own click stays suppressed).
  {
    const i = ipcLog.length
    await dragPill(-37, -11)
    const afterDrag = await rootClass()
    if (!/ghost-root-pill/.test(afterDrag)) fail(sc, 'post_drag_activation', { root: afterDrag })
    const dropped = { x: pill.getBounds().x + pill.getBounds().width, y: pill.getBounds().y + pill.getBounds().height }
    steps.drag = { opensFromDrag: since(i, isOpenReq), next: await clickOpens(sc, 'after-drag') }
    await closesTo(sc, clickPill, dropped)
  }
  const home = ctl.inspect().anchor

  // 5. Existing Open Record Panel command (workspace/hotkey path).
  {
    const i = ipcLog.length
    pill.webContents.send('pill:openRecordPanel')
    const r = await checkOpen(sc)
    steps.openRecordPanelCommand = { opens: since(i, isOpenReq), root: r.d.root }
    if (steps.openRecordPanelCommand.opens !== 1) fail(sc, 'command_open_requests', steps.openRecordPanelCommand)
    await closesTo(sc, clickPill, home)
  }

  // 6. Real in-page unmount/remount of the React root (StrictMode replays again on mount).
  {
    const i = ipcLog.length
    await pill.webContents.executeJavaScript('window.__grayHarness.unmount()')
    await sleep(300)
    const afterUnmount = ipcLog.length - i
    await pill.webContents.executeJavaScript('window.__grayHarness.mount()')
    await sleep(800)
    steps.remount = { requestsWhileUnmounted: afterUnmount, pillSyncOnMount: since(i, isPillSync), next: await clickOpens(sc, 'after-remount') }
    await closesTo(sc, clickPill, home)
  }

  // 6b. Close trace: every renderer frame and native bounds/visibility sample during a close.
  // The visible pill must never be drawn anywhere but its anchored spot (no top-left flash).
  async function closeTrace(name, how) {
    await clickOpens(sc, name + '-open')
    await sleep(300)
    const expect = home
    await pill.webContents.executeJavaScript(`(() => {
      window.__frames = []
      const tick = () => {
        const p = document.querySelector('.pill')
        const r = p && p.getBoundingClientRect()
        const cs = p && getComputedStyle(p)
        const rootVis = getComputedStyle(document.querySelector('.ghost-root')).visibility
        window.__frames.push({ t: Date.now(), root: document.querySelector('.ghost-root').className, vis: document.visibilityState,
          sx: window.screenX, sy: window.screenY, iw: innerWidth, ih: innerHeight, pill: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
          shown: !!cs && rootVis === 'visible' && cs.visibility === 'visible' && Number(cs.opacity) === 1, filter: cs ? cs.filter : null })
        if (window.__frames.length < 400) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)
    const nat = []
    const onEv = (ev) => () => nat.push({ t: Date.now(), ev, visible: pill.isVisible(), b: pill.getBounds() })
    const evs = ['move', 'resize', 'hide', 'show']
    const fns = evs.map((e) => [e, onEv(e)])
    for (const [e, f] of fns) pill.on(e, f)
    const poll = setInterval(() => nat.push({ t: Date.now(), ev: 'poll', visible: pill.isVisible(), b: pill.getBounds() }), 2)
    await how()
    await sleep(900)
    clearInterval(poll)
    for (const [e, f] of fns) pill.removeListener(e, f)
    const frames = await pill.webContents.executeJavaScript('window.__frames.splice(0)')
    const visibleAt = (t) => {
      let last = null
      for (const n of nat) if (n.t <= t) last = n
      return last ? last.visible && last.b.x > -10000 : true
    }
    // A misplaced frame: a painted, on-screen pill whose bottom-right is off the anchor.
    const bad = frames.filter((f) => f.pill && f.vis === 'visible' && visibleAt(f.t) && !/ghost-root-parking/.test(f.root) &&
      (Math.abs(f.sx + f.pill.x + f.pill.w - expect.x) > 2 || Math.abs(f.sy + f.pill.y + f.pill.h - expect.y) > 2))
    // Native: visible pill-sized window not at the anchor (macOS painting size before origin).
    const badNative = nat.filter((n) => n.visible && n.b.x > -10000 && n.b.height <= T.PILL_H + 4 &&
      (Math.abs(n.b.x + n.b.width - expect.x) > 2 || Math.abs(n.b.y + n.b.height - expect.y) > 2))
    // Idle content painted while the window is not yet the final pill rect (parked, or still
    // glass-sized): any such frame is what a coalesced macOS hide/resize/show can put on
    // screen as a pill at the panel's corner. Hidden (.ghost-root-parking) frames are safe.
    const fin = pill.getBounds()
    const reshape = frames.filter((f) => f.pill && /ghost-root-pill/.test(f.root) && !/ghost-root-parking/.test(f.root) &&
      (f.sx !== fin.x || f.sy !== fin.y || f.iw !== fin.width || f.ih !== fin.height))
    if (reshape.length) fail(sc, 'content_during_reshape', { name, first: reshape[0], count: reshape.length })
    // macOS animates hide: any native hide/show during a close can leave a fading pill at
    // the old frame origin and a visible gap (user-recorded glitch).
    const hideShow = nat.filter((n) => n.ev === 'hide' || n.ev === 'show' || !n.visible).length
    if (hideShow) fail(sc, 'native_hide_show_during_close', { name, count: hideShow })
    if (bad.length) fail(sc, 'misplaced_pill_frame', { name, first: bad[0], count: bad.length })
    if (badNative.length) fail(sc, 'misplaced_native_pill', { name, first: badNative[0], count: badNative.length })
    await checkIdle(sc, expect)
    fs.writeFileSync(path.join(fxReal, 'trace-' + name + '.json'), JSON.stringify({ expect, frames, nat }, null, 1))
    // M1-HF3: the stationary pill is never hidden, filtered, moved or resized by a close.
    const hidden = frames.filter((f) => !f.pill || !f.shown || /ghost-root-parking/.test(f.root))
    const filtered = frames.filter((f) => f.filter && f.filter !== 'none')
    const reshaped = nat.filter((n) => n.ev === 'move' || n.ev === 'resize' || n.b.x !== fin.x || n.b.y !== fin.y || n.b.width !== fin.width || n.b.height !== fin.height)
    const hiddenTs = hidden.map((f) => f.t)
    if (hidden.length) fail(sc, 'pill_hidden_during_close', { name, count: hidden.length })
    if (filtered.length) fail(sc, 'pill_filtered_during_close', { name, count: filtered.length, first: filtered[0].filter })
    if (reshaped.length) fail(sc, 'pill_native_reshape_during_close', { name, count: reshaped.length })
    return { frames: frames.length, nativeSamples: nat.length, nativeHideShow: hideShow, hiddenMs: hiddenTs.length ? Math.max(...hiddenTs) - Math.min(...hiddenTs) : 0, contentDuringReshape: reshape.length, hiddenFrames: hidden.length, filteredFrames: filtered.length, nativeReshapeSamples: reshaped.length, misplacedFrames: bad.length, misplacedNative: badNative.length }
  }
  steps.closeTraceClick = await closeTrace('click', clickPill)
  steps.closeTraceEscape = await closeTrace('escape', async () => {
    pill.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    pill.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  steps.closeTraceBlur = await closeTrace('blur', outsideFocus)

  // 7. Held stale acknowledgements: an old lifetime's open/close completes after its cleanup.
  async function staleCase(name, kind, replace) {
    if (kind === 'close') await clickOpens(sc, name + '-open')
    const h = holdOne(kind === 'open' ? isOpenReq : isCloseReq)
    await clickPill()
    if (!(await Promise.race([h.arrived.then(() => true), sleep(3000).then(() => false)]))) {
      holdNext = null
      fail(sc, 'held_request_never_sent', { name })
      return { staleCalls: null, staleMutations: null, requestSent: false }
    }
    await replace()
    await sleep(800)
    const before = await dom()
    const mark = ipcLog.length
    h.release()
    await sleep(800)
    const after = await dom()
    // After release the new lifetime is idle and untouched: no DOM change. An open that main
    // completed for a lifetime that already ended is closed again (one close, nothing else).
    const staleCalls = ipcLog.slice(mark).map((e) => e.ch)
    const allowed = kind === 'open' ? ['dropdown:close'] : []
    const mutated = before.root !== after.root || JSON.stringify(before.pill) !== JSON.stringify(after.pill)
    if (JSON.stringify(staleCalls) !== JSON.stringify(allowed)) fail(sc, 'stale_bridge_calls', { name, staleCalls })
    if (ddVisible()) fail(sc, 'stale_open_left_dropdown_showing', { name })
    if (mutated) fail(sc, 'stale_dom_mutation', { name, before: before.root, after: after.root })
    await checkIdle(sc, home)
    return { staleCalls: staleCalls.length, staleMutations: mutated ? 1 : 0, root: after.root, next: await clickOpens(sc, name + '-reopen') }
  }
  const remount = async () => {
    await pill.webContents.executeJavaScript('window.__grayHarness.unmount(); window.__grayHarness.mount()')
  }
  const reload = async () => {
    pill.webContents.reload()
    await new Promise((r) => pill.webContents.once('did-finish-load', r))
    await sleep(600)
  }
  steps.staleOpenAfterRemount = await staleCase('stale-open-remount', 'open', remount)
  await closesTo(sc, clickPill, home)
  steps.staleCloseAfterRemount = await staleCase('stale-close-remount', 'close', remount)
  await closesTo(sc, clickPill, home)
  steps.staleCloseAfterReload = await staleCase('stale-close-reload', 'close', reload)
  await closesTo(sc, clickPill, home)

  // ── Teardown: unmount, then no owned timer/promise/window may survive ──
  const i = ipcLog.length
  await pill.webContents.executeJavaScript('window.__grayHarness.unmount()')
  await sleep(500)
  const afterUnmount = ipcLog.length - i
  pill.destroy()
  outside.destroy()
  await sleep(300)
  report.externalBlurRetries = externalBlurRetries
  report.teardown = { requestsAfterUnmount: afterUnmount, ownedTimers: live.timeouts.size + live.intervals.size, pendingPromises: pending, windows: BrowserWindow.getAllWindows().length, dropdownsCreated: dd.created, maxLiveDropdowns: dd.maxLive, liveDropdowns: dd.live.size }
  if (afterUnmount || report.teardown.ownedTimers || report.teardown.pendingPromises || report.teardown.windows || dd.live.size || dd.maxLive > 1) fail('teardown', 'leftover', report.teardown)
  report.scenarios[sc] = steps
  report.failures = failures
  report.failureCounts = failures.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] || 0) + 1), acc), {})
  fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
  console.log('SMOKE-REPORT ' + JSON.stringify({ identity: report.identity, externalBlurRetries, failureCounts: report.failureCounts, teardown: report.teardown, scenarios: report.scenarios }))
  app.exit(failures.length ? 1 : 0)
}

// ── M1-HF3-B anchored dropdown: actual renderer, GhostPill/RecordPanel and production CSS ──

/**
 * CPU/working set of this app's own processes, sampled once a second via app.getAppMetrics().
 * (`ps` is setuid on macOS and cannot be executed inside the network-denying sandbox-exec.)
 */
async function sampleResources(seconds) {
  const samples = []
  app.getAppMetrics() // prime: percentCPUUsage is measured since the previous call
  for (let i = 0; i < seconds; i++) {
    await sleep(1000)
    const s = { cpu: 0, rssKb: 0, procs: 0, byType: {} }
    for (const m of app.getAppMetrics()) {
      const cpu = m.cpu.percentCPUUsage
      const kb = m.memory.workingSetSize
      s.cpu += cpu
      s.rssKb += kb
      s.procs++
      const b = (s.byType[m.type] = s.byType[m.type] || { cpu: 0, rssKb: 0, procs: 0 })
      b.cpu += cpu
      b.rssKb += kb
      b.procs++
    }
    samples.push(s)
  }
  const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null }
  const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 100) / 100 : null)
  const byType = {}
  for (const t of new Set(samples.flatMap((s) => Object.keys(s.byType)))) {
    const xs = samples.map((s) => s.byType[t]).filter(Boolean)
    byType[t] = { procs: med(xs.map((x) => x.procs)), cpuMean: mean(xs.map((x) => x.cpu)), rssMbMedian: Math.round(med(xs.map((x) => x.rssKb)) / 102.4) / 10 }
  }
  return {
    seconds,
    procs: med(samples.map((s) => s.procs)),
    cpuMean: mean(samples.map((s) => s.cpu)),
    cpuMedian: med(samples.map((s) => s.cpu)),
    rssMbMedian: Math.round(med(samples.map((s) => s.rssKb)) / 102.4) / 10,
    byType
  }
}

async function runAnchoredDropdown() {
  setTimeout(() => {
    fail('watchdog', 'timeout', {})
    report.failures = failures
    fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
    console.log('SMOKE-REPORT ' + JSON.stringify({ watchdog: true, scenarios: report.scenarios, failures }))
    app.exit(4)
  }, (15 * 60 + 4 * SAMPLE_SECONDS + MANUAL_SECONDS) * 1000).unref()
  await app.whenReady()
  const primary = screen.getPrimaryDisplay()
  report.display = { scaleFactor: primary.scaleFactor, workArea: primary.workArea, displays: screen.getAllDisplays().length }
  const bundle = await bundleRenderer(RENDERER_MODE)
  rendererHtml = bundle.html
  const src = (f) => sha(path.join(ROOT, f))
  report.identity = {
    ...identity, rendererMode: RENDERER_MODE, reactDom: bundle.reactDom, strictMode: bundle.strictMode, sampleSeconds: SAMPLE_SECONDS,
    executable: process.execPath.replace(ROOT, '.'), mainBuild: src('out/main/index.js'),
    sources: Object.fromEntries(['src/renderer/src/components/RecordDropdown.tsx', 'src/renderer/src/components/panels/RecordPanel.tsx', 'src/renderer/src/components/GhostPill.tsx', 'src/renderer/src/components/GhostShell.tsx', 'src/renderer/src/state/WorkflowContext.tsx', 'src/renderer/src/styles/globals.css', 'src/renderer/src/styles/components.css', 'src/renderer/src/main.tsx', 'src/preload/index.ts'].map((f) => [f.replace('src/', ''), src(f)]))
  }
  if (bundle.reactDom !== (RENDERER_MODE === 'development' ? 'react-dom.development' : 'react-dom.production.min')) {
    refuse('bundled React runtime ' + bundle.reactDom + ' does not match --renderer-mode=' + RENDERER_MODE)
    return
  }
  if (!bundle.strictMode) fail('identity', 'strict_mode_missing', {})
  const wa = primary.workArea
  const sc = 'anchored-dropdown'
  const steps = {}
  report.scenarios[sc] = steps
  const bottom = { x: wa.x + wa.width - 40, y: wa.y + wa.height - 40 }

  // Every native frame/visibility call on the pill, and its native events.
  const PILL_OPS = ['setBounds', 'setPosition', 'setSize', 'setContentBounds', 'hide', 'show', 'showInactive', 'setOpacity', 'minimize', 'close']
  const ops = { pill: 0, events: 0, byOp: {} }
  function instrumentPill(win) {
    for (const m of PILL_OPS) {
      const f = win[m].bind(win)
      win[m] = (...a) => {
        ops.pill++
        ops.byOp[m] = (ops.byOp[m] || 0) + 1
        return f(...a)
      }
    }
    for (const ev of ['move', 'resize', 'hide', 'show']) win.on(ev, () => ops.events++)
  }
  let pillLoads = 0
  async function makePill(anchor) {
    await createPill(anchor)
    pillLoads = 0
    pill.webContents.on('did-start-loading', () => pillLoads++)
    await sleep(1200)
    await pill.webContents.executeJavaScript('window.__harnessDoc = Math.random().toString(36).slice(2)')
    instrumentPill(pill)
  }
  async function identityOf(win) {
    if (!win || win.isDestroyed()) return null
    return { id: win.webContents.id, pid: win.webContents.getOSProcessId(), doc: await win.webContents.executeJavaScript('window.__harnessDoc || null') }
  }
  // Underlying synthetic app window (not always-on-top) counting its own clicks.
  let probe = null
  async function makeProbe(at) {
    probe = new BrowserWindow({ x: at.x, y: at.y, width: 420, height: 420, frame: false, resizable: false, skipTaskbar: true, show: true })
    await probe.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;height:100vh;background:#e8e6df;font:12px sans-serif;color:#55534c;padding:12px">Synthetic underlying window<script>window.__clicks=0;addEventListener("mousedown",()=>window.__clicks++)</script></body>'))
  }
  const probeClicks = async () => probe.webContents.executeJavaScript('window.__clicks')

  // Pill trace: one rAF collector in the pill page plus a 4 ms native poll in main.
  let trace = null
  async function traceStart() {
    await pill.webContents.executeJavaScript(`(() => {
      window.__frames = []
      window.__tracing = true
      const tick = () => {
        if (!window.__tracing) return
        const p = document.querySelector('.pill')
        const root = document.querySelector('.ghost-root')
        const r = p && p.getBoundingClientRect()
        const cs = p && getComputedStyle(p)
        if (window.__frames.length < 20000) window.__frames.push({ t: Date.now(), x: r ? r.x : null, y: r ? r.y : null, w: r ? r.width : 0, h: r ? r.height : 0,
          op: cs ? Number(cs.opacity) : 0, filter: cs ? cs.filter : 'missing', vis: cs ? cs.visibility : 'missing', rootVis: root ? getComputedStyle(root).visibility : 'missing',
          doc: document.visibilityState, sx: screenX, sy: screenY, cls: root ? root.className : '' })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)
    const base = pill.getBounds()
    const nat = []
    const poll = setInterval(() => {
      if (pill && !pill.isDestroyed()) nat.push({ visible: pill.isVisible(), b: pill.getBounds() })
    }, 4)
    trace = { base, nat, poll, ops0: ops.pill, ev0: ops.events, loads0: pillLoads, id0: await identityOf(pill) }
  }
  async function traceStop(name, assertStill = true) {
    clearInterval(trace.poll)
    const frames = await pill.webContents.executeJavaScript('window.__tracing = false; window.__frames.splice(0)')
    const f0 = frames[0] || {}
    const moved = frames.filter((f) => f.x !== f0.x || f.y !== f0.y || f.w !== f0.w || f.h !== f0.h || f.sx !== f0.sx || f.sy !== f0.sy)
    const hidden = frames.filter((f) => f.w === 0 || f.op < 1 || f.vis !== 'visible' || f.rootVis !== 'visible' || f.doc !== 'visible')
    const filtered = frames.filter((f) => f.filter !== 'none')
    const b = trace.base
    const nativeBad = trace.nat.filter((n) => !n.visible || n.b.x !== b.x || n.b.y !== b.y || n.b.width !== b.width || n.b.height !== b.height)
    const id1 = await identityOf(pill)
    const r = {
      frames: frames.length, nativeSamples: trace.nat.length,
      pillNativeOps: ops.pill - trace.ops0, pillNativeEvents: ops.events - trace.ev0,
      movedFrames: moved.length, hiddenFrames: hidden.length, filteredFrames: filtered.length,
      nativeOffAnchorOrHidden: nativeBad.length, pillReloads: pillLoads - trace.loads0,
      rendererSame: JSON.stringify(trace.id0) === JSON.stringify(id1)
    }
    if (assertStill) {
      for (const k of ['pillNativeOps', 'pillNativeEvents', 'movedFrames', 'hiddenFrames', 'filteredFrames', 'nativeOffAnchorOrHidden', 'pillReloads']) {
        if (r[k]) fail(sc, 'pill_disturbed', { name, k, n: r[k], byOp: ops.byOp })
      }
      if (!r.rendererSame) fail(sc, 'pill_renderer_changed', { name, before: trace.id0, after: id1 })
      if (frames.length < 10) fail(sc, 'too_few_frames', { name, frames: frames.length })
    }
    trace = null
    return r
  }

  const isOpen = () => ctl.inspect().dropdown.open
  let tClick = 0
  // A native pill click focuses the pill first (acceptFirstMouse), then the renderer gets it.
  async function pillClick(focusFirst = true) {
    if (focusFirst) {
      pill.focus()
      await sleep(15)
    }
    // Target the capsule where it is drawn (a notice toast enlarges the pill window).
    const d = await dom()
    const x = d.pill ? d.pill.x + d.pill.w / 2 : 47
    const y = d.pill ? d.pill.y + d.pill.h / 2 : 12
    tClick = Date.now()
    send('mouseDown', x, y)
    send('mouseUp', x, y)
  }
  // Open stages from the click: show() call, then the first dropdown frame after it.
  async function openStages() {
    const showCall = dd.tShow >= tClick ? dd.tShow - tClick : null
    const frame = await ddChild.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => r(Date.now())))')
    return { showCall, firstFrame: frame - tClick }
  }
  const stagesLog = []
  async function cycle() {
    let i = ipcLog.length
    await pillClick()
    const opened = await waitFor(async () => since(i, isOpenReq) > 0 && ddVisible() && isOpen())
    if (opened) stagesLog.push(await openStages())
    await sleep(60)
    i = ipcLog.length
    const h0 = dd.hides
    await pillClick()
    const t0 = Date.now()
    const closed = await waitFor(async () => since(i, isCloseReq) > 0 && !ddVisible() && !isOpen())
    if (closed && dd.hides > h0) stagesLog[stagesLog.length - 1].close = Date.now() - t0
    await sleep(60)
    return opened && closed
  }
  const stat = (xs) => {
    const v = xs.filter((x) => x != null).sort((a, b) => a - b)
    return v.length ? { median: v[Math.floor(v.length / 2)], max: v[v.length - 1], n: v.length } : null
  }
  async function trials(name, n = 3, perTrial = 20) {
    const out = []
    for (let t = 0; t < n; t++) {
      if (isOpen()) fail(sc, 'trial_started_open', { name, trial: t })
      const s0 = stagesLog.length
      const shows0 = dd.shows
      const hides0 = dd.hides
      await traceStart()
      let ok = 0
      for (let i = 0; i < perTrial; i++) if (await cycle()) ok++
      const r = await traceStop(name + '-' + t)
      const got = stagesLog.slice(s0)
      Object.assign(r, { cycles: perTrial, okCycles: ok, dropdownShows: dd.shows - shows0, dropdownHides: dd.hides - hides0, placement: ctl.inspect().dropdown.placement, liveDropdowns: dd.live.size,
        openShowCallMs: stat(got.map((g) => g.showCall)), openFirstFrameMs: stat(got.map((g) => g.firstFrame)), closeMs: stat(got.map((g) => g.close)) })
      if (ok !== perTrial || got.length !== perTrial) fail(sc, 'cycle_failed', { name, trial: t, ok, stages: got.length })
      out.push(r)
    }
    return out
  }
  const rel = () => {
    const p = pill.getBounds()
    const d = ddChild.getBounds()
    return { dx: d.x - p.x, dy: d.y - p.y, width: d.width, height: d.height }
  }
  async function pillStyle() {
    return pill.webContents.executeJavaScript(`(() => { const p = document.querySelector('.pill'); const cs = getComputedStyle(p);
      return { cls: p.className.trim(), radius: cs.borderTopLeftRadius, background: cs.backgroundColor, shadow: cs.boxShadow, filter: cs.filter, opacity: cs.opacity, animation: cs.animationName, w: p.getBoundingClientRect().width, h: p.getBoundingClientRect().height } })()`)
  }

  // ── R0. Idle before the first open: the pill alone (comparable with the old one-window app) ──
  await makePill(bottom)
  await sleep(3000)
  steps.resourcesIdleBeforeFirstOpen = await sampleResources(SAMPLE_SECONDS)
  if (dd.created) fail(sc, 'dropdown_prewarmed', { created: dd.created })
  await makeProbe({ x: bottom.x - 420, y: bottom.y - 420 })

  // ── A. First open: cold create → load → real renderer ready, pill traced ──
  {
    await traceStart()
    const t0 = Date.now()
    await pillClick()
    const shown = await waitFor(async () => ddVisible(), 6000)
    const firstOpenMs = Date.now() - t0
    const stages = shown ? await openStages() : null
    await sleep(300)
    const r = await traceStop('first-open')
    const c = await childDom()
    const g = rel()
    const expected = { dx: T.PILL_W - T.RECORD_DROPDOWN_W, dy: -T.DROPDOWN_GAP - g.height }
    if (!shown) fail(sc, 'first_open_not_shown', {})
    if (g.dx !== expected.dx || g.dy !== expected.dy) fail(sc, 'dropdown_misplaced', { g, expected })
    if (!c || !c.panel || Math.abs(c.panel.h - g.height) > 1) fail(sc, 'dropdown_not_fitted_to_panel', { panel: c && c.panel, window: g })
    if (c && c.ghostBridge !== 'undefined') fail(sc, 'child_has_full_bridge', { ghostBridge: c.ghostBridge })
    steps.firstOpen = { ...r, firstOpenMs, stages, placement: ctl.inspect().dropdown.placement, dropdown: g, dropdownFocused: ddChild.isFocused(), child: c, childOptions: dd.lastOptions }
  }
  const childId0 = await identityOf(ddChild)

  // ── B. Real content-height change: Full screen ↔ One app through the actual controls ──
  {
    await traceStart()
    const h0 = ddChild.getBounds().height
    await ddChild.webContents.executeJavaScript(`[...document.querySelectorAll('.segment')].find((b) => b.textContent === 'Full screen').click()`)
    await waitFor(async () => ddChild.getBounds().height !== h0)
    await sleep(250)
    const full = await childDom()
    const shotFull = await capture('dropdown_full_screen', ddChild)
    const hFull = ddChild.getBounds().height
    await ddChild.webContents.executeJavaScript(`[...document.querySelectorAll('.segment')].find((b) => b.textContent === 'One app').click()`)
    await waitFor(async () => ddChild.getBounds().height !== hFull)
    await sleep(250)
    const r = await traceStop('height-change')
    const g = rel()
    if (g.dy !== -T.DROPDOWN_GAP - g.height) fail(sc, 'dropdown_misplaced_after_resize', { g })
    if (full.mode !== 'Full screen' || Math.abs(full.panel.h - hFull) > 1) fail(sc, 'height_change', { full, hFull })
    steps.heightChange = { ...r, oneApp: h0, fullScreen: hFull, back: g.height, fullScreenChild: full, fullScreenCornerAlpha: shotFull.alpha(1, 1) }
    await pillClick()
    await waitFor(async () => !ddVisible())
  }

  // ── C. Warm-up, then three 20-toggle trials (above) ──
  for (let i = 0; i < 5; i++) await cycle()
  steps.trialsAbove = await trials('above')
  const childId1 = await identityOf(ddChild)
  steps.dropdownRendererSame = JSON.stringify(childId0) === JSON.stringify(childId1)
  if (!steps.dropdownRendererSame) fail(sc, 'dropdown_renderer_recreated', { childId0, childId1 })

  // ── D. Surface treatment: computed styles + synthetic-window screenshots per state ──
  {
    const st = {}
    const shot = async (name, win = pill) => {
      const c = await capture(name, win)
      return { corner: c.alpha(1, 1), center: c.alpha(Math.round((c.size.width * c.scale) / 2), Math.round((c.size.height * c.scale) / 2)) }
    }
    send('mouseLeave', -5, -5)
    await sleep(150)
    st.neutral = { ...(await pillStyle()), shot: await shot('pill_neutral') }
    send('mouseMove', 47, 12, { button: undefined })
    await sleep(150)
    st.pointerHover = { ...(await pillStyle()), shot: await shot('pill_hover') }
    send('mouseLeave', -5, -5)
    await sleep(150)
    st.pointerAway = await pillStyle()
    await pillClick()
    await waitFor(async () => ddVisible())
    send('mouseLeave', -5, -5)
    await sleep(300)
    st.open = { ...(await pillStyle()), shot: await shot('pill_open') }
    st.openDropdown = { ...(await childDom()).style, shot: await shot('dropdown_open', ddChild) }
    pill.focus()
    await sleep(200)
    st.focus = await pillStyle()
    // Each state below is measured with the pointer away: genuine hover is measured above.
    const away = async () => {
      send('mouseLeave', -5, -5)
      await sleep(150)
    }
    await pillClick()
    await waitFor(async () => !ddVisible())
    await away()
    st.close = { ...(await pillStyle()), shot: await shot('pill_closed') }
    await dragPill(-24, -8, { beforeRelease: async () => { st.dragWithPointer = await pillStyle() } })
    await away()
    st.drag = await pillStyle()
    await pillClick()
    await waitFor(async () => ddVisible())
    await away()
    st.reopen = await pillStyle()
    const pillStates = ['neutral', 'pointerAway', 'open', 'focus', 'close', 'drag', 'reopen']
    for (const k of pillStates) {
      const v = st[k]
      if (v.filter !== 'none') fail(sc, 'pill_filter', { state: k, filter: v.filter })
      if (v.shadow !== st.neutral.shadow) fail(sc, 'pill_hairline_inconsistent', { state: k, shadow: v.shadow, neutral: st.neutral.shadow })
      if (v.background !== st.neutral.background) fail(sc, 'pill_open_masquerades_as_hover', { state: k, background: v.background })
      if (v.radius !== '10px' || v.h !== 24) fail(sc, 'pill_geometry', { state: k, radius: v.radius, h: v.h })
    }
    if (!/inset/.test(st.neutral.shadow) || /\), rgb/.test(st.neutral.shadow)) fail(sc, 'pill_outer_shadow', { shadow: st.neutral.shadow })
    if (st.pointerHover.filter !== 'none' || st.pointerHover.radius !== '10px') fail(sc, 'pill_hover_filter_or_geometry', st.pointerHover)
    st.hoverChangesBackground = st.pointerHover.background !== st.neutral.background
    const o = st.openDropdown
    if (o.shadow !== 'none' || o.radius !== '20px' || !/^1px solid/.test(o.border) || o.filter !== 'none') fail(sc, 'dropdown_surface', o)
    for (const k of ['neutral', 'open', 'closed']) {
      const s1 = k === 'closed' ? st.close.shot : st[k].shot
      if (s1.corner > 32 || s1.center < 200) fail(sc, 'pill_corner_or_paint', { state: k, ...s1 })
    }
    if (o.shot.corner > 32 || o.shot.center < 200) fail(sc, 'dropdown_corner_or_paint', o.shot)
    steps.surfaces = st
    await pillClick()
    await waitFor(async () => !ddVisible())
  }

  // ── E. Real content variants (screenshots); synthetic snapshots only where noted ──
  {
    const v = {}
    await pillClick()
    await waitFor(async () => ddVisible())
    await sleep(250)
    v.oneApp = { ...(await childDom()), shot: (await capture('variant_one_app', ddChild)).size }
    await ddChild.webContents.executeJavaScript(`document.querySelector('.toggle').click()`)
    await sleep(250)
    v.narrationToggled = { checked: await ddChild.webContents.executeJavaScript(`document.querySelector('.toggle').getAttribute('aria-checked')`) }
    await capture('variant_narration_toggled', ddChild)
    await ddChild.webContents.executeJavaScript(`document.querySelector('.toggle').click()`)
    await sleep(150)
    // Synthetic snapshot injected at the main → child boundary (labelled): long labels, busy.
    const long = { revision: 9999, recordMode: 'one-app', selectedAppId: 'syn-1', narrate: true, screenGranted: true, micGranted: true, busy: true,
      apps: [1, 2, 3, 4, 5].map((n) => ({ id: 'syn-' + n, name: 'Synthetic application with a long name ' + n, detail: 'synthetic-detail-label-' + 'x'.repeat(30) })) }
    ddChild.webContents.send('dropdown:snapshot', long)
    await sleep(400)
    v.longLabelsBusy = { ...(await childDom()), shot: (await capture('variant_long_labels_busy', ddChild)).size, injected: true }
    if (!v.longLabelsBusy.record || !v.longLabelsBusy.record.disabled) fail(sc, 'busy_not_disabled', v.longLabelsBusy.record)
    await ddChild.webContents.executeJavaScript('window.grayDropdown.hello()') // main resends the pill's real snapshot
    await sleep(400)
    // Real permission events to the pill: microphone off, then Screen Recording off.
    pill.webContents.send('permissions:changed', { screen: 'granted', accessibility: 'granted', microphone: 'denied' })
    await sleep(400)
    v.micOff = { ...(await childDom()), shot: (await capture('variant_mic_off', ddChild)).size }
    pill.webContents.send('permissions:changed', { screen: 'denied', accessibility: 'granted', microphone: 'denied' })
    await sleep(500)
    v.screenOff = { ...(await childDom()), shot: (await capture('variant_screen_off', ddChild)).size, pillBounds: pill.getBounds() }
    if (!v.screenOff.hint || !v.screenOff.record || !v.screenOff.record.disabled) fail(sc, 'screen_off_presentation', v.screenOff)
    pill.webContents.send('permissions:changed', { screen: 'granted', accessibility: 'granted', microphone: 'granted' })
    await sleep(500)
    v.restored = await childDom()
    if (v.restored.hint || v.restored.record.disabled || v.restored.apps !== 3) fail(sc, 'restore_after_permission', v.restored)
    steps.variants = v
    await pillClick()
    await waitFor(async () => !ddVisible())
    // Permission changes legitimately resize the pill (paused label/toast); let it settle.
    await ensureIdle()
    await sleep(800)
  }

  // ── F. Escape in the dropdown closes only the dropdown ──
  {
    await pillClick()
    await waitFor(async () => ddVisible())
    await sleep(100)
    await traceStart()
    ddChild.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    ddChild.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    const closed = await waitFor(async () => !ddVisible() && !isOpen())
    await sleep(150)
    steps.escape = { closed, ...(await traceStop('escape')), pillStateIdle: /ghost-root-pill/.test((await dom()).root) }
    if (!closed) fail(sc, 'escape_did_not_close', {})
  }
  // ── G. Internal focus transfer keeps it open ──
  {
    await pillClick()
    await waitFor(async () => ddVisible())
    await sleep(100)
    await traceStart()
    pill.focus()
    await sleep(250)
    const afterPill = isOpen() && ddVisible()
    ddChild.focus()
    await sleep(250)
    const afterDropdown = isOpen() && ddVisible()
    steps.internalFocus = { stayedOpenAfterPillFocus: afterPill, stayedOpenAfterDropdownFocus: afterDropdown, ddFocused: ddChild.isFocused(), ...(await traceStop('internal-focus')) }
    if (!afterPill || !afterDropdown) fail(sc, 'internal_focus_dismissed', steps.internalFocus)
  }
  // ── H. Focus moves to the underlying synthetic app: only the dropdown closes ──
  {
    await traceStart()
    probe.focus()
    const closed = await waitFor(async () => !ddVisible() && !isOpen(), 1500)
    await sleep(200)
    steps.outsideFocus = { closed, probeFocused: probe.isFocused(), pillVisible: pill.isVisible(), pillUiIdle: !/hover/.test(await pill.webContents.executeJavaScript('document.querySelector(".ghost-root").className')), ...(await traceStop('outside-focus')) }
    if (!closed) fail(sc, 'outside_focus_did_not_close', {})
    const c0 = await probeClicks()
    const pb = probe.getBounds()
    const p = pill.getBounds()
    probe.webContents.sendInputEvent({ type: 'mouseDown', x: p.x - pb.x - 20, y: p.y - pb.y + 10, button: 'left', clickCount: 1 })
    probe.webContents.sendInputEvent({ type: 'mouseUp', x: p.x - pb.x - 20, y: p.y - pb.y + 10, button: 'left', clickCount: 1 })
    await sleep(150)
    steps.outsideSpace = { directedProbeClicks: (await probeClicks()) - c0, closedDropdownVisible: ddVisible(), pillFrame: p, nativeFirstClick: MANUAL_SECONDS ? 'see manual' : 'PENDING (manual native check; GRAY_HF3A_MANUAL_SECONDS)' }
    if (steps.outsideSpace.directedProbeClicks !== 1 || ddVisible()) fail(sc, 'outside_space', steps.outsideSpace)
    if (p.width !== T.PILL_W || p.height !== T.PILL_H) fail(sc, 'pill_frame_not_pill_sized', p)
    // Gray unfocused (the probe app has focus): one click on the pill opens it.
    const i = ipcLog.length
    await pillClick(false)
    const opened = await waitFor(async () => ddVisible(), 3000)
    steps.unfocusedPillClick = { opened, opens: since(i, isOpenReq), directed: true }
    if (!opened) fail(sc, 'unfocused_pill_click', steps.unfocusedPillClick)
    await pillClick()
    await waitFor(async () => !ddVisible())
  }
  // ── I. Rapid toggles: nine clicks 10 ms apart end open, one child, settled ──
  {
    pill.focus()
    await sleep(50)
    await traceStart()
    const i = ipcLog.length
    for (let n = 0; n < 9; n++) {
      send('mouseDown', 47, 12)
      send('mouseUp', 47, 12)
      await sleep(10)
    }
    await sleep(900)
    steps.rapid = { requests: since(i, (e) => isOpenReq(e) || isCloseReq(e)), open: isOpen(), visible: ddVisible(), pending, liveDropdowns: dd.live.size, ...(await traceStop('rapid')) }
    if (isOpen() !== ddVisible() || pending || dd.live.size > 1) fail(sc, 'rapid_toggle_state', steps.rapid)
    if (isOpen()) {
      await pillClick()
      await waitFor(async () => !ddVisible())
    }
  }
  // ── J. Pill drag while open: the pill moves (allowed), the dropdown keeps its offset ──
  {
    await pillClick()
    await waitFor(async () => ddVisible())
    await sleep(150)
    const g0 = rel()
    const offsets = []
    await dragPill(-72, -32, { beforeRelease: async () => offsets.push(rel()) })
    const g1 = rel()
    const nb = pill.getBounds()
    steps.pillDrag = { before: g0, during: offsets, after: g1, visible: ddVisible(), anchor: ctl.inspect().anchor, pill: nb }
    if (!ddVisible() || g1.dx !== g0.dx || g1.dy !== g0.dy || offsets.some((o) => o.dx !== g0.dx || o.dy !== g0.dy)) fail(sc, 'pill_drag_pair', steps.pillDrag)
    if (JSON.stringify(ctl.inspect().anchor) !== JSON.stringify({ x: nb.x + nb.width, y: nb.y + nb.height })) fail(sc, 'drag_anchor_not_persisted', steps.pillDrag)
  }
  // ── K. Header drag in the dropdown moves the pair through the pill's gesture owner ──
  {
    const p0 = pill.getBounds()
    const g0 = rel()
    const hb = await ddChild.webContents.executeJavaScript(`(() => { const r = document.querySelector('.record-header').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 } })()`)
    const c0 = ddChild.getBounds()
    cursor = { x: c0.x + hb.x, y: c0.y + hb.y }
    // Real pointer events carry screen coordinates; the header gesture uses them.
    const ev = (type, x, y, extra = {}) => {
      const b = ddChild.getBounds()
      ddChild.webContents.sendInputEvent({ type, x, y, globalX: b.x + x, globalY: b.y + y, ...extra })
    }
    ev('mouseDown', hb.x, hb.y, { button: 'left', clickCount: 1 })
    ev('mouseMove', hb.x + 10, hb.y)
    await sleep(60)
    for (let i = 1; i <= 8; i++) {
      cursor = { x: c0.x + hb.x - 5 * i, y: c0.y + hb.y - 3 * i }
      await sleep(25)
    }
    const during = ctl.inspect().dragging
    const nc = ddChild.getBounds()
    ev('mouseUp', cursor.x - nc.x, cursor.y - nc.y, { button: 'left', clickCount: 1 })
    await sleep(200)
    const p1 = pill.getBounds()
    const g1 = rel()
    steps.headerDrag = { draggingDuring: during, draggingAfter: ctl.inspect().dragging, pillMoved: { dx: p1.x - p0.x, dy: p1.y - p0.y }, offsetBefore: g0, offsetAfter: g1, open: isOpen() }
    if (!during || ctl.inspect().dragging || (p1.x === p0.x && p1.y === p0.y) || g1.dx !== g0.dx || g1.dy !== g0.dy || !isOpen()) fail(sc, 'header_drag', steps.headerDrag)
    await pillClick()
    await waitFor(async () => !ddVisible())
  }
  // ── L. Child crash, load failure and never-ready: only the child is affected; retry works ──
  {
    const f = {}
    await pillClick()
    await waitFor(async () => ddVisible())
    const crashed = ddChild
    ddChild.webContents.forcefullyCrashRenderer()
    await waitFor(async () => crashed.isDestroyed(), 3000)
    await sleep(300)
    f.crash = { childDestroyed: crashed.isDestroyed(), open: isOpen(), pillAlive: !pill.isDestroyed() && pill.isVisible(), pillUi: (await dom()).root }
    if (!f.crash.childDestroyed || f.crash.open || !f.crash.pillAlive || !/ghost-root-pill/.test(f.crash.pillUi)) fail(sc, 'child_crash', f.crash)
    // Load failure injected at the native load boundary (nonexistent file).
    const realHtml = rendererHtml
    rendererHtml = path.join(fxReal, 'missing-' + Date.now() + '.html')
    await pillClick()
    await sleep(1500)
    f.loadFailure = { open: isOpen(), visible: ddVisible(), live: dd.live.size, notice: /ghost-root-pill/.test((await dom()).root) ? 'pill' : (await dom()).root, noticeText: await pill.webContents.executeJavaScript('document.body.innerText.slice(0, 200)') }
    if (f.loadFailure.open || f.loadFailure.visible || f.loadFailure.live) fail(sc, 'load_failure', f.loadFailure)
    // Never-ready: a page that loads but never renders the dropdown (no readiness message).
    rendererHtml = path.join(fxReal, 'blank.html')
    fs.writeFileSync(rendererHtml, '<!DOCTYPE html><html><body></body></html>')
    await ensureIdle()
    const t0 = Date.now()
    await pillClick()
    await waitFor(async () => dd.live.size === 0 && Date.now() - t0 > 1000, 8000)
    f.neverReady = { msUntilFailed: Date.now() - t0, open: isOpen(), live: dd.live.size, visible: ddVisible() }
    if (f.neverReady.open || f.neverReady.live || f.neverReady.msUntilFailed > 7000) fail(sc, 'never_ready', f.neverReady)
    rendererHtml = realHtml
    await ensureIdle()
    // Dismiss the neutral failure notice, then the explicit retry builds one replacement.
    await pill.webContents.executeJavaScript(`document.querySelector('.toast [aria-label="Dismiss"], .toast-dismiss, .toast button:last-child')?.click()`)
    await sleep(600)
    const created0 = dd.created
    await pillClick()
    const reopened = await waitFor(async () => ddVisible(), 6000)
    f.retry = { reopened, created: dd.created - created0, live: dd.live.size, maxLive: dd.maxLive }
    if (!reopened || dd.created - created0 !== 1 || dd.live.size !== 1) fail(sc, 'retry_after_failure', f.retry)
    steps.failures = f
    await pillClick()
    await waitFor(async () => !ddVisible())
  }
  // ── M. Owner destroyed while open, then a fresh pair at the top: dropdown below ──
  {
    await pillClick()
    await waitFor(async () => ddVisible())
    pill.destroy()
    await sleep(400)
    steps.ownerDestroyed = { liveDropdowns: dd.live.size, exists: ctl.inspect().dropdown.exists, ownedTimers: live.timeouts.size + live.intervals.size, pending }
    if (dd.live.size || steps.ownerDestroyed.exists || steps.ownerDestroyed.ownedTimers || pending) fail(sc, 'owner_destroy_leftover', steps.ownerDestroyed)
    const top = { x: wa.x + wa.width - 40, y: wa.y + 60 }
    probe.setBounds({ x: top.x - 420, y: top.y - 24, width: 420, height: 420 })
    await makePill(top)
    await traceStart()
    await pillClick()
    await waitFor(async () => ddVisible(), 6000)
    await sleep(300)
    const r = await traceStop('first-open-below')
    const g = rel()
    if (ctl.inspect().dropdown.placement !== 'below' || g.dy !== T.PILL_H + T.DROPDOWN_GAP) fail(sc, 'below_misplaced', { g })
    const shotBelow = await capture('dropdown_open_below', ddChild)
    steps.firstOpenBelow = { ...r, placement: ctl.inspect().dropdown.placement, dropdown: g, cornerAlpha: shotBelow.alpha(1, 1) }
    await pillClick()
    await waitFor(async () => !ddVisible())
    for (let i = 0; i < 5; i++) await cycle()
    steps.trialsBelow = await trials('below')
  }
  // ── N. Optional native checks by a person (never synthesized) ──
  if (MANUAL_SECONDS) {
    await ensureIdle()
    const c0 = await probeClicks()
    const i = ipcLog.length
    const p0 = pill.getBounds()
    console.log(`[smoke] MANUAL ${MANUAL_SECONDS}s: without moving the pointer first, click the grey "Synthetic underlying window" right next to the pill; then click the pill (Gray unfocused), press Escape, reopen and click outside, and drag the pill and the panel header.`)
    await sleep(MANUAL_SECONDS * 1000)
    const p1 = pill.getBounds()
    steps.manual = { seconds: MANUAL_SECONDS, nativeProbeClicks: (await probeClicks()) - c0, opens: since(i, isOpenReq), closes: since(i, isCloseReq), pillMoved: p1.x !== p0.x || p1.y !== p0.y, dropdownsCreated: dd.created, maxLive: dd.maxLive }
  }
  probe.destroy()
  probe = null
  // ── P. Resources: retained child closed, child open, teardown ──
  {
    await ensureIdle()
    await sleep(3000)
    steps.resourcesRetainedChildClosed = await sampleResources(SAMPLE_SECONDS)
    await pillClick()
    await waitFor(async () => ddVisible())
    await sleep(3000)
    steps.resourcesChildOpen = await sampleResources(SAMPLE_SECONDS)
    pill.destroy()
    await sleep(1000)
    steps.resourcesTeardown = await sampleResources(SAMPLE_SECONDS)
  }
  // ── Teardown: no owned timer, promise, window or dropdown survives ──
  report.externalBlurRetries = externalBlurRetries
  report.teardown = { ownedTimers: live.timeouts.size + live.intervals.size, pendingPromises: pending, liveDropdowns: dd.live.size, windows: BrowserWindow.getAllWindows().length, dropdownsCreated: dd.created, maxLiveDropdowns: dd.maxLive }
  if (report.teardown.ownedTimers || pending || dd.live.size || report.teardown.windows || dd.maxLive > 1) fail('teardown', 'leftover', report.teardown)
  report.failures = failures
  report.failureCounts = failures.reduce((acc, f) => ((acc[f.kind] = (acc[f.kind] || 0) + 1), acc), {})
  fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
  console.log('SMOKE-REPORT ' + JSON.stringify({ identity: report.identity, failureCounts: report.failureCounts, teardown: report.teardown }))
  app.exit(failures.length ? 1 : 0)
}


;(SCENARIO === 'pill-lifecycle' ? runLifecycle() : SCENARIO === 'anchored-dropdown' ? runAnchoredDropdown() : run()).catch((err) => {
  console.error('[smoke] harness error', err && err.stack ? err.stack : err)
  app.exit(3)
})
