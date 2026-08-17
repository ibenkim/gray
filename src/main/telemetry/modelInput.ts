import type {
  ActivitySegment,
  Address,
  PolishedAction,
  PolishedSession,
  ScreenStateRef,
  TelemetrySessionMeta,
  WorkflowVariable
} from '../../shared/telemetry/schema'
import { sanitizeUrl } from '../../shared/telemetry/sanitize'
import { sanitizeModelString } from './modelSanitize'
import { segmentActions } from './segment'

/** Short category codes for the model payload. */
const CAT: Record<PolishedAction['category'], string> = {
  navigation: 'nav',
  interaction: 'act',
  input: 'in',
  submission: 'sub',
  shortcut: 'sc',
  error: 'err',
  recovery: 'rec',
  idle: 'idle',
  session: 'sess',
  clipboard: 'clip'
}

const TY: Record<string, string> = {
  navigation: 'nav',
  interaction: 'act',
  input: 'type',
  submission: 'sub',
  shortcut: 'sc',
  error: 'err',
  recovery: 'rec',
  clipboard: 'clip'
}

const DROP_CATEGORIES = new Set(['sess', 'idle'])
const MAX_ACTIONS = 48
/** Approximate char budget for the packed JSON body before chunking kicks in upstream. */
export const MODEL_INPUT_CHAR_BUDGET = 12_000

/**
 * Compact action row sent to the model.
 * Structured fields preferred over prose `t`.
 *
 * i = order, ty = action-type code, c = category code, ids = short evidence ids,
 * e = element label, r = role, h = clipboard host, ct = clipboard type,
 * tx = typed text, k = inputKind, sb/sa = screen refs, w = waitMs,
 * tr = target resolution, op = semanticOp, inf = inferred, v = verified,
 * nt = narrationText, mk = marker, l1 = l1Op, cp = clipboardPairId,
 * t = fallback prose when structured fields are insufficient
 */
export type CompactModelAction = {
  i: number
  c: string
  ids: string[]
  ty?: string
  t?: string
  a?: string
  d?: string
  e?: string
  r?: string
  h?: string
  ct?: string
  tx?: string
  k?: string
  sb?: string
  sa?: string
  w?: number
  tr?: string
  /** Absolute screen click when recorded. */
  x?: number
  y?: number
  /** Window-relative click offset when recorded. */
  wx?: number
  wy?: number
  op?: string
  inf?: true
  v?: true
  nt?: string
  mk?: string
  l1?: string
  cp?: string
}

export type CompactModelAddress = {
  id: string
  kind: string
  t: string
  p?: Record<string, string>
  pol?: string
  nr?: true
}

export type CompactModelVariable = {
  k: string
  kind: string
  l?: string
  ex?: string
}

export type CompactModelScreen = {
  id: string
  a?: string
  d?: string
  h?: string
}

export type CompactModelSegment = {
  i: number
  kind: string
  a?: string
  d?: string
  acts: CompactModelAction[]
}

/** Wire payload — intentionally terse field names. */
export type CompactWorkflowModelInput = {
  dur?: number
  mode?: 'one-app' | 'full-screen'
  screens?: CompactModelScreen[]
  segs?: CompactModelSegment[]
  /** Flat acts kept for backward-compatible consumers / chunking helpers. */
  acts: CompactModelAction[]
  vars?: CompactModelVariable[]
  /** Deterministic destinations extracted before the model call. */
  addrs?: CompactModelAddress[]
  elided?: true
}

export type PreparedWorkflowModelInput = {
  /** JSON-serializable compact body for the user message. */
  body: CompactWorkflowModelInput
  /** Map short evidence id → full polished sourceEventId. */
  evidenceMap: Map<string, string>
  /** Expand model-returned short ids (or full ids) back to polished event ids. */
  resolveEvidence: (ids: string[]) => string[]
  /** Approximate serialized size (chars). */
  estimatedChars: number
}

/**
 * @deprecated Use prepareWorkflowModelInput — kept for older call sites/tests.
 * Returns the compact body only.
 */
export function createWorkflowModelInput(
  session: TelemetrySessionMeta,
  polishedSession: PolishedSession,
  extras: { variables?: WorkflowVariable[] } = {}
): CompactWorkflowModelInput {
  return prepareWorkflowModelInput(session, polishedSession, extras).body
}

/**
 * Backend prep: filter noise, segment, remap long event ids to short indices,
 * omit nulls/redundant prose, importance-budget selection, pack minimal JSON.
 */
export function prepareWorkflowModelInput(
  session: TelemetrySessionMeta,
  polishedSession: PolishedSession,
  extras: {
    variables?: WorkflowVariable[]
    addresses?: Address[]
    maxActions?: number
  } = {}
): PreparedWorkflowModelInput {
  const evidenceMap = new Map<string, string>()
  let nextId = 0
  const shortId = (full: string): string => {
    for (const [s, f] of evidenceMap) {
      if (f === full) return s
    }
    const s = String(nextId++)
    evidenceMap.set(s, full)
    return s
  }

  const started = Date.parse(session.startedAt)
  const stopped = session.stoppedAt ? Date.parse(session.stoppedAt) : NaN
  const dur =
    Number.isFinite(started) && Number.isFinite(stopped)
      ? Math.max(0, stopped - started)
      : undefined

  const filtered = filterAndCollapse(polishedSession.actions)
  const budget = extras.maxActions ?? MAX_ACTIONS
  const { kept, elided } = selectByImportance(filtered, budget)

  const segments =
    polishedSession.segments && polishedSession.segments.length
      ? polishedSession.segments
      : segmentActions(polishedSession.actions).segments
  const screens =
    polishedSession.screens && polishedSession.screens.length
      ? polishedSession.screens
      : segmentActions(polishedSession.actions).screens

  const screenIndex = packScreens(screens, kept)
  const shortScreen = (full?: string): string | undefined => {
    if (!full) return undefined
    return screenIndex.fullToShort.get(full)
  }

  const acts: CompactModelAction[] = []
  const orderToCompact = new Map<number, CompactModelAction>()

  for (const a of kept) {
    const row = packAction(a, shortId, shortScreen)
    if (!row) continue
    // Re-number for the packed list while retaining original order via `i`.
    row.i = acts.length + 1
    acts.push(row)
    orderToCompact.set(a.order, row)
  }

  const segs = packSegments(segments, orderToCompact, kept)

  const vars = compactVariables(extras.variables ?? [])
  const addrs = compactAddresses(extras.addresses ?? [])

  // Prefer segment-shaped payload; keep flat acts for evidence remap / legacy tests.
  const body: CompactWorkflowModelInput = { acts }
  if (dur != null) body.dur = dur
  if (session.recordMode) body.mode = session.recordMode
  if (screenIndex.screens.length) body.screens = screenIndex.screens
  if (segs.length) body.segs = segs
  if (vars.length) body.vars = vars
  if (addrs.length) body.addrs = addrs
  if (elided) body.elided = true

  const estimatedChars = JSON.stringify(body).length

  return {
    body,
    evidenceMap,
    resolveEvidence: (ids: string[]) =>
      ids.map((id) => evidenceMap.get(id) ?? id).filter(Boolean),
    estimatedChars
  }
}

function packAction(
  a: PolishedAction,
  shortId: (full: string) => string,
  shortScreen: (full?: string) => string | undefined
): CompactModelAction | null {
  const code = CAT[a.category] ?? a.category
  if (DROP_CATEGORIES.has(code)) return null

  const app = sanitizeModelString(a.appName ?? null, 40)
  const el = sanitizeModelString(a.elementLabel ?? null, 40)
  const role = sanitizeModelString(a.elementRole ?? null, 24)
  // Browser AX often puts the page URL in documentTitle — surface host/path to the model.
  const titleUrl =
    a.documentTitle && /^https?:\/\//i.test(a.documentTitle)
      ? sanitizeUrl(a.documentTitle)
      : null
  const doc = sanitizeModelString(
    titleUrl?.urlHost
      ? `${titleUrl.urlHost}${titleUrl.urlPath ?? ''}`.slice(0, 80)
      : (a.documentTitle ?? null),
    60
  )
  const host = sanitizeModelString(
    a.clipboard?.urlHost ??
      (titleUrl && !titleUrl.rejected ? titleUrl.urlHost : null) ??
      a.screenAfter?.urlHost ??
      null,
    60
  )
  const typed = sanitizeModelString(a.typedText ?? null, 120)

  const row: CompactModelAction = {
    i: a.order,
    c: code,
    ids: a.sourceEventIds.map(shortId)
  }

  const ty = actionTypeCode(a)
  if (ty) row.ty = ty

  // Prefer structured fields; include prose only when it adds information.
  const structuredEnough = !!(el || typed || host || a.semanticOp || a.screenAfter)
  if (!structuredEnough) {
    const text = sanitizeModelString(a.text, 100)
    if (text) row.t = text
  } else {
    // Keep a short fallback only when text is not a trivial restatement of e/tx/h/op.
    const text = sanitizeModelString(a.text, 100)
    if (
      text &&
      !isRedundantProse(text, {
        el: el ?? undefined,
        typed: typed ?? undefined,
        host: host ?? undefined,
        op: a.semanticOp
      })
    ) {
      row.t = text
    }
  }

  // App/doc usually live on the segment — only include per-action when they differ
  // or when no segments will carry them (handled by caller leaving them off often).
  // Keep a/d on actions for flat `acts` consumers and when screen refs are absent.
  if (app) row.a = app
  if (doc) row.d = doc
  if (el) row.e = el
  if (role && role !== 'AXUnknown') row.r = role
  if (host) row.h = host
  if (typed) row.tx = typed
  if (a.inputKind && a.inputKind !== 'unknown') row.k = a.inputKind
  if (a.clipboard?.contentType && a.clipboard.contentType !== 'text') {
    row.ct = a.clipboard.contentType
  }
  const sb = shortScreen(a.screenBeforeId)
  const sa = shortScreen(a.screenAfterId)
  if (sb) row.sb = sb
  if (sa) row.sa = sa
  if (a.waitedMs && a.waitedMs >= 1000) row.w = a.waitedMs
  if (a.targetResolution) row.tr = a.targetResolution
  if (a.clickX != null) row.x = a.clickX
  if (a.clickY != null) row.y = a.clickY
  if (a.clickWindowX != null) row.wx = a.clickWindowX
  if (a.clickWindowY != null) row.wy = a.clickWindowY
  if (a.semanticOp) row.op = a.semanticOp
  if (a.inferred) row.inf = true
  if (a.verified) row.v = true
  const narration = sanitizeModelString(a.narrationText ?? null, 160)
  if (narration) row.nt = narration
  if (a.marker) row.mk = a.marker
  if (a.l1Op) row.l1 = a.l1Op
  const pairId = sanitizeModelString(a.clipboardPairId ?? null, 40)
  if (pairId) row.cp = pairId

  return row
}

function actionTypeCode(a: PolishedAction): string | undefined {
  if (a.semanticOp === 'copy') return 'copy'
  if (a.semanticOp === 'paste') return 'paste'
  if (a.semanticOp === 'submit') return 'sub'
  if (a.semanticOp === 'save') return 'save'
  if (a.category === 'input' && a.typedText) return 'type'
  if (a.category === 'interaction' && a.clickX != null) return 'click'
  return TY[a.category]
}

function isRedundantProse(
  text: string,
  parts: { el?: string; typed?: string; host?: string; op?: string }
): boolean {
  const lower = text.toLowerCase()
  const tokens = [parts.el, parts.typed, parts.host].filter(Boolean) as string[]
  if (!tokens.length && !parts.op) return false
  if (tokens.length && tokens.every((t) => lower.includes(t.toLowerCase()))) return true
  // Verb templates like "Copied …" / "Pasted …" add nothing beyond op + host.
  if (parts.op && /^(copied|pasted|typed|clicked|activated|selected|focused)\b/i.test(text)) {
    return tokens.length === 0 || tokens.every((t) => lower.includes(t.toLowerCase()))
  }
  return false
}

function packScreens(
  screens: ScreenStateRef[],
  kept: PolishedAction[]
): { screens: CompactModelScreen[]; fullToShort: Map<string, string> } {
  const needed = new Set<string>()
  for (const a of kept) {
    if (a.screenBeforeId) needed.add(a.screenBeforeId)
    if (a.screenAfterId) needed.add(a.screenAfterId)
  }
  const fullToShort = new Map<string, string>()
  const out: CompactModelScreen[] = []
  let i = 0
  for (const s of screens) {
    if (!needed.has(s.id)) continue
    const short = `s${i++}`
    fullToShort.set(s.id, short)
    const row: CompactModelScreen = { id: short }
    const app = sanitizeModelString(s.appName ?? null, 40)
    const doc = sanitizeModelString(s.documentTitle ?? null, 60)
    const host = sanitizeModelString(s.urlHost ?? null, 60)
    if (app) row.a = app
    if (doc) row.d = doc
    if (host) row.h = host
    out.push(row)
  }
  // Include referenced ids missing from the table.
  for (const id of needed) {
    if (fullToShort.has(id)) continue
    const short = `s${i++}`
    fullToShort.set(id, short)
    out.push({ id: short })
  }
  return { screens: out, fullToShort }
}

function packSegments(
  segments: ActivitySegment[],
  orderToCompact: Map<number, CompactModelAction>,
  kept: PolishedAction[]
): CompactModelSegment[] {
  if (!segments.length) {
    // Single synthetic segment when segmentation was empty.
    if (!kept.length) return []
    return [
      {
        i: 1,
        kind: 'interaction',
        acts: [...orderToCompact.values()]
      }
    ]
  }

  const keptOrders = new Set(kept.map((a) => a.order))
  const segs: CompactModelSegment[] = []
  for (const seg of segments) {
    const sourceActs = seg.actionOrders
      .filter((o) => keptOrders.has(o))
      .map((o) => orderToCompact.get(o))
      .filter((a): a is CompactModelAction => !!a)
    if (!sourceActs.length) continue
    // Clone so stripping a/d for segments does not mutate flat `acts`.
    const acts = sourceActs.map((a) => ({ ...a }))
    const segApp = sanitizeModelString(seg.appName ?? null, 40)
    const segDoc = sanitizeModelString(seg.documentTitle ?? null, 60)
    for (const act of acts) {
      if (segApp && act.a === segApp) delete act.a
      if (segDoc && act.d === segDoc) delete act.d
    }
    const row: CompactModelSegment = {
      i: segs.length + 1,
      kind: seg.kind,
      acts
    }
    if (segApp) row.a = segApp
    if (segDoc) row.d = segDoc
    segs.push(row)
  }
  return segs
}

function compactVariables(variables: WorkflowVariable[]): CompactModelVariable[] {
  return variables.map((v) => {
    const row: CompactModelVariable = {
      k: v.key,
      kind: v.kind
    }
    const label = sanitizeModelString(v.label, 40)
    if (label && label !== v.key) row.l = label
    const ex = sanitizeModelString(v.exampleSanitized, 80)
    if (ex) row.ex = ex
    return row
  })
}

function compactAddresses(addresses: Address[]): CompactModelAddress[] {
  return addresses.slice(0, 20).map((a) => {
    const row: CompactModelAddress = {
      id: a.id,
      kind: a.kind,
      t: sanitizeModelString(a.template, 200) ?? a.template.slice(0, 200)
    }
    if (a.params?.length) {
      row.p = Object.fromEntries(a.params.map((e) => [e.key, e.value]))
    }
    if (a.policy) row.pol = a.policy
    if (a.needsReview) row.nr = true
    return row
  })
}

/**
 * Drop lifecycle/idle noise and collapse consecutive same-document navigations.
 */
function filterAndCollapse(actions: PolishedAction[]): PolishedAction[] {
  const out: PolishedAction[] = []
  for (const a of actions) {
    const code = CAT[a.category] ?? a.category
    if (DROP_CATEGORIES.has(code)) continue

    const prev = out[out.length - 1]
    if (
      prev &&
      (prev.category === 'navigation' || code === 'nav') &&
      a.category === 'navigation' &&
      (prev.appName ?? '') === (a.appName ?? '') &&
      (prev.documentTitle ?? prev.text) === (a.documentTitle ?? a.text)
    ) {
      for (const id of a.sourceEventIds) {
        if (!prev.sourceEventIds.includes(id)) prev.sourceEventIds.push(id)
      }
      if (a.documentTitle && !prev.documentTitle) prev.documentTitle = a.documentTitle
      if (a.screenAfterId) {
        prev.screenAfterId = a.screenAfterId
        prev.screenAfter = a.screenAfter
      }
      if (a.waitedMs) prev.waitedMs = (prev.waitedMs ?? 0) + a.waitedMs
      continue
    }

    out.push({ ...a, sourceEventIds: [...a.sourceEventIds] })
  }
  return out
}

/**
 * Importance-budgeted selection. Never drops verified or submission actions.
 * Drops lowest-value focus/selection noise first.
 */
export function selectByImportance(
  actions: PolishedAction[],
  maxActions: number
): { kept: PolishedAction[]; elided: boolean } {
  if (actions.length <= maxActions) return { kept: actions, elided: false }

  const scored = actions.map((a, index) => ({ a, index, score: importanceScore(a) }))
  // Must-keep set.
  const must = new Set<number>()
  for (const s of scored) {
    if (s.a.verified || s.a.category === 'submission' || s.a.semanticOp === 'submit') {
      must.add(s.index)
    }
  }

  // Sort optional by score ascending (drop lowest first).
  const optional = scored.filter((s) => !must.has(s.index)).sort((x, y) => x.score - y.score)
  const dropCount = actions.length - maxActions
  const drop = new Set<number>()
  for (let i = 0; i < dropCount && i < optional.length; i++) {
    drop.add(optional[i].index)
  }

  // If still over budget (too many must-keep), keep must-keep + highest scored optional.
  let kept = actions.filter((_, i) => !drop.has(i))
  if (kept.length > maxActions) {
    const mustActions = scored.filter((s) => must.has(s.index)).map((s) => s.a)
    const rest = scored
      .filter((s) => !must.has(s.index) && !drop.has(s.index))
      .sort((x, y) => y.score - x.score)
      .slice(0, Math.max(0, maxActions - mustActions.length))
      .map((s) => s.a)
    kept = [...mustActions, ...rest].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.order - b.order
    )
  }

  return { kept, elided: true }
}

function importanceScore(a: PolishedAction): number {
  let score = 0
  if (a.verified) score += 100
  if (a.category === 'submission') score += 80
  if (a.category === 'clipboard' || a.semanticOp === 'copy' || a.semanticOp === 'paste') score += 70
  if (a.category === 'input' || a.typedText) score += 60
  if (a.category === 'navigation') score += 50
  if (a.category === 'shortcut' && a.semanticOp && a.semanticOp !== 'other') score += 45
  if (a.category === 'error') score += 40
  if (a.category === 'interaction') {
    score += a.elementLabel ? 25 : 10
    if (/^Focused /i.test(a.text)) score -= 15
    if (/^Changed selection/i.test(a.text)) score -= 5
  }
  if (a.inferred) score -= 5
  if (a.targetResolution === 'none') score -= 10
  if (a.waitedMs && a.waitedMs >= 5000) score += 15
  return score
}

/** Estimate tokens roughly as chars/4 for metering tests. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4)
}
