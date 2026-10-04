/* eslint-disable */
'use strict'
/**
 * TEST-ONLY mounted capture-lifecycle harness (M2-R1).
 *
 * Real: the renderer entry (src/renderer/src/main.tsx, StrictMode kept) bundled with the
 * installed esbuild in development or production React, the built preload, and the real
 * telemetry main module (src/main/telemetry/index.ts) bundled for this run with its IPC,
 * recorder, queue, FileTelemetryStore and NarrationRecorder.
 * Fake: getUserMedia/MediaRecorder/tracks (injected ahead of app code), the accessibility
 * child, active-window reads, keyframes, clipboard, the app store and any provider client
 * (construction is counted and must stay 0). Fresh temp profile/store, network denied by
 * the caller, no real capture. Unknown flags refuse to run.
 *
 *   GRAY_UI_FIXTURE_DIR=$(mktemp -d /tmp/gray-m2r1-dev.XXXXXX)
 *   env -u ELECTRON_RUN_AS_NODE OPENAI_API_KEY= GRAY_UI_FIXTURE_DIR="$GRAY_UI_FIXTURE_DIR" \
 *     /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
 *     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     scripts/smoke-capture-lifecycle.cjs --renderer-mode=development --scenario=narration-boundaries
 */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const Module = require('module')

const ROOT = path.resolve(__dirname, '..')
const FX = process.env.GRAY_UI_FIXTURE_DIR || ''

function refuse(msg) {
  console.error('[capture-smoke] refusing to start: ' + msg)
  app.exit(2)
  process.exit(2)
}

const ARGS = {}
for (const a of process.argv.slice(2)) {
  const m = /^--(renderer-mode|scenario)=(.+)$/.exec(a)
  if (!m) refuse('unknown argument ' + a)
  ARGS[m[1]] = m[2]
}
const MODE = ARGS['renderer-mode']
if (!['development', 'production'].includes(MODE)) refuse('--renderer-mode=development|production is required')
const SCENARIO = ARGS.scenario
if (!['narration-boundaries', 'owner-boundaries'].includes(SCENARIO)) refuse('--scenario=narration-boundaries|owner-boundaries is required')

const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp'].map((p) => fs.realpathSync(p))
if (!FX || !path.isAbsolute(FX) || !fs.existsSync(FX)) refuse('GRAY_UI_FIXTURE_DIR must be an existing absolute temp dir')
const fxReal = fs.realpathSync(FX)
if (!tmpRoots.some((r) => fxReal.startsWith(r + path.sep))) refuse('fixture dir must be under a temp root')
if (fs.readdirSync(fxReal).length > 0) refuse('fixture dir must be empty (use a fresh mktemp -d)')
if (process.env.OPENAI_API_KEY) refuse('OPENAI_API_KEY must be empty')
if (!fs.existsSync(path.join(ROOT, 'out/preload/index.js'))) refuse('missing out/preload/index.js (run npm run build)')

app.setName('gray-capture-smoke')
// Chromium's inner sandbox cannot start nested in sandbox-exec (which denies network here).
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
for (const [k, sub] of [['userData', 'userData'], ['sessionData', 'sessionData'], ['logs', 'logs'], ['crashDumps', 'crash']]) {
  const dir = path.join(fxReal, sub)
  fs.mkdirSync(dir, { recursive: true })
  app.setPath(k, dir)
}
const STORE_DIR = path.join(fxReal, 'store')
fs.mkdirSync(STORE_DIR, { recursive: true })
const esbuild = require(path.join(ROOT, 'node_modules/esbuild'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Fakes for the main bundle (no native capture, no provider client) ──
global.__captureSmoke = { openaiConstructed: 0, ixStarts: 0, ixStops: 0, ixLive: 0, winReads: 0,
  stopFails: false, pendingTeardown: false, storeDir: STORE_DIR }
const MAIN_FAKES = {
  config: `export function loadTelemetryConfig() {
    return { storage: 'file', devDir: globalThis.__captureSmoke.storeDir, openaiApiKey: null,
      openaiModel: 'synthetic-model', isDev: true, isPackaged: false } }`,
  appStore: `export function getSnapshot() { return { session: null } }`,
  jxa: `export class JxaAccessibilityProvider {
    constructor() { this.enabled = true; this.capturesKeys = true }
    get teardownPending() { return globalThis.__captureSmoke.pendingTeardown }
    start() { const g = globalThis.__captureSmoke; g.ixStarts++; g.ixLive++ }
    async stop() { const g = globalThis.__captureSmoke; g.ixStops++
      // Failure injection: the child is never observed to exit.
      if (g.stopFails) { g.pendingTeardown = true; throw new Error('synthetic: sensor did not exit') }
      g.ixLive = Math.max(0, g.ixLive - 1) }
    flush() {} }`,
  keyframes: `export class SparseKeyframeProvider { constructor() { this.enabled = false }
    async captureKeyframe() { return null } }`,
  clipboard: `export class ClipboardWatcher { start() {} stop() {} getLatest() { return null }
    snapshotSessionValues() { return new Map() } }
    export function inferPaste() { return { matched: false } }`,
  activeWin: `export default async function activeWin() {
    globalThis.__captureSmoke.winReads++
    return { title: 'Fixture window', owner: { name: 'FixtureApp', processId: 4242 },
      bounds: { x: 0, y: 0, width: 800, height: 600 } } }`,
  openai: `class OpenAI { constructor() { globalThis.__captureSmoke.openaiConstructed++;
      throw new Error('provider disabled in capture smoke') } }
    export default OpenAI; export { OpenAI }; export async function toFile() { return {} }`
}

async function bundleMain() {
  const telemetryDir = path.join(ROOT, 'src/main/telemetry')
  const plugin = {
    name: 'capture-smoke-fakes',
    setup(build) {
      const fake = (key) => ({ path: key, namespace: 'smoke-fake' })
      build.onResolve({ filter: /^(active-win|openai)$/ }, (a) => fake(a.path === 'openai' ? 'openai' : 'activeWin'))
      build.onResolve({ filter: /^\.\.?\// }, (a) => {
        if (a.resolveDir === telemetryDir) {
          if (a.path === './config') return fake('config')
          if (a.path === '../store') return fake('appStore')
          if (a.path === './ax/JxaAccessibilityProvider') return fake('jxa')
          if (a.path === './keyframes') return fake('keyframes')
          if (a.path === './clipboard') return fake('clipboard')
        }
        return undefined
      })
      build.onLoad({ filter: /.*/, namespace: 'smoke-fake' }, (a) => ({ contents: MAIN_FAKES[a.path], loader: 'js' }))
    }
  }
  const outfile = path.join(fxReal, 'main-bundle', 'telemetry.cjs')
  await esbuild.build({
    entryPoints: [path.join(telemetryDir, 'index.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    plugins: [plugin],
    logLevel: 'silent'
  })
  return require(outfile)
}

// ── Fake media, prepended to the renderer bundle so real media is never reachable ──
const FAKE_MEDIA = `
(() => {
  const fm = { mode: 'auto', pending: [], tracks: [], recorders: [], constructed: 0, starts: 0,
    ctorThrows: false, startThrows: false, finalChunkBytes: 0, stopThrows: false, noStopEvent: false }
  class FakeTrack { constructor() { this.stops = 0; this.readyState = 'live'; fm.tracks.push(this) }
    stop() { this.stops++; this.readyState = 'ended' } }
  function makeStream() { const t = new FakeTrack(); return { getTracks: () => [t], getAudioTracks: () => [t] } }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: () => new Promise((resolve, reject) => {
      if (fm.mode === 'auto') return resolve(makeStream())
      fm.pending.push({ grant: () => resolve(makeStream()), deny: () => reject(new Error('denied')) })
    }) } })
  class FakeMediaRecorder extends EventTarget {
    static isTypeSupported() { return true }
    constructor(stream) { super(); fm.constructed++; if (fm.ctorThrows) throw new Error('ctor');
      this.stream = stream; this.state = 'inactive'; this.ondataavailable = null; this.onerror = null; fm.recorders.push(this) }
    start() { if (fm.startThrows) throw new Error('start'); fm.starts++; this.state = 'recording' }
    emit(bytes) { this.ondataavailable && this.ondataavailable({ data: new Blob([new Uint8Array(bytes)]) }) }
    // Failure injection: a stop that throws, a stop whose 'stop' event never arrives, and a
    // runtime encoder error (onerror, then the recorder stops, as Chromium does).
    stop() { if (this.state === 'inactive') return; if (fm.stopThrows) throw new Error('stop')
      if (fm.noStopEvent) return; if (fm.finalChunkBytes) this.emit(fm.finalChunkBytes)
      this.state = 'inactive'; setTimeout(() => this.dispatchEvent(new Event('stop')), 0) }
    fail() { this.onerror && this.onerror(new Event('error')); this.state = 'inactive'
      setTimeout(() => this.dispatchEvent(new Event('stop')), 0) }
    // Registered 'stop' listeners actually held by this recorder ({once} ones leave on dispatch).
    addEventListener(type, fn, o) { if (type === 'stop') (this._stops ||= new Map()).set(fn, !!(o && o.once)); super.addEventListener(type, fn, o) }
    removeEventListener(type, fn, o) { if (type === 'stop') this._stops?.delete(fn); super.removeEventListener(type, fn, o) }
    dispatchEvent(ev) { const r = super.dispatchEvent(ev)
      if (ev.type === 'stop' && this._stops) for (const [fn, once] of this._stops) if (once) this._stops.delete(fn)
      return r }
  }
  window.MediaRecorder = FakeMediaRecorder
  fm.grantAll = () => { const p = fm.pending.splice(0); p.forEach((x) => x.grant()); return p.length }
  fm.liveTracks = () => fm.tracks.filter((t) => t.readyState === 'live').length
  fm.stats = () => ({ pendingGrants: fm.pending.length, constructed: fm.constructed, starts: fm.starts,
    tracks: fm.tracks.length, liveTracks: fm.liveTracks(), maxStopsPerTrack: Math.max(0, ...fm.tracks.map((t) => t.stops)),
    recordersRecording: fm.recorders.filter((r) => r.state === 'recording').length,
    stopListeners: fm.recorders.reduce((n, r) => n + (r._stops ? r._stops.size : 0), 0) })
  fm.reset = (o = {}) => { Object.assign(fm, { mode: 'auto', ctorThrows: false, startThrows: false, finalChunkBytes: 0,
    stopThrows: false, noStopEvent: false }, o) }
  window.__fm = fm
})();
`

async function bundleRenderer() {
  const outdir = path.join(fxReal, 'renderer-' + MODE)
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
    window.__grayHarness = { unmount() { last.root.unmount() } }`
  await esbuild.build({
    entryPoints: { main: path.join(ROOT, 'src/renderer/src/main.tsx') },
    outdir,
    bundle: true,
    format: 'iife',
    minify: false,
    jsx: 'automatic',
    jsxDev: MODE === 'development',
    define: { 'process.env.NODE_ENV': JSON.stringify(MODE) },
    loader: { '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file' },
    assetNames: 'assets/[name]-[hash]',
    banner: { js: FAKE_MEDIA },
    plugins: [{
      name: 'root-shim',
      setup(build) {
        build.onResolve({ filter: /^react-dom\/client$/ }, (a) => (a.namespace === 'harness' ? undefined : { path: 'shim', namespace: 'harness' }))
        build.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ contents: shim, loader: 'js', resolveDir: ROOT }))
      }
    }],
    logLevel: 'silent'
  })
  fs.writeFileSync(path.join(outdir, 'index.html'), '<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script src="main.js"></script></body></html>')
  const js = fs.readFileSync(path.join(outdir, 'main.js'), 'utf8')
  return { html: path.join(outdir, 'index.html'), reactDom: (/node_modules\/react-dom\/cjs\/(react-dom\.[a-z.]+)\.js/.exec(js) || [])[1] }
}

// ── Window transitions (production controller, transpiled) and non-telemetry fixtures ──
function loadTs(file) {
  const ts = require(path.join(ROOT, 'node_modules/typescript'))
  const out = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText
  const m = new Module(file)
  m.filename = file
  m.paths = Module._nodeModulePaths(path.dirname(file))
  m._compile(out, file)
  return m.exports
}
const T = loadTs(path.join(ROOT, 'src/main/windowTransitions.ts'))
let pill = null
// M1-HF3-B: the production Record dropdown (factory + relay); Record is clicked in the child.
let dropdownWiring = null
let childHtml = null
const ctl = T.createWindowTransitions({
  pill: () => pill,
  workAreaNear: () => require('electron').screen.getPrimaryDisplay().workArea,
  cursor: () => ({ x: 0, y: 0 }),
  persistAnchor: () => {},
  createDropdown: () => dropdownWiring.create(),
  onDropdownClosed: (e) => dropdownWiring.notifyClosed(e)
})
const ddChild = () => (dropdownWiring && dropdownWiring.inspect().child) || null
const snapshot = {
  version: 1, workflows: [], runs: [], activity: [], suggestion: null, discardedSuggestionIds: [],
  recordSettings: { recordMode: 'full-screen', narrate: true, selectedAppId: 'chrome' }, pillPosition: null,
  onboardingComplete: true, onboardingStep: 'done', session: null, team: null, micSkipped: false,
  permissionToastDismissedAt: null, lastPermissionRevokeAt: null
}
const fixtures = {
  'store:getSnapshot': () => snapshot,
  'permissions:get': () => ({ screen: 'granted', accessibility: 'granted', microphone: 'granted' })
}

const report = { identity: {}, trials: [], scenarios: {}, failures: [] }
function fail(scenario, kind, detail) {
  report.failures.push({ scenario, kind, detail })
}

async function js(code) {
  return pill.webContents.executeJavaScript(code)
}
async function waitFor(pred, ms = 4000, label = 'condition') {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await pred()) return Date.now() - t0
    await sleep(15)
  }
  throw new Error('timeout waiting for ' + label)
}

async function createPill(html) {
  childHtml = html
  const wa = require('electron').screen.getPrimaryDisplay().workArea
  const anchor = { x: wa.x + wa.width - 40, y: wa.y + wa.height - 40 }
  ctl.setAnchor(anchor)
  pill = new BrowserWindow({
    x: anchor.x - T.PILL_W, y: anchor.y - T.PILL_H, width: T.PILL_W, height: T.PILL_H,
    ...T.PILL_WINDOW_OPTIONS, show: false,
    webPreferences: { preload: path.join(ROOT, 'out/preload/index.js'), sandbox: false, contextIsolation: true }
  })
  ctl.attachPill(pill, {})
  await pill.loadFile(html)
  await sleep(500)
}

let telemetry = null
const phase = () => telemetry.getTelemetryRecorder().getRecordingStatus().phase
const sessionId = () => telemetry.getTelemetryRecorder().getRecordingStatus().sessionId
const fm = () => js('window.__fm.stats()')

/** Open the Record dropdown and press its real Record button (relayed to the pill owner). */
async function pressRecordInDropdown() {
  pill.webContents.send('pill:openRecordPanel')
  await waitFor(async () => {
    const c = ddChild()
    if (!c || c.isDestroyed() || !c.isVisible()) return false
    return c.webContents.executeJavaScript('!!document.querySelector(".btn-record") && !document.querySelector(".btn-record").disabled')
  }, 6000, 'record dropdown')
  await ddChild().webContents.executeJavaScript('document.querySelector(".btn-record").click()')
}
async function startNarrated(media = {}) {
  await js(`window.__fm.reset(${JSON.stringify(media)})`)
  await pressRecordInDropdown()
  await waitFor(() => phase() === 'recording', 4000, 'recording')
  return sessionId()
}
async function clickPause() {
  // Toggle only once the renderer itself shows the settled state (an in-flight pause
  // ignores clicks by design), then click.
  await waitFor(() => js('!!document.querySelector(".play-pause-btn") && !document.querySelector(".play-pause-btn").disabled'), 4000, 'pause control')
  await js('document.querySelector(".play-pause-btn").click()')
}
async function waitPausedUi() {
  await waitFor(() => js('document.querySelector(".play-pause-btn")?.title === "Resume"'), 6000, 'paused UI')
}
async function clickFinish() {
  // Expand the ledger through the pill (the ordinary path) if it is not already open.
  if (!(await js('!!document.querySelector(".ledger-footer .btn-primary")'))) await js(`document.querySelector('.pill')?.click()`)
  await waitFor(() => js('!!document.querySelector(".ledger-footer .btn-primary")'), 4000, 'ledger finish')
  await js('document.querySelector(".ledger-footer .btn-primary").click()')
}
async function savedAudio(id) {
  await waitFor(() => phase() === 'idle', 8000, 'stopped')
  await waitFor(async () => {
    const m = await telemetry.getTelemetryStore().getSessionMeta(id)
    return m && m.delivery && m.delivery.save && m.delivery.save.state !== 'recording' && m.delivery.save.state !== 'saving'
  }, 8000, 'saved')
  const m = await telemetry.getTelemetryStore().getSessionMeta(id)
  return { state: m.delivery.save.state, errorCode: m.delivery.save.errorCode || null, audio: m.delivery.save.audio || null }
}
async function emitChunk(bytes) {
  await js(`window.__fm.recorders.at(-1).emit(${bytes})`)
  await sleep(150)
}

/** One fresh-renderer trial of the two reproduced defects. */
async function trial(html) {
  await createPill(html)
  const t = {}
  // A. Late grant after Pause: no recorder may start; the granted track is released once.
  {
    const id = await startNarrated({ mode: 'hold' })
    await waitFor(async () => (await fm()).pendingGrants === 1, 3000, 'pending grant')
    const t0 = Date.now()
    await clickPause()
    await waitFor(() => phase() === 'paused', 4000, 'paused')
    await waitPausedUi()
    t.pauseAckMs = Date.now() - t0
    await js('window.__fm.grantAll()')
    await sleep(300)
    const after = await fm()
    t.lateGrant = { recorderConstructed: after.constructed, recorderStarts: after.starts, liveTracks: after.liveTracks, maxStopsPerTrack: after.maxStopsPerTrack }
    const tf = Date.now()
    await clickFinish()
    t.lateGrant.save = await savedAudio(id)
    t.lateGrant.finishMs = Date.now() - tf
    t.lateGrant.liveTracksAfterStop = (await fm()).liveTracks
  }
  // B. One acknowledged chunk, Pause, Resume (no narration), Finish: receipt survives.
  try {
    const startsBefore = (await fm()).starts
    const id = await startNarrated({ mode: 'auto' })
    await waitFor(async () => (await fm()).starts === startsBefore + 1, 3000, 'recorder start')
    await emitChunk(64)
    const t0 = Date.now()
    await clickPause()
    await waitFor(() => phase() === 'paused', 4000, 'paused')
    await waitPausedUi()
    t.pauseTeardownMs = Date.now() - t0
    const paused = await fm()
    await clickPause() // resume
    await waitFor(() => phase() === 'recording', 4000, 'resumed')
    const resumed = await fm()
    await clickFinish()
    const save = await savedAudio(id)
    t.receipt = { save, liveTracksAtPause: paused.liveTracks, reacquiredOnResume: resumed.tracks - paused.tracks, liveTracksAfterStop: (await fm()).liveTracks }
  } catch (err) {
    t.receiptError = String(err && err.message)
  }
  pill.destroy()
  pill = null
  await sleep(200)
  return t
}

/**
 * M2-R1 correction: recorder failures after capture started must save incomplete, stay
 * incomplete on a repeated finalization and refuse review. One fresh renderer per trial.
 */
async function failureTrial(html) {
  await createPill(html)
  const out = {}
  const finishPaused = async () => {
    const t0 = Date.now()
    await clickPause()
    await waitFor(() => phase() === 'paused', 6000, 'paused')
    await waitPausedUi()
    const pauseMs = Date.now() - t0
    await clickPause() // resume (without narration)
    await waitFor(() => phase() === 'recording', 4000, 'resumed')
    await clickFinish()
    return pauseMs
  }
  const started = async (media) => {
    const before = (await fm()).starts
    const id = await startNarrated(media)
    await waitFor(async () => (await fm()).starts === before + 1, 3000, 'recorder start')
    return id
  }
  const verdict = async (id, extra) => {
    const save = await savedAudio(id)
    // A repeated finalization with a clean zeroed account must not change the outcome.
    await js(`window.ghostBridge.telemetryStop({ sessionId: ${JSON.stringify(id)}, audio: { chunksAcknowledged: 0, chunksFailed: 0, timedOut: false, recorderFailed: false } })`)
    const again = await savedAudio(id)
    const review = await js(`window.ghostBridge.telemetryPrepareReview(${JSON.stringify(id)})`)
    const st = await fm()
    return { save, afterRepeat: again, reviewOk: !!(review && review.ok), reviewCode: (review && (review.errorCode || null)) || null,
      liveTracks: st.liveTracks, stopListeners: st.stopListeners, ...extra }
  }
  // A1: started recorder, zero chunks, stop event never arrives (timeout), Pause→Resume→Finish.
  {
    const id = await started({ noStopEvent: true })
    const pauseMs = await finishPaused()
    out.zeroChunkTimeout = await verdict(id, { pauseMs })
  }
  // A2a: one 64-byte chunk, then stop() throws; direct Finish.
  {
    const id = await started({ stopThrows: true })
    await emitChunk(64)
    const t0 = Date.now()
    await clickFinish()
    out.stopThrows = await verdict(id, { finishMs: Date.now() - t0 })
  }
  // A2b: one 64-byte chunk, then a runtime encoder error; Pause→Resume→Finish.
  {
    const id = await started({})
    await emitChunk(64)
    await js('window.__fm.recorders.at(-1).fail()')
    await sleep(100)
    const pauseMs = await finishPaused()
    out.runtimeError64 = await verdict(id, { pauseMs })
  }
  // A2c: runtime error before any chunk; direct Finish.
  {
    const id = await started({})
    const failedIndex = await js('window.__fm.recorders.length - 1')
    await js('window.__fm.recorders.at(-1).fail()')
    await sleep(100)
    await clickFinish()
    out.runtimeError0 = await verdict(id, {})
    // Stale: the failed attempt's recorder errors again during a later valid session.
    const next = await started({})
    await emitChunk(64)
    await js(`window.__fm.recorders[${failedIndex}].onerror && window.__fm.recorders[${failedIndex}].onerror(new Event('error'))`)
    await clickFinish()
    out.staleErrorNextSession = await verdict(next, {})
  }
  // Control: started recorder, observed empty stop → complete/none.
  {
    const id = await started({})
    await clickFinish()
    out.emptyControl = await verdict(id, {})
  }
  pill.destroy()
  pill = null
  await sleep(200)
  return out
}

async function scenarioChecks(html) {
  await createPill(html)
  const s = {}
  // Finish while the grant is pending.
  {
    const id = await startNarrated({ mode: 'hold' })
    await waitFor(async () => (await fm()).pendingGrants === 1, 3000, 'pending grant')
    // Expand the ledger to reach Finish without pausing.
    await js(`document.querySelector('.pill')?.click()`)
    await clickFinish()
    await sleep(100)
    await js('window.__fm.grantAll()')
    await sleep(300)
    const st = await fm()
    s.grantAfterStop = { recorderStarts: st.starts, liveTracks: st.liveTracks, save: await savedAudio(id) }
  }
  // Recorder construction throws: the track is released immediately; session continues.
  {
    const before = await fm()
    const id = await startNarrated({ mode: 'auto', ctorThrows: true })
    await sleep(300)
    const st = await fm()
    s.recorderCtorThrows = { liveTracks: st.liveTracks, newTracks: st.tracks - before.tracks, phase: phase() }
    await clickPause()
    await waitFor(() => phase() === 'paused', 4000, 'paused')
    await waitPausedUi()
    await clickFinish()
    s.recorderCtorThrows.save = await savedAudio(id)
  }
  // Rapid Pause + Finish join one teardown; every track stopped exactly once.
  {
    const startsBefore = (await fm()).starts
    const id = await startNarrated({ mode: 'auto', finalChunkBytes: 32 })
    await waitFor(async () => (await fm()).starts > startsBefore, 3000, 'recorder start')
    await emitChunk(48)
    await js(`document.querySelector('.pill')?.click()`)
    await waitFor(() => js('!!document.querySelector(".ledger-footer .btn-primary")'), 4000, 'ledger')
    await js(`(() => { document.querySelector('.ledger-header .play-pause-btn').click(); document.querySelector('.ledger-footer .btn-primary').click() })()`)
    const save = await savedAudio(id)
    const st = await fm()
    s.rapidPauseFinish = { save, liveTracks: st.liveTracks, maxStopsPerTrack: st.maxStopsPerTrack }
  }
  // Unmount while the grant is pending: the late grant is released.
  {
    await startNarrated({ mode: 'hold' })
    await waitFor(async () => (await fm()).pendingGrants === 1, 3000, 'pending grant')
    const before = await fm()
    await js('window.__grayHarness.unmount()')
    await js('window.__fm.grantAll()')
    await sleep(300)
    const st = await fm()
    s.grantAfterUnmount = { recorderStarts: st.starts - before.starts, liveTracks: st.liveTracks }
    await telemetry.stopActiveRecording('owner_lost')
  }
  pill.destroy()
  pill = null
  await sleep(200)
  return s
}

async function cycles(html, n) {
  await createPill(html)
  const out = { n, complete: 0, exactReceipts: 0, latencies: [] }
  for (let i = 0; i < n; i++) {
    const id = await startNarrated({ mode: 'auto' })
    await waitFor(async () => (await fm()).recordersRecording === 1, 3000, 'recorder start')
    await emitChunk(64)
    const t0 = Date.now()
    await clickPause()
    await waitFor(() => phase() === 'paused', 4000, 'paused')
    await waitPausedUi()
    out.latencies.push(Date.now() - t0)
    await clickFinish()
    const save = await savedAudio(id)
    if (save.state === 'complete') out.complete++
    if (save.audio && save.audio.chunks === 1 && save.audio.bytes === 64) out.exactReceipts++
  }
  const st = await fm()
  out.end = { liveTracks: st.liveTracks, recordersRecording: st.recordersRecording, pendingGrants: st.pendingGrants, tracks: st.tracks, maxStopsPerTrack: st.maxStopsPerTrack, narrationActive: telemetry.getNarrationRecorder().isActive(), phase: phase() }
  out.latencies.sort((a, b) => a - b)
  out.pauseMedianMs = out.latencies[Math.floor(n / 2)]
  pill.destroy()
  pill = null
  await sleep(200)
  return out
}

// ── M2-R2 owner boundaries: pending Start, reserved Stop, durable save, failed teardown ──
const g = global.__captureSmoke
const gates = { create: null, createReached: false, finalSave: null }
function holdGate() {
  let release
  const promise = new Promise((r) => (release = r))
  return { promise, release }
}
function installStoreGates() {
  const st = telemetry.getTelemetryStore()
  const create = st.createSession.bind(st)
  st.createSession = async (input) => {
    if (gates.create) {
      gates.createReached = true
      await gates.create.promise
    }
    return create(input)
  }
  const update = st.updateDelivery.bind(st)
  st.updateDelivery = async (id, fn, extra) => {
    let probe
    try { probe = fn(undefined) } catch { probe = undefined }
    const state = probe && probe.save && probe.save.state
    if (gates.finalSave && (state === 'complete' || state === 'incomplete')) await gates.finalSave.promise
    return update(id, fn, extra)
  }
}
async function clickRecord() {
  await js('window.__fm.reset({ mode: "auto" })')
  await pressRecordInDropdown()
}
async function lastSave() {
  const [m] = await telemetry.getTelemetryStore().listSessions({ limit: 1 })
  return m ? { state: m.delivery && m.delivery.save && m.delivery.save.state, errorCode: (m.delivery && m.delivery.save && m.delivery.save.errorCode) || null, stopReason: (m.delivery && m.delivery.save && m.delivery.save.stopReason) || null } : null
}
const sessionCount = async () => (await telemetry.getTelemetryStore().listSessions({ limit: 500 })).length
const settle = (ms = 700) => sleep(ms)

async function ownerTrial(html) {
  const t = {}
  // A. Owner window destroyed while Start waits on storage.
  {
    await createPill(html)
    gates.create = holdGate(); gates.createReached = false
    await clickRecord()
    await waitFor(() => gates.createReached, 4000, 'start held in storage')
    const ix0 = g.ixStarts, w0 = g.winReads
    pill.destroy(); pill = null
    gates.create.release(); gates.create = null
    await settle(800)
    t.ownerLostDuringStart = { sourceStarts: g.ixStarts - ix0, windowReads: g.winReads - w0, phase: phase(), active: telemetry.hasActiveRecording(), save: await lastSave() }
  }
  // B. Each main barrier reason while Start waits on storage.
  t.barrierDuringStart = {}
  for (const reason of ['hide', 'logout', 'permission_revoked', 'quit']) {
    await createPill(html)
    gates.create = holdGate(); gates.createReached = false
    await clickRecord()
    await waitFor(() => gates.createReached, 4000, 'start held in storage')
    const ix0 = g.ixStarts, w0 = g.winReads
    let done = false
    const barrier = telemetry.stopActiveRecording(reason).then(() => (done = true))
    await sleep(60)
    const waitedForStart = !done
    gates.create.release(); gates.create = null
    await barrier
    await settle(600)
    t.barrierDuringStart[reason] = { waitedForStart, sourceStarts: g.ixStarts - ix0, windowReads: g.winReads - w0, phase: phase(), active: telemetry.hasActiveRecording() }
    pill.destroy(); pill = null
    await sleep(150)
  }
  // C. Resume during a reserved main Stop (before the renderer's reply arrives).
  {
    await createPill(html)
    const id = await startNarrated({ mode: 'auto' })
    await clickPause()
    await waitFor(() => phase() === 'paused', 4000, 'paused')
    await waitPausedUi()
    const ix0 = g.ixStarts
    const t0 = Date.now()
    const barrier = telemetry.stopActiveRecording('hide')
    const resumed = await js(`window.ghostBridge.telemetryResume({ sessionId: ${JSON.stringify(id)} })`)
    await barrier
    const stopMs = Date.now() - t0
    const w0 = g.winReads
    await settle(600)
    t.resumeDuringStop = { resumeOk: !!(resumed && resumed.ok), sourceStarts: g.ixStarts - ix0, windowReadsAfter: g.winReads - w0, stopMs, save: await lastSave(), liveChildren: g.ixLive }
    pill.destroy(); pill = null
    await sleep(150)
  }
  // D. Quit during the final save write: recorder idle, durable outcome pending.
  {
    await createPill(html)
    const id = await startNarrated({ mode: 'auto' })
    const before = await sessionCount()
    gates.finalSave = holdGate()
    await clickFinish()
    await waitFor(() => phase() === 'idle', 6000, 'recorder idle')
    const idleButActive = telemetry.hasActiveRecording()
    let quitDone = false
    const t0 = Date.now()
    const quitting = telemetry.flushTelemetryOnQuit().then(() => (quitDone = true))
    await sleep(150)
    const quitWaited = !quitDone
    const startDuringSave = await js('window.ghostBridge.telemetryStart({})')
    gates.finalSave.release(); gates.finalSave = null
    await quitting
    t.quitDuringSave = { idleButActive, quitWaited, startRefused: !(startDuringSave && startDuringSave.ok), quitMs: Date.now() - t0, newSessions: (await sessionCount()) - before, save: await lastSave(), sessionId: id }
    pill.destroy(); pill = null
    await sleep(150)
  }
  // E. A sensor that never confirms exit.
  {
    await createPill(html)
    await startNarrated({ mode: 'auto' })
    g.stopFails = true
    await clickPause()
    await sleep(300)
    const st = telemetry.getTelemetryRecorder().getRecordingStatus()
    const pausedUi = await js('document.querySelector(".play-pause-btn")?.title === "Resume"')
    await clickFinish()
    await waitFor(() => phase() === 'idle', 6000, 'stopped')
    await settle(300)
    const save = await lastSave()
    const w0 = g.winReads, ix0 = g.ixStarts, n0 = await sessionCount()
    const retry = await js('window.ghostBridge.telemetryStart({})')
    await settle(600)
    t.teardownFailure = { pauseAcknowledgedInUi: pausedUi, teardownFailed: st.teardownFailed, save, windowReadsAfter: g.winReads - w0, replacementStarts: g.ixStarts - ix0, startRefused: !(retry && retry.ok), newSessions: (await sessionCount()) - n0, liveChildren: g.ixLive }
    // Child observed to exit later: capture is available again.
    Object.assign(g, { stopFails: false, pendingTeardown: false, ixLive: 0 })
    pill.destroy(); pill = null
    await sleep(150)
  }
  return t
}

async function ownerCycles(html, n) {
  await createPill(html)
  const out = { n, complete: 0, latencies: [] }
  for (let i = 0; i < n; i++) {
    const id = await startNarrated({ mode: 'auto' })
    await sleep(50)
    const t0 = Date.now()
    await telemetry.stopActiveRecording(i % 2 ? 'hide' : 'quit')
    out.latencies.push(Date.now() - t0)
    const m = await telemetry.getTelemetryStore().getSessionMeta(id)
    if (m && m.delivery.save.state === 'complete') out.complete++
    await waitFor(() => js('document.querySelector(".ghost-root") && !document.querySelector(".ghost-root-glass")'), 4000, 'renderer idle')
    await sleep(100)
  }
  out.latencies.sort((a, b) => a - b)
  out.stopMedianMs = out.latencies[Math.floor(n / 2)]
  out.end = { liveChildren: g.ixLive, active: telemetry.hasActiveRecording(), phase: phase(), liveTracks: (await fm()).liveTracks }
  pill.destroy(); pill = null
  await sleep(200)
  return out
}

/**
 * M1-HF3-B: two Record presses in the dropdown (and a replayed command) start exactly one
 * session with one microphone owner, in the pill; the child owns no capture.
 */
async function duplicateRecordCheck(html) {
  await createPill(html)
  await js('window.__fm.reset({ mode: "auto" })')
  const before = await sessionCount()
  pill.webContents.send('pill:openRecordPanel')
  await waitFor(async () => {
    const c = ddChild()
    return !!c && !c.isDestroyed() && c.isVisible() && (await c.webContents.executeJavaScript('!!document.querySelector(".btn-record")'))
  }, 6000, 'record dropdown')
  const child = ddChild()
  await child.webContents.executeJavaScript('(() => { const b = document.querySelector(".btn-record"); b.click(); b.click() })()')
  await waitFor(() => phase() === 'recording', 4000, 'recording')
  await sleep(600)
  const stats = await fm()
  const out = {
    sessions: (await sessionCount()) - before,
    phase: phase(),
    getUserMediaCalls: stats.gumCalls != null ? stats.gumCalls : stats.tracks,
    childHasCaptureBridge: child.isDestroyed() ? null : await child.webContents.executeJavaScript('typeof window.ghostBridge'),
    dropdownClosed: child.isDestroyed() || !child.isVisible()
  }
  await telemetry.stopActiveRecording('quit')
  pill.destroy(); pill = null
  await sleep(200)
  return out
}

async function runOwnerBoundaries(r, tryRun) {
  installStoreGates()
  report.duplicateRecord = await tryRun('duplicateRecord', () => duplicateRecordCheck(r.html))
  const dr = report.duplicateRecord
  if (dr && (dr.sessions !== 1 || dr.getUserMediaCalls > 1 || dr.childHasCaptureBridge !== 'undefined' || !dr.dropdownClosed)) fail('duplicateRecord', 'duplicate_record', dr)
  await tryRun('ownerWarmup', () => ownerTrial(r.html))
  report.ownerTrials = []
  for (let i = 0; i < 3; i++) report.ownerTrials.push(await tryRun('ownerTrial' + i, () => ownerTrial(r.html)))
  report.ownerCycles20 = await tryRun('ownerCycles20', () => ownerCycles(r.html, 20))
  for (const [i, t] of report.ownerTrials.entries()) {
    if (!t) continue
    const a = t.ownerLostDuringStart
    if (a.sourceStarts || a.windowReads || a.active || !a.save || a.save.errorCode !== 'START_FAILED') fail('ownerTrial' + i, 'owner_lost_during_start', a)
    for (const [reason, b] of Object.entries(t.barrierDuringStart)) {
      if (b.sourceStarts || b.windowReads || b.active || !b.waitedForStart) fail('ownerTrial' + i, 'barrier_during_start_' + reason, b)
    }
    const c = t.resumeDuringStop
    if (c.resumeOk || c.sourceStarts || c.windowReadsAfter || !c.save || c.save.state !== 'complete' || c.liveChildren) fail('ownerTrial' + i, 'resume_during_stop', c)
    const d = t.quitDuringSave
    if (!d.idleButActive || !d.quitWaited || !d.startRefused || d.newSessions !== 0 || d.save.state !== 'complete') fail('ownerTrial' + i, 'quit_during_save', d)
    const e = t.teardownFailure
    if (e.pauseAcknowledgedInUi || !e.teardownFailed || e.save.errorCode !== 'SOURCE_TEARDOWN_FAILED' || e.windowReadsAfter || e.replacementStarts || !e.startRefused || e.newSessions) fail('ownerTrial' + i, 'teardown_failure', e)
  }
  const c = report.ownerCycles20
  if (c && (c.complete !== 20 || c.end.liveChildren || c.end.active || c.end.phase !== 'idle' || c.end.liveTracks)) fail('ownerCycles20', 'cycles', c)
}

app.on('window-all-closed', () => {})

async function run() {
  const watchdog = setTimeout(() => {
    fail('watchdog', 'timeout', {})
    fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
    app.exit(4)
  }, 280000)
  watchdog.unref()
  await app.whenReady()
  telemetry = await bundleMain()
  await telemetry.initTelemetry()
  telemetry.registerTelemetryIpc()
  T.registerTransitionIpc(ipcMain, (wc) => BrowserWindow.fromWebContents(wc), ctl, () => pill)
  dropdownWiring = T.createRecordDropdownWiring({
    ipc: ipcMain,
    BrowserWindow,
    preload: path.join(ROOT, 'out/preload/index.js'),
    load: (win) => win.loadFile(childHtml, { hash: T.RECORD_DROPDOWN_HASH }),
    pill: () => pill,
    ctl: () => ctl
  })
  const preload = fs.readFileSync(path.join(ROOT, 'out/preload/index.js'), 'utf8')
  for (const ch of new Set([...preload.matchAll(/invoke\(\s*["']([^"']+)["']/g)].map((m) => m[1]))) {
    try {
      ipcMain.handle(ch, (...a) => (fixtures[ch] ? fixtures[ch](...a) : undefined))
    } catch {
      /* already handled by telemetry or transitions */
    }
  }
  ipcMain.on('window:setIgnoreMouseEvents', () => {})
  const r = await bundleRenderer()
  report.identity = { rendererMode: MODE, reactDom: r.reactDom, electron: process.versions.electron }
  if (r.reactDom !== (MODE === 'development' ? 'react-dom.development' : 'react-dom.production.min')) refuse('bundled React runtime mismatch: ' + r.reactDom)

  const tryRun = async (name, fn) => {
    try {
      return await fn()
    } catch (err) {
      fail(name, 'error', String(err && err.message))
      if (pill) { pill.destroy(); pill = null }
      return null
    }
  }
  if (SCENARIO === 'owner-boundaries') {
    await runOwnerBoundaries(r, tryRun)
    report.openaiConstructed = global.__captureSmoke.openaiConstructed
    report.windowsAtEnd = BrowserWindow.getAllWindows().length
    if (report.openaiConstructed !== 0) fail('egress', 'provider_constructed', report.openaiConstructed)
    if (report.windowsAtEnd !== 0) fail('teardown', 'windows', report.windowsAtEnd)
    fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
    console.log('CAPTURE-SMOKE ' + JSON.stringify({ identity: report.identity, scenario: SCENARIO, failures: report.failures.length }))
    app.exit(report.failures.length ? 1 : 0)
    return
  }
  await tryRun('warmup', () => trial(r.html))
  for (let i = 0; i < 3; i++) report.trials.push(await tryRun('trial' + i, () => trial(r.html)))
  report.scenarios = (await tryRun('scenarios', () => scenarioChecks(r.html))) || {}
  await tryRun('failureWarmup', () => failureTrial(r.html))
  report.failureTrials = []
  for (let i = 0; i < 3; i++) report.failureTrials.push(await tryRun('failureTrial' + i, () => failureTrial(r.html)))
  report.cycles20 = await tryRun('cycles20', () => cycles(r.html, 20))
  report.openaiConstructed = global.__captureSmoke.openaiConstructed
  report.windowsAtEnd = BrowserWindow.getAllWindows().length

  // Acceptance (M2-R1).
  for (const [i, t] of report.trials.entries()) {
    if (!t) continue
    if (t.lateGrant.recorderStarts !== 0 || t.lateGrant.liveTracks !== 0 || t.lateGrant.maxStopsPerTrack !== 1) fail('trial' + i, 'late_grant', t.lateGrant)
    if (!t.receipt) { fail('trial' + i, 'receipt', t.receiptError); continue }
    if (t.receipt.save.state !== 'complete' || !t.receipt.save.audio || t.receipt.save.audio.chunks !== 1 || t.receipt.save.audio.bytes !== 64) fail('trial' + i, 'receipt', t.receipt)
    if (t.receipt.reacquiredOnResume !== 0 || t.receipt.liveTracksAtPause !== 0 || t.receipt.liveTracksAfterStop !== 0) fail('trial' + i, 'tracks', t.receipt)
  }
  const s = report.scenarios
  if (s.grantAfterStop && (s.grantAfterStop.recorderStarts !== 0 || s.grantAfterStop.liveTracks !== 0)) fail('grantAfterStop', 'late_grant', s.grantAfterStop)
  if (s.recorderCtorThrows && (s.recorderCtorThrows.liveTracks !== 0 || s.recorderCtorThrows.phase !== 'recording')) fail('recorderCtorThrows', 'tracks', s.recorderCtorThrows)
  if (s.rapidPauseFinish && (s.rapidPauseFinish.liveTracks !== 0 || s.rapidPauseFinish.maxStopsPerTrack !== 1)) fail('rapidPauseFinish', 'tracks', s.rapidPauseFinish)
  if (s.grantAfterUnmount && (s.grantAfterUnmount.recorderStarts !== 0 || s.grantAfterUnmount.liveTracks !== 0)) fail('grantAfterUnmount', 'late_grant', s.grantAfterUnmount)
  for (const [i, f] of (report.failureTrials || []).entries()) {
    if (!f) continue
    for (const k of ['zeroChunkTimeout', 'stopThrows', 'runtimeError64', 'runtimeError0']) {
      const v = f[k]
      if (v.save.state !== 'incomplete' || v.save.errorCode !== 'AUDIO_INCOMPLETE' || v.afterRepeat.state !== 'incomplete' || v.reviewOk) fail('failureTrial' + i, k, v)
      if (v.liveTracks !== 0 || v.stopListeners !== 0) fail('failureTrial' + i, k + '_resources', v)
    }
    for (const k of ['emptyControl', 'staleErrorNextSession']) {
      const v = f[k]
      if (v.save.state !== 'complete' || v.afterRepeat.state !== 'complete' || v.liveTracks !== 0 || v.stopListeners !== 0) fail('failureTrial' + i, k, v)
    }
    if (f.staleErrorNextSession.save.audio?.chunks !== 1 || f.staleErrorNextSession.save.audio?.bytes !== 64) fail('failureTrial' + i, 'staleErrorNextSession_receipt', f.staleErrorNextSession)
  }
  const c = report.cycles20
  if (c && (c.complete !== 20 || c.exactReceipts !== 20 || c.end.liveTracks || c.end.recordersRecording || c.end.pendingGrants || c.end.narrationActive || c.end.phase !== 'idle')) fail('cycles20', 'cycles', c)
  if (report.openaiConstructed !== 0) fail('egress', 'provider_constructed', report.openaiConstructed)
  if (report.windowsAtEnd !== 0) fail('teardown', 'windows', report.windowsAtEnd)

  fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
  console.log('CAPTURE-SMOKE ' + JSON.stringify({ identity: report.identity, failures: report.failures.length }))
  app.exit(report.failures.length ? 1 : 0)
}

run().catch((err) => {
  console.error('[capture-smoke] harness error', err && err.stack ? err.stack : err)
  app.exit(3)
})
