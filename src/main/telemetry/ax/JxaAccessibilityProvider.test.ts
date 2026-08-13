import { describe, expect, it, vi } from 'vitest'
import {
  appendFromValueTail,
  JxaAccessibilityProvider,
  type JxaKeyEvent
} from './JxaAccessibilityProvider'
import type { InteractionPartial } from '../providers'

describe('appendFromValueTail', () => {
  it('returns the appended suffix by length delta', () => {
    expect(appendFromValueTail(5, 'hello world', 11)).toBe(' world')
    expect(appendFromValueTail(10, 'abcdefghijX', 11)).toBe('X')
  })

  it('returns null when length did not grow', () => {
    expect(appendFromValueTail(11, 'hello world', 11)).toBeNull()
    expect(appendFromValueTail(12, 'hello', 5)).toBeNull()
  })
})

describe('JxaAccessibilityProvider', () => {
  it('emits focus_changed and selection_changed from a sample', () => {
    const provider = new JxaAccessibilityProvider()
    const events: InteractionPartial[] = []
    // Drive without spawning osascript.
    provider['onEvent'] = (p) => events.push(p)
    provider['enabled'] = true

    provider.emitFromSample({
      appName: 'Messages',
      appBundleId: 'com.apple.MobileSMS',
      windowTitle: 'Alex',
      documentTitle: 'Alex',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      elementPath: ['Conversation', 'Messages'],
      selectedLabels: ['Alex']
    })

    expect(events.some((e) => e.type === 'focus_changed')).toBe(true)
    expect(events.some((e) => e.type === 'selection_changed')).toBe(true)
    const sel = events.find((e) => e.type === 'selection_changed')
    expect(sel?.data?.selectedLabels?.[0]).toBe('Alex')
  })

  it('emits inferred element_activated after button focus then state change', () => {
    const provider = new JxaAccessibilityProvider()
    const events: InteractionPartial[] = []
    provider['onEvent'] = (p) => events.push(p)
    provider['enabled'] = true

    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXButton',
      elementLabel: 'Send',
      valueLength: null,
      selectedLabels: []
    })
    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      selectedLabels: ['Alex']
    })

    const act = events.find((e) => e.type === 'element_activated')
    expect(act).toBeTruthy()
    expect(act?.data?.inferred).toBe(true)
    expect(act?.data?.elementLabel).toBe('Send')
  })

  it('disables itself when sample reports an error', () => {
    const provider = new JxaAccessibilityProvider()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    provider['onEvent'] = () => {}
    provider.handleLine(JSON.stringify({ error: 'not trusted' }))
    expect(provider.enabled).toBe(false)
    spy.mockRestore()
  })

  it('does not re-emit focus_changed when only the field length changes', () => {
    const { provider, events } = harness()
    const base = {
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      selectedLabels: []
    }
    provider.emitFromSample({ ...base, valueLength: 0 })
    provider.emitFromSample({ ...base, valueLength: 1 })
    provider.emitFromSample({ ...base, valueLength: 2 })

    // Typing must not produce one focus event per character.
    expect(events.filter((e) => e.type === 'focus_changed')).toHaveLength(1)
  })

  it('tolerates transient faults and only disables after repeated ones', () => {
    const { provider } = harness()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 4; i++) provider.handleLine(JSON.stringify({ k: 'fault' }))
    expect(provider.enabled).toBe(true)
    provider.handleLine(JSON.stringify({ k: 'fault' }))
    expect(provider.enabled).toBe(false)
    spy.mockRestore()
  })
})

/** Drive the provider without spawning osascript. */
function harness(): { provider: JxaAccessibilityProvider; events: InteractionPartial[] } {
  const provider = new JxaAccessibilityProvider()
  const events: InteractionPartial[] = []
  provider['onEvent'] = (p) => events.push(p)
  provider['enabled'] = true
  return { provider, events }
}

function key(overrides: Partial<JxaKeyEvent> & { code: number }): JxaKeyEvent {
  return { chars: null, base: null, ...overrides }
}

/** A printable character key (keyCode is irrelevant for these). */
function char(ch: string): JxaKeyEvent {
  return key({ code: 0, chars: ch, base: ch })
}

describe('JxaAccessibilityProvider typing capture', () => {
  it('aggregates keystrokes into one text_input on Return', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      selectedLabels: []
    })

    for (const ch of 'hey') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 36 })) // Return

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0].data?.typedText).toBe('hey')
    expect(typed[0].data?.submitKey).toBe('Return')
    expect(typed[0].data?.elementLabel).toBe('Message')
    expect(typed[0].target?.appName).toBe('Messages')
  })

  it('applies backspace to the buffered text', () => {
    const { provider, events } = harness()
    for (const ch of 'helo') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 51 })) // Backspace
    provider.handleKey(char('l'))
    provider.handleKey(char('o'))
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('hello')
    // keyCount counts physical presses, including the correction.
    expect(typed?.data?.keyCount).toBe(7)
  })

  it('never buffers characters typed into a secure field', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Safari',
      elementRole: 'AXSecureTextField',
      elementLabel: 'Password',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hunter2') provider.handleKey(char(ch))
    provider.flush()

    expect(events.some((e) => e.type === 'text_input')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('hunter')
  })

  it('honours the secure flag reported with the key event itself', () => {
    const { provider, events } = harness()
    provider.handleKey({ code: 0, chars: 's', base: 's', secure: true })
    provider.flush()
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })

  it('starts a new entry when focus moves to another element', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'To',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'ben') provider.handleKey(char(ch))

    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'Subject',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hi') provider.handleKey(char(ch))
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(2)
    expect(typed[0].data?.typedText).toBe('ben')
    expect(typed[0].data?.elementLabel).toBe('To')
    expect(typed[1].data?.typedText).toBe('hi')
    expect(typed[1].data?.elementLabel).toBe('Subject')
  })

  it('redacts sensitive text before it leaves the provider', () => {
    const { provider, events } = harness()
    for (const ch of 'ben@example.com') provider.handleKey(char(ch))
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('[email]')
    expect(typed?.data?.typedTextRedacted).toBe(true)
  })

  it('reports chords as shortcuts instead of typed text', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 1, chars: 's', base: 's', cmd: true }))

    const shortcut = events.find((e) => e.type === 'keyboard_shortcut')
    expect(shortcut?.data?.shortcut).toBe('Cmd+S')
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })

  it('flushes in-progress typing before recording a chord', () => {
    const { provider, events } = harness()
    for (const ch of 'draft') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 36, cmd: true })) // Cmd+Enter to send

    const types = events.map((e) => e.type)
    expect(types).toEqual(['text_input', 'keyboard_shortcut'])
    expect(events[0].data?.typedText).toBe('draft')
    expect(events[1].data?.shortcut).toBe('Cmd+Enter')
  })

  it('captures copy and paste chords, which accelerators could not', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 8, chars: 'c', base: 'c', cmd: true }))
    provider.handleKey(key({ code: 9, chars: 'v', base: 'v', cmd: true }))

    expect(events.map((e) => e.data?.shortcut)).toEqual(['Cmd+C', 'Cmd+V'])
  })

  it('ignores arrow keys as characters but keeps the entry open', () => {
    const { provider, events } = harness()
    provider.handleKey(char('a'))
    provider.handleKey(key({ code: 123 })) // Left arrow
    provider.handleKey(char('b'))
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0].data?.typedText).toBe('ab')
  })

  it('drops NSEvent private-use characters for function keys', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 122, chars: '\uF704', base: '\uF704' }))
    provider.flush()
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })
})

describe('JxaAccessibilityProvider click capture', () => {
  it('emits a click carrying the Accessibility identity of the target', () => {
    const { provider, events } = harness()
    provider.handleLine(
      JSON.stringify({
        k: 'click',
        button: 'left',
        count: 1,
        x: 300,
        y: 200,
        app: 'Messages',
        appBundleId: 'com.apple.MobileSMS',
        role: 'AXButton',
        label: 'Send',
        path: ['Conversation', 'Messages']
      })
    )

    const click = events.find((e) => e.type === 'click')
    expect(click).toBeTruthy()
    expect(click!.data?.elementLabel).toBe('Send')
    expect(click!.data?.elementRole).toBe('AXButton')
    expect(click!.data?.elementPath).toEqual(['Conversation', 'Messages'])
    expect(click!.data?.clickButton).toBe('left')
    expect(click!.target?.accessibleLabel).toBe('Send')
  })

  it('drops JXA bridge garbage roles so clicks fall back to coords tier', () => {
    const { provider, events } = harness()
    provider.handleClick({
      button: 'left',
      count: 1,
      x: 100,
      y: 200,
      app: 'Google Chrome',
      role: '[object Ref]',
      label: undefined
    })
    const click = events.find((e) => e.type === 'click')
    expect(click?.data?.elementRole).toBeUndefined()
    expect(click?.data?.targetTier).toBe('coords')
    expect(click?.target?.tier).toBe('coords')
  })

  it('clamps an implausible click count', () => {
    const { provider, events } = harness()
    provider.handleClick({ button: 'right', count: 99, label: 'Row' })
    const click = events.find((e) => e.type === 'click')
    expect(click?.data?.clickCount).toBe(10)
    expect(click?.data?.clickButton).toBe('right')
  })

  it('flushes typing when the click lands on a different element', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'Subject',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hi') provider.handleKey(char(ch))
    provider.handleClick({ button: 'left', label: 'Send', role: 'AXButton', app: 'Mail' })

    const types = events.map((e) => e.type)
    expect(types).toContain('text_input')
    expect(types.indexOf('text_input')).toBeLessThan(types.indexOf('click'))
  })
})

describe('AX valueTail typing fallback', () => {
  it('aggregates typed text from valueTail when key monitors are silent', () => {
    vi.useFakeTimers()
    const { provider, events } = harness()
    const base = {
      appName: 'Terminal',
      elementRole: 'AXTextArea',
      elementLabel: 'shell',
      selectedLabels: [],
      secure: false
    }
    provider.emitFromSample({ ...base, valueLength: 10, valueTail: 'prompt> ls' })
    provider.emitFromSample({ ...base, valueLength: 12, valueTail: 'prompt> ls -' })
    provider.emitFromSample({ ...base, valueLength: 13, valueTail: 'prompt> ls -l' })
    vi.advanceTimersByTime(1300)
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    // sanitizeTypedText trims leading whitespace.
    expect(typed?.data?.typedText).toBe('-l')
    vi.useRealTimers()
  })

  it('does not use valueTail while key events are actively arriving', () => {
    vi.useFakeTimers()
    const { provider, events } = harness()
    const base = {
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      selectedLabels: [],
      secure: false
    }
    provider.emitFromSample({ ...base, valueLength: 0, valueTail: '' })
    provider.handleKey(char('h'))
    provider.handleKey(char('i'))
    // Length also grows via AX — must not double-append.
    provider.emitFromSample({ ...base, valueLength: 2, valueTail: 'hi' })
    vi.advanceTimersByTime(1300)
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0]?.data?.typedText).toBe('hi')
    vi.useRealTimers()
  })
})

describe('capability reporting', () => {
  it('reports that keys are not captured when accessibility is denied', () => {
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => false })
    const seen: boolean[] = []
    provider['onEvent'] = () => {}
    provider.onCapabilityChange(({ capturesKeys }) => seen.push(capturesKeys))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    provider.handleLine(JSON.stringify({ k: 'ready', trusted: false, monitors: true }))

    expect(provider.capturesKeys).toBe(false)
    expect(seen).toEqual([false])
    warn.mockRestore()
  })

  it('reports that keys are captured once the sensor confirms monitors', () => {
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    provider['onEvent'] = () => {}
    provider.handleLine(
      JSON.stringify({ k: 'ready', trusted: true, monitors: true, secureApi: true })
    )
    expect(provider.capturesKeys).toBe(true)
  })
})
