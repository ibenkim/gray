import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M2 capture-session ownership. Real: TelemetryRecorder, TelemetryQueue, FileTelemetryStore,
 * NarrationRecorder, IPC handlers and the shared stop barrier (screenshots are disabled in
 * production, M3-A). Fake: interaction child, active-window reads, clipboard and the owning window (an EventEmitter standing
 * in for WebContents). All data is synthetic; the runner denies network.
 */

type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  devDir: '',
  /** Source reads that actually happened (the privacy measure, not downstream drops). */
  reads: { window: 0 },
  winGate: null as null | Promise<void>,
  /** Give each window read a new title so the recorder emits screen events for it. */
  varyTitle: false,
  ix: {
    live: 0,
    starts: 0,
    stops: 0,
    cb: null as null | ((p: unknown) => void),
    stale: [] as Array<(p: unknown) => void>,
    buffered: null as null | Record<string, unknown>,
    exitGate: null as null | Promise<void>,
    /** Stop rejects (child never confirmed exit) and the provider keeps it owned. */
    stopFails: false,
    pendingTeardown: false
  },
  fail: { saving: false, create: false, narration: false },
  /** Hold points: session creation (pending Start) and the final save-outcome write. */
  gate: { create: null as null | Promise<void>, finalSave: null as null | Promise<void> },
  openaiCtor: 0
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.devDir },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (wc: { trusted?: boolean } | undefined) => (wc?.trusted ? {} : null)
  },
  ipcMain: { handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn) },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  screen: {
    getPrimaryDisplay: () => ({
      scaleFactor: 1,
      size: { width: 1000, height: 800 },
      workAreaSize: { width: 1000, height: 780 }
    })
  },
  globalShortcut: { register: () => true, unregister: () => {} }
}))

vi.mock('active-win', () => ({
  default: async () => {
    h.reads.window += 1
    if (h.winGate) await h.winGate
    return {
      title: h.varyTitle ? `Fixture window ${h.reads.window}` : 'Fixture window',
      owner: { name: 'FixtureApp', processId: 4242 },
      bounds: { x: 0, y: 0, width: 800, height: 600 }
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

/** Fake interaction child: counts live processes; stop resolves when the "child" exits. */
vi.mock('./ax/JxaAccessibilityProvider', () => ({
  JxaAccessibilityProvider: class {
    readonly enabled = true
    readonly capturesKeys = true
    start(cb: (p: unknown) => void) {
      h.ix.starts += 1
      h.ix.live += 1
      h.ix.cb = cb
    }
    get teardownPending() {
      return h.ix.pendingTeardown
    }
    async stop() {
      h.ix.stops += 1
      // The provider keeps the old callback reference a late child line might still use.
      if (h.ix.cb) h.ix.stale.push(h.ix.cb)
      h.ix.cb = null
      if (h.ix.exitGate) await h.ix.exitGate
      if (h.ix.stopFails) {
        h.ix.pendingTeardown = true
        throw new Error('synthetic: sensor did not exit')
      }
      h.ix.live = Math.max(0, h.ix.live - 1)
    }
    flush() {
      if (h.ix.buffered && h.ix.cb) h.ix.cb({ type: 'text_input', data: h.ix.buffered })
      h.ix.buffered = null
    }
  }
}))

vi.mock('./clipboard', () => ({
  ClipboardWatcher: class {
    reset() {}
    readNow() {
      return null
    }
    getLatest() {
      return null
    }
  },
  inferPaste: () => ({ matched: false })
}))

/** Real FileTelemetryStore with injectable failures for the saving marker and session creation. */
vi.mock('./store', async (orig) => {
  const mod = await orig<typeof import('./store')>()
  return {
    ...mod,
    createTelemetryStore: (cfg: Parameters<typeof mod.createTelemetryStore>[0]) => {
      const s = mod.createTelemetryStore(cfg)!
      const update = s.updateDelivery.bind(s)
      s.updateDelivery = (async (id, fn, extra) => {
        let probe: { save?: { state?: string } } | undefined
        try {
          probe = fn(undefined) as typeof probe
        } catch {
          probe = undefined
        }
        if (h.fail.saving && probe?.save?.state === 'saving') throw new Error('synthetic marker failure')
        const st = probe?.save?.state
        if (h.gate.finalSave && (st === 'complete' || st === 'incomplete')) await h.gate.finalSave
        return update(id, fn, extra)
      }) as typeof s.updateDelivery
      const create = s.createSession.bind(s)
      s.createSession = (async (input) => {
        if (h.fail.create) throw new Error('synthetic create failure')
        if (h.gate.create) await h.gate.create
        return create(input)
      }) as typeof s.createSession
      if (s.saveNarration) {
        const save = s.saveNarration.bind(s)
        s.saveNarration = async (id, n) => {
          if (h.fail.narration) throw new Error('synthetic narration sink failure')
          return save(id, n)
        }
      }
      return s
    }
  }
})

/** Owning window stand-in: emits WebContents lifecycle events and records what main sent. */
class FakeOwner extends EventEmitter {
  readonly trusted = true
  sent: Array<{ channel: string; payload: unknown }> = []
  destroyed = false
  crashed = 0
  reloaded = 0
  /** When set, a stop request is answered like the renderer: release mic, then Stop. */
  onStopRequested: ((req: { sessionId: string }) => void) | null = null
  send(channel: string, payload: { sessionId: string }) {
    this.sent.push({ channel, payload })
    if (channel === 'telemetry:stopRequested') this.onStopRequested?.(payload)
  }
  isDestroyed() {
    return this.destroyed
  }
  forcefullyCrashRenderer() {
    this.crashed += 1
  }
  reload() {
    this.reloaded += 1
  }
}

type Mod = typeof import('./index')
let mod: Mod

async function boot(): Promise<Mod> {
  vi.resetModules()
  h.handlers.clear()
  h.devDir = mkdtempSync(join(tmpdir(), 'gray-m2-lifecycle-'))
  h.reads.window = 0
  h.winGate = null
  h.varyTitle = false
  Object.assign(h.ix, { live: 0, starts: 0, stops: 0, cb: null, stale: [], buffered: null, exitGate: null })
  Object.assign(h.fail, { saving: false, create: false, narration: false })
  Object.assign(h.gate, { create: null, finalSave: null })
  Object.assign(h.ix, { stopFails: false, pendingTeardown: false })
  h.openaiCtor = 0
  mod = await import('./index')
  await mod.initTelemetry()
  mod.registerTelemetryIpc()
  return mod
}

function call(sender: unknown, channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return Promise.resolve(fn({ sender }, ...args))
}

function events(sessionId: string): Array<{ type: string; data?: Record<string, unknown> }> {
  const p = join(h.devDir, 'sessions', sessionId, 'events.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).event)
}

function meta(sessionId: string): any {
  return JSON.parse(readFileSync(join(h.devDir, 'sessions', sessionId, 'meta.json'), 'utf8'))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const report = (chunks: number) => ({ chunksAcknowledged: chunks, chunksFailed: 0, timedOut: false })

async function start(owner: unknown, opts: { narrate?: boolean } = {}): Promise<string> {
  const res = await call(owner, 'telemetry:sessionStart', { narrate: !!opts.narrate })
  expect(res.ok).toBe(true)
  // Let the first window poll land so later read counts are boundary-relative.
  await vi.waitFor(() => expect(h.reads.window).toBeGreaterThan(0))
  return res.status.sessionId as string
}

const status = () => mod.getTelemetryRecorder()!.getRecordingStatus()

/** Assert no source can read after an acknowledged boundary: counts frozen, no live child. */
async function expectNoReadsAfter(ms = 1000) {
  const before = { ...h.reads }
  h.ix.cb?.({ type: 'click', data: { appName: 'FixtureApp', elementLabel: 'AfterBoundary' } })
  for (const stale of h.ix.stale) stale({ type: 'click', data: { appName: 'FixtureApp', elementLabel: 'AfterBoundary' } })
  await sleep(ms)
  expect(h.reads).toEqual(before)
  expect(h.ix.live).toBe(0)
}

beforeEach(async () => {
  await boot()
})

// Each test owns its module instance; never let its recorder keep reading into the next test.
afterEach(async () => {
  const r = mod?.getTelemetryRecorder()
  if (r) await r.stopRecording()
  vi.useRealTimers()
})

describe('start: one owner, rollback on failure', () => {
  it('a storage failure rolls the start back: no source runs and the status is idle', async () => {
    const owner = new FakeOwner()
    h.fail.create = true
    const res = await call(owner, 'telemetry:sessionStart', {})
    expect(res.ok).toBe(false)
    expect(status()).toMatchObject({ phase: 'idle', recording: false })
    expect(h.ix.starts).toBe(0)
    await expectNoReadsAfter(900)
    expect(h.reads.window).toBe(0)
  })

  it('a narration sink failure after the session exists rolls back and marks it START_FAILED', async () => {
    const owner = new FakeOwner()
    h.fail.narration = true
    const res = await call(owner, 'telemetry:sessionStart', { narrate: true })
    expect(res.ok).toBe(false)
    expect(status().phase).toBe('idle')
    expect(h.ix.starts).toBe(0)
    const sessions = (await mod.getTelemetryStore()!.listSessions({ limit: 5 }))
    expect(sessions).toHaveLength(1)
    expect(sessions[0].delivery?.save).toMatchObject({ state: 'incomplete', errorCode: 'START_FAILED' })
    expect(sessions[0].captureStatus).toBe('failed')
    expect(mod.getNarrationRecorder()!.isActive()).toBe(false)
  })

  it('concurrent starts from two windows create exactly one session with one owner', async () => {
    const a = new FakeOwner()
    const b = new FakeOwner()
    const [ra, rb] = await Promise.all([
      call(a, 'telemetry:sessionStart', {}),
      call(b, 'telemetry:sessionStart', {})
    ])
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1)
    expect(await mod.getTelemetryStore()!.listSessions({ limit: 5 })).toHaveLength(1)
    // The owner's repeat joins; the other window is refused and cannot pause it.
    const winner = ra.ok ? a : b
    const loser = ra.ok ? b : a
    expect((await call(winner, 'telemetry:sessionStart', {})).ok).toBe(true)
    expect((await call(loser, 'telemetry:sessionPause', {})).ok).toBe(false)
    expect(status().phase).toBe('recording')
  })
})

describe('pause: flush, halt, drain, then acknowledge', () => {
  it('buffered text lands before the gate closes; nothing is read or ingested while paused', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    h.ix.buffered = { appName: 'FixtureApp', elementLabel: 'Name', elementRole: 'AXTextField', typedText: 'synthetic value' }
    const paused = await call(owner, 'telemetry:sessionPause', { sessionId: id })
    expect(paused).toMatchObject({ ok: true, status: { phase: 'paused' } })
    expect(h.ix.live).toBe(0)
    await expectNoReadsAfter()

    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    expect(status().phase).toBe('recording')
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect(stopped.recording.saveState).toBe('complete')
    const evs = events(id)
    expect(evs.some((e) => e.type === 'text_input')).toBe(true)
    expect(evs.some((e) => e.data?.elementLabel === 'AfterBoundary')).toBe(false)
    const stats = mod.getTelemetryRecorder()!.getIngressStats()
    expect(stats.rejectedStale).toBeGreaterThan(0)
  })

  it('a delayed window read admitted before pause still lands; no new read starts after it', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    h.varyTitle = true
    const gate = deferred()
    h.winGate = gate.promise
    // Wait for the next poll to be in flight (admitted) behind the gate.
    const readsBefore = h.reads.window
    await vi.waitFor(() => expect(h.reads.window).toBe(readsBefore + 1), { timeout: 2000 })
    let acked = false
    const pausing = call(owner, 'telemetry:sessionPause', { sessionId: id }).then((r) => {
      acked = true
      return r
    })
    await sleep(50)
    expect(acked).toBe(false) // the admitted read is still owned by the boundary
    gate.resolve()
    h.winGate = null
    expect((await pausing).ok).toBe(true)
    expect(mod.getTelemetryRecorder()!.getIngressStats().drainedAfterBoundary).toBeGreaterThan(0)
    await expectNoReadsAfter()
  })

  it('pause is acknowledged only after the interaction child has exited', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const exit = deferred()
    h.ix.exitGate = exit.promise
    let acked = false
    const pausing = call(owner, 'telemetry:sessionPause', { sessionId: id }).then(() => (acked = true))
    await sleep(50)
    expect(acked).toBe(false)
    expect(h.ix.live).toBe(1)
    exit.resolve()
    await pausing
    expect(h.ix.live).toBe(0)
  })

  it('halts input before waiting for the narration sink to finish', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    const sink = mod.getNarrationRecorder()!
    const end = sink.end.bind(sink)
    const gate = deferred()
    const held = vi.spyOn(sink, 'end').mockImplementation(async () => {
      await gate.promise
      return end()
    })
    let acked = false
    const pausing = call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(0) })
      .then((r) => { acked = true; return r })
    try {
      await vi.waitFor(() => expect(held).toHaveBeenCalled())
      await sleep(50)
      expect(acked).toBe(false)
      expect(h.ix.live).toBe(0)
      expect((await call(owner, 'telemetry:sessionResume', { sessionId: id })).ok).toBe(false)
      let duplicateAcked = false
      void call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(0) })
        .then(() => { duplicateAcked = true })
      await expectNoReadsAfter(900)
      expect(duplicateAcked).toBe(false)
    } finally {
      gate.resolve()
      await pausing
      held.mockRestore()
    }
    expect((await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })).recording.saveState).toBe('complete')
  })

  it('double pause, pause racing Stop and resume after Stop are deterministic', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const [p1, p2] = await Promise.all([
      call(owner, 'telemetry:sessionPause', { sessionId: id }),
      call(owner, 'telemetry:sessionPause', { sessionId: id })
    ])
    expect(p1.ok && p2.ok).toBe(true)
    expect(h.ix.starts).toBe(1)
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const [paused, stopped] = await Promise.all([
      call(owner, 'telemetry:sessionPause', { sessionId: id }),
      call(owner, 'telemetry:sessionStop', { sessionId: id })
    ])
    expect(stopped.ok).toBe(true)
    // Stop dominates a concurrent Pause; its truthful response may still be saving.
    expect(paused.ok).toBe(false)
    expect(['stopping', 'idle']).toContain(paused.status.phase)
    expect((await call(owner, 'telemetry:sessionResume', { sessionId: id })).ok).toBe(false)
    expect(status().phase).toBe('idle')
    await expectNoReadsAfter(900)
    expect(events(id).filter((e) => e.type === 'session_stopped')).toHaveLength(1)
  })
})

describe('narration: owned, ended at first pause, final chunks only', () => {
  it('accepts the final chunks before pause, rejects stale ones after, and resumes without narration', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    expect(status()).toMatchObject({ phase: 'recording' })
    expect((await call(owner, 'narration:append', id, new Uint8Array(64))).ok).toBe(true)
    // The renderer stops its tracks and awaits final chunks before asking main to pause.
    expect((await call(owner, 'narration:append', id, new Uint8Array(32))).ok).toBe(true)
    const paused = await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(2) })
    expect(paused.status).toMatchObject({ phase: 'paused', narration: 'ended' })
    expect((await call(owner, 'narration:append', id, new Uint8Array(16))).ok).toBe(false)
    const resumed = await call(owner, 'telemetry:sessionResume', { sessionId: id })
    expect(resumed.status).toMatchObject({ phase: 'recording', narration: 'ended' })
    expect((await call(owner, 'narration:append', id, new Uint8Array(16))).ok).toBe(false)
    expect((await call(owner, 'narration:start', id)).ok).toBe(false)

    // Stop after the renderer already released its mic: the pause account is authoritative.
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
    expect(stopped.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
    expect(meta(id).delivery.save.audio).toMatchObject({ state: 'complete', chunks: 2, bytes: 96 })
  })

  it('rejects narration from another window, for another session, or without an approved start', async () => {
    const owner = new FakeOwner()
    const other = new FakeOwner()
    const id = await start(owner)
    // Not narrated: no microphone session can be created from narration:start alone.
    expect((await call(owner, 'narration:start', id)).ok).toBe(false)
    expect((await call(owner, 'narration:append', id, new Uint8Array(8))).ok).toBe(false)
    expect(mod.getNarrationRecorder()!.isActive()).toBe(false)
    await call(owner, 'telemetry:sessionStop', { sessionId: id })

    const id2 = await start(owner, { narrate: true })
    expect((await call(other, 'narration:append', id2, new Uint8Array(8))).ok).toBe(false)
    expect((await call(owner, 'narration:append', 'tsess_not_active_0000', new Uint8Array(8))).ok).toBe(false)
    expect((await call(other, 'narration:stop')).ok).toBe(false)
    expect(mod.getNarrationRecorder()!.isActive()).toBe(true)
    expect((await call(other, 'telemetry:sessionStop', { sessionId: id2 })).ok).toBe(false)
    expect(status().phase).toBe('recording')
  })

  it('event batches only append to the owner’s actively recording session', async () => {
    const owner = new FakeOwner()
    const other = new FakeOwner()
    const id = await start(owner)
    expect((await call(other, 'telemetry:events', { sessionId: id, events: [] })).ok).toBe(false)
    await call(owner, 'telemetry:sessionPause', { sessionId: id })
    expect((await call(owner, 'telemetry:events', { sessionId: id, events: [] })).ok).toBe(false)
    await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect((await call(owner, 'telemetry:events', { sessionId: id, events: [] })).ok).toBe(false)
  })
})

describe('narration receipt (M2-R1)', () => {
  it('renderer order — sink closed by narration:stop, then Pause with the receipt — saves complete', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    expect((await call(owner, 'narration:append', id, new Uint8Array(64))).ok).toBe(true)
    expect((await call(owner, 'narration:stop', id)).ok).toBe(true)
    expect((await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(1) })).ok).toBe(true)
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(1) })
    expect(stopped.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
    expect(meta(id).delivery.save.audio).toEqual({ state: 'complete', chunks: 1, bytes: 64 })

    // A fresh process over the same store rediscovers the same complete session.
    const devDir = h.devDir
    vi.resetModules()
    h.handlers.clear()
    h.devDir = devDir
    mod = await import('./index')
    await mod.initTelemetry()
    mod.registerTelemetryIpc()
    const listed = await call(owner, 'telemetry:listRecordings', {})
    expect(listed).toEqual([expect.objectContaining({ sessionId: id, saveState: 'complete', audio: 'complete' })])
  })

  it('the first receipt survives a second pause and Stop with zeroed counters, and a repeated Stop joins', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    await call(owner, 'narration:append', id, new Uint8Array(40))
    await call(owner, 'narration:append', id, new Uint8Array(24))
    await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(2) })
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(0) })
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const [a, b] = await Promise.all([
      call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) }),
      call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
    ])
    expect(a.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
    expect(b.recording.saveState).toBe('complete')
    expect(meta(id).delivery.save.audio).toEqual({ state: 'complete', chunks: 2, bytes: 64 })
  })

  it.each([
    ['a failed append', { chunksAcknowledged: 0, chunksFailed: 1, timedOut: false }],
    ['a drain timeout', { chunksAcknowledged: 1, chunksFailed: 0, timedOut: true }],
    ['an invalid account', { chunksAcknowledged: -1, chunksFailed: 0, timedOut: false }],
    ['a missing account', undefined]
  ])('%s stays incomplete', async (_name, audio) => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    await call(owner, 'narration:append', id, new Uint8Array(32))
    await call(owner, 'telemetry:sessionPause', { sessionId: id, audio })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio })
    expect(stopped.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'AUDIO_INCOMPLETE' })
  })

  it('narration:stop is session-scoped: unscoped, wrong session or another window cannot close the sink', async () => {
    const owner = new FakeOwner()
    const other = new FakeOwner()
    const id = await start(owner, { narrate: true })
    expect((await call(owner, 'narration:stop')).ok).toBe(false)
    expect((await call(owner, 'narration:stop', 'tsess_other_session_000')).ok).toBe(false)
    expect((await call(other, 'narration:stop', id)).ok).toBe(false)
    expect(mod.getNarrationRecorder()!.isActive()).toBe(true)
    expect((await call(owner, 'narration:append', id, new Uint8Array(8))).ok).toBe(true)
    // Idempotent for its own session; a second close keeps the same end result.
    const first = await call(owner, 'narration:stop', id)
    const again = await call(owner, 'narration:stop', id)
    expect(first).toMatchObject({ ok: true, chunks: 1, bytes: 8 })
    expect(again).toMatchObject({ ok: true, chunks: 1, bytes: 8 })
    expect((await call(owner, 'narration:append', id, new Uint8Array(8))).ok).toBe(false)
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(1) })
    expect(stopped.recording.audio).toBe('complete')
  })

  it('a non-narrated session with no audio account saves complete with no audio', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    await call(owner, 'telemetry:sessionPause', { sessionId: id })
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect(stopped.recording).toMatchObject({ saveState: 'complete', audio: 'none' })
  })
})

describe('narration failure receipts (M2-R1 correction)', () => {
  const failed = (o: Partial<{ chunksAcknowledged: number; chunksFailed: number; timedOut: boolean; recorderFailed: unknown }>) => ({
    chunksAcknowledged: 0,
    chunksFailed: 0,
    timedOut: false,
    recorderFailed: false,
    ...o
  })

  it.each([
    ['a zero-chunk stop timeout', 0, failed({ timedOut: true })],
    ['a recorder failure before any chunk', 0, failed({ recorderFailed: true })],
    ['a recorder failure after one 64-byte chunk', 64, failed({ chunksAcknowledged: 1, recorderFailed: true })],
    ['a malformed failure field', 64, failed({ chunksAcknowledged: 1, recorderFailed: 'no' })]
  ])('%s is incomplete — evaluated before the no-audio shortcut', async (_n, bytes, audio) => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    if (bytes) await call(owner, 'narration:append', id, new Uint8Array(bytes))
    await call(owner, 'telemetry:sessionPause', { sessionId: id, audio })
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio })
    expect(stopped.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'AUDIO_INCOMPLETE', audio: 'incomplete' })
    // Partial audio is retained (counts/bytes recorded), never deleted.
    expect(meta(id).delivery.save.audio).toMatchObject({ state: 'incomplete', bytes })
  })

  it('a legacy receipt without the failure field still decodes and verifies', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    await call(owner, 'narration:append', id, new Uint8Array(64))
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(1) })
    expect(stopped.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
  })

  it.each([
    ['failed at pause, clean at Stop', failed({ chunksAcknowledged: 1, recorderFailed: true }), failed({ chunksAcknowledged: 1 })],
    ['clean at pause, failed at Stop', failed({ chunksAcknowledged: 1 }), failed({ chunksAcknowledged: 1, recorderFailed: true })]
  ])('failure is sticky across joined receipts (%s)', async (_n, atPause, atStop) => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    await call(owner, 'narration:append', id, new Uint8Array(64))
    await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: atPause })
    await call(owner, 'telemetry:sessionResume', { sessionId: id })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: atStop })
    expect(stopped.recording.saveState).toBe('incomplete')
  })

  it('an incomplete narrated save is rediscovered by a fresh process and refused for review', async () => {
    const owner = new FakeOwner()
    const id = await start(owner, { narrate: true })
    await call(owner, 'narration:append', id, new Uint8Array(64))
    const audio = failed({ chunksAcknowledged: 1, recorderFailed: true })
    await call(owner, 'telemetry:sessionStop', { sessionId: id, audio })
    // A repeated finalization with a clean account answers with the saved state, unchanged.
    const again = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(1) })
    expect(again.recording.saveState).toBe('incomplete')

    const devDir = h.devDir
    vi.resetModules()
    h.handlers.clear()
    h.devDir = devDir
    mod = await import('./index')
    await mod.initTelemetry()
    mod.registerTelemetryIpc()
    const listed = await call(owner, 'telemetry:listRecordings', {})
    expect(listed).toEqual([
      expect.objectContaining({ sessionId: id, saveState: 'incomplete', saveErrorCode: 'AUDIO_INCOMPLETE', audio: 'incomplete' })
    ])
    const review = await call(owner, 'telemetry:prepareReview', id)
    expect(review.ok).toBe(false)
    expect(review.recording.saveState).toBe('incomplete')
    expect(h.openaiCtor).toBe(0)
  })
})

describe('Stop: halts before any status I/O', () => {
  it('a failing saving-marker write still halts every source and writes a truthful outcome', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    h.fail.saving = true
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect(status()).toMatchObject({ phase: 'idle', recording: false })
    await expectNoReadsAfter()
    // Every event persisted, so the completeness checks allow complete; never fabricated.
    expect(stopped.ok).toBe(true)
    expect(meta(id).delivery.save.state).toBe('complete')
    expect(events(id).some((e) => e.type === 'session_stopped')).toBe(true)
  })

  it('Stop during a delayed child exit waits for it; the outcome is never reported early', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const exit = deferred()
    h.ix.exitGate = exit.promise
    let done = false
    const stopping = call(owner, 'telemetry:sessionStop', { sessionId: id }).then((r) => {
      done = true
      return r
    })
    await sleep(50)
    expect(done).toBe(false)
    expect(status().phase).toBe('stopping')
    exit.resolve()
    expect((await stopping).ok).toBe(true)
    expect(h.ix.live).toBe(0)
  })
})

describe('shared stop barrier: hide, logout, owner loss, revocation, quit', () => {
  it.each(['hide', 'logout', 'permission_revoked', 'quit'] as const)(
    '%s asks the owner to release its mic and Stop; the barrier waits for that save',
    async (reason) => {
      const owner = new FakeOwner()
      const id = await start(owner, { narrate: true })
      owner.onStopRequested = (req) => {
        expect(req.sessionId).toBe(id)
        // The renderer stops tracks, then Stops with its chunk account (zero chunks here).
        void call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
      }
      await mod.stopActiveRecording(reason)
      expect(status().phase).toBe('idle')
      expect(owner.sent.map((s) => s.channel)).toContain('telemetry:stopRequested')
      expect(owner.crashed).toBe(0)
      expect(meta(id).delivery.save).toMatchObject({ state: 'complete', stopReason: reason })
      await expectNoReadsAfter(900)
    }
  )

  it('an unresponsive owner with a possible open microphone is failed closed; save is incomplete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], shouldAdvanceTime: true })
    try {
      const owner = new FakeOwner()
      const id = await start(owner, { narrate: true })
      const barrier = mod.stopActiveRecording('hide')
      await vi.advanceTimersByTimeAsync(7500)
      await barrier
      expect(owner.crashed).toBe(1)
      expect(owner.reloaded).toBe(1)
      expect(status().phase).toBe('idle')
      expect(meta(id).delivery.save).toMatchObject({
        state: 'incomplete',
        errorCode: 'AUDIO_INCOMPLETE',
        stopReason: 'hide'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['destroyed', 'render-process-gone'])('owner %s stops and saves without waiting on it', async (ev) => {
    const owner = new FakeOwner()
    const id = await start(owner)
    owner.destroyed = ev === 'destroyed'
    owner.emit(ev)
    await vi.waitFor(() => expect(status().phase).toBe('idle'))
    await vi.waitFor(() => expect(meta(id).delivery.save.stopReason).toBe('owner_lost'))
    expect(owner.sent).toHaveLength(0)
    await expectNoReadsAfter(900)
  })

  it('an owner reload (main-frame navigation) is owner loss; in-page navigation is not', async () => {
    const owner = new FakeOwner()
    await start(owner)
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    await sleep(50)
    expect(status().phase).toBe('recording')
    owner.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await vi.waitFor(() => expect(status().phase).toBe('idle'))
  })

  it('ordinary focus loss keeps a visible authorized recording running', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    owner.emit('blur')
    owner.emit('focus')
    owner.emit('blur')
    const before = h.reads.window
    await sleep(1800)
    expect(status().phase).toBe('recording')
    expect(h.reads.window).toBeGreaterThan(before)
    await call(owner, 'telemetry:sessionStop', { sessionId: id })
  })

  it('quit while the saving marker fails still halts capture and leaves a truthful record', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    owner.onStopRequested = () => void call(owner, 'telemetry:sessionStop', { sessionId: id })
    h.fail.saving = true
    await mod.flushTelemetryOnQuit()
    expect(mod.hasActiveRecording()).toBe(false)
    await expectNoReadsAfter(900)
    expect(meta(id).delivery.save).toMatchObject({ state: 'complete', stopReason: 'quit' })
  })

  it('an idle barrier is a no-op and never contacts the owner', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    await call(owner, 'telemetry:sessionStop', { sessionId: id })
    owner.sent.length = 0
    await mod.stopActiveRecording('hide')
    expect(owner.sent).toHaveLength(0)
  })
})

describe('M2-R2: ownership from pending Start through durable save', () => {
  const sessionsOnDisk = async () => (await mod.getTelemetryStore()!.listSessions({ limit: 20 })).length

  it.each(['owner destroyed', 'owner crashed'] as const)(
    '%s while Start waits on storage: the start is cancelled and no source ever starts',
    async (how) => {
      const owner = new FakeOwner()
      const gate = deferred()
      h.gate.create = gate.promise
      const starting = call(owner, 'telemetry:sessionStart', {})
      await sleep(30)
      expect(mod.hasActiveRecording()).toBe(true)
      if (how === 'owner destroyed') owner.destroyed = true
      owner.emit(how === 'owner destroyed' ? 'destroyed' : 'render-process-gone')
      gate.resolve()
      expect((await starting).ok).toBe(false)
      expect(h.ix.starts).toBe(0)
      await expectNoReadsAfter(900)
      expect(h.reads.window).toBe(0)
      const [session] = await mod.getTelemetryStore()!.listSessions({ limit: 5 })
      expect(session.delivery?.save).toMatchObject({ state: 'incomplete', errorCode: 'START_FAILED' })
      expect(mod.hasActiveRecording()).toBe(false)
    }
  )

  it.each(['hide', 'logout', 'permission_revoked', 'quit'] as const)(
    '%s during a pending Start cancels it, joins it, and nothing starts',
    async (reason) => {
      const owner = new FakeOwner()
      const gate = deferred()
      h.gate.create = gate.promise
      const starting = call(owner, 'telemetry:sessionStart', { narrate: true })
      await sleep(30)
      let barrierDone = false
      const barrier = mod.stopActiveRecording(reason).then(() => (barrierDone = true))
      await sleep(30)
      expect(barrierDone).toBe(false) // waits for the start to settle
      gate.resolve()
      await barrier
      expect((await starting).ok).toBe(false)
      expect(h.ix.starts).toBe(0)
      expect(mod.getNarrationRecorder()!.isActive()).toBe(false)
      expect(await sessionsOnDisk()).toBe(1)
      await expectNoReadsAfter(900)
    }
  )

  it('Resume during a reserved main Stop is refused before the renderer replies; the reply completes it (no deadlock)', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    await call(owner, 'telemetry:sessionPause', { sessionId: id })
    let request: { sessionId: string } | null = null
    owner.onStopRequested = (req) => (request = req)
    const barrier = mod.stopActiveRecording('hide')
    await sleep(30)
    expect(request).not.toBeNull()
    const startsBefore = h.ix.starts
    expect((await call(owner, 'telemetry:sessionResume', { sessionId: id })).ok).toBe(false)
    expect((await call(owner, 'telemetry:sessionPause', { sessionId: id })).ok).toBe(false)
    expect((await call(owner, 'telemetry:events', { sessionId: id, events: [] })).ok).toBe(false)
    expect((await call(new FakeOwner(), 'telemetry:sessionStart', {})).ok).toBe(false)
    expect(h.ix.starts).toBe(startsBefore)
    // The renderer's own Stop delivers its receipt into the reserved operation.
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
    await barrier
    expect(stopped.ok).toBe(true)
    expect(meta(id).delivery.save).toMatchObject({ state: 'complete', stopReason: 'hide' })
    await expectNoReadsAfter(900)
  })

  it('quit during the final save write waits for it even though the recorder is already idle', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const gate = deferred()
    h.gate.finalSave = gate.promise
    const stopping = call(owner, 'telemetry:sessionStop', { sessionId: id })
    await vi.waitFor(() => expect(status().phase).toBe('idle'))
    expect(mod.hasActiveRecording()).toBe(true) // the durable outcome is still pending
    let quitDone = false
    const quitting = mod.flushTelemetryOnQuit().then(() => (quitDone = true))
    const hiding = mod.stopActiveRecording('hide')
    await sleep(50)
    expect(quitDone).toBe(false)
    expect((await call(owner, 'telemetry:sessionStart', {})).ok).toBe(false)
    gate.resolve()
    const [result] = await Promise.all([stopping, quitting, hiding])
    expect(result.ok).toBe(true)
    expect(quitDone).toBe(true)
    expect(meta(id).delivery.save.state).toBe('complete')
    expect(await sessionsOnDisk()).toBe(1)
    expect(mod.hasActiveRecording()).toBe(false)
  })

  it('every stop reason and duplicate Stop join one durable outcome', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    owner.onStopRequested = () => void call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
    await Promise.all([
      mod.stopActiveRecording('quit'),
      mod.stopActiveRecording('hide'),
      mod.stopActiveRecording('logout'),
      call(owner, 'telemetry:sessionStop', { sessionId: id })
    ])
    expect(events(id).filter((e) => e.type === 'session_stopped')).toHaveLength(1)
    expect(meta(id).delivery.save.state).toBe('complete')
    expect(owner.sent.filter((m) => m.channel === 'telemetry:stopRequested')).toHaveLength(1)
  })

  it('a source that never confirms exit: no clean pause, incomplete save, capture blocked until it exits', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    h.ix.stopFails = true
    const paused = await call(owner, 'telemetry:sessionPause', { sessionId: id })
    expect(paused.ok).toBe(false)
    expect(paused.status.teardownFailed).toBe(true)
    expect((await call(owner, 'telemetry:sessionResume', { sessionId: id })).ok).toBe(false)
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect(stopped.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'SOURCE_TEARDOWN_FAILED' })
    // Other sources still halted (reads frozen); the unconfirmed child is still counted live
    // and no replacement child starts.
    const reads = { ...h.reads }
    await sleep(900)
    expect(h.reads).toEqual(reads)
    expect(h.ix.live).toBe(1)
    const startsBefore = h.ix.starts
    expect((await call(owner, 'telemetry:sessionStart', {})).ok).toBe(false)
    expect(h.ix.starts).toBe(startsBefore)
    expect(await mod.getTelemetryStore()!.listSessions({ limit: 5 })).toHaveLength(1)
    // Once the child is observed to exit, recording is available again.
    h.ix.stopFails = false
    h.ix.pendingTeardown = false
    h.ix.live = 0
    const next = await start(owner)
    expect(next).not.toBe(id)
    await call(owner, 'telemetry:sessionStop', { sessionId: next })
  })

  it('a stale receipt or event batch from a stopped session cannot affect the next one', async () => {
    const owner = new FakeOwner()
    const first = await start(owner, { narrate: true })
    await call(owner, 'telemetry:sessionStop', { sessionId: first, audio: report(0) })
    const second = await start(owner, { narrate: true })
    await call(owner, 'narration:append', second, new Uint8Array(64))
    const stale = await call(owner, 'telemetry:sessionStop', {
      sessionId: first,
      audio: { chunksAcknowledged: 0, chunksFailed: 5, timedOut: true, recorderFailed: true }
    })
    expect(stale.recording.sessionId).toBe(first)
    expect((await call(owner, 'telemetry:events', { sessionId: first, events: [] })).ok).toBe(false)
    expect(status()).toMatchObject({ phase: 'recording', sessionId: second })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: second, audio: report(1) })
    expect(stopped.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
  })

  it.each(['throw', 'reject'] as const)('an admitted renderer append that fails (%s) never saves complete', async (failure) => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const store = mod.getTelemetryStore()!
    const append = store.appendEvents.bind(store)
    const gate = deferred()
    const entered = deferred()
    const injected = vi.spyOn(store, 'appendEvents').mockImplementation(async (sid, batch) => {
      if (batch.some((e) => e.eventId === 'evt_synthetic_ipc_0001')) {
        entered.resolve()
        await gate.promise
        if (failure === 'throw') throw new Error('synthetic append failure')
        return { accepted: 0, duplicates: 0, rejected: 1, filtered: 0 }
      }
      return append(sid, batch)
    })
    const appending = call(owner, 'telemetry:events', {
      sessionId: id,
      events: [{ schemaVersion: meta(id).schemaVersion, eventId: 'evt_synthetic_ipc_0001',
        sessionId: id, sequence: 1000, timestamp: '2026-01-01T00:00:00.000Z', elapsedMs: 1000, type: 'click' }]
    })
    await entered.promise
    let saved = false
    const stopping = call(owner, 'telemetry:sessionStop', { sessionId: id }).then((r) => { saved = true; return r })
    try {
      await sleep(50)
      expect(saved).toBe(false)
      expect(mod.hasActiveRecording()).toBe(true)
    } finally {
      gate.resolve()
    }
    expect((await appending).ok).toBe(failure !== 'throw')
    const stopped = await stopping
    injected.mockRestore()
    expect(stopped.recording.saveState).toBe('incomplete')
    expect(meta(id).delivery.save.errorCode).toBe(failure === 'throw' ? 'EVENTS_DROPPED' : 'EVENTS_REJECTED')
    expect((await call(owner, 'telemetry:prepareReview', id)).ok).toBe(false)
    expect((await call(owner, 'telemetry:retrySave', id)).ok).toBe(false)
    const again = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    expect(again.recording.saveState).toBe('incomplete')
    // Relaunch reads the same truthful state; no retained event content or approval is invented.
    vi.resetModules()
    h.handlers.clear()
    mod = await import('./index')
    await mod.initTelemetry()
    mod.registerTelemetryIpc()
    expect(await call(owner, 'telemetry:listRecordings', {})).toEqual([
      expect.objectContaining({ sessionId: id, saveState: 'incomplete' })
    ])
    expect((await call(owner, 'telemetry:prepareReview', id)).ok).toBe(false)
  })

  it('a manifest retry preserves renderer loss separately from the queue drain', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    // The real store rejects this invalid synthetic event; the queue itself has no loss.
    await call(owner, 'telemetry:events', { sessionId: id, events: [{ eventId: 'invalid_synthetic' }] })
    const store = mod.getTelemetryStore()!
    const update = store.updateDelivery.bind(store)
    const failed = vi.spyOn(store, 'updateDelivery').mockImplementation(async (sid, fn, extra) => {
      const prior = (await store.getSessionMeta(sid))!.delivery ?? null
      if (fn(prior).save.state === 'incomplete') throw new Error('synthetic manifest write failure')
      return update(sid, fn, extra)
    })
    const stopped = await call(owner, 'telemetry:sessionStop', { sessionId: id })
    failed.mockRestore()
    expect(stopped.errorCode).toBe('MANIFEST_WRITE_FAILED')
    const retried = await call(owner, 'telemetry:retrySave', id)
    expect(retried.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'EVENTS_REJECTED' })
    expect(meta(id).delivery.save.rejectedEvents).toBe(1)
    expect((await call(owner, 'telemetry:prepareReview', id)).ok).toBe(false)
  })

  it('coordinated deadline: a slow owner receipt inside the renderer bound is honored; past it, audio is incomplete', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], shouldAdvanceTime: true })
    try {
      const owner = new FakeOwner()
      const id = await start(owner, { narrate: true })
      await call(owner, 'narration:append', id, new Uint8Array(64))
      // Renderer worst case: 1.5 s recorder stop + 5 s chunk drain, then its Stop.
      owner.onStopRequested = () => {
        setTimeout(() => void call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(1) }), 6600)
      }
      const barrier = mod.stopActiveRecording('quit')
      await vi.advanceTimersByTimeAsync(6700)
      await barrier
      expect(meta(id).delivery.save).toMatchObject({ state: 'complete', audio: { state: 'complete', chunks: 1, bytes: 64 } })
      expect(owner.crashed).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('relaunch and repeated cycles', () => {
  it('an interrupted session is recovered incomplete; nothing resumes and no provider is created', async () => {
    const owner = new FakeOwner()
    const id = await start(owner)
    const devDir = h.devDir
    // Simulate a hard kill: no Stop and no save. Process death ends its sources; a fresh
    // process then recreates telemetry on the same data.
    mod.getTelemetryRecorder()!.haltSources()
    vi.resetModules()
    h.handlers.clear()
    h.devDir = devDir
    h.reads.window = 0
    Object.assign(h.ix, { live: 0, starts: 0, cb: null, stale: [] })
    mod = await import('./index')
    await mod.initTelemetry()
    mod.registerTelemetryIpc()
    expect(status().phase).toBe('idle')
    expect(h.ix.starts).toBe(0)
    expect(meta(id).delivery.save).toMatchObject({ state: 'incomplete', errorCode: 'INTERRUPTED' })
    expect(h.openaiCtor).toBe(0)
    await sleep(900)
    expect(h.reads.window).toBe(0)
  })

  it('20 start→pause→resume→stop cycles leave no live child, reads, owner or narration', async () => {
    const owner = new FakeOwner()
    for (let i = 0; i < 20; i++) {
      const res = await call(owner, 'telemetry:sessionStart', { narrate: i % 2 === 0 })
      const id = res.status.sessionId
      await call(owner, 'telemetry:sessionPause', { sessionId: id, audio: report(0) })
      await call(owner, 'telemetry:sessionResume', { sessionId: id })
      await call(owner, 'telemetry:sessionStop', { sessionId: id, audio: report(0) })
    }
    expect(h.ix.starts).toBe(h.ix.stops)
    expect(mod.hasActiveRecording()).toBe(false)
    expect(mod.getNarrationRecorder()!.isActive()).toBe(false)
    await expectNoReadsAfter()
    expect(await mod.getTelemetryStore()!.listSessions({ limit: 50 })).toHaveLength(20)
  })
})
