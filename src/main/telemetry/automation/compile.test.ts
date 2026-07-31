import { describe, expect, it, vi } from 'vitest'
import {
  SCHEMA_VERSION,
  type ExtractedWorkflow,
  type PolishedSession
} from '../../../shared/telemetry/schema'
import { InMemoryTelemetryStore } from '../store/InMemoryTelemetryStore'
import { compileAutomationScript, validateAndGroundScript } from './compile'

const polished: PolishedSession = {
  sessionId: 'tsess_auto',
  schemaVersion: SCHEMA_VERSION,
  polishedAt: '2026-07-29T04:28:48.452Z',
  sequenceRange: { min: 0, max: 4 },
  actions: [
    {
      order: 1,
      text: 'Opened Messages',
      category: 'navigation',
      timestamp: '2026-07-29T04:28:46.548Z',
      sourceEventIds: ['tevt_nav'],
      appName: 'Messages'
    },
    {
      order: 2,
      text: 'Clicked Send',
      category: 'interaction',
      timestamp: '2026-07-29T04:28:47.000Z',
      sourceEventIds: ['tevt_click'],
      appName: 'Messages',
      elementLabel: 'Send',
      elementRole: 'AXButton'
    }
  ]
}

const workflow: ExtractedWorkflow = {
  title: 'Send a message',
  goal: null,
  summary: 'Open Messages and send.',
  outcome: 'completed',
  steps: [
    {
      order: 1,
      action: 'Open Messages',
      category: 'navigation',
      appName: 'Messages',
      evidenceEventIds: ['tevt_nav'],
      confidence: 0.9
    },
    {
      order: 2,
      action: 'Click Send',
      category: 'interaction',
      appName: 'Messages',
      evidenceEventIds: ['tevt_click'],
      confidence: 0.85
    }
  ],
  warnings: [],
  variables: null
}

describe('validateAndGroundScript', () => {
  it('keeps grounded activate_element ops', () => {
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'open_app',
            stepOrder: 1,
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Open Messages',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            waitCondition: null,
            waitValue: null,
            prompt: null
          },
          {
            op: 'activate_element',
            stepOrder: 2,
            evidenceEventIds: ['tevt_click'],
            confidence: 0.85,
            timeoutMs: 10000,
            label: 'Click Send',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: 'AXButton',
            elementLabel: 'Send',
            elementPath: null,
            chord: null,
            variableKey: null,
            waitCondition: null,
            waitValue: null,
            prompt: null
          }
        ],
        warnings: []
      },
      workflow,
      polished
    )
    expect(script.ops[1].op).toBe('activate_element')
    expect(script.ops[1].elementLabel).toBe('Send')
  })

  it('downgrades hallucinated activate_element to manual', () => {
    const script = validateAndGroundScript(
      {
        ops: [
          {
            op: 'activate_element',
            stepOrder: 2,
            evidenceEventIds: ['tevt_click'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Click Invented',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: 'AXButton',
            elementLabel: 'Completely Fake Button',
            elementPath: null,
            chord: null,
            variableKey: null,
            waitCondition: null,
            waitValue: null,
            prompt: null
          }
        ],
        warnings: []
      },
      workflow,
      polished
    )
    expect(script.ops[0].op).toBe('manual')
    expect(script.warnings.some((w) => /ungrounded/i.test(w))).toBe(true)
  })

  it('rejects unknown stepOrder', () => {
    expect(() =>
      validateAndGroundScript(
        {
          ops: [
            {
              op: 'open_app',
              stepOrder: 99,
              evidenceEventIds: ['tevt_nav'],
              confidence: 0.9,
              timeoutMs: 10000,
              label: 'Bad',
              appName: 'Messages',
              appBundleId: null,
              url: null,
              urlVariableKey: null,
              elementRole: null,
              elementLabel: null,
              elementPath: null,
              chord: null,
              variableKey: null,
              waitCondition: null,
              waitValue: null,
              prompt: null
            }
          ],
          warnings: []
        },
        workflow,
        polished
      )
    ).toThrow()
  })
})

describe('compileAutomationScript', () => {
  it('calls OpenAI and saves through TelemetryStore', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_auto' })
    await store.stopSession('tsess_auto')
    await store.savePolishedSession('tsess_auto', polished)

    const parse = vi.fn(async () => ({
      output_parsed: {
        ops: [
          {
            op: 'open_app',
            stepOrder: 1,
            evidenceEventIds: ['tevt_nav'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Open Messages',
            appName: 'Messages',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            waitCondition: null,
            waitValue: null,
            prompt: null
          }
        ],
        warnings: []
      }
    }))

    const stored = await compileAutomationScript(
      store,
      {
        storage: 'file',
        devDir: '/tmp',
        openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
        openaiModel: 'gpt-test',
        isDev: true,
        isPackaged: false
      },
      'tsess_auto',
      workflow,
      polished,
      { createClient: () => ({ responses: { parse } }) }
    )

    expect(parse).toHaveBeenCalledTimes(1)
    expect(stored.script.ops).toHaveLength(1)
    expect(stored.script.ops[0].op).toBe('open_app')
    expect(store.automation.get('tsess_auto')).toBeTruthy()
  })
})
