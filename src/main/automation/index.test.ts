import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  type ExtractedWorkflow,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { polishSession } from '../telemetry/polish'
import { InMemoryTelemetryStore } from '../telemetry/store/InMemoryTelemetryStore'

// Synthetic fixtures only. Transports reject; actuator and runner are fakes.
const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  store: null as unknown as InMemoryTelemetryStore,
  runnerStarts: 0,
  parse: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/nonexistent-test-path' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => h.handlers.set(channel, fn)
  }
}))

vi.mock('openai', () => {
  class OpenAI {
    responses = {
      parse: (...args: unknown[]) => {
        h.parse(...args)
        return Promise.reject(new Error('transport disabled in tests'))
      }
    }
  }
  return { default: OpenAI, OpenAI, toFile: async () => ({}) }
})

vi.mock('../telemetry', () => ({
  getTelemetryStore: () => h.store,
  getTelemetryConfig: () => ({
    storage: 'file',
    devDir: '/nonexistent-test-path',
    openaiApiKey: 'sk-test-synthetic-not-a-real-key-0000000000',
    openaiModel: 'test-model',
    isDev: true,
    isPackaged: false
  }),
  getTelemetryRecorder: () => null
}))

vi.mock('./JxaActuator', () => ({
  JxaActuator: { isAccessibilityTrusted: () => true }
}))

vi.mock('./runner', () => ({
  AutomationRunner: class {
    isRunning() {
      return false
    }
    async start() {
      h.runnerStarts += 1
    }
    control() {}
  }
}))

vi.mock('../telemetry/automation/compileSession', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../telemetry/automation/compileSession')>()
  return { ...mod, compileSessionAutomation: vi.fn(mod.compileSessionAutomation) }
})

vi.mock('../telemetry/automation/compile', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../telemetry/automation/compile')>()
  return { ...mod, compileAutomationScript: vi.fn(mod.compileAutomationScript) }
})

const { registerAutomationIpc } = await import('./index')
const { compileSessionAutomation } = await import('../telemetry/automation/compileSession')
const { compileAutomationScript } = await import('../telemetry/automation/compile')

const SID = 'tsess_m1_run_synthetic'

const events: TelemetryEvent[] = [
  {
    schemaVersion: SCHEMA_VERSION,
    sessionId: SID,
    eventId: 'e1',
    sequence: 1,
    timestamp: '2026-01-01T12:00:01.000Z',
    elapsedMs: 1000,
    type: 'click',
    data: { appName: 'FixtureApp', elementLabel: 'Open', elementRole: 'AXButton' }
  }
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

function remoteCalls() {
  return {
    compileSessionAutomation: vi.mocked(compileSessionAutomation).mock.calls.length,
    compileAutomationScript: vi.mocked(compileAutomationScript).mock.calls.length,
    responsesTransport: h.parse.mock.calls.length
  }
}

const ZERO = { compileSessionAutomation: 0, compileAutomationScript: 0, responsesTransport: 0 }

async function runStart(payload: Record<string, unknown>): Promise<any> {
  return h.handlers.get('automation:runStart')!({}, { sessionId: SID, ...payload })
}

beforeEach(async () => {
  h.handlers.clear()
  h.runnerStarts = 0
  h.store = new InMemoryTelemetryStore()
  await h.store.createSession({ sessionId: SID })
  await h.store.appendEvents(SID, events)
  await h.store.updateSessionMeta(SID, { captureStatus: 'stopped', processingStatus: 'complete' })
  await h.store.savePolishedSession(SID, await polishSession(h.store, SID))
  await h.store.saveWorkflow(SID, syntheticWorkflow, 'test-model')
  registerAutomationIpc()
})

describe('automation:runStart implicit compilation — M1 hold', () => {
  it('missing script returns UPLOAD_REVIEW_REQUIRED before any compile helper', async () => {
    const result = await runStart({})
    expect(result).toMatchObject({ ok: false, errorCode: 'UPLOAD_REVIEW_REQUIRED' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(h.runnerStarts).toBe(0)
  })

  it('stale script returns UPLOAD_REVIEW_REQUIRED before any compile helper', async () => {
    await h.store.saveAutomationScript(SID, { ops: [], warnings: [] }, 'test-model', {
      stale: true
    })
    const result = await runStart({})
    expect(result).toMatchObject({ ok: false, errorCode: 'UPLOAD_REVIEW_REQUIRED' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(h.runnerStarts).toBe(0)
    expect((await h.store.getAutomationScript(SID))?.stale).toBe(true)
  })

  it('recompileIfNeeded returns UPLOAD_REVIEW_REQUIRED before any compile helper', async () => {
    await h.store.saveAutomationScript(SID, { ops: [], warnings: [] }, 'test-model')
    const result = await runStart({ recompileIfNeeded: true })
    expect(result).toMatchObject({ ok: false, errorCode: 'UPLOAD_REVIEW_REQUIRED' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(h.runnerStarts).toBe(0)
  })
})
