import { useEffect } from 'react'
import { useWorkflow } from '../state/WorkflowContext'
import GhostPill from './GhostPill'
import LearningPanel from './panels/LearningPanel'
import EditorPanel from './panels/EditorPanel'
import RunningPanel from './panels/RunningPanel'
import SummaryPanel from './panels/SummaryPanel'
import Toast from './shared/Toast'

export default function GhostShell() {
  const {
    state,
    watchExpanded,
    editorCollapsed,
    runCollapsed,
    closeHover,
    permToastVisible,
    permStake,
    permStakeTitle,
    fixPermission,
    dismissPermToast,
    recordingNotice,
    dismissRecordingNotice,
    runRecordingNoticeAction
  } = useWorkflow()
  /*
   * The Record dropdown is its own window (M1-HF3): main dismisses it on Escape inside it,
   * on a second pill click, or once focus leaves both windows. Esc on the pill closes it too.
   */
  useEffect(() => {
    if (state !== 'hover') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeHover()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, closeHover])

  const expandedPanel =
    (state === 'recording' && watchExpanded) ||
    (state === 'editor' && !editorCollapsed) ||
    (state === 'running' && !runCollapsed) ||
    state === 'summary'

  // The revoked-permission toast floats above the pill while idle (hidden while the
  // dropdown is open so the pill keeps its capsule frame).
  const showPermToast = permToastVisible && !expandedPanel && state !== 'hover'
  const showRecordingNotice =
    !!recordingNotice && !expandedPanel && state === 'idle' && !showPermToast
  const showToast = showPermToast || showRecordingNotice

  // Pill mode: the window is exactly the pill capsule, including while the dropdown is open.
  const pillMode = !expandedPanel && !showToast

  const learningOpen = state === 'recording' && watchExpanded
  const panelFlush =
    learningOpen ||
    (state === 'editor' && !editorCollapsed) ||
    (state === 'running' && !runCollapsed)

  const rootClass = [
    'ghost-root',
    pillMode ? 'ghost-root-pill' : '',
    state === 'summary' ? 'ghost-root-summary' : '',
    panelFlush ? 'ghost-root-panel' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <div className="panel-slot">
        {state === 'recording' && watchExpanded && (
          <div className="morph-panel morph-panel-in">
            <LearningPanel />
          </div>
        )}
        {state === 'editor' && !editorCollapsed && (
          <div className="morph-panel morph-panel-in">
            <EditorPanel />
          </div>
        )}
        {state === 'running' && !runCollapsed && (
          <div className="morph-panel morph-panel-in">
            <RunningPanel />
          </div>
        )}
        {state === 'summary' && (
          <div className="morph-panel morph-panel-in">
            <SummaryPanel />
          </div>
        )}
        {showPermToast && (
          <div className="toast-slot">
            <Toast
              tone="apricot"
              title={permStakeTitle}
              body={permStake}
              actionLabel="Fix in System Settings"
              onAction={fixPermission}
              onDismiss={dismissPermToast}
            />
          </div>
        )}
        {showRecordingNotice && recordingNotice && (
          <div className="toast-slot">
            <Toast
              tone={recordingNotice.tone}
              title={recordingNotice.title}
              body={recordingNotice.body}
              actionLabel={recordingNotice.action ? recordingNotice.actionLabel : undefined}
              onAction={recordingNotice.action ? runRecordingNoticeAction : undefined}
              onDismiss={dismissRecordingNotice}
            />
          </div>
        )}
      </div>
      {!expandedPanel && <GhostPill />}
    </div>
  )
}
