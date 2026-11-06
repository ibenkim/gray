import { useEffect, useRef } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import MicIcon from '../ui/MicIcon'
import AppChip from '../shared/AppChip'
import { useWindowDrag } from '../../hooks/useWindowDrag'
import RichText from '../shared/RichText'

/**
 * 3.2 — expanded recording ledger (Figma: recording-expanded-panel · Hero · Recording).
 * Each understood action rises in at the bottom; the card grows upward from the pill
 * (Teach "Rises" / "Panel"). "Now · Thinking..." breathes. Cancel discards; Finish is the
 * only stop control. The pill below shows Reading… and toggles this panel.
 */
export default function LearningPanel() {
  const { watchLog, setWatchExpanded, cancelRecording, finishRecording, recordPaused } = useWorkflow()
  const logRef = useRef<HTMLDivElement>(null)
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  // New steps append without stealing focus, but keep the latest in view.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [watchLog.length])

  // Esc folds the ledger back into the pill (recording continues).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setWatchExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setWatchExpanded])

  return (
    <div className="ledger" onMouseDown={onDragMouseDown}>
      <div className="watch-log" ref={logRef}>
        {watchLog.map((entry, i) => (
          <div className="watch-entry" key={`${entry.time}-${i}`}>
            <div className="watch-entry-main">
              <span className="watch-time">{entry.time}</span>
              <span className="watch-text">
                <RichText text={entry.text} />
                {entry.app && <AppChip app={entry.app} small />}
              </span>
            </div>
            {entry.voiceNote && (
              <div className="watch-voice">
                <MicIcon size={11} />
                <span>{entry.voiceNote}</span>
              </div>
            )}
          </div>
        ))}
        <div className="watch-entry watch-entry-now">
          <div className="watch-entry-main">
            <span className="watch-time">Now</span>
            <span className={`watch-text ${recordPaused ? '' : 'breathe'}`}>
              {recordPaused ? 'Paused' : 'Thinking...'}
            </span>
          </div>
        </div>
      </div>

      <div className="ledger-footer">
        <button
          className="btn btn-quiet"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={cancelRecording}
        >
          Cancel
        </button>
        <button
          className="btn btn-primary"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={finishRecording}
        >
          Finish
        </button>
      </div>
    </div>
  )
}
