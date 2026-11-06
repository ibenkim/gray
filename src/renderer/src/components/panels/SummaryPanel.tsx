import { useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import type { RunStep, StepApp } from '../../state/types'
import AppChip, { AppChipBlank, isAppSlotLabel, withAppSlotBlank } from '../shared/AppChip'
import { useWindowDrag } from '../../hooks/useWindowDrag'
import RailCell, { type SummaryRailState } from '../shared/RailCell'
import RichText from '../shared/RichText'

/**
 * 07 — summary (Figma: summary-done · Summary / stopped · Run "Summary"). The run card
 * narrows into this recap in place. Done: gray rows with checks · View log · Done.
 * Stopped: the step it stopped on carries an isolated accent node on a rose tint; rows it
 * never reached are dimmed; Run Remaining picks up from there.
 */
export default function SummaryPanel() {
  const { workflow, runSteps, setRunSteps, summaryOutcome, summaryMeta, finishSummary, runRemaining, lastRunId } =
    useWorkflow()
  const isStopped = summaryOutcome === 'stopped'
  // Hovering "Run remaining" highlights the rows it will act on.
  const [previewRemaining, setPreviewRemaining] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  function patchStep(id: string, patch: Partial<RunStep>) {
    setRunSteps((steps) => steps.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  function changeApp(step: RunStep, app: StepApp) {
    const text = step.status === 'done' ? step.doneLabel : step.label
    if (isAppSlotLabel(text) || isAppSlotLabel(step.label) || isAppSlotLabel(step.doneLabel)) {
      const label = withAppSlotBlank(step.label).replace(/\s*___+\s*$/, '').trim()
      const doneLabel = withAppSlotBlank(step.doneLabel).replace(/\s*___+\s*$/, '').trim()
      patchStep(step.id, { app, label, doneLabel })
      return
    }
    // Unique-to-app: whole event changes — open inline edit with the new app.
    patchStep(step.id, { app })
    setEditingId(step.id)
    setDraftText(step.status === 'done' ? step.doneLabel : step.label)
  }

  function removeApp(step: RunStep) {
    if (isAppSlotLabel(step.label) || isAppSlotLabel(step.doneLabel)) {
      patchStep(step.id, {
        app: undefined,
        label: withAppSlotBlank(step.label),
        doneLabel: withAppSlotBlank(step.doneLabel)
      })
      return
    }
    patchStep(step.id, { app: undefined })
    setEditingId(step.id)
    setDraftText(step.status === 'done' ? step.doneLabel : step.label)
  }

  function pickSlotApp(step: RunStep, app: StepApp) {
    patchStep(step.id, {
      app,
      label: withAppSlotBlank(step.label).replace(/\s*___+\s*$/, '').trim(),
      doneLabel: withAppSlotBlank(step.doneLabel).replace(/\s*___+\s*$/, '').trim()
    })
  }

  function commitEdit(step: RunStep) {
    setEditingId(null)
    const text = draftText.trim()
    if (!text) return
    if (step.status === 'done') patchStep(step.id, { doneLabel: text, label: text })
    else patchStep(step.id, { label: text })
  }

  const heldIndex = runSteps.findIndex(
    (s) => s.status === 'active' || s.status === 'question' || s.status === 'error'
  )
  const stateOf = (step: RunStep, i: number): SummaryRailState =>
    heldIndex >= 0
      ? i < heldIndex
        ? 'complete'
        : i === heldIndex
          ? 'stopped'
          : 'unrun'
      : step.status === 'pending'
        ? 'unrun'
        : 'complete'

  return (
    <div className={`summary-panel ${isStopped ? 'summary-panel-stopped' : ''}`} onMouseDown={onDragMouseDown}>
      <div className="summary-head">
        <div className="summary-title">{workflow.name}</div>
        <div className="summary-meta">{summaryMeta}</div>
      </div>

      <div className="summary-steps scroll">
        {runSteps.map((step, i) => {
          const summaryState = stateOf(step, i)
          const prevState = i > 0 ? stateOf(runSteps[i - 1], i - 1) : null
          const nextState = i < runSteps.length - 1 ? stateOf(runSteps[i + 1], i + 1) : null
          return (
            <SummaryStepRow
              key={step.id}
              index={i}
              step={step}
              summaryState={summaryState}
              leading={prevState === summaryState && summaryState !== 'stopped'}
              trailing={nextState === summaryState && summaryState !== 'stopped'}
              expanded={expandedId === step.id}
              onToggle={() => setExpandedId(expandedId === step.id ? null : step.id)}
              highlighted={previewRemaining && summaryState !== 'complete'}
              editing={editingId === step.id}
              draftText={draftText}
              onDraftChange={setDraftText}
              onCommitEdit={() => commitEdit(step)}
              onCancelEdit={() => setEditingId(null)}
              onChangeApp={(app) => changeApp(step, app)}
              onRemoveApp={() => removeApp(step)}
              onPickSlotApp={(app) => pickSlotApp(step, app)}
            />
          )
        })}
      </div>

      <div className="summary-footer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="window-actions-right">
          {isStopped ? (
            <>
              <button className="btn btn-secondary" onClick={finishSummary}>
                Done
              </button>
              <button
                className="btn btn-primary"
                onClick={runRemaining}
                onMouseEnter={() => setPreviewRemaining(true)}
                onMouseLeave={() => setPreviewRemaining(false)}
              >
                Run Remaining
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-secondary"
                onClick={() =>
                  window.grayBridge?.openWorkspace?.(
                    lastRunId ? { workflowId: workflow.id, runId: lastRunId } : { workflowId: workflow.id }
                  )
                }
              >
                View log
              </button>
              <button className="btn btn-primary" onClick={finishSummary}>
                Done
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryStepRow({
  index,
  step,
  summaryState,
  leading,
  trailing,
  expanded,
  onToggle,
  highlighted,
  editing,
  draftText,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onChangeApp,
  onRemoveApp,
  onPickSlotApp
}: {
  index: number
  step: RunStep
  summaryState: SummaryRailState
  leading: boolean
  trailing: boolean
  expanded: boolean
  onToggle: () => void
  highlighted: boolean
  editing: boolean
  draftText: string
  onDraftChange: (v: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onChangeApp: (app: StepApp) => void
  onRemoveApp: () => void
  onPickSlotApp: (app: StepApp) => void
}) {
  const isDone = step.status === 'done'
  const isSkipped = step.status === 'skipped'
  const isHeld = summaryState === 'stopped'
  const isNotYet = summaryState === 'unrun'
  const isVoice = isDone && !!step.voiceNote
  const displayText = isDone ? step.doneLabel : step.label
  const slotBlank = !step.app && (isAppSlotLabel(step.label) || isAppSlotLabel(step.doneLabel))
  const textWithoutBlank = displayText.replace(/\s*___+\s*$/, '').trim()

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        className={[
          'summary-row',
          isHeld ? 'summary-row-held' : '',
          isNotYet ? 'summary-row-notyet' : '',
          highlighted ? 'summary-row-highlight' : ''
        ].join(' ')}
        style={{ ['--i' as string]: index }}
        onClick={() => !editing && onToggle()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !editing) {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-expanded={expanded}
      >
        <RailCell kind="summary" anchor="summary" state={summaryState} leading={leading} trailing={trailing} />
        <div className="run-step-body">
          {editing ? (
            <input
              className="step-edit-input"
              autoFocus
              value={draftText}
              onChange={(e) => onDraftChange(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onBlur={onCommitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onCommitEdit()
                if (e.key === 'Escape') onCancelEdit()
              }}
            />
          ) : (
            <div className="run-step-line">
              <span className="run-step-label">
                <RichText text={textWithoutBlank} />
                {step.app ? (
                  <AppChip app={step.app} muted editable onChangeApp={onChangeApp} onRemoveApp={onRemoveApp} />
                ) : slotBlank ? (
                  <AppChipBlank muted onPick={onPickSlotApp} />
                ) : null}
              </span>
              {isDone && (
                <span className="run-check" aria-label="Done">
                  <svg width="10" height="8" viewBox="0 0 10 8" fill="none" aria-hidden="true">
                    <path d="M0.35 3.35L3.35 6.35L9.35 0.35" pathLength={1} />
                  </svg>
                </span>
              )}
              {isSkipped && <span className="run-skipped-mark">Skipped</span>}
            </div>
          )}
          {step.voiceNote && !editing && isVoice && (
            <span className="run-voice-quote">{step.voiceNote.text.replace(/[“”"…]/g, '').replace(/^\.{3}/, '')}</span>
          )}
        </div>
      </div>
      {expanded && !editing && (
        <div className="summary-detail">
          {isDone && `Completed — ${step.doneLabel}.`}
          {isSkipped && 'Skipped by you during the run.'}
          {isHeld &&
            (step.status === 'error'
              ? step.error?.message || 'The run needed help at this step.'
              : 'The run stopped while this step was in progress.')}
          {isNotYet && 'Not reached — Run Remaining picks up from here.'}
        </div>
      )}
    </div>
  )
}
