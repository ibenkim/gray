import Toggle from '../ui/Toggle'
import type { RecordMode } from '../../state/types'
import { AppLogo } from '../shared/AppChip'
import type { StepApp } from '../../state/types'

export type RecordPanelProps = {
  recordMode: RecordMode
  onRecordMode: (mode: RecordMode) => void
  apps: Array<{ id: string; name: string; detail: string }>
  /** The installed apps' own icons by id; null while main is still answering. */
  icons?: Record<string, string> | null
  /** "Select apps" is multi-select (Figma Workflow Container shows two chosen). */
  selectedAppIds: string[]
  /** Add or remove an app; the owner keeps at least one chosen. */
  onToggleApp: (id: string) => void
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

const KNOWN_LOGOS = new Set<string>(['notion', 'slack', 'figma', 'chrome'])

/**
 * The app's own macOS icon in the row's 30 × 30 slot (Figma Workflow Container). Until main has
 * answered the slot stays empty; an app that isn't installed falls back to its bundled logo.
 */
function AppIcon({ id, src, pending }: { id: string; src?: string; pending: boolean }) {
  if (src) {
    return (
      <span className="app-icon app-icon-real">
        <img src={src} alt="" draggable={false} />
      </span>
    )
  }
  if (pending) return <span className="app-icon app-icon-real" />
  const known = KNOWN_LOGOS.has(id)
  return (
    <span className={`app-icon ${known ? 'app-icon-logo' : ''}`}>
      {known && <AppLogo id={id as StepApp['id']} />}
    </span>
  )
}

/**
 * 02 — "Record a workflow" (Figma: Workflow Container). Select apps / Full screen with a
 * sliding thumb, app rows, narration switch and Start Recording. A view only: it renders in
 * the Record dropdown window from the pill's snapshot and sends every choice back.
 */
export default function RecordPanel({
  recordMode,
  onRecordMode,
  apps,
  icons = {},
  selectedAppIds,
  onToggleApp,
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
    { value: 'one-app', label: 'Select apps' },
    { value: 'full-screen', label: 'Full screen' }
  ]

  return (
    <div className="record-panel">
      <div className="record-header" onMouseDown={onHeaderMouseDown}>
        Record a workflow
      </div>

      <div
        className={`segmented ${recordMode === 'full-screen' ? 'segmented-right' : ''}`}
        role="radiogroup"
        aria-label="What to record"
      >
        <span className="segmented-thumb" aria-hidden="true" />
        {modes.map((m) => (
          <button
            key={m.value}
            role="radio"
            aria-checked={recordMode === m.value}
            className={`segment ${recordMode === m.value ? 'segment-active' : ''}`}
            onClick={() => onRecordMode(m.value)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="record-body">
        {recordMode === 'one-app' ? (
          <div className="app-list" key="apps" role="group" aria-label="Apps to record">
            {apps.map((app, i) => {
              const selected = selectedAppIds.includes(app.id)
              const onlyOne = selected && selectedAppIds.length === 1
              return (
                <button
                  key={app.id}
                  title={`${app.name} · ${app.detail}`}
                  className={`app-row ${selected ? 'app-row-selected' : ''}`}
                  style={{ ['--i' as string]: i }}
                  onClick={() => onToggleApp(app.id)}
                  role="checkbox"
                  aria-checked={selected}
                  aria-disabled={onlyOne || undefined}
                >
                  <AppIcon id={app.id} src={icons ? icons[app.id] : undefined} pending={icons === null} />
                  <span className="app-name">{app.name}</span>
                  <span className="app-detail">{app.detail}</span>
                  <span className={`radio ${selected ? 'radio-on' : ''}`} />
                </button>
              )
            })}
          </div>
        ) : (
          <div className="desktop-preview" key="screen" aria-label="Your whole screen">
            <div className="desktop-preview-inner">
              <span className="desktop-menubar" />
              <span className="desktop-dock" />
              <span className="desktop-folder" />
              <span className="desktop-folder" />
              <span className="desktop-folder" />
              <span className="desktop-preview-pill" />
            </div>
          </div>
        )}
      </div>

      <div className="narrate-row">
        <span className={`narrate-label ${micGranted ? '' : 'narrate-label-off'}`}>
          {micGranted ? 'Narrate while recording' : 'Mic is off — turn on in Settings'}
        </span>
        {micGranted ? (
          <Toggle checked={narrate} onChange={onNarrate} label="Narrate while recording" />
        ) : (
          <button className="narrate-settings" onClick={onMicSettings}>
            Settings
          </button>
        )}
      </div>

      {screenGranted ? (
        <p className="record-hint">Screenshots are disabled in this build. Actions and text may still be recorded.</p>
      ) : (
        <button className="record-hint record-hint-warn" onClick={onScreenRecovery}>
          Screen Recording is off — turn it on to record
        </button>
      )}
      <button
        className="btn-record"
        disabled={!screenGranted || busy}
        onClick={() => (screenGranted ? onRecord() : onScreenRecovery())}
      >
        Start Recording
      </button>
    </div>
  )
}
