import { describe, expect, it, vi } from 'vitest'
import { reportBuild } from './reportBuild'
import { BUILD } from '../../shared/build'

describe('M4-R4 renderer build report', () => {
  it('never throws when the preload bridge is missing, stale or failing', () => {
    expect(() => reportBuild(undefined)).not.toThrow()
    expect(() => reportBuild({})).not.toThrow() // an older preload: bridge without reportBuild
    expect(() => reportBuild({ reportBuild: () => { throw new Error('synthetic IPC failure') } })).not.toThrow()
  })

  it('reports this renderer stamp once when the bridge supports it', () => {
    const report = vi.fn()
    reportBuild({ reportBuild: report })
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(BUILD)
  })
})
