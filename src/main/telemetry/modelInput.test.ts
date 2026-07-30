import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type PolishedSession, type TelemetrySessionMeta } from '../../shared/telemetry/schema'
import { createWorkflowModelInput, prepareWorkflowModelInput } from './modelInput'

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

describe('createWorkflowModelInput / prepareWorkflowModelInput', () => {
  it('excludes ownerEmail and processing errors', () => {
    const input = createWorkflowModelInput(session, polished)
    const json = JSON.stringify(input)
    expect(json).not.toContain('ownerEmail')
    expect(json).not.toContain('secret@example.com')
    expect(json).not.toContain('OPENAI_AUTHENTICATION_FAILED')
    expect(json).not.toContain('processingErrorCode')
    expect(json).not.toContain('sessionId')
  })

  it('redacts temporary paths and env-like values from action text', () => {
    const input = createWorkflowModelInput(session, polished)
    expect(input.acts[0].t).not.toMatch(/\/var\/folders/)
    expect(input.acts[0].t).not.toMatch(/TMPDIR=\//)
    expect(input.acts[0].t).not.toContain('__CFBundleIdentifier=com.apple')
    expect(input.acts[0].t).not.toContain('XPC_FLAGS=0x0')
  })

  it('remaps source event IDs to short indices and can resolve them back', () => {
    const prepared = prepareWorkflowModelInput(session, polished)
    expect(prepared.body.acts[0].ids).toEqual(['0'])
    expect(JSON.stringify(prepared.body)).not.toContain(
      'tevt_501ade3e-d8f9-4f7f-88cc-0783cbc54640'
    )
    expect(prepared.resolveEvidence(['0'])).toEqual([
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

  it('never includes raw clipboard text, absolute paths, or URL query strings', () => {
    const rich: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Copied figma.com link',
          category: 'clipboard',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_clip'],
          appName: 'Figma',
          documentTitle: 'Gray Design',
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/abc',
            charCount: 80,
            contentHash: 'deadbeef'
          },
          keyframePath: 'tsess_test/tevt_clip.jpg'
        },
        {
          order: 2,
          text: 'Pasted link',
          category: 'input',
          timestamp: '2026-07-29T04:28:47.548Z',
          sourceEventIds: ['tevt_paste'],
          appName: 'Messages',
          keyframePath: '/Users/ben/development-data/telemetry/keyframes/x.jpg'
        },
        {
          order: 3,
          text: 'Started recording',
          category: 'session',
          timestamp: '2026-07-29T04:28:40.000Z',
          sourceEventIds: ['tevt_start']
        }
      ]
    }
    const input = createWorkflowModelInput(session, rich, {
      variables: [
        {
          key: 'link',
          label: 'Shared link',
          kind: 'url',
          exampleSanitized: 'figma.com/file/abc'
        }
      ]
    })
    const json = JSON.stringify(input)
    expect(json).not.toContain('https://')
    expect(json).not.toContain('node-id')
    expect(json).not.toContain('/Users/')
    expect(json).not.toContain('keyframe')
    expect(json).not.toContain('Started recording')
    expect(input.acts[0].h).toBe('figma.com')
    expect(input.acts[0].ct).toBe('url')
    expect(input.acts[0].a).toBe('Figma')
    expect(input.acts[0].d).toBe('Gray Design')
    expect(input.vars?.[0].k).toBe('link')
    expect(input.vars?.[0].ex).toBe('figma.com/file/abc')
    // Compact: no null fields, no screens/clipboardEvents arrays
    expect(json).not.toContain('null')
    expect(json).not.toContain('screens')
    expect(json).not.toContain('clipboardEvents')
    expect(json).not.toContain('clipboardHost')
  })

  it('omits nulls and uses short category codes', () => {
    const input = createWorkflowModelInput(session, polished)
    expect(input.acts[0].c).toBe('nav')
    expect(input.acts[0]).not.toHaveProperty('inf')
    expect(input.acts[0]).not.toHaveProperty('v')
    expect(input.mode).toBe('full-screen')
    expect(typeof input.dur).toBe('number')
  })
})
