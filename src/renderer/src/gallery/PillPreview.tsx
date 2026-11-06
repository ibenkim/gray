import { useEffect, useMemo, useState } from 'react'
import GrayShell from '../components/GrayShell'
import {
  PILL_H,
  PILL_WIDTH,
  SUMMARY_W,
  SURFACE_SIZE,
  panelWindowSize,
  pillKindFor,
  surfaceFor,
  type SurfaceKind
} from '../components/pillLayout'
import { WorkflowContextForPreview, type WorkflowContextValue } from '../state/WorkflowContext'
import type { RunStep, Workflow } from '../../../shared/types'
import { BRIEFING, LEDGER } from './sampleData'

const noop = () => {}

/** This frame's scenario id; the gallery page owns the Record dropdown "window". */
const SCENARIO_ID = new URLSearchParams(location.search).get('s')
const postDropdown = (msg: Record<string, unknown>) =>
  window.parent !== window && window.parent.postMessage({ gallery: 'dropdown', id: SCENARIO_ID, ...msg }, '*')

export type PillSeed = Partial<WorkflowContextValue> & {
  /** Append ledger rows on a timer (shows the rise motion). */
  liveLedger?: boolean
  /** Advance the active run step on a timer (shows the sliding bar). */
  liveRun?: boolean
}

function holdFlags(steps: RunStep[]) {
  return {
    hasQuestionHold: steps.some((s) => s.status === 'question' && s.question?.answerId === null),
    hasErrorHold: steps.some((s) => s.status === 'error' && !s.error?.takenOver)
  }
}

/**
 * A pill-window scenario rendered against a fixed (but locally interactive) context: choices,
 * collapses and run progress update local state so motion can be exercised; window bounds are
 * computed with the app's own layout rules and reported to the gallery frame.
 */
export default function PillPreview({ seed, onBounds }: { seed: PillSeed; onBounds: (w: number, h: number) => void }) {
  const [workflow, setWorkflow] = useState<Workflow>(seed.workflow ?? BRIEFING)
  const [runSteps, setRunSteps] = useState<RunStep[]>(seed.runSteps ?? [])
  const [watchExpanded, setWatchExpanded] = useState(seed.watchExpanded ?? false)
  const [editorCollapsed, setEditorCollapsed] = useState(seed.editorCollapsed ?? false)
  const [runCollapsed, setRunCollapsed] = useState(seed.runCollapsed ?? false)
  const [recordPaused, setRecordPaused] = useState(seed.recordPaused ?? false)
  const [runPaused, setRunPaused] = useState(seed.runPaused ?? false)
  const [watchLog, setWatchLog] = useState(seed.watchLog ?? LEDGER.slice(0, 3))
  const [measure, setMeasure] = useState<{ key: SurfaceKind; h: number } | null>(null)
  /** The Record dropdown is open over this pill (idle → hover, as in the app). */
  const [dropdownOpen, setDropdownOpen] = useState(false)

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.gallery === 'dropdown-state') setDropdownOpen(e.data.id === SCENARIO_ID)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Live ledger: one understood action every 1.6s, then start over.
  useEffect(() => {
    if (!seed.liveLedger) return
    const t = setInterval(() => {
      setWatchLog((log) => (log.length >= LEDGER.length ? LEDGER.slice(0, 1) : LEDGER.slice(0, log.length + 1)))
    }, 1600)
    return () => clearInterval(t)
  }, [seed.liveLedger])

  // Live run: advance the active step every 1.8s (pauses respected), loop at the end.
  useEffect(() => {
    if (!seed.liveRun || runPaused) return
    const t = setInterval(() => {
      setRunSteps((steps) => {
        const i = steps.findIndex((s) => s.status === 'active')
        if (i < 0) return steps.map((s, j) => ({ ...s, status: j === 0 ? 'active' : 'pending' }))
        return steps.map((s, j) =>
          j === i ? { ...s, status: 'done' } : j === i + 1 ? { ...s, status: 'active' } : s
        )
      })
    }, 1800)
    return () => clearInterval(t)
  }, [seed.liveRun, runPaused])

  const seedState = seed.state ?? 'idle'
  const state = seedState === 'idle' && dropdownOpen ? 'hover' : seedState
  const flags = holdFlags(runSteps)
  const ctx: WorkflowContextValue = useMemo(
    () => ({
      state,
      recordMode: 'one-app',
      setRecordMode: noop,
      selectedAppId: 'notion',
      selectedAppIds: ['notion'],
      setSelectedAppId: noop,
      toggleSelectedApp: noop,
      narrate: true,
      setNarrate: noop,
      elapsedLabel: seed.elapsedLabel ?? '0:26',
      recordPaused,
      toggleRecordPause: () => setRecordPaused((p) => !p),
      watchLog,
      watchExpanded,
      setWatchExpanded,
      recordingNotice: seed.recordingNotice ?? null,
      dismissRecordingNotice: noop,
      runRecordingNoticeAction: noop,
      workflow,
      setWorkflow,
      editorCollapsed,
      setEditorCollapsed,
      savedConfirm: seed.savedConfirm ?? null,
      openSavedInLibrary: noop,
      dismissSavedConfirm: noop,
      beginDrag: () => ({ collapseToPill: false }),
      endDrag: noop,
      placement: seed.placement ?? 'above',
      reportSurfaceHeight: (key, h) =>
        setMeasure((m) => (m && m.key === key && m.h === h ? m : { key, h })),
      runSteps,
      setRunSteps,
      runPaused,
      runCollapsed,
      setRunCollapsed,
      runElapsedLabel: seed.runElapsedLabel ?? '0:49',
      runDoneCount: runSteps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
      ...flags,
      answerQuestion: (stepId, optionId) =>
        setRunSteps((steps) =>
          steps.map((s) =>
            s.id === stepId && s.question
              ? { ...s, status: 'active', question: { ...s.question, answerId: optionId } }
              : s
          )
        ),
      resolveError: (stepId) =>
        setRunSteps((steps) =>
          steps.map((s) => (s.id === stepId ? { ...s, status: 'active', error: undefined } : s))
        ),
      skipStep: (stepId) =>
        setRunSteps((steps) => steps.map((s) => (s.id === stepId ? { ...s, status: 'skipped' } : s))),
      summaryOutcome: seed.summaryOutcome ?? 'done',
      summaryMeta: seed.summaryMeta ?? 'Done · 5 of 5 · 1:12',
      lastRunId: null,
      screenGranted: true,
      micGranted: true,
      permissionPaused: seed.permissionPaused ?? false,
      permissionHold: seed.permissionHold ?? false,
      permToastVisible: seed.permToastVisible ?? false,
      permStake: seed.permStake ?? '',
      permStakeTitle: seed.permStakeTitle ?? '',
      fixPermission: noop,
      dismissPermToast: noop,
      openScreenRecovery: noop,
      openHover: () => postDropdown({ open: true }),
      closeHover: () => postDropdown({ open: false }),
      toggleHover: () => postDropdown({ toggle: true }),
      startRecording: noop,
      cancelRecording: noop,
      finishRecording: noop,
      cancelEditor: noop,
      runWorkflow: noop,
      saveWorkflow: noop,
      editFromRunning: noop,
      toggleRunPause: () => setRunPaused((p) => !p),
      stopRunning: noop,
      finishSummary: noop,
      runRemaining: noop,
      runAgain: noop
    }),
    [state, seed, recordPaused, watchLog, watchExpanded, workflow, editorCollapsed, runSteps, runPaused, runCollapsed, flags]
  )

  // Same window rules as the provider (pillLayout), reported to the gallery frame.
  useEffect(() => {
    const toast = !!ctx.permToastVisible || (!!ctx.recordingNotice && state === 'idle')
    const surface = surfaceFor({ state, watchExpanded, editorCollapsed, runCollapsed, toast })
    const kind = pillKindFor({
      state,
      recordPaused,
      hasErrorHold: flags.hasErrorHold,
      hasQuestionHold: flags.hasQuestionHold,
      permissionHold: !!ctx.permissionHold,
      permissionPaused: !!ctx.permissionPaused,
      savedConfirm: !!ctx.savedConfirm,
      summaryDone: ctx.summaryOutcome === 'done'
    })
    if (!surface) {
      onBounds(PILL_WIDTH[kind], PILL_H)
      return
    }
    const cardW = surface === 'run' && state === 'summary' ? SUMMARY_W : SURFACE_SIZE[surface].w
    const cardH = measure && measure.key === surface ? measure.h : SURFACE_SIZE[surface].h
    const { w, h } = panelWindowSize(cardW, cardH, PILL_WIDTH[kind])
    onBounds(w, h)
  }, [ctx, state, watchExpanded, editorCollapsed, runCollapsed, recordPaused, flags, measure, onBounds])

  return (
    <WorkflowContextForPreview.Provider value={ctx}>
      <GrayShell />
    </WorkflowContextForPreview.Provider>
  )
}
