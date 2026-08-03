import { describe, expect, it } from 'vitest'
import {
  allowedLiteralsFromPolished,
  isAllowedLiteral,
  looksLikeShellNoise,
  pickLiteralFromEvidence,
  searchQueryFromTitle
} from './groundText'
import type { PolishedAction, PolishedSession } from '../../../shared/telemetry/schema'

function action(partial: Partial<PolishedAction> & { order: number }): PolishedAction {
  return {
    order: partial.order,
    text: partial.text ?? 'x',
    category: partial.category ?? 'input',
    sourceEventIds: partial.sourceEventIds ?? [`tevt_${partial.order}`],
    appName: partial.appName,
    documentTitle: partial.documentTitle,
    elementLabel: partial.elementLabel,
    elementRole: partial.elementRole,
    typedText: partial.typedText,
    clipboard: partial.clipboard,
    inferred: partial.inferred,
    verified: partial.verified
  }
}

describe('searchQueryFromTitle', () => {
  it('extracts the query from a Google Search title', () => {
    expect(searchQueryFromTitle('how to use ai - Google Search')).toBe('how to use ai')
  })

  it('returns null for ordinary titles', () => {
    expect(searchQueryFromTitle('Inbox — Mail')).toBeNull()
  })
})

describe('allowedLiteralsFromPolished', () => {
  it('includes typedText and searchQuery, never invented strings', () => {
    const polished: PolishedSession = {
      sessionId: 'tsess_x',
      schemaVersion: 1,
      polishedAt: new Date().toISOString(),
      sequenceRange: { min: 0, max: 2 },
      actions: [
        action({ order: 1, typedText: 'ai', documentTitle: 'New Tab' }),
        action({
          order: 2,
          documentTitle: 'how to use ai - Google Search'
        })
      ]
    }
    const allowed = allowedLiteralsFromPolished(polished)
    expect(allowed.has('ai')).toBe(true)
    expect(allowed.has('how to use ai')).toBe(true)
    expect(isAllowedLiteral('aiaiai', allowed)).toBe(false)
  })
})

describe('pickLiteralFromEvidence', () => {
  it('prefers searchQuery over intermediate typed scraps', () => {
    const byEvent = new Map<string, PolishedAction>([
      [
        'tevt_1',
        action({
          order: 1,
          sourceEventIds: ['tevt_1'],
          typedText: 'ai',
          documentTitle: 'how to use ai - Google Search'
        })
      ]
    ])
    expect(pickLiteralFromEvidence(['tevt_1'], byEvent)).toBe('how to use ai')
  })
})

describe('looksLikeShellNoise', () => {
  it('flags prompt and command-not-found fragments', () => {
    expect(looksLikeShellNoise('Ben@MacBookAir gemini-video-test %')).toBe(true)
    expect(looksLikeShellNoise('ot found: cler (.venv) Ben@MacBookAir x %')).toBe(true)
    expect(looksLikeShellNoise('how to use ai')).toBe(false)
  })
})
