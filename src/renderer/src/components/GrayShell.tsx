import { useEffect, useRef, type ReactNode } from 'react'
import { useWorkflow } from '../state/WorkflowContext'
import GrayPill from './GrayPill'
import LearningPanel from './panels/LearningPanel'
import EditorPanel from './panels/EditorPanel'
import RunningPanel from './panels/RunningPanel'
import SummaryPanel from './panels/SummaryPanel'
import Toast from './shared/Toast'
import { MorphCard, usePresence } from './shared/Motion'
import { SUMMARY_W, SURFACE_EXIT_MS, SURFACE_SIZE, surfaceFor } from './pillLayout'

/**
 * The pill window. The pill is always present at its anchor; at most one surface (ledger,
 * editor, run/summary card or toast) opens above it — or below when the pill sits high on
 * the screen. Surfaces grow out of the pill's corner (Teach / Review / Run timelines) and
 * shrink back into it on close.
 */
export default function GrayShell() {
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
    runRecordingNoticeAction,
    placement,
    reportSurfaceHeight
  } = useWorkflow()

  // The Record dropdown is its own window (M1-HF3); Esc on the pill closes it too.
  useEffect(() => {
    if (state !== 'hover') return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeHover()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, closeHover])

  // The revoked-permission toast and recording notices float above the idle pill.
  const panelOpen = surfaceFor({ state, watchExpanded, editorCollapsed, runCollapsed, toast: false })
  const showPermToast = permToastVisible && !panelOpen && state !== 'hover'
  const showRecordingNotice = !!recordingNotice && !panelOpen && state === 'idle' && !showPermToast
  const surface = surfaceFor({
    state,
    watchExpanded,
    editorCollapsed,
    runCollapsed,
    toast: showPermToast || showRecordingNotice
  })

  // A closing toast keeps its last words while it leaves.
  const toastRef = useRef<ReactNode>(null)
  if (showPermToast) {
    toastRef.current = (
      <Toast
        title={permStakeTitle}
        body={permStake}
        actionLabel="Fix in System Settings"
        onAction={fixPermission}
        onDismiss={dismissPermToast}
      />
    )
  } else if (showRecordingNotice && recordingNotice) {
    toastRef.current = (
      <Toast
        tone={recordingNotice.tone}
        title={recordingNotice.title}
        body={recordingNotice.body}
        actionLabel={recordingNotice.action ? recordingNotice.actionLabel : undefined}
        onAction={recordingNotice.action ? runRecordingNoticeAction : undefined}
        onDismiss={dismissRecordingNotice}
      />
    )
  }

  const items = usePresence(surface, SURFACE_EXIT_MS)
  const panelMode = items.length > 0
  const below = panelMode && placement === 'below'

  return (
    <div className={`gray-root ${panelMode ? 'gray-root-panel' : 'gray-root-pill'} ${below ? 'gray-root-below' : ''}`}>
      <div className="shell-stack">
        <div className="surface-slot">
          {items.map(({ key, exiting }) => (
            <div
              key={key}
              className={`surface surface-${key} ${exiting ? 'surface-exit' : 'surface-enter'}`}
              aria-hidden={exiting || undefined}
            >
              {key === 'ledger' && (
                <MorphCard
                  width={SURFACE_SIZE.ledger.w}
                  maxHeight={SURFACE_SIZE.ledger.maxH}
                  className="card-ledger"
                  onMeasure={exiting ? undefined : (h) => reportSurfaceHeight(key, h)}
                >
                  <LearningPanel />
                </MorphCard>
              )}
              {key === 'editor' && (
                <MorphCard
                  width={SURFACE_SIZE.editor.w}
                  maxHeight={SURFACE_SIZE.editor.maxH}
                  className="card-editor"
                  onMeasure={exiting ? undefined : (h) => reportSurfaceHeight(key, h)}
                >
                  <EditorPanel />
                </MorphCard>
              )}
              {key === 'run' && (
                <MorphCard
                  width={state === 'summary' ? SUMMARY_W : SURFACE_SIZE.run.w}
                  maxHeight={SURFACE_SIZE.run.maxH}
                  className={`card-run ${state === 'summary' ? 'card-run-summary' : ''}`}
                  onMeasure={exiting ? undefined : (h) => reportSurfaceHeight(key, h)}
                >
                  {state === 'summary' ? (
                    <div className="run-face run-face-summary" key="summary">
                      <SummaryPanel />
                    </div>
                  ) : (
                    <div className="run-face run-face-running" key="running">
                      <RunningPanel />
                    </div>
                  )}
                </MorphCard>
              )}
              {key === 'toast' && (
                <MorphCard
                  width={SURFACE_SIZE.toast.w}
                  maxHeight={SURFACE_SIZE.toast.maxH}
                  className="card-toast"
                  onMeasure={exiting ? undefined : (h) => reportSurfaceHeight(key, h)}
                >
                  {toastRef.current}
                </MorphCard>
              )}
            </div>
          ))}
        </div>
        <div className="pill-slot">
          <GrayPill />
        </div>
      </div>
    </div>
  )
}
