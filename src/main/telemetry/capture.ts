import { globalShortcut, screen } from 'electron'
import { newId } from '../../shared/id'
import {
  SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetryEventType
} from '../../shared/telemetry/schema'
import { redactEvent, sanitizeLabel, sanitizeUrl, sanitizeWindowTitle } from '../../shared/telemetry/sanitize'
import { ClipboardWatcher, inferPaste } from './clipboard'
import {
  DisabledScreenshotProvider,
  NoopInteractionProvider,
  type InteractionPartial,
  type InteractionProvider,
  type KeyframeReason,
  type ScreenshotProvider
} from './providers'
import { TelemetryQueue } from './queue'
import { ScreenStateTracker } from './screenState'
import type { TelemetryStore } from './store/TelemetryStore'

export type RecordingStatus = {
  recording: boolean
  sessionId: string | null
  sequence: number
  startedAt: string | null
  processing: boolean
}

export type CaptureOptions = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  ownerEmail?: string
  /** App names to ignore (our own pill/workspace). */
  ignoreAppNames?: string[]
}

type ActiveWinModule = {
  default?: () => Promise<ActiveWinResult | undefined>
  (): Promise<ActiveWinResult | undefined>
}

type ActiveWinResult = {
  title?: string
  owner?: { name?: string; bundleId?: string; processId?: number }
  url?: string
  bounds?: { x?: number; y?: number; width?: number; height?: number }
}

const POLL_MS = 800

/**
 * Meaningful shortcut chords — never ordinary printable typing.
 * Omits C/V/X so copy-paste is not stolen from the target app while recording
 * (Electron globalShortcut claims the chord system-wide when registered).
 */
const SHORTCUTS: Array<{ accelerator: string; label: string }> = [
  { accelerator: 'CommandOrControl+S', label: 'Cmd/Ctrl+S' },
  { accelerator: 'CommandOrControl+Enter', label: 'Cmd/Ctrl+Enter' },
  { accelerator: 'CommandOrControl+Shift+S', label: 'Cmd/Ctrl+Shift+S' },
  { accelerator: 'CommandOrControl+P', label: 'Cmd/Ctrl+P' },
  { accelerator: 'CommandOrControl+N', label: 'Cmd/Ctrl+N' },
  { accelerator: 'CommandOrControl+Shift+T', label: 'Cmd/Ctrl+Shift+T' },
  { accelerator: 'CommandOrControl+Shift+Z', label: 'Cmd/Ctrl+Shift+Z' }
]

/**
 * Main-process recorder: active-win polling + globalShortcut chords +
 * optional Accessibility (JXA) + clipboard watcher + sparse keyframes.
 * Structurally cannot capture printable keystrokes.
 */
export class TelemetryRecorder {
  private sessionId: string | null = null
  private sequence = 0
  private startedAtMs = 0
  private startedAtIso: string | null = null
  private recording = false
  private processing = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private registeredShortcuts: string[] = []
  private lastAppKey: string | null = null
  private lastBounds: ActiveWinResult['bounds'] | null = null
  private opts: CaptureOptions = {}
  private onEventListeners = new Set<(event: TelemetryEvent) => void>()
  private onStatusListeners = new Set<(status: RecordingStatus) => void>()
  private interaction: InteractionProvider
  private screenshot: ScreenshotProvider
  private screenStates: ScreenStateTracker
  private clipboard: ClipboardWatcher
  private queue: TelemetryQueue | null = null
  private activeWin: ActiveWinModule | null = null
  private lastFieldLength: number | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly store: TelemetryStore | null,
    providers?: {
      interaction?: InteractionProvider
      screenshot?: ScreenshotProvider
      clipboard?: ClipboardWatcher
    }
  ) {
    this.interaction = providers?.interaction ?? new NoopInteractionProvider()
    this.screenshot = providers?.screenshot ?? new DisabledScreenshotProvider()
    this.screenStates = new ScreenStateTracker(this.screenshot)
    this.clipboard = providers?.clipboard ?? new ClipboardWatcher()
  }

  getRecordingStatus(): RecordingStatus {
    return {
      recording: this.recording,
      sessionId: this.sessionId,
      sequence: this.sequence,
      startedAt: this.startedAtIso,
      processing: this.processing
    }
  }

  onEvent(cb: (event: TelemetryEvent) => void): () => void {
    this.onEventListeners.add(cb)
    return () => this.onEventListeners.delete(cb)
  }

  onStatus(cb: (status: RecordingStatus) => void): () => void {
    this.onStatusListeners.add(cb)
    return () => this.onStatusListeners.delete(cb)
  }

  setProcessing(processing: boolean): void {
    this.processing = processing
    this.emitStatus()
  }

  async startRecording(opts: CaptureOptions = {}): Promise<RecordingStatus> {
    if (this.recording) {
      return this.getRecordingStatus()
    }
    if (!this.store) {
      throw new Error('[telemetry] no TelemetryStore configured')
    }

    this.opts = opts
    this.sessionId = newId('tsess')
    this.sequence = 0
    this.startedAtMs = Date.now()
    this.startedAtIso = new Date(this.startedAtMs).toISOString()
    this.recording = true
    this.processing = false
    this.lastAppKey = null
    this.lastBounds = null
    this.lastFieldLength = null
    this.screenStates.reset()

    await this.store.ensureReady()
    await this.store.createSession({
      sessionId: this.sessionId,
      ownerEmail: opts.ownerEmail,
      recordMode: opts.recordMode,
      selectedAppId: opts.selectedAppId
    })

    this.queue = new TelemetryQueue(this.store)
    this.queue.start()

    this.recordEvent('session_started', {
      data: {
        appName: 'ghost',
        message: 'Recording started'
      }
    })

    await this.ensureActiveWin()
    this.startPolling()
    this.registerShortcuts()
    this.startClipboard()

    if (this.interaction.enabled) {
      this.interaction.start((partial) => this.ingestInteraction(partial))
    }

    this.emitStatus()
    return this.getRecordingStatus()
  }

  async stopRecording(): Promise<{ sessionId: string | null }> {
    if (!this.recording || !this.sessionId) {
      return { sessionId: this.sessionId }
    }

    this.stopPolling()
    this.unregisterShortcuts()
    this.interaction.stop()
    this.clipboard.stop()
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }

    this.recordEvent('session_stopped', {
      data: { message: 'Recording stopped' }
    })

    this.recording = false
    await this.flush()
    if (this.store && this.sessionId) {
      await this.store.stopSession(this.sessionId)
    }
    this.queue?.stop()
    this.emitStatus()
    return { sessionId: this.sessionId }
  }

  recordEvent(
    type: TelemetryEventType,
    partial: Partial<
      Pick<TelemetryEvent, 'page' | 'route' | 'viewport' | 'target' | 'data' | 'screenStateId'>
    > = {}
  ): TelemetryEvent | null {
    if (!this.sessionId) return null
    if (!this.recording && type !== 'session_stopped') return null

    const event: TelemetryEvent = redactEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: newId('tevt'),
      sessionId: this.sessionId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - this.startedAtMs),
      type,
      page: partial.page,
      route: partial.route,
      viewport: partial.viewport ?? this.viewport(),
      target: partial.target,
      data: partial.data,
      screenStateId: partial.screenStateId
    })

    this.queue?.enqueue([event])
    for (const cb of this.onEventListeners) {
      try {
        cb(event)
      } catch (err) {
        console.error('[telemetry] onEvent listener failed', err)
      }
    }
    return event
  }

  async flush(): Promise<void> {
    await this.queue?.flush()
  }

  // ── internals ──

  private emitStatus(): void {
    const status = this.getRecordingStatus()
    for (const cb of this.onStatusListeners) {
      try {
        cb(status)
      } catch (err) {
        console.error('[telemetry] onStatus listener failed', err)
      }
    }
  }

  private viewport(): { width: number; height: number } {
    try {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize
      return { width, height }
    } catch {
      return { width: 0, height: 0 }
    }
  }

  private async ensureActiveWin(): Promise<void> {
    if (this.activeWin) return
    try {
      const mod = (await import('active-win')) as unknown as ActiveWinModule
      this.activeWin = mod
    } catch (err) {
      console.error('[telemetry] active-win unavailable', err)
      this.activeWin = null
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      void this.pollActiveWindow()
    }, POLL_MS)
    void this.pollActiveWindow()
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private startClipboard(): void {
    this.clipboard.start((change) => {
      if (!this.recording) return
      this.recordEvent('clipboard_changed', {
        data: {
          clipboard: change.clipboard
        }
      })
      this.interaction.poke?.()
      void this.captureKeyframe('clipboard')
    })
  }

  private async pollActiveWindow(): Promise<void> {
    if (!this.recording || !this.activeWin) return
    try {
      const fn = this.activeWin.default ?? this.activeWin
      const win = await fn()
      if (!win) return

      const appName = sanitizeLabel(win.owner?.name)
      const ignore = this.opts.ignoreAppNames ?? ['ghost', 'Electron', 'yuh']
      if (appName && ignore.some((n) => appName.toLowerCase() === n.toLowerCase())) {
        return
      }

      if (this.opts.recordMode === 'one-app' && this.opts.selectedAppId && appName) {
        const selected = this.opts.selectedAppId.toLowerCase()
        const aliases: Record<string, string[]> = {
          chrome: ['google chrome', 'chrome', 'chromium'],
          figma: ['figma'],
          slack: ['slack'],
          finder: ['finder'],
          mail: ['mail']
        }
        const names = aliases[selected] ?? [selected]
        if (!names.some((n) => appName.toLowerCase().includes(n))) {
          return
        }
      }

      if (win.bounds) this.lastBounds = win.bounds

      const snapshot = this.screenStates.fromActiveWindow(win)
      if (!snapshot) return

      const appKey = `${snapshot.appBundleId ?? snapshot.appName ?? ''}`
      const screenKey = `${appKey}|${snapshot.windowTitle ?? ''}|${snapshot.urlHost ?? ''}${snapshot.urlPath ?? ''}`
      const prevScreenKey = this.lastAppKey
      const prevApp = prevScreenKey?.split('|')[0] ?? null
      const isFirst = prevScreenKey === null
      const appChanged = prevApp !== null && prevApp !== appKey
      this.lastAppKey = screenKey

      const { urlHost, urlPath } = sanitizeUrl(win.url)
      const windowTitle = sanitizeWindowTitle(win.title)

      if (isFirst || appChanged) {
        this.recordEvent('navigation', {
          page: snapshot.page,
          route: snapshot.route,
          screenStateId: snapshot.screenStateId,
          target: {
            appName: snapshot.appName,
            appBundleId: snapshot.appBundleId
          },
          data: {
            appName: snapshot.appName,
            appBundleId: snapshot.appBundleId,
            windowTitle,
            documentTitle: windowTitle,
            urlHost,
            urlPath
          }
        })
        this.interaction.poke?.()
        void this.captureKeyframe('app_changed')
      }

      this.recordEvent('screen_changed', {
        page: snapshot.page,
        route: snapshot.route,
        screenStateId: snapshot.screenStateId,
        target: {
          appName: snapshot.appName,
          appBundleId: snapshot.appBundleId
        },
        data: {
          appName: snapshot.appName,
          appBundleId: snapshot.appBundleId,
          windowTitle,
          documentTitle: windowTitle,
          urlHost,
          urlPath,
          headings: snapshot.headings,
          buttons: snapshot.buttons,
          dialogs: snapshot.dialogs,
          loading: snapshot.loading
        }
      })

      this.scheduleSettleKeyframe()
    } catch (err) {
      console.error('[telemetry] active-win poll failed', err instanceof Error ? err.name : 'error')
    }
  }

  private scheduleSettleKeyframe(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      if (!this.recording) return
      void this.captureKeyframe('settle')
    }, 1500)
  }

  private async captureKeyframe(reason: KeyframeReason): Promise<void> {
    if (!this.screenshot.enabled || !this.sessionId || !this.recording) return
    const eventId = newId('tevt')
    try {
      const result = await this.screenshot.captureKeyframe(`ss_${eventId}`, {
        reason,
        bounds: this.lastBounds
          ? {
              x: this.lastBounds.x ?? 0,
              y: this.lastBounds.y ?? 0,
              width: this.lastBounds.width ?? 0,
              height: this.lastBounds.height ?? 0
            }
          : undefined,
        sessionId: this.sessionId,
        eventId
      })
      if (result?.relativePath) {
        this.recordEvent('keyframe_captured', {
          data: {
            keyframePath: result.relativePath,
            message: reason
          }
        })
      }
    } catch {
      /* never block recording on keyframe failure */
    }
  }

  private registerShortcuts(): void {
    this.unregisterShortcuts()
    for (const { accelerator, label } of SHORTCUTS) {
      try {
        const ok = globalShortcut.register(accelerator, () => {
          if (!this.recording) return
          this.recordEvent('keyboard_shortcut', {
            data: { shortcut: label }
          })
        })
        if (ok) this.registeredShortcuts.push(accelerator)
      } catch {
        // Some accelerators may be reserved by the OS.
      }
    }
  }

  private unregisterShortcuts(): void {
    for (const accel of this.registeredShortcuts) {
      try {
        globalShortcut.unregister(accel)
      } catch {
        /* ignore */
      }
    }
    this.registeredShortcuts = []
  }

  private ingestInteraction(partial: InteractionPartial): void {
    if (!this.recording) return

    // Paste inference: field length jumped after a recent clipboard change.
    if (partial.type === 'focus_changed' || partial.type === 'field_completed') {
      const len = partial.data?.field?.valueLength
      if (typeof len === 'number') {
        const latest = this.clipboard.getLatest()
        if (
          latest &&
          this.lastFieldLength != null &&
          len > this.lastFieldLength
        ) {
          const result = inferPaste({
            fieldCharCountBefore: this.lastFieldLength,
            fieldCharCountAfter: len,
            clipboard: latest.clipboard,
            clipboardAt: latest.at,
            now: Date.now()
          })
          if (result.matched) {
            this.recordEvent('paste_detected', {
              target: partial.target,
              data: {
                ...partial.data,
                clipboard: latest.clipboard,
                matchedClipboardHash: latest.clipboard.contentHash,
                charCountDelta: result.charCountDelta,
                inferred: true
              }
            })
          }
        }
        this.lastFieldLength = len
      }
    }

    this.recordEvent(partial.type, {
      target: partial.target,
      data: partial.data
    })

    if (partial.type === 'element_activated' || partial.type === 'click') {
      void this.captureKeyframe('activation')
      this.interaction.poke?.()
    }
  }
}
