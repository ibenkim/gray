import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  formatSchedule,
  formatTime,
  nextRunPreview,
  parseScheduleText
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

const PRESETS: { kind: CadenceKind; label: string }[] = [
  { kind: 'daily', label: 'Daily' },
  { kind: 'weekly', label: 'Weekly' },
  { kind: 'monthly', label: 'Monthly' },
  { kind: 'custom', label: 'Custom' }
]

const DEFAULT_TIME: TimeOfDay = { hour: 9, minute: 0 }
const UNDERSTAND_MS = 650

function defaultCadence(kind: CadenceKind): ScheduleCadence {
  switch (kind) {
    case 'daily':
      return { kind: 'daily', time: { ...DEFAULT_TIME } }
    case 'weekly':
      return { kind: 'weekly', days: [1], time: { ...DEFAULT_TIME } }
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
 * TRIGGER — the resolved schedule reads as plain text; hover reveals the pencil
 * (Input/Smart trigger · Resolved / Hover). Opening it shows EDIT TRIGGER: a smart field that
 * understands a typed time ("every Monday at 9 AM"), schedule presets, and Turn off / Cancel /
 * Save trigger. `renderPopover` lets the workspace host it in its overlay layer.
 */
export default function TriggerSection({
  trigger,
  onChange,
  onTurnOff,
  renderPopover
}: {
  trigger: Trigger
  onChange: (t: Trigger) => void
  /** When set, "Turn off trigger" also sets workflow status Off (Workspace). */
  onTurnOff?: () => void
  /** Host the editor elsewhere (anchored popover). Without it the editor opens inline. */
  renderPopover?: (args: { anchor: HTMLElement | null; onClose: () => void; content: ReactNode }) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const rowRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Inline editor: Esc / outside press close it (the workspace popover owns its own dismissal).
  useEffect(() => {
    if (!open || renderPopover) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    function onPointer(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('mousedown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onPointer)
    }
  }, [open, renderPopover])

  const editor = open ? (
    <TriggerEditor
      key="editor"
      trigger={trigger}
      inline={!renderPopover}
      onCancel={() => setOpen(false)}
      onSave={(cadence) => {
        onChange({ cadence })
        setOpen(false)
      }}
      onTurnOff={() => {
        if (onTurnOff) onTurnOff()
        else onChange({})
        setOpen(false)
      }}
    />
  ) : null

  return (
    <div className="editor-section trigger-field" ref={rootRef}>
      <div className="section-label">Trigger</div>
      <button
        ref={rowRef}
        className={`trigger-row ${open ? 'trigger-row-open' : ''}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {trigger.cadence ? (
          <span className="trigger-text">{formatSchedule(trigger.cadence)}</span>
        ) : (
          <span className="trigger-text trigger-none">No schedule — runs when you press Run</span>
        )}
        <span className="trigger-pencil">
          <PencilIcon />
        </span>
      </button>
      {editor &&
        (renderPopover
          ? renderPopover({ anchor: rowRef.current, onClose: () => setOpen(false), content: editor })
          : editor)}
    </div>
  )
}

function TriggerEditor({
  trigger,
  inline,
  onCancel,
  onSave,
  onTurnOff
}: {
  trigger: Trigger
  inline: boolean
  onCancel: () => void
  onSave: (cadence: ScheduleCadence) => void
  onTurnOff: () => void
}) {
  const [draft, setDraft] = useState<ScheduleCadence>(() => trigger.cadence ?? defaultCadence('weekly'))
  const [text, setText] = useState(() => (trigger.cadence ? formatSchedule(trigger.cadence) : ''))
  const [dirtyText, setDirtyText] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [notUnderstood, setNotUnderstood] = useState(false)
  const [showParams, setShowParams] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function applyDraft(next: ScheduleCadence) {
    setDraft(next)
    setText(formatSchedule(next))
    setDirtyText(false)
    setNotUnderstood(false)
  }

  /** Enter: read the typed time, show "Understanding trigger…", then resolve to a schedule. */
  function understand() {
    const parsed = parseScheduleText(text)
    if (!parsed) {
      setNotUnderstood(true)
      return
    }
    setThinking(true)
    setNotUnderstood(false)
    timer.current = setTimeout(() => {
      setThinking(false)
      applyDraft(parsed)
    }, UNDERSTAND_MS)
  }

  const preview = nextRunPreview({ cadence: draft })

  return (
    <div
      className={`trigger-popover ${inline ? 'trigger-popover-inline' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Edit trigger"
    >
      <div className="trigger-pop-group">
        <div className="section-label">Edit trigger</div>
        <div className="trigger-input-wrap">
          <div className={`smart-input ${thinking ? 'smart-input-thinking' : ''}`}>
            <input
              ref={inputRef}
              value={thinking ? 'Understanding trigger…' : text}
              readOnly={thinking}
              placeholder="Every Monday at 9:00 AM"
              onChange={(e) => {
                setText(e.target.value)
                setDirtyText(true)
                setNotUnderstood(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (dirtyText) understand()
                  else onSave(draft)
                }
              }}
              aria-label="Trigger"
            />
            <button
              className={`enter-btn ${dirtyText && !thinking ? 'enter-btn-on' : ''}`}
              tabIndex={dirtyText ? 0 : -1}
              aria-label="Apply"
              onClick={understand}
            >
              <EnterIcon />
            </button>
          </div>
          <div className={`trigger-hint ${notUnderstood ? 'trigger-hint-warn' : ''}`}>
            {notUnderstood
              ? 'Try a time, like “every weekday at 4:30 PM”'
              : preview ?? 'Type a condition or a time'}
          </div>
        </div>
      </div>

      <div className="trigger-pop-group">
        <div className="section-label">Or choose a schedule</div>
        <div className="presets" role="radiogroup" aria-label="Schedule">
          {PRESETS.map((p) => (
            <button
              key={p.kind}
              role="radio"
              aria-checked={draft.kind === p.kind}
              className={`preset ${draft.kind === p.kind ? 'preset-active' : ''}`}
              onClick={() => {
                applyDraft(draft.kind === p.kind ? draft : defaultCadence(p.kind))
                setShowParams(true)
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        {showParams && <CadenceParams draft={draft} onChange={applyDraft} />}
      </div>

      <div className="trigger-pop-footer">
        <button className="trigger-off" onClick={onTurnOff}>
          Turn off trigger
        </button>
        <button className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={thinking} onClick={() => onSave(draft)}>
          Save trigger
        </button>
      </div>
    </div>
  )
}

function CadenceParams({
  draft,
  onChange
}: {
  draft: ScheduleCadence
  onChange: (c: ScheduleCadence) => void
}) {
  return (
    <div className="trigger-params" key={draft.kind}>
      {draft.kind === 'weekly' && (
        <div className="trigger-param-row">
          <span>Every</span>
          {WEEKDAY_OPTIONS.map(({ day, label }) => {
            const active = draft.days.includes(day)
            return (
              <button
                key={day}
                className={`day-chip ${active ? 'day-chip-on' : ''}`}
                aria-pressed={active}
                onClick={() => {
                  const next = active ? draft.days.filter((x) => x !== day) : [...draft.days, day]
                  onChange({ ...draft, days: (next.length ? next : [day]) as Weekday[] })
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
      <div className="trigger-param-row">
        {draft.kind === 'monthly' && (
          <>
            <span>On day</span>
            <input
              className="param-input param-day"
              type="number"
              min={1}
              max={31}
              value={draft.day}
              onChange={(e) => {
                const day = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1))
                onChange({ ...draft, day })
              }}
            />
          </>
        )}
        {draft.kind === 'custom' && (
          <>
            <span>Every</span>
            <input
              className="param-input param-day"
              type="number"
              min={1}
              max={365}
              value={draft.intervalDays}
              onChange={(e) => {
                const intervalDays = Math.min(365, Math.max(1, parseInt(e.target.value, 10) || 1))
                onChange({
                  ...draft,
                  intervalDays,
                  label: `Every ${intervalDays} days at ${formatTime(draft.time)}`
                })
              }}
            />
            <span>days</span>
          </>
        )}
        <span>at</span>
        <input
          className="param-input param-time"
          type="time"
          value={timeToInput(draft.time)}
          onChange={(e) => {
            const time = inputToTime(e.target.value)
            onChange(
              draft.kind === 'custom'
                ? { ...draft, time, label: `Every ${draft.intervalDays} days at ${formatTime(time)}` }
                : { ...draft, time }
            )
          }}
        />
      </div>
    </div>
  )
}

function EnterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d="M9.5 2.5V4.75C9.5 5.85457 8.60457 6.75 7.5 6.75H2.5M4.75 9L2.5 6.75L4.75 4.5"
        stroke="var(--gray-color-paper)"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Edit pencil (Figma 1522:616). */
export function PencilIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path
        d="M7.5 1.5L9.5 3.5L4 9H2V7L7.5 1.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export { EnterIcon }
