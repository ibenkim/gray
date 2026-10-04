import { describe, expect, it, vi } from 'vitest'
import { GestureTracker } from '../hooks/useWindowDrag'
import { HoverDriver } from '../state/WorkflowContext'

// Production gesture/transition boundaries (no DOM, no Electron). The native smoke harness
// covers compositor behavior; these pin the ownership rules.

function tracker() {
  const io = { start: vi.fn(), end: vi.fn(), tap: vi.fn() }
  return { t: new GestureTracker(io), io }
}

describe('GestureTracker', () => {
  it('a completed drag suppresses exactly the click it generates', () => {
    const { t, io } = tracker()
    t.down(10, 10)
    t.move(20, 10)
    expect(io.start).toHaveBeenCalledTimes(1)
    expect(t.up()).toBe('drag')
    expect(io.end).toHaveBeenCalledTimes(1)
    expect(io.tap).not.toHaveBeenCalled()
    expect(t.consumeClick()).toBe(true)
    expect(t.consumeClick()).toBe(false)
  })

  it('a normal click is a tap and is never suppressed', () => {
    const { t, io } = tracker()
    t.down(10, 10)
    t.move(12, 11) // below the 4px threshold
    expect(t.up()).toBe('tap')
    expect(io.tap).toHaveBeenCalledTimes(1)
    expect(io.start).not.toHaveBeenCalled()
    expect(t.consumeClick()).toBe(false)
  })

  it('cancel (blur/pointercancel/unmount) ends an active drag once, with no tap', () => {
    const { t, io } = tracker()
    t.down(0, 0)
    t.move(30, 0)
    t.cancel()
    t.cancel()
    expect(t.up()).toBe('none')
    expect(io.end).toHaveBeenCalledTimes(1)
    expect(io.tap).not.toHaveBeenCalled()
    expect(t.dragging).toBe(false)
  })

  it('a new press clears a stale suppression so the next real click works', () => {
    const { t } = tracker()
    t.down(0, 0)
    t.move(30, 0)
    t.up()
    t.down(5, 5)
    expect(t.up()).toBe('tap')
    expect(t.consumeClick()).toBe(false)
  })
})

/** Ops whose native transition can be resolved by the test (current or superseded). */
function hoverOps() {
  const state = { open: false, dragging: false }
  const calls: string[] = []
  let resolveOp: ((ok: boolean) => void) | null = null
  const op = (kind: 'open' | 'close') => () =>
    new Promise<boolean>((resolve) => {
      calls.push(kind)
      resolveOp = (ok) => {
        if (ok) state.open = kind === 'open'
        resolve(ok)
      }
    })
  const driver = new HoverDriver({
    isOpen: () => state.open,
    canRun: () => !state.dragging,
    open: op('open'),
    close: op('close')
  })
  const settle = async (ok = true) => {
    const r = resolveOp
    resolveOp = null
    r?.(ok)
    await new Promise((res) => setTimeout(res, 0))
  }
  return { driver, state, calls, settle }
}

describe('HoverDriver', () => {
  it('rapid open → close → open: one transition at a time, the latest request wins', async () => {
    const { driver, state, calls, settle } = hoverOps()
    driver.toggle() // open
    driver.toggle() // close (open still in flight)
    driver.toggle() // open again
    await settle()
    expect(calls).toEqual(['open'])
    expect(state.open).toBe(true)
  })

  it('a toggle during an in-flight open closes after the open completes', async () => {
    const { driver, state, calls, settle } = hoverOps()
    driver.toggle()
    driver.toggle()
    await settle() // open done → close starts
    await settle() // close done
    expect(calls).toEqual(['open', 'close'])
    expect(state.open).toBe(false)
  })

  it('a superseded (stale) acknowledgement stops the driver without further UI changes', async () => {
    const { driver, state, calls, settle } = hoverOps()
    driver.request('open')
    await settle(false) // main said current=false
    expect(state.open).toBe(false)
    expect(calls).toEqual(['open'])
  })

  it('requests during a drag wait for the drop, then run once', async () => {
    const { driver, state, calls, settle } = hoverOps()
    state.dragging = true
    driver.request('open')
    expect(calls).toEqual([])
    state.dragging = false
    driver.kick()
    await settle()
    expect(calls).toEqual(['open'])
    expect(state.open).toBe(true)
  })

  it('dispose prevents any later transition', async () => {
    const { driver, calls } = hoverOps()
    driver.dispose()
    driver.request('open')
    expect(calls).toEqual([])
  })
})
