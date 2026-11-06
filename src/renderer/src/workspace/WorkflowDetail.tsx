import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { WorkspaceDialog } from './WorkspaceDialog'
import { WorkspacePopover } from './WorkspacePopover'
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
import { OverflowDots } from './WorkflowsHome'

type Tab = 'overview' | 'log'

/**
 * Workflow detail (Figma: workflow · workflow/log · run-detail · trigger-edit · menu ·
 * delete-confirm): Overview shares the editor's TRIGGER/STEPS, Log groups runs by month,
 * a run opens its step-by-step record. The tab underline slides; views rise in.
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
  /** The More button: its menu is anchored to it in the card's overlay layer. */
  const moreRef = useRef<HTMLButtonElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  function requestRun() {
    if (needsRunContract(workflow)) {
      setShowContract(true)
      setTab('overview')
      return
    }
    void window.grayBridge?.runWorkflow?.(workflow.id)
  }

  async function confirmContract() {
    const accepted = { ...workflow, contractAccepted: true }
    onUpdate(() => accepted)
    setShowContract(false)
    await window.grayBridge?.upsertWorkflow?.(accepted)
    void window.grayBridge?.runWorkflow?.(accepted.id)
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

  // Menu shortcuts while the menu is open (dismissal is the popover's).
  useEffect(() => {
    if (!menuOpen) return
    function onKey(e: KeyboardEvent) {
      if (menuOpen && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        setMenuOpen(false)
        onDuplicate()
      }
      if (menuOpen && e.altKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        void navigator.clipboard?.writeText?.(`gray://workflow/${workflow.id}`)
        setMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, onDuplicate, workflow.id])

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
    <div className="ws-view ws-detail-view">
      <div className="ws-header" onMouseDown={onDragMouseDown}>
        <div className="ws-detail-head">
          <button
            className="back-btn"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onBack}
            title="Back to Workflows"
            aria-label="Back to Workflows"
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
              <div className="ws-detail-title" title={workflow.name}>
                {workflow.name}
              </div>
            )}
            <div className="ws-detail-sub">
              {workflow.status === 'on' ? 'On' : 'Off'} · {workflow.runCount} runs · {workflow.hoursReturned}
            </div>
          </div>
        </div>
        <div className="ws-detail-actions" onMouseDown={(e) => e.stopPropagation()}>
          {onShareToTeam && (
            <button
              className="btn btn-hairline btn-ws"
              disabled={workflow.scope === 'team'}
              onClick={() => {
                if (workflow.scope === 'team') return
                onShareToTeam()
              }}
            >
              {workflow.scope === 'team' ? 'Shared with team' : 'Share to Team'}
            </button>
          )}
          <button className="btn btn-primary btn-ws" onClick={requestRun}>
            Run
          </button>
          <button
            ref={moreRef}
            className="overflow-btn"
            title="More"
            aria-label="More"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <OverflowDots />
          </button>
          {menuOpen && (
            <WorkspacePopover anchor={moreRef.current} onClose={() => setMenuOpen(false)} className="overflow-menu">
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
                  void navigator.clipboard?.writeText?.(`gray://workflow/${workflow.id}`)
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
                  onUpdate((w) => ({ ...w, status: w.status === 'on' ? 'off' : 'on' }))
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
            </WorkspacePopover>
          )}
        </div>
      </div>

      <Tabs
        tab={tab}
        onTab={(t) => {
          setTab(t)
          if (t === 'overview') setSelectedRunId(null)
        }}
      />

      {tab === 'overview' ? (
        <div className="ws-detail-body scroll" key="overview">
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
                renderPopover={({ anchor, onClose, content }) => (
                  <WorkspacePopover anchor={anchor} onClose={onClose} className="trigger-pop-host">
                    {content}
                  </WorkspacePopover>
                )}
              />
              <QuestionsSection questions={workflow.questions} />
              <div className="editor-section">
                <div className="section-label">Steps</div>
                <StepList
                  animateIn
                  steps={workflow.steps}
                  initialEditStepId={initialEditStepId}
                  onChange={(updater) =>
                    onUpdate((w) => {
                      const nextSteps = updater(w.steps)
                      if (w.sessionId) {
                        void window.grayBridge?.automationMarkStale?.(
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
          key={`run-${selectedRun.id}`}
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
        <LogTab key="log" runs={runs} onOpenRun={setSelectedRunId} onOpenActivity={onOpenActivity} />
      )}

      {deleteOpen && (
        <WorkspaceDialog
          title={`Delete “${workflow.name}”?`}
          target={workflow.name}
          confirmLabel="Delete workflow"
          returnFocusTo={moreRef.current}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => {
            setDeleteOpen(false)
            onDelete()
          }}
        >
          <p>
            Automatic runs stop immediately. Its {workflow.runCount} runs stay in History. This can’t be undone.
          </p>
        </WorkspaceDialog>
      )}
    </div>
  )
}

/** Overview · Log with an underline that slides to the active tab. */
function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const refs = useRef<Record<Tab, HTMLButtonElement | null>>({ overview: null, log: null })
  const [line, setLine] = useState<{ x: number; w: number } | null>(null)
  useLayoutEffect(() => {
    const el = refs.current[tab]
    if (el) setLine({ x: el.offsetLeft, w: el.offsetWidth })
  }, [tab])
  return (
    <div className="ws-tabs" role="tablist">
      {(['overview', 'log'] as Tab[]).map((t) => (
        <button
          key={t}
          ref={(el) => {
            refs.current[t] = el
          }}
          role="tab"
          aria-selected={tab === t}
          className={`ws-tab ${tab === t ? 'ws-tab-active' : ''}`}
          onClick={() => onTab(t)}
        >
          {t === 'overview' ? 'Overview' : 'Log'}
        </button>
      ))}
      {line && (
        <span
          className="ws-tab-underline"
          style={{ width: line.w, transform: `translateX(${line.x}px)` }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}

/** "Jul 1, 9:00 A.M." */
function runWhen(iso: string): string {
  return formatRunWhen(iso).replace(/\s+·\s+/, ', ')
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
  const sorted = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
  const groups = groupRunsByMonth(sorted)
  let row = 0

  return (
    <div className="ws-detail-body ws-detail-body-log scroll">
      {groups.length === 0 && <div className="log-empty">Runs will show up here</div>}
      {groups.map((g) => (
        <div className="log-month" key={g.key}>
          <div className="log-month-label">{g.label}</div>
          <div>
            {g.runs.map((run) => {
              const held = run.outcome !== 'done'
              return (
                <button
                  key={run.id}
                  className="log-row"
                  style={{ ['--i' as string]: row++ }}
                  title={formatLogOutcome(run)}
                  onClick={() => onOpenRun(run.id)}
                >
                  <span className="log-when">{runWhen(run.startedAt)}</span>
                  <span className={`log-outcome ${held ? 'log-outcome-held' : ''}`}>
                    {held ? run.stopReason ?? 'Stopped' : 'Done'}
                  </span>
                  <span className="log-returned">{formatReturned(run.returnedMinutes)}</span>
                </button>
              )
            })}
          </div>
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
    run.steps.find((s) => s.status === 'held' || s.status === 'skipped')?.stepId ?? run.steps[0]?.stepId
  const stepsRef = useRef<HTMLDivElement>(null)
  const [rail, setRail] = useState<{ top: number; height: number } | null>(null)

  // The rail runs from the first node to the last one.
  useLayoutEffect(() => {
    const el = stepsRef.current
    if (!el) return
    const nodes = el.querySelectorAll<HTMLElement>('.run-step-node')
    if (nodes.length < 2) return setRail(null)
    // Rows are positioned, so offsetTop is row-relative; measure against the list instead.
    // offsetTop of the row + the node's own offset keeps this transform-proof (rows rise in).
    const centre = (node: HTMLElement): number => {
      let y = node.offsetTop + node.offsetHeight / 2
      let p = node.offsetParent as HTMLElement | null
      while (p && p !== el) {
        y += p.offsetTop
        p = p.offsetParent as HTMLElement | null
      }
      return y
    }
    const top = centre(nodes[0])
    setRail({ top, height: centre(nodes[nodes.length - 1]) - top })
  }, [run])

  const held = run.outcome !== 'done'

  return (
    <div className="ws-detail-body ws-detail-body-log scroll run-detail">
      <button className="run-detail-back" onClick={onBack}>
        ‹  All runs
      </button>
      <div className="log-row run-detail-summary" title={formatRunDetailMeta(run)}>
        <span className="log-when">{runWhen(run.startedAt)}</span>
        <span className={`log-outcome ${held ? 'log-outcome-held' : ''}`}>
          {held ? run.stopReason ?? 'Stopped' : 'Done'}
        </span>
        <span className="log-returned">{formatReturned(run.returnedMinutes)}</span>
      </div>

      <div className="run-detail-steps" ref={stepsRef}>
        {rail && <span className="run-detail-rail" style={{ top: rail.top, height: rail.height }} aria-hidden="true" />}
        {run.steps.map((step, i) => (
          <RunStepBlock
            key={step.stepId}
            index={i}
            step={step}
            receipt={run.questions.find((q) => q.stepId === step.stepId)}
            offeringAlways={alwaysOffer === step.stepId}
            onOfferAlways={() => onOfferAlways(step.stepId)}
            onAlwaysUse={onAlwaysUse}
            artifacts={step.index === run.steps.length ? run.artifactLinks : undefined}
          />
        ))}
      </div>

      <div className="run-detail-feedback">
        <span className="run-feedback-label">Went well?</span>
        <button className="run-feedback-link" onClick={onLooksRight}>
          Looks right
        </button>
        <button className="run-feedback-link" onClick={() => firstFixable && onFixStep(firstFixable)}>
          Something’s off — fix a step
        </button>
      </div>
    </div>
  )
}

function RunStepBlock({
  index,
  step,
  receipt,
  offeringAlways,
  onOfferAlways,
  onAlwaysUse,
  artifacts
}: {
  index: number
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
  const isPending = !isHeld && !isSkipped && !isDone

  return (
    <div className="run-step-block">
      <div
        className={`run-step-row ${isHeld ? 'run-step-row-held' : ''} ${isPending ? 'run-step-row-pending' : ''}`}
        style={{ ['--i' as string]: index }}
      >
        <span className="run-step-node" />
        <span className="run-step-text">{isDone || isSkipped || isHeld ? step.doneLabel : step.label}</span>
        {isSkipped && <span className="run-skipped-chip">Skipped</span>}
        <span className="run-step-time">{formatStepClock(step.endedAt ?? step.startedAt)}</span>
      </div>
      {receipt && (
        <button
          className="run-receipt"
          style={{ ['--i' as string]: index }}
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
              <span className="run-receipt-label">Asked:</span>
              <span>{receipt.prompt}</span>
              <span className="run-receipt-label">Answered:</span>
              <span>{receipt.answerLabel}</span>
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
          {a.label.replace(/\s*↗\s*$/, '')} <span aria-hidden="true">↗</span>
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
      label: d.toLocaleString('en-US', { month: 'long' }),
      runs: groupRuns
    }
  })
}

function BackChevron() {
  return (
    <svg width="6.08" height="9.74" viewBox="0 0 6.08191 9.74329" fill="none" aria-hidden="true">
      <path d="M5.75 0.37L0.75 4.87L5.75 9.37" stroke="currentColor" />
    </svg>
  )
}
