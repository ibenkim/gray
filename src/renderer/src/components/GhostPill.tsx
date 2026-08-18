import { useEffect, useRef } from 'react'
import { useWorkflow } from '../state/WorkflowContext'
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
    openHover,
    closeHover,
    beginDrag,
    endDrag,
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
  const dragging = useRef(false)

  const pressStart = useRef<{ x: number; y: number } | null>(null)

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()
    pressStart.current = { x: e.clientX, y: e.clientY }
  }

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!pressStart.current || dragging.current) return
      const dx = e.clientX - pressStart.current.x
      const dy = e.clientY - pressStart.current.y
      if (dx * dx + dy * dy < 16) return
      dragging.current = true
      const { collapseToPill } = beginDrag()
      window.ghostBridge?.dragStart?.(e.clientX, e.clientY, { collapseToPill })
    }
    function onUp() {
      const wasPress = !!pressStart.current
      pressStart.current = null
      if (dragging.current) {
        dragging.current = false
        endDrag()
        window.ghostBridge?.dragEnd?.()
        return
      }
      if (!wasPress) return
      if (savedConfirm && state === 'idle') {
        dismissSavedConfirm()
        return
      }
      if (state === 'idle') openHover()
      else if (state === 'hover') closeHover()
    }
    function onNativeDragStart(e: DragEvent) {
      e.preventDefault()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('dragend', onUp)
    window.addEventListener('dragstart', onNativeDragStart, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('dragend', onUp)
      window.removeEventListener('dragstart', onNativeDragStart, true)
    }
  }, [
    beginDrag,
    endDrag,
    openHover,
    closeHover,
    state,
    savedConfirm,
    dismissSavedConfirm
  ])

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
        label={<span className="pill-blink">Thinking…</span>}
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

  return (
    <StatusPill
      kind="idle"
      className={state === 'hover' ? 'pill-ready' : ''}
      {...sharedProps}
    />
  )
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
