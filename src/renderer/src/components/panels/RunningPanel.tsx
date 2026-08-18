import { useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import type { RunStep } from '../../state/types'
import AppChip from '../shared/AppChip'
import RunCard from '../shared/RunCard'
import { PauseButton, ChevronDown } from '../GhostPill'
import { useWindowDrag } from '../../hooks/useWindowDrag'
import RailCell from '../shared/RailCell'

/**
 * 6.2 — running expanded: flat single-workflow ledger mirroring the editor.
 * Pause lives only in the header icon; footer is Stop · Edit.
 * 6.3 / 6.4 — inline run-card holds at the active step.
 */
export default function RunningPanel() {
  const {
    workflow,
    runSteps,
    runDoneCount,
    runPaused,
    toggleRunPause,
    runElapsedLabel,
    setRunCollapsed,
    skipStep,
    answerQuestion,
    resolveError,
    stopRunning,
    editFromRunning,
    hasQuestionHold,
    hasErrorHold,
    permissionHold,
    fixPermission
  } = useWorkflow()
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  const holdSuffix = permissionHold
    ? ' · needs permission'
    : hasErrorHold
      ? ' · needs help'
      : hasQuestionHold
        ? ' · needs an answer'
        : ''

  return (
    <div
      className={`running-panel ${hasErrorHold ? 'running-panel-rose' : ''} ${
        hasQuestionHold || permissionHold ? 'running-panel-amber' : ''
      }`}
    >
      <div className="ledger-header" onMouseDown={onDragMouseDown}>
        <PauseButton paused={runPaused} onToggle={toggleRunPause} />
        <span className="ledger-title">
          {workflow.name}{' '}
          <span className="pill-dim">
            · {runDoneCount}/{runSteps.length}
            {holdSuffix}
          </span>
        </span>
        <span className="ledger-time">{runElapsedLabel}</span>
        <button
          className="chevron-btn"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setRunCollapsed(true)}
          title="Collapse"
        >
          <ChevronDown />
        </button>
      </div>

      <div className="run-steps scroll">
        {permissionHold && (
          <div className="run-card run-card-question">
            <div className="run-card-title">Paused — needs permission</div>
            <div className="run-card-message">
              A permission yuh needs was turned off mid-run. Turn it back on and the run resumes
              automatically.
            </div>
            <div className="fix-options">
              <button className="fix-option" onClick={fixPermission}>
                Fix in System Settings
              </button>
            </div>
            <div className="run-card-footer">
              Run is holding — turning it back on resumes automatically
            </div>
          </div>
        )}
        {runSteps.map((step, i) => (
          <RunStepRow
            key={step.id}
            step={step}
            runPaused={runPaused}
            leading={i > 0}
            trailing={i < runSteps.length - 1}
            onSkip={() => skipStep(step.id)}
            onAnswer={(optionId, custom) => answerQuestion(step.id, optionId, custom)}
            onResolveError={(action) => resolveError(step.id, action)}
          />
        ))}
      </div>

      <div className="ledger-footer window-actions">
        <button className="btn btn-danger" onClick={stopRunning}>
          Stop
        </button>
        <button className="btn btn-secondary" onClick={editFromRunning}>
          Edit
        </button>
      </div>
    </div>
  )
}

function RunStepRow({
  step,
  runPaused,
  leading,
  trailing,
  onSkip,
  onAnswer,
  onResolveError
}: {
  step: RunStep
  runPaused: boolean
  leading: boolean
  trailing: boolean
  onSkip: () => void
  onAnswer: (optionId: string, custom?: string) => void
  onResolveError: (action: 'retry' | 'skip' | 'takeover') => void
}) {
  const [hovered, setHovered] = useState(false)

  if (step.status === 'question' && step.question && step.question.answerId === null) {
    return (
      <div className="step-rail-row">
        <RailCell anchor="decision" state="forming" leading={leading} trailing={trailing} />
        <RunCard
          variant="question"
          title={`${step.index} · ${step.label}`}
          message={step.question.prompt}
          chips={step.question.options}
          footer="Run is holding — answering resumes automatically"
          onSelect={onAnswer}
        />
      </div>
    )
  }

  if (step.status === 'error' && step.error && !step.error.takenOver) {
    return (
      <div className="step-rail-row">
        <RailCell anchor="decision" state="forming" leading={leading} trailing={trailing} />
        <RunCard
          variant="error"
          title={`${step.index} · ${step.label}`}
          message={step.error.message}
          chips={[
            { id: 'retry', label: 'Retry' },
            { id: 'skip', label: 'Skip step' },
            { id: 'takeover', label: 'Take over' }
          ]}
          footer="Held for 10 min — then the run stops and is logged"
          onSelect={(id) => {
            if (id === 'retry') onResolveError('retry')
            else if (id === 'skip') onResolveError('skip')
            else onResolveError('takeover')
          }}
        />
      </div>
    )
  }

  const isCurrent = step.status === 'active'
  const isDone = step.status === 'done'
  const isSkipped = step.status === 'skipped'
  const notDone = !isDone && !isSkipped
  const showSkip = notDone && hovered
  const railState = isCurrent ? 'current' : isDone || isSkipped ? 'muted' : 'formed'
  const hasVoice = isDone && !!step.voiceNote

  return (
    <div
      className={`run-step ${isCurrent ? 'run-step-current' : ''} ${
        isCurrent && runPaused ? 'run-step-paused' : ''
      } ${isDone || isSkipped ? 'run-step-past' : ''} ${
        showSkip && !isCurrent ? 'run-step-hover' : ''
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <RailCell
        anchor={hasVoice ? 'voice' : 'running'}
        state={railState}
        leading={leading}
        trailing={trailing}
      />
      <div className="run-step-body">
        <span className={`run-step-label ${isCurrent ? 'run-step-label-current' : ''}`}>
          {isDone ? step.doneLabel : step.label}
          {step.app && <AppChip app={step.app} muted={isDone || isSkipped} />}
        </span>
        {isCurrent && runPaused && <span className="run-step-sub-paused">Paused</span>}
        {isDone && step.voiceNote && (
          <span className="run-voice-quote">{stripQuotes(step.voiceNote.text)}</span>
        )}
      </div>
      {isSkipped && <span className="run-skipped-mark">Skipped</span>}
      {showSkip && (
        <button className="run-skip" onClick={onSkip}>
          Skip
        </button>
      )}
    </div>
  )
}

function stripQuotes(text: string): string {
  return text.replace(/[“”"]/g, '').replace(/^\.{3}|^…/, '')
}
