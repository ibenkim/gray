import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import {
  createWindowTransitions,
  PILL_H,
  PILL_W,
  type Rect,
  type TransitionAck
} from './windowTransitions'

// Fake windows + Vitest fake timers drive the production controller. No Electron, no capture.

class FakeWindow extends EventEmitter {
  bounds: Rect
  visible = true
  focused = false
  destroyed = false
  calls = 0
  constructor(b: Rect) {
    super()
    this.bounds = { ...b }
  }
  getBounds() {
    return { ...this.bounds }
  }
  setBounds(b: Rect) {
    this.calls++
    this.bounds = { ...b }
  }
  setPosition(x: number, y: number) {
    this.calls++
    this.bounds = { ...this.bounds, x, y }
  }
  setSize(width: number, height: number) {
    this.calls++
    this.bounds = { ...this.bounds, width, height }
  }
  hide() {
    this.visible = false
    this.emit('hide')
  }
  showInactive() {
    this.visible = true
    this.emit('show')
  }
  show() {
    this.visible = true
    this.emit('show')
    this.focus()
  }
  focus() {
    this.focused = true
    this.emit('focus')
  }
  isVisible() {
    return this.visible
  }
  isDestroyed() {
    return this.destroyed
  }
  isFocused() {
    return this.focused
  }
  blur() {
    this.focused = false
    this.emit('blur')
  }
  moveTop() {}
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
}

const WA_PRIMARY: Rect = { x: 0, y: 34, width: 1512, height: 948 }

function setup(opts: { anchor?: { x: number; y: number }; workArea?: Rect } = {}) {
  const anchor = opts.anchor ?? { x: 1472, y: 942 }
  const pill = new FakeWindow({ x: anchor.x - PILL_W, y: anchor.y - PILL_H, width: PILL_W, height: PILL_H })
  let cursor = { x: 0, y: 0 }
  const persisted: Array<{ x: number; y: number }> = []
  const ctl = createWindowTransitions({
    pill: () => pill as unknown as BrowserWindow,
    workAreaNear: () => opts.workArea ?? WA_PRIMARY,
    cursor: () => cursor,
    persistAnchor: (p) => persisted.push(p)
  })
  ctl.setAnchor(anchor)
  ctl.attachPill(pill as unknown as BrowserWindow)
  const win = pill as unknown as BrowserWindow
  return {
    pill,
    win,
    ctl,
    persisted,
    setCursor: (c: { x: number; y: number }) => {
      cursor = c
    }
  }
}

const open = { w: 266, h: 344, mode: 'glass' as const, durationMs: 420, pillDrive: true }
const close = { w: PILL_W, h: PILL_H, mode: 'pill' as const, durationMs: 400, pillDrive: true }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('transition ownership', () => {
  it('close → new open → late close completion cannot demote the newer open', async () => {
    const { ctl, win, pill } = setup()
    const opened = await ctl.applyBounds(win, open)
    expect(opened.current).toBe(true)
    await vi.advanceTimersByTimeAsync(500)

    const closing = ctl.applyBounds(win, close)
    const reopened = ctl.applyBounds(win, open)
    const closeAck = await closing
    expect(closeAck).toMatchObject({ current: false })
    expect((await reopened).current).toBe(true)

    await vi.advanceTimersByTimeAsync(1000)
    expect(ctl.inspect().mode).toBe('glass')
    expect(pill.bounds.height).toBe(344)
    // The stale close cannot shrink the window.
    expect(ctl.restoreToSavedPill(win, closeAck.generation)).toBeNull()
    expect(pill.visible).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('close restore is one on-screen move to the saved pill: never hidden, parked or shown, and resigns focus', async () => {
    const { ctl, win, pill } = setup()
    const shown = vi.fn()
    const hidden = vi.fn()
    pill.on('show', shown)
    pill.on('hide', hidden)
    await ctl.applyBounds(win, open)
    await vi.advanceTimersByTimeAsync(500)
    const closing = ctl.applyBounds(win, close)
    await vi.advanceTimersByTimeAsync(250)
    const ack = await closing
    const calls = pill.calls
    pill.focused = true
    const restored = ctl.restoreToSavedPill(win, ack.generation)!
    expect(pill.calls - calls).toBe(1)
    expect(pill.focused).toBe(false) // focus is handed back, as the old hide did
    expect(pill.bounds).toEqual(restored)
    expect({ x: restored.x + restored.width, y: restored.y + restored.height }).toEqual({ x: 1472, y: 942 })
    expect(pill.visible).toBe(true)
    expect(hidden).not.toHaveBeenCalled()
    expect(shown).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a cancelled eased animation settles its promise and leaves no timer', async () => {
    const { ctl, win } = setup()
    const eased = ctl.applyBounds(win, { w: 300, h: 300, mode: 'panel', durationMs: 200 })
    await vi.advanceTimersByTimeAsync(48)
    const next = ctl.applyBounds(win, { w: PILL_W, h: PILL_H, mode: 'pill' })
    expect((await eased).current).toBe(false)
    expect((await next).current).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a resize during an open is deferred and applied with the latest height afterwards', async () => {
    const { ctl, win, pill } = setup()
    await ctl.applyBounds(win, open)
    await ctl.applyBounds(win, { w: 266, h: 360, mode: 'glass' })
    await ctl.applyBounds(win, { w: 266, h: 372, mode: 'glass' })
    expect(pill.bounds.height).toBe(344)
    await vi.advanceTimersByTimeAsync(421)
    expect(pill.bounds.height).toBe(372)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('window destruction settles pending work without touching the destroyed window', async () => {
    const { ctl, win, pill } = setup()
    await ctl.applyBounds(win, open)
    await vi.advanceTimersByTimeAsync(500)
    const closing = ctl.applyBounds(win, close)
    const callsBefore = pill.calls
    pill.destroy()
    expect((await closing).current).toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(pill.calls).toBe(callsBefore)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('drag ownership', () => {
  it('drag during a close supersedes it; the drop is the final anchor and restore uses it', async () => {
    const { ctl, win, pill, setCursor, persisted } = setup()
    await ctl.applyBounds(win, open)
    await vi.advanceTimersByTimeAsync(500)
    const closing = ctl.applyBounds(win, close)

    setCursor({ x: 1400, y: 900 })
    const token = ctl.dragStart(win, { x: 0, y: 0, collapseToPill: false })
    expect((await closing).current).toBe(false)
    setCursor({ x: 1300, y: 700 })
    await vi.advanceTimersByTimeAsync(32)
    expect(ctl.dragEnd(win, token)).toBe(true)
    const dropped = { x: pill.bounds.x + pill.bounds.width, y: pill.bounds.y + pill.bounds.height }
    expect(persisted.at(-1)).toEqual(ctl.inspect().anchor)

    // A fresh close after the drop restores to the dropped pill, not the pre-drag rect.
    const ack = await (async () => {
      const p = ctl.applyBounds(win, close)
      await vi.advanceTimersByTimeAsync(250)
      return p
    })()
    expect(ack.current).toBe(true)
    const restored = ctl.restoreToSavedPill(win, ack.generation)!
    expect(restored.x + restored.width).toBe(dropped.x)
    expect(ctl.inspect().dragging).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('only the owning window and matching token end a gesture', async () => {
    const { ctl, win } = setup()
    const other = new FakeWindow({ x: 0, y: 0, width: 100, height: 100 }) as unknown as BrowserWindow
    const token = ctl.dragStart(win, { x: 0, y: 0 })
    expect(ctl.dragEnd(other, token)).toBe(false)
    expect(ctl.dragEnd(win, token + 1)).toBe(false)
    expect(ctl.inspect().dragging).toBe(true)
    expect(ctl.dragEnd(win, token)).toBe(true)
    expect(ctl.dragEnd(win, token)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('blur or close of the owner ends the gesture; no interval survives', async () => {
    const { ctl, win, pill } = setup()
    ctl.dragStart(win, { x: 0, y: 0 })
    pill.emit('blur')
    expect(ctl.inspect().dragging).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    ctl.dragStart(win, { x: 0, y: 0 })
    pill.destroy()
    expect(ctl.inspect().dragging).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('repeated drags keep the latest placement as the anchor', async () => {
    const { ctl, win, pill, setCursor, persisted } = setup()
    for (const [dx, dy] of [[-40, 0], [25, -30], [-5, 12]]) {
      const b = pill.getBounds()
      setCursor({ x: b.x + 10, y: b.y + 10 })
      const t = ctl.dragStart(win, { x: 10, y: 10 })
      setCursor({ x: b.x + 10 + dx, y: b.y + 10 + dy })
      await vi.advanceTimersByTimeAsync(20)
      ctl.dragEnd(win, t)
    }
    const br = { x: pill.bounds.x + pill.bounds.width, y: pill.bounds.y + pill.bounds.height }
    expect(ctl.inspect().anchor).toEqual(br)
    expect(persisted.at(-1)).toEqual(br)
  })
})

describe('placement geometry', () => {
  it.each([
    ['primary, pill near bottom → above', { x: 1472, y: 942 }, WA_PRIMARY, 'above'],
    ['primary, pill near top → below', { x: 1472, y: 100 }, WA_PRIMARY, 'below'],
    [
      'secondary display at negative origin → below, clamped inside its work area',
      { x: -30, y: -150 },
      { x: -1920, y: -200, width: 1920, height: 1080 },
      'below'
    ]
  ] as const)('%s', async (_n, anchor, workArea, expected) => {
    const { ctl, win, pill } = setup({ anchor, workArea })
    const ack: TransitionAck = await ctl.applyBounds(win, open)
    expect(ack.placement).toBe(expected)
    const b = pill.bounds
    expect(b.x).toBeGreaterThanOrEqual(workArea.x)
    expect(b.x + b.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    // The pill's bottom-right stays on the anchor (the visible capsule does not move).
    const pillBottom = expected === 'below' ? b.y + PILL_H : b.y + b.height
    expect({ x: b.x + b.width, y: pillBottom }).toEqual(anchor)
    await vi.advanceTimersByTimeAsync(500)
  })

  // The controller works purely in DIP; these are typical 1x (1280×800) and 2x (1512×982
  // logical) work areas. Physical 1x hardware was not available for the native smoke.
  it.each([
    ['1x work area', { x: 0, y: 25, width: 1280, height: 775 }],
    ['2x work area', { x: 0, y: 34, width: 1512, height: 948 }]
  ] as const)('a pill at the right edge keeps the open frame inside the %s', async (_n, workArea) => {
    const anchor = { x: workArea.x + workArea.width, y: workArea.y + workArea.height - 10 }
    const { ctl, win, pill } = setup({ anchor, workArea })
    await ctl.applyBounds(win, open)
    expect(pill.bounds.x + pill.bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(pill.bounds.y).toBeGreaterThanOrEqual(workArea.y)
    await vi.advanceTimersByTimeAsync(500)
  })
})

describe('anchored dropdown (HF3-A)', () => {
  function withDropdown(opts: { anchor?: { x: number; y: number }; workArea?: Rect } = {}) {
    const created: FakeWindow[] = []
    const gates: Array<() => void> = []
    const anchor = opts.anchor ?? { x: 1472, y: 942 }
    const pill = new FakeWindow({ x: anchor.x - PILL_W, y: anchor.y - PILL_H, width: PILL_W, height: PILL_H })
    let cursor = { x: 0, y: 0 }
    const ctl = createWindowTransitions({
      pill: () => pill as unknown as BrowserWindow,
      workAreaNear: () => opts.workArea ?? WA_PRIMARY,
      cursor: () => cursor,
      persistAnchor: () => {},
      createDropdown: () => {
        const win = new FakeWindow({ x: 0, y: 0, width: 1, height: 1 })
        win.visible = false
        created.push(win)
        return { win: win as unknown as BrowserWindow, ready: new Promise<void>((r) => gates.push(r)) }
      }
    })
    ctl.setAnchor(anchor)
    ctl.attachPill(pill as unknown as BrowserWindow)
    // Every pill native frame/visibility operation is counted.
    const pillOps = () => pill.calls + hides + shows
    let hides = 0
    let shows = 0
    pill.on('hide', () => hides++)
    pill.on('show', () => shows++)
    return {
      ctl,
      pill,
      created,
      pillOps,
      paint: () => gates.splice(0).forEach((r) => r()),
      setCursor: (c: { x: number; y: number }) => {
        cursor = c
      }
    }
  }
  const size = { w: 266, h: 344 }

  it('first open, close, content-height changes and 20 toggles never touch the pill; one window is reused', async () => {
    const { ctl, pill, created, pillOps, paint } = withDropdown()
    const rect = pill.getBounds()
    const opening = ctl.openDropdown(size)
    expect(created).toHaveLength(1)
    expect(created[0].visible).toBe(false) // hidden until painted
    paint()
    const ack = await opening
    expect(ack).toMatchObject({ current: true, open: true, placement: 'above' })
    expect(created[0].visible).toBe(true)
    // Right edges align; the dropdown sits DROPDOWN_GAP above the pill.
    expect(ack.bounds).toEqual({ x: rect.x + PILL_W - 266, y: rect.y - 8 - 344, width: 266, height: 344 })
    ctl.resizeDropdown(400)
    expect(created[0].bounds.height).toBe(400)
    for (let i = 0; i < 20; i++) {
      ctl.closeDropdown()
      expect(created[0].visible).toBe(false)
      await ctl.openDropdown(size)
      expect(created[0].visible).toBe(true)
    }
    ctl.closeDropdown()
    ctl.resizeDropdown(200) // closed: remembered, not shown
    expect(created[0].visible).toBe(false)
    expect(created).toHaveLength(1)
    expect(pillOps()).toBe(0)
    expect(pill.getBounds()).toEqual(rect)
    expect(pill.visible).toBe(true)
  })

  it('a dismissed request never reopens when its paint arrives late; the latest reopen shows once', async () => {
    const { ctl, created, paint } = withDropdown()
    const first = ctl.openDropdown(size)
    ctl.closeDropdown()
    expect((await first).current).toBe(false)
    paint()
    await Promise.resolve()
    expect(created[0].visible).toBe(false)

    // Destroyed dropdown: the next open builds the one replacement; close+reopen during its readiness.
    created[0].destroy()
    const a = ctl.openDropdown(size)
    ctl.closeDropdown()
    const b = ctl.openDropdown({ w: 266, h: 300 })
    expect((await a).current).toBe(false)
    let shows = 0
    created[1].on('show', () => shows++)
    paint()
    expect(await b).toMatchObject({ current: true, open: true })
    expect(shows).toBe(1)
    expect(created[1].bounds.height).toBe(300)
  })

  it.each([
    ['pill near top → below', { x: 1472, y: 100 }, WA_PRIMARY, 'below'],
    ['negative-origin display → below, inside its work area', { x: -30, y: -150 }, { x: -1920, y: -200, width: 1920, height: 1080 }, 'below'],
    ['short display → fitted height, content scrolls', { x: 1000, y: 260 }, { x: 0, y: 0, width: 1280, height: 400 }, 'above']
  ] as const)('%s; the pill rect is preserved', async (_n, anchor, workArea, placement) => {
    const { ctl, pill, pillOps, paint } = withDropdown({ anchor, workArea })
    const rect = pill.getBounds()
    const opening = ctl.openDropdown(size)
    paint()
    const { bounds, placement: got } = await opening
    expect(got).toBe(placement)
    expect(bounds!.x).toBeGreaterThanOrEqual(workArea.x)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    expect(bounds!.y).toBeGreaterThanOrEqual(workArea.y)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(workArea.y + workArea.height)
    expect(bounds!.height).toBeLessThanOrEqual(344)
    expect(pill.getBounds()).toEqual(rect)
    expect(pillOps()).toBe(0)
  })

  it('focus moving between pill and dropdown keeps it open; focus outside both closes only the dropdown', async () => {
    const { ctl, pill, created, pillOps, paint } = withDropdown()
    pill.focus()
    const opening = ctl.openDropdown(size)
    paint()
    await opening
    // show() focused the dropdown: the pill blurred into it (internal transfer).
    pill.blur()
    await vi.advanceTimersByTimeAsync(200)
    expect(ctl.inspect().dropdown.open).toBe(true)
    // Back to the pill (a pill click), then into the dropdown again.
    created[0].blur()
    pill.focus()
    await vi.advanceTimersByTimeAsync(200)
    expect(ctl.inspect().dropdown.open).toBe(true)
    // Another app takes focus: both blurred.
    pill.blur()
    created[0].focused = false
    await vi.advanceTimersByTimeAsync(200)
    expect(ctl.inspect().dropdown.open).toBe(false)
    expect(created[0].visible).toBe(false)
    expect(pill.visible).toBe(true)
    expect(pillOps()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a pill drag moves the dropdown with the same anchor; the drop is persisted', async () => {
    const { ctl, pill, created, paint, setCursor } = withDropdown()
    const opening = ctl.openDropdown(size)
    paint()
    await opening
    const offset = (d: Rect) => ({ dx: d.x - pill.bounds.x, dy: d.y - pill.bounds.y })
    const before = offset(created[0].bounds)
    setCursor({ x: pill.bounds.x + 10, y: pill.bounds.y + 10 })
    const t = ctl.dragStart(pill as unknown as BrowserWindow, { x: 10, y: 10 })
    setCursor({ x: pill.bounds.x - 70, y: pill.bounds.y - 30 })
    await vi.advanceTimersByTimeAsync(32)
    expect(offset(created[0].bounds)).toEqual(before)
    ctl.dragEnd(pill as unknown as BrowserWindow, t)
    expect(ctl.inspect().anchor).toEqual({ x: pill.bounds.x + PILL_W, y: pill.bounds.y + PILL_H })
    expect(pill.bounds.width).toBe(PILL_W)
    expect(created[0].visible).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('owner destruction destroys the dropdown, settles a pending open and leaves no listener or timer', async () => {
    const { ctl, pill, created } = withDropdown()
    const base = { blur: pill.listenerCount('blur'), focus: pill.listenerCount('focus') }
    pill.focus()
    const opening = ctl.openDropdown(size) // never painted
    expect(pill.listenerCount('blur')).toBe(base.blur + 1)
    pill.blur() // pending focus check
    pill.destroy()
    expect((await opening).current).toBe(false)
    expect(created[0].destroyed).toBe(true)
    expect(created[0].listenerCount('closed') + created[0].listenerCount('blur')).toBe(0)
    expect(pill.listenerCount('blur')).toBe(base.blur)
    expect(pill.listenerCount('focus')).toBe(base.focus)
    expect(ctl.inspect().dropdown).toMatchObject({ open: false, exists: false })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('dropdown failure paths (HF3-B A1/A2)', () => {
  type Made = { win: FakeWindow; resolve: () => void; reject: (e: unknown) => void }
  function rig(opts: { workArea?: Rect; anchor?: { x: number; y: number }; throwOnCreate?: () => boolean } = {}) {
    const anchor = opts.anchor ?? { x: 1472, y: 942 }
    let pill: FakeWindow | null = new FakeWindow({ x: anchor.x - PILL_W, y: anchor.y - PILL_H, width: PILL_W, height: PILL_H })
    const made: Made[] = []
    const closed: Array<{ generation: number; reason: string; error?: string }> = []
    const ctl = createWindowTransitions({
      pill: () => pill as unknown as BrowserWindow,
      workAreaNear: () => opts.workArea ?? WA_PRIMARY,
      cursor: () => ({ x: 0, y: 0 }),
      persistAnchor: () => {},
      onDropdownClosed: (e) => closed.push(e),
      createDropdown: () => {
        if (opts.throwOnCreate?.()) throw new Error('synthetic factory failure')
        const win = new FakeWindow({ x: 0, y: 0, width: 1, height: 1 })
        win.visible = false
        let resolve!: () => void
        let reject!: (e: unknown) => void
        const ready = new Promise<void>((res, rej) => {
          resolve = res
          reject = rej
        })
        made.push({ win, resolve, reject })
        return { win: win as unknown as BrowserWindow, ready }
      }
    })
    ctl.attachPill(pill as unknown as BrowserWindow)
    const pillCalls = () => pill?.calls ?? 0
    return { ctl, made, closed, pillCalls, getPill: () => pill, dropPill: () => (pill = null) }
  }
  const size = { w: 266, h: 344 }
  const live = (made: Made[]) => made.filter((m) => !m.win.destroyed).length

  it('a rejected load settles the open with a content-free error, destroys the child and retries once', async () => {
    const { ctl, made, closed, pillCalls } = rig()
    const opening = ctl.openDropdown(size)
    made[0].reject(new Error('synthetic load failure'))
    expect(await opening).toMatchObject({ current: true, open: false, error: 'load_failed' })
    expect(made[0].win.destroyed).toBe(true)
    expect(closed.at(-1)).toMatchObject({ reason: 'failed', error: 'load_failed' })
    expect(ctl.inspect().dropdown).toMatchObject({ open: false, exists: false })
    // Explicit retry builds exactly one replacement and opens.
    const retry = ctl.openDropdown(size)
    expect(made).toHaveLength(2)
    made[1].resolve()
    expect(await retry).toMatchObject({ current: true, open: true })
    expect(made[1].win.visible).toBe(true)
    expect(live(made)).toBe(1)
    expect(pillCalls()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a child that never becomes ready fails at the 5 s deadline; the retry replaces it', async () => {
    const { ctl, made } = rig()
    const opening = ctl.openDropdown(size)
    await vi.advanceTimersByTimeAsync(4999)
    expect(made[0].win.destroyed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await opening).toMatchObject({ open: false, error: 'timeout' })
    expect(made[0].win.destroyed).toBe(true)
    // A late readiness of the failed child changes nothing.
    made[0].resolve()
    await Promise.resolve()
    expect(made[0].win.visible).toBe(false)
    const retry = ctl.openDropdown(size)
    made[1].resolve()
    expect(await retry).toMatchObject({ open: true })
    expect(live(made)).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closing while loading cancels the deadline; the next open re-arms it once', async () => {
    const { ctl, made } = rig()
    void ctl.openDropdown(size)
    ctl.closeDropdown()
    expect(vi.getTimerCount()).toBe(0)
    const again = ctl.openDropdown(size)
    expect(vi.getTimerCount()).toBe(1)
    expect(made).toHaveLength(1) // the loading child is reused, not duplicated
    made[0].resolve()
    expect(await again).toMatchObject({ open: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a factory throw is unavailable without a child; a later open can still succeed', async () => {
    let fail = true
    const { ctl, made } = rig({ throwOnCreate: () => fail })
    expect(await ctl.openDropdown(size)).toMatchObject({ open: false, error: 'unavailable' })
    expect(ctl.inspect().dropdown.exists).toBe(false)
    fail = false
    const retry = ctl.openDropdown(size)
    made[0].resolve()
    expect(await retry).toMatchObject({ open: true })
  })

  it('no owner: nothing is created or shown; an owner lost during loading is rechecked before reveal', async () => {
    const r = rig()
    r.dropPill()
    expect(await r.ctl.openDropdown(size)).toMatchObject({ open: false, error: 'no_owner' })
    expect(r.made).toHaveLength(0)

    const s = rig()
    const opening = s.ctl.openDropdown(size)
    const pill = s.getPill()!
    pill.destroyed = true // destroyed without its closed event yet
    s.made[0].resolve()
    expect(await opening).toMatchObject({ open: false, error: 'no_owner' })
    expect(s.made[0].win.visible).toBe(false)
  })

  it('invalid sizes are refused before any native call', async () => {
    const { ctl, made } = rig()
    for (const bad of [{ w: NaN, h: 300 }, { w: 266, h: 0 }, { w: Infinity, h: 300 }, { w: 266, h: -5 }]) {
      expect(await ctl.openDropdown(bad)).toMatchObject({ open: false, error: 'invalid_size' })
    }
    expect(made).toHaveLength(0)
    expect(ctl.resizeDropdown(NaN)).toMatchObject({ error: 'invalid_size' })
  })

  it('width is fitted to a narrow work area; a display with no usable room refuses instead of showing a sliver', async () => {
    const narrow = rig({ anchor: { x: 200, y: 700 }, workArea: { x: 0, y: 0, width: 200, height: 800 } })
    const a = narrow.ctl.openDropdown(size)
    narrow.made[0].resolve()
    const ack = await a
    expect(ack.open).toBe(true)
    expect(ack.bounds!.width).toBe(200)
    expect(ack.bounds!.x).toBe(0)

    const tiny = rig({ anchor: { x: 600, y: 70 }, workArea: { x: 0, y: 0, width: 800, height: 140 } })
    expect(await tiny.ctl.openDropdown(size)).toMatchObject({ open: false, error: 'no_room' })
    expect(tiny.made[0]?.win.visible ?? false).toBe(false)
  })

  it('a crash after readiness closes only the child (pill untouched) and the next open replaces it', async () => {
    const { ctl, made, closed, pillCalls, getPill } = rig()
    const opening = ctl.openDropdown(size)
    made[0].resolve()
    await opening
    made[0].win.destroy()
    expect(closed.at(-1)).toMatchObject({ reason: 'child_closed' })
    expect(ctl.inspect().dropdown).toMatchObject({ open: false, exists: false })
    expect(getPill()!.visible).toBe(true)
    const retry = ctl.openDropdown(size)
    made[1].resolve()
    expect(await retry).toMatchObject({ open: true })
    expect(live(made)).toBe(1)
    expect(pillCalls()).toBe(0)
  })

  it('a stale rejection from a replaced child cannot close the newer one', async () => {
    const { ctl, made } = rig()
    const first = ctl.openDropdown(size)
    made[0].win.destroy() // closed while loading
    await first
    const second = ctl.openDropdown(size)
    made[1].resolve()
    await second
    made[0].reject(new Error('late'))
    await Promise.resolve()
    await Promise.resolve()
    expect(ctl.inspect().dropdown.open).toBe(true)
    expect(made[1].win.destroyed).toBe(false)
  })
})
