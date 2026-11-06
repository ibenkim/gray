import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import type { RunStep } from '../../state/types'
import AppChip from '../shared/AppChip'
import RunCard from '../shared/RunCard'
import { useWindowDrag } from '../../hooks/useWindowDrag'
import RailCell, { type WorkflowRailState } from '../shared/RailCell'
import RichText from '../shared/RichText'

/**
 * 6.2 — running (Figma: Run panel · running-expanded · Hero · Run paused). An ink bar marks
 * the step Gray is on and slides to the next one (0.36s in-out); finished steps fade to gray
 * with a drawn-on check; hovering a later step offers Skip. Questions and failures hold the
 * run at the active step (6.3 / 6.4). The pill below shows the fluid mark and the clock.
 */
export default function RunningPanel() {
  const {
    workflow,
    runSteps,
    runDoneCount,
    runPaused,
    skipStep,
    answerQuestion,
    resolveError,
    stopRunning,
    editFromRunning,
    permissionHold,
    fixPermission,
    setRunCollapsed
  } = useWorkflow()
  const { onMouseDown: onDragMouseDown } = useWindowDrag()
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const [bar, setBar] = useState<{ top: number; height: number } | null>(null)

  // Esc folds the run into the pill (it keeps running).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement
      if (e.key === 'Escape' && t.tagName !== 'INPUT') setRunCollapsed(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setRunCollapsed])

  const currentIdx = runSteps.findIndex((s) => s.status === 'active')
  const current = currentIdx >= 0 ? runSteps[currentIdx] : null
  const holdIdx = runSteps.findIndex(isHolding)

  // The bar follows the active row (position + height), measured after layout.
  useLayoutEffect(() => {
    const el = current ? rowRefs.current.get(current.id) : null
    if (!el) {
      setBar(null)
      return
    }
    const next = { top: el.offsetTop, height: el.offsetHeight }
    setBar((b) => (b && b.top === next.top && b.height === next.height ? b : next))
  })

  return (
    <div className="running-panel" onMouseDown={onDragMouseDown}>
      <div className="run-head">
        <span className="run-title">{workflow.name}</span>
        <span className="run-count" aria-label={`${runDoneCount} of ${runSteps.length} done`}>
          <span className="run-count-tick" key={runDoneCount}>
            {runDoneCount}/{runSteps.length}
          </span>
        </span>
      </div>

      <div className="run-steps">
        {bar && (
          <span
            className={`run-current-bar ${runPaused ? 'run-current-bar-paused' : ''}`}
            style={{ transform: `translateY(${bar.top}px)`, height: bar.height }}
            aria-hidden="true"
          />
        )}
        {permissionHold && (
          <RunCard
            variant="question"
            title="Paused — needs permission"
            message="A permission Gray needs was turned off mid-run. Turn it back on and the run picks up where it stopped."
            chips={[{ id: 'fix', label: 'Fix in System Settings' }]}
            onSelect={fixPermission}
            leading={false}
            trailing={runSteps.length > 0}
          />
        )}
        {runSteps.map((step, i) => (
          <RunStepRow
            key={step.id}
            step={step}
            runPaused={runPaused}
            leading={i > 0}
            trailing={i < runSteps.length - 1}
            railState={railStateFor(step, i, holdIdx)}
            rowRef={(el) => {
              if (el) rowRefs.current.set(step.id, el)
              else rowRefs.current.delete(step.id)
            }}
            onSkip={() => skipStep(step.id)}
            onAnswer={(optionId, custom) => answerQuestion(step.id, optionId, custom)}
            onResolveError={(action) => resolveError(step.id, action)}
          />
        ))}
      </div>

      <div className="run-footer" onMouseDown={(e) => e.stopPropagation()}>
        <button className="btn btn-quiet" onClick={stopRunning}>
          Stop
        </button>
        <button className="btn btn-secondary" onClick={editFromRunning}>
          Edit
        </button>
      </div>
    </div>
  )
}

function isHolding(s: RunStep) {
  return (
    (s.status === 'question' && !!s.question && s.question.answerId === null) ||
    (s.status === 'error' && !!s.error && !s.error.takenOver)
  )
}

function railStateFor(step: RunStep, i: number, holdIdx: number): WorkflowRailState {
  if (step.status === 'active') return 'current'
  if (step.status === 'done' || step.status === 'skipped') {
    return holdIdx === i + 1 ? 'before-forming' : 'muted'
  }
  if (holdIdx >= 0 && holdIdx === i - 1) return 'after-forming'
  return 'formed'
}

function RunStepRow({
  step,
  runPaused,
  leading,
  trailing,
  railState,
  rowRef,
  onSkip,
  onAnswer,
  onResolveError
}: {
  step: RunStep
  runPaused: boolean
  leading: boolean
  trailing: boolean
  railState: WorkflowRailState
  rowRef: (el: HTMLElement | null) => void
  onSkip: () => void
  onAnswer: (optionId: string, custom?: string) => void
  onResolveError: (action: 'retry' | 'skip' | 'takeover') => void
}) {
  const [hovered, setHovered] = useState(false)

  if (step.status === 'question' && step.question && step.question.answerId === null) {
    return (
      <div ref={rowRef}>
        <RunCard
          variant="question"
          title={step.label}
          message={step.question.prompt}
          chips={step.question.options}
          onSelect={onAnswer}
          leading={leading}
          trailing={trailing}
        />
      </div>
    )
  }

  if (step.status === 'error' && step.error && !step.error.takenOver) {
    return (
      <div ref={rowRef}>
        <RunCard
          variant="error"
          title="Couldn’t continue"
          message={step.error.message}
          chips={[
            { id: 'retry', label: 'Retry' },
            { id: 'skip', label: 'Skip step' },
            { id: 'takeover', label: 'Take over' }
          ]}
          onSelect={(id) => {
            if (id === 'retry') onResolveError('retry')
            else if (id === 'skip') onResolveError('skip')
            else onResolveError('takeover')
          }}
          leading={leading}
          trailing={trailing}
        />
      </div>
    )
  }

  const isCurrent = step.status === 'active'
  const isDone = step.status === 'done'
  const isSkipped = step.status === 'skipped'
  const pending = !isCurrent && !isDone && !isSkipped
  const hasVoice = !!step.voiceNote

  return (
    <div
      ref={rowRef}
      className={[
        'run-step',
        hasVoice ? 'run-step-voice' : '',
        isCurrent ? 'run-step-current' : '',
        isDone || isSkipped ? 'run-step-past' : '',
        pending && hovered ? 'run-step-hover' : ''
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <RailCell
        anchor={hasVoice ? 'voice' : 'running'}
        state={railState}
        dim={isDone || isSkipped}
        leading={leading}
        trailing={trailing}
      />
      <div className="run-step-body">
        <div className="run-step-line">
          <span className="run-step-label">
            <RichText text={isDone ? step.doneLabel : step.label} />
            {step.app && <AppChip app={step.app} />}
          </span>
          {isDone && <DrawnCheck />}
          {isSkipped && <span className="run-skipped-mark">Skipped</span>}
          {pending && hovered && (
            <button
              className="run-skip"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={onSkip}
            >
              Skip
            </button>
          )}
        </div>
        {isCurrent && runPaused && <span className="run-step-sub">Paused — press play on the pill to continue</span>}
        {hasVoice && <span className="run-voice-quote">{stripQuotes(step.voiceNote!.text)}</span>}
      </div>
    </div>
  )
}

/** Check that draws itself on (Run "Vector" stroke-dasharray). */
function DrawnCheck() {
  return (
    <span className="run-check" aria-label="Done">
      <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
        <path d="M0.35 3.35L3.35 6.35L9.35 0.35" pathLength={1} />
      </svg>
    </span>
  )
}

function stripQuotes(text: string): string {
  return text.replace(/[“”"]/g, '').replace(/^\.{3}|^…/, '')
}
