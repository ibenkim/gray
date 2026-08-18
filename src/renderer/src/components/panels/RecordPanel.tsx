import { useWorkflow } from '../../state/WorkflowContext'
import { MOCK_APPS } from '../../state/mockData'
import MicIcon from '../ui/MicIcon'
import Toggle from '../ui/Toggle'
import type { RecordMode } from '../../state/types'
import { useWindowDrag } from '../../hooks/useWindowDrag'
import { RecordDot } from '../shared/Marks'

/** 02 — "Record a workflow" glass panel; Start Recording lives here. */
export default function RecordPanel() {
  const {
    recordMode,
    setRecordMode,
    selectedAppId,
    setSelectedAppId,
    narrate,
    setNarrate,
    startRecording,
    screenGranted,
    micGranted,
    openScreenRecovery
  } = useWorkflow()
  const { onMouseDown: onDragMouseDown } = useWindowDrag()

  const modes: { value: RecordMode; label: string }[] = [
    { value: 'one-app', label: 'One app' },
    { value: 'full-screen', label: 'Full screen' }
  ]

  return (
    <div className="window-surface record-panel">
      <div className="record-header" onMouseDown={onDragMouseDown}>
        Record a workflow
      </div>

      <div className="segmented">
        {modes.map((m) => (
          <button
            key={m.value}
            className={`segment ${recordMode === m.value ? 'segment-active' : ''}`}
            onClick={() => setRecordMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {recordMode === 'one-app' ? (
        <div className="app-list">
          {MOCK_APPS.map((app) => {
            const selected = app.id === selectedAppId
            return (
              <button
                key={app.id}
                className={`app-row ${selected ? 'app-row-selected' : ''}`}
                onClick={() => setSelectedAppId(app.id)}
              >
                <span className="app-icon" />
                <span className="app-name">{app.name}</span>
                <span className="app-detail">{app.detail}</span>
                <span className={`radio ${selected ? 'radio-on' : ''}`} />
              </button>
            )
          })}
        </div>
      ) : (
        <div className="desktop-preview">
          <div className="desktop-preview-inner">
            <span className="desktop-taskbar" />
            <span className="desktop-folder" />
            <span className="desktop-folder" />
            <span className="desktop-folder" />
          </div>
        </div>
      )}

      <div className="narrate-row">
        <div className="narrate-label">
          <MicIcon size={11} />
          <span>
            {micGranted ? 'Narrate while recording' : 'mic is off — turn on in Settings'}
          </span>
        </div>
        {micGranted ? (
          <Toggle checked={narrate} onChange={setNarrate} />
        ) : (
          <button
            className="narrate-settings"
            onClick={() => window.ghostBridge?.openPermissionSettings?.('microphone')}
          >
            Settings
          </button>
        )}
      </div>

      <button
        className="btn-record"
        disabled={!screenGranted}
        onClick={() => (screenGranted ? startRecording() : openScreenRecovery())}
      >
        <RecordDot />
        Record
      </button>
      {screenGranted ? null : (
        <button className="record-hint record-hint-warn" onClick={openScreenRecovery}>
          Screen Recording is off — turn it on to record
        </button>
      )}
    </div>
  )
}
