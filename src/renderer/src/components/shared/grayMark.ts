// Geometry for Gray's mark in motion, kept apart from the React so it can be drawn frame by frame.
// Ported verbatim from the portfolio (hk-portfolio components/case/grayMark.ts), which generated the
// Figma "mark/running 0…179" flipbook (Gray · 3 Run, 1505:515): 180 frames = one 3 s step.

// Figma "mark/fluid" (65 × 20) repeats every 52 units: big node, neck, small node, neck. PROFILE[i] is its
// half-height at u = i / 20, with a big node's apex at u = 0, from the mark's own curves.
const PERIOD = 52
const PROFILE = (() => {
  const seg = [
    [0, 0, 3.217, 0, 6.243, 1.51, 8.151, 4.067],
    [8.151, 4.067, 9.727, 6.178, 12.134, 7.53, 14.777, 7.788],
    [14.777, 7.788, 17.419, 8.047, 20.049, 7.186, 22.012, 5.422],
    [22.012, 5.422, 24.864, 2.859, 27.136, 2.859, 29.988, 5.422],
    [29.988, 5.422, 31.951, 7.186, 34.581, 8.047, 37.223, 7.788],
    [37.223, 7.788, 39.866, 7.53, 42.273, 6.178, 43.849, 4.067],
    [43.849, 4.067, 45.757, 1.51, 48.783, 0, 52, 0]
  ]
  const pts: number[][] = []
  for (const c of seg)
    for (let i = 0; i < 200; i++) {
      const t = i / 200
      const u = 1 - t
      const b = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
      pts.push([
        b[0] * c[0] + b[1] * c[2] + b[2] * c[4] + b[3] * c[6],
        10 - (b[0] * c[1] + b[1] * c[3] + b[2] * c[5] + b[3] * c[7])
      ])
    }
  pts.push([PERIOD, 10])
  const out = new Float32Array(PERIOD * 20 + 1)
  let j = 0
  for (let i = 0; i < out.length; i++) {
    const x = i / 20
    while (j < pts.length - 2 && pts[j + 1][0] < x) j++
    const [x0, h0] = pts[j]
    const [x1, h1] = pts[j + 1]
    out[i] = h0 + ((h1 - h0) * (x - x0)) / (x1 - x0 || 1)
  }
  return out
})()
const wave = (u: number) => {
  const v = (((u % PERIOD) + PERIOD) % PERIOD) * 20
  const i = Math.floor(v)
  return PROFILE[i] + (PROFILE[i + 1] - PROFILE[i]) * (v - i)
}

// Running, the mark's nodes move simply left to right, a step at a time, and a node's size is where it
// is: the one in the middle is always the biggest. So a node swells as it comes to the middle and eases
// back to small as it moves on. Its ends stay where they are: at the left a new node grows out of the
// end as the row moves off it, and at the right the last one shrinks away under the one arriving. Mid-step
// there are four, nothing is ever cut off, and every step comes back to the mark. Pass a falling beat to
// run it the other way.
//
// The outline is plain geometry: each node a circle, each neck a rod between neighbouring centres,
// thinnest between them, all joined by one smooth union, so every frame is a single seamless shape.
const W = 65
const STEP = 26 // node to node, at rest
const NECK = 0.24 // the rod's waist, against the pair's harmonic mean radius
const BOW = 0.025 // how fast the rod opens toward the nodes
const JOIN = 2.5 // rods into nodes
const FILLET = 1.2 // node into node (they only meet at the ends)
// Node into node: a circular fillet (Quilez), so a small node on a big one meets it in a round neck.
const sminRound = (a: number, b: number, k: number) => {
  const r = k / (1 - Math.SQRT1_2)
  return Math.max(r, Math.min(a, b)) - Math.hypot(Math.max(r - a, 0), Math.max(r - b, 0))
}
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}
function field(x: number, y: number, nodes: number[][]) {
  let d = Infinity
  for (const [p, r] of nodes) {
    const v = Math.hypot(x - p, y) - r
    d = d === Infinity ? v : sminRound(d, v, FILLET)
  }
  for (let i = 1; i < nodes.length; i++) {
    const [p1, r1] = nodes[i - 1]
    const [p2, r2] = nodes[i]
    const k1 = r1 ** 1.5
    const xn = p1 + ((p2 - p1) * k1) / (k1 + r2 ** 1.5)
    const c = Math.min(Math.max(x, p1), p2)
    const open = (NECK * 2 * r1 * r2) / (r1 + r2) + BOW * (c - xn) ** 2
    const half = smin(open, 0.6 * Math.min(r1, r2), 1.5) // always well inside the smaller node
    // Along the rod its half-height; past either end, a round cap.
    d = smin(d, x === c ? Math.abs(y) - half : Math.hypot(x - c, y) - half, JOIN)
  }
  return d
}
function model(x: number, nodes: number[][]) {
  if (field(x, 0, nodes) > 0) return 0
  let lo = 0
  let hi = 12
  for (let i = 0; i < 22; i++) {
    const m = (lo + hi) / 2
    if (field(x, m, nodes) > 0) hi = m
    else lo = m
  }
  return lo
}
// The nodes `shift` units into a step (0 to STEP).
function nodesAt(shift: number) {
  const u = shift / STEP
  const ease = (v: number) => {
    const c = Math.min(1, Math.max(0, v))
    return c * c * (3 - 2 * c)
  }
  // Big (10) in the middle, easing to small (6.5) a step either side.
  const size = (x: number) => 10 - 3.5 * ease(Math.abs(x - W / 2) / STEP)
  const a = 6.5 + STEP * u
  const b = W / 2 + STEP * u
  return [
    [6.5, 6.5 * ease(u)], // growing at the left end
    [a, size(a)],
    [b, size(b)],
    [W - 6.5, 6.5 * (1 - ease(u))] // shrinking at the right end
  ].filter(([, r]) => r > 0.05)
}
// What the geometry misses of the mark's own curves at rest, put back as the flow settles into rest.
const REST = nodesAt(0)
const FIX = Float32Array.from({ length: W * 20 + 1 }, (_, i) => {
  const x = i / 20
  const end = Math.min(x, W - x)
  const mark = end < 6.5 ? Math.sqrt(Math.max(0, 6.5 * 6.5 - (6.5 - end) ** 2)) : wave(x - W / 2)
  return mark - model(x, REST)
})

const f = (n: number) => n.toFixed(2)

/** The running mark, 65 × 20, `beat` steps into its flow (whole numbers are the mark). */
export function markPath(beat: number) {
  const shift = (((beat * STEP) % STEP) + STEP) % STEP
  const nodes = nodesAt(shift)
  // Wide enough for the soft blends, which reach a little past the nodes.
  const from = Math.min(...nodes.map(([p, r]) => p - r)) - 3
  const to = Math.max(...nodes.map(([p, r]) => p + r)) + 3
  const rest = Math.exp(-((Math.min(shift, STEP - shift) / 2) ** 2))
  const n = 180
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i <= n; i++) {
    const x = from + ((to - from) / 2) * (1 - Math.cos((Math.PI * i) / n))
    const j = Math.round(x * 20)
    const fix = j >= 0 && j < FIX.length ? FIX[j] * rest : 0
    const h = Math.max(0, model(x, nodes) + fix)
    top.push(`${f(x)} ${f(10 - h)}`)
    bottom.push(`${f(x)} ${f(10 + h)}`)
  }
  return `M${top.join('L')}L${bottom.reverse().join('L')}Z`
}

/**
 * Where the flow is after t seconds, in steps, a step every `period` seconds: each step glides in from a
 * gentle start to a long, soft landing, and a slight constant drift underneath keeps it from ever
 * stopping (at the turn of a step it's crawling at about 15% of its average pace).
 */
export const beatAt = (t: number, period: number) => {
  const n = Math.floor(t / period)
  const f = t / period - n
  const s = (1 - Math.cos(Math.PI * f)) / 2
  return n + 0.85 * (1 - (1 - s) ** 1.35) + 0.15 * f
}

/**
 * Gray's seed (Figma "Constant rod → rails", forming), a lens pointed at both ends, carrying a little
 * extra volume at `at` (0 its left point, 1 its right; outside that, none): a
 * swell `extra` thick, which slides through it as `at` moves.
 */
export function swellPath(cx: number, cy: number, a: number, c: number, extra: number, at: number) {
  const n = 48
  const top: string[] = []
  const bottom: string[] = []
  for (let i = 0; i <= n; i++) {
    const u = i / n
    const lens = Math.sin(Math.PI * u) ** 0.9
    const h = lens * (c + extra * Math.exp(-(((u - at) / 0.3) ** 2)))
    const x = cx - a + 2 * a * u
    top.push(`${f(x)} ${f(cy - h)}`)
    bottom.push(`${f(x)} ${f(cy + h)}`)
  }
  return `M${top.join('L')}L${bottom.reverse().join('L')}Z`
}
