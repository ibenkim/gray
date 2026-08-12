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
import type { ExtractedWorkflow, TelemetryEvent } from '../../../shared/telemetry/schema'
import { createMockDraft, makeRunSteps } from './mockData'

/**
 * Ensure review fields from ExtractedWorkflow stay on the editor Workflow
 * even if an older main process omitted them from toEditorWorkflow.
 */
function applyExtractedReview(
  workflow: Workflow,
  extracted: ExtractedWorkflow | undefined,
  sessionId?: string | null
): Workflow {
  const base: Workflow = {
    ...workflow,
    sessionId: workflow.sessionId ?? sessionId ?? undefined,
    hoursReturned: workflow.hoursReturned ?? '≈ 0 h returned total',
    automationStale: false,
    contractAccepted: workflow.contractAccepted ?? false
  }
  if (!extracted) return base

  const destinations = [
    ...new Set([
      ...(extracted.authorizationScope?.destinations ?? []),
      ...(extracted.addresses ?? []).map((a) => a.id)
    ])
  ]
  const hasContract =
    (extracted.inputs?.length ?? 0) > 0 ||
    (extracted.writes?.length ?? 0) > 0 ||
    (extracted.commits?.length ?? 0) > 0 ||
    destinations.length > 0 ||
    !!extracted.authorizationScope

  return {
    ...base,
    summary: base.summary ?? extracted.summary,
    goal: base.goal ?? extracted.goal ?? undefined,
    questions:
      base.questions ??
      (extracted.questions?.length
        ? extracted.questions.map((q) => ({
            id: q.id,
            prompt: q.prompt,
            relatedStepId: q.relatedStepId,
            kind: q.kind
          }))
        : undefined),
    runContract:
      base.runContract ??
      (hasContract
        ? {
            inputs: extracted.inputs ?? [],
            writes: extracted.writes ?? [],
            commits: extracted.commits ?? [],
            destinations,
            authorizationLevel: extracted.authorizationScope?.level,
            authorizationExpires: extracted.authorizationScope?.expires ?? null
          }
        : undefined)
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
/** Stable record-panel height (Figma ~277–293). Never open glass shorter than this. */
const HOVER_PANEL_H = 289
/** Reject clipped measures from close/morph — 81px poisoned the next open to h=113. */
const HOVER_PANEL_MEASURE_MIN = 200

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
  /** Set when organize/extract fails after Finish. */
  organizeError: string | null
  /** Session id preserved so summarization can be retried without re-recording. */
  lastTelemetrySessionId: string | null
  dismissOrganizeError: () => void
  retryOrganize: () => Promise<void>
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
  panelPlacement: 'above' | 'below'
  /** True while the hover panel is morphing/fading out. */
  hoverFading: boolean
  /** How the hover panel is dismissing — morph back into the pill, or quick drag. */
  hoverDismissMode: 'morph' | 'drag' | null
  /** Measured hover-panel height so the glass window hugs its content. */
  reportHoverPanelHeight: (h: number) => void
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
  const [organizeError, setOrganizeError] = useState<string | null>(null)
  const [lastTelemetrySessionId, setLastTelemetrySessionId] = useState<string | null>(null)
  const telemetrySessionRef = useRef<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const narrationSessionRef = useRef<string | null>(null)

  const [workflow, setWorkflow] = useState<Workflow>(() => createMockDraft(newId('draft')))
  const [editorCollapsed, setEditorCollapsed] = useState(false)
  const editorCollapsedRef = useRef(editorCollapsed)
  editorCollapsedRef.current = editorCollapsed
  const [savedConfirm, setSavedConfirm] = useState<SavedConfirm | null>(null)

  const [panelPlacement, setPanelPlacement] = useState<'above' | 'below'>('above')
  const [hoverFading, setHoverFading] = useState(false)
  const [hoverDismissMode, setHoverDismissMode] = useState<'morph' | 'drag' | null>(null)
  /** Last known full record-panel height (never a clipped close-frame measure). */
  const [hoverPanelH, setHoverPanelH] = useState(HOVER_PANEL_H)
  const hoverPanelHRef = useRef(HOVER_PANEL_H)
  hoverPanelHRef.current = hoverPanelH
  /** While true, hover must not open — dragging and hovering are exclusive. */
  const draggingRef = useRef(false)
  /** Prevents double-triggering morph-out / drag dismiss. */
  const hoverClosingRef = useRef(false)
  const prevStateRef = useRef<AppState>(state)
  /** True while the glass open ease is running — ignore height churn mid-anim. */
  const hoverOpenAnimRef = useRef(false)
  const pendingHoverHRef = useRef<number | null>(null)
  const openAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    const glassPanelH = Math.max(hoverPanelH, HOVER_PANEL_H)
    const idleSize: Size = savedConfirm
      ? { w: 210, h: 24, mode: 'pill' }
      : permToastVisible || !!organizeError
        ? { w: 392, h: 232, mode: 'panel' }
        : permissionPaused
          ? { w: 224, h: 24, mode: 'pill' }
          : { w: 94, h: 24, mode: 'pill' }
    const sizes: Record<AppState, Size> = {
      idle: idleSize,
      hover: { w: 266, h: glassPanelH + 8 + 24, mode: 'glass' },
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
    if (hoverClosingRef.current && state === 'hover') return
    const isOpenTransition = prev === 'idle' && state === 'hover'
    if (state === 'hover' && !isOpenTransition && hoverOpenAnimRef.current) {
      return
    }
    const durationMs = isOpenTransition ? 420 : 0
    const pillDrive = isOpenTransition
    if (isOpenTransition) {
      hoverOpenAnimRef.current = true
      if (openAnimTimerRef.current) clearTimeout(openAnimTimerRef.current)
      openAnimTimerRef.current = setTimeout(() => {
        hoverOpenAnimRef.current = false
        openAnimTimerRef.current = null
        const pending = pendingHoverHRef.current
        pendingHoverHRef.current = null
        if (pending != null) {
          setHoverPanelH((prevH) => (prevH === pending ? prevH : pending))
        }
      }, 440)
    }
    window.ghostBridge
      ?.setBounds?.(w, h, mode, { durationMs, pillDrive, center })
      ?.then((placement) => {
        if (placement) setPanelPlacement(placement)
      })
  }, [
    state,
    watchExpanded,
    editorCollapsed,
    runCollapsed,
    savedConfirm,
    hoverPanelH,
    permToastVisible,
    permissionPaused,
    organizeError
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

  const stopNarrationCapture = useCallback(async () => {
    const recorder = mediaRecorderRef.current
    mediaRecorderRef.current = null
    const stream = mediaStreamRef.current
    mediaStreamRef.current = null
    narrationSessionRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        try {
          recorder.stop()
        } catch {
          resolve()
        }
      })
    }
    stream?.getTracks().forEach((t) => t.stop())
    try {
      await window.ghostBridge?.narrationStop?.()
    } catch {
      /* ignore */
    }
  }, [])

  const startNarrationCapture = useCallback(async (sessionId: string) => {
    const bridge = window.ghostBridge
    if (!bridge?.narrationStart || !bridge.narrationAppend) return
    try {
      const started = await bridge.narrationStart(sessionId)
      if (!started?.ok) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : ''
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream)
      recorder.ondataavailable = (ev) => {
        if (!ev.data || ev.data.size === 0) return
        void ev.data
          .arrayBuffer()
          .then((buf) => bridge.narrationAppend?.(sessionId, buf))
          .catch(() => {
            /* drop chunk */
          })
      }
      recorder.onerror = () => {
        /* continue session without narration */
      }
      mediaStreamRef.current = stream
      mediaRecorderRef.current = recorder
      narrationSessionRef.current = sessionId
      recorder.start(1000)
    } catch {
      // Mic failure must not abort the telemetry session.
      try {
        await bridge.narrationStop?.()
      } catch {
        /* ignore */
      }
    }
  }, [])

  const resetRecording = useCallback(() => {
    setElapsed(0)
    setRecordPaused(false)
    setWatchLog([])
    setWatchExpanded(false)
    telemetrySessionRef.current = null
    setOrganizeError(null)
    void stopNarrationCapture()
  }, [stopNarrationCapture])

  const openHover = useCallback(() => {
    if (draggingRef.current || hoverClosingRef.current) return
    setSavedConfirm(null)
    setHoverFading(false)
    setHoverDismissMode(null)
    pendingHoverHRef.current = null
    if (hoverPanelHRef.current < HOVER_PANEL_MEASURE_MIN) {
      setHoverPanelH(HOVER_PANEL_H)
    }
    setState((s) => (s === 'idle' ? 'hover' : s))
  }, [])

  const reportHoverPanelHeight = useCallback((h: number) => {
    const next = Math.round(h)
    if (hoverClosingRef.current || stateRef.current !== 'hover') return
    if (next < HOVER_PANEL_MEASURE_MIN) return
    if (hoverOpenAnimRef.current) {
      pendingHoverHRef.current = next
      return
    }
    setHoverPanelH((prev) => (Math.abs(prev - next) <= 2 ? prev : next))
  }, [])

  const closeHover = useCallback(() => {
    if (stateRef.current !== 'hover' || hoverClosingRef.current) return
    hoverClosingRef.current = true
    pendingHoverHRef.current = null
    setHoverDismissMode('morph')
    setHoverFading(true)
    // Stay in glass CSS until bounds finish — idle + width:100% mid-anim
    // was stretching the pill to the shrinking window (pillW≠94).
    void window.ghostBridge
      ?.setBounds?.(94, 24, 'pill', {
        durationMs: 400,
        pillDrive: true
      })
      ?.then(() => {
        setHoverFading(false)
        setHoverDismissMode(null)
        hoverClosingRef.current = false
        setState((s) => (s === 'hover' ? 'idle' : s))
      })
  }, [])

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
      setOrganizeError(result?.error ?? 'Could not start recording')
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
    await stopNarrationCapture()
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
  }, [resetRecording, stopNarrationCapture])

  const finishRecording = useCallback(async () => {
    setWatchExpanded(false)
    setState('organizing')
    setOrganizeError(null)
    await stopNarrationCapture()
    const sessionId = telemetrySessionRef.current ?? undefined
    const result = await window.ghostBridge?.telemetryStop?.(
      sessionId ? { sessionId } : undefined
    )
    if (!result?.ok || !result.workflow) {
      const sid = result?.sessionId ?? sessionId ?? null
      if (sid) setLastTelemetrySessionId(sid)
      setOrganizeError(
        result?.error ??
          'Workflow processing is unavailable because the OpenAI API configuration is invalid.'
      )
      setState('idle')
      resetRecording()
      return
    }
    setLastTelemetrySessionId(null)
    setWorkflow(applyExtractedReview(result.workflow, result.extracted, result.sessionId))
    setEditorCollapsed(false)
    resetRecording()
    setState('editor')
  }, [resetRecording, stopNarrationCapture])

  const dismissOrganizeError = useCallback(() => {
    setOrganizeError(null)
  }, [])

  const retryOrganize = useCallback(async () => {
    const sessionId = lastTelemetrySessionId
    if (!sessionId) return
    setOrganizeError(null)
    setState('organizing')
    const result = await window.ghostBridge?.telemetryProcessWorkflow?.(sessionId)
    if (!result?.ok || !result.workflow) {
      setOrganizeError(
        result?.error ??
          'Workflow processing is unavailable because the OpenAI API configuration is invalid.'
      )
      setState('idle')
      return
    }
    setLastTelemetrySessionId(null)
    setWorkflow(applyExtractedReview(result.workflow, result.extracted, sessionId))
    setEditorCollapsed(false)
    setState('editor')
  }, [lastTelemetrySessionId])

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

  const runRemaining = useCallback(() => {
    runPersistedRef.current = false
    if (activeRunRef.current) activeRunRef.current.stopReason = undefined
    setRunPaused(false)
    setRunCollapsed(false)
    setState('running')
  }, [])

  // ── Commands from the workspace window / global hotkey ──
  useEffect(() => {
    const offRecord = window.ghostBridge?.onOpenRecordPanel?.(() => {
      setSavedConfirm(null)
      setState((s) => (s === 'idle' || s === 'hover' ? 'hover' : s))
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
    const offWorkflowReady = window.ghostBridge?.onTelemetryWorkflowReady?.(
      (payload) => {
        setLastTelemetrySessionId(null)
        setOrganizeError(null)
        setWorkflow(applyExtractedReview(payload.workflow, payload.extracted, payload.sessionId))
        setEditorCollapsed(false)
        setState('editor')
      }
    )
    return () => {
      offRecord?.()
      offRun?.()
      offEditor?.()
      offReveal?.()
      offWorkflowReady?.()
    }
  }, [beginRun, computeStake])

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
    toggleRecordPause: () => {
      void (async () => {
        if (recordPaused) {
          const result = await window.ghostBridge?.telemetryResume?.()
          if (result?.ok) setRecordPaused(false)
        } else {
          const result = await window.ghostBridge?.telemetryPause?.()
          if (result?.ok) setRecordPaused(true)
        }
      })()
    },
    watchLog,
    watchExpanded,
    setWatchExpanded,
    organizeError,
    lastTelemetrySessionId,
    dismissOrganizeError,
    retryOrganize,
    workflow,
    setWorkflow,
    editorCollapsed,
    setEditorCollapsed,
    savedConfirm,
    openSavedInLibrary,
    dismissSavedConfirm,
    panelPlacement,
    hoverFading,
    hoverDismissMode,
    reportHoverPanelHeight,
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
    runRemaining
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
