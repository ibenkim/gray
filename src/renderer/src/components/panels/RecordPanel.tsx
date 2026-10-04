import MicIcon from '../ui/MicIcon'
import Toggle from '../ui/Toggle'
import type { RecordMode } from '../../state/types'
import { RecordDot } from '../shared/Marks'

export type RecordPanelProps = {
  recordMode: RecordMode
  onRecordMode: (mode: RecordMode) => void
  apps: Array<{ id: string; name: string; detail: string }>
  selectedAppId: string
  onSelectApp: (id: string) => void
  narrate: boolean
  onNarrate: (on: boolean) => void
  screenGranted: boolean
  micGranted: boolean
  /** Start is in flight or another state owns the pill: Record is unavailable. */
  busy?: boolean
  onRecord: () => void
  onScreenRecovery: () => void
  onMicSettings: () => void
  onHeaderMouseDown?: (e: React.MouseEvent) => void
}

/**
 * 02 — "Record a workflow" panel; Start Recording lives here. A view only: it renders in the
 * Record dropdown window from the pill's snapshot and sends every choice back as a command.
 */
export default function RecordPanel({
  recordMode,
  onRecordMode,
  apps,
  selectedAppId,
  onSelectApp,
  narrate,
  onNarrate,
  screenGranted,
  micGranted,
  busy = false,
  onRecord,
  onScreenRecovery,
  onMicSettings,
  onHeaderMouseDown
}: RecordPanelProps) {
  const modes: { value: RecordMode; label: string }[] = [
    { value: 'one-app', label: 'One app' },
    { value: 'full-screen', label: 'Full screen' }
  ]

  return (
    <div className="window-surface record-panel">
      <div className="record-header" onMouseDown={onHeaderMouseDown}>
        Record a workflow
      </div>

      <div className="segmented">
        {modes.map((m) => (
          <button
            key={m.value}
            className={`segment ${recordMode === m.value ? 'segment-active' : ''}`}
            onClick={() => onRecordMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {recordMode === 'one-app' ? (
        <div className="app-list">
          {apps.map((app) => {
            const selected = app.id === selectedAppId
            return (
              <button
                key={app.id}
                className={`app-row ${selected ? 'app-row-selected' : ''}`}
                onClick={() => onSelectApp(app.id)}
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
          <Toggle checked={narrate} onChange={onNarrate} />
        ) : (
          <button className="narrate-settings" onClick={onMicSettings}>
            Settings
          </button>
        )}
      </div>

      <button
        className="btn-record"
        disabled={!screenGranted || busy}
        onClick={() => (screenGranted ? onRecord() : onScreenRecovery())}
      >
        <RecordDot />
        Record
      </button>
      {screenGranted ? null : (
        <button className="record-hint record-hint-warn" onClick={onScreenRecovery}>
          Screen Recording is off — turn it on to record
        </button>
      )}
    </div>
  )
}
