import { config as loadDotenv } from 'dotenv'
import { app, shell, BrowserWindow, ipcMain, screen, Menu, globalShortcut } from 'electron'
import { join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'

// Load project .env into process.env before telemetry/config reads it.
// electron-vite does not reliably inject non-VITE_ vars into the main process.
loadDotenv({ path: resolve(process.cwd(), '.env') })
import {
  getSnapshot,
  getWorkflow,
  loadStore,
  registerStoreIpc,
  setLastPermissionRevokeAt,
  setOnboardingComplete,
  setOnboardingStep,
  setPillPosition,
  setSession,
  setTeam
} from './store'
import { createTray, destroyTray, setTrayMode } from './tray'
import {
  getPermissions,
  registerPermissionIpc,
  setBeforeOpenSettings,
  startPermissionWatch,
  stopPermissionWatch
} from './permissions'
import { googleAuth, isValidEmail, sessionForEmail } from './auth'
import {
  createTeam,
  inviteToTeam,
  isValidInviteCode,
  removeMember,
  renameTeam,
  resendInvite,
  revokeInvite,
  teamFromInvite
} from './team'
import { newId } from '../shared/id'
import type { DeepLink, PermissionsState } from '../shared/types'
import {
  flushTelemetryOnQuit,
  initTelemetry,
  registerTelemetryIpc
} from './telemetry'

let pillWindow: BrowserWindow | null = null
let workspaceWindow: BrowserWindow | null = null
// Native-blur backdrops. Vibrancy always fills a whole window, so one window
// behind the pill and one behind the panel give real background blur on each
// glass shape while the gap between them stays fully transparent.
let pillBackdrop: BrowserWindow | null = null
let panelBackdrop: BrowserWindow | null = null
/** Fullscreen ink-20 dim behind the expanded editor. */
let editorScrim: BrowserWindow | null = null
/** Fullscreen onboarding overlay — the hard gate before pill/workspace. */
let onboardingWindow: BrowserWindow | null = null
/** Pending Library deep-link until the workspace window finishes loading. */
let pendingWorkspaceFocus: { workflowId?: string; runId?: string } | null = null
/** Deep-link held until the onboarding window finishes loading. */
let pendingDeepLink: DeepLink | null = null
/** True once the app is actually quitting (lets the gated window close). */
let isQuitting = false
/** Global shortcuts are registered once, only in normal (post-onboarding) mode. */
let shortcutsRegistered = false
/** Last AppState reported by the pill (for context-menu recording variant). */
let pillAppState: string = 'idle'
/** True while the onboarding overlay is hidden so System Settings can be used. */
let overlayDemotedForSettings = false

const PILL_W = 94
const PILL_H = 24
const MARGIN = 24
/** CSS gap between the panel slot and the pill in glass mode. */
const GLASS_GAP = 8
/** Backdrops sit 1px inside the CSS tint so corner radii never poke out. */
const BACKDROP_INSET = 1

/** Content size of the Library card (matches `.workspace-window`). */
const WORKSPACE_CONTENT_W = 807
const WORKSPACE_CONTENT_H = 549
/**
 * Transparent inset so the CSS shadow (blur 30 + `#3E2B49` @ 20%) can paint
 * outside the opaque card — Electron clips shadows to the window bounds.
 */
const WORKSPACE_SHADOW_PAD = 36
const WORKSPACE_W = WORKSPACE_CONTENT_W + WORKSPACE_SHADOW_PAD * 2
const WORKSPACE_H = WORKSPACE_CONTENT_H + WORKSPACE_SHADOW_PAD * 2

// ── Custom URL scheme (magic-link + invite-link return paths) ──
// Single-instance so a second `ghost://` launch routes into the running app.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => a.startsWith('ghost://'))
    if (url) handleDeepLink(url)
    onboardingWindow?.focus()
  })
}
if (is.dev && process.platform === 'win32') {
  app.setAsDefaultProtocolClient('ghost', process.execPath, [join(__dirname, '..', '..')])
} else {
  app.setAsDefaultProtocolClient('ghost')
}
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleDeepLink(url)
})
app.on('before-quit', () => {
  isQuitting = true
})

function getBottomRightBounds(width: number, height: number) {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  return {
    x: sw - width - MARGIN,
    y: sh - height - MARGIN,
    width,
    height
  }
}

function initialPillBounds() {
  const saved = getSnapshot().pillPosition
  if (saved) {
    return {
      x: Math.round(saved.x - PILL_W),
      y: Math.round(saved.y - PILL_H),
      width: PILL_W,
      height: PILL_H
    }
  }
  return getBottomRightBounds(PILL_W, PILL_H)
}

function createPillWindow() {
  const bounds = initialPillBounds()
  pillAnchor = { x: bounds.x + bounds.width, y: bounds.y + bounds.height }

  pillWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    acceptFirstMouse: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Frameless + no traffic lights (titleBarStyle: 'hidden' would show close/min).
  pillWindow.setWindowButtonVisibility(false)
  pillWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  pillWindow.setAlwaysOnTop(true, 'floating')

  pillWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    pillWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    pillWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  pillWindow.on('closed', () => {
    pillWindow = null
  })

  pillWindow.on('blur', () => onPillFocusChange(false))
  pillWindow.on('focus', () => onPillFocusChange(true))

  // Backdrops shadow the pill window's visibility exactly.
  pillWindow.on('hide', () => {
    hideBackdrops()
    editorScrim?.setOpacity(0)
  })
  pillWindow.on('show', () => {
    if (pillWindow) layoutBackdrops(pillWindow.getBounds())
    applyEditorScrim()
  })
}

/**
 * A vibrancy-only window that paints frosted blur behind one glass shape.
 * It never takes focus or mouse events; z-order is fixed once at startup
 * (below the pill window) and visibility is driven via opacity so showing
 * and hiding never re-stacks windows mid-animation.
 */
function createBackdrop(): BrowserWindow {
  const win = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    vibrancy: 'hud',
    // Keep the frost when unfocused — 'followWindow' goes opaque on blur.
    visualEffectState: 'active'
  })
  win.setIgnoreMouseEvents(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
  win.setAlwaysOnTop(true, 'floating')
  win.setOpacity(0)
  win.loadURL('about:blank')
  return win
}

function createBackdrops() {
  pillBackdrop = createBackdrop()
  panelBackdrop = createBackdrop()
  pillBackdrop.showInactive()
  panelBackdrop.showInactive()
  // Fix stacking once: material windows sit just below the content window.
  pillWindow?.moveTop()
}

function hideBackdrops() {
  pillBackdrop?.setOpacity(0)
  panelBackdrop?.setOpacity(0)
}

/**
 * Position the blur shapes under the pill strip and the panel slot for the
 * given pill-window bounds. Called on every window move/resize tick so the
 * material tracks the CSS silhouettes through morphs and drags.
 */
function layoutBackdrops(b: Rect) {
  if (!pillBackdrop || !panelBackdrop) return
  if (!pillWindow || !pillWindow.isVisible() || currentMode === 'panel') {
    hideBackdrops()
    return
  }
  const inset = BACKDROP_INSET
  const below = currentMode === 'glass' && currentPlacement === 'below'
  const pillTop = currentMode === 'pill' || below ? b.y : b.y + b.height - PILL_HEIGHT
  // Glass mode: pill blur stays compact (PILL_W) at the trailing edge —
  // never stretch to the panel / window width.
  const pillW = currentMode === 'glass' ? PILL_W : b.width
  const pillX = currentMode === 'glass' ? b.x + b.width - pillW : b.x
  pillBackdrop.setBounds(
    {
      x: pillX + inset,
      y: pillTop + inset,
      width: Math.max(1, pillW - inset * 2),
      height: Math.max(1, Math.min(PILL_HEIGHT, b.height) - inset * 2)
    },
    false
  )
  pillBackdrop.setOpacity(1)

  const panelH = currentMode === 'glass' ? b.height - PILL_HEIGHT - GLASS_GAP : 0
  if (panelH < 6) {
    panelBackdrop.setOpacity(0)
    return
  }
  panelBackdrop.setBounds(
    {
      x: b.x + inset,
      y: (below ? b.y + PILL_HEIGHT + GLASS_GAP : b.y) + inset,
      width: Math.max(1, b.width - inset * 2),
      height: Math.max(1, panelH - inset * 2)
    },
    false
  )
  panelBackdrop.setOpacity(1)
}

function sendWorkspaceFocus(focus: { workflowId?: string; runId?: string } | null) {
  if (!workspaceWindow || !focus) return
  workspaceWindow.webContents.send('workspace:focus', focus)
  // Back-compat for older listeners.
  if (focus.workflowId) {
    workspaceWindow.webContents.send('workspace:focusWorkflow', focus.workflowId)
  }
}

function normalizeWorkspaceFocus(
  focus?: string | { workflowId?: string; runId?: string }
): { workflowId?: string; runId?: string } | null {
  if (!focus) return null
  if (typeof focus === 'string') return { workflowId: focus }
  if (focus.workflowId || focus.runId) return focus
  return null
}

function openWorkspaceWindow(focus?: string | { workflowId?: string; runId?: string }) {
  // Hard gate — Library is unavailable until onboarding completes.
  if (!getSnapshot().onboardingComplete) return

  const normalized = normalizeWorkspaceFocus(focus)
  if (normalized) pendingWorkspaceFocus = normalized

  if (workspaceWindow) {
    workspaceWindow.show()
    workspaceWindow.focus()
    if (pendingWorkspaceFocus) {
      sendWorkspaceFocus(pendingWorkspaceFocus)
      pendingWorkspaceFocus = null
    }
    return
  }

  workspaceWindow = new BrowserWindow({
    width: WORKSPACE_W,
    height: WORKSPACE_H,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  workspaceWindow.webContents.on('did-finish-load', () => {
    if (pendingWorkspaceFocus) {
      sendWorkspaceFocus(pendingWorkspaceFocus)
      pendingWorkspaceFocus = null
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    workspaceWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#workspace`)
  } else {
    workspaceWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'workspace' })
  }

  workspaceWindow.on('closed', () => {
    workspaceWindow = null
  })
}

function showPill() {
  if (!pillWindow) createPillWindow()
  pillWindow?.show()
  pillWindow?.focus()
}

function hidePill() {
  pillWindow?.hide()
}

/** Desired scrim visibility from the renderer — applied only while pill is frontmost. */
let editorScrimWanted = false

function setEditorScrimVisible(visible: boolean) {
  editorScrimWanted = visible
  applyEditorScrim()
}

function applyEditorScrim() {
  const show = editorScrimWanted && Boolean(pillWindow?.isVisible()) && Boolean(pillWindow?.isFocused())
  if (!show) {
    editorScrim?.setOpacity(0)
    return
  }
  if (!editorScrim) {
    const { x, y, width, height } = screen.getPrimaryDisplay().bounds
    editorScrim = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#00000000'
    })
    editorScrim.setIgnoreMouseEvents(true)
    editorScrim.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })
    editorScrim.setAlwaysOnTop(true, 'floating')
    // ink-20 = rgba(22, 20, 39, 0.20)
    editorScrim.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:rgba(22,20,39,0.20);width:100vw;height:100vh;"></body></html>'
        )
    )
    editorScrim.showInactive()
    editorScrim.setOpacity(0)
  }
  const { x, y, width, height } = screen.getPrimaryDisplay().bounds
  editorScrim.setBounds({ x, y, width, height }, false)
  editorScrim.setOpacity(1)
  // Keep the pill above the scrim.
  pillWindow?.moveTop()
}

/**
 * Summary can sit behind other apps when the user focuses them; other pill
 * states stay always-on-top. Vibrancy backdrops hide on blur so they don't
 * paint a gray box over the desktop / other windows.
 */
function onPillFocusChange(focused: boolean) {
  applyEditorScrim()
  if (!pillWindow) return
  if (focused) {
    if (pillAppState === 'summary') {
      pillWindow.setAlwaysOnTop(true, 'floating')
      pillWindow.moveTop()
    }
    layoutBackdrops(pillWindow.getBounds())
  } else {
    hideBackdrops()
    if (pillAppState === 'summary') {
      pillWindow.setAlwaysOnTop(false)
    }
  }
}

// ── IPC: pill window sizing ──
// The pill's bottom-right corner is tracked as a persistent screen anchor:
// resizes never derive it from live bounds (which drift mid-drag), resizes
// are instant (animation moved the window under a stationary cursor, causing
// the hover flicker loop), and resizes are deferred while a drag is active.
// Modes: 'pill' and 'glass' windows hug their content; all modes are plain
// transparent windows — the pill and panel each paint their own CSS glass,
// so the gap between them stays fully see-through.
type BoundsRequest = {
  w: number
  h: number
  mode: 'pill' | 'glass' | 'panel'
  /** Ease window bounds over this many ms. */
  durationMs?: number
  /**
   * Pill-driven morph: the pill BR is the only anchor. Open jumps to the full
   * glass frame and returns placement immediately (so above/below CSS matches
   * geometry). Close fades the panel then snaps to pill size.
   */
  pillDrive?: boolean
  /** Center in the display work area instead of anchoring to the pill BR. */
  center?: boolean
}
type Placement = 'above' | 'below'
type Rect = { x: number; y: number; width: number; height: number }

const PANEL_PADDING = 36
const PILL_HEIGHT = 24
/** Screen position of the pill's bottom-right corner. */
let pillAnchor: { x: number; y: number } | null = null
/** Content inset of the current window mode (0 = pill fills the window). */
let currentInsets = 0
let pendingBounds: BoundsRequest | null = null
/** Last applied panel placement — needed so drag syncs the pill BR correctly. */
let currentPlacement: Placement = 'above'
let currentMode: BoundsRequest['mode'] = 'pill'
let boundsAnimTimer: ReturnType<typeof setInterval> | null = null
/** True for the whole pill-drive open/close (both phases). */
let pillDriveLock = false

function cancelBoundsAnim() {
  if (boundsAnimTimer) {
    clearInterval(boundsAnimTimer)
    boundsAnimTimer = null
  }
}

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

/** Window rect whose bottom-right (or pill strip) stays on the pill anchor. */
function rectFromPillAnchor(
  anchor: { x: number; y: number },
  width: number,
  height: number,
  placement: Placement,
  insets: number
): Rect {
  const x = anchor.x + insets - width
  if (placement === 'below' && height > PILL_HEIGHT) {
    return {
      x,
      y: anchor.y - PILL_HEIGHT - insets,
      width,
      height
    }
  }
  return {
    x,
    y: anchor.y + insets - height,
    width,
    height
  }
}

/** All pill-window bounds go through here so the blur backdrops track them. */
function setPillBounds(win: BrowserWindow, rect: Rect) {
  win.setBounds(rect, false)
  layoutBackdrops(rect)
}

function runBoundsEase(
  win: BrowserWindow,
  from: Rect,
  to: Rect,
  durationMs: number,
  ease: (t: number) => number,
  onDone?: () => void
) {
  if (durationMs <= 0) {
    setPillBounds(win, to)
    onDone?.()
    return
  }
  const t0 = Date.now()
  boundsAnimTimer = setInterval(() => {
    const u = Math.min(1, (Date.now() - t0) / durationMs)
    const e = ease(u)
    setPillBounds(win, lerpRect(from, to, e))
    if (u >= 1) {
      cancelBoundsAnim()
      setPillBounds(win, to)
      onDone?.()
    }
  }, 16)
}

function ensurePillAnchor(win: BrowserWindow): { x: number; y: number } {
  if (!pillAnchor) {
    const b = win.getBounds()
    pillAnchor = { x: b.x + b.width - currentInsets, y: b.y + b.height - currentInsets }
  }
  return pillAnchor
}

/** Pill bottom-right derived from live window bounds + placement. */
function pillAnchorFromBounds(b: {
  x: number
  y: number
  width: number
  height: number
}): { x: number; y: number } {
  const right = b.x + b.width - currentInsets
  if (currentPlacement === 'below' && currentMode !== 'pill') {
    // Panel sits under the pill — pill BR is at the top strip of the window.
    return { x: right, y: b.y + currentInsets + PILL_HEIGHT }
  }
  return { x: right, y: b.y + b.height - currentInsets }
}

function pillAnchorFromWindow(win: BrowserWindow): { x: number; y: number } {
  return pillAnchorFromBounds(win.getBounds())
}

function applyBounds(win: BrowserWindow, req: BoundsRequest): Placement | Promise<Placement> {
  const width = Math.round(req.w)
  const height = Math.round(req.h)
  const durationMs = Math.max(0, req.durationMs ?? 0)

  // Never let a trivial glass height "correction" cancel an in-flight
  // pill-drive morph — that was killing the vertical expansion mid-way.
  if (pillDriveLock && durationMs <= 0 && req.mode === 'glass' && !req.pillDrive) {
    pendingBounds = req
    return currentPlacement
  }

  cancelBoundsAnim()
  if (req.pillDrive && durationMs > 0) pillDriveLock = true
  else pillDriveLock = false
  const anchorBefore = { ...ensurePillAnchor(win) }
  const prevBounds = win.getBounds()
  const wa = screen.getDisplayNearestPoint(anchorBefore).workArea
  const insets = req.mode === 'panel' ? PANEL_PADDING : 0
  const pillDrive = !!req.pillDrive && durationMs > 0

  let placement: Placement = 'above'
  let trial: Rect

  if (req.center) {
    // Center in the work area; leave pillAnchor untouched so the pill returns
    // to its spot when this panel closes (drag still re-syncs the anchor).
    trial = {
      x: Math.round(wa.x + (wa.width - width) / 2),
      y: Math.round(wa.y + (wa.height - height) / 2),
      width,
      height
    }
    placement = 'above'
  } else {
    // Prefer the panel directly above the pill; if that would leave the work
    // area (obstructed), open below the pill instead.
    trial = rectFromPillAnchor(anchorBefore, width, height, 'above', insets)
    if (req.mode !== 'pill' && trial.y < wa.y) {
      placement = 'below'
      trial = rectFromPillAnchor(anchorBefore, width, height, 'below', insets)
      if (trial.y + height > wa.y + wa.height) {
        placement = 'above'
        trial = rectFromPillAnchor(anchorBefore, width, height, 'above', insets)
        trial.y = Math.max(wa.y, trial.y)
      }
    }
    trial.x = Math.min(Math.max(trial.x, wa.x), wa.x + wa.width - width)
  }

  currentInsets = insets
  currentPlacement = req.mode === 'pill' ? 'above' : placement
  currentMode = req.mode

  const target: Rect = trial
  const from: Rect = {
    x: prevBounds.x,
    y: prevBounds.y,
    width: prevBounds.width,
    height: prevBounds.height
  }

  const alreadyThere =
    from.x === target.x &&
    from.y === target.y &&
    from.width === target.width &&
    from.height === target.height

  if (durationMs <= 0 || alreadyThere) {
    setPillBounds(win, target)
    return placement
  }

  if (pillDrive) {
    const opening = target.height > from.height + 4

    return new Promise((resolve) => {
      const releaseLock = () => {
        pillDriveLock = false
        if (opening && pendingBounds && pillWindow) {
          const pending = pendingBounds
          pendingBounds = null
          if (pending.h >= PILL_HEIGHT + 40) {
            applyBounds(pillWindow, { ...pending, durationMs: 0, pillDrive: false })
          }
        }
      }

      if (opening) {
        // Instant full glass frame pinned to the pill BR.
        setPillBounds(win, target)
        // Resolve placement immediately so renderer applies above/below CSS
        // before the fade — delayed resolve caused below opens to paint as
        // above then teleport.
        resolve(placement)
        setTimeout(releaseLock, durationMs)
      } else {
        // Close: let the panel CSS-fade, then snap to pill size. Animating
        // height at full width left a 266×24 strip (close glitch).
        const fadeMs = Math.min(200, Math.max(120, durationMs))
        setTimeout(() => {
          setPillBounds(win, target)
          releaseLock()
          resolve(placement)
        }, fadeMs)
      }
    })
  }

  const ease = req.mode === 'pill' ? easeClose : easeOpen
  return new Promise((resolve) => {
    runBoundsEase(win, from, target, durationMs, ease, () => resolve(placement))
  })
}

ipcMain.handle(
  'window:setBounds',
  async (event, req: BoundsRequest): Promise<Placement> => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win !== pillWindow) return 'above'
  if (dragTimer) {
    // Collapse-to-pill during drag is applied immediately so we never drag
    // a glass shell with the Hello pill still painted under the panel.
    if (req.mode === 'pill') {
      pendingBounds = null
      return await Promise.resolve(applyBounds(win, req))
    }
    pendingBounds = req
    return currentPlacement
  }
  return await Promise.resolve(applyBounds(win, req))
})

// ── IPC: workspace window lifecycle ──
ipcMain.handle(
  'workspace:open',
  (_event, focus?: string | { workflowId?: string; runId?: string }) =>
    openWorkspaceWindow(focus)
)
ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.handle('editor:setScrim', (_event, visible: boolean) => {
  setEditorScrimVisible(Boolean(visible))
})
ipcMain.handle('pill:setAppState', (_event, next: string) => {
  const prev = pillAppState
  pillAppState = typeof next === 'string' ? next : 'idle'
  // Leaving summary restores always-on-top (summary drops it on blur).
  if (prev === 'summary' && pillAppState !== 'summary' && pillWindow) {
    pillWindow.setAlwaysOnTop(true, 'floating')
  }
})

// ── IPC: workspace → pill commands ──
ipcMain.handle('pill:runWorkflow', (_event, workflowId: string) => {
  // Resolve from the shared store — never fall back to a hardcoded mock.
  const workflow = getWorkflow(workflowId)
  if (!workflow) {
    console.warn(`[pill:runWorkflow] unknown workflowId: ${workflowId}`)
    return false
  }
  pillWindow?.show()
  pillWindow?.webContents.send('pill:runWorkflow', workflowId)
  return true
})
ipcMain.handle('pill:openRecordPanel', () => {
  pillWindow?.show()
  pillWindow?.webContents.send('pill:openRecordPanel')
})
ipcMain.handle('pill:openEditor', () => {
  pillWindow?.show()
  pillWindow?.webContents.send('pill:openEditor')
})
/** Activity "Answer" / paused — show pill and expand the running hold. */
ipcMain.handle('pill:revealRunning', () => {
  pillWindow?.show()
  pillWindow?.focus()
  pillWindow?.webContents.send('pill:revealRunning')
})

// ── IPC: pill drag (follows cursor 1:1) ──
// A CSS drag-region would swallow the pill's click events, so the renderer
// signals drag start/end and main polls the cursor to move the window.
let dragTimer: ReturnType<typeof setInterval> | null = null
ipcMain.handle(
  'pill:dragStart',
  (event, payload: { x: number; y: number; collapseToPill?: boolean }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return

  // Same IPC path moves the Library window; skip pill-only collapse/anchor.
  const isPill = win === pillWindow

  if (isPill) {
    // Collapse only when the renderer asks (unpinned hover). If the user has
    // clicked the panel open, keep glass and drag the whole UI.
    cancelBoundsAnim()
    const collapseToPill = payload?.collapseToPill !== false
    if (collapseToPill && currentMode !== 'pill') {
      pillAnchor = pillAnchorFromWindow(win)
      applyBounds(win, { w: PILL_W, h: PILL_H, mode: 'pill' })
    }
  }

  // Recompute grab offset from the (possibly just-shrunk) window.
  const cursor0 = screen.getCursorScreenPoint()
  const b0 = win.getBounds()
  const grab = { x: cursor0.x - b0.x, y: cursor0.y - b0.y }

  if (dragTimer) clearInterval(dragTimer)
  // Panel-mode chrome hides the pill. Updating the anchor from the window BR
  // while dragging a large panel (esp. clamped under the menu bar) parks the
  // pill mid-screen. Keep the pre-panel pill spot — same as summary.
  const freezeAnchor = isPill && currentMode === 'panel'
  dragTimer = setInterval(() => {
    const cursor = screen.getCursorScreenPoint()
    const nx = Math.round(cursor.x - grab.x)
    const ny = Math.round(cursor.y - grab.y)
    win.setPosition(nx, ny)
    if (isPill) {
      const bounds = win.getBounds()
      if (!freezeAnchor) {
        pillAnchor = pillAnchorFromBounds(bounds)
      }
      layoutBackdrops(bounds)
    }
  }, 16)
  }
)
ipcMain.handle('pill:dragEnd', (event) => {
  if (dragTimer) {
    clearInterval(dragTimer)
    dragTimer = null
  }
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && win === pillWindow) {
    // Panel overlays: keep the pre-panel pill spot (see freezeAnchor above).
    if (currentMode !== 'panel') {
      pillAnchor = pillAnchorFromWindow(win)
      setPillPosition({ x: pillAnchor.x, y: pillAnchor.y })
    }
    if (pendingBounds) {
      const req = pendingBounds
      pendingBounds = null
      applyBounds(win, req)
    }
  }
})

// ── IPC: pill context menu ──
// Idle: Open Library ⌘L · Record a workflow ⌥R · Settings… ⌘, · Hide pill ⌥H
// Recording: omits Record; appends "Recording continues" under Hide pill.
ipcMain.handle('pill:contextMenu', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const recording = pillAppState === 'recording'
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Open Library',
      accelerator: 'CommandOrControl+L',
      click: () => openWorkspaceWindow()
    }
  ]
  if (!recording) {
    template.push({
      label: 'Record a workflow',
      accelerator: 'Alt+R',
      click: () => {
        showPill()
        pillWindow?.webContents.send('pill:openRecordPanel')
      }
    })
  }
  template.push(
    { type: 'separator' },
    {
      label: 'Settings…',
      accelerator: 'CommandOrControl+,',
      enabled: false
    },
    {
      label: 'Hide pill',
      accelerator: 'Alt+H',
      click: () => hidePill()
    }
  )
  if (recording) {
    template.push({
      label: 'Recording continues',
      enabled: false
    })
  }
  Menu.buildFromTemplate(template).popup({ window: win })
})

// ── Onboarding gate ──
// Card-sized movable window: desktop stays interactive, window can sit behind
// other apps. Quitting is only possible from the tray. Relaunch resumes the
// persisted step.
const ONB_SHADOW_PAD = 36
const ONB_CONTENT_W = 440
const ONB_CONTENT_H = 320
const ONB_W = ONB_CONTENT_W + ONB_SHADOW_PAD * 2
const ONB_H = ONB_CONTENT_H + ONB_SHADOW_PAD * 2

function createOnboardingWindow() {
  if (onboardingWindow) {
    if (overlayDemotedForSettings) promoteOnboardingOverlay()
    else {
      onboardingWindow.show()
      onboardingWindow.focus()
    }
    return
  }
  const { workArea } = screen.getPrimaryDisplay()
  const width = ONB_W
  const height = ONB_H
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  const y = Math.round(workArea.y + (workArea.height - height) / 2)
  onboardingWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // Restore after returning from System Settings (show + focus only —
  // do not re-pin always-on-top so the user can still put it behind).
  onboardingWindow.on('focus', () => {
    if (overlayDemotedForSettings) promoteOnboardingOverlay()
  })

  onboardingWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Hard gate: no dismiss. Only a real quit (tray) may close this window.
  onboardingWindow.on('close', (e) => {
    if (!isQuitting && !getSnapshot().onboardingComplete) e.preventDefault()
  })

  onboardingWindow.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      onboardingWindow?.webContents.send('onboarding:deepLink', pendingDeepLink)
      pendingDeepLink = null
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    onboardingWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#onboarding`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'onboarding' })
  }

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })
}

function sendDeepLink(link: DeepLink) {
  if (onboardingWindow && !onboardingWindow.webContents.isLoading()) {
    onboardingWindow.webContents.send('onboarding:deepLink', link)
  } else {
    pendingDeepLink = link
  }
  onboardingWindow?.show()
  onboardingWindow?.focus()
}

/** Custom-scheme handler for magic-link and invite-link return paths. */
function handleDeepLink(rawUrl: string) {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return
  }
  const host = url.hostname
  const path = url.pathname.replace(/^\/+/, '')

  if (host === 'auth' && path === 'magic') {
    const email = url.searchParams.get('email') || 'harry@yuh.app'
    const token = url.searchParams.get('token') || ''
    setSession(sessionForEmail(email))
    if (getSnapshot().onboardingStep === 'welcome') setOnboardingStep('team')
    sendDeepLink({ kind: 'magic', email, token })
  } else if (host === 'auth' && path === 'google') {
    sendDeepLink({ kind: 'google' })
  } else if (host === 'invite') {
    const code = path || url.searchParams.get('code') || ''
    sendDeepLink({ kind: 'invite', code })
  }
}

function registerGlobalShortcuts() {
  if (shortcutsRegistered) return
  shortcutsRegistered = true
  // ⌥G — stand-in for bare Option (polish): show pill + open record panel.
  globalShortcut.register('Alt+G', () => {
    showPill()
    pillWindow?.webContents.send('pill:openRecordPanel')
  })
  // ⌥R — Record a workflow (same as context-menu item).
  globalShortcut.register('Alt+R', () => {
    showPill()
    pillWindow?.webContents.send('pill:openRecordPanel')
  })
  // ⌥H — Hide / show pill (tray also recovers).
  globalShortcut.register('Alt+H', () => {
    if (!pillWindow) return
    if (pillWindow.isVisible()) hidePill()
    else showPill()
  })
  // ⌘L — Open Library
  globalShortcut.register('CommandOrControl+L', () => openWorkspaceWindow())
}

/** Promote from the gate to the real app (pill + workspace available). */
function enterNormalMode(opts?: { openRecordPanel?: boolean }) {
  setTrayMode('normal')
  if (!pillWindow) {
    createPillWindow()
    createBackdrops()
    if (pillWindow) layoutBackdrops((pillWindow as BrowserWindow).getBounds())
  } else {
    showPill()
  }
  registerGlobalShortcuts()
  if (opts?.openRecordPanel) {
    showPill()
    pillWindow?.webContents.send('pill:openRecordPanel')
  }
}

/**
 * Tear down the signed-in surface and reopen the onboarding gate at welcome.
 * Used by Log out — session/team clear; workflows/runs stay on disk.
 */
function enterOnboardingMode(): void {
  setSession(null)
  setTeam(null)
  setOnboardingComplete(false)
  setOnboardingStep('welcome')

  globalShortcut.unregisterAll()
  shortcutsRegistered = false
  setTrayMode('onboarding')
  setEditorScrimVisible(false)

  if (workspaceWindow) {
    workspaceWindow.destroy()
    workspaceWindow = null
  }
  hidePill()
  hideBackdrops()
  if (pillWindow) {
    pillWindow.destroy()
    pillWindow = null
  }
  pillBackdrop?.destroy()
  panelBackdrop?.destroy()
  pillBackdrop = null
  panelBackdrop = null

  createOnboardingWindow()
}

/**
 * Hide the onboarding window so System Settings (and the macOS permission
 * sheet) can receive clicks.
 */
function demoteOnboardingForSettings(): void {
  if (!onboardingWindow || onboardingWindow.isDestroyed()) return
  overlayDemotedForSettings = true
  onboardingWindow.hide()
}

function promoteOnboardingOverlay(): void {
  if (!onboardingWindow || onboardingWindow.isDestroyed()) return
  if (getSnapshot().onboardingComplete) return
  overlayDemotedForSettings = false
  onboardingWindow.show()
  onboardingWindow.focus()
}

/** Record a granted→denied flip so the pill can arm the paused-permission UX. */
function handlePermissionChange(prev: PermissionsState | null, next: PermissionsState) {
  if (!prev || !getSnapshot().onboardingComplete) return
  const revoked =
    (prev.screen === 'granted' && next.screen !== 'granted') ||
    (prev.accessibility === 'granted' && next.accessibility !== 'granted')
  if (revoked) setLastPermissionRevokeAt(new Date().toISOString())
}

function registerOnboardingIpc() {
  setBeforeOpenSettings(() => {
    demoteOnboardingForSettings()
  })

  ipcMain.handle('app:openExternal', (_e, url: string) => {
    if (typeof url === 'string') shell.openExternal(url)
  })

  ipcMain.handle('onboarding:complete', (_e, opts: { openRecordPanel?: boolean }) => {
    setOnboardingComplete(true)
    if (onboardingWindow) {
      onboardingWindow.destroy()
      onboardingWindow = null
    }
    enterNormalMode(opts)
  })

  /** Resize the onboarding window to hug the card (keeps current center). */
  ipcMain.handle('onboarding:setSize', (event, size: { w: number; h: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== onboardingWindow) return
    const width = Math.max(1, Math.round(size.w))
    const height = Math.max(1, Math.round(size.h))
    const b = win.getBounds()
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    win.setBounds(
      {
        x: Math.round(cx - width / 2),
        y: Math.round(cy - height / 2),
        width,
        height
      },
      false
    )
  })

  ipcMain.handle('auth:logout', () => {
    enterOnboardingMode()
  })

  // ── Mocked auth ──
  ipcMain.handle('auth:google', async () => {
    const session = await googleAuth()
    setSession(session)
    if (getSnapshot().onboardingStep === 'welcome') setOnboardingStep('team')
    return session
  })
  ipcMain.handle('auth:sendMagicLink', (_e, email: string) => {
    if (!isValidEmail(email)) return { ok: false }
    // Simulate the emailed link arriving: fire the same deep-link path shortly.
    setTimeout(() => {
      handleDeepLink(
        `ghost://auth/magic?email=${encodeURIComponent(email)}&token=${newId('mtok')}`
      )
    }, 1500)
    return { ok: true }
  })

  // ── Mocked team ──
  ipcMain.handle('team:create', () => {
    const session = getSnapshot().session
    const team = createTeam(session)
    setTeam(team)
    if (session) setSession({ ...session, role: 'owner' })
    setOnboardingStep('permissions')
    return team
  })
  ipcMain.handle('team:join', (_e, code: string) => {
    if (!isValidInviteCode(code)) {
      return { ok: false, error: 'That link didn’t work — ask your team owner to re-send' }
    }
    const session = getSnapshot().session
    const team = teamFromInvite(code, session)
    setTeam(team)
    if (session) setSession({ ...session, role: 'member' })
    setOnboardingStep('permissions')
    return { ok: true, team }
  })
  ipcMain.handle('team:preview', (_e, code: string) => {
    if (!isValidInviteCode(code)) return { ok: false }
    return { ok: true, team: teamFromInvite(code, getSnapshot().session) }
  })
  ipcMain.handle('team:rename', (_e, name: string) => {
    const next = renameTeam(getSnapshot().team, name)
    if (next) setTeam(next)
    return next
  })
  ipcMain.handle('team:invite', (_e, email: string) => {
    const result = inviteToTeam(getSnapshot().team, email)
    if (result.team && !result.error) setTeam(result.team)
    return result
  })
  ipcMain.handle('team:resendInvite', (_e, inviteId: string) => {
    const next = resendInvite(getSnapshot().team, inviteId)
    if (next) setTeam(next)
    return next
  })
  ipcMain.handle('team:revokeInvite', (_e, inviteId: string) => {
    const next = revokeInvite(getSnapshot().team, inviteId)
    if (next) setTeam(next)
    return next
  })
  ipcMain.handle('team:removeMember', (_e, memberId: string) => {
    const next = removeMember(getSnapshot().team, memberId)
    if (next) setTeam(next)
    return next
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.ghost')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  loadStore()
  registerStoreIpc()
  registerPermissionIpc()
  registerOnboardingIpc()
  await initTelemetry()
  registerTelemetryIpc()
  startPermissionWatch(handlePermissionChange)

  const onboarded = getSnapshot().onboardingComplete
  createTray(
    {
      showPill: () => showPill(),
      openLibrary: () => openWorkspaceWindow()
    },
    onboarded ? 'normal' : 'onboarding'
  )

  if (onboarded) enterNormalMode()
  else createOnboardingWindow()

  app.on('activate', () => {
    if (!getSnapshot().onboardingComplete) {
      createOnboardingWindow()
      return
    }
    if (!pillWindow) enterNormalMode()
    else showPill()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopPermissionWatch()
  void flushTelemetryOnQuit()
  setEditorScrimVisible(false)
  editorScrim?.destroy()
  editorScrim = null
  destroyTray()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
