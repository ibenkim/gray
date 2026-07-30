import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type PolishedSession, type TelemetrySessionMeta } from '../../shared/telemetry/schema'
import { createWorkflowModelInput } from './modelInput'

const session: TelemetrySessionMeta = {
  sessionId: 'tsess_test',
  ownerEmail: 'secret@example.com',
  startedAt: '2026-07-29T04:28:43.153Z',
  stoppedAt: '2026-07-29T04:28:48.451Z',
  captureStatus: 'stopped',
  processingStatus: 'failed',
  processingErrorCode: 'OPENAI_AUTHENTICATION_FAILED',
  schemaVersion: SCHEMA_VERSION,
  recordMode: 'full-screen'
}

const polished: PolishedSession = {
  sessionId: 'tsess_test',
  schemaVersion: SCHEMA_VERSION,
  polishedAt: '2026-07-29T04:28:48.452Z',
  sequenceRange: { min: 0, max: 2 },
  actions: [
    {
      order: 1,
      text: 'Opened Terminal TMPDIR=/var/folders/abc/T/ __CFBundleIdentifier=com.apple.Terminal XPC_FLAGS=0x0',
      category: 'navigation',
      timestamp: '2026-07-29T04:28:46.548Z',
      sourceEventIds: ['tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'],
      appName: 'Terminal'
    }
  ]
}

describe('createWorkflowModelInput', () => {
  it('excludes ownerEmail and processing errors', () => {
    const input = createWorkflowModelInput(session, polished)
    const json = JSON.stringify(input)
    expect(json).not.toContain('ownerEmail')
    expect(json).not.toContain('secret@example.com')
    expect(json).not.toContain('OPENAI_AUTHENTICATION_FAILED')
    expect(json).not.toContain('processingErrorCode')
  })

  it('redacts temporary paths and env-like values from action text', () => {
    const input = createWorkflowModelInput(session, polished)
    expect(input.actions[0].text).not.toMatch(/\/var\/folders/)
    expect(input.actions[0].text).not.toMatch(/TMPDIR=\//)
    expect(input.actions[0].text).not.toContain('__CFBundleIdentifier=com.apple')
    expect(input.actions[0].text).not.toContain('XPC_FLAGS=0x0')
  })

  it('preserves source event IDs verbatim', () => {
    const input = createWorkflowModelInput(session, polished)
    expect(input.actions[0].sourceEventIds).toEqual([
      'tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'
    ])
  })

  it('excludes API key material from model input', () => {
    const withKey: PolishedSession = {
      ...polished,
      actions: [
        {
          ...polished.actions[0],
          text: 'Error 401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz123456'
        }
      ]
    }
    const input = createWorkflowModelInput(session, withKey)
    const json = JSON.stringify(input)
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{10,}/)
    expect(json).not.toContain('Incorrect API key provided')
  })
})
