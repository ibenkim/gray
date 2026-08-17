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
    // Compact: no null fields, no legacy clipboardEvents arrays
    expect(json).not.toContain('null')
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

  it('packs segments/screens and elides low-value focus noise under budget', () => {
    const actions = Array.from({ length: 60 }, (_, i) => {
      const order = i + 1
      if (i === 58) {
        return {
          order,
          text: 'Activated Send',
          category: 'submission' as const,
          timestamp: `2026-07-29T04:28:${String(i).padStart(2, '0')}.000Z`,
          sourceEventIds: [`tevt_sub`],
          appName: 'Messages',
          verified: true,
          semanticOp: 'submit' as const
        }
      }
      return {
        order,
        text: `Focused field ${i}`,
        category: 'interaction' as const,
        timestamp: `2026-07-29T04:28:${String(Math.min(i, 59)).padStart(2, '0')}.000Z`,
        sourceEventIds: [`tevt_${i}`],
        appName: 'Messages',
        elementLabel: `field ${i}`
      }
    })
    const long: PolishedSession = {
      ...polished,
      actions,
      segments: [
        {
          id: 'seg_1',
          index: 0,
          kind: 'interaction',
          appName: 'Messages',
          startMs: 0,
          endMs: 60_000,
          actionOrders: actions.map((a) => a.order)
        }
      ],
      screens: [{ id: 'ss_1', appName: 'Messages' }]
    }
    const prepared = prepareWorkflowModelInput(session, long)
    expect(prepared.body.elided).toBe(true)
    expect(prepared.body.acts.length).toBeLessThanOrEqual(48)
    expect(prepared.body.acts.some((a) => a.v === true || a.c === 'sub')).toBe(true)
    expect(prepared.body.segs?.length).toBeGreaterThan(0)
    // Token reduction vs dumping full polished actions (timestamps + long ids).
    const naive = JSON.stringify(long.actions)
    expect(prepared.body.acts.length).toBeLessThan(long.actions.length)
    expect(prepared.estimatedChars).toBeLessThan(naive.length)
  })

  it('packs narration, marker, l1Op, and clipboardPairId compactly', () => {
    const rich: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Filled amount',
          category: 'input',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_fill'],
          appName: 'Chrome',
          elementLabel: 'Amount',
          typedText: '40',
          l1Op: 'fill_field',
          narrationText: 'only if the cell is empty',
          marker: 'decision_point',
          clipboardPairId: 'pair_1'
        }
      ]
    }
    const input = createWorkflowModelInput(session, rich)
    expect(input.acts[0].l1).toBe('fill_field')
    expect(input.acts[0].nt).toMatch(/empty/)
    expect(input.acts[0].mk).toBe('decision_point')
    expect(input.acts[0].cp).toBe('pair_1')
  })

  it('dedupes redundant prose when structured fields exist', () => {
    const rich: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Typed "hello" into Message',
          category: 'input',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_type'],
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea',
          typedText: 'hello',
          inputKind: 'text',
          targetResolution: 'ax'
        }
      ]
    }
    const input = createWorkflowModelInput(session, rich)
    expect(input.acts[0].tx).toBe('hello')
    expect(input.acts[0].e).toBe('Message')
    // Prose restates structured fields — omit t.
    expect(input.acts[0].t).toBeUndefined()
  })

  it('packs click coordinates and tr=coords for positional clicks', () => {
    const rich: PolishedSession = {
      ...polished,
      actions: [
        {
          order: 1,
          text: 'Clicked point (100,200)',
          category: 'interaction',
          timestamp: '2026-07-29T04:28:46.548Z',
          sourceEventIds: ['tevt_click'],
          appName: 'Figma',
          elementRole: 'AXGroup',
          targetResolution: 'coords',
          clickX: 100,
          clickY: 200,
          clickWindowX: 20,
          clickWindowY: 40
        }
      ]
    }
    const input = createWorkflowModelInput(session, rich)
    expect(input.acts[0].tr).toBe('coords')
    expect(input.acts[0].x).toBe(100)
    expect(input.acts[0].y).toBe(200)
    expect(input.acts[0].wx).toBe(20)
    expect(input.acts[0].wy).toBe(40)
  })
})
