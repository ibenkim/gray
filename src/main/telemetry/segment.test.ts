import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type PolishedAction } from '../../shared/telemetry/schema'
import {
  classifyInputKind,
  segmentActions,
  semanticOpFromShortcut
} from './segment'

function action(
  partial: Partial<PolishedAction> & Pick<PolishedAction, 'order' | 'text' | 'category'>
): PolishedAction {
  return {
    timestamp: new Date(Date.UTC(2026, 6, 29, 12, 0, partial.order)).toISOString(),
    sourceEventIds: [`e${partial.order}`],
    ...partial
  }
}

describe('segmentActions', () => {
  it('splits on app changes and groups clipboard as data_transfer', () => {
    const actions = [
      action({
        order: 1,
        text: 'Started recording',
        category: 'session',
        appName: 'ghost'
      }),
      action({
        order: 2,
        text: 'Copied figma.com link',
        category: 'clipboard',
        appName: 'Figma',
        documentTitle: 'Gray Design',
        semanticOp: 'copy',
        screenBeforeId: 'ss_a',
        screenAfterId: 'ss_a'
      }),
      action({
        order: 3,
        text: 'Opened Messages',
        category: 'navigation',
        appName: 'Messages',
        screenBeforeId: 'ss_a',
        screenAfterId: 'ss_b',
        screenAfter: { appName: 'Messages' },
        waitedMs: 9000
      }),
      action({
        order: 4,
        text: 'Pasted figma.com link',
        category: 'input',
        appName: 'Messages',
        semanticOp: 'paste',
        elementLabel: 'iMessage',
        elementRole: 'AXTextField',
        targetResolution: 'ax'
      }),
      action({
        order: 5,
        text: 'Activated Send',
        category: 'submission',
        appName: 'Messages',
        verified: true,
        semanticOp: 'submit'
      })
    ]

    const { segments, screens } = segmentActions(actions)
    expect(segments.length).toBeGreaterThanOrEqual(2)
    expect(segments[0].kind).toBe('data_transfer')
    expect(segments[0].appName).toBe('Figma')
    expect(segments.some((s) => s.appName === 'Messages')).toBe(true)
    expect(screens.map((s) => s.id)).toEqual(expect.arrayContaining(['ss_a', 'ss_b']))
  })

  it('splits on long waitedMs gaps', () => {
    const actions = [
      action({ order: 1, text: 'Clicked A', category: 'interaction', appName: 'Safari' }),
      action({
        order: 2,
        text: 'Clicked B',
        category: 'interaction',
        appName: 'Safari',
        waitedMs: 12_000
      })
    ]
    const { segments } = segmentActions(actions)
    expect(segments.length).toBe(2)
  })
})

describe('classifyInputKind', () => {
  it('classifies email, date, search, and redacted placeholders', () => {
    expect(classifyInputKind('a@b.com')).toBe('email')
    expect(classifyInputKind('2026-08-03')).toBe('date')
    expect(classifyInputKind('hello', { fieldLabel: 'Search', elementRole: 'AXSearchField' })).toBe(
      'text'
    )
    expect(classifyInputKind('[email]')).toBe('redacted')
    expect(classifyInputKind('secret', { fieldLabel: 'Password' })).toBe('sensitive')
  })
})

describe('semanticOpFromShortcut', () => {
  it('maps common chords', () => {
    expect(semanticOpFromShortcut('Cmd+C')).toBe('copy')
    expect(semanticOpFromShortcut('Ctrl+V')).toBe('paste')
    expect(semanticOpFromShortcut('Cmd+S')).toBe('save')
    expect(semanticOpFromShortcut('Cmd+Shift+Z')).toBe('redo')
  })
})

describe('schema version', () => {
  it('keeps SCHEMA_VERSION at 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
  })
})
