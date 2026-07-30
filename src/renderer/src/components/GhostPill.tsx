import { useEffect, useRef } from 'react'
import { useWorkflow } from '../state/WorkflowContext'
import StatusPill from './shared/StatusPill'

/**
 * The pill IS the character — a horizontal glass pill whose content changes
 * with state. Rendered only in collapsed states; expanded panels replace it.
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
    workflow,
    setEditorCollapsed,
    runSteps,
    runDoneCount,
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

  // A press only becomes a drag after the cursor moves past a small
  // threshold — a plain click toggles the record panel open/closed.
  const pressStart = useRef<{ x: number; y: number } | null>(null)

  function handleMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
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
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
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

  // ── Recording collapsed: [pause] · "Learning..." · 1:05 · chevron ──
  if (state === 'recording') {
    return (
      <div className="pill pill-active" {...sharedProps}>
        <PauseButton paused={recordPaused} onToggle={toggleRecordPause} />
        <button className="pill-body" onClick={() => setWatchExpanded(true)}>
          <span className="pill-text">{recordPaused ? 'Paused' : 'Learning...'}</span>
          <span className="pill-time">{elapsedLabel}</span>
          <ChevronUp />
        </button>
      </div>
    )
  }

  // ── Organizing: "Thinking..." ──
  if (state === 'organizing') {
    return (
      <StatusPill label={<span className="pill-blink">Thinking...</span>} {...sharedProps} />
    )
  }

  // ── Editor collapsed: "Editing" · chevron ──
  if (state === 'editor') {
    return (
      <div className="pill pill-active" {...sharedProps}>
        <button className="pill-body" onClick={() => setEditorCollapsed(false)}>
          <span className="pill-text">Editing</span>
          <ChevronUp />
        </button>
      </div>
    )
  }

  // ── Running collapsed: [pause] · "name · 3/6" · 1:05 · chevron ──
  if (state === 'running') {
    const tone = permissionHold
      ? 'apricot'
      : hasErrorHold
        ? 'rose'
        : hasQuestionHold
          ? 'amber'
          : 'default'
    return (
      <div
        className={`pill pill-active ${tone === 'amber' ? 'pill-amber' : ''} ${
          tone === 'rose' ? 'pill-rose' : ''
        } ${tone === 'apricot' ? 'pill-apricot' : ''}`}
        {...sharedProps}
      >
        <PauseButton paused={runPaused} onToggle={toggleRunPause} />
        <button className="pill-body" onClick={() => setRunCollapsed(false)}>
          <span className="pill-text">
            {workflow.name}{' '}
            <span className="pill-dim">
              · {runDoneCount}/{runSteps.length}
            </span>
          </span>
          <span className="pill-time">{runElapsedLabel}</span>
          <ChevronUp />
        </button>
      </div>
    )
  }

  // ── Idle / hover: apricot permission pause takes priority ──
  if (permissionPaused && (state === 'idle' || state === 'hover')) {
    return (
      <StatusPill
        tone="apricot"
        showDot
        label="Paused — needs permission"
        {...sharedProps}
      />
    )
  }

  // ── Idle / hover: two-circle mark, or teal saved confirmation ──
  if (savedConfirm && state === 'idle') {
    return (
      <StatusPill
        tone="teal"
        showDot
        label="Workflow saved ·"
        actionLabel="Open in Library"
        onAction={openSavedInLibrary}
        {...sharedProps}
      />
    )
  }

  return (
    <StatusPill
      label={<IdleMark />}
      className={state === 'hover' ? 'pill-ready' : ''}
      {...sharedProps}
    />
  )
}

/** Idle mark — two circles in place of the old "Hello" label. */
function IdleMark() {
  return (
    <span className="pill-mark" aria-label="Ghost">
      <span className="pill-mark-dot" />
      <span className="pill-mark-dot" />
    </span>
  )
}

/** Purple circle with pause bars; toggles to play when paused. */
export function PauseButton({
  paused,
  onToggle
}: {
  paused: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="pause-btn"
      title={paused ? 'Resume' : 'Pause'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {paused ? (
        <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor">
          <path d="M0.5 0.7c0-.55.6-luna-.9 1.07-.62l5.1 3.3a.72.72 0 0 1 0 1.24l-5.1 3.3A.72.72 0 0 1 .5 7.3Z" />
        </svg>
      ) : (
        <svg width="7" height="8" viewBox="0 0 7 8" fill="currentColor">
          <rect x="0.5" width="2" height="8" rx="1" />
          <rect x="4.5" width="2" height="8" rx="1" />
        </svg>
      )}
    </button>
  )
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
