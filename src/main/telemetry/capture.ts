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
import { TelemetryQueue, type DrainResult } from './queue'
import { ScreenStateTracker } from './screenState'
import type { TelemetryStore } from './store/TelemetryStore'

/** Main-owned lifecycle phase (M2). Only `recording` admits new source reads. */
export type RecordingPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'

export type RecordingStatus = {
  recording: boolean
  paused: boolean
  sessionId: string | null
  sequence: number
  startedAt: string | null
  processing: boolean
  phase: RecordingPhase
  /** Bumped at every source boundary; callbacks from an older generation are rejected. */
  generation: number
  /** A source did not confirm shutdown (e.g. sensor child never exited); capture is unavailable. */
  teardownFailed: boolean
}

/** Ingress accounting across boundaries (counts only, never content). */
export type IngressStats = {
  accepted: number
  /** Callback from an older generation (after pause/resume/stop) — rejected before use. */
  rejectedStale: number
  /** Arrived while ingress was closed (paused/stopping) — rejected before use. */
  rejectedClosed: number
  /** Events recorded by already-admitted work after its boundary (allowed final drain). */
  drainedAfterBoundary: number
}

/** A start that failed after its session was created; the caller marks it incomplete. */
export class StartFailedError extends Error {
  constructor(readonly sessionId: string | null) {
    super('[telemetry] start failed')
  }
}

/** Outcome of the owned Stop barrier — what was actually persisted vs pending/lost. */
export type StopResult = {
  sessionId: string | null
  /** Sequence of the terminal session_stopped event. */
  finalSequence?: number
  events?: DrainResult
  artifacts?: { saved: number; skipped: number; failed: number; paths: string[] }
  /** A source did not confirm shutdown; the save must not be reported complete. */
  teardownFailed?: boolean
}

export type CaptureOptions = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  ownerEmail?: string
  /** Capture voice narration for this session. */
  narrate?: boolean
  /**
   * Runs after the session is created and before any source starts (e.g. open the
   * narration sink). A rejection rolls the whole start back.
   */
  beforeSources?: (sessionId: string) => Promise<void>
  /**
   * Checked after every Start await and before sources start (M2-R2). False (owner lost,
   * Stop/hide/quit/revoke requested) cancels the start: no source ever starts.
   */
  shouldContinue?: () => boolean
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
/** Admitted async source work (window polls, screenshots) owned until Stop drains it. */
const MAX_ADMITTED_JOBS = 16

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
  private phase: RecordingPhase = 'idle'
  private generation = 0
  private sourcesActive = false
  private sourceStop: Promise<void> = Promise.resolve()
  private teardownFailed = false
  /** Serializes start/pause/resume/stop; stop still halts sources synchronously first. */
  private transitions: Promise<unknown> = Promise.resolve()
  private ingress: IngressStats = { accepted: 0, rejectedStale: 0, rejectedClosed: 0, drainedAfterBoundary: 0 }
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
  /** Set once Stop owns the recorder: no new source reads, admitted work still lands. */
  private finalizing = false
  private stopPromise: Promise<StopResult> | null = null
  private admittedJobs = new Set<Promise<unknown>>()
  private artifactStats = { saved: 0, nulls: 0, failed: 0, writeFailures: 0, paths: [] as string[] }

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
      processing: this.processing,
      phase: this.phase,
      generation: this.generation,
      teardownFailed: this.teardownFailed
    }
  }

  getIngressStats(): IngressStats {
    return { ...this.ingress }
  }

  /**
   * True pause. Buffered text is flushed while ingress is still open, then sources stop,
   * the generation is invalidated and admitted work drains. Acknowledged only after the
   * interaction child has exited (bounded) and no source can read.
   */
  pauseRecording(): Promise<RecordingStatus> {
    return this.serial(async () => {
      if (this.phase !== 'recording') return this.getRecordingStatus()
      this.phase = 'pausing'
      this.emitStatus()
      this.haltSources()
      await this.drainSources()
      // A Stop that arrived meanwhile owns the recorder now.
      if (this.phase === 'pausing') {
        this.paused = true
        this.phase = 'paused'
      }
      this.emitStatus()
      return this.getRecordingStatus()
    })
  }

  resumeRecording(): Promise<RecordingStatus> {
    return this.serial(async () => {
      // Never resume across a requested Stop or an unconfirmed source teardown.
      if (this.phase !== 'paused' || this.stopPromise || this.teardownFailed) {
        return this.getRecordingStatus()
      }
      this.phase = 'resuming'
      this.paused = false
      this.finalizing = false
      this.startSources()
      this.phase = 'recording'
      this.emitStatus()
      return this.getRecordingStatus()
    })
  }

  /**
   * Immediately stop every source and close ingress (idempotent, synchronous). Used by
   * Stop and by main's owner-loss/hide/quit barrier before any I/O can fail.
   */
  haltSources(): void {
    if (this.sourcesActive) {
      this.stopPolling()
      this.unregisterShortcuts()
      // Flush while ingress is still open so a half-typed entry lands in the session.
      try {
        this.interaction.flush?.()
      } catch {
        /* never block the halt */
      }
      this.sourcesActive = false
      this.generation += 1
      // A stop failure is kept (not swallowed); every other source still halts.
      this.sourceStop = Promise.resolve().then(() => this.interaction.stop())
      try {
        this.clipboard.stop()
      } catch {
        /* never block the halt */
      }
    }
    this.finalizing = true
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  private startSources(): void {
    this.generation += 1
    const gen = this.generation
    this.sourcesActive = true
    this.startPolling(gen)
    this.startClipboard(gen)
    if (this.interaction.enabled) {
      this.interaction.start((partial) => this.ingestInteraction(partial, gen))
    }
    this.registerShortcuts(gen)
  }

  /** Await the interaction child's exit and every admitted job (their events still land). */
  private async drainSources(): Promise<void> {
    try {
      await this.sourceStop
    } catch {
      // Unconfirmed source shutdown: reported, keeps capture unavailable, never "stopped".
      this.teardownFailed = true
    }
    while (this.admittedJobs.size > 0) {
      await Promise.allSettled([...this.admittedJobs])
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.transitions.then(fn, fn)
    this.transitions = run.catch(() => undefined)
    return run
  }

  /** Gate for every source callback: current generation and open ingress only. */
  private admits(gen: number): boolean {
    if (gen !== this.generation) {
      this.ingress.rejectedStale += 1
      return false
    }
    if (!this.recording || this.paused || this.finalizing) {
      this.ingress.rejectedClosed += 1
      return false
    }
    this.ingress.accepted += 1
    return true
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

  startRecording(opts: CaptureOptions = {}): Promise<RecordingStatus> {
    if (this.phase !== 'idle') return Promise.resolve(this.getRecordingStatus())
    return this.serial(() => this.doStart(opts))
  }

  /** Nothing reads until storage and the optional pre-source hook succeed; failure rolls back. */
  private async doStart(opts: CaptureOptions): Promise<RecordingStatus> {
    if (this.phase !== 'idle') return this.getRecordingStatus()
    if (!this.store) {
      throw new Error('[telemetry] no TelemetryStore configured')
    }
    // A previous source has not confirmed shutdown: no session, no overlapping source.
    if (this.interaction.teardownPending) throw new StartFailedError(null)

    this.opts = opts
    this.teardownFailed = false
    this.sessionId = newId('tsess')
    this.sequence = 0
    this.startedAtMs = Date.now()
    this.startedAtIso = new Date(this.startedAtMs).toISOString()
    this.phase = 'starting'
    this.recording = false
    this.paused = false
    this.processing = false
    this.ingress = { accepted: 0, rejectedStale: 0, rejectedClosed: 0, drainedAfterBoundary: 0 }
    this.lastAppKey = null
    this.lastWindowKey = null
    this.lastBounds = null
    this.lastScreenSnapshot = null
    this.lastFocusTarget = null
    this.pendingClipboardPairId = null
    this.lastFieldLength = null
    this.finalizing = false
    this.artifactStats = { saved: 0, nulls: 0, failed: 0, writeFailures: 0, paths: [] }
    this.screenStates.reset()

    const sessionId = this.sessionId
    let created = false
    const proceed = () => {
      if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('[telemetry] start cancelled')
    }
    try {
      await this.store.ensureReady()
      proceed()
      await this.store.createSession({
        sessionId,
        ownerEmail: opts.ownerEmail,
        recordMode: opts.recordMode,
        selectedAppId: opts.selectedAppId
      })
      created = true
      proceed()
      await opts.beforeSources?.(sessionId)
      proceed()

      this.queue = new TelemetryQueue(this.store)
      this.queue.start()
      this.recording = true
      this.finalizing = false

      this.recordEvent('session_started', {
        data: {
          appName: 'ghost',
          message: 'Recording started'
        }
      })

      await this.ensureActiveWin()
      proceed()
      this.startSources()
      if (this.interaction.enabled) {
        this.interaction.onCapabilityChange?.(({ capturesKeys }) => {
          // The provider only learns whether the OS will deliver key events after
          // its child reports in; register the fallback if it will not.
          if (this.phase === 'recording' && !capturesKeys) this.registerShortcuts(this.generation)
        })
      }
      this.phase = 'recording'
    } catch {
      // Roll back: no source may keep reading for a session that never started.
      this.haltSources()
      await this.drainSources()
      this.queue?.stop()
      this.queue = null
      this.recording = false
      this.finalizing = false
      this.sessionId = null
      this.phase = 'idle'
      this.emitStatus()
      throw new StartFailedError(created ? sessionId : null)
    }

    this.emitStatus()
    return this.getRecordingStatus()
  }

  /**
   * Owned Stop barrier. Duplicate calls join the same promise. Order: flush buffered
   * text, close source ingress, await admitted window/screenshot jobs, emit the terminal
   * event, then drain the queue and report persisted vs pending/lost counts.
   */
  stopRecording(): Promise<StopResult> {
    if (this.stopPromise) return this.stopPromise
    if (this.phase === 'idle' || !this.sessionId) {
      return Promise.resolve({ sessionId: this.sessionId })
    }
    // Halt before queueing behind any transition, and before any status I/O can fail.
    this.haltSources()
    this.stopPromise = this.serial(() => this.finalize()).finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  /** Same-session local retry: drain retained events again (after relaunch, from the outbox). */
  async retrySessionDrain(sessionId: string): Promise<DrainResult | null> {
    if (!this.store) return null
    if (this.recording && this.sessionId === sessionId) return null
    if (!this.queue) {
      this.queue = new TelemetryQueue(this.store)
      this.queue.restoreOutbox()
    }
    return this.queue.drain(sessionId)
  }

  /** Called by the keyframe store wrapper when a frame write fails for this session. */
  noteArtifactWriteFailure(sessionId: string): void {
    if (sessionId === this.sessionId) this.artifactStats.writeFailures += 1
  }

  private async finalize(): Promise<StopResult> {
    const sessionId = this.sessionId
    // A start that rolled back while this Stop was queued leaves nothing to finalize.
    if (!sessionId || this.phase === 'idle') return { sessionId }
    this.phase = 'stopping'
    this.emitStatus()
    this.haltSources()
    // Admitted jobs may still record their events; no new reads are accepted.
    await this.drainSources()

    const stopped = this.recordEvent('session_stopped', {
      data: { message: 'Recording stopped' }
    })

    this.recording = false
    this.paused = false
    let events: DrainResult | undefined
    try {
      events = this.queue ? await this.queue.drain(sessionId) : undefined
      if (this.store && events && events.pending === 0) {
        await this.store.stopSession(sessionId)
      }
    } finally {
      this.queue?.stop()
      this.finalizing = false
      this.phase = 'idle'
      this.emitStatus()
    }
    const a = this.artifactStats
    return {
      sessionId,
      finalSequence: stopped?.sequence,
      events,
      artifacts: {
        saved: a.saved,
        failed: a.failed + a.writeFailures,
        skipped: Math.max(0, a.nulls - a.writeFailures),
        paths: [...a.paths]
      },
      ...(this.teardownFailed ? { teardownFailed: true } : {})
    }
  }

  /** Own async source work so Stop can await it; bounded, over-limit work is skipped. */
  private admit(job: () => Promise<unknown>): void {
    if (this.admittedJobs.size >= MAX_ADMITTED_JOBS) {
      this.artifactStats.nulls += 1
      return
    }
    const p = job().catch(() => undefined)
    this.admittedJobs.add(p)
    void p.finally(() => this.admittedJobs.delete(p))
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
    if (this.finalizing && type !== 'session_stopped') this.ingress.drainedAfterBoundary += 1

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

  private startPolling(gen: number): void {
    if (this.pollTimer) return
    this.pollTimer = setInterval(() => {
      if (this.admits(gen)) this.admit(() => this.pollActiveWindow(gen))
    }, POLL_MS)
    if (this.admits(gen)) this.admit(() => this.pollActiveWindow(gen))
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private startClipboard(gen: number): void {
    this.clipboard.start((change) => {
      if (!this.admits(gen)) return
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
      this.admit(() => this.captureKeyframe('clipboard'))
    })
  }

  private async pollActiveWindow(gen: number): Promise<void> {
    // Re-checked at the read: a boundary may have passed since this job was admitted.
    if (gen !== this.generation || !this.recording || this.paused || this.finalizing || !this.activeWin) {
      return
    }
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
        this.admit(() => this.captureKeyframe('app_changed'))
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
    this.settleTimer = null
    if (this.finalizing || this.paused) return
    this.settleTimer = setTimeout(() => {
      if (!this.recording || this.finalizing) return
      this.admit(() => this.captureKeyframe('settle'))
    }, 1500)
  }

  private async captureKeyframe(
    reason: KeyframeReason,
    boundsOverride?: { x: number; y: number; width: number; height: number }
  ): Promise<string | null> {
    if (
      !this.screenshot.enabled ||
      !this.sessionId ||
      !this.recording ||
      this.paused ||
      this.finalizing
    ) {
      return null
    }
    const sessionId = this.sessionId
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
        sessionId,
        eventId
      })
      // A late completion can never attach to a later session.
      if (this.sessionId !== sessionId) return null
      if (!result?.relativePath) this.artifactStats.nulls += 1
      if (result?.relativePath) {
        this.artifactStats.saved += 1
        this.artifactStats.paths.push(result.relativePath)
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
      /* never block recording on keyframe failure; counted for the save manifest */
      if (this.sessionId === sessionId) this.artifactStats.failed += 1
    }
    return null
  }

  private registerShortcuts(gen: number): void {
    // Passive observation is strictly better: it sees every chord (including
    // Cmd+C/V/X) without intercepting it from the app being recorded.
    if (this.interaction.capturesKeys) return
    if (this.registeredShortcuts.length > 0 || gen !== this.generation || !this.sourcesActive) return
    for (const { accelerator, label } of SHORTCUTS) {
      try {
        const ok = globalShortcut.register(accelerator, () => {
          if (!this.admits(gen)) return
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

  private ingestInteraction(partial: InteractionPartial, gen: number): void {
    if (!this.admits(gen)) return
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

    // Enrich clicks with window-relative coordinates.
    // Prefer AX windowBounds from the hit-test; fall back to polled active-win bounds.
    let data = partial.data
    if (
      (partial.type === 'click' || partial.type === 'element_activated') &&
      data?.clickX != null &&
      data?.clickY != null
    ) {
      const axWin = data.windowBounds
      const polled = this.lastBounds
        ? {
            x: this.lastBounds.x ?? 0,
            y: this.lastBounds.y ?? 0,
            width: this.lastBounds.width ?? 0,
            height: this.lastBounds.height ?? 0
          }
        : undefined
      const win = axWin ?? polled
      if (win) {
        data = {
          ...data,
          windowBounds: win,
          clickWindowX: data.clickWindowX ?? data.clickX - win.x,
          clickWindowY: data.clickWindowY ?? data.clickY - win.y
        }
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
      this.admit(() => this.captureActionShots(data))
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
