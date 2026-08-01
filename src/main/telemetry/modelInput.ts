import type {
  PolishedAction,
  PolishedSession,
  TelemetrySessionMeta,
  WorkflowVariable
} from '../../shared/telemetry/schema'
import { sanitizeModelString } from './modelSanitize'

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

const DROP_CATEGORIES = new Set(['sess', 'idle'])
const MAX_ACTIONS = 48
const MAX_TEXT = 100

/**
 * Compact action row sent to the model.
 * Only defined fields are included (nulls omitted).
 *
 * i = order, t = text, c = category code, ids = short evidence ids,
 * a = app, d = document, e = element label, r = role,
 * h = clipboard host, ct = clipboard type, tx = typed text,
 * inf = inferred, v = verified
 */
export type CompactModelAction = {
  i: number
  t: string
  c: string
  ids: string[]
  a?: string
  d?: string
  e?: string
  r?: string
  h?: string
  ct?: string
  tx?: string
  inf?: true
  v?: true
}

export type CompactModelVariable = {
  k: string
  kind: string
  l?: string
  ex?: string
}

/** Wire payload — intentionally terse field names. */
export type CompactWorkflowModelInput = {
  dur?: number
  mode?: 'one-app' | 'full-screen'
  acts: CompactModelAction[]
  vars?: CompactModelVariable[]
}

export type PreparedWorkflowModelInput = {
  /** JSON-serializable compact body for the user message. */
  body: CompactWorkflowModelInput
  /** Map short evidence id → full polished sourceEventId. */
  evidenceMap: Map<string, string>
  /** Expand model-returned short ids (or full ids) back to polished event ids. */
  resolveEvidence: (ids: string[]) => string[]
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
 * Backend prep: filter noise, remap long event ids to short indices,
 * omit nulls, and pack a minimal JSON body for OpenAI.
 */
export function prepareWorkflowModelInput(
  session: TelemetrySessionMeta,
  polishedSession: PolishedSession,
  extras: { variables?: WorkflowVariable[] } = {}
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

  const acts: CompactModelAction[] = []
  for (const a of filtered.slice(0, MAX_ACTIONS)) {
    const text = sanitizeModelString(a.text, MAX_TEXT)
    if (!text) continue

    const row: CompactModelAction = {
      i: acts.length + 1,
      t: text,
      c: CAT[a.category] ?? a.category,
      ids: a.sourceEventIds.map(shortId)
    }

    const app = sanitizeModelString(a.appName ?? null, 40)
    const doc = sanitizeModelString(a.documentTitle ?? null, 60)
    const el = sanitizeModelString(a.elementLabel ?? null, 40)
    const role = sanitizeModelString(a.elementRole ?? null, 24)
    const host = sanitizeModelString(a.clipboard?.urlHost ?? null, 60)

    // Skip fields already implied by text when identical — still keep structured
    // fields the model prefers over prose.
    if (app) row.a = app
    if (doc) row.d = doc
    if (el) row.e = el
    if (role && role !== 'AXUnknown') row.r = role
    if (host) row.h = host
    const typed = sanitizeModelString(a.typedText ?? null, 120)
    if (typed) row.tx = typed
    if (a.clipboard?.contentType && a.clipboard.contentType !== 'text') {
      row.ct = a.clipboard.contentType
    }
    if (a.inferred) row.inf = true
    if (a.verified) row.v = true

    acts.push(row)
  }

  const vars = compactVariables(extras.variables ?? [])

  const body: CompactWorkflowModelInput = { acts }
  if (dur != null) body.dur = dur
  if (session.recordMode) body.mode = session.recordMode
  if (vars.length) body.vars = vars

  return {
    body,
    evidenceMap,
    resolveEvidence: (ids: string[]) =>
      ids.map((id) => evidenceMap.get(id) ?? id).filter(Boolean)
  }
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
      // Merge evidence ids into the prior nav row.
      for (const id of a.sourceEventIds) {
        if (!prev.sourceEventIds.includes(id)) prev.sourceEventIds.push(id)
      }
      if (a.documentTitle && !prev.documentTitle) prev.documentTitle = a.documentTitle
      continue
    }

    out.push({ ...a, sourceEventIds: [...a.sourceEventIds] })
  }
  return out
}
