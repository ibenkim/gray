import { describe, expect, it, vi } from 'vitest'
import { JxaAccessibilityProvider } from './JxaAccessibilityProvider'
import type { InteractionPartial } from '../providers'

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
})
