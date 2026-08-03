import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from '../../shared/telemetry/schema'
import { extractWorkflowVariables } from './variables'

function evt(
  partial: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'eventId' | 'sequence'>
): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: 'tsess_vars',
    timestamp: new Date(Date.UTC(2026, 6, 29, 12, 0, partial.sequence)).toISOString(),
    elapsedMs: partial.sequence * 1000,
    ...partial
  }
}

describe('extractWorkflowVariables', () => {
  it('extracts file, link, and recipient from a Figma→Messages session', () => {
    const events: TelemetryEvent[] = [
      evt({
        type: 'navigation',
        eventId: 'a',
        sequence: 0,
        data: { appName: 'Figma', documentTitle: 'Gray Design', windowTitle: 'Gray Design' }
      }),
      evt({
        type: 'screen_changed',
        eventId: 'b',
        sequence: 1,
        data: { appName: 'Figma', documentTitle: 'Gray Design', windowTitle: 'Gray Design' }
      }),
      evt({
        type: 'clipboard_changed',
        eventId: 'c',
        sequence: 2,
        data: {
          appName: 'Figma',
          clipboard: {
            contentType: 'url',
            urlHost: 'figma.com',
            urlPath: '/file/abc',
            charCount: 40,
            contentHash: 'h1'
          }
        }
      }),
      evt({
        type: 'selection_changed',
        eventId: 'd',
        sequence: 3,
        data: {
          appName: 'Messages',
          selectionLabel: 'Alex',
          selectedLabels: ['Alex']
        }
      }),
      evt({
        type: 'focus_changed',
        eventId: 'e',
        sequence: 4,
        data: {
          appName: 'Messages',
          elementRole: 'AXTextArea',
          elementLabel: 'Message',
          field: { label: 'Message', fieldType: 'text', valueLength: 0, valueCategory: 'empty' }
        }
      })
    ]

    const vars = extractWorkflowVariables(events)
    const byKey = Object.fromEntries(vars.map((v) => [v.key, v]))
    expect(byKey.file?.kind).toBe('document')
    expect(byKey.file?.exampleSanitized).toContain('Gray Design')
    expect(byKey.link?.kind).toBe('url')
    expect(byKey.link?.exampleSanitized).toContain('figma.com')
    expect(byKey.recipient?.kind).toBe('recipient')
    expect(byKey.recipient?.exampleSanitized).toContain('Alex')
  })

  it('extracts search / message / date variables from polished input kinds', () => {
    const events: TelemetryEvent[] = [
      evt({
        type: 'text_input',
        eventId: 's1',
        sequence: 0,
        data: {
          appName: 'Chrome',
          documentTitle: 'how to use ai - Google Search',
          elementLabel: 'Search',
          elementRole: 'AXSearchField',
          typedText: 'how to use ai'
        }
      }),
      evt({
        type: 'text_input',
        eventId: 'm1',
        sequence: 1,
        data: {
          appName: 'Messages',
          elementLabel: 'Message',
          elementRole: 'AXTextArea',
          typedText: 'on my way'
        }
      }),
      evt({
        type: 'text_input',
        eventId: 'd1',
        sequence: 2,
        data: {
          appName: 'Calendar',
          elementLabel: 'Date',
          typedText: '2026-08-03'
        }
      })
    ]
    const polished = {
      sessionId: 'tsess_vars',
      schemaVersion: SCHEMA_VERSION,
      polishedAt: new Date().toISOString(),
      sequenceRange: { min: 0, max: 2 },
      actions: [
        {
          order: 1,
          text: 'Typed search',
          category: 'input' as const,
          timestamp: events[0].timestamp,
          sourceEventIds: ['s1'],
          appName: 'Chrome',
          documentTitle: 'how to use ai - Google Search',
          elementLabel: 'Search',
          elementRole: 'AXSearchField',
          typedText: 'how to use ai',
          inputKind: 'text' as const
        },
        {
          order: 2,
          text: 'Typed message',
          category: 'input' as const,
          timestamp: events[1].timestamp,
          sourceEventIds: ['m1'],
          appName: 'Messages',
          elementLabel: 'Message',
          typedText: 'on my way',
          inputKind: 'text' as const
        },
        {
          order: 3,
          text: 'Typed date',
          category: 'input' as const,
          timestamp: events[2].timestamp,
          sourceEventIds: ['d1'],
          appName: 'Calendar',
          elementLabel: 'Date',
          typedText: '2026-08-03',
          inputKind: 'date' as const
        }
      ]
    }
    const vars = extractWorkflowVariables(events, polished)
    const byKey = Object.fromEntries(vars.map((v) => [v.key, v]))
    expect(byKey.search?.kind).toBe('search')
    expect(byKey.message?.kind).toBe('message')
    expect(byKey.date?.kind).toBe('date')
  })
})
