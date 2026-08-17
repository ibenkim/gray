import { describe, expect, it } from 'vitest'
import { isActionableAxTarget, resolveTargetResolution } from './axTarget'

describe('axTarget', () => {
  it('treats labeled buttons as actionable', () => {
    expect(isActionableAxTarget('AXButton', 'Send')).toBe(true)
    expect(resolveTargetResolution({ role: 'AXButton', label: 'Send', clickX: 1, clickY: 2 })).toBe(
      'ax'
    )
  })

  it('treats unlabeled AXGroup as coords when a point exists', () => {
    expect(isActionableAxTarget('AXGroup', null)).toBe(false)
    expect(
      resolveTargetResolution({ role: 'AXGroup', label: null, clickX: 10, clickY: 20 })
    ).toBe('coords')
  })

  it('returns none when there is neither actionable AX nor a point', () => {
    expect(resolveTargetResolution({ role: 'AXGroup', label: null })).toBe('none')
  })
})
