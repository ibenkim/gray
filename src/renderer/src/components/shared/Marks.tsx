import markFluid from '../../assets/gray/mark-fluid.svg'
import markInterpreting from '../../assets/gray/mark-interpreting.svg'
import markError from '../../assets/gray/mark-error.svg'
import markMuted from '../../assets/gray/mark-muted.svg'
import recordDot from '../../assets/gray/record-dot.svg'
import recordDotArmed from '../../assets/gray/record-dot-armed.svg'
import pauseRing from '../../assets/gray/pause-ring.svg'
import playRing from '../../assets/gray/play-ring.svg'

export type BrandMarkKind = 'fluid' | 'interpreting' | 'error' | 'muted'

const MARK_SRC: Record<BrandMarkKind, string> = {
  fluid: markFluid,
  interpreting: markInterpreting,
  error: markError,
  muted: markMuted
}

export function BrandMark({
  kind = 'fluid',
  className = ''
}: {
  kind?: BrandMarkKind
  className?: string
}) {
  return (
    <span className={`brand-mark ${className}`} aria-hidden="true">
      <img src={MARK_SRC[kind]} alt="" width={65} height={18} draggable={false} />
    </span>
  )
}

export function RecordDot({ armed = false }: { armed?: boolean }) {
  return (
    <img
      src={armed ? recordDotArmed : recordDot}
      alt=""
      width={9}
      height={9}
      className="record-dot"
      draggable={false}
    />
  )
}

export function PlayPauseControl({
  paused,
  onToggle
}: {
  paused: boolean
  onToggle: () => void
}) {
  return (
    <button
      className="play-pause-btn"
      title={paused ? 'Resume' : 'Pause'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <img
        src={paused ? playRing : pauseRing}
        alt=""
        width={18}
        height={18}
        draggable={false}
      />
    </button>
  )
}
