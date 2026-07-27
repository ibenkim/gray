import { useEffect, useRef, useState } from 'react'
import { useWorkflow } from '../../state/WorkflowContext'
import { PauseButton, ChevronDown } from '../GhostPill'
import MicIcon from '../ui/MicIcon'
import AppChip from '../shared/AppChip'
import { useWindowDrag } from '../../hooks/useWindowDrag'

/**
 * 3.2 — expanded recording ledger. Header: [pause] · "Learning Workflow" ·
 * timer · chevron. Footer: Cancel (discard) · Finish (the only stop control).
 */
export default function LearningPanel() {
  const {
    watchLog,
    setWatchExpanded,
    cancelRecording,
    finishRecording,
    elapsedLabel,
    recordPaused,
    toggleRecordPause
  } = useWorkflow()
  const [openVoiceIdx, setOpenVoiceIdx] = useState<number | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  // New steps append without stealing focus, but keep the latest in view.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [watchLog.length])

  return (
    <div className="ledger-panel">
      <div className="ledger-header" onMouseDown={onDragMouseDown}>
        <PauseButton paused={recordPaused} onToggle={toggleRecordPause} />
        <span className="ledger-title">Learning Workflow</span>
        <span className="ledger-time">{elapsedLabel}</span>
        <button
          className="chevron-btn"
          onClick={() => setWatchExpanded(false)}
          onMouseDown={(e) => e.stopPropagation()}
          title="Collapse"
        >
          <ChevronDown />
        </button>
      </div>

      <div className="watch-log scroll" ref={logRef}>
        {watchLog.map((entry, i) => (
          <div className="watch-entry" key={`${entry.time}-${i}`}>
            <div className="watch-entry-main">
              <span className="watch-time">{entry.time}</span>
              <span className="watch-text">{entry.text}</span>
              {entry.app && <AppChip app={entry.app} muted />}
              {entry.voiceNote && (
                <button
                  className={`voice-tag ${openVoiceIdx === i ? 'voice-tag-open' : ''}`}
                  onClick={() => setOpenVoiceIdx(openVoiceIdx === i ? null : i)}
                >
                  <MicIcon size={7} />
                  voice
                </button>
              )}
            </div>
            {entry.voiceNote && openVoiceIdx === i && (
              <div className="watch-voice">
                <MicIcon size={8} />
                <span className="watch-voice-text">{entry.voiceNote}</span>
              </div>
            )}
          </div>
        ))}
        <div className="watch-entry">
          <div className="watch-entry-main">
            <span className="watch-time">Now</span>
            <span className="watch-text watch-text-thinking">Thinking...</span>
          </div>
        </div>
      </div>

      <div className="ledger-footer">
        <button className="cancel-link" onClick={cancelRecording}>
          <XGlyph />
          Cancel
        </button>
        <button className="btn-small-outline" onClick={finishRecording}>
          Finish
        </button>
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
