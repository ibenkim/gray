import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type PolishedSession, type TelemetrySessionMeta } from '../../shared/telemetry/schema'
import { normalizeOpenAiApiKey } from './openaiKey'
import { mapToProcessingError, userMessageForCode } from './errors'
import { __resetProcessingLocksForTests, processSessionWorkflow } from './processSession'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'
import { assertEvidence, extractWorkflow } from './workflow'

const session: TelemetrySessionMeta = {
  sessionId: 'tsess_sparse',
  startedAt: '2026-07-29T04:28:43.153Z',
  stoppedAt: '2026-07-29T04:28:48.451Z',
  captureStatus: 'stopped',
  processingStatus: 'not_started',
  schemaVersion: SCHEMA_VERSION,
  recordMode: 'full-screen'
}

const polished: PolishedSession = {
  sessionId: 'tsess_sparse',
  schemaVersion: SCHEMA_VERSION,
  polishedAt: '2026-07-29T04:28:48.452Z',
  sequenceRange: { min: 0, max: 4 },
  actions: [
    {
      order: 1,
      text: 'Started recording',
      category: 'session',
      timestamp: '2026-07-29T04:28:43.154Z',
      sourceEventIds: ['tevt_start'],
      appName: 'ghost'
    },
    {
      order: 2,
      text: 'Opened Terminal',
      category: 'navigation',
      timestamp: '2026-07-29T04:28:46.548Z',
      sourceEventIds: ['tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'],
      appName: 'Terminal'
    },
    {
      order: 3,
      text: 'Stopped recording',
      category: 'session',
      timestamp: '2026-07-29T04:28:48.450Z',
      sourceEventIds: ['tevt_stop']
    }
  ]
}

describe('API key normalization', () => {
  it('treats placeholders as missing', () => {
    expect(normalizeOpenAiApiKey('sk-...')).toBeNull()
    expect(normalizeOpenAiApiKey('')).toBeNull()
    expect(normalizeOpenAiApiKey('sk-abcdefghijklmnopqrstuvwxyz12')).not.toBeNull()
  })
})

describe('error mapping', () => {
  it('maps 401 to OPENAI_AUTHENTICATION_FAILED without leaking key material', () => {
    const err = mapToProcessingError(
      Object.assign(new Error('401 Incorrect API key provided: sk-abc123456789012345'), {
        status: 401
      })
    )
    expect(err.code).toBe('OPENAI_AUTHENTICATION_FAILED')
    expect(userMessageForCode(err.code)).toContain('OpenAI API configuration is invalid')
    expect(userMessageForCode(err.code)).not.toMatch(/sk-/)
  })

  it('maps missing key to OPENAI_API_KEY_MISSING', () => {
    expect(mapToProcessingError(new Error('OPENAI_API_KEY is not set')).code).toBe(
      'OPENAI_API_KEY_MISSING'
    )
  })
})

describe('extractWorkflow', () => {
  it('fails safely when API key missing', async () => {
    const store = new InMemoryTelemetryStore()
    await expect(
      extractWorkflow(
        store,
        {
          storage: 'file',
          devDir: '/tmp',
          openaiApiKey: null,
          openaiModel: 'gpt-5.6-luna',
          isDev: true,
          isPackaged: false
        },
        session,
        polished
      )
    ).rejects.toMatchObject({ code: 'OPENAI_API_KEY_MISSING' })
    expect(store.workflows.size).toBe(0)
  })

  it('calls OpenAI once and saves through TelemetryStore', async () => {
    const store = new InMemoryTelemetryStore()
    const parse = vi.fn(async () => ({
      output_parsed: {
        title: 'Brief Terminal observation',
        goal: null,
        summary:
          'The recording observed a Terminal window associated with the gray development environment before the session ended.',
        outcome: 'unknown',
        steps: [
          {
            order: 1,
            action: 'Opened a Terminal window associated with the gray development environment',
            category: 'navigation',
            appName: 'Terminal',
            evidenceEventIds: ['tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'],
            confidence: 0.91
          }
        ],
        warnings: [
          'No clicks, commands, text entry, or confirmed outcome were recorded.',
          'A screen-title change alone does not establish a distinct user action.'
        ],
        variables: null
      }
    }))

    const result = await extractWorkflow(
      store,
      {
        storage: 'file',
        devDir: '/tmp',
        openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
        openaiModel: 'gpt-5.6-luna',
        isDev: true,
        isPackaged: false
      },
      session,
      polished,
      { createClient: () => ({ responses: { parse } }) }
    )

    expect(parse).toHaveBeenCalledTimes(1)
    expect(result.workflow.outcome).toBe('unknown')
    expect(result.workflow.steps[0].evidenceEventIds).toContain(
      'tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'
    )
    expect(await store.getWorkflow('tsess_sparse')).not.toBeNull()
  })

  it('rejects unknown evidence IDs and does not store', async () => {
    const store = new InMemoryTelemetryStore()
    await expect(
      extractWorkflow(
        store,
        {
          storage: 'file',
          devDir: '/tmp',
          openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
          openaiModel: 'gpt-5.6-luna',
          isDev: true,
          isPackaged: false
        },
        session,
        polished,
        {
          createClient: () => ({
            responses: {
              parse: async () => ({
                output_parsed: {
                  title: 'Invented',
                  goal: null,
                  summary: 'Invented typing',
                  outcome: 'completed',
                  steps: [
                    {
                      order: 1,
                      action: 'Typed a command',
                      category: 'execution',
                      appName: 'Terminal',
                      evidenceEventIds: ['tevt_does_not_exist'],
                      confidence: 0.9
                    }
                  ],
                  warnings: [],
                  variables: null
                }
              })
            }
          })
        }
      )
    ).rejects.toMatchObject({ code: 'OPENAI_UNKNOWN_EVIDENCE' })
    expect(store.workflows.size).toBe(0)
  })

  it('rejects invalid structured output', async () => {
    const store = new InMemoryTelemetryStore()
    await expect(
      extractWorkflow(
        store,
        {
          storage: 'file',
          devDir: '/tmp',
          openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
          openaiModel: 'gpt-5.6-luna',
          isDev: true,
          isPackaged: false
        },
        session,
        polished,
        {
          createClient: () => ({
            responses: {
              parse: async () => ({ output_parsed: { title: 'nope' } })
            }
          })
        }
      )
    ).rejects.toMatchObject({ code: 'OPENAI_INVALID_OUTPUT' })
  })
})

describe('assertEvidence', () => {
  it('accepts known ids', () => {
    expect(() =>
      assertEvidence(
        {
          title: 't',
          goal: null,
          summary: 's',
          outcome: 'unknown',
          steps: [
            {
              order: 1,
              action: 'Opened Terminal',
              category: 'navigation',
              appName: 'Terminal',
              evidenceEventIds: ['tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'],
              confidence: 0.9
            }
          ],
          warnings: [],
          variables: null
        },
        polished
      )
    ).not.toThrow()
  })
})

describe('processSessionWorkflow', () => {
  it('keeps capture stopped when summarization fails with 401', async () => {
    __resetProcessingLocksForTests()
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_sparse', recordMode: 'full-screen' })
    await store.updateSessionMeta('tsess_sparse', {
      captureStatus: 'stopped',
      stoppedAt: session.stoppedAt
    })
    await store.savePolishedSession('tsess_sparse', polished)

    const result = await processSessionWorkflow(
      store,
      {
        storage: 'file',
        devDir: '/tmp',
        openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
        openaiModel: 'gpt-5.6-luna',
        isDev: true,
        isPackaged: false
      },
      'tsess_sparse',
      {
        skipPolishIfPresent: true,
        deps: {
          createClient: () => ({
            responses: {
              parse: async () => {
                throw Object.assign(new Error('401 Incorrect API key provided: sk-abc'), {
                  status: 401
                })
              }
            }
          })
        }
      }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorCode).toBe('OPENAI_AUTHENTICATION_FAILED')
      expect(result.error).not.toMatch(/sk-/)
    }
    const meta = await store.getSessionMeta('tsess_sparse')
    expect(meta?.captureStatus).toBe('stopped')
    expect(meta?.processingStatus).toBe('failed')
    expect(await store.readPolishedSession('tsess_sparse')).not.toBeNull()
  })

  it('retries successfully without re-recording and calls OpenAI once per attempt', async () => {
    __resetProcessingLocksForTests()
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_sparse' })
    await store.updateSessionMeta('tsess_sparse', {
      captureStatus: 'stopped',
      processingStatus: 'failed',
      processingErrorCode: 'OPENAI_AUTHENTICATION_FAILED',
      stoppedAt: session.stoppedAt
    })
    await store.savePolishedSession('tsess_sparse', polished)

    const parse = vi.fn(async () => ({
      output_parsed: {
        title: 'Brief Terminal observation',
        goal: null,
        summary: 'Observed Terminal then stopped.',
        outcome: 'unknown',
        steps: [
          {
            order: 1,
            action: 'Opened a Terminal window',
            category: 'navigation',
            appName: 'Terminal',
            evidenceEventIds: ['tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'],
            confidence: 0.9
          }
        ],
        warnings: ['No confirmed outcome.'],
        variables: null
      }
    }))

    const result = await processSessionWorkflow(
      store,
      {
        storage: 'file',
        devDir: '/tmp',
        openaiApiKey: 'sk-abcdefghijklmnopqrstuvwxyz12',
        openaiModel: 'gpt-5.6-luna',
        isDev: true,
        isPackaged: false
      },
      'tsess_sparse',
      {
        skipPolishIfPresent: true,
        deps: { createClient: () => ({ responses: { parse } }) }
      }
    )

    expect(result.ok).toBe(true)
    expect(parse).toHaveBeenCalledTimes(1)
    const meta = await store.getSessionMeta('tsess_sparse')
    expect(meta?.captureStatus).toBe('stopped')
    expect(meta?.processingStatus).toBe('complete')
  })
})
