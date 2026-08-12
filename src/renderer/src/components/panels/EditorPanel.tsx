import { useEffect, useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import TriggerSection, { PencilIcon } from '../shared/TriggerSection'
import StepList from '../shared/StepList'
import {
  needsRunContract,
  QuestionsSection,
  RedactionPreview,
  RunContractPanel,
  WorkflowSummary
} from '../shared/ReviewSections'
import { ChevronDown } from '../GhostPill'
import { useWindowDrag } from '../../hooks/useWindowDrag'

/**
 * 05 — editor, 660×521 white panel. Header · summary · TRIGGER · QUESTIONS ·
 * STEPS · footer (Cancel with confirm · Run · Save Workflow). Esc collapses to
 * the "Editing" pill — Cancel/✕ is the only destructive exit.
 */
export default function EditorPanel() {
  const {
    workflow,
    setWorkflow,
    saveWorkflow,
    runWorkflow,
    cancelEditor,
    setEditorCollapsed
  } = useWorkflow()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [showContract, setShowContract] = useState(false)
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  // Esc → collapse (not discard).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (showContract) {
        setShowContract(false)
        return
      }
      if (confirmDiscard) {
        setConfirmDiscard(false)
        return
      }
      setEditorCollapsed(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setEditorCollapsed, confirmDiscard, showContract])

  function commitTitle() {
    if (titleDraft.trim()) setWorkflow((w) => ({ ...w, name: titleDraft.trim() }))
    setEditingTitle(false)
  }

  function beginTitleEdit() {
    setTitleDraft(workflow.name)
    setEditingTitle(true)
  }

  function requestRun() {
    if (needsRunContract(workflow)) {
      setShowContract(true)
      return
    }
    runWorkflow()
  }

  function confirmContract() {
    const accepted = { ...workflow, contractAccepted: true }
    setWorkflow(accepted)
    setShowContract(false)
    runWorkflow(accepted)
  }

  return (
    <div className="editor-panel">
      <div className="editor-chrome">
        <button
          className="editor-close"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setConfirmDiscard(true)}
          title="Cancel"
        >
          <XGlyph />
        </button>
        <button
          className="chevron-btn editor-collapse"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setEditorCollapsed(true)}
          title="Collapse"
        >
          <ChevronDown />
        </button>
      </div>

      <div className="editor-head" onMouseDown={onDragMouseDown}>
        <div className="eyebrow">Here's what I learned</div>
        <div className="editor-title-row">
          {editingTitle ? (
            <input
              className="editor-title-input"
              autoFocus
              value={titleDraft}
              size={Math.max(titleDraft.length, 4)}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle()
                if (e.key === 'Escape') setEditingTitle(false)
              }}
            />
          ) : (
            <button
              className="editor-title"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={beginTitleEdit}
            >
              {workflow.name}
            </button>
          )}
          <span
            className="editor-edit-icon"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={beginTitleEdit}
          >
            <PencilIcon />
          </span>
        </div>
        <div className="meta">{workflow.metaLabel}</div>
      </div>

      <div className="editor-body scroll">
        {showContract && workflow.runContract ? (
          <RunContractPanel
            contract={workflow.runContract}
            onConfirm={confirmContract}
            onCancel={() => setShowContract(false)}
          />
        ) : (
          <>
            <WorkflowSummary summary={workflow.summary} goal={workflow.goal} />

            <RedactionPreview sessionId={workflow.sessionId} />

            <TriggerSection
              trigger={workflow.trigger}
              onChange={(t) => setWorkflow((w) => ({ ...w, trigger: t }))}
            />

            <QuestionsSection questions={workflow.questions} />

            <div className="ledger-section">
              <div className="section-label">STEPS</div>
              <StepList
                steps={workflow.steps}
                onChange={(updater) =>
                  setWorkflow((w) => {
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

      <div className="panel-divider" />
      <div className="panel-footer">
        {confirmDiscard ? (
          <div className="discard-confirm">
            <span>Discard these {workflow.steps.length} steps?</span>
            <button className="cancel-link discard-yes" onClick={cancelEditor}>
              Discard
            </button>
            <button className="btn-text" onClick={() => setConfirmDiscard(false)}>
              Keep
            </button>
          </div>
        ) : (
          <>
            <button className="cancel-link" onClick={() => setConfirmDiscard(true)}>
              <XGlyph />
              Cancel
            </button>
            <div className="footer-actions">
              <button
                className="btn btn-outline"
                onClick={requestRun}
                disabled={showContract}
              >
                Run
              </button>
              <button className="btn btn-primary" onClick={saveWorkflow}>
                Save Workflow
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function XGlyph() {
  return (
    <svg width="7" height="7" viewBox="0 0 7 7" stroke="currentColor" strokeWidth="1.2">
      <path d="M0.8 0.8 6.2 6.2 M6.2 0.8 0.8 6.2" />
    </svg>
  )
}
