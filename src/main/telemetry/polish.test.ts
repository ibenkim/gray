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
})
