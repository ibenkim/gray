import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION } from '../../shared/telemetry/schema'
import type { RecordingSummary } from '../../shared/types'

/**
 * M1-HF vertical scenario. Real: TelemetryRecorder, TelemetryQueue, FileTelemetryStore,
 * NarrationRecorder, IPC handlers, review preparation/consent, request construction,
 * validation and state recreation. Fake: native input/window/screen/clipboard sources and
 * the OpenAI Responses transport. All data is synthetic; network is denied by the runner.
 */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  broadcasts: [] as Array<{ channel: string; payload: unknown; workflowFileExists?: boolean }>,
  devDir: '',
  userData: '',
  key: 'sk-test-synthetic-not-a-real-key-0000000000' as string | null,
  model: 'test-model',
  session: null as null | { email: string },
  interaction: null as null | { emit: (p: unknown) => void },
  buffered: null as null | Record<string, unknown>,
  shotGate: null as null | Promise<void>,
  log: [] as string[],
  ctor: [] as unknown[],
  bodies: [] as Array<{ input: Array<{ content: string }> }>,
  respond: [] as Array<() => Promise<unknown>>,
  polishFails: false,
  clipboardRaw: new Map<string, string>([['h1', 'RAWCLIPCANARY-do-not-send']])
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData },
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: { sessionId?: string; interpretationState?: string }) => {
            const wf = payload?.sessionId
              ? join(h.devDir, 'sessions', payload.sessionId, 'workflow.json')
              : ''
            h.broadcasts.push({ channel, payload, workflowFileExists: !!wf && existsSync(wf) })
          }
        }
      }
    ],
    fromWebContents: (wc: { trusted?: boolean } | undefined) => (wc?.trusted ? {} : null)
  },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn)
  },
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
  default: async () => ({
    title: 'Fixture window',
    owner: { name: 'FixtureApp', processId: 4242 },
    bounds: { x: 0, y: 0, width: 800, height: 600 }
  })
}))

vi.mock('openai', () => {
  class OpenAI {
    constructor(opts: unknown) {
      h.ctor.push(opts)
    }
    responses = {
      parse: (body: never) => {
        h.bodies.push(body)
        const next = h.respond.shift()
        return next ? next() : Promise.reject(new Error('no scripted response'))
      }
    }
  }
  return { default: OpenAI, OpenAI, toFile: async () => ({}) }
})

vi.mock('../store', () => ({ getSnapshot: () => ({ session: h.session }) }))

vi.mock('./config', () => ({
  loadTelemetryConfig: () => ({
    storage: 'file',
    devDir: h.devDir,
    openaiApiKey: h.key,
    openaiModel: h.model,
    isDev: true,
    isPackaged: false
  })
}))

vi.mock('./ax/JxaAccessibilityProvider', () => ({
  JxaAccessibilityProvider: class {
    readonly enabled = true
    readonly capturesKeys = true
    private cb: ((p: unknown) => void) | null = null
    constructor() {
      h.interaction = { emit: (p) => this.cb?.(p) }
    }
    start(cb: (p: unknown) => void) {
      this.cb = cb
    }
    stop() {
      this.cb = null
    }
    flush() {
      if (h.buffered) {
        this.cb?.({ type: 'text_input', data: h.buffered })
        h.buffered = null
      }
    }
  }
}))

vi.mock('./keyframes', () => ({
  SparseKeyframeProvider: class {
    readonly enabled = true
    private busy = false
    constructor(
      private readonly target: {
        saveKeyframe: (s: string, e: string, b: Buffer) => Promise<{ relativePath: string }>
      }
    ) {}
    async captureKeyframe(_id: string, opts: { sessionId?: string; eventId?: string } = {}) {
      if (this.busy || !opts.sessionId || !opts.eventId) return null
      this.busy = true
      try {
        if (h.shotGate) await h.shotGate
        // Mirrors the real provider: write errors are swallowed as "no frame".
        try {
          const saved = await this.target.saveKeyframe(
            opts.sessionId,
            opts.eventId,
            Buffer.from('synthetic-frame-bytes')
          )
          h.log.push('artifact-ack')
          return { relativePath: saved.relativePath }
        } catch {
          return null
        }
      } finally {
        this.busy = false
      }
    }
  }
}))

vi.mock('./clipboard', () => ({
  ClipboardWatcher: class {
    start() {}
    stop() {}
    getLatest() {
      return null
    }
    snapshotSessionValues() {
      return h.clipboardRaw
    }
  },
  inferPaste: () => ({ matched: false })
}))

vi.mock('./polish', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polish')>()
  return {
    ...mod,
    polishSession: async (...args: Parameters<typeof mod.polishSession>) => {
      if (h.polishFails) throw new Error('synthetic polish failure')
      return mod.polishSession(...args)
    }
  }
})

const trusted = { trusted: true }
const otherWindow = { trusted: true, id: 2 }

async function boot() {
  vi.resetModules()
  h.handlers.clear()
  const mod = await import('./index')
  await mod.initTelemetry()
  mod.registerTelemetryIpc()
  return mod
}

function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return invokeFrom(trusted, channel, ...args)
}
function invokeFrom(sender: unknown, channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`no handler ${channel}`)
  return Promise.resolve(fn({ sender }, ...args))
}

function classifyOutput() {
  return {
    title: 'Synthetic fixture task',
    goal: null,
    summary: 'Open the fixture window and submit.',
    outcome: 'completed',
    steps: [
      {
        order: 1,
        action: 'Click Submit',
        category: 'interaction',
        appName: 'FixtureApp',
        evidenceEventIds: ['e0'],
        confidence: 0.8
      }
    ],
    warnings: [],
    variables: null,
    addresses: null,
    commits: null,
    writes: null,
    inputs: null,
    authorizationScope: null,
    branches: null,
    questions: null
  }
}

function eventsFile(sessionId: string): string[] {
  return readFileSync(join(h.devDir, 'sessions', sessionId, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
}

/** Start through IPC and generate deterministic synthetic activity. */
async function recordSynthetic(opts: { narrate?: boolean } = {}): Promise<string> {
  const started = await invoke('telemetry:sessionStart', { narrate: !!opts.narrate })
  expect(started.ok).toBe(true)
  const sessionId = started.status.sessionId as string
  // Let the first window poll land (app_switch + an admitted screenshot).
  await vi.waitFor(() => expect(h.broadcasts.some((b) => b.channel === 'telemetry:event')).toBe(true))
  h.interaction!.emit({
    type: 'click',
    data: { appName: 'FixtureApp', elementLabel: 'Submit', elementRole: 'AXButton' }
  })
  h.buffered = {
    appName: 'FixtureApp',
    elementLabel: 'Name',
    elementRole: 'AXTextField',
    typedText: 'synthetic value'
  }
  if (opts.narrate) {
    expect((await invoke('narration:append', sessionId, new Uint8Array(2048))).ok).toBe(true)
  }
  return sessionId
}

const audioOk = { chunksAcknowledged: 1, chunksFailed: 0, timedOut: false }

beforeEach(() => {
  h.devDir = mkdtempSync(join(tmpdir(), 'gray-hf-flow-'))
  h.userData = mkdtempSync(join(tmpdir(), 'gray-hf-userdata-'))
  h.key = 'sk-test-synthetic-not-a-real-key-0000000000'
  h.model = 'test-model'
  h.session = null
  h.broadcasts.length = 0
  h.log.length = 0
  h.ctor.length = 0
  h.bodies.length = 0
  h.respond.length = 0
  h.shotGate = null
  h.polishFails = false
  h.buffered = null
})

describe('canonical synthetic flow: Stop → save → rediscover → review → approve → result', () => {
  it('runs end to end with honest ordering and one operation', async () => {
    let app = await boot()
    const store = app.getTelemetryStore()!
    const shotGate = deferred()
    h.shotGate = shotGate.promise
    const sessionId = await recordSynthetic({ narrate: true })

    // Hold every event append while Stop is saving.
    const appendGate = deferred()
    const realAppend = store.appendEvents.bind(store)
    vi.spyOn(store, 'appendEvents').mockImplementation(async (sid, events) => {
      await appendGate.promise
      const r = await realAppend(sid, events)
      h.log.push('append-ack')
      return r
    })

    const stopA = invoke('telemetry:sessionStop', { sessionId, audio: audioOk }).then((r) => {
      h.log.push('stop-returned')
      return r
    })
    const stopB = invoke('telemetry:sessionStop', { sessionId, audio: audioOk })
    await new Promise((r) => setTimeout(r, 30))

    const during = (await invoke('telemetry:getRecording', sessionId)).recording as RecordingSummary
    expect(during.saveState).toBe('saving')
    expect(h.log).not.toContain('stop-returned')
    expect(h.ctor).toHaveLength(0)

    shotGate.resolve()
    await new Promise((r) => setTimeout(r, 10))
    appendGate.resolve()
    const [a, b] = await Promise.all([stopA, stopB])
    expect(a).toEqual(b)
    expect(a).toMatchObject({ ok: true, sessionId, localOnly: true })
    expect(a.recording).toMatchObject({
      saveState: 'complete',
      audio: 'complete',
      reviewState: 'pending',
      interpretationState: 'not_started'
    })
    // Stop returned only after artifact and event acknowledgements.
    expect(h.log.indexOf('stop-returned')).toBeGreaterThan(h.log.lastIndexOf('append-ack'))
    expect(h.log.indexOf('stop-returned')).toBeGreaterThan(h.log.indexOf('artifact-ack'))

    const lines = eventsFile(sessionId)
    const types = lines.map((l) => JSON.parse(l).event.type)
    expect(types).toContain('session_stopped')
    expect(types).toContain('text_input') // buffered text flushed at the boundary
    expect(types).toContain('keyframe_captured')
    const ids = lines.map((l) => JSON.parse(l).event.eventId)
    expect(new Set(ids).size).toBe(ids.length)
    const meta = JSON.parse(readFileSync(join(h.devDir, 'sessions', sessionId, 'meta.json'), 'utf8'))
    expect(meta.delivery.save).toMatchObject({
      state: 'complete',
      pendingEvents: 0,
      rejectedEvents: 0,
      droppedEvents: 0,
      storedEvents: lines.length
    })
    expect(meta.delivery.save.artifacts.saved).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(h.devDir, 'narration', `${sessionId}.webm`))).toBe(true)

    // A repeated Stop after completion is idempotent: same id, no duplicate events.
    const again = await invoke('telemetry:sessionStop', { sessionId, audio: audioOk })
    expect(again.recording.saveState).toBe('complete')
    expect(eventsFile(sessionId)).toHaveLength(lines.length)

    // ── Recreate application state; discover without knowing the id ──
    app = await boot()
    const listed = (await invoke('telemetry:listRecordings')) as RecordingSummary[]
    expect(listed.map((r) => r.sessionId)).toEqual([sessionId])
    expect(listed[0].saveState).toBe('complete')

    // Review then Keep local: nothing sent, files kept, row still listed.
    const prepared = await invoke('telemetry:prepareReview', sessionId)
    expect(prepared.ok).toBe(true)
    expect(prepared.preview.exclusions.join(' ')).toMatch(/Raw clipboard/)
    expect(prepared.preview.payloadText).not.toContain('RAWCLIPCANARY')
    expect((await invoke('telemetry:cancelReview', sessionId)).recording.reviewState).toBe(
      'cancelled'
    )
    expect(h.ctor).toHaveLength(0)
    expect(h.bodies).toHaveLength(0)
    expect(eventsFile(sessionId)).toHaveLength(lines.length)
    expect((await invoke('telemetry:listRecordings')).map((r: RecordingSummary) => r.sessionId)).toEqual(
      [sessionId]
    )

    // Reopen; approve twice concurrently and from a second window → one operation.
    const reopened = await invoke('telemetry:prepareReview', sessionId)
    const approval = {
      sessionId,
      revision: reopened.preview.revision,
      digest: reopened.preview.digest
    }
    const classify = deferred<unknown>()
    const extract = deferred<unknown>()
    h.respond.push(() => classify.promise, () => extract.promise)
    const results = await Promise.all([
      invoke('telemetry:approveInterpretation', approval),
      invoke('telemetry:approveInterpretation', approval),
      invokeFrom(otherWindow, 'telemetry:approveInterpretation', approval)
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    expect(results.filter((r) => r.alreadyRunning)).toHaveLength(2)
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1))
    expect(h.ctor).toEqual([expect.objectContaining({ maxRetries: 0 })])
    const sending = (await invoke('telemetry:getRecording', sessionId)).recording
    expect(sending).toMatchObject({ interpretationState: 'sending', stage: 'classify' })
    // No extract until classify is acknowledged.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.bodies).toHaveLength(1)
    // The classify request carries exactly the previewed payload.
    expect(h.bodies[0].input[1].content).toBe(JSON.stringify(JSON.parse(reopened.preview.payloadText)))

    classify.resolve({ output_parsed: classifyOutput(), id: 'resp_c', _request_id: 'req_c' })
    await vi.waitFor(() => expect(h.bodies).toHaveLength(2))
    const extractBody = JSON.parse(h.bodies[1].input[1].content)
    expect(extractBody.telemetry).toEqual(JSON.parse(reopened.preview.payloadText))
    for (const body of h.bodies) expect(JSON.stringify(body)).not.toContain('RAWCLIPCANARY')

    extract.resolve({ output_parsed: classifyOutput(), id: 'resp_e', _request_id: 'req_e' })
    await vi.waitFor(async () => {
      const r = (await invoke('telemetry:getRecording', sessionId)).recording
      expect(r.interpretationState).toBe('complete')
    })
    const done = (await invoke('telemetry:getRecording', sessionId)).recording as RecordingSummary
    expect(done.workflowId).toBeTruthy()
    expect(done.approvedAt).toBeTruthy()
    // Completion was only announced after the validated result was durable.
    const completeBroadcast = h.broadcasts.find(
      (b) =>
        b.channel === 'telemetry:recordingChanged' &&
        (b.payload as RecordingSummary).interpretationState === 'complete'
    )
    expect(completeBroadcast?.workflowFileExists).toBe(true)
    expect(h.bodies).toHaveLength(2)
    expect(h.bodies.some((b) => JSON.stringify(b).includes('automation'))).toBe(false)

    // ── Recreate again; reopen the same result without another request ──
    app = await boot()
    const opened = await invoke('telemetry:openResult', sessionId)
    expect(opened.ok).toBe(true)
    expect(opened.workflow.id).toBe(done.workflowId)
    expect(opened.workflow.sessionId).toBe(sessionId)
    const openedAgain = await invoke('telemetry:openResult', sessionId)
    expect(openedAgain.workflow.id).toBe(done.workflowId)
    // Approving the same digest again is a no-op on a complete result.
    expect((await invoke('telemetry:approveInterpretation', approval)).ok).toBe(true)
    expect(h.bodies).toHaveLength(2)
    expect(await invoke('telemetry:listRecordings')).toHaveLength(1)
    void app
  })
})

describe('Stop safety and save failures (no request is ever made)', () => {
  it('a mismatched session id never stops the active recording', async () => {
    await boot()
    const sessionId = await recordSynthetic()
    const r = await invoke('telemetry:sessionStop', { sessionId: 'tsess_someone_else' })
    expect(r).toMatchObject({ ok: false, error: 'Unknown session' })
    expect((await invoke('telemetry:getStatus')).recording).toBe(true)
    await invoke('telemetry:sessionStop', { sessionId })
  })

  it('event write failure → incomplete, then a same-session local retry completes it', async () => {
    const app = await boot()
    const store = app.getTelemetryStore()!
    const sessionId = await recordSynthetic()
    let failing = true
    const realAppend = store.appendEvents.bind(store)
    vi.spyOn(store, 'appendEvents').mockImplementation(async (sid, events) => {
      if (failing) throw new Error('synthetic EIO')
      return realAppend(sid, events)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stop = await invoke('telemetry:sessionStop', { sessionId })
    expect(stop.recording).toMatchObject({
      saveState: 'incomplete',
      saveErrorCode: 'EVENTS_NOT_PERSISTED',
      canRetrySave: true
    })
    expect((await invoke('telemetry:prepareReview', sessionId)).errorCode).toBe('NOT_SAVED')

    failing = false
    const retried = await invoke('telemetry:retrySave', sessionId)
    expect(retried.recording).toMatchObject({ sessionId, saveState: 'complete' })
    const ids = eventsFile(sessionId).map((l) => JSON.parse(l).event.eventId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(h.ctor).toHaveLength(0)
  })

  it('artifact write failure → incomplete ARTIFACT_FAILED; not reviewable', async () => {
    const app = await boot()
    vi.spyOn(app.getTelemetryStore()!, 'saveKeyframe').mockRejectedValue(new Error('synthetic ENOSPC'))
    const sessionId = await recordSynthetic()
    const stop = await invoke('telemetry:sessionStop', { sessionId })
    expect(stop.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'ARTIFACT_FAILED' })
    expect(stop.recording.canRetrySave).toBe(false)
    expect((await invoke('telemetry:prepareReview', sessionId)).ok).toBe(false)
    expect(h.ctor).toHaveLength(0)
  })

  it('audio chunk failure → incomplete AUDIO_INCOMPLETE', async () => {
    await boot()
    const sessionId = await recordSynthetic({ narrate: true })
    const stop = await invoke('telemetry:sessionStop', {
      sessionId,
      audio: { chunksAcknowledged: 1, chunksFailed: 1, timedOut: false }
    })
    expect(stop.recording).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'AUDIO_INCOMPLETE' })
  })

  it('completion-marker write failure → MANIFEST_WRITE_FAILED with a local retry', async () => {
    const app = await boot()
    const store = app.getTelemetryStore()!
    const sessionId = await recordSynthetic()
    const realUpdate = store.updateDelivery.bind(store)
    let calls = 0
    vi.spyOn(store, 'updateDelivery').mockImplementation(async (...args) => {
      calls += 1
      if (calls === 2) throw new Error('synthetic EIO on marker')
      return realUpdate(...args)
    })
    const stop = await invoke('telemetry:sessionStop', { sessionId })
    expect(stop).toMatchObject({ ok: false, errorCode: 'MANIFEST_WRITE_FAILED' })
    expect(stop.recording).toMatchObject({ saveState: 'incomplete', canRetrySave: true })
    const retried = await invoke('telemetry:retrySave', sessionId)
    expect(retried.recording.saveState).toBe('complete')
  })

  it('polish failure → saved, review unavailable with a reason, nothing sent', async () => {
    await boot()
    const sessionId = await recordSynthetic()
    h.polishFails = true
    const stop = await invoke('telemetry:sessionStop', { sessionId })
    expect(stop.recording).toMatchObject({
      saveState: 'complete',
      reviewState: 'unavailable',
      reviewErrorCode: 'POLISH_FAILED'
    })
    expect(stop.recording.reviewMessage).toMatch(/saved/)
    expect(h.ctor).toHaveLength(0)
  })

  it('an unfinished save found on relaunch becomes incomplete INTERRUPTED', async () => {
    const app = await boot()
    const store = app.getTelemetryStore()!
    const sessionId = await recordSynthetic()
    // Simulate a crash mid-Stop: delivery says saving, no completion marker.
    await store.updateDelivery(sessionId, (d) => ({ ...d!, save: { state: 'saving' } }))
    await boot()
    const r = (await invoke('telemetry:getRecording', sessionId)).recording
    expect(r).toMatchObject({ saveState: 'incomplete', saveErrorCode: 'INTERRUPTED' })
    expect(h.ctor).toHaveLength(0)
  })
})

describe('approval and request failure states', () => {
  async function savedSession(): Promise<{ sessionId: string; revision: number; digest: string }> {
    await boot()
    const sessionId = await recordSynthetic()
    const stop = await invoke('telemetry:sessionStop', { sessionId })
    expect(stop.recording.saveState).toBe('complete')
    const prepared = await invoke('telemetry:prepareReview', sessionId)
    return { sessionId, revision: prepared.preview.revision, digest: prepared.preview.digest }
  }

  it('an untrusted sender cannot prepare or approve', async () => {
    const s = await savedSession()
    expect((await invokeFrom({}, 'telemetry:approveInterpretation', s)).ok).toBe(false)
    expect((await invokeFrom({}, 'telemetry:prepareReview', s.sessionId)).ok).toBe(false)
    expect(h.ctor).toHaveLength(0)
  })

  it('another owner’s recording is neither listed nor approvable', async () => {
    const s = await savedSession()
    h.session = { email: 'someone.else@example.com' }
    // Unowned local sessions stay with the current profile; owned ones need a match.
    expect(await invoke('telemetry:listRecordings')).toHaveLength(1)
    const metaPath = join(h.devDir, 'sessions', s.sessionId, 'meta.json')
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    writeFileSync(metaPath, JSON.stringify({ ...meta, ownerEmail: 'owner@example.com' }))
    expect(await invoke('telemetry:listRecordings')).toEqual([])
    expect((await invoke('telemetry:approveInterpretation', s)).ok).toBe(false)
    expect(h.ctor).toHaveLength(0)
  })

  it('stale approval (model or evidence changed) sends nothing', async () => {
    const s = await savedSession()
    h.model = 'different-model'
    await boot()
    const r = await invoke('telemetry:approveInterpretation', s)
    expect(r).toMatchObject({ ok: false, errorCode: 'REVIEW_STALE' })
    expect(h.ctor).toHaveLength(0)
  })

  it('missing key: approval recorded, configuration failure, zero clients/requests', async () => {
    const s = await savedSession()
    h.key = null
    await boot()
    const r = await invoke('telemetry:approveInterpretation', s)
    expect(r).toMatchObject({ ok: false, errorCode: 'OPENAI_API_KEY_MISSING' })
    expect(r.recording).toMatchObject({ interpretationState: 'failed', reviewState: 'approved' })
    expect(h.ctor).toHaveLength(0)
    expect(h.bodies).toHaveLength(0)
  })

  it('401 → failed; resending requires acknowledging a possibly processed request', async () => {
    const s = await savedSession()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    h.respond.push(async () => {
      throw Object.assign(new Error('401 Unauthorized'), { status: 401 })
    })
    await invoke('telemetry:approveInterpretation', s)
    await vi.waitFor(async () => {
      const r = (await invoke('telemetry:getRecording', s.sessionId)).recording
      expect(r.interpretationState).toBe('failed')
      expect(r.interpretationErrorCode).toBe('OPENAI_AUTHENTICATION_FAILED')
    })
    const blocked = await invoke('telemetry:approveInterpretation', s)
    expect(blocked.errorCode).toBe('UNKNOWN_OUTCOME_ACK_REQUIRED')
    expect(h.bodies).toHaveLength(1)
    h.respond.push(async () => ({ output_parsed: classifyOutput(), id: 'r1' }), async () => ({
      output_parsed: classifyOutput(),
      id: 'r2'
    }))
    expect(
      (await invoke('telemetry:approveInterpretation', { ...s, acknowledgeUnknownOutcome: true })).ok
    ).toBe(true)
    await vi.waitFor(async () => {
      const r = (await invoke('telemetry:getRecording', s.sessionId)).recording
      expect(r.interpretationState).toBe('complete')
    })
    expect(h.bodies).toHaveLength(3)
  })

  it('crash while a request is in flight → interrupted_unknown on relaunch, never resent', async () => {
    const s = await savedSession()
    h.respond.push(() => new Promise(() => {})) // never acknowledged
    await invoke('telemetry:approveInterpretation', s)
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1))
    await boot() // the old operation is abandoned, as in a crash
    const r = (await invoke('telemetry:getRecording', s.sessionId)).recording
    expect(r.interpretationState).toBe('interrupted_unknown')
    await new Promise((res) => setTimeout(res, 20))
    expect(h.bodies).toHaveLength(1)
    expect((await invoke('telemetry:approveInterpretation', s)).errorCode).toBe(
      'UNKNOWN_OUTCOME_ACK_REQUIRED'
    )
    expect(h.bodies).toHaveLength(1)
  })

  it('result-save failure is not success; approving again saves locally without a request', async () => {
    const s = await savedSession()
    const app = await import('./index')
    const store = app.getTelemetryStore()!
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const realSave = store.saveWorkflow.bind(store)
    const spy = vi.spyOn(store, 'saveWorkflow').mockRejectedValueOnce(new Error('synthetic ENOSPC'))
    h.respond.push(
      async () => ({ output_parsed: classifyOutput(), id: 'r1' }),
      async () => ({ output_parsed: classifyOutput(), id: 'r2' })
    )
    await invoke('telemetry:approveInterpretation', s)
    await vi.waitFor(async () => {
      const r = (await invoke('telemetry:getRecording', s.sessionId)).recording
      expect(r.interpretationErrorCode).toBe('RESULT_SAVE_FAILED')
    })
    spy.mockImplementation(realSave)
    const retried = await invoke('telemetry:approveInterpretation', s)
    expect(retried.recording.interpretationState).toBe('complete')
    expect(h.bodies).toHaveLength(2)
  })

  it('legacy stopped sessions are reviewable as unverified evidence; approval says so', async () => {
    await boot()
    const legacyId = 'tsess_legacy_fixture'
    mkdirSync(join(h.devDir, 'meta'), { recursive: true })
    mkdirSync(join(h.devDir, 'normalized'), { recursive: true })
    writeFileSync(
      join(h.devDir, 'meta', `${legacyId}.json`),
      JSON.stringify({
        sessionId: legacyId,
        startedAt: '2025-01-01T00:00:00.000Z',
        stoppedAt: '2025-01-01T00:01:00.000Z',
        captureStatus: 'stopped',
        processingStatus: 'not_started',
        schemaVersion: SCHEMA_VERSION
      })
    )
    const ev = (sequence: number, type: string, data: object) =>
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        receivedAt: '2025-01-01T00:00:30.000Z',
        event: {
          schemaVersion: SCHEMA_VERSION,
          eventId: `tevt_legacy_${sequence}`,
          sessionId: legacyId,
          sequence,
          timestamp: new Date(Date.UTC(2025, 0, 1, 0, 0, sequence)).toISOString(),
          elapsedMs: sequence * 1000,
          type,
          data
        }
      })
    writeFileSync(
      join(h.devDir, 'normalized', `${legacyId}.jsonl`),
      [ev(1, 'click', { appName: 'FixtureApp', elementLabel: 'Open', elementRole: 'AXButton' })].join(
        '\n'
      ) + '\n'
    )
    const listed = (await invoke('telemetry:listRecordings')) as RecordingSummary[]
    expect(listed.find((r) => r.sessionId === legacyId)?.saveState).toBe('legacy_unverified')
    const prepared = await invoke('telemetry:prepareReview', legacyId)
    expect(prepared.ok).toBe(true)
    expect(prepared.preview.legacyUnverified).toBe(true)
    h.respond.push(() => new Promise(() => {}))
    await invoke('telemetry:approveInterpretation', {
      sessionId: legacyId,
      revision: prepared.preview.revision,
      digest: prepared.preview.digest
    })
    const meta = JSON.parse(readFileSync(join(h.devDir, 'meta', `${legacyId}.json`), 'utf8'))
    expect(meta.delivery.save.state).toBe('legacy_unverified')
    expect(meta.delivery.review.approval.legacyUnverified).toBe(true)
  })
})

describe('evidence integrity end to end (M1-HF2)', () => {
  it('valid classify + valid-shaped bad extract → visible partial; same result after recreation', async () => {
    await boot()
    const sessionId = await recordSynthetic()
    expect((await invoke('telemetry:sessionStop', { sessionId })).recording.saveState).toBe('complete')
    const prepared = await invoke('telemetry:prepareReview', sessionId)
    const payload = JSON.parse(prepared.preview.payloadText)
    const alias = payload.acts[0].ids[0] as string
    expect(alias).toMatch(/^e\d+$/)
    const badExtract = {
      ...classifyOutput(),
      steps: [{ ...classifyOutput().steps[0], evidenceEventIds: ['step_1', 'tevt_guess'] }]
    }
    const goodClassify = {
      ...classifyOutput(),
      steps: [{ ...classifyOutput().steps[0], evidenceEventIds: [alias] }]
    }
    h.respond.push(
      async () => ({ output_parsed: goodClassify, id: 'resp_c' }),
      async () => ({ output_parsed: badExtract, id: 'resp_x' })
    )
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const approval = { sessionId, revision: prepared.preview.revision, digest: prepared.preview.digest }
    await Promise.all([
      invoke('telemetry:approveInterpretation', approval),
      invoke('telemetry:approveInterpretation', approval)
    ])
    await vi.waitFor(async () => {
      const r = (await invoke('telemetry:getRecording', sessionId)).recording
      expect(r.interpretationState).toBe('complete')
    })
    expect(h.bodies).toHaveLength(2)
    const done = (await invoke('telemetry:getRecording', sessionId)).recording as RecordingSummary
    expect(done.partial).toBe(true)
    // Diagnostics are counts only.
    const info = vi.mocked(console.info).mock.calls.flat().join(' ')
    expect(info).toMatch(/evidence rejected stage=extract reason=namespace steps=1 citations=2 known=0 unknown=2/)
    expect(info).not.toContain('tevt_guess')

    await boot()
    const opened = await invoke('telemetry:openResult', sessionId)
    expect(opened).toMatchObject({ ok: true, partial: true })
    expect(opened.workflow.id).toBe(done.workflowId)
    expect(opened.workflow.summary).toMatch(/^Partial interpretation/)
    const listed = (await invoke('telemetry:listRecordings')) as RecordingSummary[]
    expect(listed).toHaveLength(1)
    expect(listed[0].partial).toBe(true)
    expect(h.bodies).toHaveLength(2)
  })

  it('a failed approval history survives a changed review digest; resending needs fresh approval', async () => {
    const app = await boot()
    const sessionId = await recordSynthetic()
    await invoke('telemetry:sessionStop', { sessionId })
    const first = await invoke('telemetry:prepareReview', sessionId)
    h.key = null
    await boot()
    await invoke('telemetry:approveInterpretation', {
      sessionId,
      revision: first.preview.revision,
      digest: first.preview.digest
    })
    // Simulate a contract change: the stored review no longer matches what main prepares.
    const store = (await import('./index')).getTelemetryStore()!
    const { reviewDigest } = await import('./uploadReview')
    const stored = (await store.readDeliveryArtifact(sessionId, 'review')) as Record<string, unknown>
    const { digest: _d, revision, preparedAt, ...content } = stored
    const older = { ...content, promptVersion: 'c1-e1-w8-old' }
    await store.saveDeliveryArtifact(sessionId, 'review', {
      ...older,
      revision,
      preparedAt,
      digest: reviewDigest(older as never)
    })
    void app
    h.key = 'sk-test-synthetic-not-a-real-key-0000000000'
    await boot()
    const again = await invoke('telemetry:prepareReview', sessionId)
    expect(again.preview.revision).toBe(first.preview.revision + 1)
    expect(again.recording).toMatchObject({ approvalCurrent: false, reviewState: 'prepared' })
    expect(again.recording.approvedAt).toBeTruthy()
    const stale = await invoke('telemetry:approveInterpretation', {
      sessionId,
      revision: first.preview.revision,
      digest: first.preview.digest
    })
    expect(stale).toMatchObject({ ok: false, errorCode: 'REVIEW_STALE' })
    expect(h.ctor).toHaveLength(0)
  })
})

describe('held routes stay held', () => {
  it('legacy Retry and Compile by id alone send nothing and claim no history', async () => {
    await boot()
    const retry = await invoke('telemetry:processWorkflow', 'tsess_any')
    const compile = await invoke('automation:compile', 'tsess_any')
    for (const r of [retry, compile]) {
      expect(r.errorCode).toBe('UPLOAD_REVIEW_REQUIRED')
      expect(r.error).toMatch(/Nothing was sent by this request/)
      expect(r.error).not.toMatch(/Saved|saved on this Mac/)
    }
    expect(h.ctor).toHaveLength(0)
  })
})
