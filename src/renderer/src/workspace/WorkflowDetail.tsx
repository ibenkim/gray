import { useEffect, useRef, useState } from 'react'
import {
  formatLogOutcome,
  formatReturned,
  formatRunDetailMeta,
  formatRunWhen,
  formatStepClock
} from '../../../shared/runFormat'
import type { QuestionReceipt, Run, RunStepResult, Workflow } from '../state/types'
import TriggerSection from '../components/shared/TriggerSection'
import StepList from '../components/shared/StepList'
import {
  needsRunContract,
  QuestionsSection,
  RunContractPanel,
  WorkflowSummary
} from '../components/shared/ReviewSections'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'

type Tab = 'overview' | 'log'

/**
 * 1.5–1.7 — workflow detail: Overview (shared TRIGGER/STEPS), Log + run
 * detail from persisted Runs, ⋯ overflow + delete confirm.
 */
export default function WorkflowDetail({
  workflow,
  runs,
  initialRunId,
  initialEditStepId,
  onBack,
  onUpdate,
  onDuplicate,
  onDelete,
  onOpenActivity,
  onFixStep,
  onShareToTeam
}: {
  workflow: Workflow
  runs: Run[]
  initialRunId?: string | null
  initialEditStepId?: string | null
  onBack: () => void
  onUpdate: (updater: (w: Workflow) => Workflow) => void
  onDuplicate: () => void
  onDelete: () => void
  onOpenActivity: () => void
  onFixStep: (stepId: string) => void
  /** When set (team present), shows Share to Team beside Run / ⋯. */
  onShareToTeam?: () => void
}) {
  const [tab, setTab] = useState<Tab>(initialRunId ? 'log' : 'overview')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(workflow.name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [alwaysOffer, setAlwaysOffer] = useState<string | null>(null)
  const [showContract, setShowContract] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  function requestRun() {
    if (needsRunContract(workflow)) {
      setShowContract(true)
      setTab('overview')
      return
    }
    void window.ghostBridge?.runWorkflow?.(workflow.id)
  }

  async function confirmContract() {
    const accepted = { ...workflow, contractAccepted: true }
    onUpdate(() => accepted)
    setShowContract(false)
    await window.ghostBridge?.upsertWorkflow?.(accepted)
    void window.ghostBridge?.runWorkflow?.(accepted.id)
  }

  useEffect(() => {
    if (initialRunId) {
      setTab('log')
      setSelectedRunId(initialRunId)
    }
  }, [initialRunId])

  useEffect(() => {
    if (initialEditStepId) setTab('overview')
  }, [initialEditStepId])

  useEffect(() => {
    setNameDraft(workflow.name)
  }, [workflow.name])

  useEffect(() => {
    if (!renaming) return
    renameRef.current?.focus()
    renameRef.current?.select()
  }, [renaming])

  useEffect(() => {
    if (!menuOpen && !deleteOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setDeleteOpen(false)
      }
      if (menuOpen && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setMenuOpen(false)
        onDuplicate()
      }
      if (menuOpen && e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void navigator.clipboard?.writeText?.(`ghost://workflow/${workflow.id}`)
        setMenuOpen(false)
      }
    }
    function onDown(e: MouseEvent) {
      if (menuOpen && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [menuOpen, deleteOpen, onDuplicate, workflow.id])

  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) ?? null : null

  function commitRename() {
    const next = nameDraft.trim()
    setRenaming(false)
    if (!next || next === workflow.name) {
      setNameDraft(workflow.name)
      return
    }
    onUpdate((w) => ({ ...w, name: next }))
  }

  function applyAlwaysAnswer(receipt: QuestionReceipt) {
    onUpdate((w) => ({
      ...w,
      steps: w.steps.map((s) => {
        if (s.id !== receipt.stepId || !s.fix) return s
        return {
          ...s,
          fix: {
            ...s.fix,
            selectedOptionId: receipt.answerId,
            customValue: receipt.customValue,
            collapsed: true
          }
        }
      })
    }))
    setAlwaysOffer(null)
  }

  return (
    <div className="ws-view">
      <div className="ws-header" onMouseDown={onDragMouseDown}>
        <div className="ws-detail-head">
          <button
            className="back-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onBack}
            title="Back"
          >
            <BackChevron />
          </button>
          <div>
            {renaming ? (
              <input
                ref={renameRef}
                className="ws-rename-input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitRename}
                onMouseDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') {
                    setNameDraft(workflow.name)
                    setRenaming(false)
                  }
                }}
              />
            ) : (
              <div className="ws-detail-title">{workflow.name}</div>
            )}
            <div className="ws-header-sub">
              {workflow.status === 'on' ? 'On' : 'Off'} · {workflow.runCount} runs ·{' '}
              {workflow.hoursReturned}
            </div>
          </div>
        </div>
        <div className="ws-detail-actions" ref={menuRef}>
          <button
            className="btn btn-secondary"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={requestRun}
          >
            Run
          </button>
          {onShareToTeam && (
            <button
              className="btn btn-secondary"
              disabled={workflow.scope === 'team'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (workflow.scope === 'team') return
                onShareToTeam()
              }}
            >
              {workflow.scope === 'team' ? 'Shared' : 'Share to Team'}
            </button>
          )}
          <button
            className="overflow-btn"
            title="More"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <OverflowDots />
          </button>
          {menuOpen && (
            <div className="overflow-menu">
              <button
                className="overflow-item"
                onClick={() => {
                  setMenuOpen(false)
                  setRenaming(true)
                }}
              >
                <span>Rename</span>
                <span className="overflow-shortcut">⏎</span>
              </button>
              <button
                className="overflow-item"
                onClick={() => {
                  setMenuOpen(false)
                  onDuplicate()
                }}
              >
                <span>Duplicate</span>
                <span className="overflow-shortcut">⌘D</span>
              </button>
              <button className="overflow-item overflow-item-dim" disabled>
                Move to folder…
              </button>
              <button
                className="overflow-item"
                onClick={() => {
                  void navigator.clipboard?.writeText?.(`ghost://workflow/${workflow.id}`)
                  setMenuOpen(false)
                }}
              >
                <span>Copy share link</span>
                <span className="overflow-shortcut">⌥⌘C</span>
              </button>
              <div className="overflow-divider" />
              <button
                className="overflow-item"
                onClick={() => {
                  setMenuOpen(false)
                  onUpdate((w) => ({
                    ...w,
                    status: w.status === 'on' ? 'off' : 'on'
                  }))
                }}
              >
                {workflow.status === 'on' ? 'Turn off' : 'Turn on'}
              </button>
              <button
                className="overflow-item overflow-item-rose"
                onClick={() => {
                  setMenuOpen(false)
                  setDeleteOpen(true)
                }}
              >
                Delete…
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="ws-tabs">
        <button
          className={`ws-tab ${tab === 'overview' ? 'ws-tab-active' : ''}`}
          onClick={() => {
            setTab('overview')
            setSelectedRunId(null)
          }}
        >
          Overview
        </button>
        <button
          className={`ws-tab ${tab === 'log' ? 'ws-tab-active' : ''}`}
          onClick={() => setTab('log')}
        >
          Log
        </button>
      </div>

      {tab === 'overview' ? (
        <div className="ws-detail-body scroll">
          {showContract && workflow.runContract ? (
            <RunContractPanel
              contract={workflow.runContract}
              onConfirm={confirmContract}
              onCancel={() => setShowContract(false)}
            />
          ) : (
            <>
              <WorkflowSummary summary={workflow.summary} goal={workflow.goal} />
              <TriggerSection
                trigger={workflow.trigger}
                onChange={(t) => onUpdate((w) => ({ ...w, trigger: t }))}
                onTurnOff={() => onUpdate((w) => ({ ...w, status: 'off' }))}
              />
              <QuestionsSection questions={workflow.questions} />
              <div className="ledger-section">
                <div className="section-label">STEPS</div>
                <StepList
                  steps={workflow.steps}
                  initialEditStepId={initialEditStepId}
                  onChange={(updater) =>
                    onUpdate((w) => {
                      const nextSteps = updater(w.steps)
                      if (w.sessionId) {
                        void window.ghostBridge?.automationMarkStale?.(
                          w.sessionId,
                          true,
                          nextSteps.map((s) => ({ index: s.index, title: s.title }))
                        )
                      }
                      return { ...w, steps: nextSteps, automationStale: true }
                    })
                  }
                />
              </div>
            </>
          )}
        </div>
      ) : selectedRun ? (
        <RunDetailView
          run={selectedRun}
          alwaysOffer={alwaysOffer}
          onBack={() => setSelectedRunId(null)}
          onOfferAlways={setAlwaysOffer}
          onAlwaysUse={applyAlwaysAnswer}
          onLooksRight={() => setSelectedRunId(null)}
          onFixStep={(stepId) => {
            onFixStep(stepId)
            setTab('overview')
            setSelectedRunId(null)
          }}
        />
      ) : (
        <LogTab
          runs={runs}
          onOpenRun={setSelectedRunId}
          onOpenActivity={onOpenActivity}
        />
      )}

      {deleteOpen && (
        <div
          className="ws-scrim"
          onClick={() => setDeleteOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setDeleteOpen(false)}
        >
          <div
            className="delete-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="delete-dialog-title">Delete “{workflow.name}”?</div>
            <div className="delete-dialog-body">
              Scheduled runs stop immediately. Its {workflow.runCount} runs stay in History. This
              can’t be undone.
            </div>
            <div className="delete-dialog-actions">
              <button className="btn btn-secondary" onClick={() => setDeleteOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setDeleteOpen(false)
                  onDelete()
                }}
              >
                Delete workflow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function LogTab({
  runs,
  onOpenRun,
  onOpenActivity
}: {
  runs: Run[]
  onOpenRun: (id: string) => void
  onOpenActivity: () => void
}) {
  const sorted = [...runs].sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  )
  const groups = groupRunsByMonth(sorted)

  return (
    <div className="ws-detail-body scroll">
      {groups.length === 0 && (
        <div className="log-empty">Runs will show up here</div>
      )}
      {groups.map((g) => (
        <div className="ledger-section" key={g.key}>
          <div className="section-label">{g.label}</div>
          {g.runs.map((run) => {
            const outcome = formatLogOutcome(run)
            const hasQuestion = run.questions.length > 0
            return (
              <button
                key={run.id}
                className="log-row"
                onClick={() => onOpenRun(run.id)}
              >
                <span className="log-when">{formatRunWhen(run.startedAt)}</span>
                <span className={`log-outcome ${hasQuestion ? 'log-outcome-amber' : ''}`}>
                  {outcome}
                </span>
                <span className="log-returned">{formatReturned(run.returnedMinutes)}</span>
              </button>
            )
          })}
        </div>
      ))}
      <button className="log-footnote" onClick={onOpenActivity}>
        View full history in Activity
      </button>
    </div>
  )
}

function RunDetailView({
  run,
  alwaysOffer,
  onBack,
  onOfferAlways,
  onAlwaysUse,
  onLooksRight,
  onFixStep
}: {
  run: Run
  alwaysOffer: string | null
  onBack: () => void
  onOfferAlways: (stepId: string | null) => void
  onAlwaysUse: (receipt: QuestionReceipt) => void
  onLooksRight: () => void
  onFixStep: (stepId: string) => void
}) {
  const firstFixable =
    run.steps.find((s) => s.status === 'held' || s.status === 'skipped')?.stepId ??
    run.steps[0]?.stepId

  return (
    <div className="ws-detail-body scroll run-detail">
      <button className="run-detail-back" onClick={onBack}>
        ‹  All runs
      </button>
      <div className="run-detail-head">
        <div className="run-detail-when">{formatRunWhen(run.startedAt)}</div>
        <div className="run-detail-returned">{formatReturned(run.returnedMinutes)}</div>
      </div>
      <div className="run-detail-meta">{formatRunDetailMeta(run)}</div>

      <div className="run-detail-steps">
        {run.steps.map((step) => (
          <RunStepBlock
            key={step.stepId}
            step={step}
            receipt={run.questions.find((q) => q.stepId === step.stepId)}
            offeringAlways={alwaysOffer === step.stepId}
            onOfferAlways={() => onOfferAlways(step.stepId)}
            onAlwaysUse={onAlwaysUse}
            artifacts={
              step.index === run.steps.length
                ? run.artifactLinks
                : undefined
            }
          />
        ))}
      </div>

      <div className="run-detail-divider" />
      <div className="run-detail-feedback">
        <span className="run-feedback-label">Went well?</span>
        <button className="run-feedback-link" onClick={onLooksRight}>
          Looks right
        </button>
        <button
          className="run-feedback-link"
          onClick={() => firstFixable && onFixStep(firstFixable)}
        >
          Something’s off — fix a step
        </button>
      </div>
    </div>
  )
}

function RunStepBlock({
  step,
  receipt,
  offeringAlways,
  onOfferAlways,
  onAlwaysUse,
  artifacts
}: {
  step: RunStepResult
  receipt?: QuestionReceipt
  offeringAlways: boolean
  onOfferAlways: () => void
  onAlwaysUse: (receipt: QuestionReceipt) => void
  artifacts?: { label: string; url: string }[]
}) {
  const isHeld = step.status === 'held'
  const isSkipped = step.status === 'skipped'
  const isDone = step.status === 'done'

  return (
    <div className="run-step-block">
      <div className={`run-step-row ${isHeld ? 'run-step-row-held' : ''}`}>
        <span className="run-step-num">{step.index}</span>
        <span className={`run-step-label ${isHeld ? 'run-step-label-held' : ''}`}>
          {isDone || isSkipped || isHeld ? step.doneLabel : step.label}
        </span>
        {isSkipped && <span className="run-skipped-chip">Skipped</span>}
        <span className="run-step-spacer" />
        <span className="run-step-time">{formatStepClock(step.endedAt ?? step.startedAt)}</span>
        {isDone && <TealCheck />}
        {isHeld && <span className="run-held-mark" />}
      </div>
      {receipt && (
        <button
          className="run-receipt"
          onClick={() => {
            if (offeringAlways) return
            onOfferAlways()
          }}
        >
          {offeringAlways ? (
            <span
              className="run-always-link"
              onClick={(e) => {
                e.stopPropagation()
                onAlwaysUse(receipt)
              }}
            >
              Always use this answer
            </span>
          ) : (
            <>
              Asked: “{receipt.prompt}”  ·  You answered “{receipt.answerLabel}”
            </>
          )}
        </button>
      )}
      {artifacts?.map((a) => (
        <a
          key={a.url + a.label}
          className="run-artifact"
          href={a.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            e.preventDefault()
            window.open(a.url, '_blank')
          }}
        >
          {a.label}
        </a>
      ))}
    </div>
  )
}

function groupRunsByMonth(runs: Run[]): { key: string; label: string; runs: Run[] }[] {
  const map = new Map<string, Run[]>()
  for (const run of runs) {
    const d = new Date(run.startedAt)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    const list = map.get(key) ?? []
    list.push(run)
    map.set(key, list)
  }
  return [...map.entries()].map(([key, groupRuns]) => {
    const d = new Date(groupRuns[0].startedAt)
    return {
      key,
      label: d.toLocaleString('en-US', { month: 'long' }).toUpperCase(),
      runs: groupRuns
    }
  })
}

function BackChevron() {
  return (
    <svg width="6" height="10" viewBox="0 0 6 10" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M5 1 1 5 5 9" />
    </svg>
  )
}

function OverflowDots() {
  return (
    <svg width="11" height="3" viewBox="0 0 11 3" fill="currentColor">
      <circle cx="1.5" cy="1.5" r="1.2" />
      <circle cx="5.5" cy="1.5" r="1.2" />
      <circle cx="9.5" cy="1.5" r="1.2" />
    </svg>
  )
}

function TealCheck() {
  return (
    <svg className="run-teal-check" width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path
        d="M1.5 5.2 3.8 7.5 8.5 2.5"
        stroke="var(--teal)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
