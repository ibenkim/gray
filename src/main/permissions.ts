import { app, BrowserWindow, desktopCapturer, ipcMain, shell, systemPreferences } from 'electron'
import type { PermissionId, PermissionsState, PermissionStatus } from '../shared/types'

/** Optional hook so main can demote the onboarding overlay before Settings. */
let beforeOpenSettings: ((id: PermissionId) => void) | null = null
export function setBeforeOpenSettings(fn: (id: PermissionId) => void): void {
  beforeOpenSettings = fn
}

const isMac = process.platform === 'darwin'

/** Deep-link targets for each System Settings privacy pane. */
const SETTINGS_PANES: Record<PermissionId, string> = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
}

function mediaStatus(kind: 'screen' | 'microphone'): PermissionStatus {
  if (!isMac) return 'granted'
  try {
    return systemPreferences.getMediaAccessStatus(kind) === 'granted' ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

function accessibilityStatus(prompt = false): PermissionStatus {
  if (!isMac) return 'granted'
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt) ? 'granted' : 'denied'
  } catch {
    return 'unknown'
  }
}

export function getPermissions(): PermissionsState {
  return {
    screen: mediaStatus('screen'),
    accessibility: accessibilityStatus(false),
    microphone: mediaStatus('microphone')
  }
}

export function openPermissionSettings(id: PermissionId): void {
  beforeOpenSettings?.(id)
  shell.openExternal(SETTINGS_PANES[id]).catch((err) => {
    console.error('[permissions] open settings failed', err)
  })
}

/**
 * Fire the real macOS prompt for the given permission. Screen recording has no
 * direct request API — touching `desktopCapturer` triggers the system dialog.
 *
 * Onboarding only requests `screen` today. Accessibility and microphone helpers
 * remain here for a future InteractionProvider / narration phase — do not
 * surface them in the UI until those features ship.
 *
 * Does NOT auto-open System Settings: the OS sheet already offers that path, and
 * stacking Settings on top of it is awkward. Denied → recovery card; the user
 * opens Settings explicitly via "Open System Settings".
 */
export async function requestPermission(id: PermissionId): Promise<PermissionsState> {
  // Keep the onboarding card up. The OS sheet floats above it; System Settings
  // is only opened from the recovery card's explicit button (openPermissionSettings).
  if (!isMac) return getPermissions()
  try {
    if (id === 'microphone') {
      await systemPreferences.askForMediaAccess('microphone')
    } else if (id === 'accessibility') {
      accessibilityStatus(true)
    } else {
      try {
        await desktopCapturer.getSources({ types: ['screen'] })
      } catch {
        // Ignored — the call itself is what surfaces the permission prompt.
      }
    }
  } catch (err) {
    console.error('[permissions] request failed', err)
  }
  const state = getPermissions()
  broadcast(state)
  return state
}

function broadcast(state: PermissionsState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('permissions:changed', state)
  }
}

let watchTimer: ReturnType<typeof setInterval> | null = null
let lastState: PermissionsState | null = null

/**
 * Poll the privacy status and broadcast on any change. `onChange` lets main
 * detect a granted→denied flip (revocation) to arm the paused-pill + toast.
 */
export function startPermissionWatch(
  onChange?: (prev: PermissionsState | null, next: PermissionsState) => void
): void {
  if (watchTimer) return
  lastState = getPermissions()
  watchTimer = setInterval(() => {
    const next = getPermissions()
    const prev = lastState
    if (
      !prev ||
      prev.screen !== next.screen ||
      prev.accessibility !== next.accessibility ||
      prev.microphone !== next.microphone
    ) {
      lastState = next
      onChange?.(prev, next)
      broadcast(next)
    }
  }, 2000)
}

export function stopPermissionWatch(): void {
  if (watchTimer) clearInterval(watchTimer)
  watchTimer = null
}

export function registerPermissionIpc(): void {
  ipcMain.handle('permissions:get', () => getPermissions())
  ipcMain.handle('permissions:request', (_e, id: PermissionId) => requestPermission(id))
  ipcMain.handle('permissions:openSettings', (_e, id: PermissionId) => openPermissionSettings(id))
  ipcMain.handle('permissions:restart', () => {
    app.relaunch()
    app.exit(0)
  })
}
