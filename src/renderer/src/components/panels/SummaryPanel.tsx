import { useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import type { RunStep, StepApp } from '../../state/types'
import AppChip, { AppChipBlank, isAppSlotLabel, withAppSlotBlank } from '../shared/AppChip'
import { useWindowDrag } from '../../hooks/useWindowDrag'

/**
 * 07 — summary recap. Meta: "Done · 6 of 6 · 1:12" / "Stopped · 3 of 6 · 1:12".
 * Row states: done · done-voice · held (rose) · skipped · not-yet.
 * Movable via the shared pill drag path; app chips are editable/deletable.
 */
export default function SummaryPanel() {
  const {
    workflow,
    runSteps,
    setRunSteps,
    summaryOutcome,
    summaryMeta,
    finishSummary,
    runRemaining,
    lastRunId
  } = useWorkflow()
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
    // Unique-to-app: whole event edit after removing the chip.
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

  return (
    <div className="summary-panel" onMouseDown={onDragMouseDown}>
      <div className="summary-head">
        <div className="summary-title">{workflow.name}</div>
        <div className="meta">{summaryMeta}</div>
      </div>

      <div className="run-steps scroll">
        {runSteps.map((step) => (
          <SummaryStepRow
            key={step.id}
            step={step}
            expanded={expandedId === step.id}
            onToggle={() => setExpandedId(expandedId === step.id ? null : step.id)}
            highlighted={
              previewRemaining &&
              (step.status === 'active' ||
                step.status === 'question' ||
                step.status === 'error' ||
                step.status === 'pending')
            }
            editing={editingId === step.id}
            draftText={draftText}
            onDraftChange={setDraftText}
            onCommitEdit={() => commitEdit(step)}
            onCancelEdit={() => setEditingId(null)}
            onChangeApp={(app) => changeApp(step, app)}
            onRemoveApp={() => removeApp(step)}
            onPickSlotApp={(app) => pickSlotApp(step, app)}
          />
        ))}
      </div>

      <div className="ledger-footer">
        <button
          className="btn-text"
          onClick={() =>
            window.ghostBridge?.openWorkspace?.(
              lastRunId
                ? { workflowId: workflow.id, runId: lastRunId }
                : { workflowId: workflow.id }
            )
          }
        >
          View log
        </button>
        <div className="footer-actions">
          {isStopped && (
            <button
              className="btn btn-outline"
              onClick={runRemaining}
              onMouseEnter={() => setPreviewRemaining(true)}
              onMouseLeave={() => setPreviewRemaining(false)}
            >
              Run remaining
            </button>
          )}
          <button className="btn btn-outline btn-done" onClick={finishSummary}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryStepRow({
  step,
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
  step: RunStep
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
  const isHeld =
    step.status === 'active' || step.status === 'question' || step.status === 'error'
  const isNotYet = step.status === 'pending'
  const isVoice = isDone && !!step.voiceNote
  const displayText = isDone ? step.doneLabel : step.label
  const slotBlank = !step.app && (isAppSlotLabel(step.label) || isAppSlotLabel(step.doneLabel))
  const textWithoutBlank = displayText.replace(/\s*___+\s*$/, '').trim()

  return (
    <div>
      <button
        className={`run-step summary-row ${isHeld ? 'summary-row-held' : ''} ${
          highlighted ? 'summary-row-highlight' : ''
        } ${isDone || isSkipped ? 'run-step-past' : ''} ${isNotYet ? 'summary-row-notyet' : ''} ${
          isVoice ? 'summary-row-voice' : ''
        }`}
        onClick={() => {
          if (editing) return
          onToggle()
        }}
      >
        <span className="step-num">{step.index}</span>
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
            <span className={`run-step-label ${isHeld ? 'run-step-label-current' : ''}`}>
              {textWithoutBlank}
              {step.app ? (
                <AppChip
                  app={step.app}
                  muted={isDone || isSkipped || isNotYet}
                  editable
                  onChangeApp={onChangeApp}
                  onRemoveApp={onRemoveApp}
                />
              ) : slotBlank ? (
                <AppChipBlank
                  muted={isDone || isSkipped || isNotYet}
                  onPick={onPickSlotApp}
                />
              ) : null}
            </span>
          )}
          {step.voiceNote && !editing && (
            <span className="run-voice-quote">
              {step.voiceNote.text.replace(/[“”"…]/g, '').replace(/^\.{3}/, '')}
            </span>
          )}
        </div>
        {isHeld ? (
          <HeldBars />
        ) : isSkipped ? (
          <span className="run-skipped-mark">Skipped</span>
        ) : (
          <ChevronExpand open={expanded} muted={isNotYet} />
        )}
      </button>
      {expanded && !editing && (
        <div className="summary-detail">
          {isDone && `Completed in 12s — ${step.doneLabel}.`}
          {isSkipped && 'Skipped by you during the run.'}
          {isHeld &&
            (step.status === 'error'
              ? step.error?.message || 'The run needed help at this step.'
              : 'The run stopped while this step was in progress.')}
          {isNotYet && 'Not reached — will run in full with "Run remaining".'}
        </div>
      )}
    </div>
  )
}

function HeldBars() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className="summary-heldbars">
      <rect x="1" width="2" height="8" rx="1" fill="var(--rose)" />
      <rect x="5" width="2" height="8" rx="1" fill="var(--rose)" />
    </svg>
  )
}

function ChevronExpand({ open, muted }: { open: boolean; muted: boolean }) {
  return (
    <svg
      width="9"
      height="6"
      viewBox="0 0 9 6"
      fill="none"
      stroke={muted ? 'rgba(161,161,171,0.5)' : 'rgba(161,161,171,0.9)'}
      strokeWidth="1"
      style={{ transform: open ? 'rotate(180deg)' : undefined, flexShrink: 0 }}
    >
      <path d="M0.5 1 4.5 5 8.5 1" />
    </svg>
  )
}
