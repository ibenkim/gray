import type { ReactNode } from 'react'
import { BrandMark, PlayPauseControl } from './Marks'

export type StatusPillKind =
  | 'idle'
  | 'running'
  | 'interpreting'
  | 'error'
  | 'reading'
  | 'paused'
  | 'editing'
  | 'thinking'
  | 'saved'
  | 'permission'

type StatusPillProps = {
  kind?: StatusPillKind
  label?: ReactNode
  time?: string
  actionLabel?: string
  onAction?: () => void
  paused?: boolean
  onTogglePause?: () => void
  className?: string
  children?: ReactNode
  onClick?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}

function markForKind(kind: StatusPillKind): 'fluid' | 'interpreting' | 'error' | 'muted' | null {
  if (kind === 'idle') return 'fluid'
  if (kind === 'running') return 'fluid'
  if (kind === 'interpreting') return 'interpreting'
  if (kind === 'error') return 'error'
  return null
}

/**
 * Compact paper status pill — 24px, 0.5px gray-2 hairline, brand mark / run states.
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
  children,
  onClick,
  onMouseDown,
  onContextMenu
}: StatusPillProps) {
  const mark = markForKind(kind)
  const showControl = kind === 'running' || kind === 'reading' || kind === 'paused'
  const idle = kind === 'idle'

  return (
    <div
      className={`pill ${idle ? 'pill-idle' : 'pill-active'} ${className}`}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      onDragStart={(e) => e.preventDefault()}
      draggable={false}
    >
      {showControl && onTogglePause && (
        <PlayPauseControl paused={!!paused} onToggle={onTogglePause} />
      )}
      {kind === 'reading' && <span className="pill-reading-dot" />}
      {kind === 'permission' && <span className="status-dot" />}
      {mark && <BrandMark kind={mark} />}
      {label && <span className="pill-text">{label}</span>}
      {actionLabel && (
        <button
          className="pill-action"
          onClick={(e) => {
            e.stopPropagation()
            onAction?.()
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {actionLabel}
        </button>
      )}
      {time && <span className="pill-time">{time}</span>}
      {children}
    </div>
  )
}
