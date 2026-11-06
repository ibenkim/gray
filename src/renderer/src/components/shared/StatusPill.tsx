import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DoneMark, FluidMark, FormingMark, IdleMark, PlayPauseControl } from './Marks'
import { PILL_WIDTH, type PillKind } from '../pillLayout'

export type StatusPillKind = PillKind

type StatusPillProps = {
  kind?: PillKind
  /** Overrides the default label for text kinds (thinking / saved). */
  label?: ReactNode
  time?: string
  actionLabel?: string
  onAction?: () => void
  paused?: boolean
  onTogglePause?: () => void
  className?: string
  onClick?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
  title?: string
}

const GLASS: PillKind[] = ['thinking', 'saved']

/**
 * The pill is the character: a 36px paper capsule whose contents change with state
 * (Figma: Hero · Pill idle / recording / running / needs you, Status/Paused, v3 status-pill).
 * Width morphs between states (0.34s ease-in-out); the old contents fade out (0.17s ease-in)
 * while the new ones fade in (0.24s ease-out), like the Teach timeline.
 */
export default function StatusPill({
  kind = 'idle',
  label,
  time,
  actionLabel,
  onAction,
  paused,
  onTogglePause,
  className = '',
  onClick,
  onMouseDown,
  onContextMenu,
  title
}: StatusPillProps) {
  const content = renderContent(kind, { label, time, actionLabel, onAction, paused, onTogglePause })
  const contentKey = `${kind}`
  const [exiting, setExiting] = useState<{ key: string; node: ReactNode } | null>(null)
  const last = useRef<{ key: string; node: ReactNode }>({ key: contentKey, node: content })
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Keep the previous contents for one crossfade whenever the kind changes.
  useEffect(() => {
    if (last.current.key !== contentKey) {
      setExiting(last.current)
      clearTimeout(exitTimer.current)
      exitTimer.current = setTimeout(() => setExiting(null), 220)
    }
    last.current = { key: contentKey, node: content }
  })
  useEffect(() => () => clearTimeout(exitTimer.current), [])

  const glass = GLASS.includes(kind)

  return (
    <div
      className={`pill pill-${kind} ${glass ? 'pill-glass' : ''} ${className}`}
      style={{ width: PILL_WIDTH[kind] }}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
      title={title}
      role="status"
    >
      {exiting && exiting.key !== contentKey && (
        <span className="pill-content pill-content-exit" aria-hidden="true">
          {exiting.node}
        </span>
      )}
      <span className="pill-content pill-content-enter" key={contentKey}>
        {content}
      </span>
    </div>
  )
}

function renderContent(
  kind: PillKind,
  p: {
    label?: ReactNode
    time?: string
    actionLabel?: string
    onAction?: () => void
    paused?: boolean
    onTogglePause?: () => void
  }
): ReactNode {
  const control = p.onTogglePause ? (
    <PlayPauseControl paused={!!p.paused} onToggle={p.onTogglePause} />
  ) : null
  const time = p.time ? <span className="pill-time">{p.time}</span> : null

  switch (kind) {
    case 'recording':
      return (
        <span className="pill-row pill-row-control">
          {control}
          <span className="pill-record-dot pulse" />
          <span className="pill-text">{p.label ?? 'Reading...'}</span>
          {time}
        </span>
      )
    case 'paused':
      return (
        <span className="pill-row pill-row-control pill-row-paused">
          {control}
          <span className="pill-text">{p.label ?? 'Paused'}</span>
          {time}
        </span>
      )
    case 'running':
      return (
        <span className="pill-row pill-row-control pill-row-running">
          {control}
          <FluidMark paused={!!p.paused} />
          {time}
        </span>
      )
    case 'needs':
    case 'error':
      return (
        <span className="pill-row pill-row-needs">
          <FormingMark tone={kind === 'error' ? 'rose' : 'accent'} />
          {p.time && <span className="pill-time pill-time-quiet">{p.time}</span>}
        </span>
      )
    case 'thinking':
      return <span className="pill-glass-text breathe-soft">{p.label ?? 'Thinking...'}</span>
    case 'saved':
      return (
        <span className="pill-row pill-row-saved">
          <span className="pill-glass-text">{p.label ?? 'Workflow saved'}</span>
          {p.actionLabel && (
            <button
              className="pill-action"
              onClick={(e) => {
                e.stopPropagation()
                p.onAction?.()
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {p.actionLabel}
            </button>
          )}
        </span>
      )
    case 'editing':
    case 'permission':
      return (
        <span className="pill-row pill-row-mark">
          <FormingMark tone="accent" />
        </span>
      )
    case 'done':
      return (
        <span className="pill-row pill-row-mark">
          <DoneMark />
        </span>
      )
    case 'idle':
    default:
      return (
        <span className="pill-row pill-row-mark">
          <IdleMark />
        </span>
      )
  }
}
