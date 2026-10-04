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
import { createTray, destroyTray, setTrayMode, setTrayRecording } from './tray'
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
import type { DeepLink, PermissionsState, WorkspaceFocus } from '../shared/types'
import {
  createRecordDropdownWiring,
  createWindowTransitions,
  PILL_H,
  PILL_W,
  PILL_WINDOW_OPTIONS,
  RECORD_DROPDOWN_HASH,
  registerTransitionIpc
} from './windowTransitions'
import {
  flushTelemetryOnQuit,
  getTelemetryRecorder,
  hasActiveRecording,
  initTelemetry,
  onCaptureStatus,
  registerTelemetryIpc,
  stopActiveRecording
} from './telemetry'
import { registerAutomationIpc, stopActiveAutomationRun } from './automation'

let pillWindow: BrowserWindow | null = null
let workspaceWindow: BrowserWindow | null = null
/** Fullscreen ink-20 dim behind the expanded editor. */
let editorScrim: BrowserWindow | null = null
/** Fullscreen onboarding overlay — the hard gate before pill/workspace. */
let onboardingWindow: BrowserWindow | null = null
/** Pending Library deep-link until the workspace window finishes loading. */
let pendingWorkspaceFocus: WorkspaceFocus | null = null
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

const MARGIN = 24

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
/**
 * Bound on the quit barrier: the owner's audio account (≤7 s, covering the renderer's 1.5 s
 * stop + 5 s drain) plus the local save. A miss leaves the session for relaunch recovery as
 * incomplete — never a fabricated successful save.
 */
const QUIT_BARRIER_MS = 10_000
let quitBarrier: 'idle' | 'running' | 'done' = 'idle'
app.on('before-quit', (event) => {
  isQuitting = true
  // M2-R2: every quit while the barrier runs is held, so no repeated quit can bypass it.
  if (quitBarrier === 'running') {
    event.preventDefault()
    return
  }
  // Join any capture lifecycle work, including a pending Start or an unfinished save.
  if (quitBarrier === 'done' || !hasActiveRecording()) return
  event.preventDefault()
  quitBarrier = 'running'
  let deadline: ReturnType<typeof setTimeout> | null = null
  void Promise.race([
    stopActiveRecording('quit').catch(() => undefined),
    new Promise((resolve) => (deadline = setTimeout(resolve, QUIT_BARRIER_MS)))
  ]).finally(() => {
    if (deadline) clearTimeout(deadline)
    quitBarrier = 'done'
    app.quit()
  })
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
  transitions.setAnchor({ x: bounds.x + bounds.width, y: bounds.y + bounds.height })

  pillWindow = new BrowserWindow({
    ...bounds,
    ...PILL_WINDOW_OPTIONS,
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

  // The transition controller owns park/restore locking and teardown; main keeps scrim/summary.
  transitions.attachPill(pillWindow, {
    onFocusChange: (focused) => onPillFocusChange(focused),
    onHide: () => editorScrim?.setOpacity(0),
    onShow: () => applyEditorScrim()
  })
}

function sendWorkspaceFocus(focus: WorkspaceFocus | null) {
  if (!workspaceWindow || !focus) return
  workspaceWindow.webContents.send('workspace:focus', focus)
  // Back-compat for older listeners.
  if (focus.workflowId) {
    workspaceWindow.webContents.send('workspace:focusWorkflow', focus.workflowId)
  }
}

function normalizeWorkspaceFocus(focus?: string | WorkspaceFocus): WorkspaceFocus | null {
  if (!focus) return null
  if (typeof focus === 'string') return { workflowId: focus }
  if (focus.workflowId || focus.runId || focus.sessionId) return focus
  return null
}

function openWorkspaceWindow(focus?: string | WorkspaceFocus) {
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

/**
 * The pill is the recording indicator: an active session stops and saves before it hides.
 * If a source did not confirm shutdown the indicator stays visible (capture unavailable).
 */
async function hidePill() {
  if (hasActiveRecording()) await stopActiveRecording('hide')
  if (getTelemetryRecorder()?.getRecordingStatus().teardownFailed) return
  transitions.closeDropdown()
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
    // ink-20 = rgba(20, 20, 15, 0.20)
    editorScrim.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<html><body style="margin:0;background:rgba(20,20,15,0.20);width:100vw;height:100vh;"></body></html>'
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
 * states stay always-on-top.
 */
function onPillFocusChange(focused: boolean) {
  applyEditorScrim()
  if (!pillWindow) return
  if (focused) {
    if (pillAppState === 'summary') {
      pillWindow.setAlwaysOnTop(true, 'floating')
      pillWindow.moveTop()
    }
  } else {
    if (pillAppState === 'summary') {
      pillWindow.setAlwaysOnTop(false)
    }
  }
}

// ── IPC: pill window sizing / drag and the anchored Record dropdown → windowTransitions.ts ──
// The pill stays stationary; the Record dropdown is one separate, reusable window (M1-HF3).
const recordDropdown = createRecordDropdownWiring({
  ipc: ipcMain,
  BrowserWindow,
  preload: join(__dirname, '../preload/index.js'),
  load: (win) =>
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${RECORD_DROPDOWN_HASH}`)
      : win.loadFile(join(__dirname, '../renderer/index.html'), { hash: RECORD_DROPDOWN_HASH }),
  pill: () => pillWindow,
  ctl: () => transitions
})
const transitions = createWindowTransitions({
  pill: () => pillWindow,
  workAreaNear: (point) => screen.getDisplayNearestPoint(point).workArea,
  cursor: () => screen.getCursorScreenPoint(),
  persistAnchor: (point) => setPillPosition(point),
  createDropdown: recordDropdown.create,
  onDropdownClosed: recordDropdown.notifyClosed
})
registerTransitionIpc(ipcMain, (wc) => BrowserWindow.fromWebContents(wc), transitions, () => pillWindow)

// ── IPC: workspace window lifecycle ──
ipcMain.handle(
  'workspace:open',
  (_event, focus?: string | WorkspaceFocus) => openWorkspaceWindow(focus)
)
ipcMain.handle('window:close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})
ipcMain.handle('window:minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})
ipcMain.on(
  'window:setIgnoreMouseEvents',
  (event, ignore: boolean, opts?: { forward?: boolean }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== pillWindow) return
    if (ignore && opts?.forward) win.setIgnoreMouseEvents(true, { forward: true })
    else win.setIgnoreMouseEvents(Boolean(ignore))
  }
)
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
      label: recording ? 'Stop recording and hide pill' : 'Hide pill',
      accelerator: 'Alt+H',
      click: () => void hidePill()
    }
  )
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
    if (pillWindow.isVisible()) void hidePill()
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
  void hidePill()
  if (pillWindow) {
    pillWindow.destroy()
    pillWindow = null
  }

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
  // M2: losing a permission the active session uses stops and saves it (no silent gap).
  if (prev && hasActiveRecording()) {
    const lost = (k: keyof PermissionsState) => prev[k] === 'granted' && next[k] !== 'granted'
    const narrating = getTelemetryRecorder()?.isNarrating() ?? false
    if (lost('screen') || lost('accessibility') || (narrating && lost('microphone'))) {
      void stopActiveRecording('permission_revoked')
    }
  }
  if (!prev || !getSnapshot().onboardingComplete) return
  // Only Screen Recording is required today (Accessibility is a future provider).
  const revoked = prev.screen === 'granted' && next.screen !== 'granted'
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

  ipcMain.handle('auth:logout', async () => {
    // Logout removes the owner and the indicator: stop and save first.
    await stopActiveRecording('logout')
    if (getTelemetryRecorder()?.getRecordingStatus().teardownFailed) {
      // Keep the signed-in surface and its failure indicator until capture has stopped.
      showPill()
      return
    }
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
  // Tray mirrors main-owned capture state from pending Start until the durable save outcome.
  onCaptureStatus((s) =>
    setTrayRecording(
      s.teardownFailed
        ? 'teardown_failed'
        : s.starting
          ? 'starting'
          : s.phase === 'idle' && s.saving
            ? 'stopping'
            : s.phase
    )
  )
  registerAutomationIpc()
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
  stopActiveAutomationRun()
  void flushTelemetryOnQuit()
  setEditorScrimVisible(false)
  editorScrim?.destroy()
  editorScrim = null
  destroyTray()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
