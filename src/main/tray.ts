import { app, Menu, Tray, nativeImage } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

/** Fallback when the file isn't found (embedded 32×32 template circle). */
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA8ElEQVR4nO1XwQ3DIAxkhIzgX+ZBmSCD8GEWVmAM3uyRBVojGQmh1liUyq2Uk+5D7NxhEyDG3PgzbEiL9MiAjMRAY5ZilgNIICMfA2aKhVXip1D4lZHzU3E/IdzTa4pPmzgXileK2wFmrueSNQESA9LSX8hEvIQ5w1ZsgtkXMYfcm7ydxkZGshnsE1YgfjD5h8CE5QyMyu+a2P5ZhRu8g21DYBLLzGrZ38UYiuGqEDgDkUlMzOz7KiQmJv60AfUWqC9C9c9QfSMqUN2KC0BQhRmKD6MC1eO4QvVCstLEtHiF6qW0AozitbyF2o/Jja/hCRf6yfg76AeiAAAAAElFTkSuQmCC'

let tray: Tray | null = null

function resolveTrayIcon() {
  const candidates = [
    join(process.cwd(), 'resources', 'trayTemplate.png'),
    join(__dirname, '../../resources/trayTemplate.png'),
    join(process.resourcesPath ?? '', 'trayTemplate.png')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) {
        img.setTemplateImage(true)
        return img
      }
    }
  }
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_PNG_BASE64, 'base64'))
  img.setTemplateImage(true)
  return img
}

export type TrayHandlers = {
  showPill: () => void
  openLibrary: () => void
}

/** 'onboarding' → Quit only (the sole exit during setup); 'normal' → full menu. */
export type TrayMode = 'onboarding' | 'normal'

let trayHandlers: TrayHandlers | null = null
let trayMode: TrayMode = 'normal'

/** Main-owned capture phase (M2); idle shows nothing extra. */
type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'teardown_failed'
let recordingPhase: RecordingPhase = 'idle'
const PHASE_LABEL: Partial<Record<RecordingPhase, string>> = {
  starting: 'Recording is starting…',
  recording: 'Recording',
  resuming: 'Recording',
  pausing: 'Recording paused',
  paused: 'Recording paused',
  stopping: 'Saving recording…',
  teardown_failed: 'Input monitor did not stop — recording unavailable'
}

function rebuildMenu(): void {
  if (!tray) return
  const label = PHASE_LABEL[recordingPhase]
  const status: Electron.MenuItemConstructorOptions[] = label
    ? [{ label, enabled: false }, { type: 'separator' }]
    : []
  const template: Electron.MenuItemConstructorOptions[] =
    trayMode === 'onboarding'
      ? [...status, { label: 'Quit Ghost', click: () => app.quit() }]
      : [
          ...status,
          { label: 'Show pill', click: () => trayHandlers?.showPill() },
          { label: 'Open Library', click: () => trayHandlers?.openLibrary() },
          { type: 'separator' },
          { label: 'Quit Ghost', click: () => app.quit() }
        ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setToolTip(label ? `Ghost — ${label}` : 'Ghost')
}

export function setTrayRecording(phase: RecordingPhase): void {
  if (phase === recordingPhase) return
  recordingPhase = phase
  rebuildMenu()
}

/**
 * Menu-bar icon — the only quit path while onboarding gates Esc/dismiss, and
 * afterwards recovers a hidden pill / opens the Library.
 */
export function createTray(handlers: TrayHandlers, mode: TrayMode = 'normal'): Tray {
  trayHandlers = handlers
  trayMode = mode
  if (tray) {
    rebuildMenu()
    return tray
  }

  tray = new Tray(resolveTrayIcon())
  tray.setToolTip('Ghost')
  tray.setIgnoreDoubleClickEvents(true)
  rebuildMenu()

  // Left-click shows the pill only once setup is complete.
  tray.on('click', () => {
    if (trayMode === 'normal') trayHandlers?.showPill()
  })

  return tray
}

/** Swap the tray menu when onboarding completes (or would re-gate). */
export function setTrayMode(mode: TrayMode): void {
  trayMode = mode
  rebuildMenu()
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}
