import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M3-A — screenshot containment on the actual production composition: real initTelemetry,
 * TelemetryRecorder, providers and FileTelemetryStore. Only the Electron boundary (screen
 * pixels, clipboard, displays), the accessibility child and active-window reads are fakes,
 * and every pixel operation is counted there. All data is synthetic; the runner denies network.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  devDir: '',
  /** Pixel work observed at the Electron boundary — the privacy measure. */
  pixels: { getSources: 0, crop: 0, resize: 0, encode: 0 },
  reads: { window: 0 },
  windowSeq: 0,
  clip: { text: '', changes: 0 },
  ix: { cb: null as null | ((p: unknown) => void) },
  openaiCtor: 0
}))

vi.mock('electron', () => {
  // A synthetic display image: any read/crop/resize/encode is counted, bytes are fixed.
  const image = (w: number, h0: number): any => ({
    isEmpty: () => false,
    getSize: () => ({ width: w, height: h0 }),
    crop: (r: { width: number; height: number }) => {
      h.pixels.crop += 1
      return image(r.width, r.height)
    },
    resize: (r: { width: number; height: number }) => {
      h.pixels.resize += 1
      return image(r.width, r.height)
    },
    toJPEG: () => {
      h.pixels.encode += 1
      return Buffer.from('synthetic-jpeg')
    }
  })
  return {
    app: { isPackaged: false, getPath: () => h.devDir },
    BrowserWindow: {
      getAllWindows: () => [],
      fromWebContents: (wc: { trusted?: boolean } | undefined) => (wc?.trusted ? {} : null)
    },
    ipcMain: { handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn) },
    systemPreferences: { isTrustedAccessibilityClient: () => true },
    screen: {
      getPrimaryDisplay: () => ({
        scaleFactor: 2,
        size: { width: 1000, height: 800 },
        workAreaSize: { width: 1000, height: 780 },
        bounds: { x: 0, y: 0, width: 1000, height: 800 }
      }),
      getAllDisplays: () => [
        { id: 1, scaleFactor: 2, bounds: { x: 0, y: 0, width: 1000, height: 800 } },
        { id: 2, scaleFactor: 1, bounds: { x: 1000, y: 0, width: 1200, height: 900 } }
      ]
    },
    desktopCapturer: {
      getSources: async () => {
        h.pixels.getSources += 1
        return [{ id: 'screen:1', name: 'Synthetic display', thumbnail: image(2000, 1600) }]
      }
    },
    nativeImage: { createEmpty: () => image(0, 0) },
    clipboard: {
      readText: () => h.clip.text,
      availableFormats: () => (h.clip.text ? ['text/plain'] : [])
    },
    globalShortcut: { register: () => true, unregister: () => {} }
  }
})

/** Window geometry variants: valid, missing, out-of-range, negative, cross-display. */
const BOUNDS = [
  { x: 10, y: 10, width: 600, height: 400 },
  undefined,
  { x: 5000, y: 5000, width: 600, height: 400 },
  { x: -200, y: -50, width: 600, height: 400 },
  { x: 900, y: 0, width: 600, height: 400 }
]
vi.mock('active-win', () => ({
  default: async () => {
    h.reads.window += 1
    const n = h.windowSeq++
    return {
      title: `Synthetic window ${n}`,
      // Alternate apps so the recorder sees app changes (the app_changed shot trigger).
      owner: { name: n % 2 ? 'SyntheticAppB' : 'SyntheticAppA', processId: 4242 + (n % 2) },
      bounds: BOUNDS[n % BOUNDS.length]
    }
  }
}))

vi.mock('openai', () => {
  class OpenAI {
    constructor() {
      h.openaiCtor += 1
    }
  }
  return { default: OpenAI, OpenAI, toFile: async () => ({}) }
})
vi.mock('../store', () => ({ getSnapshot: () => ({ session: null }) }))
vi.mock('./config', () => ({
  loadTelemetryConfig: () => ({
    storage: 'file',
    devDir: h.devDir,
    openaiApiKey: null,
    openaiModel: 'test-model',
    isDev: true,
    isPackaged: false
  })
}))
/** Synthetic accessibility child: the test drives its callback. */
vi.mock('./ax/JxaAccessibilityProvider', () => ({
  JxaAccessibilityProvider: class {
    readonly enabled = true
    readonly capturesKeys = true
    start(cb: (p: unknown) => void) {
      h.ix.cb = cb
    }
    async stop() {
      h.ix.cb = null
    }
  }
}))

class FakeOwner extends EventEmitter {
  readonly trusted = true
  sent: Array<{ channel: string; payload: unknown }> = []
  send(channel: string, payload: unknown) {
    this.sent.push({ channel, payload })
  }
  isDestroyed() {
    return false
  }
}

type Mod = typeof import('./index')
let mod: Mod

function call(sender: unknown, channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return Promise.resolve(fn({ sender }, ...args))
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function events(sessionId: string): Array<{ type: string; data?: Record<string, unknown> }> {
  const p = join(h.devDir, 'sessions', sessionId, 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event)
}
function meta(sessionId: string): any {
  return JSON.parse(readFileSync(join(h.devDir, 'sessions', sessionId, 'meta.json'), 'utf8'))
}
/** Image files anywhere under the store, with total bytes. */
function imageFiles(dir: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!existsSync(dir)) return { count, bytes }
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      const sub = imageFiles(p)
      count += sub.count
      bytes += sub.bytes
    } else if (/\.(jpe?g|png)$/i.test(name)) {
      count += 1
      bytes += st.size
    }
  }
  return { count, bytes }
}

/** Synthetic workload that hits every former screenshot trigger. */
async function workload(owner: FakeOwner, opts: { pause: boolean }): Promise<{ sessionId: string; stopMs: number }> {
  const res = await call(owner, 'telemetry:sessionStart', { narrate: false })
  expect(res.ok).toBe(true)
  const sessionId = res.status.sessionId as string
  await vi.waitFor(() => expect(h.ix.cb).not.toBeNull())
  const click = (i: number, elementBounds?: unknown) =>
    h.ix.cb?.({
      type: 'click',
      data: { appName: 'SyntheticAppA', elementLabel: `Synthetic button ${i}`, elementRole: 'AXButton', clickX: 50 + i, clickY: 60, ...(elementBounds ? { elementBounds } : {}) }
    })
  for (let round = 0; round < 3; round++) {
    // Clicks with each crop geometry variant (target crops), plus pre/post action triggers.
    BOUNDS.forEach((b, i) => click(round * 10 + i, b))
    h.clip.text = `synthetic clipboard ${h.clip.changes++}`
    // M3-B: the clipboard is read only after an observed in-scope copy chord.
    h.ix.cb?.({ type: 'keyboard_shortcut', data: { appName: 'SyntheticAppA', shortcut: 'Cmd+C' } })
    await sleep(1300) // window polls (app changes), clipboard ticks, settle timers
  }
  if (opts.pause) {
    expect((await call(owner, 'telemetry:sessionPause', { sessionId })).ok).toBe(true)
    await sleep(300)
    expect((await call(owner, 'telemetry:sessionResume', { sessionId })).ok).toBe(true)
    click(99, BOUNDS[0])
    await sleep(1700)
  }
  const t0 = Date.now()
  const stop = await call(owner, 'telemetry:sessionStop', { sessionId })
  const stopMs = Date.now() - t0
  expect(stop.ok).toBe(true)
  return { sessionId, stopMs }
}

beforeEach(async () => {
  vi.resetModules()
  h.handlers.clear()
  h.devDir = mkdtempSync(join(tmpdir(), 'gray-m3a-containment-'))
  Object.assign(h.pixels, { getSources: 0, crop: 0, resize: 0, encode: 0 })
  h.reads.window = 0
  h.windowSeq = 0
  Object.assign(h.clip, { text: '', changes: 0 })
  h.ix.cb = null
  h.openaiCtor = 0
  mod = await import('./index')
  await mod.initTelemetry()
  mod.registerTelemetryIpc()
})

describe('M3-A screenshot containment (actual production composition)', () => {
  it('production recording never reads screen pixels', async () => {
    const owner = new FakeOwner()
    const first = await workload(owner, { pause: true })
    const second = await workload(owner, { pause: false })

    const all = [...events(first.sessionId), ...events(second.sessionId)]
    const count = (t: string) => all.filter((e) => e.type === t).length
    const measured = {
      pixels: { ...h.pixels },
      images: imageFiles(h.devDir),
      keyframeEvents: count('keyframe_captured'),
      imageRefs: all.filter((e) => e.data && ['keyframePath', 'preShotPath', 'postShotPath', 'targetCropPath'].some((k) => k in e.data!)).length,
      workload: { events: all.length, appSwitch: count('app_switch'), click: count('click'), clipboard: count('clipboard_changed'), windowReads: h.reads.window },
      stopMs: [first.stopMs, second.stopMs],
      settleTimerOwned: !!(mod.getTelemetryRecorder() as unknown as { settleTimer: unknown }).settleTimer
    }
    console.log('M3A-MEASURE ' + JSON.stringify(measured))

    // Non-hollow workload: synthetic input reached the recorder through every trigger.
    expect(measured.workload.appSwitch).toBeGreaterThan(1)
    expect(measured.workload.click).toBeGreaterThanOrEqual(15)
    expect(measured.workload.clipboard).toBeGreaterThan(0)
    // Privacy invariant: no pixel acquisition, processing, persistence or reference.
    expect(measured.pixels).toEqual({ getSources: 0, crop: 0, resize: 0, encode: 0 })
    expect(measured.images).toEqual({ count: 0, bytes: 0 })
    expect(measured.keyframeEvents).toBe(0)
    expect(measured.imageRefs).toBe(0)
    expect(measured.settleTimerOwned).toBe(false)
    // A deliberately disabled modality is not a save failure.
    for (const id of [first.sessionId, second.sessionId]) {
      expect(meta(id).delivery.save).toMatchObject({ state: 'complete', artifacts: { saved: 0, missing: 0, failed: 0 } })
    }
    expect(h.openaiCtor).toBe(0)
  }, 30000)

  it('new sessions persist disabled screenshot availability across a restart; nothing is sent', async () => {
    const owner = new FakeOwner()
    const { sessionId } = await workload(owner, { pause: false })
    expect(meta(sessionId).screenshotCapture).toBe('disabled_privacy')

    // Recreate the application state over the same store.
    vi.resetModules()
    h.handlers.clear()
    mod = await import('./index')
    await mod.initTelemetry()
    mod.registerTelemetryIpc()
    const listed = await call(owner, 'telemetry:listRecordings', {})
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ sessionId, saveState: 'complete', reviewState: 'pending', screenshotCapture: 'disabled_privacy' })
    expect(imageFiles(h.devDir).count).toBe(0)
    expect(h.openaiCtor).toBe(0)
  }, 20000)
})
