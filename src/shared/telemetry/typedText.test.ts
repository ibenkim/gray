import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from './schema'
import { redactEvent, sanitizeTypedText, shouldDropEvent } from './sanitize'

function evt(partial: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: 'tevt_1',
    sessionId: 'tsess_1',
    sequence: 1,
    timestamp: '2026-08-01T12:00:00.000Z',
    elapsedMs: 1000,
    type: 'text_input',
    ...partial
  }
}

describe('sanitizeTypedText', () => {
  it('keeps ordinary prose intact', () => {
    const { text, redacted } = sanitizeTypedText('Ship the Q3 report to the design team')
    expect(text).toBe('Ship the Q3 report to the design team')
    expect(redacted).toBe(false)
  })

  it('keeps line breaks (M8-B); other controls and whitespace runs collapse to one space', () => {
    expect(sanitizeTypedText('first line\r\nsecond\tline\u0007 end').text).toBe('first line\nsecond line end')
    expect(sanitizeTypedText('a  \n\n\n\n  b').text).toBe('a\n\nb')
    expect(sanitizeTypedText('café — naïve 日本語 ✓').text).toBe('café — naïve 日本語 ✓')
  })

  it('reports truncation', () => {
    expect(sanitizeTypedText('x'.repeat(600))).toMatchObject({ truncated: true })
    expect(sanitizeTypedText('short').truncated).toBeUndefined()
  })

  it('redacts email addresses', () => {
    const { text, redacted } = sanitizeTypedText('mail ben@example.com about it')
    expect(text).toBe('mail [email] about it')
    expect(redacted).toBe(true)
  })

  it('redacts vendor-prefixed credentials', () => {
    const { text, redacted } = sanitizeTypedText('key sk-proj-abcdefghijklmnop1234')
    expect(text).not.toMatch(/sk-proj/)
    expect(text).toContain('[token]')
    expect(redacted).toBe(true)
  })

  it('redacts long high-entropy strings', () => {
    const { text } = sanitizeTypedText('token AbCd1234EfGh5678IjKl9012Mn')
    expect(text).toBe('token [token]')
  })

  it('redacts card-length digit runs but keeps short numbers', () => {
    expect(sanitizeTypedText('card 4111 1111 1111 1111').text).toBe('card [number]')
    expect(sanitizeTypedText('order 42 please').text).toBe('order 42 please')
  })

  it('returns nothing for empty or whitespace-only input', () => {
    expect(sanitizeTypedText('   ').text).toBeUndefined()
    expect(sanitizeTypedText(null).text).toBeUndefined()
  })

  it('truncates very long entries', () => {
    const { text } = sanitizeTypedText('a'.repeat(900))
    expect(text!.length).toBeLessThanOrEqual(500)
    expect(text!.endsWith('…')).toBe(true)
  })
})

describe('redactEvent typed text', () => {
  it('re-redacts typed text that reaches the store unsanitized', () => {
    const redacted = redactEvent(
      evt({
        data: { appName: 'Mail', elementLabel: 'To', typedText: 'send to ben@example.com' }
      })
    )
    expect(redacted.data?.typedText).toBe('send to [email]')
    expect(redacted.data?.typedTextRedacted).toBe(true)
  })

  it('drops typed text entirely for a password field', () => {
    const redacted = redactEvent(
      evt({
        data: { appName: 'Safari', elementLabel: 'Password', typedText: 'hunter2' },
        target: { accessibleLabel: 'Password', appName: 'Safari' }
      })
    )
    expect(redacted.data?.typedText).toBeUndefined()
    expect(redacted.data?.typedTextRedacted).toBe(true)
  })

  it('drops typed text for a secure text field role', () => {
    const redacted = redactEvent(
      evt({
        data: { appName: 'Safari', elementRole: 'AXSecureTextField', typedText: 'hunter2' }
      })
    )
    expect(redacted.data?.typedText).toBeUndefined()
  })

  it('keeps typed text out of the store when it redacts to nothing', () => {
    const event = redactEvent(evt({ data: { typedText: 'ben@example.com', keyCount: 15 } }))
    // Only a placeholder remains, which is still worth keeping as evidence of entry.
    expect(event.data?.typedText).toBe('[email]')
  })
})

describe('shouldDropEvent for text_input', () => {
  it('drops typing that carries neither text nor a submit key', () => {
    expect(shouldDropEvent(evt({ data: { keyCount: 4 } }))).toBe(true)
  })

  it('keeps typing that recorded a submit key', () => {
    expect(shouldDropEvent(evt({ data: { keyCount: 1, submitKey: 'Return' } }))).toBe(false)
  })

  it('keeps typing that recorded text', () => {
    expect(shouldDropEvent(evt({ data: { typedText: 'hello' } }))).toBe(false)
  })
})

describe('M8-A: legacy key counts and secure lengths never leave redaction', () => {
  it('strips keyCount from any event, including legacy rows', () => {
    const e = redactEvent(evt({ data: { typedText: 'hello', keyCount: 7 } }))
    expect(e.data).not.toHaveProperty('keyCount')
    expect(e.data?.typedText).toBe('hello')
  })

  it.each([
    ['secure role', { elementRole: 'AXSecureTextField' }],
    ['secure subrole', { elementRole: 'AXTextField', elementSubrole: 'AXSecureTextField' }]
  ])('%s: legacy field length, paste length and clipboard hash are removed', (_n, ident) => {
    const focus = redactEvent(
      evt({
        type: 'focus_changed',
        data: { ...ident, field: { label: 'Password', fieldType: 'text', completed: true, valueCategory: 'text', valueLength: 9 } }
      })
    )
    expect(focus.data?.field).toEqual({ label: 'Password', fieldType: 'text', valueCategory: 'redacted' })
    const paste = redactEvent(
      evt({
        type: 'paste_detected',
        data: {
          ...ident,
          charCountDelta: 9,
          matchedClipboardHash: 'abc123',
          clipboard: { contentType: 'text', charCount: 9, contentHash: 'abc123' }
        }
      })
    )
    expect(paste.data).not.toHaveProperty('charCountDelta')
    expect(paste.data).not.toHaveProperty('matchedClipboardHash')
    expect(paste.data).not.toHaveProperty('clipboard')
  })

  it('credential_entered never carries typed text', () => {
    const e = redactEvent(evt({ type: 'credential_entered', data: { elementLabel: 'PIN', typedText: '1234' } }))
    expect(e.data).not.toHaveProperty('typedText')
  })

  it('an ordinary field keeps its length', () => {
    const e = redactEvent(
      evt({ type: 'focus_changed', data: { elementRole: 'AXTextField', field: { label: 'Subject', valueCategory: 'text', valueLength: 9 } } })
    )
    expect(e.data?.field?.valueLength).toBe(9)
  })
})
