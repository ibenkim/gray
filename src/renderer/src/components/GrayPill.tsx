import { useWorkflow } from '../state/WorkflowContext'
import { useWindowDrag } from '../hooks/useWindowDrag'
import StatusPill from './shared/StatusPill'
import { pillKindFor } from './pillLayout'

/**
 * The pill stays on screen in every state; panels open above it. A tap toggles whatever the
 * pill owns right now (record dropdown, ledger, editor, run panel); a drag moves the window.
 */
export default function GrayPill() {
  const {
    state,
    savedConfirm,
    openSavedInLibrary,
    dismissSavedConfirm,
    closeHover,
    toggleHover,
    elapsedLabel,
    recordPaused,
    toggleRecordPause,
    watchExpanded,
    setWatchExpanded,
    editorCollapsed,
    setEditorCollapsed,
    runPaused,
    toggleRunPause,
    runElapsedLabel,
    runCollapsed,
    setRunCollapsed,
    hasQuestionHold,
    hasErrorHold,
    permissionPaused,
    permissionHold,
    summaryOutcome
  } = useWorkflow()

  // One shared gesture owner (drag vs tap, post-drag click suppression, cancel on blur).
  const { onMouseDown } = useWindowDrag({
    preventDefault: true,
    onTap: () => {
      if (state === 'idle' && savedConfirm) {
        dismissSavedConfirm()
        return
      }
      if (state === 'idle' || state === 'hover') toggleHover()
      else if (state === 'recording') setWatchExpanded(!watchExpanded)
      else if (state === 'editor') setEditorCollapsed(!editorCollapsed)
      else if (state === 'running') setRunCollapsed(!runCollapsed)
    }
  })

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (state === 'hover') closeHover()
    window.grayBridge?.showContextMenu?.()
  }

  const kind = pillKindFor({
    state,
    recordPaused,
    hasErrorHold,
    hasQuestionHold,
    permissionHold,
    permissionPaused,
    savedConfirm: !!savedConfirm,
    summaryDone: summaryOutcome === 'done'
  })

  const common = { onMouseDown, onContextMenu }

  if (kind === 'recording' || kind === 'paused') {
    return (
      <StatusPill
        kind={kind}
        paused={recordPaused}
        onTogglePause={toggleRecordPause}
        time={elapsedLabel}
        title={watchExpanded ? 'Hide what Gray has learned' : 'Show what Gray has learned'}
        {...common}
      />
    )
  }
  if (kind === 'running' || kind === 'needs' || kind === 'error') {
    return (
      <StatusPill
        kind={kind}
        paused={runPaused}
        onTogglePause={kind === 'running' ? toggleRunPause : undefined}
        time={runElapsedLabel}
        {...common}
      />
    )
  }
  if (kind === 'saved') {
    return (
      <StatusPill
        kind="saved"
        actionLabel="Open in Library"
        onAction={openSavedInLibrary}
        {...common}
      />
    )
  }
  // Open is not hover: the capsule looks the same while its dropdown is open (M1-HF3).
  return <StatusPill kind={kind} {...common} />
}
