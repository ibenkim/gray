import { useEffect, useRef, useState } from 'react'
import { useWorkflow } from '../state/WorkflowContext'
import GhostPill from './GhostPill'
import RecordPanel from './panels/RecordPanel'
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
    panelPlacement,
    hoverFading,
    hoverDismissMode,
    reportHoverPanelHeight,
    permToastVisible,
    permStake,
    permStakeTitle,
    fixPermission,
    dismissPermToast,
    organizeError,
    lastTelemetrySessionId,
    dismissOrganizeError,
    retryOrganize
  } = useWorkflow()
  const [switchFlash, setSwitchFlash] = useState(false)

  // The hover window hugs its content exactly (no padding) — measure the
  // panel and report its height for window sizing.
  const hoverPanelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (state !== 'hover' || !hoverPanelRef.current) return
    const el = hoverPanelRef.current
    reportHoverPanelHeight(el.offsetHeight)
    const observer = new ResizeObserver(() => reportHoverPanelHeight(el.offsetHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [state, reportHoverPanelHeight])

  /**
   * Brief macOS-like inactive wash on the pill + panel when switching to
   * another desktop window (Cmd-Tab / click away). Not a persistent gray box.
   */
  useEffect(() => {
    let flashTimer: ReturnType<typeof setTimeout> | null = null
    function onBlur() {
      setSwitchFlash(true)
      if (flashTimer) clearTimeout(flashTimer)
      flashTimer = setTimeout(() => {
        setSwitchFlash(false)
        flashTimer = null
      }, 160)
    }
    function onFocus() {
      if (flashTimer) {
        clearTimeout(flashTimer)
        flashTimer = null
      }
      setSwitchFlash(false)
    }
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      if (flashTimer) clearTimeout(flashTimer)
    }
  }, [])

  /**
   * Record-panel dismissal rules (panel opens only by clicking the pill):
   * 1. Pill click again toggles it closed (handled in GhostPill).
   * 2. A click outside the panel + pill dismisses it (window blur).
   * 3. Esc dismisses it.
   */
  useEffect(() => {
    if (state !== 'hover') return
    function onBlur() {
      closeHover()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [state, closeHover])

  // Esc dismisses the record panel.
  useEffect(() => {
    if (state !== 'hover') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeHover()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, closeHover])

  // Empty glass chrome after close must not steal clicks from apps below.
  useEffect(() => {
    function applyIgnore(ignoreEmpty: boolean) {
      if (!ignoreEmpty) {
        window.ghostBridge?.setIgnoreMouseEvents?.(false)
        return
      }
      window.ghostBridge?.setIgnoreMouseEvents?.(false)
    }
    const oversizedIdle = () => state === 'idle' && window.innerHeight > 48
    if (!oversizedIdle()) {
      applyIgnore(false)
      return
    }
    applyIgnore(false)
    function onMove(e: MouseEvent) {
      if (!oversizedIdle()) {
        window.ghostBridge?.setIgnoreMouseEvents?.(false)
        return
      }
      const el = e.target as HTMLElement | null
      const hit = el?.closest?.('.pill, .toast-slot, .toast')
      window.ghostBridge?.setIgnoreMouseEvents?.(!hit, { forward: true })
    }
    function onResize() {
      if (!oversizedIdle()) window.ghostBridge?.setIgnoreMouseEvents?.(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('resize', onResize)
      window.ghostBridge?.setIgnoreMouseEvents?.(false)
    }
  }, [state])

  const expandedPanel =
    (state === 'recording' && watchExpanded) ||
    (state === 'editor' && !editorCollapsed) ||
    (state === 'running' && !runCollapsed) ||
    state === 'summary'

  // The revoked-permission toast floats above the pill while idle.
  const showPermToast = permToastVisible && !expandedPanel && state !== 'hover'
  const showOrganizeError =
    !!organizeError && !expandedPanel && state === 'idle' && !showPermToast
  const showToast = showPermToast || showOrganizeError

  // Pill mode: the window is sized exactly to the pill (native blur/shadow)
  // unless we kept the glass frame after close (no shrink snap).
  const oversizedFrame =
    typeof window !== 'undefined' && window.innerHeight > 48
  const pillMode = !expandedPanel && state !== 'hover' && !showToast
  const dockBelow =
    panelPlacement === 'below' &&
    (state === 'hover' || (pillMode && oversizedFrame))

  const learningOpen = state === 'recording' && watchExpanded
  const panelFlush =
    learningOpen ||
    (state === 'editor' && !editorCollapsed) ||
    (state === 'running' && !runCollapsed)

  const rootClass = [
    'ghost-root',
    pillMode ? 'ghost-root-pill' : '',
    state === 'hover' ? 'ghost-root-glass' : '',
    state === 'hover' && hoverFading ? 'ghost-root-closing' : '',
    state === 'summary' ? 'ghost-root-summary' : '',
    panelFlush ? 'ghost-root-panel' : '',
    !panelFlush && dockBelow ? 'ghost-root-below' : '',
    switchFlash ? 'os-switch-flash' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      <div className="panel-slot">
        {state === 'hover' && (
          <div
            ref={hoverPanelRef}
            className={[
              'morph-panel',
              hoverFading
                ? hoverDismissMode === 'drag'
                  ? 'morph-panel-drag'
                  : 'morph-panel-out'
                : 'morph-panel-in'
            ].join(' ')}
          >
            <RecordPanel />
          </div>
        )}
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
        {showOrganizeError && (
          <div className="toast-slot">
            <Toast
              tone="error"
              title="Couldn’t organize that recording"
              body={organizeError ?? undefined}
              actionLabel={lastTelemetrySessionId ? 'Retry' : undefined}
              onAction={lastTelemetrySessionId ? () => void retryOrganize() : undefined}
              onDismiss={dismissOrganizeError}
            />
          </div>
        )}
      </div>
      {!expandedPanel && <GhostPill />}
    </div>
  )
}
