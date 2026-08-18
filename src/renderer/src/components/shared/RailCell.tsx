export type RailAnchor = 'standard' | 'voice' | 'decision' | 'running'
export type WorkflowRailState =
  | 'formed'
  | 'forming'
  | 'before-forming'
  | 'after-forming'
  | 'muted'
  | 'current'
export type SummaryRailState = 'complete' | 'stopped' | 'unrun'
export type RailKind = 'workflow' | 'summary'

const WORKFLOW_MIN: Record<RailAnchor, number> = {
  standard: 31,
  voice: 56,
  decision: 96,
  running: 31
}

const SUMMARY_MIN: Record<'standard' | 'voice', number> = {
  standard: 29,
  voice: 50
}

type RailCellProps = {
  kind?: RailKind
  anchor?: RailAnchor
  state?: WorkflowRailState | SummaryRailState
  leading?: boolean
  trailing?: boolean
  className?: string
}

/**
 * Row-owned step-rail cell. The 9px node stays aligned to the title while the
 * 1px stem stretches with the row. Leading is off on the first item; trailing
 * is off on the last. Forming uses accent spindles instead of a continuous rod.
 */
export default function RailCell({
  kind = 'workflow',
  anchor = 'standard',
  state = 'formed',
  leading = true,
  trailing = true,
  className = ''
}: RailCellProps) {
  const minHeight =
    kind === 'summary'
      ? SUMMARY_MIN[anchor === 'voice' ? 'voice' : 'standard']
      : WORKFLOW_MIN[anchor]

  const isForming = state === 'forming'
  const isStopped = state === 'stopped'
  const isMuted = state === 'muted' || state === 'unrun' || state === 'complete'
  const isCurrent = state === 'current'
  const isAccent = isForming || isStopped || isCurrent

  const toneClass = isAccent ? 'rail-accent' : isMuted ? 'rail-muted' : 'rail-ink'
  const showLead = leading && !isStopped && !isForming
  const showTrail = trailing && !isStopped && !isForming
  const showLeadSpindle = leading && isForming
  const showTrailSpindle = trailing && isForming

  return (
    <span
      className={`rail-cell ${toneClass} ${className}`}
      style={{ minHeight }}
      aria-hidden="true"
    >
      {showLead && <span className="rail-stem rail-stem-lead" />}
      {showLeadSpindle && <span className="rail-spindle rail-spindle-lead" />}
      {showTrail && <span className="rail-stem rail-stem-trail" />}
      {showTrailSpindle && <span className="rail-spindle rail-spindle-trail" />}
      <span className={`rail-node ${isForming ? 'rail-node-forming' : ''}`} />
    </span>
  )
}
