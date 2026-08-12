import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from '../../shared/telemetry/schema'
import { polishSession } from './polish'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'

function evt(
  partial: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'eventId' | 'sequence'>
): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: 'tsess_polish',
    timestamp: new Date(Date.UTC(2026, 6, 29, 12, 0, partial.sequence)).toISOString(),
    elapsedMs: partial.sequence * 1000,
    ...partial
  }
}

describe('polishSession', () => {
  it('merges copy → paste → send into one verified submission', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')

    const events: TelemetryEvent[] = [
      evt({
        type: 'session_started',
        eventId: 'e0',
        sequence: 0,
        data: { message: 'Recording started' }
      }),
      evt({
        type: 'clipboard_changed',
        eventId: 'e1',
        sequence: 1,
        data: {
          appName: 'Figma',
          documentTitle: 'Gray Design',
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/abc',
            charCount: 40,
            contentHash: 'hash1'
          }
        }
      }),
      evt({
        type: 'paste_detected',
        eventId: 'e2',
        sequence: 2,
        data: {
          appName: 'Messages',
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/abc',
            charCount: 40,
            contentHash: 'hash1'
          },
          matchedClipboardHash: 'hash1',
          inferred: true
        }
      }),
      evt({
        type: 'element_activated',
        eventId: 'e3',
        sequence: 3,
        data: {
          appName: 'Messages',
          elementLabel: 'Send',
          elementRole: 'AXButton',
          inferred: true
        },
        target: { visibleLabel: 'Send', role: 'AXButton', appName: 'Messages' }
      }),
      evt({
        type: 'session_stopped',
        eventId: 'e4',
        sequence: 4,
        data: { message: 'Recording stopped' }
      })
    ]
    await store.appendEvents('tsess_polish', events)

    const polished = await polishSession(store, 'tsess_polish')
    const submission = polished.actions.find((a) => a.category === 'submission')
    expect(submission).toBeTruthy()
    expect(submission!.text.toLowerCase()).toMatch(/paste|send|figma/)
    expect(submission!.sourceEventIds).toEqual(expect.arrayContaining(['e1', 'e2', 'e3']))
    expect(submission!.verified).toBe(true)
    expect(submission!.clipboard?.urlHost).toBe('figma.com')
  })

  it('turns captured typing into an input action carrying the text', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'text_input',
        eventId: 't1',
        sequence: 0,
        data: {
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea',
          typedText: 'on my way',
          keyCount: 9,
          submitKey: 'Return'
        }
      })
    ])

    const polished = await polishSession(store, 'tsess_polish')
    const input = polished.actions.find((a) => a.category === 'input')
    expect(input?.text).toBe('Typed "on my way" into Message')
    expect(input?.typedText).toBe('on my way')
    expect(input?.elementLabel).toBe('Message')
  })

  it('records a bare submit keypress when the text redacted away', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'text_input',
        eventId: 't2',
        sequence: 0,
        data: { appName: 'Safari', elementLabel: 'Search', keyCount: 12, submitKey: 'Return' }
      })
    ])

    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].text).toBe('Pressed Return in Search')
  })

  it('distinguishes an observed click from an inferred activation', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'click',
        eventId: 'c1',
        sequence: 0,
        data: { appName: 'Figma', elementLabel: 'Export', elementRole: 'AXButton' }
      }),
      evt({
        type: 'element_activated',
        eventId: 'c2',
        sequence: 1,
        data: {
          appName: 'Figma',
          elementLabel: 'Copy link',
          elementRole: 'AXButton',
          inferred: true
        }
      })
    ])

    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].text).toBe('Clicked Export')
    expect(polished.actions[1].text).toBe('Selected Copy link')
    expect(polished.actions[1].inferred).toBe(true)
  })

  it('still treats a click on a submit control as a submission', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'click',
        eventId: 'c3',
        sequence: 0,
        data: { appName: 'Messages', elementLabel: 'Send', elementRole: 'AXButton' }
      })
    ])

    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].category).toBe('submission')
    expect(polished.actions[0].text).toBe('Activated Send')
  })

  it('preserves documentTitle on navigation', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'navigation',
        eventId: 'n1',
        sequence: 0,
        data: {
          appName: 'Figma',
          windowTitle: 'Gray Design',
          documentTitle: 'Gray Design'
        }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].documentTitle).toBe('Gray Design')
    expect(polished.actions[0].text).toContain('Gray Design')
    expect(polished.actions[0].text).toContain('Figma')
  })

  it('attaches waitedMs instead of emitting idle rows for long gaps', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'click',
        eventId: 'c1',
        sequence: 0,
        timestamp: '2026-07-29T12:00:00.000Z',
        data: { appName: 'Safari', elementLabel: 'Go', elementRole: 'AXButton' }
      }),
      evt({
        type: 'click',
        eventId: 'c2',
        sequence: 1,
        timestamp: '2026-07-29T12:00:45.000Z',
        elapsedMs: 45_000,
        data: { appName: 'Safari', elementLabel: 'Next', elementRole: 'AXButton' }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions.every((a) => a.category !== 'idle')).toBe(true)
    const next = polished.actions.find((a) => a.elementLabel === 'Next')
    expect(next?.waitedMs).toBeGreaterThanOrEqual(30_000)
  })

  it('folds focus_changed into the following typed input on the same target', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'focus_changed',
        eventId: 'f1',
        sequence: 0,
        data: {
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea'
        },
        target: { accessibleLabel: 'Message', role: 'AXTextArea', appName: 'Messages' }
      }),
      evt({
        type: 'text_input',
        eventId: 't1',
        sequence: 1,
        data: {
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea',
          typedText: 'hello',
          keyCount: 5
        }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions.some((a) => /^Focused /.test(a.text))).toBe(false)
    const typed = polished.actions.find((a) => a.typedText === 'hello')
    expect(typed?.sourceEventIds).toEqual(expect.arrayContaining(['f1', 't1']))
    expect(typed?.inputKind).toBe('text')
    expect(typed?.targetResolution).toBe('ax')
  })

  it('marks unresolved clicks with targetResolution none and does not invent a control', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'click',
        eventId: 'c1',
        sequence: 0,
        data: { appName: 'Figma', clickX: 10, clickY: 20 }
      }),
      evt({
        type: 'click',
        eventId: 'c2',
        sequence: 1,
        data: { appName: 'Figma' }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].targetResolution).toBe('coords')
    expect(polished.actions[0].text).toContain('point (10,20)')
    expect(polished.actions.some((a) => a.sourceEventIds.includes('c2'))).toBe(false)
  })

  it('attaches screen transitions and produces segments', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'navigation',
        eventId: 'n1',
        sequence: 0,
        screenStateId: 'ss_figma',
        data: { appName: 'Figma', documentTitle: 'Gray Design' }
      }),
      evt({
        type: 'navigation',
        eventId: 'n2',
        sequence: 1,
        screenStateId: 'ss_messages',
        data: { appName: 'Messages', documentTitle: 'Alex' }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions[0].screenAfterId).toBe('ss_figma')
    expect(polished.actions[1].screenAfterId).toBe('ss_messages')
    expect(polished.segments?.length).toBeGreaterThanOrEqual(2)
    expect(polished.screens?.some((s) => s.id === 'ss_figma')).toBe(true)
  })

  it('merges click + type + Tab into one fill_field action', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'click',
        eventId: 'c1',
        sequence: 0,
        data: {
          appName: 'Safari',
          elementLabel: 'Name',
          elementRole: 'AXTextField'
        }
      }),
      evt({
        type: 'text_input',
        eventId: 't1',
        sequence: 1,
        data: {
          appName: 'Safari',
          elementLabel: 'Name',
          elementRole: 'AXTextField',
          typedText: 'Ada Lovelace',
          keyCount: 12
        }
      }),
      evt({
        type: 'text_input',
        eventId: 't2',
        sequence: 2,
        data: {
          appName: 'Safari',
          elementLabel: 'Name',
          elementRole: 'AXTextField',
          submitKey: 'Tab'
        }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions).toHaveLength(1)
    expect(polished.actions[0].l1Op).toBe('fill_field')
    expect(polished.actions[0].category).toBe('input')
    expect(polished.actions[0].typedText).toBe('Ada Lovelace')
    expect(polished.actions[0].sourceEventIds).toEqual(
      expect.arrayContaining(['c1', 't1', 't2'])
    )
    expect(polished.actions.some((a) => /^Clicked /.test(a.text))).toBe(false)
  })

  it('merges clipboard pair into one transfer with source and dest labels', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'clipboard_changed',
        eventId: 'copy1',
        sequence: 0,
        data: {
          appName: 'Figma',
          elementLabel: 'Share link',
          elementRole: 'AXButton',
          clipboardPairId: 'clip_pair_1',
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/xyz',
            charCount: 40,
            contentHash: 'hash_transfer',
            pairId: 'clip_pair_1'
          }
        },
        target: { visibleLabel: 'Share link', role: 'AXButton', appName: 'Figma' }
      }),
      evt({
        type: 'paste_detected',
        eventId: 'paste1',
        sequence: 1,
        data: {
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea',
          clipboardPairId: 'clip_pair_1',
          matchedClipboardHash: 'hash_transfer',
          inferred: true,
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/xyz',
            charCount: 40,
            contentHash: 'hash_transfer',
            pairId: 'clip_pair_1'
          }
        }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions).toHaveLength(1)
    expect(polished.actions[0].l1Op).toBe('transfer')
    expect(polished.actions[0].transferSourceLabel).toBe('Share link')
    expect(polished.actions[0].transferDestLabel).toBe('Message')
    expect(polished.actions[0].clipboardPairId).toBe('clip_pair_1')
    expect(polished.actions[0].semanticOp).toBe('paste')
    expect(polished.actions[0].sourceEventIds).toEqual(
      expect.arrayContaining(['copy1', 'paste1'])
    )
  })

  it('drops navigation when userInitiated is false', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_polish' })
    await store.stopSession('tsess_polish')
    await store.appendEvents('tsess_polish', [
      evt({
        type: 'navigation',
        eventId: 'n_user',
        sequence: 0,
        data: {
          appName: 'Safari',
          documentTitle: 'Home',
          userInitiated: true
        }
      }),
      evt({
        type: 'navigation',
        eventId: 'n_redirect',
        sequence: 1,
        data: {
          appName: 'Safari',
          documentTitle: 'Login redirect',
          userInitiated: false
        }
      }),
      evt({
        type: 'click',
        eventId: 'c1',
        sequence: 2,
        data: { appName: 'Safari', elementLabel: 'Continue', elementRole: 'AXButton' }
      })
    ])
    const polished = await polishSession(store, 'tsess_polish')
    expect(polished.actions.some((a) => a.sourceEventIds.includes('n_redirect'))).toBe(false)
    expect(polished.actions.some((a) => a.sourceEventIds.includes('n_user'))).toBe(true)
    expect(polished.actions.some((a) => a.elementLabel === 'Continue')).toBe(true)
  })
})
