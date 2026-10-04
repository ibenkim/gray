import { useWorkflow } from '../state/WorkflowContext'
import { useWindowDrag } from '../hooks/useWindowDrag'
import StatusPill from './shared/StatusPill'
import { PlayPauseControl } from './shared/Marks'

/**
 * The pill IS the character — a paper capsule whose content changes with state.
 * Rendered only in collapsed states; expanded panels replace it.
 */
export default function GhostPill() {
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
    setWatchExpanded,
    setEditorCollapsed,
    runPaused,
    toggleRunPause,
    runElapsedLabel,
    setRunCollapsed,
    hasQuestionHold,
    hasErrorHold,
    permissionPaused,
    permissionHold
  } = useWorkflow()
  // One shared gesture owner (drag vs tap, post-drag click suppression, cancel on blur).
  const { onMouseDown: handleMouseDown } = useWindowDrag({
    preventDefault: true,
    onTap: () => {
      if (savedConfirm && state === 'idle') {
        dismissSavedConfirm()
        return
      }
      if (state === 'idle' || state === 'hover') toggleHover()
    }
  })

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    if (state === 'hover') closeHover()
    window.ghostBridge?.showContextMenu?.()
  }

  const sharedProps = {
    onMouseDown: handleMouseDown,
    onContextMenu: handleContextMenu
  }

  if (state === 'recording') {
    return (
      <StatusPill
        kind={recordPaused ? 'paused' : 'reading'}
        paused={recordPaused}
        onTogglePause={toggleRecordPause}
        label={recordPaused ? 'Paused' : 'Reading…'}
        time={elapsedLabel}
        onClick={() => setWatchExpanded(true)}
        {...sharedProps}
      />
    )
  }

  if (state === 'organizing') {
    return (
      <StatusPill
        kind="thinking"
        label={<span className="pill-blink">Saving…</span>}
        {...sharedProps}
      />
    )
  }

  if (state === 'editor') {
    return (
      <StatusPill
        kind="editing"
        label="Editing"
        onClick={() => setEditorCollapsed(false)}
        {...sharedProps}
      />
    )
  }

  if (state === 'running') {
    const kind = permissionHold
      ? 'interpreting'
      : hasErrorHold
        ? 'error'
        : hasQuestionHold
          ? 'interpreting'
          : 'running'
    return (
      <StatusPill
        kind={kind}
        paused={runPaused}
        onTogglePause={toggleRunPause}
        time={runElapsedLabel}
        onClick={() => setRunCollapsed(false)}
        {...sharedProps}
      />
    )
  }

  if (permissionPaused && (state === 'idle' || state === 'hover')) {
    return (
      <StatusPill kind="permission" label="Paused — needs permission" {...sharedProps} />
    )
  }

  if (savedConfirm && state === 'idle') {
    return (
      <StatusPill
        kind="saved"
        label="Workflow saved ·"
        actionLabel="Open in Library"
        onAction={openSavedInLibrary}
        {...sharedProps}
      />
    )
  }

  // Open is not hover: the capsule looks the same while its dropdown is open (M1-HF3).
  return <StatusPill kind="idle" {...sharedProps} />
}

export function PauseButton({
  paused,
  onToggle
}: {
  paused: boolean
  onToggle: () => void
}) {
  return <PlayPauseControl paused={paused} onToggle={onToggle} />
}

export function ChevronUp() {
  return (
    <svg width="9" height="5" viewBox="0 0 9 5" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M0.5 4.5 4.5 0.5 8.5 4.5" />
    </svg>
  )
}

export function ChevronDown() {
  return (
    <svg width="9" height="5" viewBox="0 0 9 5" fill="none" stroke="currentColor" strokeWidth="1">
      <path d="M0.5 0.5 4.5 4.5 8.5 0.5" />
    </svg>
  )
}
