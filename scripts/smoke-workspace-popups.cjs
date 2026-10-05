/* eslint-disable */
'use strict'
/**
 * TEST-ONLY isolated actual-WorkspaceApp popup/long-text containment harness (HF4).
 *
 * Bundles the real renderer WorkspaceApp (and its children), production CSS and fonts with the
 * installed esbuild, in development (StrictMode) or production React, and loads it in the
 * documented 879×621 transparent workspace window (visible card 807×549 at 36,36). A synthetic
 * bridge stands in for main: every non-read call is counted as an effect. No main process code,
 * capture, provider, actuator, real profile or network is involved. Input is directed at this
 * synthetic window only (webContents.sendInputEvent) and every actionable control is
 * hit-tested with elementFromPoint at its real center; screenshots use capturePage of this
 * window only. Unknown flags refuse to run.
 *
 *   GRAY_UI_FIXTURE_DIR=$(mktemp -d /tmp/gray-hf4-popups.XXXXXX)
 *   env -u ELECTRON_RUN_AS_NODE OPENAI_API_KEY= GRAY_UI_FIXTURE_DIR="$GRAY_UI_FIXTURE_DIR" \
 *     /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny network*)' \
 *     ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
 *     scripts/smoke-workspace-popups.cjs --renderer-mode=production --scenario=containment
 */
const { app, BrowserWindow } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FX = process.env.GRAY_UI_FIXTURE_DIR || ''

process.on('uncaughtException', (err) => {
  console.error('[popups] uncaught', err && err.stack ? err.stack : err)
  app.exit(3)
})
function refuse(msg) {
  console.error('[popups] refusing to start: ' + msg)
  app.exit(2)
}

const ARGS = {}
for (const a of process.argv.slice(2)) {
  const m = /^--(renderer-mode|scenario)=(.+)$/.exec(a)
  if (!m) refuse('unknown argument ' + a)
  else ARGS[m[1]] = m[2]
}
const MODE = ARGS['renderer-mode'] || 'production'
const SCENARIO = ARGS.scenario || ''
if (!['development', 'production'].includes(MODE)) refuse('unknown --renderer-mode ' + MODE)
if (SCENARIO !== 'containment') refuse('unknown --scenario ' + SCENARIO + ' (expected containment)')

const tmpRoots = [os.tmpdir(), '/tmp', '/private/tmp'].map((p) => fs.realpathSync(p))
if (!FX || !path.isAbsolute(FX) || !fs.existsSync(FX)) refuse('GRAY_UI_FIXTURE_DIR must be an existing absolute temp dir')
const fxReal = fs.existsSync(FX) ? fs.realpathSync(FX) : ''
if (fxReal && !tmpRoots.some((r) => fxReal.startsWith(r + path.sep))) refuse('fixture dir must be under a temp root')
if (fxReal && fs.readdirSync(fxReal).length > 0) refuse('fixture dir must be empty (use a fresh mktemp -d)')
if (process.env.OPENAI_API_KEY) refuse('OPENAI_API_KEY must be empty')
app.setName('gray-ui-smoke')
// Chromium's inner seatbelt cannot initialize nested in sandbox-exec (which denies network).
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
for (const [k, sub] of [['userData', 'userData'], ['sessionData', 'sessionData'], ['logs', 'logs'], ['crashDumps', 'crash']]) {
  const dir = path.join(fxReal, sub)
  fs.mkdirSync(dir, { recursive: true })
  app.setPath(k, dir)
}
const SHOTS = path.join(fxReal, 'shots')
fs.mkdirSync(SHOTS, { recursive: true })
app.on('window-all-closed', () => {})

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Synthetic renderer entry: actual WorkspaceApp + production CSS, fixture-driven bridge ──
const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import WorkspaceApp from './src/renderer/src/workspace/WorkspaceApp'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import './src/renderer/src/styles/globals.css'
import './src/renderer/src/styles/components.css'
import './src/renderer/src/styles/workspace.css'

// Owned-work accounting: window/document listeners and ResizeObservers alive right now.
const live = { listeners: {}, observers: 0 }
for (const target of [window, document]) {
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  const seen = new Map()
  target.addEventListener = (type, fn, opts) => {
    const key = type + (typeof opts === 'boolean' ? opts : !!(opts && opts.capture))
    const set = seen.get(key) || new Set()
    if (!set.has(fn)) { set.add(fn); live.listeners[type] = (live.listeners[type] || 0) + 1 }
    seen.set(key, set)
    return add(type, fn, opts)
  }
  target.removeEventListener = (type, fn, opts) => {
    const key = type + (typeof opts === 'boolean' ? opts : !!(opts && opts.capture))
    const set = seen.get(key)
    if (set && set.delete(fn)) live.listeners[type] -= 1
    return remove(type, fn, opts)
  }
}
const RO = window.ResizeObserver
window.ResizeObserver = class extends RO {
  constructor(cb) { super(cb); this.__on = false }
  observe(...a) { if (!this.__on) { this.__on = true; live.observers += 1 } return super.observe(...a) }
  disconnect() { if (this.__on) { this.__on = false; live.observers -= 1 } return super.disconnect() }
}

const q = new URLSearchParams(location.search)
const kind = q.get('name') || 'short'
const NAMES = {
  short: 'Synthetic workflow',
  token: 'SyntheticWorkflow_' + 'x'.repeat(200),
  prose: 'Synthetic workflow for reviewing a long local fixture description with many words. '.repeat(26),
  unicode: 'Synthetic 作業 🙂 Ünïcode line\\nsecond synthetic line ✓\\n'.repeat(8)
}
const name = NAMES[kind]
const count = Number(q.get('count') || 1)
const target = Number(q.get('target') || count - 1)
const workflows = Array.from({ length: count }, (_, i) => ({
  id: 'wf_fixture_' + i,
  name: i === target ? name : 'Synthetic workflow ' + i,
  metaLabel: '1 step',
  trigger: {},
  steps: [{ id: 'step1', index: 1, title: 'Synthetic step' }],
  status: 'on',
  runCount: 3,
  hoursReturned: '0h',
  scope: 'personal'
}))
if (q.get('contract')) {
  workflows[target].sessionId = 'tsess_fixture'
  workflows[target].runContract = {
    inputs: ['synthetic-input-' + 'x'.repeat(200)],
    writes: ['Synthetic destination ' + 'long prose '.repeat(30)],
    commits: ['Synthetic submit'],
    destinations: ['https://example.invalid/' + 'y'.repeat(200)],
    authorizationLevel: 'assist'
  }
}
const rec = { sessionId: 'tsess_fixture', startedAt: '2026-01-01T00:00:00.000Z', saveState: 'complete', canRetrySave: false, reviewState: 'prepared', interpretationState: 'not_started', screenshotCapture: 'disabled_privacy' }
const preview = { sessionId: rec.sessionId, revision: 1, digest: 'a'.repeat(64), provider: 'openai', model: 'synthetic-model-' + 'm'.repeat(200), purpose: 'Synthetic interpretation preview ' + 'p'.repeat(200), stages: 'Synthetic stages', payloadText: JSON.stringify({ fixture: 'z'.repeat(400) }), bytes: 400, actionCount: 1, elided: false, categories: ['Synthetic actions ' + 'c'.repeat(200)], exclusions: ['Screenshots and screen video', 'Raw microphone audio'], legacyUnverified: false }
const memberName = q.get('member') === 'token' ? 'SyntheticMember_' + 'n'.repeat(200) : 'Synthetic member'
const team = { id: 'team_fixture', name: q.get('team') === 'token' ? 'SyntheticTeam_' + 't'.repeat(200) : 'Synthetic team', role: q.get('role') || 'owner', memberCount: 2,
  members: [{ id: 'owner', name: 'Synthetic owner', role: 'owner', isSelf: true }, { id: 'member_fixture', name: memberName, email: 'fixture@example.invalid', role: 'member' }], invites: [] }
const snapshot = { workflows, runs: [], suggestion: null, activity: [], team, session: { email: 'fixture@example.invalid', displayName: 'Synthetic owner' }, onboardingComplete: true }

// Every call that is not a read/subscription is an effect: cancel paths must produce none.
const effects = []
const READS = new Set(['getSnapshot', 'telemetryListRecordings', 'telemetryGetRecording', 'telemetryPrepareReview', 'getRun'])
const known = {
  getSnapshot: async () => snapshot,
  telemetryListRecordings: async () => (q.get('review') ? [rec] : []),
  telemetryGetRecording: async () => ({ ok: true, recording: rec }),
  telemetryPrepareReview: async () => ({ ok: true, recording: rec, preview }),
  getRun: async () => null
}
window.ghostBridge = new Proxy(known, {
  get(t, k) {
    if (typeof k !== 'string') return undefined
    if (k in t) return t[k]
    if (k.startsWith('on')) return () => () => {}
    return (...args) => {
      if (!READS.has(k)) effects.push([k, typeof args[0] === 'string' ? args[0] : args[0] && typeof args[0] === 'object' && 'id' in args[0] ? args[0].id : null])
      return Promise.resolve(k === 'deleteWorkflow' || k === 'teamRemoveMember' ? snapshot : undefined)
    }
  }
})
window.__hf4 = { effects, live, names: NAMES }
const tree = React.createElement(WorkspaceApp)
createRoot(document.getElementById('root')).render(${MODE === 'development' ? 'React.createElement(React.StrictMode, null, tree)' : 'tree'})
`

async function bundle() {
  const esbuild = require(path.join(ROOT, 'node_modules/esbuild'))
  const outdir = path.join(fxReal, 'renderer')
  await esbuild.build({
    stdin: { contents: ENTRY, loader: 'jsx', resolveDir: ROOT, sourcefile: 'hf4-workspace-entry.jsx' },
    outfile: path.join(outdir, 'main.js'),
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    jsxDev: MODE === 'development',
    define: { 'process.env.NODE_ENV': JSON.stringify(MODE) },
    loader: { '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file', '.tsx': 'tsx', '.ts': 'ts' },
    assetNames: 'assets/[name]-[hash]',
    logLevel: 'silent'
  })
  const html = path.join(outdir, 'index.html')
  fs.writeFileSync(html, '<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script src="main.js"></script></body></html>')
  const js = fs.readFileSync(path.join(outdir, 'main.js'), 'utf8')
  return { html, reactDom: (/node_modules\/react-dom\/cjs\/(react-dom\.[a-z.]+)\.js/.exec(js) || [])[1] || 'unknown' }
}

// ── In-page geometry helpers (content-free: rectangles, counts, booleans) ──
const PAGE_HELPERS = `
window.__geo = {
  card() { const r = document.querySelector('.workspace-window').getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom } },
  rect(el) { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } },
  hit(el) {
    const r = el.getBoundingClientRect()
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2
    const at = document.elementFromPoint(cx, cy)
    return { cx, cy, ok: !!at && (at === el || el.contains(at)) }
  },
  inside(r, c, inset) { return r.x >= c.x + inset - 0.5 && r.y >= c.y + inset - 0.5 && r.right <= c.right - inset + 0.5 && r.bottom <= c.bottom - inset + 0.5 },
  /** Descendant text boxes extending past a horizontal bound (clipped text). */
  spill(root, bound) {
    let n = 0, maxRight = 0
    for (const el of root.querySelectorAll('*')) {
      if (!el.childNodes.length) continue
      const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())
      if (!hasText) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0) continue
      maxRight = Math.max(maxRight, r.right)
      if (r.right > bound + 0.5 || r.x < 0) n++
    }
    return { spilled: n, maxRight }
  },
  byText(sel, text) { return [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text || e.textContent.trim().startsWith(text)) || null }
}
`

let win = null
const report = { identity: {}, cases: {}, cycles: null }
const failures = []
function fail(c, kind, detail) {
  failures.push({ case: c, kind, detail })
}
const js = (code) => win.webContents.executeJavaScript(code)

async function load(query) {
  const loaded = new Promise((r) => win.webContents.once('did-finish-load', r))
  await win.loadFile(report.html, { search: query })
  await loaded
  await js(PAGE_HELPERS + ';true')
  for (let i = 0; i < 100; i++) {
    if (await js('!!document.querySelector(".workspace-window .ws-sidebar")')) break
    await sleep(30)
  }
  await js('document.fonts.ready.then(() => true)')
  await sleep(250)
}

/** Directed click at the element's real center, after an elementFromPoint hit test. */
async function clickEl(c, selectorExpr, label, opts = {}) {
  const h = await js(`(() => { const el = ${selectorExpr}; if (!el) return null; return __geo.hit(el) })()`)
  if (!h) {
    fail(c, 'control_missing', { label })
    return false
  }
  if (!h.ok) {
    fail(c, 'control_unhittable', { label, cx: Math.round(h.cx), cy: Math.round(h.cy) })
    if (opts.domFallback) {
      // Diagnostic only: open the downstream surface to measure it. Not acceptance evidence.
      await js(`(${selectorExpr}).click()`)
      await sleep(250)
    }
    return false
  }
  const x = Math.round(h.cx), y = Math.round(h.cy)
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(250)
  return true
}
async function key(code) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: code })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: code })
  await sleep(200)
}
const effects = () => js('__hf4.effects.slice()')
const shot = async (name) => {
  const img = await win.webContents.capturePage()
  fs.writeFileSync(path.join(SHOTS, name + '.png'), img.toPNG())
}

/** Measure an open confirmation dialog: bounds, overflow, scroll owner, controls, full text. */
async function measureDialog(c, expectExpr) {
  return js(`(() => {
    const card = __geo.card()
    const d = document.querySelector('[role="dialog"]')
    if (!d) return null
    const body = d.querySelector('.delete-dialog-body')
    const title = d.querySelector('.delete-dialog-title')
    const buttons = [...d.querySelectorAll('.delete-dialog-actions button')]
    const text = d.textContent
    return {
      card, dialog: __geo.rect(d),
      inside: __geo.inside(__geo.rect(d), card, 8),
      hOverflow: Math.max(0, d.scrollWidth - d.clientWidth, body ? body.scrollWidth - body.clientWidth : 0),
      spill: __geo.spill(d, __geo.rect(d).right).spilled,
      bodyScrolls: !!body && body.scrollHeight > body.clientHeight + 1,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
      titleInside: !!title && __geo.inside(__geo.rect(title), card, 8),
      buttons: buttons.map((b) => ({ label: b.textContent.trim(), hit: __geo.hit(b).ok, inside: __geo.inside(__geo.rect(b), card, 8) })),
      fullTextPresent: text.includes(${expectExpr})
    }
  })()`)
}

/** Delete-style confirmation flow: cancel, Escape, backdrop (all zero effects), then confirm once. */
async function confirmationCase(c, opts) {
  const res = { opener: null, measures: null, cancel: {}, confirm: null }
  const open = async () => {
    const ok = await opts.open()
    for (let i = 0; i < 20 && !(await js('!!document.querySelector(\'[role="dialog"]\')')); i++) await sleep(50)
    return ok
  }
  res.opener = await open()
  const m = await measureDialog(c, opts.expectText)
  res.measures = m
  if (!m) {
    fail(c, 'dialog_missing', {})
    return res
  }
  if (!m.inside) fail(c, 'dialog_outside_card', { dialog: m.dialog, card: m.card })
  if (m.hOverflow > 1 || m.spill) fail(c, 'dialog_horizontal_overflow', { hOverflow: m.hOverflow, spill: m.spill })
  if (!m.titleInside) fail(c, 'dialog_title_outside', {})
  if (!m.fullTextPresent) fail(c, 'dialog_target_text_missing', {})
  for (const b of m.buttons) if (!b.hit || !b.inside) fail(c, 'dialog_action_unhittable', b)
  await shot(c + '-open')
  if (m.bodyScrolls) {
    // Read the end of a long body while the footer stays visible.
    await js(`(() => { const b = document.querySelector('[role="dialog"] .delete-dialog-body'); b.scrollTop = b.scrollHeight })()`)
    await sleep(150)
    const end = await js(`(() => { const d = document.querySelector('[role="dialog"]'); return [...d.querySelectorAll('.delete-dialog-actions button')].map((b) => __geo.hit(b).ok) })()`)
    res.footerAfterScroll = end
    if (end.some((ok) => !ok)) fail(c, 'footer_hidden_after_scroll', { end })
    await shot(c + '-scrolled')
  }
  res.focusOnOpen = await js('document.activeElement ? document.activeElement.textContent.trim() : null')
  if (res.focusOnOpen !== 'Cancel') fail(c, 'focus_not_on_cancel', { focus: res.focusOnOpen })
  // Tab stays within the dialog.
  await key('Tab')
  await key('Tab')
  await key('Tab')
  res.focusTrapped = await js('!!document.querySelector(\'[role="dialog"]\') && document.querySelector(\'[role="dialog"]\').contains(document.activeElement)')
  if (!res.focusTrapped) fail(c, 'focus_escaped_dialog', {})

  const before = (await effects()).length
  // 1. Cancel button.
  await clickEl(c, `__geo.byText('[role="dialog"] button', 'Cancel')`, 'Cancel')
  res.cancel.button = { closed: !(await js('!!document.querySelector(\'[role="dialog"]\')')), effects: (await effects()).length - before }
  // 2. Escape.
  await open()
  await key('Escape')
  res.cancel.escape = { closed: !(await js('!!document.querySelector(\'[role="dialog"]\')')), effects: (await effects()).length - before }
  // 3. Backdrop (a point on the scrim outside the dialog).
  await open()
  const pt = await js(`(() => { const c = __geo.card(); const d = document.querySelector('[role="dialog"]').getBoundingClientRect(); return { x: Math.round(c.x + 20), y: Math.round(Math.min(c.bottom - 20, Math.max(c.y + 20, d.bottom + 10 < c.bottom ? d.bottom + 10 : c.y + 20))) } })()`)
  const onScrim = await js(`(() => { const at = document.elementFromPoint(${pt.x}, ${pt.y}); return !!at && !at.closest('[role="dialog"]') })()`)
  win.webContents.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  win.webContents.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
  await sleep(250)
  res.cancel.backdrop = { onScrim, closed: !(await js('!!document.querySelector(\'[role="dialog"]\')')), effects: (await effects()).length - before }
  for (const [k, v] of Object.entries(res.cancel)) {
    if (!v.closed) fail(c, 'cancel_did_not_close', { path: k })
    if (v.effects) fail(c, 'cancel_had_effects', { path: k, effects: v.effects })
  }
  // 4. Explicit confirmation: exactly one effect for the original target.
  await open()
  const e0 = (await effects()).length
  await clickEl(c, `__geo.byText('[role="dialog"] button', ${JSON.stringify(opts.confirmLabel)})`, opts.confirmLabel)
  await sleep(300)
  const after = (await effects()).slice(e0)
  res.confirm = after
  const want = JSON.stringify([opts.expect])
  if (JSON.stringify(after.filter((e) => e[0] === opts.expect[0])) !== want) fail(c, 'confirm_effects', { after, want: opts.expect })
  if (await js('!!document.querySelector(\'[role="dialog"]\')')) fail(c, 'dialog_open_after_confirm', {})
  return res
}

const homeMore = (i) => `document.querySelectorAll('.ws-row .overflow-btn')[${i}]`
const menuItem = (label) => `__geo.byText('.overflow-item', ${JSON.stringify(label)})`

/** A visible menu: inside the card, every enabled item hittable, no horizontal spill. */
async function measureMenu(c, sel) {
  const m = await js(`(() => {
    const card = __geo.card()
    const menu = document.querySelector(${JSON.stringify(sel)})
    if (!menu) return null
    const items = [...menu.querySelectorAll('button')].filter((b) => !b.disabled)
    return { menu: __geo.rect(menu), inside: __geo.inside(__geo.rect(menu), card, 4),
      hOverflow: Math.max(0, menu.scrollWidth - menu.clientWidth), spill: __geo.spill(menu, __geo.rect(menu).right).spilled,
      items: items.map((b) => ({ label: b.textContent.trim().slice(0, 24), hit: __geo.hit(b).ok })) }
  })()`)
  if (!m) {
    fail(c, 'menu_missing', {})
    return m
  }
  if (!m.inside) fail(c, 'menu_outside_card', { menu: m.menu })
  if (m.hOverflow > 1 || m.spill) fail(c, 'menu_horizontal_overflow', { hOverflow: m.hOverflow, spill: m.spill })
  const bad = m.items.filter((i) => !i.hit)
  if (bad.length) fail(c, 'menu_items_unhittable', { count: bad.length, of: m.items.length })
  return m
}

async function run() {
  setTimeout(() => {
    fail('watchdog', 'timeout', {})
    fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify({ ...report, failures }, null, 2))
    app.exit(4)
  }, 300000).unref()
  await app.whenReady()
  const b = await bundle()
  report.html = b.html
  report.identity = {
    rendererMode: MODE, reactDom: b.reactDom, electron: process.versions.electron, window: '879x621',
    sources: Object.fromEntries(['src/renderer/src/workspace/WorkspaceApp.tsx', 'src/renderer/src/workspace/WorkflowsHome.tsx', 'src/renderer/src/workspace/WorkflowDetail.tsx', 'src/renderer/src/workspace/ManageView.tsx', 'src/renderer/src/workspace/Sidebar.tsx', 'src/renderer/src/styles/workspace.css', 'src/renderer/src/styles/components.css'].map((f) => [path.basename(f), sha(path.join(ROOT, f))]))
  }
  if (b.reactDom !== (MODE === 'development' ? 'react-dom.development' : 'react-dom.production.min')) return refuse('bundled React runtime mismatch: ' + b.reactDom)
  win = new BrowserWindow({ x: 40, y: 40, width: 879, height: 621, frame: false, transparent: true, resizable: false, hasShadow: false, show: true, webPreferences: { sandbox: false, contextIsolation: true } })

  // Home delete confirmation: short, unbroken token, prose taller than the dialog, multi-line Unicode.
  for (const kind of ['short', 'token', 'prose', 'unicode']) {
    const c = 'home-delete-' + kind
    await load(`name=${kind}&count=1`)
    report.cases[c] = await confirmationCase(c, {
      expectText: `window.__hf4.names[${JSON.stringify(kind)}]`,
      open: async () => {
        const ok = await clickEl(c, homeMore(0), 'row More', { domFallback: true })
        await clickEl(c, menuItem('Delete…'), 'Delete…', { domFallback: true })
        return ok
      },
      confirmLabel: 'Delete workflow',
      expect: ['deleteWorkflow', 'wf_fixture_0']
    })
  }

  // Detail: long header keeps Back/Run/More inside the card; delete confirmation.
  {
    const c = 'detail-delete-token'
    await load('name=token&count=1')
    await clickEl(c, `document.querySelector('.ws-row-name')`, 'row')
    await sleep(300)
    const head = await js(`(() => { const card = __geo.card(); const t = document.querySelector('.ws-detail-title');
      const ctl = [document.querySelector('.back-btn'), __geo.byText('.ws-detail-actions button', 'Run'), document.querySelector('.ws-detail-actions .overflow-btn')];
      return { title: t ? __geo.rect(t) : null, titleFull: !!t && (t.getAttribute('title') === window.__hf4.names.token || t.textContent === window.__hf4.names.token),
        controls: ctl.map((e) => e ? { hit: __geo.hit(e).ok, inside: __geo.inside(__geo.rect(e), card, 0) } : null) } })()`)
    report.cases['detail-header-token'] = head
    head.controls.forEach((x, i) => { if (!x || !x.hit || !x.inside) fail('detail-header-token', 'header_control_unreachable', { index: i, x }) })
    if (!head.titleFull) fail('detail-header-token', 'header_full_name_missing', {})
    await shot('detail-header-token')
    report.cases[c] = await confirmationCase(c, {
      expectText: 'window.__hf4.names.token',
      open: async () => {
        const ok = await clickEl(c, `document.querySelector('.ws-detail-actions .overflow-btn')`, 'detail More', { domFallback: true })
        await clickEl(c, menuItem('Delete…'), 'Delete…', { domFallback: true })
        return ok
      },
      confirmLabel: 'Delete workflow',
      expect: ['deleteWorkflow', 'wf_fixture_0']
    })
  }

  // Member removal with an unbroken member name.
  {
    const c = 'member-remove-token'
    await load('name=short&count=1&member=token')
    await clickEl(c, `__geo.byText('.ws-nav-item', 'Teams')`, 'Teams nav')
    await sleep(300)
    report.cases[c] = await confirmationCase(c, {
      expectText: "'SyntheticMember_' + 'n'.repeat(200)",
      open: () => clickEl(c, `document.querySelector('.manage-remove-btn')`, 'remove member', { domFallback: true }),
      confirmLabel: 'Remove member',
      expect: ['teamRemoveMember', 'member_fixture']
    })
  }

  // Team menu with a long team name: inside the card, items hittable, Escape returns focus.
  {
    const c = 'team-menu-token'
    await load('name=short&count=1&team=token&role=member')
    await clickEl(c, `document.querySelector('.team-menu-btn')`, 'team menu')
    const m = await measureMenu(c, '.team-menu')
    await shot(c)
    const e0 = (await effects()).length
    await key('Escape')
    const r = { menu: m, closedByEscape: !(await js('!!document.querySelector(".team-menu")')), focusBack: await js('document.activeElement === document.querySelector(".team-menu-btn")') }
    if (!r.closedByEscape) fail(c, 'menu_escape', {})
    if (!r.focusBack) fail(c, 'menu_focus_not_restored', {})
    await clickEl(c, `document.querySelector('.team-menu-btn')`, 'team menu')
    await clickEl(c, `__geo.byText('.team-menu-item', 'Personal')`, 'Personal')
    r.selectEffects = (await effects()).length - e0
    r.closedAfterSelect = !(await js('!!document.querySelector(".team-menu")'))
    if (r.selectEffects || !r.closedAfterSelect) fail(c, 'team_select', r)
    report.cases[c] = r
  }

  // Row menus at top/middle/last row of a scrolled 25-row list.
  for (const [label, idx] of [['top', 0], ['middle', 12], ['last', 24]]) {
    const c = 'row-menu-' + label
    await load('name=short&count=25&target=24')
    await js(`(() => { const row = document.querySelectorAll('.ws-row')[${idx}]; row.scrollIntoView({ block: ${idx === 24 ? "'end'" : idx === 0 ? "'start'" : "'center'"} }) })()`)
    await sleep(150)
    await clickEl(c, homeMore(idx), 'row More')
    const m = await measureMenu(c, '.overflow-menu')
    await shot(c)
    const e0 = (await effects()).length
    // Choosing an action calls it exactly once for that row.
    await clickEl(c, menuItem('Turn off'), 'Turn off')
    const after = (await effects()).slice(e0)
    const r = { menu: m, effects: after }
    if (after.length !== 1 || after[0][0] !== 'upsertWorkflow' || after[0][1] !== 'wf_fixture_' + idx) fail(c, 'menu_action_effects', { after, want: 'wf_fixture_' + idx })
    // Scrolling the list while a menu is open never activates anything.
    await clickEl(c, homeMore(idx), 'row More')
    const e1 = (await effects()).length
    await js(`document.querySelector('.ws-home-body').scrollTop += 40`)
    await sleep(200)
    r.scrollEffects = (await effects()).length - e1
    r.openAfterScroll = await js('!!document.querySelector(".overflow-menu")')
    if (r.scrollEffects) fail(c, 'scroll_effects', r)
    report.cases[c] = r
  }

  // Run contract (inline disclosure): full values readable, Confirm reachable, nothing run.
  {
    const c = 'run-contract-token'
    await load('name=short&count=1&contract=1&target=0')
    await clickEl(c, `document.querySelector('.ws-row-name')`, 'row')
    await sleep(300)
    await clickEl(c, `__geo.byText('.ws-detail-actions button', 'Run')`, 'Run')
    await sleep(300)
    const r = await js(`(() => { const card = __geo.card(); const p = document.querySelector('.run-contract'); if (!p) return null;
      const content = document.querySelector('.workspace-content').getBoundingClientRect();
      const dds = [...p.querySelectorAll('dd')];
      return { panel: __geo.rect(p), hOverflow: Math.max(0, p.scrollWidth - p.clientWidth), spill: __geo.spill(p, Math.min(content.right, __geo.rect(p).right)),
        fullInputs: dds.some((d) => d.textContent.includes('synthetic-input-' + 'x'.repeat(200))), fullDest: dds.some((d) => d.textContent.includes('https://example.invalid/' + 'y'.repeat(200))),
        confirm: __geo.hit(__geo.byText('.run-contract-actions button', 'Confirm')).ok, cancel: __geo.hit(__geo.byText('.run-contract-actions button', 'Cancel')).ok } })()`)
    if (!r) fail(c, 'contract_missing', {})
    else {
      if (r.hOverflow > 1 || r.spill.spilled) fail(c, 'contract_text_clipped', { hOverflow: r.hOverflow, spilled: r.spill.spilled, maxRight: Math.round(r.spill.maxRight) })
      if (!r.fullInputs || !r.fullDest) fail(c, 'contract_value_missing', {})
      if (!r.confirm || !r.cancel) fail(c, 'contract_action_unhittable', r)
    }
    await shot(c)
    r && (r.effects = await effects())
    if (r && r.effects.some((e) => e[0] === 'runWorkflow')) fail(c, 'run_without_confirm', {})
    report.cases[c] = r
  }

  // Upload review: long provider/model/purpose/categories fully readable; nothing approved.
  {
    const c = 'upload-review-token'
    await load('name=short&count=0&review=1')
    await clickEl(c, `document.querySelector('.saved-recordings .ws-row, .saved-recordings button, .ws-row')`, 'recording')
    await sleep(500)
    const r = await js(`(() => { const v = document.querySelector('.upload-review'); if (!v) return null;
      const content = document.querySelector('.workspace-content').getBoundingClientRect();
      const approve = __geo.byText('.upload-review button', 'Approve and send');
      return { hOverflow: Math.max(0, v.scrollWidth - v.clientWidth), spill: __geo.spill(v, content.right), approve: approve ? __geo.hit(approve).ok : null,
        fullModel: v.textContent.includes('synthetic-model-' + 'm'.repeat(200)) } })()`)
    if (!r) fail(c, 'review_missing', {})
    else if (r.spill.spilled) fail(c, 'review_text_clipped', { spilled: r.spill.spilled, maxRight: Math.round(r.spill.maxRight) })
    if (r) {
      // The review scrolls vertically; its approval control must be reachable there.
      r.approveAfterScroll = await js(`(() => { const b = __geo.byText('.upload-review button', 'Approve and send'); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); return __geo.hit(b).ok })()`)
      if (!r.approveAfterScroll) fail(c, 'review_action_unreachable', { approveAfterScroll: r.approveAfterScroll })
      await shot(c + '-end')
    }
    await shot(c)
    if (r) r.effects = await effects()
    if (r && r.effects.some((e) => e[0] === 'telemetryApproveInterpretation')) fail(c, 'approved_without_click', {})
    report.cases[c] = r
  }

  // 20 open/close/scroll/navigate cycles: no accumulating listeners, observers or effects.
  {
    const c = 'cycles-20'
    await load('name=token&count=25&target=0')
    const base = await js('JSON.stringify(__hf4.live)')
    const e0 = (await effects()).length
    for (let i = 0; i < 20; i++) {
      await clickEl(c, homeMore(0), 'row More')
      await js(`document.querySelector('.ws-home-body').scrollTop += 10`)
      await sleep(60)
      if (await js('!!document.querySelector(".overflow-menu")')) await key('Escape')
      await clickEl(c, homeMore(0), 'row More')
      await clickEl(c, menuItem('Delete…'), 'Delete…', { domFallback: true })
      await key('Escape')
      await clickEl(c, `document.querySelector('.ws-row-name')`, 'row')
      await clickEl(c, `document.querySelector('.back-btn')`, 'Back', { domFallback: true })
    }
    await sleep(300)
    const end = await js('JSON.stringify(__hf4.live)')
    // Compare live (non-zero) counts only: a type whose listeners all went away reads 0.
    const nonzero = (o) => JSON.stringify({ observers: o.observers, listeners: Object.fromEntries(Object.entries(o.listeners).filter(([, n]) => n).sort()) })
    const r = { base: JSON.parse(base), end: JSON.parse(end), effects: (await effects()).length - e0 }
    if (nonzero(r.base) !== nonzero(r.end)) fail(c, 'owned_work_accumulated', r)
    if (r.effects) fail(c, 'cycle_effects', r)
    report.cycles = r
  }

  win.destroy()
  await sleep(200)
  report.teardown = { windows: BrowserWindow.getAllWindows().length }
  report.failures = failures
  report.failureCounts = failures.reduce((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {})
  fs.writeFileSync(path.join(fxReal, 'report.json'), JSON.stringify(report, null, 2))
  console.log('POPUPS-REPORT ' + JSON.stringify({ identity: report.identity, failureCounts: report.failureCounts, teardown: report.teardown }))
  app.exit(failures.length ? 1 : 0)
}

run().catch((err) => {
  console.error('[popups] harness error', err && err.stack ? err.stack : err)
  app.exit(3)
})
