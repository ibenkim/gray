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
  actuatorUses: 0,
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
  JxaActuator: class {
    constructor() {
      h.actuatorUses += 1
    }
    static isAccessibilityTrusted() {
      h.actuatorUses += 1
      return true
    }
  }
}))

vi.mock('./runner', () => ({
  AutomationRunner: class {
    constructor() {
      h.runnerStarts += 1
    }
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

async function storeState() {
  return JSON.stringify([await h.store.getAutomationScript(SID), await h.store.getWorkflow(SID)])
}

beforeEach(async () => {
  h.handlers.clear()
  h.runnerStarts = 0
  h.actuatorUses = 0
  h.store = new InMemoryTelemetryStore()
  await h.store.createSession({ sessionId: SID })
  await h.store.appendEvents(SID, events)
  await h.store.updateSessionMeta(SID, { captureStatus: 'stopped', processingStatus: 'complete' })
  await h.store.savePolishedSession(SID, await polishSession(h.store, SID))
  await h.store.saveWorkflow(SID, syntheticWorkflow, 'test-model')
  registerAutomationIpc()
})

describe('automation:runStart — M5 run contract hold', () => {
  const script = {
    ops: [{ op: 'keystroke', chord: 'Cmd+S', stepOrder: 1, evidenceEventIds: ['e1'], confidence: 0.9 }],
    warnings: []
  } as any

  it.each([
    ['no grant', {}],
    ['UI authorization bool', { authorized: true, approved: true }],
    ['claimed grant', { grant: { id: 'g1', scope: ['example.com'] } }],
    ['empty scope', { allowedAddressIds: [], grant: { scope: [] } }],
    ['expired scope', { grant: { scope: ['example.com'], expiresAt: '2000-01-01T00:00:00Z' } }],
    ['unknown mode', { mode: 'turbo' }],
    ['authorized mode', { mode: 'authorized' }],
    ['simulated mode', { mode: 'simulated' }],
    ['recompile request', { recompileIfNeeded: true, editorSteps: [{ index: 0, title: 'Renamed' }] }]
  ])('%s → RUN_CONTRACT_REQUIRED with zero side effects', async (_name, payload) => {
    await h.store.saveAutomationScript(SID, script, 'test-model')
    const before = await storeState()
    const result = await runStart(payload)
    expect(result).toMatchObject({ ok: false, errorCode: 'RUN_CONTRACT_REQUIRED' })
    expect(result.error).toMatch(/Nothing was run/)
    expect(h.runnerStarts).toBe(0)
    expect(h.actuatorUses).toBe(0)
    expect(remoteCalls()).toEqual(ZERO)
    expect(await storeState()).toBe(before)
  })

  it('a missing script is refused the same way, before any compile', async () => {
    expect(await runStart({})).toMatchObject({ ok: false, errorCode: 'RUN_CONTRACT_REQUIRED' })
    expect(remoteCalls()).toEqual(ZERO)
    expect(await h.store.getAutomationScript(SID)).toBeFalsy()
  })

  it('run controls and status report no run', async () => {
    for (const ch of ['automation:runStop', 'automation:runTakeOver', 'automation:runAnswer']) {
      expect(await h.handlers.get(ch)!({}, { value: 'x' })).toMatchObject({ ok: false })
    }
    expect(await h.handlers.get('automation:runStatus')!({})).toEqual({ running: false, runId: null })
  })
})
