/**
 * One source of truth for the pill window's geometry (Figma: Hero · Pill *, v4 desktop frames).
 *
 * Pill mode: the window is exactly the 36px capsule. Panel mode: the panel sits above the
 * pill (8px gap) and the pill stays where it was — the window adds a 36px shadow inset on the
 * sides and pill edge (main's PANEL_PADDING, which keeps the pill on its anchor) and a 16px
 * shadow room on the far edge.
 */

export const PILL_H = 36
/** Must equal main's PANEL_PADDING so the pill keeps its screen position inside a panel window. */
export const PANEL_PAD = 36
export const PANEL_FAR_PAD = 16
export const PILL_GAP = 8

export type PillKind =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'running'
  | 'needs'
  | 'error'
  | 'thinking'
  | 'saved'
  | 'permission'
  | 'editing'
  | 'done'

export const PILL_WIDTH: Record<PillKind, number> = {
  idle: 138,
  recording: 167,
  paused: 154,
  running: 167,
  needs: 144,
  error: 144,
  thinking: 151,
  saved: 223,
  permission: 138,
  editing: 138,
  done: 138
}

/** Surfaces that open above the pill. `run` covers running and its summary (one morphing card). */
export type SurfaceKind = 'ledger' | 'editor' | 'run' | 'toast'

/** Card widths and first-frame heights before the shell measures the real content. */
export const SURFACE_SIZE: Record<SurfaceKind, { w: number; h: number; maxH: number }> = {
  ledger: { w: 332, h: 180, maxH: 420 },
  editor: { w: 687, h: 581, maxH: 640 },
  run: { w: 476, h: 298, maxH: 520 },
  toast: { w: 338, h: 129, maxH: 260 }
}
export const SUMMARY_W = 397

/** Durations the window waits for before it shrinks (CSS owns the visible motion). */
export const PILL_MORPH_MS = 400
export const SURFACE_EXIT_MS = 400

export function panelWindowSize(cardW: number, cardH: number, pillW: number) {
  return {
    w: Math.ceil(Math.max(cardW, pillW) + PANEL_PAD * 2),
    h: Math.ceil(PANEL_FAR_PAD + cardH + PILL_GAP + PILL_H + PANEL_PAD)
  }
}

/** Which pill face the current state shows (shared with the shell's window sizing). */
export function pillKindFor(s: {
  state: string
  recordPaused: boolean
  hasErrorHold: boolean
  hasQuestionHold: boolean
  permissionHold: boolean
  permissionPaused: boolean
  savedConfirm: boolean
  summaryDone: boolean
}): PillKind {
  switch (s.state) {
    case 'recording':
      return s.recordPaused ? 'paused' : 'recording'
    case 'organizing':
      return 'thinking'
    case 'editor':
      return 'editing'
    case 'running':
      if (s.hasErrorHold) return 'error'
      if (s.hasQuestionHold || s.permissionHold) return 'needs'
      return 'running'
    case 'summary':
      return s.summaryDone ? 'done' : 'idle'
    default:
      if (s.permissionPaused) return 'permission'
      if (s.savedConfirm) return 'saved'
      return 'idle'
  }
}

/** The surface the current state opens above the pill (null = pill only). */
export function surfaceFor(s: {
  state: string
  watchExpanded: boolean
  editorCollapsed: boolean
  runCollapsed: boolean
  toast: boolean
}): SurfaceKind | null {
  if (s.state === 'recording' && s.watchExpanded) return 'ledger'
  if (s.state === 'editor' && !s.editorCollapsed) return 'editor'
  if ((s.state === 'running' && !s.runCollapsed) || s.state === 'summary') return 'run'
  if (s.toast) return 'toast'
  return null
}
