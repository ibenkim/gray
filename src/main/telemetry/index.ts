import { statSync } from 'fs'
import {
  BrowserWindow,
  ipcMain,
  systemPreferences,
  type IpcMainInvokeEvent,
  type WebContents
} from 'electron'
import { newId } from '../../shared/id'
import {
  initialDelivery,
  type ProcessingErrorCode,
  type SessionDelivery,
  type StopReason,
  type TelemetryEvent,
  type TelemetrySessionMeta
} from '../../shared/telemetry/schema'
import type { RecordingSummary } from '../../shared/types'
import { getSnapshot } from '../store'
import { JxaAccessibilityProvider } from './ax/JxaAccessibilityProvider'
import {
  StartFailedError,
  TelemetryRecorder,
  type CaptureOptions,
  type RecordingStatus,
  type StopResult
} from './capture'
import { ClipboardWatcher } from './clipboard'
import { DisabledScreenshotProvider } from './providers'
import { loadTelemetryConfig, type TelemetryConfig } from './config'
import { mapToProcessingError, uploadReviewRequired, userMessageForCode } from './errors'
import { emptyNarration, NarrationRecorder } from './narration'
import { polishSession } from './polish'
import { processApprovedSession, ResultSaveError } from './processSession'
import type { DrainResult } from './queue'
import { createTelemetryStore, type TelemetryStore } from './store'
import {
  prepareReview,
  REVIEW_ERROR_TEXT,
  reviewPreview,
  toRecordingSummary,
  validateApproval,
  type PreparedReview
} from './uploadReview'
import { toEditorWorkflow } from './workflow'

const MAX_EVENTS_BODY = 200
const MAX_BODY_BYTES = 512_000
const MAX_NARRATION_CHUNK = 512_000

let config: TelemetryConfig
let store: TelemetryStore | null = null
let recorder: TelemetryRecorder | null = null
let narrationRecorder: NarrationRecorder | null = null

/** One owned Stop finalization per session; duplicate Stops join it. */
const stopOps = new Map<string, Promise<StopIpcResult>>()
/** One owned interpretation operation per session (never parallel attempts). */
const interpretOps = new Map<string, Promise<void>>()
/** Serializes approve/cancel/prepare decisions per session. */
const reviewLocks = new Map<string, Promise<unknown>>()
/** In-session inputs for a local save retry when the manifest write itself failed. */
const lastStopOutcomes = new Map<string, SaveInputs>()
/** Received-but-unsaved results, retryable locally without another request. */
const pendingResultSaves = new Map<string, ResultSaveError['pending']>()

/** Renderer's account of the final narration chunks it sent before Stop. */
type AudioReport = {
  chunksAcknowledged: number
  chunksFailed: number
  timedOut: boolean
  /** Recorder error or stop exception after capture started (sticky; absent = legacy false). */
  recorderFailed?: boolean
}

type SaveInputs = {
  finalSequence?: number
  events?: DrainResult
  /** Direct IPC writes are outside the recorder queue; retain their loss across save retry. */
  rendererLosses?: Pick<DrainResult, 'rejected' | 'dropped' | 'filtered'>
  artifacts: NonNullable<SessionDelivery['save']['artifacts']>
  audio: NonNullable<SessionDelivery['save']['audio']>
  stopReason?: StopReason
  /** A source did not confirm shutdown; never complete. */
  teardownFailed?: boolean
}

/**
 * M2 capture owner: the window that started the active session. Pause/resume/stop,
 * event batches and every narration call must come from it, for its session.
 */
type CaptureOwner = {
  sender: unknown
  /** Null until Start has created the session (the owner exists before any Start await). */
  sessionId: string | null
  /** Owner lost or a stop barrier ran during Start: no source may start. */
  cancelled: boolean
  pause: Promise<{ ok: boolean; status: ReturnType<typeof currentStatus> }> | null
  rendererLosses: Pick<DrainResult, 'rejected' | 'dropped' | 'filtered'>
  release: () => void
}
let owner: CaptureOwner | null = null
/** The pending Start (owner reserved, storage/acquisition in progress). */
let startOp: Promise<void> | null = null
/** Owner receipt slot of a reserved main Stop that is waiting for the renderer's account. */
const receiptSlots = new Map<string, (report?: AudioReport) => void>()
/** Admitted renderer event appends; drained before the save outcome is decided. */
const pendingAppends = new Set<Promise<unknown>>()
const captureStatusListeners = new Set<(status: ReturnType<typeof currentStatus>) => void>()
/** One narration stream per session; it ends at the first pause (resume is without it). */
let narration: { sessionId: string; state: 'active' | 'ended' } | null = null
/** Chunk account retained from the narration's end (first pause) until Stop consumes it. */
const pauseAudioReports = new Map<string, AudioReport>()

const MAX_REPORTED_CHUNKS = 1_000_000
/** A renderer chunk account is untrusted input: bounded nonnegative counts, boolean timeout. */
function validAudioReport(raw: unknown): AudioReport | undefined {
  const r = raw as Partial<AudioReport> | null
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_REPORTED_CHUNKS
  if (!r || !count(r.chunksAcknowledged) || !count(r.chunksFailed) || typeof r.timedOut !== 'boolean') {
    return undefined
  }
  if (r.recorderFailed !== undefined && typeof r.recorderFailed !== 'boolean') return undefined
  return {
    chunksAcknowledged: r.chunksAcknowledged!,
    chunksFailed: r.chunksFailed!,
    timedOut: r.timedOut,
    recorderFailed: r.recorderFailed === true
  }
}

/**
 * The retained (first) receipt wins for counts; failure in either receipt is sticky, so a
 * later clean or zeroed account can never erase a known failure.
 */
function joinAudioReports(first?: AudioReport, later?: AudioReport): AudioReport | undefined {
  const base = first ?? later
  if (!base) return undefined
  const failed = (r?: AudioReport) => !!r && (r.timedOut || r.chunksFailed > 0 || !!r.recorderFailed)
  return failed(first) || failed(later) ? { ...base, recorderFailed: base.recorderFailed || failed(later) } : base
}

/** A receipt that proves narration did not complete cleanly. */
function audioReportFailed(r: AudioReport): boolean {
  return r.timedOut || r.chunksFailed > 0 || !!r.recorderFailed
}
/** Reason recorded when a main-owned barrier asked the owner to Stop. */
const stopReasons = new Map<string, StopReason>()
/**
 * How long a reserved Stop waits for the live owner's audio account before failing closed.
 * Covers the renderer's own bounds (1.5 s recorder stop + 5 s chunk drain) with margin; the
 * quit barrier (main/index) allows 10 s for this plus the local save. A miss is recorded as
 * incomplete audio, never as a successful drain.
 */
const OWNER_RECEIPT_DEADLINE_MS = 7000

type StopIpcResult = {
  ok: boolean
  sessionId?: string | null
  localOnly?: true
  discarded?: boolean
  error?: string
  errorCode?: string
  recording?: RecordingSummary
}

export function getTelemetryRecorder(): TelemetryRecorder | null {
  return recorder
}

export function getTelemetryStore(): TelemetryStore | null {
  return store
}

export function getTelemetryConfig(): TelemetryConfig {
  return config
}

export function getNarrationRecorder(): NarrationRecorder | null {
  return narrationRecorder
}

function isAccessibilityTrusted(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

export async function initTelemetry(): Promise<void> {
  config = loadTelemetryConfig()
  try {
    store = createTelemetryStore(config)
    if (store) {
      await store.ensureReady()
      console.log(
        `[telemetry] ready — storage=${config.storage} dir=${config.devDir}` +
          (config.openaiApiKey ? ' openai=configured' : ' openai=missing')
      )
      if (!config.openaiApiKey) {
        console.warn(
          '[telemetry] OPENAI_API_KEY missing or invalid. Recording and review work; an approved interpretation will fail until you set a real key in .env and restart the app.'
        )
      }
    } else {
      console.warn(
        '[telemetry] storage disabled (TELEMETRY_STORAGE not file). Recording will not persist.'
      )
    }
  } catch (err) {
    console.error('[telemetry] init failed', err instanceof Error ? err.message : err)
    store = null
  }

  const interaction =
    process.platform === 'darwin'
      ? new JxaAccessibilityProvider({ isAccessibilityTrusted })
      : undefined

  if (interaction) {
    // Clicks, typing and element labels all come from the Accessibility API, so
    // say so loudly at startup rather than recording a hollow session.
    console.log(
      `[telemetry] interaction capture — accessibility=${
        isAccessibilityTrusted() ? 'granted' : 'DENIED'
      }`
    )
    if (!isAccessibilityTrusted()) {
      console.warn(
        '[telemetry] Accessibility permission missing: recordings will only contain ' +
          'app switches, clipboard changes and a few shortcuts. Grant it in System ' +
          'Settings › Privacy & Security › Accessibility.'
      )
    }
  }
  recorder = new TelemetryRecorder(store, {
    interaction,
    // M3-A: no unredacted screenshots. The display is never read; sessions record that
    // screenshots were disabled. Restoring images needs scoped pixels and masking first.
    screenshot: new DisabledScreenshotProvider(),
    clipboard: new ClipboardWatcher()
  })
  narrationRecorder = new NarrationRecorder(config.devDir)

  recorder.onEvent((event) => {
    broadcast('telemetry:event', event)
  })
  recorder.onStatus(() => emitCaptureStatus())

  if (store) {
    try {
      await recoverDeliveryStates(store)
    } catch (err) {
      console.error('[telemetry] delivery recovery failed', err instanceof Error ? err.name : 'error')
    }
  }
}

/**
 * Relaunch reconciliation. Nothing here sends: an unfinished save becomes incomplete,
 * and a request with no persisted result becomes interrupted_unknown (never resent).
 * A validated result whose final meta update was missed is matched by digest/attempt.
 */
async function recoverDeliveryStates(s: TelemetryStore): Promise<void> {
  for (const meta of await s.listSessions({ limit: 200 })) {
    const d = meta.delivery
    if (!d) continue
    const unfinishedSave = d.save.state === 'recording' || d.save.state === 'saving'
    const matched = await resultMatchesAttempt(s, meta)
    const interp = d.interpretation
    if (!unfinishedSave && (interp.state === 'complete' || (interp.state !== 'sending' && !matched))) {
      continue
    }
    await s.updateDelivery(meta.sessionId, (cur) => {
      const next = { ...cur! }
      if (unfinishedSave) next.save = { ...next.save, state: 'incomplete', errorCode: 'INTERRUPTED' }
      if (matched) {
        next.interpretation = { ...next.interpretation, state: 'complete', errorCode: undefined }
      } else if (next.interpretation.state === 'sending') {
        next.interpretation = { ...next.interpretation, state: 'interrupted_unknown' }
      }
      return next
    })
  }
}

async function resultMatchesAttempt(s: TelemetryStore, meta: TelemetrySessionMeta): Promise<boolean> {
  const interp = meta.delivery?.interpretation
  if (!interp?.digest || !interp.attemptId) return false
  const stored = await s.getWorkflow(meta.sessionId)
  return (
    stored?.provenance?.reviewDigest === interp.digest &&
    stored.provenance.attemptId === interp.attemptId
  )
}

/** Opens the approved narration sink before any source starts; failure rolls the start back. */
async function beginNarrationCapture(sessionId: string): Promise<void> {
  if (!narrationRecorder) throw new Error('[telemetry] narration unavailable')
  const { audioPath } = narrationRecorder.begin(sessionId)
  narration = { sessionId, state: 'active' }
  if (store?.saveNarration) {
    await store.saveNarration(sessionId, emptyNarration(sessionId, audioPath))
  }
}

/**
 * Status for the renderer/tray: recorder phase, this session's narration state, and the
 * main lifecycle — `starting` while Start is pending, `saving` until the durable outcome.
 */
function currentStatus(): RecordingStatus & {
  narration: 'off' | 'active' | 'ended'
  starting: boolean
  saving: boolean
} {
  const s = recorder!.getRecordingStatus()
  return {
    ...s,
    narration: narration && narration.sessionId === s.sessionId ? narration.state : 'off',
    starting: !!startOp,
    saving: stopOps.size > 0
  }
}

function emitCaptureStatus(): void {
  if (!recorder) return
  const status = currentStatus()
  broadcast('telemetry:status', status)
  for (const cb of captureStatusListeners) {
    try {
      cb(status)
    } catch {
      /* listeners never break the lifecycle */
    }
  }
}

/** Main-owned capture lifecycle for the tray: includes pending Start and unfinished saves. */
export function onCaptureStatus(cb: (status: ReturnType<typeof currentStatus>) => void): () => void {
  captureStatusListeners.add(cb)
  return () => captureStatusListeners.delete(cb)
}

function isOwner(e: IpcMainInvokeEvent, sessionId?: string): boolean {
  return (
    !!owner &&
    !!owner.sessionId &&
    e.sender === owner.sender &&
    (!sessionId || sessionId === owner.sessionId)
  )
}

function isLiveContents(sender: unknown): sender is WebContents {
  const wc = sender as Partial<WebContents> | null
  return !!wc && typeof wc.send === 'function' && !(wc.isDestroyed?.() ?? false)
}

/**
 * Reserve the starting window as owner before any Start await; its reload/crash/close is
 * owner loss, which cancels a pending Start or runs the stop barrier.
 */
function bindOwner(sender: unknown): CaptureOwner {
  owner?.release()
  const wc = sender as Partial<WebContents>
  const lost = () => {
    if (owner === bound) bound.cancelled = true
    void stopActiveRecording('owner_lost')
  }
  const navigated = (details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
    if (details?.isMainFrame && !details.isSameDocument) lost()
  }
  if (typeof wc.on === 'function') {
    wc.on('destroyed', lost)
    wc.on('render-process-gone', lost)
    wc.on('did-start-navigation', navigated as never)
  }
  const bound: CaptureOwner = {
    sender,
    sessionId: null,
    cancelled: false,
    pause: null,
    rendererLosses: { rejected: 0, dropped: 0, filtered: 0 },
    release: () => {
      if (typeof wc.removeListener !== 'function') return
      wc.removeListener('destroyed', lost)
      wc.removeListener('render-process-gone', lost)
      wc.removeListener('did-start-navigation', navigated as never)
    }
  }
  owner = bound
  return bound
}

function releaseOwner(sessionId: string | CaptureOwner): void {
  if (!owner) return
  if (typeof sessionId === 'string' ? owner.sessionId !== sessionId : owner !== sessionId) return
  owner.release()
  owner = null
}

async function markStartFailed(s: TelemetryStore, sessionId: string): Promise<void> {
  try {
    await s.updateDelivery(
      sessionId,
      (d) => ({ ...(d ?? initialDelivery()), save: { state: 'incomplete', errorCode: 'START_FAILED' } }),
      { captureStatus: 'failed', stoppedAt: new Date().toISOString() }
    )
  } catch {
    /* relaunch recovery marks an unfinished save incomplete */
  }
}

/**
 * Close the mic audio sink. Audio stays on disk; M1 hold: no transcription until
 * an upload review exists.
 */
async function endNarrationLocally(): Promise<void> {
  if (!narrationRecorder) return
  try {
    await narrationRecorder.end()
  } catch (err) {
    console.error('[telemetry] narration end failed', err instanceof Error ? err.name : 'error')
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

async function broadcastRecording(sessionId: string): Promise<void> {
  const meta = await store?.getSessionMeta(sessionId).catch(() => null)
  if (meta) broadcast('telemetry:recordingChanged', toRecordingSummary(meta))
}

/** Review/approval IPC must come from one of this app's own windows. */
function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  try {
    return !!BrowserWindow.fromWebContents(e.sender)
  } catch {
    return false
  }
}

function withReviewLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = reviewLocks.get(sessionId) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  reviewLocks.set(sessionId, tail)
  void tail.then(() => {
    if (reviewLocks.get(sessionId) === tail) reviewLocks.delete(sessionId)
  })
  return run
}


/** Verify each saved frame is on disk at the size the store reported. */
async function verifyArtifacts(
  s: TelemetryStore,
  artifacts: StopResult['artifacts']
): Promise<SaveInputs['artifacts']> {
  const a = artifacts ?? { saved: 0, skipped: 0, failed: 0, paths: [] }
  let missing = 0
  for (const path of a.paths) {
    const size = await s.artifactSize(path)
    if (!size) missing += 1
  }
  return { saved: a.saved - missing, missing, failed: a.failed, skipped: a.skipped }
}

/** Audio is complete only when every chunk the renderer sent was acknowledged and closed. */
async function finishAudio(
  sessionId: string,
  wasNarrating: boolean,
  report?: AudioReport
): Promise<SaveInputs['audio']> {
  if (!wasNarrating || !narrationRecorder) return { state: 'none' }
  const end =
    narrationRecorder.getEndResult(sessionId) ??
    (narrationRecorder.getSessionId() === sessionId ? await narrationRecorder.end() : null)
  // Unknown or failed completion is evaluated before the no-audio shortcut: no renderer
  // account (owner lost/unresponsive), a timeout, failed chunks, a recorder failure, or a
  // missing/failed sink end result all mean the expected narration is incomplete.
  if (!report || audioReportFailed(report) || !end || !end.ok) {
    return { state: 'incomplete', chunks: end?.chunks ?? 0, bytes: end?.bytes ?? 0 }
  }
  if (end.chunks === 0 && report.chunksAcknowledged === 0) {
    // Narration requested but no audio delivered and nothing failed (mic unavailable before
    // capture, or a cancelled pending grant).
    return { state: 'none' }
  }
  let onDisk = -1
  try {
    onDisk = end.audioPath ? statSync(end.audioPath).size : -1
  } catch {
    onDisk = -1
  }
  const ok =
    end.ok &&
    !!report &&
    !report.timedOut &&
    report.chunksFailed === 0 &&
    report.chunksAcknowledged === end.chunks &&
    onDisk === end.bytes
  return { state: ok ? 'complete' : 'incomplete', chunks: end.chunks, bytes: end.bytes }
}

/**
 * Persist the save outcome. `complete` requires zero pending/rejected/dropped events,
 * the terminal event on disk, every frame present and audio verified.
 */
async function writeSaveOutcome(
  s: TelemetryStore,
  sessionId: string,
  inputs: SaveInputs
): Promise<StopIpcResult> {
  const ev = {
    ...inputs.events,
    rejected: (inputs.events?.rejected ?? 0) + (inputs.rendererLosses?.rejected ?? 0),
    dropped: (inputs.events?.dropped ?? 0) + (inputs.rendererLosses?.dropped ?? 0),
    filtered: (inputs.events?.filtered ?? 0) + (inputs.rendererLosses?.filtered ?? 0)
  }
  const { events: stored } = await s.readSessionEventsChecked(sessionId)
  const terminalStored =
    inputs.finalSequence != null && stored.some((e) => e.sequence === inputs.finalSequence)
  const errorCode =
    inputs.teardownFailed
      ? 'SOURCE_TEARDOWN_FAILED'
      : (ev?.rejected ?? 0) > 0
      ? 'EVENTS_REJECTED'
      : (ev?.dropped ?? 0) > 0
        ? 'EVENTS_DROPPED'
        : inputs.artifacts.failed + inputs.artifacts.missing > 0
          ? 'ARTIFACT_FAILED'
          : inputs.audio.state === 'incomplete'
            ? 'AUDIO_INCOMPLETE'
            : (ev?.pending ?? 0) > 0 || !terminalStored
              ? 'EVENTS_NOT_PERSISTED'
              : undefined
  let complete = !errorCode
  if (complete) {
    try {
      await s.syncEvents(sessionId)
    } catch {
      complete = false
    }
  }
  const save: SessionDelivery['save'] = {
    state: complete ? 'complete' : 'incomplete',
    ...(complete ? {} : { errorCode: errorCode ?? 'EVENTS_NOT_PERSISTED' }),
    ...(inputs.finalSequence != null ? { finalSequence: inputs.finalSequence } : {}),
    storedEvents: stored.length,
    pendingEvents: ev?.pending ?? 0,
    rejectedEvents: ev?.rejected ?? 0,
    droppedEvents: ev?.dropped ?? 0,
    filteredEvents: ev?.filtered ?? 0,
    artifacts: inputs.artifacts,
    audio: inputs.audio,
    ...(inputs.stopReason ? { stopReason: inputs.stopReason } : {}),
    ...(complete ? { completedAt: new Date().toISOString() } : {})
  }
  let meta: TelemetrySessionMeta
  try {
    meta = await s.updateDelivery(
      sessionId,
      (d) => ({ ...(d ?? initialDelivery()), save }),
      {
        captureStatus: 'stopped',
        processingStatus: 'not_started',
        processingErrorCode: null,
        stoppedAt: new Date().toISOString()
      }
    )
  } catch {
    lastStopOutcomes.set(sessionId, inputs)
    const current = await s.getSessionMeta(sessionId).catch(() => null)
    return {
      ok: false,
      sessionId,
      errorCode: 'MANIFEST_WRITE_FAILED',
      error: 'The recording could not be marked as saved. Try saving again.',
      recording: current
        ? {
            ...toRecordingSummary(current),
            saveState: 'incomplete',
            saveErrorCode: 'MANIFEST_WRITE_FAILED',
            canRetrySave: true
          }
        : undefined
    }
  }
  lastStopOutcomes.delete(sessionId)

  // Raw evidence can be completely saved while local review preparation fails.
  if (complete) {
    try {
      await polishSession(s, sessionId)
    } catch {
      meta = await s.updateDelivery(sessionId, (d) => ({
        ...d!,
        review: { state: 'unavailable', errorCode: 'POLISH_FAILED' }
      }))
    }
  }
  void broadcastRecording(sessionId)
  return { ok: true, sessionId, localOnly: true, recording: toRecordingSummary(meta) }
}

async function finalizeStop(
  s: TelemetryStore,
  r: TelemetryRecorder,
  sessionId: string,
  receipt: Promise<AudioReport | undefined>,
  stopReason: StopReason = 'user'
): Promise<StopIpcResult> {
  const wasNarrating = r.isNarrating()
  // Halt every source before any status I/O: a failed marker write must never keep
  // capture running. The recorder then drains already-admitted work.
  const stopping = r.stopRecording()
  r.setProcessing(true)
  try {
    try {
      await s.updateDelivery(sessionId, (d) => ({
        ...(d ?? initialDelivery()),
        save: { state: 'saving' }
      }))
      void broadcastRecording(sessionId)
    } catch {
      /* the outcome write below decides; relaunch recovery covers a lost marker */
    }
    const stop = await stopping
    // Admitted renderer event writes land before the outcome is decided.
    while (pendingAppends.size > 0) await Promise.allSettled([...pendingAppends])
    const audioReport = await receipt
    const audio = await finishAudio(
      sessionId,
      wasNarrating,
      joinAudioReports(pauseAudioReports.get(sessionId), audioReport)
    )
    const artifacts = await verifyArtifacts(s, stop.artifacts)
    return await writeSaveOutcome(s, sessionId, {
      finalSequence: stop.finalSequence,
      events: stop.events,
      rendererLosses: owner?.sessionId === sessionId ? { ...owner.rendererLosses } : undefined,
      artifacts,
      audio,
      stopReason,
      teardownFailed: stop.teardownFailed
    })
  } catch {
    await stopping.catch(() => undefined)
    receiptSlots.get(sessionId)?.(undefined)
    if (narration?.sessionId === sessionId && narration.state === 'active') {
      await endNarrationLocally()
    }
    let recording: RecordingSummary | undefined
    try {
      recording = toRecordingSummary(
        await s.updateDelivery(sessionId, (d) => ({
          ...(d ?? initialDelivery()),
          save: { state: 'incomplete', errorCode: 'STOP_FAILED' }
        }))
      )
    } catch {
      /* the recording files remain; state stays unverified */
    }
    return {
      ok: false,
      sessionId,
      errorCode: 'STOP_FAILED',
      error: 'Could not finish saving this recording.',
      recording
    }
  } finally {
    r.setProcessing(false)
    pauseAudioReports.delete(sessionId)
    stopReasons.delete(sessionId)
    if (narration?.sessionId === sessionId) narration = null
    releaseOwner(sessionId)
  }
}

const AWAIT_OWNER = Symbol('await-owner-receipt')

/**
 * One owned finalization per session, reserved at entry and shared by every Stop reason.
 * Creating it halts all sources immediately. With AWAIT_OWNER the operation waits (bounded)
 * for the live owner's audio account; the owner's later Stop delivers that account into this
 * operation and returns its result, so the handshake can never wait on itself.
 */
function runFinalize(
  sessionId: string,
  reason: StopReason,
  audio: AudioReport | undefined | typeof AWAIT_OWNER,
  askOwner?: WebContents
): Promise<StopIpcResult> {
  const inflight = stopOps.get(sessionId)
  if (inflight) {
    if (audio !== AWAIT_OWNER) receiptSlots.get(sessionId)?.(audio)
    return inflight
  }
  let receipt: Promise<AudioReport | undefined>
  if (audio === AWAIT_OWNER) {
    receipt = new Promise((resolve) => {
      const timer = setTimeout(() => {
        receiptSlots.delete(sessionId)
        // Unresponsive owner: fail closed — its renderer may still hold microphone tracks.
        if (narration?.sessionId === sessionId && narration.state === 'active' && askOwner) {
          try {
            askOwner.forcefullyCrashRenderer()
            askOwner.reload()
          } catch {
            /* the renderer is already gone */
          }
        }
        resolve(undefined)
      }, OWNER_RECEIPT_DEADLINE_MS)
      receiptSlots.set(sessionId, (report) => {
        clearTimeout(timer)
        receiptSlots.delete(sessionId)
        resolve(report)
      })
    })
  } else {
    receipt = Promise.resolve(audio)
  }
  const op = finalizeStop(store!, recorder!, sessionId, receipt, reason).finally(() => {
    stopOps.delete(sessionId)
    emitCaptureStatus()
  })
  stopOps.set(sessionId, op)
  emitCaptureStatus()
  return op
}

/**
 * True while any capture lifecycle operation exists: a pending Start, a recording/paused/
 * stopping recorder, or a Stop whose durable save outcome is not yet written.
 */
export function hasActiveRecording(): boolean {
  const st = recorder?.getRecordingStatus()
  return !!startOp || stopOps.size > 0 || (!!st && st.phase !== 'idle')
}

/**
 * Shared stop/save barrier for hide, logout, owner loss, used-permission revocation and
 * quit (M2). Sources halt immediately. A live owner is asked to release its microphone and
 * Stop with its chunk account; if it does not within the timeout, main fails closed (its
 * renderer is forcibly restarted when narration could still hold tracks) and finalizes
 * without an audio account, which the completeness check records as incomplete.
 */
export async function stopActiveRecording(reason: StopReason): Promise<void> {
  const r = recorder
  if (!r || !store) return
  // A pending Start is cancelled (no source will start), then joined.
  if (startOp) {
    if (owner) owner.cancelled = true
    await startOp
  }
  // Decided synchronously (no await before reserving), so concurrent callers join one op.
  const st = r.getRecordingStatus()
  const sessionId = st.sessionId
  const existing = sessionId ? stopOps.get(sessionId) : undefined
  if (existing) {
    await existing
    return
  }
  if (!sessionId || st.phase === 'idle') {
    // Join every unfinished save, even when the recorder phase is already idle.
    await Promise.allSettled([...stopOps.values()])
    return
  }
  const o = owner
  const ask =
    o && o.sessionId === sessionId && reason !== 'owner_lost' && isLiveContents(o.sender)
      ? (o.sender as WebContents)
      : undefined
  stopReasons.set(sessionId, reason)
  // Reserve the Stop decision before the handshake: sources halt now, Resume/new Start/new
  // events are refused, and the owner's receipt is delivered into this operation.
  const op = runFinalize(sessionId, reason, ask ? AWAIT_OWNER : undefined, ask)
  ask?.send('telemetry:stopRequested', { sessionId, reason })
  await op
}

/** Run the single approved operation and persist its terminal state. */
async function runInterpretation(
  s: TelemetryStore,
  review: PreparedReview,
  attempt: { attemptId: string; workflowId: string }
): Promise<void> {
  const sessionId = review.sessionId
  let failure: ProcessingErrorCode | null = null
  let partial = false
  try {
    const result = await processApprovedSession(s, config, review, attempt, {
      onProgress: () => void broadcastRecording(sessionId)
    })
    partial = result.partial
    pendingResultSaves.delete(sessionId)
  } catch (err) {
    if (err instanceof ResultSaveError) pendingResultSaves.set(sessionId, err.pending)
    failure = mapToProcessingError(err).code
    console.error(`[telemetry] interpretation failed code=${failure}`)
  }
  try {
    await s.updateDelivery(
      sessionId,
      (d) => ({
        ...d!,
        interpretation: failure
          ? { ...d!.interpretation, state: 'failed', errorCode: failure }
          : {
              ...d!.interpretation,
              state: 'complete',
              errorCode: undefined,
              partial,
              completedAt: new Date().toISOString()
            }
      }),
      failure ? {} : { processingStatus: 'complete', processingErrorCode: null }
    )
  } catch {
    // A durable matching result is reconciled to complete on the next listing/relaunch.
    console.error('[telemetry] interpretation state write failed')
  }
  await broadcastRecording(sessionId)
}

function requireSessionOwner(
  ownerEmail?: string
): { ok: true; email?: string } | { ok: false; error: string } {
  const session = getSnapshot().session
  if (!session) {
    if (ownerEmail) return { ok: false, error: 'Not authenticated' }
    return { ok: true }
  }
  if (ownerEmail && ownerEmail !== session.email) {
    return { ok: false, error: 'Session ownership mismatch' }
  }
  return { ok: true, email: session.email }
}

function estimateBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

export function registerTelemetryIpc(): void {
  ipcMain.handle(
    'telemetry:sessionStart',
    async (e, opts: CaptureOptions = {}) => {
      if (!recorder) return { ok: false, error: 'Telemetry not initialized' }
      if (!isTrustedSender(e)) return { ok: false, error: 'Invalid request' }
      const auth = requireSessionOwner(opts.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
      if (!store) {
        return { ok: false, error: 'Telemetry storage is not configured (TELEMETRY_STORAGE)' }
      }
      // One lifecycle, one owner: a repeat from the active owner joins; anything else —
      // including a pending Start or an unfinished save — is refused.
      if (startOp || hasActiveRecording()) {
        return owner && owner.sessionId && e.sender === owner.sender && !startOp && stopOps.size === 0
          ? { ok: true, status: currentStatus() }
          : { ok: false, error: 'A recording is already in progress' }
      }
      // Reserve owner and cancellation before any await (loss listeners attached now).
      const o = bindOwner(e.sender)
      let settle!: () => void
      startOp = new Promise<void>((resolve) => (settle = resolve))
      emitCaptureStatus()
      const wc = e.sender as Partial<WebContents>
      // Window existence is checked synchronously: Electron can deliver 'destroyed' late.
      const proceed = () =>
        owner === o &&
        !o.cancelled &&
        !(wc.isDestroyed?.() ?? false) &&
        isTrustedSender(e) &&
        requireSessionOwner(auth.email ?? opts.ownerEmail).ok
      try {
        const status = await recorder.startRecording({
          recordMode: opts.recordMode,
          selectedAppId: opts.selectedAppId,
          narrate: !!opts.narrate,
          ownerEmail: auth.email ?? opts.ownerEmail,
          ignoreAppNames: Array.isArray(opts.ignoreAppNames)
            ? opts.ignoreAppNames
            : ['ghost', 'Electron', 'yuh'],
          beforeSources: async (sessionId) => {
            o.sessionId = sessionId
            if (opts.narrate) await beginNarrationCapture(sessionId)
          },
          shouldContinue: proceed
        })
        if (!status.sessionId || status.phase !== 'recording') {
          releaseOwner(o)
          return { ok: false, error: 'Could not start recording' }
        }
        return { ok: true, status: currentStatus() }
      } catch (err) {
        releaseOwner(o)
        console.error('[telemetry] sessionStart failed')
        const failedId = err instanceof StartFailedError ? err.sessionId : null
        if (narration && (!failedId || narration.sessionId === failedId)) {
          await endNarrationLocally()
          narration = null
        }
        if (failedId) await markStartFailed(store, failedId)
        return { ok: false, error: 'Could not start recording' }
      } finally {
        startOp = null
        settle()
        emitCaptureStatus()
      }
    }
  )

  /**
   * Pause is acknowledged only after every source halted. The owner stops its microphone
   * first and sends its chunk account; the first pause ends narration for this session.
   */
  ipcMain.handle(
    'telemetry:sessionPause',
    async (e, payload?: { sessionId?: string; audio?: AudioReport }) => {
      if (!recorder) return { ok: false, error: 'Telemetry not initialized' }
      if (!isOwner(e, payload?.sessionId)) return { ok: false, error: 'Not the recording owner' }
      const sessionId = owner!.sessionId!
      if (stopOps.has(sessionId)) return { ok: false, error: 'Recording is stopping', status: currentStatus() }
      const o = owner!
      if (narration?.sessionId === sessionId) {
        // Keep the first receipt for this session even if its sink was already closed;
        // a later (zeroed) account never replaces it.
        const report = validAudioReport(payload?.audio)
        if (report && !pauseAudioReports.has(sessionId)) pauseAudioReports.set(sessionId, report)
      }
      if (o.pause) return o.pause
      // Start source shutdown before any audio I/O. Keep this operation owned until
      // both have drained: repeated Pause joins; Resume cannot reopen capture meanwhile.
      recorder.haltSources()
      const pausing = recorder.pauseRecording()
      const n = narration?.sessionId === sessionId ? narration : null
      const closingAudio = (async () => {
        if (n?.state === 'active') {
          await endNarrationLocally()
          if (narration === n) n.state = 'ended'
        }
      })()
      o.pause = Promise.all([pausing, closingAudio]).then(() => {
        const status = currentStatus()
        return { ok: status.phase === 'paused' && !status.teardownFailed, status }
      }).finally(() => { o.pause = null })
      return o.pause
    }
  )

  ipcMain.handle('telemetry:sessionResume', async (e, payload?: { sessionId?: string }) => {
    if (!recorder) return { ok: false, error: 'Telemetry not initialized' }
    if (!isOwner(e, payload?.sessionId)) return { ok: false, error: 'Not the recording owner' }
    if (stopOps.has(owner!.sessionId!)) return { ok: false, error: 'Recording is stopping', status: currentStatus() }
    if (owner!.pause) return { ok: false, error: 'Recording is pausing', status: currentStatus() }
    const status = await recorder.resumeRecording()
    return { ok: status.phase === 'recording', status: currentStatus() }
  })

  /** Renderer event batches only for the owner's session while it is actively recording. */
  ipcMain.handle(
    'telemetry:events',
    async (e, payload: { sessionId: string; events: TelemetryEvent[] }) => {
      if (!store || !recorder) return { ok: false, error: 'Telemetry not initialized' }
      if (!payload?.sessionId || !Array.isArray(payload.events)) {
        return { ok: false, error: 'Invalid body' }
      }
      const r = recorder
      const admits = () =>
        isOwner(e, payload.sessionId) &&
        r.getRecordingStatus().phase === 'recording' &&
        !stopOps.has(payload.sessionId)
      if (!admits()) return { ok: false, error: 'Session is not being recorded' }
      const generation = r.getRecordingStatus().generation
      if (payload.events.length > MAX_EVENTS_BODY || estimateBytes(payload) > MAX_BODY_BYTES) {
        return { ok: false, error: 'Body too large' }
      }
      const meta = await store.getSessionMeta(payload.sessionId)
      if (!meta) return { ok: false, error: 'Unknown session' }
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
      // Revalidated after the await: a boundary since admission rejects the write.
      if (!admits() || r.getRecordingStatus().generation !== generation) {
        return { ok: false, error: 'Session is not being recorded' }
      }
      const losses = owner!.rendererLosses
      // Normalize a synchronous store throw too; every admitted failure reaches accounting.
      const append = Promise.resolve().then(() => store!.appendEvents(payload.sessionId, payload.events))
      pendingAppends.add(append)
      try {
        const result = await append
        losses.rejected += result.rejected
        losses.filtered += result.filtered ?? 0
        return { ok: true, result }
      } catch {
        // No durable outbox owns this direct write. Its contents are unverified/lost;
        // never offer a retry that can invent them or mark the recording complete.
        losses.dropped += payload.events.length
        return { ok: false, error: 'Failed to append events' }
      } finally {
        pendingAppends.delete(append)
      }
    }
  )

  // Stop capture and save locally (or discard). Nothing is sent on Stop.
  ipcMain.handle(
    'telemetry:sessionStop',
    async (
      e,
      sessionIdOrOpts?:
        | string
        | { sessionId?: string; discard?: boolean; audio?: AudioReport }
    ): Promise<StopIpcResult> => {
      if (!recorder || !store) return { ok: false, error: 'Telemetry not initialized' }
      const opts =
        typeof sessionIdOrOpts === 'string'
          ? { sessionId: sessionIdOrOpts }
          : sessionIdOrOpts ?? {}
      const status = recorder.getRecordingStatus()
      const active = status.phase !== 'idle' ? status.sessionId : null
      const id = opts.sessionId || active
      if (!id) return { ok: false, error: 'No active session' }

      // A reserved Stop (any reason) receives the owner's receipt and returns its result.
      if (stopOps.has(id)) {
        if (owner && owner.sessionId === id && e.sender !== owner.sender) {
          return { ok: false, error: 'Not the recording owner' }
        }
        return runFinalize(id, stopReasons.get(id) ?? 'user', validAudioReport(opts.audio))
      }
      // A valid Stop of the active session halts sources before any metadata I/O.
      if (id === active && owner && e.sender === owner.sender && !opts.discard) {
        return runFinalize(id, stopReasons.get(id) ?? 'user', validAudioReport(opts.audio))
      }

      const meta = await store.getSessionMeta(id).catch(() => null)
      // Re-check after the await: a concurrent Stop may have started finalizing meanwhile.
      const joined = stopOps.get(id)
      if (joined) return runFinalize(id, stopReasons.get(id) ?? 'user', validAudioReport(opts.audio))
      if (meta) {
        const auth = requireSessionOwner(meta.ownerEmail)
        if (!auth.ok) return { ok: false, error: auth.error }
      }
      if (id !== active) {
        // Never stop another session while answering for this one; report its saved state.
        if (!meta) return { ok: false, error: 'Unknown session' }
        return { ok: true, sessionId: id, localOnly: true, recording: toRecordingSummary(meta) }
      }
      if (owner && e.sender !== owner.sender) return { ok: false, error: 'Not the recording owner' }

      if (opts.discard) {
        // Discard is a lifecycle operation too: it joins nothing else and blocks new Starts.
        const s = store
        const r = recorder
        const op = (async (): Promise<StopIpcResult> => {
          try {
            const stopping = r.stopRecording()
            if (narration?.sessionId === id && narration.state === 'active') await endNarrationLocally()
            const { sessionId: stoppedId } = await stopping
            if (stoppedId) {
              await s.updateSessionMeta(stoppedId, {
                captureStatus: 'stopped',
                processingStatus: 'not_started',
                processingErrorCode: null,
                stoppedAt: new Date().toISOString()
              })
            }
            return { ok: true, sessionId: stoppedId, discarded: true }
          } catch {
            return { ok: false, sessionId: id, error: 'Could not stop the recording.' }
          } finally {
            if (narration?.sessionId === id) narration = null
            pauseAudioReports.delete(id)
            releaseOwner(id)
          }
        })().finally(() => {
          stopOps.delete(id)
          emitCaptureStatus()
        })
        stopOps.set(id, op)
        emitCaptureStatus()
        return op
      }

      return runFinalize(id, stopReasons.get(id) ?? 'user', validAudioReport(opts.audio))
    }
  )

  /** Same-session local save retry: drains retained events again; never re-records. */
  ipcMain.handle('telemetry:retrySave', async (e, sessionId: string): Promise<StopIpcResult> => {
    if (!recorder || !store) return { ok: false, error: 'Telemetry not initialized' }
    if (!isTrustedSender(e) || !sessionId) return { ok: false, error: 'Invalid request' }
    const meta = await store.getSessionMeta(sessionId).catch(() => null)
    if (!meta) return { ok: false, error: 'Unknown session' }
    const auth = requireSessionOwner(meta.ownerEmail)
    if (!auth.ok) return { ok: false, error: auth.error }
    const save = meta.delivery?.save
    const remembered = lastStopOutcomes.get(sessionId)
    const fromMeta: SaveInputs | null =
      save?.state === 'incomplete' && save.errorCode === 'EVENTS_NOT_PERSISTED'
        ? {
            finalSequence: save.finalSequence,
            artifacts: save.artifacts ?? { saved: 0, missing: 0, failed: 0, skipped: 0 },
            audio: save.audio ?? { state: 'none' },
            stopReason: save.stopReason
          }
        : null
    const base = remembered ?? fromMeta
    if (!base || stopOps.has(sessionId)) {
      return {
        ok: false,
        sessionId,
        error: 'This save cannot be retried locally.',
        recording: toRecordingSummary(meta)
      }
    }
    const drained = await recorder.retrySessionDrain(sessionId)
    const events: DrainResult | undefined = drained
      ? remembered
        ? drained
        : {
            ...drained,
            rejected: drained.rejected + (save?.rejectedEvents ?? 0),
            dropped: drained.dropped + (save?.droppedEvents ?? 0)
          }
      : base.events
    return writeSaveOutcome(store, sessionId, { ...base, events })
  })

  ipcMain.handle(
    'telemetry:listRecordings',
    async (_e, opts?: { limit?: number }): Promise<RecordingSummary[]> => {
      if (!store) return []
      const metas = await store.listSessions({ limit: opts?.limit })
      return metas
        .filter((m) => requireSessionOwner(m.ownerEmail).ok)
        .map(toRecordingSummary)
    }
  )

  ipcMain.handle('telemetry:getRecording', async (_e, sessionId: string) => {
    if (!store || !sessionId) return { ok: false, error: 'Unknown session' }
    const meta = await store.getSessionMeta(sessionId).catch(() => null)
    if (!meta || !requireSessionOwner(meta.ownerEmail).ok) {
      return { ok: false, error: 'Unknown session' }
    }
    return { ok: true, recording: toRecordingSummary(meta) }
  })

  /** Local only: prepares (or reuses) the exact sanitized payload. Creates no client. */
  ipcMain.handle('telemetry:prepareReview', async (e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!isTrustedSender(e) || !sessionId) return { ok: false, error: 'Invalid request' }
    const s = store
    return withReviewLock(sessionId, async () => {
      const meta = await s.getSessionMeta(sessionId).catch(() => null)
      if (!meta) return { ok: false, error: 'Unknown session' }
      if (!requireSessionOwner(meta.ownerEmail).ok) return { ok: false, error: 'Unknown session' }
      if (interpretOps.has(sessionId)) {
        return {
          ok: false,
          errorCode: 'SENDING',
          error: 'This recording is being sent for interpretation.',
          recording: toRecordingSummary(meta)
        }
      }
      const result = await prepareReview(s, sessionId, config.openaiModel)
      if (!meta.delivery && !result.ok) {
        // Unreviewable legacy session: persist nothing (never fabricate a save state).
        return {
          ok: false,
          errorCode: result.code,
          error: REVIEW_ERROR_TEXT[result.code],
          recording: toRecordingSummary(meta)
        }
      }
      const next = await s.updateDelivery(sessionId, (d) => {
        // Legacy sessions gain review state only, explicitly marked unverified.
        const base =
          d ?? { ...initialDelivery(), save: { state: 'legacy_unverified' as const } }
        if (!result.ok) {
          return { ...base, review: { state: 'unavailable', errorCode: result.code } }
        }
        const sameRevision = base.review.revision === result.review.revision
        return {
          ...base,
          review: {
            state: sameRevision && base.review.state === 'approved' ? 'approved' : 'prepared',
            revision: result.review.revision,
            digest: result.review.digest,
            // Keep the receipt as history even when it covers an older revision; it never
            // authorizes the new digest (validateApproval + approval.revision check).
            ...(base.review.approval ? { approval: base.review.approval } : {})
          }
        }
      })
      void broadcastRecording(sessionId)
      return result.ok
        ? { ok: true, preview: reviewPreview(result.review), recording: toRecordingSummary(next) }
        : {
            ok: false,
            errorCode: result.code,
            error: REVIEW_ERROR_TEXT[result.code],
            recording: toRecordingSummary(next)
          }
    })
  })

  /** Keep local: records the decision; nothing is sent and nothing is deleted. */
  ipcMain.handle('telemetry:cancelReview', async (e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!isTrustedSender(e) || !sessionId) return { ok: false, error: 'Invalid request' }
    const s = store
    return withReviewLock(sessionId, async () => {
      const meta = await s.getSessionMeta(sessionId).catch(() => null)
      if (!meta?.delivery || !requireSessionOwner(meta.ownerEmail).ok) {
        return { ok: false, error: 'Unknown session' }
      }
      if (meta.delivery.review.state !== 'prepared') {
        return { ok: true, recording: toRecordingSummary(meta) }
      }
      const next = await s.updateDelivery(sessionId, (d) => ({
        ...d!,
        review: { ...d!.review, state: 'cancelled' }
      }))
      void broadcastRecording(sessionId)
      return { ok: true, recording: toRecordingSummary(next) }
    })
  })

  /**
   * Explicit approval of one prepared revision/digest. Persists the receipt and the
   * attempt start before any client exists; repeated presses join the same operation.
   */
  ipcMain.handle(
    'telemetry:approveInterpretation',
    async (
      e,
      payload: {
        sessionId: string
        revision: number
        digest: string
        acknowledgeUnknownOutcome?: boolean
      }
    ) => {
      if (!store) return { ok: false, error: 'Telemetry not initialized' }
      const sessionId = payload?.sessionId
      if (
        !isTrustedSender(e) ||
        !sessionId ||
        typeof payload.revision !== 'number' ||
        typeof payload.digest !== 'string'
      ) {
        return { ok: false, error: 'Invalid request' }
      }
      const s = store
      return withReviewLock(sessionId, async () => {
        const meta = await s.getSessionMeta(sessionId).catch(() => null)
        if (!meta) return { ok: false, error: 'Unknown session' }
        const auth = requireSessionOwner(meta.ownerEmail)
        if (!auth.ok) return { ok: false, error: 'Unknown session' }
        const interp = meta.delivery?.interpretation
        if (interpretOps.has(sessionId)) {
          return { ok: true, alreadyRunning: true, recording: toRecordingSummary(meta) }
        }
        if (interp?.state === 'complete' && interp.digest === payload.digest) {
          return { ok: true, recording: toRecordingSummary(meta) }
        }

        // A received result that only failed to save locally: retry the write, no request.
        const pending = pendingResultSaves.get(sessionId)
        if (pending && interp?.digest === payload.digest) {
          try {
            await pending.save()
            pendingResultSaves.delete(sessionId)
            const next = await s.updateDelivery(
              sessionId,
              (d) => ({
                ...d!,
                interpretation: {
                  ...d!.interpretation,
                  state: 'complete',
                  errorCode: undefined,
                  completedAt: new Date().toISOString()
                }
              }),
              { processingStatus: 'complete', processingErrorCode: null }
            )
            void broadcastRecording(sessionId)
            return { ok: true, recording: toRecordingSummary(next) }
          } catch {
            return {
              ok: false,
              errorCode: 'RESULT_SAVE_FAILED',
              error: 'The interpretation still could not be saved on this Mac.',
              recording: toRecordingSummary(meta)
            }
          }
        }

        // A dispatched request may have been processed remotely; resending needs consent.
        const dispatched =
          (interp?.state === 'failed' || interp?.state === 'interrupted_unknown') && !!interp.stage
        if (dispatched && !payload.acknowledgeUnknownOutcome) {
          return {
            ok: false,
            errorCode: 'UNKNOWN_OUTCOME_ACK_REQUIRED',
            error:
              'The provider may already have processed the earlier request. Sending again may repeat that work.',
            recording: toRecordingSummary(meta)
          }
        }

        const checked = await validateApproval(
          s,
          sessionId,
          payload.revision,
          payload.digest,
          config.openaiModel
        )
        if (!checked.ok) {
          return {
            ok: false,
            errorCode: checked.code,
            error: REVIEW_ERROR_TEXT[checked.code],
            recording: toRecordingSummary(meta)
          }
        }
        const review = checked.review
        const approval = {
          revision: review.revision,
          digest: review.digest,
          principal: auth.email ?? 'local-profile',
          approvedAt: new Date().toISOString(),
          purpose: review.purpose,
          provider: review.provider,
          model: review.model,
          promptVersion: review.promptVersion,
          policyVersion: review.policyVersion,
          legacyUnverified: review.legacyUnverified
        }

        if (!config.openaiApiKey) {
          // Configuration error before any request: approval recorded, nothing dispatched.
          const next = await s.updateDelivery(sessionId, (d) => ({
            ...d!,
            review: { state: 'approved', revision: review.revision, digest: review.digest, approval },
            interpretation: {
              ...d!.interpretation,
              state: 'failed',
              errorCode: 'OPENAI_API_KEY_MISSING',
              stage: undefined
            }
          }))
          void broadcastRecording(sessionId)
          return {
            ok: false,
            errorCode: 'OPENAI_API_KEY_MISSING',
            error: userMessageForCode('OPENAI_API_KEY_MISSING'),
            recording: toRecordingSummary(next)
          }
        }

        const attemptId = newId('att')
        const workflowId = interp?.workflowId ?? newId('wf')
        const sameDigest = interp?.digest === review.digest
        const next = await s.updateDelivery(sessionId, (d) => ({
          ...d!,
          review: { state: 'approved', revision: review.revision, digest: review.digest, approval },
          interpretation: {
            state: 'sending',
            attempt: (d!.interpretation.attempt ?? 0) + 1,
            attemptId,
            revision: review.revision,
            digest: review.digest,
            workflowId,
            ...(sameDigest && d!.interpretation.receipts
              ? { receipts: d!.interpretation.receipts }
              : {})
          }
        }))
        const op = runInterpretation(s, review, { attemptId, workflowId }).finally(() => {
          interpretOps.delete(sessionId)
        })
        interpretOps.set(sessionId, op)
        void broadcastRecording(sessionId)
        return { ok: true, recording: toRecordingSummary(next) }
      })
    }
  )

  /** Open a completed interpretation as a draft with its stable id. Local only. */
  ipcMain.handle('telemetry:openResult', async (_e, sessionId: string) => {
    if (!store || !sessionId) return { ok: false, error: 'Unknown session' }
    const meta = await store.getSessionMeta(sessionId).catch(() => null)
    if (!meta || !requireSessionOwner(meta.ownerEmail).ok) {
      return { ok: false, error: 'Unknown session' }
    }
    const interp = meta.delivery?.interpretation
    const stored = await store.getWorkflow(sessionId)
    const prov = stored?.provenance
    if (!stored || !prov || !interp?.digest || prov.reviewDigest !== interp.digest) {
      return { ok: false, error: 'No reviewed interpretation is available for this recording.' }
    }
    if (interp.state !== 'complete') {
      // Durable matching result whose state update was missed: reconcile locally.
      await store.updateDelivery(sessionId, (d) => ({
        ...d!,
        interpretation: { ...d!.interpretation, state: 'complete', errorCode: undefined }
      }))
      void broadcastRecording(sessionId)
    }
    const workflow = toEditorWorkflow(stored.workflow, prov.workflowId, sessionId)
    return {
      ok: true,
      partial: prov.partial,
      workflow: prov.partial
        ? {
            ...workflow,
            summary: `Partial interpretation — the detailed extraction was invalid, so only the verified first-stage result is shown. ${workflow.summary ?? ''}`.trim()
          }
        : workflow
    }
  })

  /** Legacy Retry by session id alone can never acquire consent. */
  ipcMain.handle('telemetry:processWorkflow', async (_e, sessionId: string) => {
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    return uploadReviewRequired(sessionId)
  })

  ipcMain.handle('telemetry:getWorkflow', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    const meta = await store.getSessionMeta(sessionId)
    if (meta) {
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
    }
    const result = await store.getWorkflow(sessionId)
    if (!result) return { ok: false, error: 'Workflow not found' }
    return { ok: true, result }
  })

  ipcMain.handle('telemetry:getStatus', () => {
    return recorder
      ? currentStatus()
      : ({
          recording: false,
          paused: false,
          sessionId: null,
          sequence: 0,
          startedAt: null,
          processing: false,
          phase: 'idle',
          generation: 0,
          teardownFailed: false
        } satisfies RecordingStatus)
  })

  /** Automation compile stays held; interpretation approval does not cover it. */
  ipcMain.handle('automation:compile', async (_e, sessionId: string) => {
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    return uploadReviewRequired(sessionId, 'compile')
  })

  ipcMain.handle('automation:getScript', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    if (!store.getAutomationScript) return { ok: false, error: 'Automation store unavailable' }
    const meta = await store.getSessionMeta(sessionId)
    if (meta) {
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
    }
    const script = await store.getAutomationScript(sessionId)
    if (!script) return { ok: false, error: 'Script not found' }
    return { ok: true, script }
  })

  ipcMain.handle(
    'automation:markStale',
    async (
      _e,
      sessionId: string,
      stale = true,
      editorSteps?: Array<{ index: number; title: string }>
    ) => {
      if (!store) return { ok: false, error: 'Telemetry not initialized' }
      if (!sessionId) return { ok: false, error: 'sessionId required' }
      // Persist edited step titles immediately so the next compile cannot
      // still see the pre-edit ExtractedWorkflow.
      if (editorSteps?.length) {
        const { syncEditorStepsToStoredWorkflow } = await import(
          './automation/syncEditorSteps'
        )
        await syncEditorStepsToStoredWorkflow(store, sessionId, editorSteps)
      }
      if (!store.markAutomationStale) return { ok: false, error: 'Automation store unavailable' }
      const updated = await store.markAutomationStale(sessionId, stale)
      return updated
        ? { ok: true, stale: updated.stale ?? false }
        : { ok: false, error: 'Script not found' }
    }
  )

  // ── Narration capture (renderer MediaRecorder → main file sink) ──
  // Narration is opened only by an approved sessionStart; these calls never begin a new
  // microphone session. Each requires the owner, its active session and an open sink.
  const narrationOpenFor = (e: IpcMainInvokeEvent, sessionId: unknown): boolean =>
    typeof sessionId === 'string' &&
    isOwner(e, sessionId) &&
    narration?.sessionId === sessionId &&
    narration.state === 'active' &&
    hasActiveRecording()

  ipcMain.handle('narration:start', async (e, sessionId: string) => {
    if (!narrationRecorder || !store) return { ok: false, error: 'Telemetry not initialized' }
    if (!narrationOpenFor(e, sessionId) || narrationRecorder.getSessionId() !== sessionId) {
      return { ok: false, error: 'Narration is not active for this session' }
    }
    return { ok: true, audioPath: narrationRecorder.getAudioPath() }
  })

  ipcMain.handle(
    'narration:append',
    async (e, sessionId: string, chunk: ArrayBuffer | Uint8Array | Buffer) => {
      if (!narrationRecorder) return { ok: false, error: 'Telemetry not initialized' }
      if (!sessionId || !chunk) return { ok: false, error: 'Invalid body' }
      if (!narrationOpenFor(e, sessionId)) return { ok: false, error: 'Chunk not accepted' }
      try {
        const buf = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk)
        if (buf.byteLength > MAX_NARRATION_CHUNK) {
          return { ok: false, error: 'Chunk too large' }
        }
        // Acknowledge only after the chunk is accepted by the file stream.
        const accepted = await narrationRecorder.appendChunk(sessionId, buf)
        return accepted ? { ok: true } : { ok: false, error: 'Chunk not accepted' }
      } catch {
        return { ok: false, error: 'Append failed' }
      }
    }
  )

  /**
   * Session-scoped, idempotent sink close (acquisition/error cleanup only; Pause/Stop carry
   * the receipt). Never closes another session's sink and never erases a receipt.
   */
  ipcMain.handle('narration:stop', async (e, sessionId?: string) => {
    if (!narrationRecorder) return { ok: false, error: 'Telemetry not initialized' }
    if (
      typeof sessionId !== 'string' ||
      !isOwner(e, sessionId) ||
      narration?.sessionId !== sessionId ||
      narrationRecorder.getSessionId() !== sessionId
    ) {
      return { ok: false, error: 'Narration is not active for this session' }
    }
    try {
      const result = await narrationRecorder.end()
      narration = { sessionId, state: 'ended' }
      return { ...result, ok: result.ok }
    } catch {
      return { ok: false, error: 'Could not stop narration' }
    }
  })
}

/** Last-chance flush after the quit barrier; an active session takes the full barrier. */
export async function flushTelemetryOnQuit(): Promise<void> {
  if (!recorder) return
  try {
    if (hasActiveRecording()) {
      await stopActiveRecording('quit')
    } else {
      await recorder.flush()
    }
  } catch (err) {
    console.error('[telemetry] quit flush failed')
  }
}
