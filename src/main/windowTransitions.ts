import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents
} from 'electron'
import type {
  DropdownAck,
  DropdownClosed,
  DropdownError,
  RecordDropdownCommand,
  RecordDropdownSnapshot
} from '../shared/types'

/**
 * Pill window bounds, open/close morph, park/restore and drag — one owner (M1-HF2).
 *
 * Every bounds transition gets a monotonically increasing generation. Starting a new one
 * (or a drag) supersedes the previous: its timers are cancelled and its promise settles
 * with `current: false`. Stale completions never touch mode, bounds, anchor or visibility.
 * Electron objects are injected so the production controller runs under unit tests and the
 * isolated native smoke harness without booting capture.
 *
 * M1-HF3-A adds an optional anchored dropdown: one separate, reusable window beside a
 * stationary pill. It is exercised only by the isolated fixture until HF3-B wires it.
 *
 * Surfaces: the pill and every panel paint opaque paper, so no native vibrancy backdrop is
 * used — it could only show as a frosted flash or a corner outside the CSS silhouette.
 */

export const PILL_W = 94
export const PILL_H = 24
export const PANEL_PADDING = 36

export type Rect = { x: number; y: number; width: number; height: number }
export type Placement = 'above' | 'below'
export type BoundsRequest = {
  w: number
  h: number
  mode: 'pill' | 'glass' | 'panel'
  /** Ease window bounds over this many ms. */
  durationMs?: number
  /**
   * Pill-driven morph: the pill BR is the only anchor. Open jumps to the full glass frame
   * and resolves placement immediately (so above/below CSS matches geometry). Close keeps
   * the frame while the paper fades, then reports completion for park/restore.
   */
  pillDrive?: boolean
  /** Center in the display work area instead of anchoring to the pill BR. */
  center?: boolean
}
/** Renderer acknowledgement: act on it only while `current` is true. */
export type TransitionAck = { placement: Placement; generation: number; current: boolean }

/** Pill content window surface (preload path is added by the caller). */
export const PILL_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  frame: false,
  transparent: true,
  resizable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  hasShadow: false,
  roundedCorners: true,
  acceptFirstMouse: true
}

type TimerApi = {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (t: unknown) => void
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (t: unknown) => void
}

export type TransitionDeps = {
  pill: () => BrowserWindow | null
  workAreaNear: (point: { x: number; y: number }) => Rect
  cursor: () => { x: number; y: number }
  persistAnchor: (point: { x: number; y: number }) => void
  /**
   * M1-HF3: create the one reusable dropdown window, hidden, with `ready` resolving once its
   * renderer has rendered (and rejecting if it cannot load). Without it the dropdown is unavailable.
   */
  createDropdown?: () => { win: BrowserWindow; ready: Promise<unknown> }
  /** The dropdown closed (outside focus, request, child closed or failed). */
  onDropdownClosed?: (event: DropdownClosed) => void
  timers?: TimerApi
}

export type { DropdownAck, DropdownClosed, DropdownError }

/** Gap between the pill and its dropdown (matches the panel/pill gap in the glass frame). */
export const DROPDOWN_GAP = 8
/** Blur → focus between the pill and its dropdown arrives as two events; wait this long. */
const FOCUS_SETTLE_MS = 60
/** A dropdown child that is not ready by then is destroyed (failure bound, not a target). */
export const DROPDOWN_READY_TIMEOUT_MS = 5000
/** Shorter than this a fitted panel cannot show its controls: refuse rather than show it. */
const DROPDOWN_MIN_H = 120

const TICK_MS = 16

/** Approximate CSS cubic-bezier(0.32, 0.72, 0, 1) — open ease-out. */
function easeOpen(t: number) {
  return 1 - Math.pow(1 - t, 3)
}
/** Approximate CSS cubic-bezier(0.4, 0, 1, 1) — close ease-in. */
function easeClose(t: number) {
  return t * t * t
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}
function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    x: Math.round(lerp(from.x, to.x, t)),
    y: Math.round(lerp(from.y, to.y, t)),
    width: Math.round(lerp(from.width, to.width, t)),
    height: Math.round(lerp(from.height, to.height, t))
  }
}

type Gesture = {
  token: number
  win: BrowserWindow
  interval: unknown
  detach: () => void
}

export function createWindowTransitions(deps: TransitionDeps) {
  const timers: TimerApi = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t as ReturnType<typeof setInterval>)
  }

  /** Screen position of the pill's bottom-right corner (latest user placement). */
  let pillAnchor: { x: number; y: number } | null = null
  let currentInsets = 0
  /** A glass height correction that arrived during an open morph or a drag. */
  let pendingBounds: BoundsRequest | null = null
  let currentPlacement: Placement = 'above'
  let currentMode: BoundsRequest['mode'] = 'pill'
  /** True for the whole pill-drive open (corrections are deferred, not cancelling). */
  let pillDriveLock = false
  /** Pill screen rect captured at the last open/close or drop, for restore. */
  let savedPillRect: Rect | null = null

  let generation = 0
  /** The one active bounds transition: owned timers and its unsettled promise. */
  let active: {
    gen: number
    timers: Set<{ t: unknown; kind: 'timeout' | 'interval' }>
    settle: ((ack: TransitionAck) => void) | null
  } | null = null

  let tokenSeq = 0
  const gestures = new Map<BrowserWindow, Gesture>()

  function ack(gen: number, placement = currentPlacement): TransitionAck {
    return { placement, generation: gen, current: gen === generation }
  }

  /** Cancel the active transition's timers and settle its promise as superseded. */
  function supersede() {
    if (!active) return
    for (const { t, kind } of active.timers) {
      if (kind === 'interval') timers.clearInterval(t)
      else timers.clearTimeout(t)
    }
    active.timers.clear()
    const settle = active.settle
    const gen = active.gen
    active = null
    pillDriveLock = false
    settle?.({ placement: currentPlacement, generation: gen, current: false })
  }

  function beginTransition() {
    supersede()
    generation += 1
    active = { gen: generation, timers: new Set(), settle: null }
    return active
  }

  function ownTimeout(op: NonNullable<typeof active>, fn: () => void, ms: number) {
    const entry = { t: null as unknown, kind: 'timeout' as const }
    entry.t = timers.setTimeout(() => {
      op.timers.delete(entry)
      if (op !== active) return // stale completion: never mutate
      fn()
    }, ms)
    op.timers.add(entry)
  }

  function finish(op: NonNullable<typeof active>, placement: Placement) {
    if (op !== active) return
    const settle = op.settle
    active = null
    pillDriveLock = false
    settle?.(ack(op.gen, placement))
  }

  function rectFromPillAnchor(
    anchor: { x: number; y: number },
    width: number,
    height: number,
    placement: Placement,
    insets: number
  ): Rect {
    const x = anchor.x + insets - width
    if (placement === 'below' && height > PILL_H) {
      return { x, y: anchor.y - PILL_H - insets, width, height }
    }
    return { x, y: anchor.y + insets - height, width, height }
  }

  /** Screen rect of the visible pill capsule inside the current window. */
  function visualPillRect(b: Rect): Rect {
    const tall = b.height > PILL_H + 4
    const below = currentPlacement === 'below' && tall
    const pw = Math.min(PILL_W, b.width)
    const ph = Math.min(PILL_H, b.height)
    return {
      x: b.x + b.width - pw,
      y: below ? b.y : b.y + b.height - ph,
      width: PILL_W,
      height: PILL_H
    }
  }

  function pillAnchorFromBounds(b: Rect): { x: number; y: number } {
    const r = visualPillRect(b)
    return { x: r.x + r.width, y: r.y + r.height }
  }

  function ensurePillAnchor(win: BrowserWindow): { x: number; y: number } {
    if (!pillAnchor) pillAnchor = pillAnchorFromBounds(win.getBounds())
    return pillAnchor
  }

  function computeTarget(win: BrowserWindow, req: BoundsRequest): { target: Rect; placement: Placement } {
    const width = Math.round(req.w)
    const height = Math.round(req.h)
    const anchor = { ...ensurePillAnchor(win) }
    const wa = deps.workAreaNear(anchor)
    const insets = req.mode === 'panel' ? PANEL_PADDING : 0
    if (req.center) {
      return {
        target: {
          x: Math.round(wa.x + (wa.width - width) / 2),
          y: Math.round(wa.y + (wa.height - height) / 2),
          width,
          height
        },
        placement: 'above'
      }
    }
    let placement: Placement = 'above'
    let trial = rectFromPillAnchor(anchor, width, height, 'above', insets)
    if (req.mode !== 'pill') {
      const pillTop = anchor.y - PILL_H
      const mid = wa.y + wa.height / 2
      if (pillTop < mid || trial.y < wa.y) {
        placement = 'below'
        trial = rectFromPillAnchor(anchor, width, height, 'below', insets)
        if (trial.y + height > wa.y + wa.height) {
          placement = 'above'
          trial = rectFromPillAnchor(anchor, width, height, 'above', insets)
          trial.y = Math.max(wa.y, trial.y)
        }
      }
    }
    trial.x = Math.min(Math.max(trial.x, wa.x), wa.x + wa.width - width)
    return { target: trial, placement }
  }

  /**
   * Apply a bounds request. Resolves with a generation-stamped acknowledgement; a request
   * superseded by a later transition or a drag resolves with `current: false`.
   */
  function applyBounds(win: BrowserWindow, req: BoundsRequest): Promise<TransitionAck> {
    const durationMs = Math.max(0, req.durationMs ?? 0)

    // A non-animated glass height correction during a pill-drive open is deferred to the
    // end of that open instead of cancelling it.
    if (pillDriveLock && durationMs <= 0 && req.mode === 'glass' && !req.pillDrive) {
      pendingBounds = req
      return Promise.resolve(ack(generation))
    }

    const op = beginTransition()
    if (win.isDestroyed()) {
      finish(op, currentPlacement)
      return Promise.resolve(ack(op.gen))
    }
    const prevBounds = win.getBounds()
    const vis = visualPillRect(prevBounds)
    if (!req.center) pillAnchor = { x: vis.x + vis.width, y: vis.y + vis.height }
    if (req.pillDrive) savedPillRect = vis
    const { target, placement } = computeTarget(win, req)
    currentInsets = req.mode === 'panel' ? PANEL_PADDING : 0
    const pillDrive = !!req.pillDrive && durationMs > 0
    const closing = pillDrive && req.mode === 'pill'
    if (!closing) {
      if (req.mode !== 'pill') currentPlacement = placement
      else if (prevBounds.height <= PILL_H + 4) currentPlacement = 'above'
      currentMode = req.mode
    }

    const from: Rect = { ...prevBounds }
    const alreadyThere =
      from.x === target.x && from.y === target.y && from.width === target.width && from.height === target.height

    return new Promise<TransitionAck>((resolve) => {
      op.settle = resolve
      if (durationMs <= 0 || alreadyThere) {
        win.setBounds(target, false)
        finish(op, placement)
        return
      }
      if (pillDrive && !closing) {
        // Open: instant full glass frame pinned to the pill BR; resolve placement now so
        // the renderer applies above/below CSS before the fade. The lock defers height
        // corrections for the open duration, then applies the latest one.
        win.setBounds(target, false)
        pillDriveLock = true
        const done = ack(op.gen, placement)
        op.settle = null
        resolve(done)
        ownTimeout(op, () => {
          pillDriveLock = false
          active = null
          const pending = pendingBounds
          pendingBounds = null
          if (pending && pending.h >= PILL_H + 40) {
            void applyBounds(win, { ...pending, durationMs: 0, pillDrive: false })
          }
        }, durationMs)
        return
      }
      if (closing) {
        // Close: keep the frame while the paper fades; the renderer then parks/restores
        // using this generation. Size never changes on-screen here.
        const fadeMs = Math.min(200, Math.max(120, durationMs))
        ownTimeout(op, () => {
          currentMode = 'pill'
          finish(op, currentPlacement)
        }, fadeMs)
        return
      }
      // Eased bounds animation with an owned interval.
      const ease = req.mode === 'pill' ? easeClose : easeOpen
      const t0 = Date.now()
      const entry = { t: null as unknown, kind: 'interval' as const }
      entry.t = timers.setInterval(() => {
        if (op !== active || win.isDestroyed()) return
        const u = Math.min(1, (Date.now() - t0) / durationMs)
        win.setBounds(lerpRect(from, target, ease(u)), false)
        if (u >= 1) {
          timers.clearInterval(entry.t)
          op.timers.delete(entry)
          win.setBounds(target, false)
          finish(op, placement)
        }
      }, TICK_MS)
      op.timers.add(entry)
    })
  }

  /**
   * Shrink the glass frame to the saved pill in one move — only for the current close.
   * The renderer hides its content first, so a macOS frame that paints the new size before
   * the new origin is fully transparent. No hide/park/show: macOS animates hide, which put
   * a fading pill at the panel's corner and left the pill missing for ~0.25 s.
   */
  function restoreToSavedPill(win: BrowserWindow, gen?: number): Rect | null {
    if (gen != null && gen !== generation) return null
    const saved = savedPillRect ?? visualPillRect(win.getBounds())
    currentMode = 'pill'
    currentInsets = 0
    currentPlacement = 'above'
    win.setBounds(saved, false)
    // The old hide also resigned focus; keep that so keystrokes return to the user's app
    // after the dropdown closes (no visibility change, content still hidden).
    if (win.isFocused()) win.blur()
    pillAnchor = { x: saved.x + saved.width, y: saved.y + saved.height }
    return saved
  }

  /** End a gesture owned by `win` (token must match when given). Idempotent. */
  function dragEnd(win: BrowserWindow | null, token?: number | null): boolean {
    if (!win) return false
    const g = gestures.get(win)
    if (!g || (token != null && token !== g.token)) return false
    timers.clearInterval(g.interval)
    g.detach()
    gestures.delete(win)
    if (win === deps.pill() && !win.isDestroyed()) {
      // The final anchor is where the user dropped it; restore must not use an older rect.
      const bounds = win.getBounds()
      if (currentMode !== 'panel') {
        pillAnchor = pillAnchorFromBounds(bounds)
        savedPillRect = visualPillRect(bounds)
        deps.persistAnchor({ x: pillAnchor.x, y: pillAnchor.y })
      }
      if (ddOpen) placeDropdown()
      if (pendingBounds) {
        const req = pendingBounds
        pendingBounds = null
        void applyBounds(win, req)
      }
    }
    return true
  }

  /** Start a cursor-following drag owned by `win`. Returns the gesture token. */
  function dragStart(
    win: BrowserWindow,
    payload: { x: number; y: number; collapseToPill?: boolean }
  ): number {
    dragEnd(win)
    const isPill = win === deps.pill()
    if (isPill) {
      // Adopt the displayed geometry: no superseded morph may move the window mid-drag.
      supersede()
      generation += 1
      const b = win.getBounds()
      const oversized = b.width > PILL_W + 4 || b.height > PILL_H + 4
      if (payload?.collapseToPill !== false && (currentMode !== 'pill' || oversized)) {
        pillAnchor = pillAnchorFromBounds(b)
        void applyBounds(win, { w: PILL_W, h: PILL_H, mode: 'pill' })
      }
    }
    const cursor0 = deps.cursor()
    const b0 = win.getBounds()
    const grab = { x: cursor0.x - b0.x, y: cursor0.y - b0.y }
    const freezeAnchor = isPill && currentMode === 'panel'
    const token = ++tokenSeq
    const end = () => dragEnd(win, token)
    win.once('blur', end)
    win.once('closed', end)
    const interval = timers.setInterval(() => {
      if (win.isDestroyed()) return end()
      const c = deps.cursor()
      win.setPosition(Math.round(c.x - grab.x), Math.round(c.y - grab.y))
      if (isPill && !freezeAnchor) pillAnchor = pillAnchorFromBounds(win.getBounds())
      if (isPill && ddOpen) placeDropdown()
    }, TICK_MS)
    gestures.set(win, {
      token,
      win,
      interval,
      detach: () => {
        win.removeListener('blur', end)
        win.removeListener('closed', end)
      }
    })
    return token
  }

  async function setBoundsFromRenderer(win: BrowserWindow, req: BoundsRequest): Promise<TransitionAck> {
    if (gestures.has(win)) {
      // Collapse-to-pill during drag applies immediately (never drag a glass shell with
      // the pill painted under the panel); other resizes wait for the drop.
      if (req.mode === 'pill') {
        pendingBounds = null
        return applyBounds(win, req)
      }
      pendingBounds = req
      return ack(generation)
    }
    return applyBounds(win, req)
  }

  // ── M1-HF3: one reusable dropdown window anchored beside the stationary pill ──
  // Dropdown operations read the pill's rect and never move, resize, hide, show or fade it.
  // Only a deliberate pill drag moves the anchor; the dropdown follows it.
  // States: closed → loading (create, load, renderer ready) → open → closed. A failed or
  // never-ready child is destroyed; the next explicit open builds one replacement.

  type Child = { win: BrowserWindow; ready: boolean; detach: () => void }
  let dd: Child | null = null
  let ddGen = 0
  let ddOpen = false
  let ddSize = { w: 0, h: 0 }
  let ddPlacement: Placement = 'above'
  let ddBounds: Rect | null = null
  /** The latest open waiting for readiness; an older one settles as superseded. */
  let ddPending: { gen: number; settle: (a: DropdownAck) => void } | null = null
  let readyDeadline: unknown = null
  let focusCheck: unknown = null
  let detachPillFocus: (() => void) | null = null

  function ddAck(gen: number, error?: DropdownError): DropdownAck {
    return {
      generation: gen,
      current: gen === ddGen,
      open: ddOpen,
      placement: ddPlacement,
      bounds: ddBounds ? { ...ddBounds } : null,
      ...(error ? { error } : {})
    }
  }

  function settlePending(error?: DropdownError) {
    const p = ddPending
    ddPending = null
    p?.settle(ddAck(p.gen, error))
  }

  function notifyClosed(reason: DropdownClosed['reason'], error?: DropdownError) {
    deps.onDropdownClosed?.({ generation: ddGen, reason, ...(error ? { error } : {}) })
  }

  const liveOwner = (): BrowserWindow | null => {
    const pill = deps.pill()
    return pill && !pill.isDestroyed() ? pill : null
  }
  const validSize = (n: number) => Number.isFinite(n) && n > 0

  /**
   * Dropdown rect beside the pill's actual rect: the panel is fitted (it scrolls), never the
   * pill. Null when the work area cannot hold a usable panel.
   */
  function dropdownRect(pill: Rect, w: number, h: number): { rect: Rect; placement: Placement } | null {
    const wa = deps.workAreaNear({ x: pill.x + pill.width, y: pill.y + pill.height })
    const roomAbove = pill.y - DROPDOWN_GAP - wa.y
    const roomBelow = wa.y + wa.height - (pill.y + pill.height + DROPDOWN_GAP)
    // Same rule as the glass frame: below when the pill sits in the upper half, or when the
    // panel does not fit above and there is more room below.
    const placement: Placement =
      pill.y < wa.y + wa.height / 2 || (h > roomAbove && roomBelow > roomAbove) ? 'below' : 'above'
    const width = Math.min(w, wa.width)
    const height = Math.min(h, placement === 'below' ? roomBelow : roomAbove)
    if (width <= 0 || height < Math.min(h, DROPDOWN_MIN_H)) return null
    const x = Math.min(Math.max(pill.x + pill.width - width, wa.x), wa.x + wa.width - width)
    const y = placement === 'below' ? pill.y + pill.height + DROPDOWN_GAP : pill.y - DROPDOWN_GAP - height
    return { rect: { x, y, width, height }, placement }
  }

  /** Fit the child beside the pill. False when there is no owner or no usable room. */
  function placeDropdown(): boolean {
    const pill = liveOwner()
    if (!dd || dd.win.isDestroyed() || !pill) return false
    const fit = dropdownRect(pill.getBounds(), ddSize.w, ddSize.h)
    if (!fit) return false
    ddPlacement = fit.placement
    const b = ddBounds
    const r = fit.rect
    if (b && b.x === r.x && b.y === r.y && b.width === r.width && b.height === r.height) return true
    ddBounds = r
    dd.win.setBounds(r, false)
    return true
  }

  function cancelReadyDeadline() {
    if (readyDeadline == null) return
    timers.clearTimeout(readyDeadline)
    readyDeadline = null
  }

  function cancelFocusCheck() {
    if (focusCheck == null) return
    timers.clearTimeout(focusCheck)
    focusCheck = null
  }

  /** Pill and dropdown are one focus group: close only once focus is outside both. */
  function scheduleFocusCheck() {
    if (!ddOpen) return
    cancelFocusCheck()
    focusCheck = timers.setTimeout(() => {
      focusCheck = null
      const inside = (w: BrowserWindow | null | undefined) => !!w && !w.isDestroyed() && w.isFocused()
      if (ddOpen && !inside(deps.pill()) && !inside(dd?.win)) closeInternal('outside')
    }, FOCUS_SETTLE_MS)
  }

  function attachPillFocus() {
    const pill = liveOwner()
    if (detachPillFocus || !pill) return
    pill.on('blur', scheduleFocusCheck)
    pill.on('focus', cancelFocusCheck)
    detachPillFocus = () => {
      pill.removeListener('blur', scheduleFocusCheck)
      pill.removeListener('focus', cancelFocusCheck)
    }
  }

  /** Destroy a failed child; stale failures of an older child are ignored. */
  function failChild(entry: Child, error: DropdownError) {
    if (dd !== entry) return
    entry.detach()
    dd = null
    ddBounds = null
    cancelReadyDeadline()
    cancelFocusCheck()
    const wasActive = ddOpen || !!ddPending
    ddOpen = false
    settlePending(error)
    if (!entry.win.isDestroyed()) entry.win.destroy()
    if (wasActive) notifyClosed('failed', error)
  }

  function reveal(entry: Child) {
    if (entry.win.isDestroyed()) return
    if (!liveOwner()) {
      ddOpen = false
      settlePending('no_owner')
      return
    }
    if (!placeDropdown()) {
      ddOpen = false
      settlePending('no_room')
      return
    }
    if (!entry.win.isVisible()) entry.win.show()
    // Opening is always a request on Gray's pill: the panel takes keyboard focus (Escape,
    // controls), so the pair's focus group starts inside it.
    if (!entry.win.isFocused()) entry.win.focus()
    settlePending()
  }

  function ensureDropdown(): Child | DropdownError {
    if (dd && !dd.win.isDestroyed()) return dd
    if (!deps.createDropdown) return 'unavailable'
    let made: { win: BrowserWindow; ready: Promise<unknown> }
    try {
      made = deps.createDropdown()
    } catch {
      return 'unavailable'
    }
    const { win, ready } = made
    const entry: Child = { win, ready: false, detach: () => {} }
    const onClosed = () => {
      if (dd !== entry) return
      entry.detach()
      dd = null
      ddBounds = null
      cancelReadyDeadline()
      cancelFocusCheck()
      const wasActive = ddOpen || !!ddPending
      ddOpen = false
      if (wasActive) {
        ddGen += 1
        settlePending('closed')
        notifyClosed('child_closed')
      }
    }
    win.on('blur', scheduleFocusCheck)
    win.on('focus', cancelFocusCheck)
    win.on('closed', onClosed)
    entry.detach = () => {
      win.removeListener('blur', scheduleFocusCheck)
      win.removeListener('focus', cancelFocusCheck)
      win.removeListener('closed', onClosed)
    }
    dd = entry
    attachPillFocus()
    // Shown only for the latest open once ready; a dismissed request never reopens it.
    void Promise.resolve(ready).then(
      () => {
        if (dd !== entry) return
        entry.ready = true
        cancelReadyDeadline()
        if (ddOpen) reveal(entry)
      },
      () => failChild(entry, 'load_failed')
    )
    return entry
  }

  /** Show the dropdown for this size. Settles once visible, failed or superseded. */
  function openDropdown(size: { w: number; h: number }): Promise<DropdownAck> {
    const gen = ++ddGen
    settlePending()
    if (!validSize(size?.w) || !validSize(size?.h)) return Promise.resolve(ddAck(gen, 'invalid_size'))
    // A missing or destroyed owner gets nothing created or shown.
    if (!liveOwner()) return Promise.resolve(ddAck(gen, 'no_owner'))
    ddSize = { w: Math.round(size.w), h: Math.round(size.h) }
    const entry = ensureDropdown()
    if (typeof entry === 'string') return Promise.resolve(ddAck(gen, entry))
    ddOpen = true
    if (entry.ready) {
      reveal(entry)
      return Promise.resolve(ddAck(gen, ddOpen ? undefined : 'no_room'))
    }
    if (!placeDropdown() && liveOwner()) {
      ddOpen = false
      return Promise.resolve(ddAck(gen, 'no_room'))
    }
    if (readyDeadline == null) {
      // Failure bound, not a performance target: a child that never becomes ready is replaced.
      readyDeadline = timers.setTimeout(() => {
        readyDeadline = null
        if (dd === entry && !entry.ready) failChild(entry, 'timeout')
      }, DROPDOWN_READY_TIMEOUT_MS)
    }
    return new Promise((resolve) => {
      ddPending = { gen, settle: resolve }
    })
  }

  function closeInternal(reason: DropdownClosed['reason']) {
    if (!ddOpen && !ddPending) return
    ddGen += 1
    ddOpen = false
    cancelFocusCheck()
    cancelReadyDeadline()
    settlePending()
    if (dd && !dd.win.isDestroyed() && dd.win.isVisible()) dd.win.hide()
    notifyClosed(reason)
  }

  /** Hide (not fade or destroy) the dropdown. The pill window is not touched. */
  function closeDropdown(): DropdownAck {
    closeInternal('request')
    return ddAck(ddGen)
  }

  /** Measured content height: refit the open dropdown; a closed one only remembers it. */
  function resizeDropdown(h: number): DropdownAck {
    if (!validSize(h)) return ddAck(ddGen, 'invalid_size')
    ddSize = { ...ddSize, h: Math.round(h) }
    if (ddOpen) placeDropdown()
    return ddAck(ddGen)
  }

  /** Cancel and settle everything (window destroyed / teardown). Destroys only the dropdown. */
  function dispose() {
    supersede()
    generation += 1
    for (const g of gestures.values()) {
      timers.clearInterval(g.interval)
      g.detach()
    }
    gestures.clear()
    pendingBounds = null
    ddGen += 1
    ddOpen = false
    cancelFocusCheck()
    cancelReadyDeadline()
    settlePending('closed')
    detachPillFocus?.()
    detachPillFocus = null
    if (dd) {
      const w = dd.win
      dd.detach()
      dd = null
      ddBounds = null
      if (!w.isDestroyed()) w.destroy()
    }
  }

  /**
   * Pill window visibility/focus hooks. Park/restore hides are not user blurs; destruction
   * cancels and settles all owned work.
   */
  function attachPill(
    win: BrowserWindow,
    hooks: { onFocusChange?: (focused: boolean) => void; onHide?: () => void; onShow?: () => void } = {}
  ) {
    win.on('blur', () => hooks.onFocusChange?.(false))
    win.on('focus', () => hooks.onFocusChange?.(true))
    win.on('hide', () => hooks.onHide?.())
    win.on('show', () => hooks.onShow?.())
    win.on('closed', () => dispose())
  }

  return {
    attachPill,
    applyBounds,
    setBoundsFromRenderer,
    restoreToSavedPill,
    dragStart,
    dragEnd,
    dispose,
    setAnchor: (p: { x: number; y: number }) => {
      pillAnchor = p
    },
    openDropdown,
    closeDropdown,
    resizeDropdown,
    /** Read-only state for tests/harness. */
    inspect: () => ({
      dropdown: {
        open: ddOpen,
        generation: ddGen,
        exists: !!dd,
        ready: !!dd?.ready,
        placement: ddPlacement,
        bounds: ddBounds,
        focusCheck: focusCheck != null
      },
      mode: currentMode,
      placement: currentPlacement,
      anchor: pillAnchor,
      savedPillRect,
      generation,
      dragging: gestures.size > 0,
      animating: !!active,
      pillDriveLock,
      insets: currentInsets
    })
  }
}

export type WindowTransitions = ReturnType<typeof createWindowTransitions>

/** Pill window IPC — the same registration is used by the app and the smoke harness. */
export function registerTransitionIpc(
  ipc: Pick<IpcMain, 'handle'>,
  fromWebContents: (wc: WebContents) => BrowserWindow | null,
  ctl: WindowTransitions,
  pill: () => BrowserWindow | null
): void {
  const pillFor = (e: IpcMainInvokeEvent) => {
    const win = fromWebContents(e.sender)
    return win && win === pill() ? win : null
  }
  ipc.handle('window:setBounds', async (e, req: BoundsRequest): Promise<TransitionAck> => {
    const win = pillFor(e)
    if (!win) return { placement: 'above', generation: -1, current: false }
    return ctl.setBoundsFromRenderer(win, req)
  })
  ipc.handle('window:restorePill', (e, generation?: number) => {
    const win = pillFor(e)
    return win ? ctl.restoreToSavedPill(win, generation) : null
  })
  ipc.handle('pill:dragStart', (e, payload: { x: number; y: number; collapseToPill?: boolean }) => {
    const win = fromWebContents(e.sender)
    return win ? ctl.dragStart(win, payload) : null
  })
  ipc.handle('pill:dragEnd', (e, token?: number | null) => {
    return ctl.dragEnd(fromWebContents(e.sender), token)
  })
}

// ── M1-HF3: Record dropdown window factory and its narrow IPC (app and harnesses) ──

/** Location hash of the dropdown route and the preload surface argument main supplies. */
export const RECORD_DROPDOWN_HASH = 'record-dropdown'
export const RECORD_DROPDOWN_ARG = '--gray-surface=record-dropdown'
export const RECORD_DROPDOWN_W = 266
const RECORD_DROPDOWN_DEFAULT_H = 330
const RECORD_DROPDOWN_MAX_H = 2000
/** Replay refusal window per child lifetime. */
const MAX_RECENT_COMMANDS = 64
const COMMAND_ID = /^[A-Za-z0-9_-]{1,64}$/

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Pill → dropdown snapshot, bounded and typed; null when malformed. */
export function sanitizeDropdownSnapshot(raw: unknown): RecordDropdownSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.recordMode !== 'one-app' && r.recordMode !== 'full-screen') return null
  if (!Array.isArray(r.apps) || typeof r.selectedAppId !== 'string') return null
  for (const k of ['narrate', 'screenGranted', 'micGranted', 'busy']) if (typeof r[k] !== 'boolean') return null
  const apps = r.apps
    .slice(0, 32)
    .map((a) => {
      const o = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
      return { id: text(o.id, 64), name: text(o.name, 80), detail: text(o.detail, 80) }
    })
    .filter((a) => a.id)
  return {
    revision: Number.isFinite(r.revision) ? Number(r.revision) : 0,
    recordMode: r.recordMode,
    selectedAppId: text(r.selectedAppId, 64),
    narrate: r.narrate as boolean,
    apps,
    screenGranted: r.screenGranted as boolean,
    micGranted: r.micGranted as boolean,
    busy: r.busy as boolean
  }
}

/** Dropdown → pill command: exact allowed shapes only; app choices must be offered ones. */
export function sanitizeDropdownCommand(
  raw: unknown,
  snapshot: RecordDropdownSnapshot | null
): RecordDropdownCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !COMMAND_ID.test(r.id)) return null
  const id = r.id
  switch (r.type) {
    case 'setRecordMode':
      return r.value === 'one-app' || r.value === 'full-screen' ? { id, type: r.type, value: r.value } : null
    case 'selectApp':
      return typeof r.value === 'string' && !!snapshot?.apps.some((a) => a.id === r.value)
        ? { id, type: r.type, value: r.value }
        : null
    case 'setNarrate':
      return typeof r.value === 'boolean' ? { id, type: r.type, value: r.value } : null
    case 'start':
    case 'openScreenSettings':
    case 'openMicSettings':
      return { id, type: r.type }
    default:
      return null
  }
}

/**
 * The one Record dropdown: its hidden window factory (for the controller) and the IPC that
 * relays between it and the pill. The pill stays the only form/recording owner; the child
 * gets snapshots and may send explicit commands, measurements, dismissal and header drags.
 * Every message is checked against the exact current sender.
 */
export function createRecordDropdownWiring(o: {
  ipc: Pick<IpcMain, 'handle' | 'on'>
  BrowserWindow: new (opts: BrowserWindowConstructorOptions) => BrowserWindow
  preload: string
  load: (win: BrowserWindow) => Promise<unknown>
  pill: () => BrowserWindow | null
  ctl: () => WindowTransitions
}) {
  let child: BrowserWindow | null = null
  let markReady: (() => void) | null = null
  let snapshot: RecordDropdownSnapshot | null = null
  let measuredH = RECORD_DROPDOWN_DEFAULT_H
  let recent = new Set<string>()
  let dragToken: number | null = null

  const livePill = () => {
    const p = o.pill()
    return p && !p.isDestroyed() ? p : null
  }
  const fromPill = (e: IpcMainEvent | IpcMainInvokeEvent) => {
    const p = livePill()
    return !!p && e.sender === p.webContents
  }
  const fromChild = (e: IpcMainEvent | IpcMainInvokeEvent) =>
    !!child && !child.isDestroyed() && e.sender === child.webContents

  function endDrag() {
    const token = dragToken
    dragToken = null
    if (token != null) o.ctl().dragEnd(livePill(), token)
  }

  function create(): { win: BrowserWindow; ready: Promise<unknown> } {
    const win = new o.BrowserWindow({
      width: RECORD_DROPDOWN_W,
      height: measuredH,
      ...PILL_WINDOW_OPTIONS,
      show: false,
      webPreferences: {
        preload: o.preload,
        sandbox: false,
        contextIsolation: true,
        additionalArguments: [RECORD_DROPDOWN_ARG]
      }
    })
    child = win
    recent = new Set()
    win.setWindowButtonVisibility?.(false)
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: false })
    win.setAlwaysOnTop(true, 'floating')
    win.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }))
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve
      // Content-free: no URL, title or native error payload is kept.
      win.webContents.once('did-fail-load', () => reject(new Error('load_failed')))
      win.webContents.once('render-process-gone', () => reject(new Error('load_failed')))
      o.load(win).catch(() => reject(new Error('load_failed')))
    })
    // After readiness, a renderer crash closes only this child (never the pill or capture).
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.destroy()
    })
    win.on('blur', endDrag)
    // A reloaded/navigated pill renderer starts idle: never leave its dropdown showing.
    // Kept by reference: a destroyed pill window no longer exposes its webContents.
    const ownerContents = livePill()?.webContents ?? null
    const ownerNavigated = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (details?.isMainFrame !== false && !details?.isSameDocument) o.ctl().closeDropdown()
    }
    ownerContents?.on('did-start-navigation', ownerNavigated as never)
    win.on('closed', () => {
      if (ownerContents && !ownerContents.isDestroyed()) {
        ownerContents.removeListener('did-start-navigation', ownerNavigated as never)
      }
      if (child !== win) return
      endDrag()
      child = null
      markReady = null
      recent = new Set()
    })
    return { win, ready }
  }

  function notifyClosed(event: DropdownClosed) {
    livePill()?.webContents.send('dropdown:closed', event)
  }

  o.ipc.handle('dropdown:open', (e): Promise<DropdownAck> | DropdownAck => {
    if (!fromPill(e)) return { generation: -1, current: false, open: false, placement: 'above', bounds: null, error: 'no_owner' }
    return o.ctl().openDropdown({ w: RECORD_DROPDOWN_W, h: measuredH })
  })
  o.ipc.handle('dropdown:close', (e): DropdownAck | null => (fromPill(e) ? o.ctl().closeDropdown() : null))
  o.ipc.on('dropdown:snapshot', (e, raw: unknown) => {
    if (!fromPill(e)) return
    const next = sanitizeDropdownSnapshot(raw)
    if (!next) return
    snapshot = next
    if (child && !child.isDestroyed()) child.webContents.send('dropdown:snapshot', snapshot)
  })
  o.ipc.on('dropdown:hello', (e) => {
    if (fromChild(e) && snapshot) child!.webContents.send('dropdown:snapshot', snapshot)
  })
  o.ipc.on('dropdown:measured', (e, h: unknown) => {
    if (!fromChild(e) || typeof h !== 'number' || !Number.isFinite(h) || h < 40 || h > RECORD_DROPDOWN_MAX_H) return
    measuredH = Math.round(h)
    o.ctl().resizeDropdown(measuredH)
  })
  o.ipc.on('dropdown:ready', (e) => {
    if (!fromChild(e)) return
    markReady?.()
    markReady = null
  })
  o.ipc.on('dropdown:command', (e, raw: unknown) => {
    if (!fromChild(e)) return
    const cmd = sanitizeDropdownCommand(raw, snapshot)
    if (!cmd || recent.has(cmd.id)) return
    recent.add(cmd.id)
    if (recent.size > MAX_RECENT_COMMANDS) recent.delete(recent.values().next().value as string)
    livePill()?.webContents.send('dropdown:command', cmd)
  })
  o.ipc.on('dropdown:dismiss', (e) => {
    if (fromChild(e)) o.ctl().closeDropdown()
  })
  // Header drag moves the pair through the pill's own gesture owner and anchor.
  o.ipc.handle('dropdown:dragStart', (e): number | null => {
    const p = livePill()
    if (!fromChild(e) || !p) return null
    endDrag()
    dragToken = o.ctl().dragStart(p, { x: 0, y: 0, collapseToPill: false })
    return dragToken
  })
  o.ipc.handle('dropdown:dragEnd', (e, token: unknown): boolean => {
    if (!fromChild(e) || token == null || token !== dragToken) return false
    endDrag()
    return true
  })

  return {
    create,
    notifyClosed,
    /** Read-only state for tests/harness. */
    inspect: () => ({ child, snapshot, measuredH, recentCommands: recent.size, dragging: dragToken != null })
  }
}
