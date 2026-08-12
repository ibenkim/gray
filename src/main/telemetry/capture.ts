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
  paused: boolean
  sessionId: string | null
  sequence: number
  startedAt: string | null
  processing: boolean
}

export type CaptureOptions = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  ownerEmail?: string
  /** Capture voice narration for this session. */
  narrate?: boolean
  /** App names to ignore (our own pill/workspace). */
  ignoreAppNames?: string[]
}

/** Hard denylist — password managers, banking, messaging (capture-spec §5). */
const APP_DENYLIST = [
  '1password',
  '1password for safari',
  'bitwarden',
  'lastpass',
  'dashlane',
  'keeper',
  'enpass',
  'keychain access',
  'chase',
  'wells fargo',
  'bank of america',
  'capital one',
  'paypal',
  'venmo',
  'cash app',
  'messages',
  'whatsapp',
  'signal',
  'telegram',
  'imessage'
]

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
 * Fallback shortcut chords, used only when the interaction provider cannot
 * observe key presses passively (no Accessibility permission, or non-macOS).
 *
 * Registering an accelerator claims the chord system-wide, so the recorded app
 * never receives it — hence C/V/X are omitted and the whole mechanism is skipped
 * whenever passive capture is available.
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
 * Main-process recorder: active-win polling + clipboard watcher + sparse
 * keyframes + an interaction provider that supplies clicks, typing and chords.
 *
 * Typed text is captured, but only ever in redacted form and never from secure
 * fields or from Ghost's own windows.
 */
export class TelemetryRecorder {
  private sessionId: string | null = null
  private sequence = 0
  private startedAtMs = 0
  private startedAtIso: string | null = null
  private recording = false
  private paused = false
  private processing = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private registeredShortcuts: string[] = []
  private lastAppKey: string | null = null
  private lastWindowKey: string | null = null
  private lastBounds: ActiveWinResult['bounds'] | null = null
  private lastScreenSnapshot: {
    loading?: boolean
    dialogs?: string[]
    windowTitle?: string
    urlHost?: string
    urlPath?: string
  } | null = null
  private lastFocusTarget: {
    role?: string
    label?: string
    appName?: string
  } | null = null
  private pendingClipboardPairId: string | null = null
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
      paused: this.paused,
      sessionId: this.sessionId,
      sequence: this.sequence,
      startedAt: this.startedAtIso,
      processing: this.processing
    }
  }

  /** True pause — halts the capture pipeline, not just the UI timer. */
  pauseRecording(): RecordingStatus {
    if (!this.recording || this.paused) return this.getRecordingStatus()
    this.paused = true
    this.stopPolling()
    this.unregisterShortcuts()
    this.interaction.flush?.()
    this.interaction.stop()
    this.clipboard.stop()
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.emitStatus()
    return this.getRecordingStatus()
  }

  resumeRecording(): RecordingStatus {
    if (!this.recording || !this.paused) return this.getRecordingStatus()
    this.paused = false
    this.startPolling()
    this.startClipboard()
    if (this.interaction.enabled) {
      this.interaction.start((partial) => this.ingestInteraction(partial))
    }
    this.registerShortcuts()
    this.emitStatus()
    return this.getRecordingStatus()
  }

  isNarrating(): boolean {
    return !!this.opts.narrate
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

  /** In-session clipboard plaintext (hash → text). Survives stop until next start. */
  getClipboardSessionValues(): Map<string, string> {
    return this.clipboard.snapshotSessionValues()
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
    this.paused = false
    this.processing = false
    this.lastAppKey = null
    this.lastWindowKey = null
    this.lastBounds = null
    this.lastScreenSnapshot = null
    this.lastFocusTarget = null
    this.pendingClipboardPairId = null
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
    this.startClipboard()

    if (this.interaction.enabled) {
      this.interaction.start((partial) => this.ingestInteraction(partial))
      this.interaction.onCapabilityChange?.(({ capturesKeys }) => {
        // The provider only learns whether the OS will deliver key events after
        // its child reports in; register the fallback if it will not.
        if (this.recording && !capturesKeys) this.registerShortcuts()
      })
    }
    this.registerShortcuts()

    this.emitStatus()
    return this.getRecordingStatus()
  }

  async stopRecording(): Promise<{ sessionId: string | null }> {
    if (!this.recording || !this.sessionId) {
      return { sessionId: this.sessionId }
    }

    this.stopPolling()
    this.unregisterShortcuts()
    // Flush before stop so a half-typed entry still lands in the session.
    this.interaction.flush?.()
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
    if (this.paused && type !== 'session_stopped') return null

    const display = this.displayInfo()
    const windowBounds = this.windowBounds()
    const data = {
      ...partial.data,
      display: partial.data?.display ?? display,
      windowBounds: partial.data?.windowBounds ?? windowBounds
    }

    const event: TelemetryEvent = redactEvent({
      schemaVersion: SCHEMA_VERSION,
      eventId: newId('tevt'),
      sessionId: this.sessionId,
      sequence: this.sequence++,
      timestamp: new Date().toISOString(),
      // elapsedMs is monotonic (session-relative) — the only legal duration source.
      elapsedMs: Math.max(0, Date.now() - this.startedAtMs),
      type,
      page: partial.page,
      route: partial.route,
      viewport: partial.viewport ?? this.viewport(),
      target: partial.target,
      data,
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

  private displayInfo(): { scale: number; width: number; height: number } {
    try {
      const d = screen.getPrimaryDisplay()
      return {
        scale: d.scaleFactor || 1,
        width: d.size.width,
        height: d.size.height
      }
    } catch {
      return { scale: 1, width: 0, height: 0 }
    }
  }

  private windowBounds():
    | { x: number; y: number; width: number; height: number }
    | undefined {
    if (!this.lastBounds) return undefined
    return {
      x: this.lastBounds.x ?? 0,
      y: this.lastBounds.y ?? 0,
      width: this.lastBounds.width ?? 0,
      height: this.lastBounds.height ?? 0
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
      if (!this.recording || this.paused) return
      const pairId = newId('clip')
      this.pendingClipboardPairId = pairId
      const clipboard = { ...change.clipboard, pairId }
      this.recordEvent('clipboard_changed', {
        target: this.lastFocusTarget
          ? {
              role: this.lastFocusTarget.role,
              accessibleLabel: this.lastFocusTarget.label,
              visibleLabel: this.lastFocusTarget.label,
              appName: this.lastFocusTarget.appName
            }
          : undefined,
        data: {
          clipboard,
          clipboardPairId: pairId,
          elementLabel: this.lastFocusTarget?.label,
          elementRole: this.lastFocusTarget?.role,
          appName: this.lastFocusTarget?.appName
        }
      })
      this.interaction.poke?.()
      void this.captureKeyframe('clipboard')
    })
  }

  private async pollActiveWindow(): Promise<void> {
    if (!this.recording || this.paused || !this.activeWin) return
    try {
      const fn = this.activeWin.default ?? this.activeWin
      const win = await fn()
      if (!win) return

      const appName = sanitizeLabel(win.owner?.name)
      if (this.shouldIgnoreApp(appName)) return

      if (win.bounds) this.lastBounds = win.bounds

      const snapshot = this.screenStates.fromActiveWindow(win)
      if (!snapshot) return

      const appKey = `${snapshot.appBundleId ?? snapshot.appName ?? ''}`
      const windowKey = `${appKey}|${snapshot.windowTitle ?? ''}`
      const screenKey = `${windowKey}|${snapshot.urlHost ?? ''}${snapshot.urlPath ?? ''}`
      const prevApp = this.lastAppKey
      const prevWindow = this.lastWindowKey
      const isFirst = prevApp === null
      const appChanged = prevApp !== null && prevApp !== appKey
      const windowChanged =
        !appChanged && prevWindow !== null && prevWindow !== windowKey
      this.lastAppKey = appKey
      this.lastWindowKey = windowKey

      const sanitized = sanitizeUrl(win.url)
      const urlHost = sanitized.rejected ? undefined : sanitized.urlHost
      const urlPath = sanitized.rejected ? undefined : sanitized.urlPath
      const urlQuery = sanitized.rejected ? undefined : sanitized.urlQuery
      const windowTitle = sanitizeWindowTitle(win.title)
      const pid = win.owner?.processId
      const commonData = {
        appName: snapshot.appName,
        appBundleId: snapshot.appBundleId,
        pid: typeof pid === 'number' && pid > 0 ? pid : undefined,
        windowTitle,
        documentTitle: windowTitle,
        urlHost,
        urlPath,
        urlQuery,
        userInitiated: true as const
      }

      if (isFirst || appChanged) {
        this.recordEvent('app_switch', {
          page: snapshot.page,
          route: snapshot.route,
          screenStateId: snapshot.screenStateId,
          target: {
            appName: snapshot.appName,
            appBundleId: snapshot.appBundleId
          },
          data: commonData
        })
        // Keep navigation for backward compatibility with polish/model.
        this.recordEvent('navigation', {
          page: snapshot.page,
          route: snapshot.route,
          screenStateId: snapshot.screenStateId,
          target: {
            appName: snapshot.appName,
            appBundleId: snapshot.appBundleId
          },
          data: commonData
        })
        this.interaction.poke?.()
        void this.captureKeyframe('app_changed')
      } else if (windowChanged) {
        this.recordEvent('window_switch', {
          page: snapshot.page,
          route: snapshot.route,
          screenStateId: snapshot.screenStateId,
          target: {
            appName: snapshot.appName,
            appBundleId: snapshot.appBundleId
          },
          data: commonData
        })
      }

      this.emitStateChanges(snapshot, windowTitle, urlHost, urlPath)

      this.recordEvent('screen_changed', {
        page: snapshot.page,
        route: snapshot.route,
        screenStateId: snapshot.screenStateId,
        target: {
          appName: snapshot.appName,
          appBundleId: snapshot.appBundleId
        },
        data: {
          ...commonData,
          headings: snapshot.headings,
          buttons: snapshot.buttons,
          dialogs: snapshot.dialogs,
          loading: snapshot.loading
        }
      })

      this.lastScreenSnapshot = {
        loading: snapshot.loading,
        dialogs: snapshot.dialogs,
        windowTitle,
        urlHost,
        urlPath
      }

      this.scheduleSettleKeyframe()
    } catch (err) {
      console.error('[telemetry] active-win poll failed', err instanceof Error ? err.name : 'error')
    }
  }

  private emitStateChanges(
    snapshot: { loading?: boolean; dialogs?: string[] },
    windowTitle?: string,
    urlHost?: string,
    urlPath?: string
  ): void {
    const prev = this.lastScreenSnapshot
    if (!prev) return

    if (prev.loading === true && snapshot.loading === false) {
      this.recordEvent('state_change', {
        data: {
          stateChangeKind: 'loading_finished',
          stateChangeDetail: 'Spinner / loading indicator cleared'
        }
      })
    } else if (prev.loading === false && snapshot.loading === true) {
      this.recordEvent('state_change', {
        data: {
          stateChangeKind: 'loading_started',
          stateChangeDetail: 'Loading indicator appeared'
        }
      })
    }

    const prevDialogs = new Set(prev.dialogs ?? [])
    for (const d of snapshot.dialogs ?? []) {
      if (!prevDialogs.has(d)) {
        this.recordEvent('state_change', {
          data: {
            stateChangeKind: 'dialog_appeared',
            stateChangeElement: d,
            stateChangeDetail: `Dialog appeared: ${d}`
          }
        })
      }
    }
    const nextDialogs = new Set(snapshot.dialogs ?? [])
    for (const d of prev.dialogs ?? []) {
      if (!nextDialogs.has(d)) {
        this.recordEvent('state_change', {
          data: {
            stateChangeKind: 'dialog_dismissed',
            stateChangeElement: d,
            stateChangeDetail: `Dialog dismissed: ${d}`
          }
        })
      }
    }

    if (prev.windowTitle && windowTitle && prev.windowTitle !== windowTitle) {
      this.recordEvent('state_change', {
        data: {
          stateChangeKind: 'title_changed',
          stateChangeDetail: `Title: ${prev.windowTitle} → ${windowTitle}`
        }
      })
    }

    if (
      (prev.urlHost || prev.urlPath) &&
      (urlHost !== prev.urlHost || urlPath !== prev.urlPath)
    ) {
      this.recordEvent('state_change', {
        data: {
          stateChangeKind: 'url_changed',
          stateChangeDetail: `URL → ${urlHost ?? ''}${urlPath ?? ''}`
        }
      })
    }
  }

  /**
   * Whether events from this app must be discarded — Ghost itself, denylisted
   * apps (password managers / banking / messaging), or outside the one-app scope.
   */
  private shouldIgnoreApp(appName?: string): boolean {
    if (!appName) return false
    const lower = appName.toLowerCase()

    const ignore = this.opts.ignoreAppNames ?? ['ghost', 'Electron', 'yuh']
    if (ignore.some((n) => lower === n.toLowerCase())) return true
    if (APP_DENYLIST.some((n) => lower.includes(n))) return true

    if (this.opts.recordMode === 'one-app' && this.opts.selectedAppId) {
      const selected = this.opts.selectedAppId.toLowerCase()
      const aliases: Record<string, string[]> = {
        chrome: ['google chrome', 'chrome', 'chromium'],
        figma: ['figma'],
        slack: ['slack'],
        finder: ['finder'],
        mail: ['mail']
      }
      const names = aliases[selected] ?? [selected]
      if (!names.some((n) => lower.includes(n))) return true
    }

    return false
  }

  private scheduleSettleKeyframe(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      if (!this.recording) return
      void this.captureKeyframe('settle')
    }, 1500)
  }

  private async captureKeyframe(
    reason: KeyframeReason,
    boundsOverride?: { x: number; y: number; width: number; height: number }
  ): Promise<string | null> {
    if (!this.screenshot.enabled || !this.sessionId || !this.recording || this.paused) {
      return null
    }
    const eventId = newId('tevt')
    try {
      const bounds =
        boundsOverride ??
        (this.lastBounds
          ? {
              x: this.lastBounds.x ?? 0,
              y: this.lastBounds.y ?? 0,
              width: this.lastBounds.width ?? 0,
              height: this.lastBounds.height ?? 0
            }
          : undefined)
      const result = await this.screenshot.captureKeyframe(`ss_${eventId}`, {
        reason,
        bounds,
        sessionId: this.sessionId,
        eventId
      })
      if (result?.relativePath) {
        if (reason !== 'pre_action' && reason !== 'post_action' && reason !== 'target_crop') {
          this.recordEvent('keyframe_captured', {
            data: {
              keyframePath: result.relativePath,
              message: reason
            }
          })
        }
        return result.relativePath
      }
    } catch {
      /* never block recording on keyframe failure */
    }
    return null
  }

  private registerShortcuts(): void {
    // Passive observation is strictly better: it sees every chord (including
    // Cmd+C/V/X) without intercepting it from the app being recorded.
    if (this.interaction.capturesKeys) return
    if (this.registeredShortcuts.length > 0) return
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
    if (!this.recording || this.paused) return
    if (this.shouldIgnoreApp(partial.data?.appName ?? partial.target?.appName)) return

    if (partial.type === 'focus_changed') {
      this.lastFocusTarget = {
        role: partial.data?.elementRole ?? partial.target?.role,
        label:
          partial.data?.elementLabel ??
          partial.target?.accessibleLabel ??
          partial.target?.visibleLabel,
        appName: partial.data?.appName ?? partial.target?.appName
      }
    }

    // Enrich clicks with window-relative coordinates when we have window bounds.
    let data = partial.data
    if (
      (partial.type === 'click' || partial.type === 'element_activated') &&
      data?.clickX != null &&
      data?.clickY != null &&
      this.lastBounds
    ) {
      const wx = this.lastBounds.x ?? 0
      const wy = this.lastBounds.y ?? 0
      data = {
        ...data,
        clickWindowX: data.clickX - wx,
        clickWindowY: data.clickY - wy
      }
    }

    // An observed paste chord is direct evidence — no length heuristics needed.
    if (partial.type === 'keyboard_shortcut' && isPasteChord(partial.data?.shortcut)) {
      const latest = this.clipboard.getLatest()
      if (latest) {
        const pairId = this.pendingClipboardPairId ?? latest.clipboard.pairId
        this.recordEvent('paste_detected', {
          target: partial.target,
          data: {
            ...data,
            clipboard: { ...latest.clipboard, pairId: pairId ?? latest.clipboard.pairId },
            matchedClipboardHash: latest.clipboard.contentHash,
            clipboardPairId: pairId
          }
        })
        return
      }
    }

    // Paste inference: field length jumped after a recent clipboard change.
    if (partial.type === 'focus_changed' || partial.type === 'field_completed') {
      const len = data?.field?.valueLength
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
            const pairId = this.pendingClipboardPairId ?? latest.clipboard.pairId
            this.recordEvent('paste_detected', {
              target: partial.target,
              data: {
                ...data,
                clipboard: { ...latest.clipboard, pairId: pairId ?? latest.clipboard.pairId },
                matchedClipboardHash: latest.clipboard.contentHash,
                clipboardPairId: pairId,
                charCountDelta: result.charCountDelta,
                inferred: true
              }
            })
          }
        }
        this.lastFieldLength = len
      }
    }

    // Record the interaction immediately so callers/tests see it without waiting
    // on screenshot I/O; attach pre/post shot paths asynchronously when enabled.
    this.recordEvent(partial.type, {
      target: partial.target,
      data
    })

    if (partial.type === 'element_activated' || partial.type === 'click') {
      this.interaction.poke?.()
      void this.captureActionShots(data)
    }
  }

  /** Pre/post screenshots + optional target crop at action boundaries. */
  private async captureActionShots(data: InteractionPartial['data']): Promise<void> {
    if (!this.screenshot.enabled) return
    const pre = await this.captureKeyframe('pre_action')
    if (pre) {
      this.recordEvent('keyframe_captured', {
        data: { keyframePath: pre, preShotPath: pre, message: 'pre_action' }
      })
    }
    if (data?.elementBounds) {
      const crop = await this.captureKeyframe('target_crop', data.elementBounds)
      if (crop) {
        this.recordEvent('keyframe_captured', {
          data: { keyframePath: crop, targetCropPath: crop, message: 'target_crop' }
        })
      }
    }
    const post = await this.captureKeyframe('post_action')
    if (post) {
      this.recordEvent('keyframe_captured', {
        data: { keyframePath: post, postShotPath: post, message: 'post_action' }
      })
    }
  }
}

/** Cmd+V / Ctrl+V, including Shift+Cmd+V ("paste and match style"). */
function isPasteChord(shortcut?: string): boolean {
  if (!shortcut) return false
  return /^(?:Cmd|Ctrl)(?:\+(?:Alt|Shift))*\+V$/i.test(shortcut)
}
