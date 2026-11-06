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
import { useWindowDrag } from '../../hooks/useWindowDrag'

/**
 * 05 — "Here's what I learned" (Figma: editor · Hero · Review). Sections rise in one after
 * another as the card opens; Run and Save wait until every highlighted question is answered.
 * Esc folds the editor into the pill — Cancel (with confirm) is the only destructive exit.
 */
export default function EditorPanel() {
  const { workflow, setWorkflow, saveWorkflow, runWorkflow, cancelEditor, setEditorCollapsed } =
    useWorkflow()
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [showContract, setShowContract] = useState(false)
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  const openQuestions = workflow.steps.filter((s) => s.fix && !s.fix.collapsed).length
  const blocked = openQuestions > 0

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

  const blockedTitle = blocked
    ? `Answer the highlighted question${openQuestions > 1 ? 's' : ''} first`
    : undefined
  let section = 0
  const rise = (extra = '') => ({
    className: `enter-rise ${extra}`,
    style: { ['--i' as string]: section++ }
  })

  return (
    <div className="editor-panel" onMouseDown={onDragMouseDown}>
      <div {...rise('editor-head')}>
        <div className="editor-eyebrow">Here’s what I learned</div>
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
          {!editingTitle && (
            <span
              className="editor-edit-icon"
              role="button"
              aria-label="Rename"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={beginTitleEdit}
            >
              <PencilIcon />
            </span>
          )}
        </div>
        <div className="editor-meta">{workflow.metaLabel}</div>
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
            {(workflow.summary || workflow.goal) && (
              <div {...rise()}>
                <WorkflowSummary summary={workflow.summary} goal={workflow.goal} />
              </div>
            )}
            {workflow.sessionId && (
              <div {...rise()}>
                <RedactionPreview sessionId={workflow.sessionId} />
              </div>
            )}
            <div {...rise()}>
              <TriggerSection
                trigger={workflow.trigger}
                onChange={(t) => setWorkflow((w) => ({ ...w, trigger: t }))}
              />
            </div>
            {!!workflow.questions?.length && (
              <div {...rise()}>
                <QuestionsSection questions={workflow.questions} />
              </div>
            )}
            <div {...rise('editor-section')}>
              <div className="section-label">Steps</div>
              <StepList
                animateIn
                steps={workflow.steps}
                onChange={(updater) =>
                  setWorkflow((w) => {
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

      <div className="editor-footer enter-rise" style={{ ['--i' as string]: section + 2 }}>
        {confirmDiscard ? (
          <div className="discard-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <span>
              Discard these {workflow.steps.length} steps? Gray won’t keep this recording’s workflow.
            </span>
            <button className="btn btn-quiet" onClick={() => setConfirmDiscard(false)}>
              Keep editing
            </button>
            <button className="btn btn-danger" onClick={cancelEditor}>
              Discard
            </button>
          </div>
        ) : (
          <>
            <button
              className="btn btn-quiet"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setConfirmDiscard(true)}
            >
              Cancel
            </button>
            <div className="window-actions-right" onMouseDown={(e) => e.stopPropagation()}>
              <button
                className="btn btn-secondary"
                onClick={requestRun}
                disabled={showContract || blocked}
                title={blockedTitle}
              >
                Run
              </button>
              <button
                className="btn btn-primary"
                onClick={saveWorkflow}
                disabled={blocked}
                title={blockedTitle}
              >
                Save Workflow
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
