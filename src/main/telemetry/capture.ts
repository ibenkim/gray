import { screen } from 'electron'
import { newId } from '../../shared/id'
import {
  EVENT_SCHEMA_VERSION,
  type ArtifactRef,
  type DisplayInfo,
  type ScreenshotCaptureStatus,
  type TelemetryEvent,
  type TelemetryEventType
} from '../../shared/telemetry/schema'
import { redactEvent, sanitizeLabel, sanitizeUrl, sanitizeWindowTitle } from '../../shared/telemetry/sanitize'
import { ClipboardWatcher, inferPaste } from './clipboard'
import {
  appInScope,
  appScope,
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
  artifacts?: { saved: number; skipped: number; failed: number; paths: string[]; undeleted?: string[] }
  /** A source did not confirm shutdown; the save must not be reported complete. */
  teardownFailed?: boolean
}

export type CaptureOptions = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  /** Every app a one-app recording may read (multi-select); `selectedAppId` is the first. */
  selectedAppIds?: string[]
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
/** M10 frame request policy: one in flight, spaced, capped per session. */
const SHOT_MIN_INTERVAL_MS = 1000
const MAX_SHOTS_PER_SESSION = 120
/** Post-action frames wait for the UI to settle (a deadline, not an immediate capture). */
const POST_SETTLE_MS = 700
/** A "pre" reference older than this says nothing about the state just before the action. */
const PRE_MAX_AGE_MS = 5000

/**
 * Main-process recorder: active-win polling + clipboard watcher + sparse
 * keyframes + an interaction provider that supplies clicks, typing and chords.
 *
 * Typed text is captured, but only ever in redacted form and never from secure
 * fields or from Gray's own windows.
 */
export class TelemetryRecorder {
  private sessionId: string | null = null
  private sequence = 0
  /** Monotonic clock reading at session start; elapsedMs is measured from it. */
  /** True while an interaction partial is being recorded (buffered typing was flushed first). */
  private ingesting = false
  private startedAtMono = 0
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
  private keyboardDeclared = false
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
  private readonly clock: () => number
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
  /** M10 request state for the current session (reset at Start). */
  private shots = freshShotState()
  /** Wakes post-action settle waits when sources halt (pause/Stop), so none outlives them. */
  private shotWaits = new Set<() => void>()

  constructor(
    private readonly store: TelemetryStore | null,
    providers?: {
      interaction?: InteractionProvider
      screenshot?: ScreenshotProvider
      clipboard?: ClipboardWatcher
      /** Monotonic milliseconds (default performance.now). Wall time is for display only. */
      clock?: () => number
    }
  ) {
    this.clock = providers?.clock ?? (() => performance.now())
    this.interaction = providers?.interaction ?? new NoopInteractionProvider()
    this.screenshot = providers?.screenshot ?? new DisabledScreenshotProvider()
    this.screenStates = new ScreenStateTracker()
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
        this.recordEvent('session_paused')
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
      this.recordEvent('session_resumed')
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
    }
    this.finalizing = true
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    for (const wake of [...this.shotWaits]) wake()
  }

  private startSources(): void {
    this.generation += 1
    const gen = this.generation
    this.sourcesActive = true
    this.startPolling(gen)
    if (this.interaction.enabled) {
      this.interaction.start(
        (partial) => this.ingestInteraction(partial, gen),
        appScope(this.opts),
        this.clock
      )
    }
    this.declareKeyboardCapability(this.interaction.enabled ? this.interaction.capturesKeys : false)
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
    this.startedAtMono = this.clock()
    this.startedAtIso = new Date().toISOString()
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
    this.keyboardDeclared = false
    this.lastFieldLength = null
    this.finalizing = false
    this.artifactStats = { saved: 0, nulls: 0, failed: 0, writeFailures: 0, paths: [] }
    this.shots = freshShotState()
    this.screenStates.reset()
    this.clipboard.reset()

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
        selectedAppId: opts.selectedAppId,
        ...(opts.selectedAppIds?.length ? { selectedAppIds: opts.selectedAppIds } : {}),
        screenshotCapture: this.screenshotCaptureStatus()
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
          appName: 'gray',
          message: 'Recording started'
        }
      })

      await this.ensureActiveWin()
      proceed()
      this.startSources()
      if (this.interaction.enabled) {
        this.interaction.onCapabilityChange?.(({ capturesKeys }) => {
          // The provider only learns whether the OS will deliver key events after its child
          // reports in; declare the reduced capability if it will not.
          if (this.phase === 'recording') this.declareKeyboardCapability(capturesKeys)
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

  /**
   * Save retry: delete frames a stopped session must not keep. Returns the paths still on disk.
   * Only paths in the session's own frame layout are attempted (the store re-validates).
   */
  async retryUndeleted(sessionId: string, paths: string[]): Promise<string[]> {
    const remaining: string[] = []
    for (const path of paths) {
      const own = path.startsWith(`sessions/${sessionId}/shots/`) || path.startsWith(`${sessionId}/`)
      try {
        if (!own || !this.screenshot.discard) throw new Error('not deletable here')
        await this.screenshot.discard(path)
      } catch {
        remaining.push(path)
      }
    }
    return remaining
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
    // A frame that must not be kept and could not be deleted is retried once; still there →
    // the save is incomplete (counted failed), never silently left behind.
    for (const path of [...this.shots.undiscarded]) await this.discardFrame(path)
    // Still on disk: the save fails and reports these paths, owed until a Save retry deletes them.
    const undeleted = [...this.shots.undiscarded]
    this.artifactStats.failed += undeleted.length

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
        paths: [...a.paths],
        ...(undeleted.length ? { undeleted } : {})
      },
      ...(this.teardownFailed ? { teardownFailed: true } : {})
    }
  }

  /** Own async source work so Stop can await it; bounded, over-limit work is skipped (false). */
  private admit(job: () => Promise<unknown>): boolean {
    if (this.admittedJobs.size >= MAX_ADMITTED_JOBS) {
      this.artifactStats.nulls += 1
      return false
    }
    const p = job().catch(() => undefined)
    this.admittedJobs.add(p)
    void p.finally(() => this.admittedJobs.delete(p))
    return true
  }

  recordEvent(
    type: TelemetryEventType,
    partial: Partial<
      Pick<TelemetryEvent, 'page' | 'route' | 'viewport' | 'target' | 'data' | 'screenStateId'>
    > &
      Pick<InteractionPartial, 'occurredAt' | 'startedAt'> = {}
  ): TelemetryEvent | null {
    if (!this.sessionId) return null
    if (!this.recording && type !== 'session_stopped') return null
    if (this.paused && type !== 'session_stopped') return null
    // Sequencing owner: buffered typing happened earlier than anything recorded now, so it is
    // emitted first; sequence order then agrees with occurrence order.
    if (!this.ingesting && this.sourcesActive) this.flushInteraction()
    // Boundary markers are the recorder's own, not late source input.
    if (this.finalizing && type !== 'session_stopped' && type !== 'session_paused') {
      this.ingress.drainedAfterBoundary += 1
    }

    const point =
      partial.data?.clickX != null && partial.data?.clickY != null
        ? { x: partial.data.clickX, y: partial.data.clickY }
        : undefined
    const windowBounds = this.windowBounds()
    const data = {
      ...partial.data,
      display: partial.data?.display ?? this.displayInfo(point),
      windowBounds: partial.data?.windowBounds ?? windowBounds
    }

    const event: TelemetryEvent = redactEvent({
      schemaVersion: EVENT_SCHEMA_VERSION,
      eventId: newId('tevt'),
      sessionId: this.sessionId,
      sequence: this.sequence++,
      // Wall time, display only. elapsedMs (monotonic, session-relative) is the only legal
      // duration and order source; it keeps running through pauses, so gaps stay explicit.
      timestamp: new Date().toISOString(),
      elapsedMs: this.sinceStart(partial.occurredAt ?? this.clock()),
      ...(partial.startedAt !== undefined ? { startElapsedMs: this.sinceStart(partial.startedAt) } : {}),
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

  private flushInteraction(): void {
    try {
      this.interaction.flush?.()
    } catch {
      /* never block recording */
    }
  }

  private sinceStart(mono: number): number {
    return Math.max(0, Math.round(mono - this.startedAtMono))
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

  /**
   * The display containing the event's global point (negative origins and mixed scales are
   * ordinary), else the primary display for point-less events. A point no display contains
   * gets no display rather than a guessed one.
   */
  private displayInfo(point?: { x: number; y: number }): DisplayInfo | undefined {
    try {
      const d = point
        ? screen.getAllDisplays().find(
            ({ bounds: b }) =>
              point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height
          )
        : screen.getPrimaryDisplay()
      if (!d) return undefined
      return {
        id: d.id,
        x: Math.round(d.bounds.x),
        y: Math.round(d.bounds.y),
        width: Math.round(d.bounds.width),
        height: Math.round(d.bounds.height),
        scale: d.scaleFactor || 1,
        binding: point ? 'event_point' : 'primary'
      }
    } catch {
      return undefined
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

  /**
   * M3-B: record a copy the sensor verified (one pasteboard change by the chord's in-scope
   * app). The main process never reads the clipboard; only the classified event is kept.
   */
  private recordCopy(appName: string, partial: InteractionPartial): void {
    const copy = partial.copy
    if (!copy) return
    const change = this.clipboard.ingestText(copy.text ?? '', copy.types, copy.pasteboard)
    if (!change) return
    const pairId = newId('clip')
    this.pendingClipboardPairId = pairId
    this.recordEvent('clipboard_changed', {
      target: { ...partial.target, appName },
      data: {
        clipboard: { ...change.clipboard, pairId },
        clipboardPairId: pairId,
        clipboardAction: copy.action,
        elementLabel: partial.data?.elementLabel,
        elementRole: partial.data?.elementRole,
        appName
      }
    })
    this.interaction.poke?.()
    this.admit(() => this.captureKeyframe('clipboard'))
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
   * Whether events from this app must be discarded — Gray itself, denylisted apps
   * (password managers / banking / messaging), outside the one-app scope, or unknown (M3-C).
   */
  private shouldIgnoreApp(appName?: string): boolean {
    return !appInScope(appScope(this.opts), appName)
  }

  /**
   * Trusted screenshot availability for a new session (M3-A): only the disabled provider that
   * declares it may claim `disabled_privacy`; any other source is `unknown`. Never taken from
   * a renderer/IPC payload.
   */
  private screenshotCaptureStatus(): ScreenshotCaptureStatus {
    const s = this.screenshot
    return s instanceof DisabledScreenshotProvider && !s.enabled && s.availability === 'disabled_privacy'
      ? 'disabled_privacy'
      : 'unknown'
  }

  private scheduleSettleKeyframe(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
    // The settle timer exists only to take a screenshot.
    if (!this.screenshot.enabled || this.finalizing || this.paused) return
    this.settleTimer = setTimeout(() => {
      if (!this.recording || this.finalizing) return
      this.admit(() => this.captureKeyframe('settle'))
    }, 1500)
  }

  /** Background frame (app change, clipboard, settle): kept only when stored, else counted. */
  private async captureKeyframe(reason: KeyframeReason): Promise<string | null> {
    const ref = await this.acquireFrame(reason, 'background')
    if (ref.status !== 'stored') return null
    this.recordEvent('keyframe_captured', {
      data: { keyframePath: ref.relativePath, message: reason, artifact: ref }
    })
    return ref.relativePath ?? null
  }

  /**
   * One frame request, settled with an explicit status (M10). Bounded: one in flight, spaced
   * by SHOT_MIN_INTERVAL_MS, MAX_SHOTS_PER_SESSION per session; background frames yield to a
   * pending action frame. A frame not declared `masked`, or completing after its session or
   * generation ended, is discarded, never kept or attached.
   */
  private async acquireFrame(
    reason: KeyframeReason,
    phase: 'post' | 'background',
    actionEventId?: string
  ): Promise<ArtifactRef> {
    const ref = (status: ArtifactRef['status'], why?: string): ArtifactRef => {
      this.noteShot(status)
      return { phase, status, ...(actionEventId ? { actionEventId } : {}), ...(why ? { reason: why } : {}) }
    }
    if (!this.screenshot.enabled) return ref('unavailable', 'capture_disabled')
    // A source that cannot delete a frame it must not keep cannot be used at all.
    if (!this.screenshot.discard) return ref('unavailable', 'no_discard')
    if (!this.sessionId || !this.recording || this.paused || this.finalizing) return ref('denied', 'session_closed')
    const shots = this.shots
    if (shots.inFlight) return ref('busy')
    if (shots.requests >= MAX_SHOTS_PER_SESSION) return ref('throttled', 'session_cap')
    const now = this.clock()
    if (now - shots.lastAt < SHOT_MIN_INTERVAL_MS) return ref('throttled', 'min_interval')
    if (phase === 'background' && shots.postsPending > 0) return ref('throttled', 'action_priority')

    const sessionId = this.sessionId
    const gen = this.generation
    const eventId = newId('tevt')
    shots.inFlight = true
    shots.lastAt = now
    shots.requests += 1
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
        sessionId,
        eventId
      })
      // The pixels were acquired somewhere in [now, done]: only `done` is known to be after them.
      const done = this.clock()
      const late = this.sessionId !== sessionId || this.generation !== gen
      if (result?.relativePath) {
        const refused = late ? 'session_changed' : result.redaction !== 'masked' ? 'unredacted' : unsafePath(result.relativePath)
        if (refused) {
          await this.discardFrame(result.relativePath)
          return ref('denied', refused)
        }
        shots.taken += 1
        this.artifactStats.saved += 1
        this.artifactStats.paths.push(result.relativePath)
        const stored: ArtifactRef = {
          phase,
          status: 'stored',
          ...(actionEventId ? { actionEventId } : {}),
          relativePath: result.relativePath,
          requestedAtMs: this.sinceStart(now),
          capturedAtMs: this.sinceStart(done),
          redaction: 'masked',
          ...(result.display ? { display: result.display } : {})
        }
        this.noteShot('stored')
        shots.lastFrame = { ref: stored, at: done, requestedAt: now, gen }
        return stored
      }
      if (late) return ref('denied', 'session_changed')
      return ref(result?.status ?? 'error', result?.status ? undefined : 'no_frame')
    } catch {
      // Never block recording on a frame failure; counted for the save manifest.
      return ref('error', 'capture_failed')
    } finally {
      shots.inFlight = false
    }
  }

  private noteShot(status: ArtifactRef['status']): void {
    this.shots.byStatus[status] = (this.shots.byStatus[status] ?? 0) + 1
    if (status === 'error') this.artifactStats.failed += 1
    else if (status !== 'stored' && status !== 'dedup') this.artifactStats.nulls += 1
  }

  /** True once the frame is gone; a failure keeps the cleanup obligation until Stop. */
  private async discardFrame(relativePath: string): Promise<boolean> {
    try {
      await this.screenshot.discard!(relativePath)
      this.shots.undiscarded.delete(relativePath)
      return true
    } catch {
      this.shots.undiscarded.add(relativePath)
      return false
    }
  }

  /**
   * M8-C: when key presses are not observed, say so once in the recording. Never claim
   * system-wide shortcuts as a fallback: that would take the chord from the recorded app.
   */
  private declareKeyboardCapability(capturesKeys: boolean | undefined): void {
    if (capturesKeys !== false || this.keyboardDeclared || !this.sourcesActive) return
    this.keyboardDeclared = true
    this.recordEvent('capture_capability', {
      data: {
        capability: 'keyboard',
        available: false,
        message: 'Keyboard input is not observed in this recording; typing and shortcuts are missing.'
      }
    })
  }
  private ingestInteraction(partial: InteractionPartial, gen: number): void {
    if (!this.admits(gen)) return
    // Sequencing owner for provider input too: any buffered typing happened before this
    // partial (scroll, same-field click, …), so it is recorded first. The flush only emits
    // text_input / credential_entered, which re-enter here without flushing again.
    const fromFlush = partial.type === 'text_input' || partial.type === 'credential_entered'
    if (!fromFlush && !this.ingesting) this.flushInteraction()
    this.ingesting = true
    try {
      this.ingestAdmitted(partial)
    } finally {
      this.ingesting = false
    }
  }

  private ingestAdmitted(partial: InteractionPartial): void {
    if (this.shouldIgnoreApp(partial.data?.appName ?? partial.target?.appName)) return

    // M3-B: copies arrive verified from the sensor; unknown app identity is never recorded.
    if (partial.type === 'clipboard_changed') {
      const appName = partial.data?.appName ?? partial.target?.appName
      if (appName) this.recordCopy(appName, partial)
      return
    }

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
    // A copy matches only while the pasteboard still holds it (same changeCount).
    if (partial.type === 'keyboard_shortcut' && isPasteChord(partial.data?.shortcut)) {
      const latest = this.clipboard.getLatest(this.interaction.pasteboardCount?.())
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
        const latest = this.clipboard.getLatest(this.interaction.pasteboardCount?.())
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
            now: performance.now()
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
    const recorded = this.recordEvent(partial.type, {
      target: partial.target,
      data,
      occurredAt: partial.occurredAt,
      startedAt: partial.startedAt
    })

    if (partial.type === 'element_activated' || partial.type === 'click') {
      this.interaction.poke?.()
      if (recorded && this.screenshot.enabled) {
        const actionAt = partial.occurredAt ?? this.clock()
        const admitted = this.admit(() => this.captureActionShots(recorded.eventId, actionAt, data))
        // Over the job bound: this action's evidence is refused visibly, not silently absent.
        if (!admitted) {
          for (const phase of ['pre', 'post'] as const) {
            // admit() already counted the skipped job once in the manifest; status only here.
            this.shots.byStatus.throttled = (this.shots.byStatus.throttled ?? 0) + 1
            this.recordArtifact({ actionEventId: recorded.eventId, phase, status: 'throttled', reason: 'job_limit' })
          }
        }
      }
    }
  }

  /**
   * M10 action evidence, each phase recorded with its settled status:
   * - pre: a reference to the last frame stored before the action (same session generation,
   *   with its age), never a capture taken after it;
   * - post: acquired after a settle deadline; a pause/Stop meanwhile denies it;
   * - crop: cut from that same stored post frame, only inside its display; never a new capture.
   */
  private async captureActionShots(
    actionEventId: string,
    actionAt: number,
    data: InteractionPartial['data']
  ): Promise<void> {
    const gen = this.generation
    const shots = this.shots
    const last = shots.lastFrame
    // The pixels lie in [requestedAt, at]: complete before the action, and even at their oldest
    // possible acquisition no more than PRE_MAX_AGE_MS old. ageMs is that upper bound.
    const pre: ArtifactRef =
      last && last.gen === gen && last.at <= actionAt && actionAt - last.requestedAt <= PRE_MAX_AGE_MS
        ? {
            ...last.ref,
            actionEventId,
            phase: 'pre',
            status: 'dedup',
            ageMs: Math.round(actionAt - last.requestedAt)
          }
        : {
            actionEventId,
            phase: 'pre',
            status: 'unavailable',
            reason: last && last.gen === gen && last.at <= actionAt ? 'prior_frame_stale' : 'no_prior_frame'
          }
    this.noteShot(pre.status)
    this.recordArtifact(pre)

    shots.postsPending += 1
    let post: ArtifactRef
    try {
      const settled = await this.settleWait(POST_SETTLE_MS)
      post = settled
        ? await this.acquireFrame('post_action', 'post', actionEventId)
        : (this.noteShot('denied'), { actionEventId, phase: 'post', status: 'denied', reason: 'session_closed' })
    } finally {
      shots.postsPending -= 1
    }
    this.recordArtifact(post)

    const bounds = data?.elementBounds
    if (!bounds) return
    this.recordArtifact(await this.cropFromPost(post, bounds, actionEventId))
  }

  private async cropFromPost(
    post: ArtifactRef,
    rect: { x: number; y: number; width: number; height: number },
    actionEventId: string
  ): Promise<ArtifactRef> {
    const out = (status: ArtifactRef['status'], reason: string): ArtifactRef => {
      this.noteShot(status)
      return { actionEventId, phase: 'crop', status, reason }
    }
    if (post.status !== 'stored' || !post.relativePath) return out('unavailable', 'no_source_frame')
    if (!this.screenshot.cropFrom) return out('unavailable', 'crop_unsupported')
    const d = post.display
    const inside =
      rect.width > 0 &&
      rect.height > 0 &&
      !!d &&
      d.x !== undefined &&
      d.y !== undefined &&
      rect.x >= d.x &&
      rect.y >= d.y &&
      rect.x + rect.width <= d.x + d.width &&
      rect.y + rect.height <= d.y + d.height
    // A rect the source frame cannot be shown to contain is rejected, not clamped or kept whole.
    if (!inside) return out('denied', d ? 'invalid_crop' : 'source_display_unknown')
    const sessionId = this.sessionId
    const gen = this.generation
    try {
      const result = await this.screenshot.cropFrom(post.relativePath, rect, {
        sessionId: sessionId!,
        eventId: newId('tevt')
      })
      const late = this.sessionId !== sessionId || this.generation !== gen
      if (!result?.relativePath) return out(late ? 'denied' : (result?.status ?? 'error'), late ? 'session_changed' : 'no_frame')
      const refused = late ? 'session_changed' : result.redaction !== 'masked' ? 'unredacted' : unsafePath(result.relativePath)
      if (refused) {
        await this.discardFrame(result.relativePath)
        return out('denied', refused)
      }
      this.artifactStats.saved += 1
      this.artifactStats.paths.push(result.relativePath)
      this.noteShot('stored')
      return {
        actionEventId,
        phase: 'crop',
        status: 'stored',
        relativePath: result.relativePath,
        capturedAtMs: post.capturedAtMs,
        redaction: 'masked',
        sourcePath: post.relativePath,
        cropRect: rect
      }
    } catch {
      return out('error', 'crop_failed')
    }
  }

  private recordArtifact(ref: ArtifactRef): void {
    this.recordEvent('keyframe_captured', {
      data: {
        ...(ref.status === 'stored' && ref.relativePath ? { keyframePath: ref.relativePath } : {}),
        message: `${ref.phase}_action`,
        artifact: ref
      }
    })
  }

  /** Resolve true after `ms`, or false at once if sources halt (pause/Stop) meanwhile. */
  private settleWait(ms: number): Promise<boolean> {
    if (this.finalizing || this.paused) return Promise.resolve(false)
    return new Promise((resolve) => {
      const wake = (): void => {
        clearTimeout(timer)
        this.shotWaits.delete(wake)
        resolve(false)
      }
      const timer = setTimeout(() => {
        this.shotWaits.delete(wake)
        resolve(!this.finalizing && !this.paused)
      }, ms)
      this.shotWaits.add(wake)
    })
  }
}

type ShotState = {
  inFlight: boolean
  lastAt: number
  taken: number
  /** Requests that reached the provider (the per-session cap counts these, not stored frames). */
  requests: number
  /** Frames that must be deleted but whose deletion failed: retried at Stop. */
  undiscarded: Set<string>
  postsPending: number
  byStatus: Partial<Record<ArtifactRef['status'], number>>
  lastFrame: { ref: ArtifactRef; at: number; requestedAt: number; gen: number } | null
}

/** A frame path the session may reference: relative, inside its root. */
function unsafePath(p: string): 'unsafe_path' | null {
  return p.includes('..') || p.startsWith('/') || /^[A-Za-z]:\\/.test(p) ? 'unsafe_path' : null
}

function freshShotState(): ShotState {
  return {
    inFlight: false,
    lastAt: -Infinity,
    taken: 0,
    requests: 0,
    undiscarded: new Set(),
    postsPending: 0,
    byStatus: {},
    lastFrame: null
  }
}

/** Cmd+V / Ctrl+V, including Shift+Cmd+V ("paste and match style"). */
function isPasteChord(shortcut?: string): boolean {
  if (!shortcut) return false
  return /^(?:Cmd|Ctrl)(?:\+(?:Alt|Shift))*\+V$/i.test(shortcut)
}
