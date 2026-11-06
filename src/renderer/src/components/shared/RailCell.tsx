export type RailAnchor = 'standard' | 'voice' | 'decision' | 'running' | 'summary'
export type WorkflowRailState =
  | 'formed'
  | 'forming'
  | 'before-forming'
  | 'after-forming'
  | 'muted'
  | 'current'
export type SummaryRailState = 'complete' | 'stopped' | 'unrun'
export type RailKind = 'workflow' | 'summary'
export type RailTone = 'ink' | 'muted' | 'current' | 'accent' | 'rose'

/** Node centre per anchor — aligned to the title line of each row type (Figma 1040:10, 1181:60). */
const NODE_CY: Record<RailAnchor, number> = {
  standard: 16.5,
  voice: 18.5,
  decision: 21.5,
  running: 15.5,
  summary: 15.5
}

const f = (n: number) => +n.toFixed(2)

/** Incoming connector: stem from the top that swells into the node (Gray's organic neck). */
function leadingPath(cy: number) {
  return `M14.5 0V${f(cy - 5.7)}C14.5 ${f(cy - 5)} 14.1 ${f(cy - 4.5)} 13.5 ${f(cy - 4.3)}C11.8 ${f(cy - 3.7)} 10.5 ${f(cy - 2.3)} 10.5 ${f(cy)}C10.5 ${f(cy + 2.5)} 12.5 ${f(cy + 4.5)} 15 ${f(cy + 4.5)}C17.5 ${f(cy + 4.5)} 19.5 ${f(cy + 2.5)} 19.5 ${f(cy)}C19.5 ${f(cy - 2.3)} 18.2 ${f(cy - 3.7)} 16.5 ${f(cy - 4.3)}C15.9 ${f(cy - 4.5)} 15.5 ${f(cy - 5)} 15.5 ${f(cy - 5.7)}V0H14.5Z`
}

/** Outgoing cap: the node tapering into the trailing stem. */
function trailingCapPath(cy: number) {
  return `M15 ${f(cy - 4.5)}C12.5 ${f(cy - 4.5)} 10.5 ${f(cy - 2.5)} 10.5 ${f(cy)}C10.5 ${f(cy + 2.3)} 11.8 ${f(cy + 3.7)} 13.5 ${f(cy + 4.3)}C14.1 ${f(cy + 4.5)} 14.5 ${f(cy + 5)} 14.5 ${f(cy + 5.7)}H15.5C15.5 ${f(cy + 5)} 15.9 ${f(cy + 4.5)} 16.5 ${f(cy + 4.3)}C18.2 ${f(cy + 3.7)} 19.5 ${f(cy + 2.3)} 19.5 ${f(cy)}C19.5 ${f(cy - 2.5)} 17.5 ${f(cy - 4.5)} 15 ${f(cy - 4.5)}Z`
}

/** Accent spindle above a forming node (isolated: it does not touch the node). */
function spindlePath(len: number) {
  return `M14.7 0C13.5 ${f(len * 0.33)} 13.5 ${f(len * 0.67)} 14.7 ${f(len)}C15.9 ${f(len * 0.67)} 15.9 ${f(len * 0.33)} 14.7 0Z`
}

type RailCellProps = {
  kind?: RailKind
  anchor?: RailAnchor
  state?: WorkflowRailState | SummaryRailState
  leading?: boolean
  trailing?: boolean
  /** Forming tone: accent for a question, rose for a failure. */
  formingTone?: 'accent' | 'rose'
  /** Gray (gray-3) regardless of state — a finished step beside a held one. */
  dim?: boolean
  className?: string
}

/**
 * Row-owned step-rail cell. The 9px node sits on the row's title line while the 1px stem
 * stretches with the row; Leading is off on the first item and Trailing on the last.
 * Forming swaps the rod for isolated accent spindles; Before/After Forming omit the side
 * that would touch the forming step; Current is paper over the dark active-step bar.
 */
export default function RailCell({
  kind = 'workflow',
  anchor = 'standard',
  state = 'formed',
  leading = true,
  trailing = true,
  formingTone = 'accent',
  dim = false,
  className = ''
}: RailCellProps) {
  const cy = NODE_CY[kind === 'summary' ? 'summary' : anchor]
  const forming = state === 'forming' || state === 'stopped'
  const tone: RailTone = dim
    ? 'muted'
    : state === 'forming'
      ? formingTone
      : state === 'stopped'
        ? 'accent'
        : state === 'current'
          ? 'current'
          : state === 'muted' || state === 'complete' || state === 'unrun'
            ? 'muted'
            : 'ink'

  const showLead = leading && !forming && state !== 'after-forming'
  const showTrail = trailing && !forming && state !== 'before-forming'
  const showSpindles = state === 'forming'
  const svgH = cy + 6

  return (
    <span className={`rail-cell rail-${tone} ${className}`} aria-hidden="true">
      <svg width="30" height={svgH} viewBox={`0 0 30 ${svgH}`} fill="currentColor">
        {showLead && <path d={leadingPath(cy)} />}
        {showTrail && <path d={trailingCapPath(cy)} />}
        {showSpindles && leading && <path d={spindlePath(cy - 8)} />}
        <circle className={forming ? 'rail-node-pop' : undefined} cx="15" cy={cy} r="4.5" />
      </svg>
      {showTrail && <span className="rail-stem" style={{ top: cy + 5.7 }} />}
      {showSpindles && trailing && (
        <svg
          className="rail-spindle-trail"
          style={{ top: cy + 8, height: `calc(100% - ${cy + 8}px)` }}
          viewBox="0 0 2.4 10"
          preserveAspectRatio="none"
          fill="currentColor"
        >
          <path d="M1.2 0C0 3.3 0 6.7 1.2 10C2.4 6.7 2.4 3.3 1.2 0Z" />
        </svg>
      )}
    </span>
  )
}
