import { useEffect, useRef } from 'react'
import { beatAt, markPath, swellPath } from './grayMark'

/**
 * Gray's mark family (Figma: node/M-left · node/L · node/M-right).
 *
 * - `IdleMark`     three resting nodes; on hover the outer nodes lean in 2px and darken
 *                  (Teach 1502:882/884, 0.21s ease-out).
 * - `FluidMark`    the running mark: the fluid mark flowing right → left, one node every 3 s
 *                  (Run "mark/running 0…179"), drawn from the portfolio's geometry (grayMark.ts).
 * - `FormingMark`  three nodes with a swelling seed in each gap — waiting on you. Accent = a
 *                  question, rose = something failed (Figma "mark/interpreting").
 * - `DoneMark`     the static fluid silhouette shown when a run completes.
 */

export function IdleMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`mark mark-idle ${className}`}
      width="65"
      height="21"
      viewBox="0 0 65 21"
      fill="none"
      aria-hidden="true"
    >
      <circle className="mark-node mark-node-left" cx="6.5" cy="10.5" r="6.5" />
      <circle className="mark-node mark-node-core" cx="32.5" cy="10.5" r="10.5" />
      <circle className="mark-node mark-node-right" cx="58.5" cy="10.5" r="6.5" />
    </svg>
  )
}

/** The middles of the two gaps, where the seeds sit (Figma "mark/interpreting"). */
const GAPS = [17.5, 47.5]
const seedAt = (cx: number, at: number) => swellPath(cx, 10.5, 4.2, 1.15, 0.5, at)
/** One pass of the swell through both seeds. */
const SWELL_S = 2.4

/**
 * Waiting on you (Figma "mark/interpreting", portfolio GrayPill forming / error): three nodes with a
 * seed in each gap. Nothing moves along; a little volume does instead, like a wave — it swells the left
 * seed's left side, slides through it, passes to the right seed and on through it, then starts over.
 */
export function FormingMark({
  tone = 'accent',
  className = ''
}: {
  tone?: 'accent' | 'rose' | 'ink'
  className?: string
}) {
  const seeds = useRef<(SVGPathElement | null)[]>([])

  useEffect(() => {
    if (prefersReducedMotion()) return
    return runFrames((t) => {
      const u = (t / SWELL_S) % 1
      const at = -0.3 + 2.6 * (0.8 * u + 0.2 * (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2))
      GAPS.forEach((cx, i) => seeds.current[i]?.setAttribute('d', seedAt(cx, at - i)))
    })
  }, [])

  return (
    <svg
      className={`mark mark-forming mark-forming-${tone} ${className}`}
      width="65"
      height="21"
      viewBox="0 0 65 21"
      aria-hidden="true"
    >
      {GAPS.map((cx, i) => (
        <path key={cx} ref={(el) => void (seeds.current[i] = el)} d={seedAt(cx, 0.5 - i)} />
      ))}
      <circle cx="6.5" cy="10.5" r="6.5" />
      <circle cx="32.5" cy="10.5" r="10.5" />
      <circle cx="58.5" cy="10.5" r="6.5" />
    </svg>
  )
}

const DONE_PATH =
  'M0 10C0 7.55 1.46 5.33 3.73 4.34C6 3.35 8.65 3.77 10.49 5.42C12.45 7.19 15.08 8.05 17.72 7.79C20.37 7.53 22.77 6.18 24.35 4.07C26.26 1.51 29.28 0 32.5 0C35.72 0 38.74 1.51 40.65 4.07C42.23 6.18 44.63 7.53 47.28 7.79C49.92 8.05 52.55 7.19 54.51 5.42C57.02 3.17 60.88 3.29 63.23 5.69C65.59 8.09 65.59 11.91 63.23 14.31C60.88 16.71 57.02 16.83 54.51 14.58C52.55 12.81 49.92 11.95 47.28 12.21C44.63 12.47 42.23 13.82 40.65 15.93C38.74 18.49 35.72 20 32.5 20C29.28 20 26.26 18.49 24.35 15.93C22.77 13.82 20.37 12.47 17.72 12.21C15.08 11.95 12.45 12.81 10.49 14.58C8.65 16.23 6 16.65 3.73 15.66C1.46 14.67 0 12.45 0 10Z'

export function DoneMark({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`mark mark-done ${className}`}
      width="65"
      height="20"
      viewBox="0 0 65 20"
      fill="none"
      aria-hidden="true"
    >
      <path d={DONE_PATH} />
    </svg>
  )
}

/* ── Fluid running mark ──────────────────────────────────────────────────────────────── */

/** One node every 3 s, at a nearly even pace (Figma "mark/running 0…179" = one step). */
const STEP_S = 3
/** Pausing lets the flow settle into the mark rather than freezing mid-step. */
const SETTLE_MS = 340
const REST = markPath(0)

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * Calls `frame` with seconds of visible time on every animation frame; time stands still while
 * the window is hidden. Returns the cleanup.
 */
function runFrames(frame: (t: number, dt: number) => boolean | void, start = 0): () => void {
  let raf = 0
  let t = start
  let last = 0
  const tick = (now: number) => {
    const dt = last ? Math.min(0.064, (now - last) / 1000) : 0
    last = now
    t += dt
    if (frame(t, dt) === false) return
    raf = requestAnimationFrame(tick)
  }
  const onVis = () => {
    cancelAnimationFrame(raf)
    last = 0
    if (!document.hidden) raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  document.addEventListener('visibilitychange', onVis)
  return () => {
    cancelAnimationFrame(raf)
    document.removeEventListener('visibilitychange', onVis)
  }
}

/**
 * The running mark (portfolio RunningPill; Figma Gray · 3 Run): the fluid mark flowing slowly right
 * to left like a loading bar, so it reads as moving on into the next node. Each step glides in from a
 * gentle start to a long, soft landing. The path is written straight to the DOM each frame.
 */
export function FluidMark({ paused = false, className = '' }: { paused?: boolean; className?: string }) {
  const pathRef = useRef<SVGPathElement>(null)
  /** Seconds of flow so far; a whole multiple of STEP_S is the mark at rest. */
  const clock = useRef(0)
  /** The beat last drawn (whole numbers are the mark). */
  const beat = useRef(0)

  useEffect(() => {
    const el = pathRef.current
    if (!el) return
    const draw = (b: number) => {
      beat.current = b
      el.setAttribute('d', markPath(-b))
    }
    if (prefersReducedMotion()) {
      draw(Math.round(beat.current))
      return
    }
    if (paused) {
      const from = beat.current
      const to = Math.round(from)
      clock.current = to * STEP_S
      if (Math.abs(to - from) < 1e-4) return draw(to)
      return runFrames((t) => {
        const k = Math.min(1, (t * 1000) / SETTLE_MS)
        draw(from + (to - from) * (1 - (1 - k) ** 3))
        return k < 1
      })
    }
    // Resuming mid-settle: carry on from the nearest rest.
    if (Math.abs(beatAt(clock.current, STEP_S) - beat.current) > 1e-3) {
      clock.current = Math.round(beat.current) * STEP_S
    }
    const from = clock.current
    return runFrames((t) => {
      clock.current = from + t
      draw(beatAt(clock.current, STEP_S))
    })
  }, [paused])

  return (
    <svg
      className={`mark mark-fluid ${paused ? 'mark-fluid-paused' : ''} ${className}`}
      width="65"
      height="20"
      viewBox="0 0 65 20"
      aria-hidden="true"
    >
      <path ref={pathRef} d={REST} />
    </svg>
  )
}

/* ── Controls ────────────────────────────────────────────────────────────────────────── */

export function RecordDot({ className = '' }: { className?: string }) {
  return (
    <svg className={`record-dot ${className}`} width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
      <circle cx="4.5" cy="4.5" r="4.5" fill="var(--gray-color-accent)" />
    </svg>
  )
}

/** 30px circular pause / play control (Figma: Pause · Control/Play). */
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
      aria-label={paused ? 'Resume' : 'Pause'}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <circle className="ppc-ring" cx="15" cy="15" r="14.5" />
        <g className={`ppc-glyph ${paused ? '' : 'ppc-glyph-on'}`}>
          <path d="M12 10V20M18 10V20" strokeWidth="2" strokeLinecap="round" />
        </g>
        <g className={`ppc-glyph ${paused ? 'ppc-glyph-on' : ''}`}>
          <path
            className="ppc-play"
            d="M20.5 14.134C21.1667 14.5189 21.1667 15.4811 20.5 15.866L11.5 21.0622C10.8333 21.4471 10 20.966 10 20.1962L10 9.80385C10 9.03405 10.8333 8.55292 11.5 8.93782L20.5 14.134Z"
          />
        </g>
      </svg>
    </button>
  )
}

/** Legacy name kept for call sites that only need the idle mark. */
export function BrandMark({ className = '' }: { kind?: string; className?: string }) {
  return <IdleMark className={className} />
}
