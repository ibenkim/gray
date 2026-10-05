import { existsSync, mkdtempSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  type ExtractedWorkflow,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'

// Synthetic fixtures only. Every transport is a rejecting spy; no real capture or network.
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: null as unknown as InMemoryTelemetryStore,
  recorder: null as unknown as {
    status: { sessionId: string | null; recording: boolean }
    narrating: boolean
  },
  order: [] as string[],
  transcribe: vi.fn(),
  parse: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/nonexistent-test-path' },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => ({}) },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn)
  },
  systemPreferences: { isTrustedAccessibilityClient: () => false }
}))

vi.mock('openai', () => {
  class OpenAI {
    audio = {
      transcriptions: {
        create: (...args: unknown[]) => {
          h.transcribe(...args)
          return Promise.reject(new Error('transport disabled in tests'))
        }
      }
    }
    responses = {
      parse: (...args: unknown[]) => {
        h.parse(...args)
        return Promise.reject(new Error('transport disabled in tests'))
      }
    }
  }
  return { default: OpenAI, OpenAI, toFile: async () => ({}) }
})

vi.mock('../store', () => ({ getSnapshot: () => ({ session: null }) }))

vi.mock('./config', () => ({
  loadTelemetryConfig: () => ({
    storage: 'file',
    devDir: mkdtempSync(join(tmpdir(), 'gray-m1-ipc-')),
    openaiApiKey: 'sk-test-synthetic-not-a-real-key-0000000000',
    openaiModel: 'test-model',
    isDev: true,
    isPackaged: false
  })
}))

vi.mock('./store', () => ({
  createTelemetryStore: () => h.store
}))

vi.mock('./ax/JxaAccessibilityProvider', () => ({ JxaAccessibilityProvider: class {} }))
vi.mock('./clipboard', () => ({ ClipboardWatcher: class {} }))

vi.mock('./capture', () => ({
  TelemetryRecorder: class {
    status = {
      recording: false,
      paused: false,
      sessionId: null as string | null,
      sequence: 0,
      startedAt: null,
      processing: false,
      phase: 'idle' as string,
      generation: 0
    }
    narrating = false
    // M2: sessionStart owns narration — the sink opens in beforeSources, before any source.
    async startRecording(opts: { narrate?: boolean; beforeSources?: (id: string) => Promise<void> }) {
      await opts.beforeSources?.(SID)
      this.narrating = !!opts.narrate
      Object.assign(this.status, { sessionId: SID, recording: true, phase: 'recording' })
      return { ...this.status }
    }
    haltSources() {}
    constructor() {
      h.recorder = this
    }
    onEvent() {}
    onStatus() {}
    getRecordingStatus() {
      return { ...this.status }
    }
    isNarrating() {
      return this.narrating
    }
    setProcessing(v: boolean) {
      this.status.processing = v
    }
    noteArtifactWriteFailure() {}
    async retrySessionDrain() {
      return null
    }
    async stopRecording() {
      h.order.push('stop')
      const sessionId = this.status.sessionId
      this.status.recording = false
      this.status.phase = 'idle'
      // Fake owned barrier: everything already persisted, terminal event is sequence 2.
      return {
        sessionId,
        finalSequence: 2,
        events: { accepted: 3, duplicates: 0, rejected: 0, filtered: 0, dropped: 0, pending: 0 },
        artifacts: { saved: 0, skipped: 0, failed: 0, paths: [] }
      }
    }
  }
}))

vi.mock('./polish', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./polish')>()
  return {
    ...mod,
    polishSession: vi.fn(async (...args: Parameters<typeof mod.polishSession>) => {
      h.order.push('polish')
      return mod.polishSession(...args)
    })
  }
})

vi.mock('./processSession', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./processSession')>()
  return { ...mod, processSessionWorkflow: vi.fn(mod.processSessionWorkflow) }
})

vi.mock('./automation/compileSession', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./automation/compileSession')>()
  return { ...mod, compileSessionAutomation: vi.fn(mod.compileSessionAutomation) }
})

vi.mock('./automation/compile', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./automation/compile')>()
  return { ...mod, compileAutomationScript: vi.fn(mod.compileAutomationScript) }
})

const { initTelemetry, registerTelemetryIpc, getNarrationRecorder } = await import('./index')
const { polishSession } = await import('./polish')
const { processSessionWorkflow } = await import('./processSession')
const { compileSessionAutomation } = await import('./automation/compileSession')
const { compileAutomationScript } = await import('./automation/compile')

const SID = 'tsess_m1_synthetic'

function evt(
  partial: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'eventId' | 'sequence'>
): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: SID,
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, partial.sequence)).toISOString(),
    elapsedMs: partial.sequence * 1000,
    ...partial
  }
}

const syntheticEvents: TelemetryEvent[] = [
  evt({ type: 'session_started', eventId: 'e0', sequence: 0, data: { message: 'Recording started' } }),
  evt({
    type: 'click',
    eventId: 'e1',
    sequence: 1,
    data: { appName: 'FixtureApp', elementLabel: 'Open', elementRole: 'AXButton' }
  }),
  evt({
    type: 'text_input',
    eventId: 'e2',
    sequence: 2,
    data: {
      appName: 'FixtureApp',
      elementLabel: 'Name',
      elementRole: 'AXTextField',
      typedText: 'synthetic value',
      submitKey: 'Return'
    }
  })
]

const syntheticWorkflow = {
  title: 'Synthetic fixture',
  goal: null,
  summary: 'Synthetic summary.',
  outcome: 'completed',
  steps: [
    {
      order: 1,
      action: 'Click Open',
      category: 'interaction',
      appName: 'FixtureApp',
      evidenceEventIds: ['e1'],
      confidence: 0.9
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
} as unknown as ExtractedWorkflow

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return invokeFrom({}, channel, ...args)
}
async function invokeFrom(sender: unknown, channel: string, ...args: unknown[]): Promise<any> {
  const fn = h.handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn({ sender }, ...args)
}
/** The window that started the session (M2 capture owner). */
const ownerSender = {}

function remoteCalls() {
  return {
    processSessionWorkflow: vi.mocked(processSessionWorkflow).mock.calls.length,
    compileSessionAutomation: vi.mocked(compileSessionAutomation).mock.calls.length,
    compileAutomationScript: vi.mocked(compileAutomationScript).mock.calls.length,
    transcriptionTransport: h.transcribe.mock.calls.length,
    responsesTransport: h.parse.mock.calls.length
  }
}

const ZERO = {
  processSessionWorkflow: 0,
  compileSessionAutomation: 0,
  compileAutomationScript: 0,
  transcriptionTransport: 0,
  responsesTransport: 0
}

async function startSyntheticSession(): Promise<void> {
  await h.store.createSession({ sessionId: SID })
  await h.store.appendEvents(SID, syntheticEvents)
  h.recorder.status.sessionId = SID
  h.recorder.status.recording = true
  h.recorder.status.phase = 'recording'
}

/** Narrated start through IPC: narration opens only via an approved sessionStart. */
async function startNarratedSession(): Promise<void> {
  await h.store.createSession({ sessionId: SID })
  await h.store.appendEvents(SID, syntheticEvents)
  expect((await invokeFrom(ownerSender, 'telemetry:sessionStart', { narrate: true })).ok).toBe(true)
}

async function seedProcessedSession(): Promise<void> {
  await h.store.createSession({ sessionId: SID })
  await h.store.appendEvents(SID, syntheticEvents)
  await h.store.updateSessionMeta(SID, { captureStatus: 'stopped', processingStatus: 'failed' })
  await h.store.savePolishedSession(SID, await (await import('./polish')).polishSession(h.store, SID))
  await h.store.saveWorkflow(SID, syntheticWorkflow, 'test-model')
  vi.mocked(polishSession).mockClear()
}

beforeEach(async () => {
  h.handlers.clear()
  h.order.length = 0
  h.store = new InMemoryTelemetryStore()
  await initTelemetry()
  registerTelemetryIpc()
})

describe('telemetry:sessionStop (Finish) — M1 local-only hold', () => {
  it('stops, polishes locally, returns localOnly and invokes no remote helper', async () => {
    await startSyntheticSession()

    const result = await invoke('telemetry:sessionStop', { sessionId: SID })

    expect(result).toMatchObject({ ok: true, sessionId: SID, localOnly: true })
    expect(result.recording).toMatchObject({
      sessionId: SID,
      saveState: 'complete',
      reviewState: 'pending',
      interpretationState: 'not_started'
    })
    expect(h.order).toEqual(['stop', 'polish'])
    expect(remoteCalls()).toEqual(ZERO)

    const meta = await h.store.getSessionMeta(SID)
    expect(meta?.captureStatus).toBe('stopped')
    expect(meta?.processingStatus).toBe('not_started')
    expect(meta?.stoppedAt).toBeTruthy()
    // Artifacts retained; no workflow fabricated.
    expect(await h.store.readSessionEvents(SID)).toHaveLength(syntheticEvents.length)
    expect((await h.store.readPolishedSession(SID))?.actions.length).toBeGreaterThan(0)
    expect(await h.store.getWorkflow(SID)).toBeNull()
    expect(await h.store.getAutomationScript(SID)).toBeNull()
  })

  it('narrated Finish closes the audio sink locally without transcription', async () => {
    await startNarratedSession()
    expect((await invokeFrom(ownerSender, 'narration:start', SID)).ok).toBe(true)
    // Synthetic bytes, not audio.
    expect((await invokeFrom(ownerSender, 'narration:append', SID, new Uint8Array(4096))).ok).toBe(true)
    const audioPath = getNarrationRecorder()!.getAudioPath()!

    const result = await invokeFrom(ownerSender, 'telemetry:sessionStop', {
      sessionId: SID,
      audio: { chunksAcknowledged: 1, chunksFailed: 0, timedOut: false }
    })

    expect(result).toMatchObject({ ok: true, sessionId: SID, localOnly: true })
    expect(result.recording).toMatchObject({ saveState: 'complete', audio: 'complete' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(getNarrationRecorder()!.isActive()).toBe(false)
    expect(existsSync(audioPath)).toBe(true)
    expect(statSync(audioPath).size).toBe(4096)
  })

  it('narrated Finish without the renderer chunk account is incomplete, not saved', async () => {
    await startNarratedSession()
    await invokeFrom(ownerSender, 'narration:append', SID, new Uint8Array(128))

    const result = await invokeFrom(ownerSender, 'telemetry:sessionStop', { sessionId: SID })

    expect(result.recording).toMatchObject({
      saveState: 'incomplete',
      saveErrorCode: 'AUDIO_INCOMPLETE',
      canRetrySave: false
    })
    expect(remoteCalls()).toEqual(ZERO)
  })

  it('discard keeps existing behavior and calls no remote helper', async () => {
    await startSyntheticSession()
    const result = await invoke('telemetry:sessionStop', { sessionId: SID, discard: true })
    expect(result).toMatchObject({ ok: true, sessionId: SID, discarded: true })
    expect(remoteCalls()).toEqual(ZERO)
    expect(await h.store.readSessionEvents(SID)).toHaveLength(syntheticEvents.length)
  })
})

describe('explicit processing routes are held for upload review', () => {
  it('telemetry:processWorkflow (Retry) returns UPLOAD_REVIEW_REQUIRED without a network path', async () => {
    await seedProcessedSession()
    const before = await h.store.getSessionMeta(SID)

    const result = await invoke('telemetry:processWorkflow', SID)

    expect(result).toMatchObject({ ok: false, sessionId: SID, errorCode: 'UPLOAD_REVIEW_REQUIRED' })
    expect(typeof result.error).toBe('string')
    expect(remoteCalls()).toEqual(ZERO)
    expect(await h.store.getSessionMeta(SID)).toEqual(before)
  })

  it('automation:compile returns UPLOAD_REVIEW_REQUIRED without a network path', async () => {
    await seedProcessedSession()

    const result = await invoke('automation:compile', SID)

    expect(result).toMatchObject({ ok: false, sessionId: SID, errorCode: 'UPLOAD_REVIEW_REQUIRED' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(await h.store.getAutomationScript(SID)).toBeNull()
  })
})

describe('approved review is the only send path', () => {
  it('prepare/cancel send nothing; explicit approval sends via the reviewed route only', async () => {
    await startSyntheticSession()
    await invoke('telemetry:sessionStop', { sessionId: SID })

    const prepared = await invoke('telemetry:prepareReview', SID)
    expect(prepared.ok).toBe(true)
    await invoke('telemetry:cancelReview', SID)
    expect(remoteCalls()).toEqual(ZERO)

    const reopened = await invoke('telemetry:prepareReview', SID)
    const approved = await invoke('telemetry:approveInterpretation', {
      sessionId: SID,
      revision: reopened.preview.revision,
      digest: reopened.preview.digest
    })
    expect(approved.ok).toBe(true)
    await vi.waitFor(async () => {
      const r = await invoke('telemetry:getRecording', SID)
      expect(r.recording.interpretationState).toBe('failed')
    })
    // The rejecting fake transport received the reviewed classify request; legacy helpers
    // and compile were never used.
    expect(h.parse.mock.calls.length).toBe(1)
    expect(vi.mocked(processSessionWorkflow).mock.calls.length).toBe(0)
    expect(vi.mocked(compileAutomationScript).mock.calls.length).toBe(0)
    expect(h.transcribe.mock.calls.length).toBe(0)
  })
})
