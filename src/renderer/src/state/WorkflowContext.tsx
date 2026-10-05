import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  Dispatch,
  SetStateAction,
  ReactNode
} from 'react'
import { flushSync } from 'react-dom'
import { newId } from '../../../shared/id'
import { nextRun } from '../../../shared/schedule'
import type {
  AppState,
  PermissionsState,
  QuestionReceipt,
  RecordMode,
  Run,
  RunStep,
  RunStepResult,
  StepApp,
  SummaryOutcome,
  Workflow
} from './types'
import { formatWatchEntry } from '../../../shared/telemetry/formatWatchEntry'
import type { TelemetryEvent } from '../../../shared/telemetry/schema'
import { noticeForStopResult, type RecordingNotice } from '../workspace/UploadReview'
import { createMockDraft, makeRunSteps, MOCK_APPS } from './mockData'

/**
 * Renderer's account of the narration chunks it sent; main verifies it against the sink.
 * `recorderFailed` is sticky and separate from the counts: a recorder error or stop
 * exception after capture started (M2-R1 correction).
 */
type NarrationReport = {
  chunksAcknowledged: number
  chunksFailed: number
  timedOut: boolean
  recorderFailed: boolean
}

/** One narration attempt: its own recorder, tracks and chunk account (never a global). */
type NarrationAttempt = {
  sessionId: string
  cancelled: boolean
  recorder: MediaRecorder | null
  stream: MediaStream | null
  chunks: { pending: Set<Promise<void>>; acknowledged: number; failed: number }
  /** Sticky: set by a runtime recorder error or a stop exception, never cleared. */
  recorderFailed: boolean
  /** The receipt was built; later callbacks cannot change it. */
  settled: boolean
  end: Promise<NarrationReport> | null
}

/** End exactly this attempt (idempotent, joinable); never touches a newer attempt. */
function endNarrationAttempt(attempt: NarrationAttempt): Promise<NarrationReport> {
  if (!attempt.end) {
    attempt.cancelled = true
    attempt.end = finishNarrationAttempt(attempt)
  }
  return attempt.end
}

const NARRATION_STOP_MS = 1500
const NARRATION_DRAIN_MS = 5000

/** Stop each track exactly once. */
function releaseTracks(attempt: NarrationAttempt): void {
  const stream = attempt.stream
  attempt.stream = null
  stream?.getTracks().forEach((t) => t.stop())
}

/** True when `p` settles first; the timer is always cleared. */
function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    void p.then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(true)
      }
    )
  })
}

/** Stop recorder (bounded), always release tracks, drain final chunk acks (bounded). */
async function finishNarrationAttempt(attempt: NarrationAttempt): Promise<NarrationReport> {
  let timedOut = false
  try {
    const recorder = attempt.recorder
    if (recorder && recorder.state !== 'inactive') {
      let onStop: (() => void) | null = null
      const stopped = new Promise<void>((resolve) => {
        onStop = () => resolve()
        recorder.addEventListener('stop', onStop)
        try {
          recorder.stop()
        } catch {
          // A stop exception is a recorder failure, not a timeout and not success.
          attempt.recorderFailed = true
          resolve()
        }
      })
      try {
        if (!(await settlesWithin(stopped, NARRATION_STOP_MS))) timedOut = true
      } finally {
        // The owned listener never outlives this teardown (success, exception or timeout).
        if (onStop) recorder.removeEventListener('stop', onStop)
      }
    }
  } finally {
    releaseTracks(attempt)
  }
  const { chunks } = attempt
  if (chunks.pending.size > 0) {
    if (!(await settlesWithin(Promise.allSettled([...chunks.pending]), NARRATION_DRAIN_MS))) {
      timedOut = true
    }
  }
  attempt.settled = true
  return {
    chunksAcknowledged: chunks.acknowledged,
    chunksFailed: chunks.failed + chunks.pending.size,
    timedOut,
    recorderFailed: attempt.recorderFailed
  }
}

/** The Record dropdown could not open (load failure, timeout, no room): neutral and retryable. */
function dropdownFailureNotice(): RecordingNotice {
  return {
    tone: 'error',
    title: 'Couldn’t open the record panel',
    body: 'Nothing was recorded. Click the pill to try again.',
    sessionId: null,
    action: null
  }
}

/**
 * Coalesces hover open/close requests (M1-HF2): the latest request wins, one native
 * transition runs at a time, and a superseded transition (ack.current=false) stops without
 * touching UI. Requests made while a drag owns the window wait for `kick()` at drag end.
 */
export class HoverDriver {
  private desired: 'open' | 'closed' = 'closed'
  private running = false
  private disposed = false

  constructor(
    private readonly ops: {
      isOpen: () => boolean
      canRun: () => boolean
      open: () => Promise<boolean>
      close: () => Promise<boolean>
    }
  ) {}

  request(next: 'open' | 'closed'): void {
    this.desired = next
    void this.pump()
  }

  /** Pill click: flip the latest intent (including an open/close still in flight). */
  toggle(): void {
    const effective = this.running ? this.desired : this.ops.isOpen() ? 'open' : 'closed'
    this.request(effective === 'open' ? 'closed' : 'open')
  }

  kick(): void {
    void this.pump()
  }

  dispose(): void {
    this.disposed = true
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return
    this.running = true
    try {
      // Bounded: at most a few alternations for one burst of requests.
      for (let step = 0; step < 4 && !this.disposed && this.ops.canRun(); step++) {
        const open = this.ops.isOpen()
        if (this.desired === 'open' && !open) {
          if (!(await this.ops.open())) break
        } else if (this.desired === 'closed' && open) {
          if (!(await this.ops.close())) break
        } else break
      }
    } finally {
      this.running = false
    }
  }
}


export type WatchEntry = {
  time: string
  text: string
  voiceNote?: string
  app?: StepApp
}

const RUN_TICK_MS = 1800
/** 10-minute error hold → auto-stop (6.4). */
const ERROR_HOLD_MS = 10 * 60 * 1000
/** Teal saved pill reverts to Hello after ~6s. */
const SAVED_PILL_MS = 6000

type ActiveRun = {
  id: string
  workflowId: string
  startedAt: string
  questionReceipts: QuestionReceipt[]
  stopReason?: string
}

type SavedConfirm = {
  workflowId: string
}

type WorkflowContextValue = {
  state: AppState
  // hover / recording config
  recordMode: RecordMode
  setRecordMode: (m: RecordMode) => void
  selectedAppId: string
  setSelectedAppId: (id: string) => void
  narrate: boolean
  setNarrate: (v: boolean) => void
  // recording
  elapsedLabel: string
  recordPaused: boolean
  toggleRecordPause: () => void
  watchLog: WatchEntry[]
  watchExpanded: boolean
  setWatchExpanded: (v: boolean) => void
  /** Saved / incomplete / error notice after Finish; keeps the session id for review. */
  recordingNotice: RecordingNotice | null
  dismissRecordingNotice: () => void
  runRecordingNoticeAction: () => void
  // editor
  workflow: Workflow
  setWorkflow: Dispatch<SetStateAction<Workflow>>
  editorCollapsed: boolean
  setEditorCollapsed: (v: boolean) => void
  /** Teal saved confirmation (replaces toast-for-save). */
  savedConfirm: SavedConfirm | null
  openSavedInLibrary: () => void
  dismissSavedConfirm: () => void
  // window layout
  // drag ↔ hover mutual exclusion
  /** Returns whether the drag should collapse glass → pill. */
  beginDrag: () => { collapseToPill: boolean }
  endDrag: () => void
  // running
  runSteps: RunStep[]
  setRunSteps: Dispatch<SetStateAction<RunStep[]>>
  runPaused: boolean
  runCollapsed: boolean
  setRunCollapsed: (v: boolean) => void
  runElapsedLabel: string
  runDoneCount: number
  hasQuestionHold: boolean
  hasErrorHold: boolean
  answerQuestion: (stepId: string, optionId: string, custom?: string) => void
  resolveError: (stepId: string, action: 'retry' | 'skip' | 'takeover') => void
  skipStep: (stepId: string) => void
  // summary
  summaryOutcome: SummaryOutcome
  summaryMeta: string
  /** Persisted run id for the current / last summary — View log deep-link. */
  lastRunId: string | null
  // permissions (Phase 4)
  /** True when Screen Recording is granted (record / run preflight). */
  screenGranted: boolean
  /** True when Microphone is granted (narration availability). */
  micGranted: boolean
  /** Screen Recording is currently off (required for record/run). */
  permissionPaused: boolean
  /** A run is holding mid-flight because Screen Recording dropped. */
  permissionHold: boolean
  /** Show the revoked-permission toast above the pill. */
  permToastVisible: boolean
  /** Concrete stake shown in the revoked toast (next scheduled run). */
  permStake: string
  /** Which permission the revoked toast points at. */
  permStakeTitle: string
  fixPermission: () => void
  dismissPermToast: () => void
  openScreenRecovery: () => void
  // transitions
  openHover: () => void
  closeHover: () => void
  /** Pill click: open or close, honoring an open/close still in flight. */
  toggleHover: () => void
  startRecording: () => void
  cancelRecording: () => void
  finishRecording: () => void
  cancelEditor: () => void
  /** Optional override used when accepting the run contract in the same tick. */
  runWorkflow: (override?: Workflow) => void
  saveWorkflow: () => void
  editFromRunning: () => void
  toggleRunPause: () => void
  stopRunning: () => void
  finishSummary: () => void
  runRemaining: () => void
  /** Full re-run from the summary (automation or mock). */
  runAgain: () => void
}

const WorkflowContext = createContext<WorkflowContextValue | null>(null)

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function toRunStepResults(steps: RunStep[]): RunStepResult[] {
  return steps.map((s) => ({
    stepId: s.id,
    index: s.index,
    label: s.label,
    doneLabel: s.doneLabel,
    status:
      s.status === 'question' || s.status === 'error' || s.status === 'active'
        ? 'held'
        : s.status,
    app: s.app,
    voiceNote: s.voiceNote
  }))
}

function buildRunRecord(
  active: ActiveRun,
  steps: RunStep[],
  outcome: SummaryOutcome,
  elapsedSeconds: number
): Run {
  const endedAt = new Date().toISOString()
  return {
    id: active.id,
    workflowId: active.workflowId,
    startedAt: active.startedAt,
    endedAt,
    outcome,
    steps: toRunStepResults(steps),
    questions: active.questionReceipts,
    returnedMinutes:
      outcome === 'done' ? Math.max(1, Math.round(elapsedSeconds / 60) || 1) : undefined,
    stopReason: active.stopReason
  }
}

function isHoldStatus(status: RunStep['status']): boolean {
  return status === 'question' || status === 'error'
}

export function WorkflowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>('idle')
  const stateRef = useRef(state)
  stateRef.current = state

  const [recordMode, setRecordModeState] = useState<RecordMode>('one-app')
  const [selectedAppId, setSelectedAppIdState] = useState('chrome')
  const [narrate, setNarrateState] = useState(true)
  const settingsReadyRef = useRef(false)

  const [elapsed, setElapsed] = useState(0)
  const [recordPaused, setRecordPaused] = useState(false)
  const [watchLog, setWatchLog] = useState<WatchEntry[]>([])
  const [watchExpanded, setWatchExpanded] = useState(false)
  const watchExpandedRef = useRef(watchExpanded)
  watchExpandedRef.current = watchExpanded
  const [recordingNotice, setRecordingNotice] = useState<RecordingNotice | null>(null)
  const telemetrySessionRef = useRef<string | null>(null)
  /** The session's one narration attempt (M2-R1); owned before acquisition is awaited. */
  const narrationRef = useRef<NarrationAttempt | null>(null)
  const pauseBusyRef = useRef(false)
  /** The teardown-failure notice was shown for this session. */
  const teardownNoticeRef = useRef<string | null>(null)

  const [workflow, setWorkflow] = useState<Workflow>(() => createMockDraft(newId('draft')))
  const [editorCollapsed, setEditorCollapsed] = useState(false)
  const editorCollapsedRef = useRef(editorCollapsed)
  editorCollapsedRef.current = editorCollapsed
  const [savedConfirm, setSavedConfirm] = useState<SavedConfirm | null>(null)

  /** While true, hover must not open — dragging and hovering are exclusive. */
  const draggingRef = useRef(false)
  const prevStateRef = useRef<AppState>(state)
  /** Last bounds request sent for the pill (the dropdown never resizes it). */
  const lastBoundsKeyRef = useRef<string | null>(null)
  /** Generation of the latest dropdown open acknowledged as current (M1-HF3). */
  const dropdownGenRef = useRef(-1)
  /**
   * Newest close generation main reported in this renderer lifetime, recorded even while an
   * open is still pending (HF3-B-R1): a delayed open reply older than it is stale.
   */
  const dropdownClosedGenRef = useRef(-1)
  /** One Start from the dropdown at a time. */
  const dropdownStartRef = useRef(false)

  const [runSteps, setRunSteps] = useState<RunStep[]>([])
  const runStepsRef = useRef<RunStep[]>([])
  runStepsRef.current = runSteps
  const [runPaused, setRunPaused] = useState(false)
  const [runCollapsed, setRunCollapsed] = useState(false)
  const runCollapsedRef = useRef(runCollapsed)
  runCollapsedRef.current = runCollapsed
  const [runElapsed, setRunElapsed] = useState(0)
  const runElapsedRef = useRef(0)
  runElapsedRef.current = runElapsed
  /** True when a paused run is waiting behind the editor (Edit during a run). */
  const runInFlightRef = useRef(false)
  const activeRunRef = useRef<ActiveRun | null>(null)
  const runPersistedRef = useRef(false)
  const errorHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holdMirroredRef = useRef<string | null>(null)

  const [summaryOutcome, setSummaryOutcome] = useState<SummaryOutcome>('done')

  // ── Permissions (Phase 4) ──
  const [permissions, setPermissions] = useState<PermissionsState | null>(null)
  const permissionsRef = useRef<PermissionsState | null>(null)
  const [toastArmed, setToastArmed] = useState(false)
  const [permStake, setPermStake] = useState('')
  const [permStakeTitle, setPermStakeTitle] = useState('Screen recording was turned off')
  const [permissionHold, setPermissionHold] = useState(false)
  const permissionHoldRef = useRef(false)
  permissionHoldRef.current = permissionHold

  const screenGranted = permissions ? permissions.screen === 'granted' : true
  const micGranted = permissions ? permissions.microphone === 'granted' : false
  // Accessibility is reserved for a future InteractionProvider — only Screen
  // Recording is required for recording today.
  const permissionPaused = !!permissions && !screenGranted

  const computeStake = useCallback(async () => {
    setPermStakeTitle('Screen recording was turned off')
    const snap = await window.ghostBridge?.getSnapshot?.()
    const scheduled = (snap?.workflows ?? [])
      .filter((w) => w.status === 'on' && w.trigger.cadence)
      .map((w) => ({ w, when: nextRun(w.trigger) }))
      .filter((x): x is { w: Workflow; when: Date } => x.when != null)
      .sort((a, b) => a.when.getTime() - b.when.getTime())
    if (scheduled.length === 0) {
      setPermStake('yuh can’t record or run workflows until this is back on.')
      return
    }
    const { w, when } = scheduled[0]
    const time = when.toLocaleString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
    setPermStake(`${w.name} is scheduled for ${time}. yuh can’t run it until this is back on.`)
  }, [])

  useEffect(() => {
    let cancelled = false
    window.ghostBridge?.getPermissions?.().then((p) => {
      if (cancelled || !p) return
      permissionsRef.current = p
      setPermissions(p)
    })
    const off = window.ghostBridge?.onPermissionsChanged?.((p) => {
      const prev = permissionsRef.current
      permissionsRef.current = p
      setPermissions(p)
      const wasOk = !!prev && prev.screen === 'granted'
      const nowMissing = p.screen !== 'granted'
      if (wasOk && nowMissing) {
        setToastArmed(true)
        void computeStake()
        if (stateRef.current === 'running') {
          setPermissionHold(true)
          setRunPaused(true)
          setRunCollapsed(false)
        }
      }
      if (!nowMissing) {
        setToastArmed(false)
        if (permissionHoldRef.current) {
          setPermissionHold(false)
          setRunPaused(false)
        }
      }
    })
    return () => {
      cancelled = true
      off?.()
    }
  }, [computeStake])

  const permToastVisible = toastArmed && state !== 'running'

  const fixPermission = useCallback(() => {
    window.ghostBridge?.openPermissionSettings?.('screen')
  }, [])

  const openScreenRecovery = useCallback(() => {
    window.ghostBridge?.openPermissionSettings?.('screen')
  }, [])

  const dismissPermToast = useCallback(() => {
    setToastArmed(false)
    window.ghostBridge?.setPermissionToastDismissedAt?.(new Date().toISOString())
  }, [])

  // ── Hydrate last-used record settings from the shared store ──
  useEffect(() => {
    let cancelled = false
    window.ghostBridge?.getSnapshot?.().then((snap) => {
      if (cancelled || !snap) return
      setRecordModeState(snap.recordSettings.recordMode)
      setSelectedAppIdState(snap.recordSettings.selectedAppId)
      setNarrateState(snap.recordSettings.narrate)
      settingsReadyRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  const persistRecordSettings = useCallback(
    (next: { recordMode: RecordMode; narrate: boolean; selectedAppId: string }) => {
      if (!settingsReadyRef.current) return
      window.ghostBridge?.setRecordSettings?.(next)
    },
    []
  )

  const setRecordMode = useCallback(
    (m: RecordMode) => {
      setRecordModeState(m)
      persistRecordSettings({ recordMode: m, narrate, selectedAppId })
    },
    [narrate, persistRecordSettings, selectedAppId]
  )

  const setSelectedAppId = useCallback(
    (id: string) => {
      setSelectedAppIdState(id)
      persistRecordSettings({ recordMode, narrate, selectedAppId: id })
    },
    [narrate, persistRecordSettings, recordMode]
  )

  const setNarrate = useCallback(
    (v: boolean) => {
      setNarrateState(v)
      persistRecordSettings({ recordMode, narrate: v, selectedAppId })
    },
    [persistRecordSettings, recordMode, selectedAppId]
  )

  // ── Keep main's context-menu variant in sync ──
  useEffect(() => {
    window.ghostBridge?.setPillAppState?.(state)
  }, [state])

  // ── Editor / summary ink-20 scrim (main hides it when pill is not frontmost) ──
  useEffect(() => {
    const show =
      (state === 'editor' && !editorCollapsed) || state === 'summary'
    window.ghostBridge?.setEditorScrim?.(show)
    return () => {
      window.ghostBridge?.setEditorScrim?.(false)
    }
  }, [state, editorCollapsed])

  // ── Saved pill auto-clear (~6s) ──
  useEffect(() => {
    if (!savedConfirm) return
    const t = setTimeout(() => setSavedConfirm(null), SAVED_PILL_MS)
    return () => clearTimeout(t)
  }, [savedConfirm])

  const dismissSavedConfirm = useCallback(() => setSavedConfirm(null), [])

  const openSavedInLibrary = useCallback(() => {
    const id = savedConfirm?.workflowId
    setSavedConfirm(null)
    if (id) window.ghostBridge?.openWorkspace?.(id)
    else window.ghostBridge?.openWorkspace?.()
  }, [savedConfirm])

  // ── Sync window bounds with state ──
  useEffect(() => {
    type Size = {
      w: number
      h: number
      mode: 'pill' | 'glass' | 'panel'
      center?: boolean
    }
    const idleSize: Size = savedConfirm
      ? { w: 210, h: 24, mode: 'pill' }
      : permToastVisible || !!recordingNotice
        ? { w: 410, h: 232, mode: 'panel' }
        : permissionPaused
          ? { w: 224, h: 24, mode: 'pill' }
          : { w: 94, h: 24, mode: 'pill' }
    // The Record dropdown is its own window (M1-HF3): while it is open the pill keeps its
    // idle capsule size (toasts hide while it is open).
    const pillOnly: Size = permissionPaused ? { w: 224, h: 24, mode: 'pill' } : { w: 94, h: 24, mode: 'pill' }
    const sizes: Record<AppState, Size> = {
      idle: idleSize,
      hover: pillOnly,
      recording: watchExpanded
        ? // Hug ledger + side/bottom shadow pad; top pad is 0 via .ghost-root-panel.
          { w: 321, h: 336, mode: 'panel' }
        : { w: 161, h: 24, mode: 'pill' },
      organizing: { w: 94, h: 24, mode: 'pill' },
      editor: editorCollapsed
        ? { w: 125, h: 24, mode: 'pill' }
        : // 660×521 card + 36 side pads + 36 bottom pad (no top pad).
          { w: 732, h: 557, mode: 'panel' },
      running: runCollapsed
        ? { w: 230, h: 24, mode: 'pill' }
        : // 436-wide running card + pads; height hugs typical content.
          { w: 508, h: 436, mode: 'panel' },
      summary: { w: 432, h: 432, mode: 'panel', center: true }
    }
    const { w, h, mode, center } = sizes[state]
    const prev = prevStateRef.current
    prevStateRef.current = state
    // Opening/closing the dropdown or re-running this effect never re-sends the pill's
    // current size: no native frame operation on the stationary pill.
    const key = `${w}x${h}:${mode}:${center ? 1 : 0}`
    const quiet = (s: AppState) => s === 'idle' || s === 'hover'
    if (quiet(prev) && quiet(state) && lastBoundsKeyRef.current === key) return
    lastBoundsKeyRef.current = key
    const durationMs = 0
    const pillDrive = false
    void window.ghostBridge?.setBounds?.(w, h, mode, { durationMs, pillDrive, center })
  }, [
    state,
    watchExpanded,
    editorCollapsed,
    runCollapsed,
    savedConfirm,
    permToastVisible,
    permissionPaused,
    recordingNotice
  ])

  // ── Recording timer ──
  useEffect(() => {
    if (state !== 'recording' || recordPaused) return
    const t = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [state, recordPaused])

  // ── Streaming ledger from real telemetry events ──
  useEffect(() => {
    const off = window.ghostBridge?.onTelemetryEvent?.((event: TelemetryEvent) => {
      if (stateRef.current !== 'recording') return
      if (recordPaused) return
      const line = formatWatchEntry(event)
      if (!line) return
      // Skip noisy screen_changed when the previous line already covers the title.
      setWatchLog((log) => {
        if (
          event.type === 'screen_changed' &&
          log.length > 0 &&
          (log[log.length - 1].text.includes(line.text.replace(/^Looking at /, '')) ||
            log[log.length - 1].text.startsWith('Opened '))
        ) {
          return log
        }
        return [
          ...log,
          {
            time: line.time,
            text: line.text,
            app: mapAppName(line.appName)
          }
        ]
      })
    })
    return () => {
      off?.()
    }
  }, [recordPaused])

  const [lastRunId, setLastRunId] = useState<string | null>(null)

  // ── Persist Run when entering summary ──
  useEffect(() => {
    if (state !== 'summary') return
    const active = activeRunRef.current
    if (!active || runPersistedRef.current) return
    runPersistedRef.current = true
    setLastRunId(active.id)
    const record = buildRunRecord(
      active,
      runStepsRef.current,
      summaryOutcome,
      runElapsedRef.current
    )
    window.ghostBridge?.saveRun?.(record)
  }, [state, summaryOutcome])

  const hasQuestionHold = runSteps.some(
    (s) => s.status === 'question' && s.question?.answerId === null
  )
  const hasErrorHold = runSteps.some((s) => s.status === 'error' && !s.error?.takenOver)
  const holdActive = hasQuestionHold || hasErrorHold

  // ── Mirror holds into Activity (Phase 3 renders 2.5) ──
  useEffect(() => {
    if (state !== 'running') return
    const active = activeRunRef.current
    if (!active) return
    const held = runSteps.find(
      (s) =>
        (s.status === 'question' && s.question?.answerId === null) ||
        (s.status === 'error' && !s.error?.takenOver)
    )
    if (!held) {
      if (holdMirroredRef.current) {
        window.ghostBridge?.clearActivityHold?.(active.id)
        holdMirroredRef.current = null
      }
      return
    }
    const key = `${held.id}:${held.status}`
    if (holdMirroredRef.current === key) return
    holdMirroredRef.current = key
    window.ghostBridge?.upsertActivityHold?.({
      runId: active.id,
      workflowId: active.workflowId,
      name: workflow.name,
      needsYou: held.status === 'error' ? 'help' : 'answer',
      heldStepIndex: held.index,
      waitingSince: new Date().toISOString()
    })
  }, [state, runSteps, workflow.name])

  // ── 10-min error hold auto-stop ──
  useEffect(() => {
    if (errorHoldTimerRef.current) {
      clearTimeout(errorHoldTimerRef.current)
      errorHoldTimerRef.current = null
    }
    if (state !== 'running' || !hasErrorHold) return
    const held = runSteps.find((s) => s.status === 'error' && !s.error?.takenOver)
    if (!held) return
    errorHoldTimerRef.current = setTimeout(() => {
      const active = activeRunRef.current
      if (active) {
        active.stopReason = `Stopped — needed help at step ${held.index}`
        window.ghostBridge?.upsertActivityHold?.({
          runId: active.id,
          workflowId: active.workflowId,
          name: workflow.name,
          needsYou: 'help',
          heldStepIndex: held.index,
          waitingSince: new Date().toISOString(),
          stopReason: active.stopReason
        })
      }
      runInFlightRef.current = false
      setSummaryOutcome('stopped')
      setState('summary')
    }, ERROR_HOLD_MS)
    return () => {
      if (errorHoldTimerRef.current) {
        clearTimeout(errorHoldTimerRef.current)
        errorHoldTimerRef.current = null
      }
    }
  }, [state, hasErrorHold, runSteps, workflow.name])

  // True when this run is driven by the main-process automation runner.
  const automationRunRef = useRef(false)
  const automationVarKeyRef = useRef<string | null>(null)

  // ── Run engine (flat ledger) ──
  useEffect(() => {
    if (state !== 'running' || runPaused) return
    const t = setInterval(() => setRunElapsed((e) => e + 1), 1000)
    return () => clearInterval(t)
  }, [state, runPaused])

  // Mock timer engine — only for seeded workflows without a compiled script.
  useEffect(() => {
    if (state !== 'running' || runPaused || holdActive) return
    if (automationRunRef.current) return
    const t = setInterval(() => {
      setRunSteps((steps) => {
        const next = steps.map((s) => ({ ...s }))
        const active = next.find(
          (s) => s.status === 'active' || isHoldStatus(s.status)
        )
        if (active) {
          if (active.status === 'question' && active.question?.answerId === null) return steps
          if (active.status === 'error' && !active.error?.takenOver) return steps
          // Mock failure: first attempt at a marked step becomes an error hold.
          if (active.status === 'active' && active.mockFailOnce) {
            active.mockFailOnce = false
            active.status = 'error'
            active.error = {
              message: 'Couldn’t find a page named “Crit” in this file.'
            }
            setRunCollapsed(false)
            return next
          }
          active.status = 'done'
        }
        const pending = next.find((s) => s.status === 'pending')
        if (pending) {
          pending.status =
            pending.question && pending.question.answerId === null ? 'question' : 'active'
          if (pending.status === 'question') setRunCollapsed(false)
        } else {
          setSummaryOutcome('done')
          setTimeout(() => setState('summary'), 600)
        }
        return next
      })
    }, RUN_TICK_MS)
    return () => clearInterval(t)
  }, [state, runPaused, holdActive])

  // Automation runner → ledger
  useEffect(() => {
    if (state !== 'running' || !automationRunRef.current) return
    const off = window.ghostBridge?.onAutomationRunEvent?.((event) => {
      if (activeRunRef.current && event.runId !== activeRunRef.current.id) {
        // Allow main-assigned runId to replace the provisional id.
        if (event.type === 'stepStarted' || event.type === 'finished') {
          activeRunRef.current.id = event.runId
        } else if (event.runId !== activeRunRef.current.id) {
          return
        }
      }

      if (event.type === 'finished') {
        setSummaryOutcome(event.outcome === 'done' ? 'done' : 'stopped')
        setTimeout(() => setState('summary'), 400)
        automationRunRef.current = false
        return
      }

      setRunSteps((steps) => {
        const next = steps.map((s) => ({ ...s }))
        const byOrder = (order: number) =>
          next.find((s) => s.index === order) ?? next[order - 1]

        if (event.type === 'stepStarted') {
          for (const s of next) {
            if (s.status === 'active') s.status = 'done'
          }
          const target = byOrder(event.stepOrder)
          if (target && target.status !== 'done' && target.status !== 'skipped') {
            target.status = 'active'
            target.label = event.label || target.label
            target.error = undefined
          }
          return next
        }

        if (event.type === 'stepDone') {
          const target = byOrder(event.stepOrder)
          if (target) {
            target.status = 'done'
            target.error = undefined
            if (event.label) target.doneLabel = event.label
          }
          return next
        }

        if (event.type === 'stepFailed') {
          const target = byOrder(event.stepOrder)
          if (target) {
            target.status = 'error'
            target.error = { message: event.message }
            setRunCollapsed(false)
          }
          return next
        }

        if (event.type === 'question') {
          const target = byOrder(event.stepOrder)
          automationVarKeyRef.current = event.variableKey
          if (target) {
            target.status = 'question'
            target.question = {
              prompt: event.prompt,
              options: [
                { id: 'custom', label: 'Enter value', kind: 'other' },
                { id: 'skip', label: 'Skip', kind: 'suggested' }
              ],
              answerId: null
            }
            setRunCollapsed(false)
          }
          return next
        }

        return steps
      })
    })
    return () => off?.()
  }, [state])

  const answerQuestion = useCallback((stepId: string, optionId: string, custom?: string) => {
    setRunSteps((steps) => {
      const target = steps.find((s) => s.id === stepId)
      const option = target?.question?.options.find((o) => o.id === optionId)
      if (activeRunRef.current && target?.question) {
        activeRunRef.current.questionReceipts.push({
          stepId,
          prompt: target.question.prompt,
          answerId: optionId,
          answerLabel: custom?.trim() || option?.label || optionId,
          customValue: custom,
          answeredAt: new Date().toISOString()
        })
      }
      return steps.map((s) =>
        s.id === stepId && s.question
          ? {
              ...s,
              status: 'active',
              question: { ...s.question, answerId: optionId, customValue: custom }
            }
          : s
      )
    })
    if (automationRunRef.current) {
      if (optionId === 'skip') {
        void window.ghostBridge?.automationRunSkipStep?.()
      } else {
        void window.ghostBridge?.automationRunAnswer?.({
          value: custom?.trim() || optionId,
          variableKey: automationVarKeyRef.current
        })
      }
    }
  }, [])

  /** Skip any not-done step — including steps later than the current one. */
  const skipStep = useCallback((stepId: string) => {
    if (automationRunRef.current) {
      setRunSteps((steps) => {
        const next = steps.map((s) => ({ ...s }))
        const target = next.find((s) => s.id === stepId)
        if (target) {
          target.status = 'skipped'
          target.error = undefined
        }
        return next
      })
      void window.ghostBridge?.automationRunSkipStep?.()
      return
    }
    setRunSteps((steps) => {
      const next = steps.map((s) => ({ ...s }))
      const target = next.find((s) => s.id === stepId)
      if (!target || target.status === 'done' || target.status === 'skipped') return steps
      const wasCurrent =
        target.status === 'active' ||
        target.status === 'question' ||
        target.status === 'error'
      target.status = 'skipped'
      target.error = undefined
      if (wasCurrent) {
        const pending = next.find((s) => s.status === 'pending')
        if (pending) {
          pending.status =
            pending.question && pending.question.answerId === null ? 'question' : 'active'
          if (pending.status === 'question') setRunCollapsed(false)
        } else {
          setSummaryOutcome('done')
          setTimeout(() => setState('summary'), 600)
        }
      }
      return next
    })
  }, [])

  const resolveError = useCallback(
    (stepId: string, action: 'retry' | 'skip' | 'takeover') => {
      if (action === 'skip') {
        skipStep(stepId)
        return
      }
      if (action === 'retry') {
        setRunSteps((steps) =>
          steps.map((s) =>
            s.id === stepId
              ? { ...s, status: 'active', error: undefined, mockFailOnce: false }
              : s
          )
        )
        if (automationRunRef.current) {
          void window.ghostBridge?.automationRunRetryStep?.()
        }
        return
      }
      // Take over — pause; resume continues from the next step.
      setRunSteps((steps) => {
        const next = steps.map((s) => ({ ...s }))
        const target = next.find((s) => s.id === stepId)
        if (!target) return steps
        target.status = 'done'
        target.error = undefined
        if (!automationRunRef.current) {
          const pending = next.find((s) => s.status === 'pending')
          if (pending) {
            pending.status =
              pending.question && pending.question.answerId === null ? 'question' : 'active'
          }
        }
        return next
      })
      if (automationRunRef.current) {
        void window.ghostBridge?.automationRunTakeOver?.()
      }
      setRunPaused(true)
    },
    [skipStep]
  )

  const runDoneCount = runSteps.filter(
    (s) => s.status === 'done' || s.status === 'skipped'
  ).length

  // ── Summary meta: "Done · 6 of 6 · 1:12" / "Stopped · 3 of 6 · 1:12" ──
  const summaryMeta = useMemo(() => {
    const time = formatElapsed(runElapsed)
    const total = runSteps.length
    if (summaryOutcome === 'done') return `Done · ${total} of ${total} · ${time}`
    const active = activeRunRef.current
    if (active?.stopReason) return active.stopReason
    return `Stopped · ${runDoneCount} of ${total} · ${time}`
  }, [summaryOutcome, runElapsed, runDoneCount, runSteps.length])

  // ── Transitions ──

  /**
   * End the current narration attempt (Pause, Finish, Cancel, owner Stop, unmount). Joinable:
   * every caller gets the same chunk account. Cancels a pending acquisition synchronously.
   * Main closes the matching sink when it receives this account with Pause/Stop.
   */
  const endNarration = useCallback((): Promise<NarrationReport | undefined> => {
    const attempt = narrationRef.current
    return attempt ? endNarrationAttempt(attempt) : Promise.resolve(undefined)
  }, [])

  const startNarrationCapture = useCallback(async (sessionId: string) => {
    const bridge = window.ghostBridge
    if (!bridge?.narrationStart || !bridge.narrationAppend) return
    const attempt: NarrationAttempt = {
      sessionId,
      cancelled: false,
      recorder: null,
      stream: null,
      chunks: { pending: new Set(), acknowledged: 0, failed: 0 },
      recorderFailed: false,
      settled: false,
      end: null
    }
    // Owned before any await, so Pause/Stop/unmount can cancel a pending acquisition.
    narrationRef.current = attempt
    const live = () => !attempt.cancelled && narrationRef.current === attempt
    try {
      const started = await bridge.narrationStart(sessionId)
      if (!started?.ok || !live()) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      attempt.stream = stream
      // Granted after Pause/Stop: release now and never construct a recorder.
      if (!live()) return
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      const chunks = attempt.chunks
      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return
        // ponytail: one pending promise per 1s chunk; the owned end drains them (bounded).
        const p: Promise<void> = ev.data
          .arrayBuffer()
          .then((buf) => bridge.narrationAppend?.(sessionId, buf))
          .then(
            (r) => {
              if (r?.ok) chunks.acknowledged += 1
              else chunks.failed += 1
            },
            () => {
              chunks.failed += 1
            }
          )
          .finally(() => chunks.pending.delete(p))
        chunks.pending.add(p)
      }
      recorder.onerror = () => {
        // Audio captured so far is no longer verifiable: mark this attempt failed (sticky)
        // and end only this attempt; the non-audio recording continues.
        if (attempt.settled) return
        attempt.recorderFailed = true
        void endNarrationAttempt(attempt)
      }
      attempt.recorder = recorder
      recorder.start(1000)
    } catch {
      // Mic, recorder construction or start failure must not abort the telemetry session.
    } finally {
      // Cancelled, or no running recorder (construction/start threw): no track may stay live.
      if (!live() || attempt.recorder?.state !== 'recording') releaseTracks(attempt)
    }
  }, [])

  // Unmount (reload/close) must never leave a pending grant or live track behind.
  useEffect(() => () => void endNarration(), [endNarration])

  const resetRecording = useCallback(() => {
    setElapsed(0)
    setRecordPaused(false)
    setWatchLog([])
    setWatchExpanded(false)
    telemetrySessionRef.current = null
    setRecordingNotice(null)
    void endNarration()
    narrationRef.current = null
  }, [endNarration])

  /**
   * Open the anchored Record dropdown (M1-HF3): main shows the one reusable child window
   * beside the stationary pill. True only when this open became current UI. `owned` is false
   * once the driver lifetime that started it was cleaned up.
   */
  const runHoverOpen = useCallback(async (owned: () => boolean): Promise<boolean> => {
    if (stateRef.current !== 'idle') return false
    setSavedConfirm(null)
    const ack = await window.ghostBridge?.openDropdown?.()
    if (!ack?.current) return false
    if (!owned()) {
      // This driver lifetime ended (remount/reload) while main was opening: do not leave a
      // dropdown showing that no current pill state owns.
      if (ack.open) void window.ghostBridge?.closeDropdown?.()
      return false
    }
    if (!ack.open) {
      // A neutral, retryable failure — never an endless loading state.
      if (ack.error && ack.error !== 'closed') setRecordingNotice(dropdownFailureNotice())
      return false
    }
    if (stateRef.current !== 'idle') {
      void window.ghostBridge?.closeDropdown?.()
      return false
    }
    if (ack.generation < dropdownClosedGenRef.current) {
      // Main already closed this open (outside focus, Escape, dismissal) before its reply
      // arrived: stay closed and leave the driver closed so the next click opens once.
      hoverDriverRef.current?.request('closed')
      return false
    }
    dropdownGenRef.current = ack.generation
    // Synchronous so the driver sees the new state before deciding its next step.
    flushSync(() => setState('hover'))
    return true
  }, [])

  const runHoverClose = useCallback(async (owned: () => boolean): Promise<boolean> => {
    if (stateRef.current !== 'hover') return false
    await window.ghostBridge?.closeDropdown?.()
    if (!owned()) return false
    flushSync(() => setState((s) => (s === 'hover' ? 'idle' : s)))
    return true
  }, [])

  const runHoverOpenRef = useRef(runHoverOpen)
  runHoverOpenRef.current = runHoverOpen
  const runHoverCloseRef = useRef(runHoverClose)
  runHoverCloseRef.current = runHoverClose
  // Effect-owned (M1-HF2-R1): each effect lifetime gets a fresh driver, so a StrictMode or
  // Fast Refresh cleanup→setup replay never leaves a disposed one in the ref. Its async
  // work is owned only while the ref still points at it.
  const hoverDriverRef = useRef<HoverDriver | null>(null)
  useEffect(() => {
    const driver: HoverDriver = new HoverDriver({
      isOpen: () => stateRef.current === 'hover',
      canRun: () => !draggingRef.current,
      open: () => runHoverOpenRef.current(() => hoverDriverRef.current === driver),
      close: () => runHoverCloseRef.current(() => hoverDriverRef.current === driver)
    })
    hoverDriverRef.current = driver
    return () => {
      driver.dispose()
      if (hoverDriverRef.current === driver) hoverDriverRef.current = null
    }
  }, [])

  // Main closed the dropdown (outside focus, Escape in the child, child failure): follow it.
  // A close older than the latest acknowledged open is stale and ignored.
  useEffect(() => {
    return window.ghostBridge?.onDropdownClosed?.((event) => {
      // Recorded before any state check: an open may still be awaiting its reply.
      dropdownClosedGenRef.current = Math.max(dropdownClosedGenRef.current, event.generation)
      if (event.generation <= dropdownGenRef.current) return
      if (stateRef.current !== 'hover') return
      flushSync(() => setState('idle'))
      hoverDriverRef.current?.request('closed')
      if (event.reason === 'failed') setRecordingNotice(dropdownFailureNotice())
    })
  }, [])

  const openHover = useCallback(() => hoverDriverRef.current?.request('open'), [])
  const closeHover = useCallback(() => hoverDriverRef.current?.request('closed'), [])
  const toggleHover = useCallback(() => hoverDriverRef.current?.toggle(), [])

  const beginDrag = useCallback((): { collapseToPill: boolean } => {
    draggingRef.current = true
    // Keep expanded chrome open while dragging hover / record / editor / run / summary.
    const s = stateRef.current
    const keepOpen =
      s === 'hover' ||
      (s === 'recording' && watchExpandedRef.current) ||
      (s === 'editor' && !editorCollapsedRef.current) ||
      (s === 'running' && !runCollapsedRef.current) ||
      s === 'summary'
    return { collapseToPill: !keepOpen }
  }, [])

  const endDrag = useCallback(() => {
    draggingRef.current = false
    // Open/close requested during the drag runs now, from the dropped position.
    hoverDriverRef.current?.kick()
  }, [])

  const startRecording = useCallback(async () => {
    // Guard: cannot start twice.
    const status = await window.ghostBridge?.getTelemetryStatus?.()
    if (status?.recording) return

    runInFlightRef.current = false
    setSavedConfirm(null)
    resetRecording()

    const wantNarrate = narrate && micGranted
    const result = await window.ghostBridge?.telemetryStart?.({
      recordMode,
      selectedAppId,
      narrate: wantNarrate
    })
    if (!result?.ok) {
      setRecordingNotice({
        tone: 'error',
        title: 'Couldn’t start recording',
        body: result?.error ?? 'Could not start recording',
        sessionId: null,
        action: null
      })
      setState('idle')
      return
    }
    const sessionId = result.status?.sessionId ?? null
    telemetrySessionRef.current = sessionId
    if (wantNarrate && sessionId) {
      void startNarrationCapture(sessionId)
    }
    setRecordPaused(false)
    setState('recording')
  }, [micGranted, narrate, recordMode, resetRecording, selectedAppId, startNarrationCapture])

  const cancelRecording = useCallback(async () => {
    await endNarration()
    const sessionId = telemetrySessionRef.current
    if (sessionId) {
      try {
        await window.ghostBridge?.telemetryStop?.({ sessionId, discard: true })
      } catch {
        /* ignore */
      }
    }
    resetRecording()
    setState('idle')
  }, [endNarration, resetRecording])

  const finishRecording = useCallback(async () => {
    if (stateRef.current === 'organizing') return
    setWatchExpanded(false)
    setState('organizing')
    setRecordingNotice(null)
    const sessionId = telemetrySessionRef.current
    let result: Awaited<ReturnType<NonNullable<typeof window.ghostBridge>['telemetryStop']>> | undefined
    try {
      // Joins a pause-time end: the same account, never a later zeroed one.
      const audio = await endNarration()
      const owned = narrationRef.current?.sessionId === sessionId ? audio : undefined
      result = await window.ghostBridge?.telemetryStop?.({
        sessionId: sessionId ?? undefined,
        audio: owned
      })
    } catch {
      result = undefined
    }
    // Saving finished (or failed): local only, nothing was sent. Keep the id for review.
    setElapsed(0)
    setRecordPaused(false)
    setWatchLog([])
    setWatchExpanded(false)
    telemetrySessionRef.current = null
    setRecordingNotice(noticeForStopResult(result, sessionId))
    setState('idle')
  }, [endNarration])

  /**
   * Pause (M2): release the microphone and await its final chunks first, then ask main to
   * pause; main acknowledges only after every capture source halted. The first pause ends
   * narration for this recording and says so — resume continues without narration until
   * audio alignment exists.
   */
  const toggleRecordPause = useCallback(async () => {
    if (pauseBusyRef.current) return
    pauseBusyRef.current = true
    try {
      const sessionId = telemetrySessionRef.current ?? undefined
      if (recordPaused) {
        const result = await window.ghostBridge?.telemetryResume?.({ sessionId })
        if (result?.ok) setRecordPaused(false)
        return
      }
      // Narration was requested for this session, whether or not the mic was granted yet.
      const attempt = narrationRef.current
      const narrated = !!attempt && attempt.sessionId === sessionId
      const firstEnd = narrated && !attempt.end
      const audio = narrated ? await endNarration() : undefined
      const result = await window.ghostBridge?.telemetryPause?.({ sessionId, audio })
      if (!result?.ok) return
      setRecordPaused(true)
      if (firstEnd) {
        setWatchLog((log) => [
          ...log,
          {
            time: formatElapsed(elapsed),
            text: 'Narration ended at pause. Recording continues without narration after you resume.'
          }
        ])
        setWatchExpanded(true)
      }
    } finally {
      pauseBusyRef.current = false
    }
  }, [elapsed, endNarration, recordPaused])

  // ── Record dropdown (M1-HF3): this provider publishes the view and owns every action ──
  const [dropdownStarting, setDropdownStarting] = useState(false)
  const dropdownRevRef = useRef(0)
  const dropdownBusy = dropdownStarting || (state !== 'idle' && state !== 'hover')
  useEffect(() => {
    window.ghostBridge?.sendDropdownSnapshot?.({
      revision: ++dropdownRevRef.current,
      recordMode,
      selectedAppId,
      narrate,
      apps: MOCK_APPS.map(({ id, name, detail }) => ({ id, name, detail })),
      screenGranted,
      micGranted,
      busy: dropdownBusy
    })
  }, [recordMode, selectedAppId, narrate, screenGranted, micGranted, dropdownBusy])

  // Leaving the open state for another surface (a run, an editor) closes the child; the
  // ordinary close to idle already did.
  const dropdownPrevStateRef = useRef(state)
  useEffect(() => {
    const prev = dropdownPrevStateRef.current
    dropdownPrevStateRef.current = state
    if (prev === 'hover' && state !== 'hover' && state !== 'idle') void window.ghostBridge?.closeDropdown?.()
  }, [state])

  const dropdownActionsRef = useRef({ setRecordMode, setSelectedAppId, setNarrate, startRecording, openScreenRecovery, micGranted, screenGranted })
  dropdownActionsRef.current = { setRecordMode, setSelectedAppId, setNarrate, startRecording, openScreenRecovery, micGranted, screenGranted }
  useEffect(() => {
    // Commands were validated and de-duplicated in main; check again against current state.
    async function startFromDropdown() {
      const a = dropdownActionsRef.current
      // One Start at a time, only from the open dropdown: a stale/replayed Start never
      // produces a second recording.
      if (dropdownStartRef.current || stateRef.current !== 'hover' || !a.screenGranted) return
      dropdownStartRef.current = true
      setDropdownStarting(true)
      try {
        await window.ghostBridge?.closeDropdown?.()
        flushSync(() => setState((s) => (s === 'hover' ? 'idle' : s)))
        hoverDriverRef.current?.request('closed')
        await a.startRecording()
      } finally {
        dropdownStartRef.current = false
        setDropdownStarting(false)
      }
    }
    return window.ghostBridge?.onDropdownCommand?.((cmd) => {
      const a = dropdownActionsRef.current
      switch (cmd.type) {
        case 'setRecordMode':
          if (cmd.value === 'one-app' || cmd.value === 'full-screen') a.setRecordMode(cmd.value)
          return
        case 'selectApp':
          if (MOCK_APPS.some((x) => x.id === cmd.value)) a.setSelectedAppId(cmd.value)
          return
        case 'setNarrate':
          if (a.micGranted && typeof cmd.value === 'boolean') a.setNarrate(cmd.value)
          return
        case 'openScreenSettings':
          a.openScreenRecovery()
          return
        case 'openMicSettings':
          window.ghostBridge?.openPermissionSettings?.('microphone')
          return
        case 'start':
          void startFromDropdown()
          return
      }
    })
  }, [])

  // Main's stop barrier (hide, logout, permission loss, quit) asks this owner to Stop.
  useEffect(() => {
    return window.ghostBridge?.onTelemetryStopRequested?.((req) => {
      if (stateRef.current === 'recording' && telemetrySessionRef.current === req.sessionId) {
        void finishRecording()
      }
    })
  }, [finishRecording])

  // Main-owned status is authoritative: mirror pause, and after a reload show the
  // previous session's save instead of offering a second recording.
  useEffect(() => {
    type Status = Awaited<ReturnType<NonNullable<typeof window.ghostBridge>['getTelemetryStatus']>>
    const apply = (status: Status | undefined) => {
      if (!status?.phase) return
      const mine = !!status.sessionId && status.sessionId === telemetrySessionRef.current
      if (mine) {
        if (status.teardownFailed) {
          // A source did not confirm it stopped: never present this as a clean pause.
          setRecordPaused(false)
          if (teardownNoticeRef.current !== status.sessionId) {
            teardownNoticeRef.current = status.sessionId
            setWatchLog((log) => [
              ...log,
              {
                time: '',
                text: 'An input monitor did not confirm it stopped. Finish to save — this recording will be marked incomplete.'
              }
            ])
            setWatchExpanded(true)
          }
        } else if (status.phase === 'paused') setRecordPaused(true)
        else if (status.phase === 'recording') setRecordPaused(false)
        else if (status.phase === 'idle' && !status.saving && stateRef.current === 'recording') {
          resetRecording()
          setRecordingNotice({
            tone: 'info',
            title: 'Recording stopped',
            body: 'Gray stopped this recording. It is in your Library.',
            sessionId: status.sessionId,
            action: 'library'
          })
          setState('idle')
        }
        return
      }
      if (!telemetrySessionRef.current) {
        // Main lifecycle is busy (Start pending, capture, or an unfinished save): show Saving.
        const busy = status.phase !== 'idle' || !!status.saving || !!status.starting
        if (busy && stateRef.current === 'idle') setState('organizing')
        else if (!busy && stateRef.current === 'organizing') setState('idle')
      }
    }
    void window.ghostBridge?.getTelemetryStatus?.().then(apply)
    return window.ghostBridge?.onTelemetryStatus?.(apply)
  }, [resetRecording])

  const dismissRecordingNotice = useCallback(() => {
    setRecordingNotice(null)
  }, [])

  const runRecordingNoticeAction = useCallback(() => {
    const notice = recordingNotice
    if (!notice?.sessionId || !notice.action) return
    const sessionId = notice.sessionId
    if (notice.action === 'retrySave') {
      void window.ghostBridge?.telemetryRetrySave?.(sessionId).then((r) => {
        setRecordingNotice(noticeForStopResult(r, sessionId))
      })
      return
    }
    // Review Upload / Library both open the saved recording in the workspace.
    setRecordingNotice(null)
    void window.ghostBridge?.openWorkspace?.({ sessionId })
  }, [recordingNotice])

  const cancelEditor = useCallback(() => {
    runInFlightRef.current = false
    setState('idle')
  }, [])

  const beginRun = useCallback((wf: Workflow) => {
    const steps = makeRunSteps(wf)
    const useAutomation = !!wf.sessionId
    automationRunRef.current = useAutomation
    automationVarKeyRef.current = null
    if (steps.length > 0 && !useAutomation) steps[0].status = 'active'
    // Automation: leave all pending until the runner emits stepStarted.
    setWorkflow(wf)
    setRunSteps(steps)
    setRunPaused(false)
    setRunCollapsed(false)
    setRunElapsed(0)
    setSavedConfirm(null)
    const provisionalId = newId('run')
    activeRunRef.current = {
      id: provisionalId,
      workflowId: wf.id,
      startedAt: new Date().toISOString(),
      questionReceipts: []
    }
    holdMirroredRef.current = null
    runPersistedRef.current = false
    setState('running')

    if (useAutomation && wf.sessionId) {
      void window.ghostBridge
        ?.automationRunStart?.({
          sessionId: wf.sessionId,
          recompileIfNeeded: !!wf.automationStale,
          editorSteps: wf.steps.map((s) => ({ index: s.index, title: s.title }))
        })
        .then((result) => {
          if (!result?.ok) {
            automationRunRef.current = false
            setRunSteps((prev) => {
              const next = prev.map((s) => ({ ...s }))
              if (next[0]) {
                next[0].status = 'error'
                next[0].error = {
                  message:
                    result?.error ??
                    'Could not start automation. Accessibility permission may be required.'
                }
              }
              return next
            })
            setRunCollapsed(false)
            return
          }
          if (result.runId && activeRunRef.current) {
            activeRunRef.current.id = result.runId
          }
          if (wf.automationStale) {
            setWorkflow((w) => ({ ...w, automationStale: false }))
          }
        })
    }
  }, [])

  const runWorkflow = useCallback(
    (override?: Workflow) => {
      const wf = override ?? workflow
      if (runInFlightRef.current) {
        runInFlightRef.current = false
        setRunPaused(false)
        setEditorCollapsed(false)
        setState('running')
        if (automationRunRef.current) {
          void window.ghostBridge?.automationRunResume?.()
        }
        return
      }
      // Preflight: automation needs Accessibility; mock runs need Screen.
      if (wf.sessionId) {
        if (permissionsRef.current && permissionsRef.current.accessibility !== 'granted') {
          window.ghostBridge?.openPermissionSettings?.('accessibility')
          setToastArmed(true)
          void computeStake()
          return
        }
      } else if (permissionsRef.current && permissionsRef.current.screen !== 'granted') {
        window.ghostBridge?.openPermissionSettings?.('screen')
        setToastArmed(true)
        void computeStake()
        return
      }
      // Run saves into history first, then runs.
      window.ghostBridge?.upsertWorkflow?.(wf)
      beginRun(wf)
    },
    [beginRun, computeStake, workflow]
  )

  const saveWorkflow = useCallback(() => {
    runInFlightRef.current = false
    window.ghostBridge?.upsertWorkflow?.(workflow)
    setSavedConfirm({ workflowId: workflow.id })
    setState('idle')
  }, [workflow])

  const editFromRunning = useCallback(() => {
    runInFlightRef.current = true
    setRunPaused(true)
    if (automationRunRef.current) {
      void window.ghostBridge?.automationRunPause?.()
    }
    setEditorCollapsed(false)
    setState('editor')
  }, [])

  const toggleRunPause = useCallback(() => {
    setRunPaused((p) => {
      const next = !p
      if (automationRunRef.current) {
        if (next) void window.ghostBridge?.automationRunPause?.()
        else void window.ghostBridge?.automationRunResume?.()
      }
      return next
    })
  }, [])

  const stopRunning = useCallback(() => {
    runInFlightRef.current = false
    if (automationRunRef.current) {
      void window.ghostBridge?.automationRunStop?.()
      automationRunRef.current = false
    }
    if (activeRunRef.current) activeRunRef.current.stopReason = undefined
    setSummaryOutcome('stopped')
    setState('summary')
  }, [])

  const finishSummary = useCallback(() => {
    runInFlightRef.current = false
    activeRunRef.current = null
    holdMirroredRef.current = null
    setState('idle')
  }, [])

  const runAgain = useCallback(() => {
    runInFlightRef.current = false
    runPersistedRef.current = false
    if (activeRunRef.current) activeRunRef.current.stopReason = undefined
    automationRunRef.current = false
    void window.ghostBridge?.automationRunStop?.()
    runWorkflow()
  }, [runWorkflow, workflow.id, workflow.sessionId])

  const runRemaining = useCallback(() => {
    // Mock (no session): resume pending steps in the in-memory timer engine.
    if (!workflow.sessionId) {
      runPersistedRef.current = false
      if (activeRunRef.current) activeRunRef.current.stopReason = undefined
      setRunPaused(false)
      setRunCollapsed(false)
      setState('running')
      return
    }
    // Automation runner is torn down on stop/finish — restart a full run.
    runAgain()
  }, [runAgain, workflow.sessionId])

  // ── Commands from the workspace window / global hotkey ──
  useEffect(() => {
    const offRecord = window.ghostBridge?.onOpenRecordPanel?.(() => {
      openHover()
    })
    const offRun = window.ghostBridge?.onRunWorkflow?.(async (workflowId) => {
      runInFlightRef.current = false
      const fromStore = await window.ghostBridge?.getWorkflow?.(workflowId)
      if (!fromStore) {
        console.warn(`[pill] runWorkflow: workflow ${workflowId} not in store`)
        return
      }
      if (fromStore.sessionId) {
        if (permissionsRef.current && permissionsRef.current.accessibility !== 'granted') {
          window.ghostBridge?.openPermissionSettings?.('accessibility')
          setToastArmed(true)
          void computeStake()
          return
        }
      } else if (permissionsRef.current && permissionsRef.current.screen !== 'granted') {
        window.ghostBridge?.openPermissionSettings?.('screen')
        setToastArmed(true)
        void computeStake()
        return
      }
      beginRun(fromStore)
    })
    const offEditor = window.ghostBridge?.onOpenEditor?.(() => {
      setWorkflow(createMockDraft(newId('draft')))
      setEditorCollapsed(false)
      setState('editor')
    })
    const offReveal = window.ghostBridge?.onRevealRunning?.(() => {
      if (stateRef.current === 'running') {
        setRunCollapsed(false)
      }
    })
    return () => {
      offRecord?.()
      offRun?.()
      offEditor?.()
      offReveal?.()
    }
  }, [beginRun, computeStake, openHover])

  const value: WorkflowContextValue = {
    state,
    recordMode,
    setRecordMode,
    selectedAppId,
    setSelectedAppId,
    narrate,
    setNarrate,
    elapsedLabel: formatElapsed(elapsed),
    recordPaused,
    toggleRecordPause: () => void toggleRecordPause(),
    watchLog,
    watchExpanded,
    setWatchExpanded,
    recordingNotice,
    dismissRecordingNotice,
    runRecordingNoticeAction,
    workflow,
    setWorkflow,
    editorCollapsed,
    setEditorCollapsed,
    savedConfirm,
    openSavedInLibrary,
    dismissSavedConfirm,
    beginDrag,
    endDrag,
    runSteps,
    setRunSteps,
    runPaused,
    runCollapsed,
    setRunCollapsed,
    runElapsedLabel: formatElapsed(runElapsed),
    runDoneCount,
    hasQuestionHold,
    hasErrorHold,
    answerQuestion,
    resolveError,
    skipStep,
    summaryOutcome,
    summaryMeta,
    lastRunId,
    screenGranted,
    micGranted,
    permissionPaused,
    permissionHold,
    permToastVisible,
    permStake,
    permStakeTitle,
    fixPermission,
    dismissPermToast,
    openScreenRecovery,
    openHover,
    closeHover,
    toggleHover,
    startRecording,
    cancelRecording,
    finishRecording,
    cancelEditor,
    runWorkflow,
    saveWorkflow,
    editFromRunning,
    toggleRunPause,
    stopRunning,
    finishSummary,
    runRemaining,
    runAgain
  }

  return <WorkflowContext.Provider value={value}>{children}</WorkflowContext.Provider>
}

export function useWorkflow(): WorkflowContextValue {
  const ctx = useContext(WorkflowContext)
  if (!ctx) throw new Error('useWorkflow must be used within WorkflowProvider')
  return ctx
}

function mapAppName(name?: string): StepApp | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  if (lower.includes('figma')) return { id: 'figma', name: 'Figma' }
  if (lower.includes('chrome') || lower.includes('chromium')) return { id: 'chrome', name: 'Chrome' }
  if (lower.includes('slack')) return { id: 'slack', name: 'Slack' }
  if (lower.includes('finder')) return { id: 'finder', name: 'Finder' }
  if (lower.includes('mail')) return { id: 'mail', name: 'Mail' }
  return undefined
}
