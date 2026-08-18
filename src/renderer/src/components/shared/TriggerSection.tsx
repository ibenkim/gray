import { useEffect, useRef, useState } from 'react'
import {
  formatSchedule,
  formatTime,
  nextRunPreview,
  upcomingLabel
} from '../../../../shared/schedule'
import type { ScheduleCadence, TimeOfDay, Trigger, Weekday } from '../../state/types'

type CadenceKind = ScheduleCadence['kind']

const WEEKDAY_OPTIONS: { day: Weekday; label: string }[] = [
  { day: 1, label: 'Mon' },
  { day: 2, label: 'Tue' },
  { day: 3, label: 'Wed' },
  { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' },
  { day: 6, label: 'Sat' },
  { day: 0, label: 'Sun' }
]

const DEFAULT_TIME: TimeOfDay = { hour: 9, minute: 0 }

function defaultCadence(kind: CadenceKind): ScheduleCadence {
  switch (kind) {
    case 'daily':
      return { kind: 'daily', time: { ...DEFAULT_TIME } }
    case 'weekly':
      return { kind: 'weekly', days: [5], time: { ...DEFAULT_TIME } }
    case 'monthly':
      return { kind: 'monthly', day: 1, time: { ...DEFAULT_TIME } }
    case 'custom':
      return {
        kind: 'custom',
        label: 'Every 3 days at 9:00 A.M.',
        time: { ...DEFAULT_TIME },
        intervalDays: 3
      }
  }
}

function timeToInput(t: TimeOfDay): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`
}

function inputToTime(value: string): TimeOfDay {
  const [h, m] = value.split(':').map((n) => parseInt(n, 10))
  return {
    hour: Number.isFinite(h) ? Math.min(23, Math.max(0, h)) : 9,
    minute: Number.isFinite(m) ? Math.min(59, Math.max(0, m)) : 0
  }
}

/**
 * TRIGGER section — schedule row + Upcoming preview; click opens the
 * trigger-editor popover (same surface reused by Workspace 1.6).
 */
export default function TriggerSection({
  trigger,
  onChange,
  /** When true, "Turn off trigger" also sets workflow status Off (Workspace). */
  onTurnOff
}: {
  trigger: Trigger
  onChange: (t: Trigger) => void
  onTurnOff?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ScheduleCadence>(
    () => trigger.cadence ?? defaultCadence('weekly')
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const upcoming = upcomingLabel(trigger)

  useEffect(() => {
    if (!open) return
    setDraft(trigger.cadence ?? defaultCadence('weekly'))
  }, [open, trigger.cadence])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [open])

  const preview = nextRunPreview({ cadence: draft })

  return (
    <div className="ledger-section" ref={rootRef}>
      <div className="section-label">TRIGGER</div>
      <button className="trigger-row" onClick={() => setOpen((o) => !o)}>
        {trigger.cadence ? (
          <span className="trigger-text">
            {formatSchedule(trigger.cadence)}
            {upcoming && (
              <span className="trigger-upcoming">   ·   Upcoming: {upcoming}</span>
            )}
          </span>
        ) : (
          <span className="trigger-text trigger-none">No schedule — runs manually</span>
        )}
        <ChevronRight />
      </button>
      {open && (
        <div className="trigger-editor">
          <div className="trigger-segments">
            {(['daily', 'weekly', 'monthly', 'custom'] as CadenceKind[]).map((kind) => (
              <button
                key={kind}
                className={`trigger-segment ${draft.kind === kind ? 'trigger-segment-active' : ''}`}
                onClick={() =>
                  setDraft((d) => (d.kind === kind ? d : defaultCadence(kind)))
                }
              >
                {kind === 'daily'
                  ? 'Daily'
                  : kind === 'weekly'
                    ? 'Weekly'
                    : kind === 'monthly'
                      ? 'Monthly'
                      : 'Custom'}
              </button>
            ))}
          </div>

          <div className="trigger-params">
            {draft.kind === 'weekly' && (
              <div className="trigger-param-row">
                <span className="trigger-param-label">Every</span>
                <div className="trigger-chips">
                  {WEEKDAY_OPTIONS.map(({ day, label }) => {
                    const active = draft.days.includes(day)
                    return (
                      <button
                        key={day}
                        className={`trigger-chip ${active ? 'trigger-chip-active' : ''}`}
                        onClick={() =>
                          setDraft((d) => {
                            if (d.kind !== 'weekly') return d
                            const next = active
                              ? d.days.filter((x) => x !== day)
                              : [...d.days, day]
                            return {
                              ...d,
                              days: (next.length ? next : [day]) as Weekday[]
                            }
                          })
                        }
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {draft.kind === 'monthly' && (
              <div className="trigger-param-row">
                <span className="trigger-param-label">On the</span>
                <input
                  className="trigger-day-input"
                  type="number"
                  min={1}
                  max={31}
                  value={draft.day}
                  onChange={(e) => {
                    const day = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1))
                    setDraft((d) => (d.kind === 'monthly' ? { ...d, day } : d))
                  }}
                />
                <span className="trigger-param-label">at</span>
                <TimeInput
                  value={draft.time}
                  onChange={(time) => setDraft((d) => ({ ...d, time }))}
                />
              </div>
            )}
            {draft.kind === 'daily' && (
              <div className="trigger-param-row">
                <span className="trigger-param-label">At</span>
                <TimeInput
                  value={draft.time}
                  onChange={(time) => setDraft((d) => ({ ...d, time }))}
                />
              </div>
            )}
            {draft.kind === 'weekly' && (
              <div className="trigger-param-row">
                <span className="trigger-param-label">At</span>
                <TimeInput
                  value={draft.time}
                  onChange={(time) => setDraft((d) => ({ ...d, time }))}
                />
              </div>
            )}
            {draft.kind === 'custom' && (
              <div className="trigger-param-row">
                <span className="trigger-param-label">Every</span>
                <input
                  className="trigger-day-input"
                  type="number"
                  min={1}
                  max={365}
                  value={draft.intervalDays}
                  onChange={(e) => {
                    const intervalDays = Math.min(
                      365,
                      Math.max(1, parseInt(e.target.value, 10) || 1)
                    )
                    setDraft((d) =>
                      d.kind === 'custom'
                        ? {
                            ...d,
                            intervalDays,
                            label: `Every ${intervalDays} days at ${formatTime(d.time)}`
                          }
                        : d
                    )
                  }}
                />
                <span className="trigger-param-label">days at</span>
                <TimeInput
                  value={draft.time}
                  onChange={(time) =>
                    setDraft((d) =>
                      d.kind === 'custom'
                        ? {
                            ...d,
                            time,
                            label: `Every ${d.intervalDays} days at ${formatTime(time)}`
                          }
                        : d
                    )
                  }
                />
              </div>
            )}
          </div>

          {preview && <div className="trigger-next">{preview}</div>}

          <div className="trigger-editor-footer">
            <button
              className="btn btn-quiet"
              onClick={() => {
                // Workspace 1.6: Off + schedule retained. Editor: manual-only.
                if (onTurnOff) onTurnOff()
                else onChange({})
                setOpen(false)
              }}
            >
              Turn off trigger
            </button>
            <div className="footer-actions">
              <button className="btn btn-quiet" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn btn-primary btn-small"
                onClick={() => {
                  onChange({ cadence: draft })
                  setOpen(false)
                }}
              >
                Save trigger
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TimeInput({
  value,
  onChange
}: {
  value: TimeOfDay
  onChange: (t: TimeOfDay) => void
}) {
  return (
    <input
      className="trigger-time-input"
      type="time"
      value={timeToInput(value)}
      onChange={(e) => onChange(inputToTime(e.target.value))}
    />
  )
}

function ChevronRight() {
  return (
    <svg
      className="trigger-chevron"
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
    >
      <path d="M3 1.5 6.5 4.5 3 7.5" />
    </svg>
  )
}

export function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}
