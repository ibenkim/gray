import {
  SCHEMA_VERSION,
  type PolishedSession,
  type TelemetrySessionMeta,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import { sanitizeModelString } from './modelSanitize'

export type WorkflowModelAction = {
  order: number
  text: string
  category: string
  timestamp: string
  sourceEventIds: string[]
  appName: string | null
  documentTitle: string | null
  elementLabel: string | null
  elementRole: string | null
  clipboardHost: string | null
  clipboardContentType: string | null
  keyframePath: string | null
  inferred: boolean | null
  verified: boolean | null
}

export type WorkflowModelScreen = {
  appName: string | null
  documentTitle: string | null
  urlHost: string | null
  timestamp: string
}

export type WorkflowModelClipboard = {
  contentType: string
  urlHost: string | null
  urlPath: string | null
  charCount: number | null
  timestamp: string
}

export type WorkflowModelInput = {
  schemaVersion: typeof SCHEMA_VERSION
  sessionId: string
  durationMs: number | null
  recordMode: 'one-app' | 'full-screen' | null
  actions: WorkflowModelAction[]
  screens: WorkflowModelScreen[]
  clipboardEvents: WorkflowModelClipboard[]
  variables: Array<{
    key: string
    label: string
    kind: string
    exampleSanitized: string | null
  }>
  keyframeCount: number
}

/**
 * Build the only payload sent to OpenAI.
 * Excludes ownerEmail, errors, env, absolute paths, and raw clipboard values.
 * Preserves sourceEventIds verbatim (not string-sanitized).
 */
export function createWorkflowModelInput(
  session: TelemetrySessionMeta,
  polishedSession: PolishedSession,
  extras: {
    variables?: WorkflowVariable[]
  } = {}
): WorkflowModelInput {
  const started = Date.parse(session.startedAt)
  const stopped = session.stoppedAt ? Date.parse(session.stoppedAt) : NaN
  const durationMs =
    Number.isFinite(started) && Number.isFinite(stopped) ? Math.max(0, stopped - started) : null

  const screens: WorkflowModelScreen[] = []
  const clipboardEvents: WorkflowModelClipboard[] = []
  let keyframeCount = 0
  const seenScreens = new Set<string>()

  for (const a of polishedSession.actions) {
    if (a.documentTitle || a.appName) {
      const key = `${a.appName ?? ''}|${a.documentTitle ?? ''}`
      if (!seenScreens.has(key)) {
        seenScreens.add(key)
        screens.push({
          appName: sanitizeModelString(a.appName ?? null, 80),
          documentTitle: sanitizeModelString(a.documentTitle ?? null, 120),
          urlHost: a.clipboard?.urlHost
            ? sanitizeModelString(a.clipboard.urlHost, 120)
            : null,
          timestamp: a.timestamp
        })
      }
    }
    if (a.clipboard) {
      clipboardEvents.push({
        contentType: a.clipboard.contentType,
        urlHost: sanitizeModelString(a.clipboard.urlHost ?? null, 120),
        urlPath: sanitizeModelString(a.clipboard.urlPath ?? null, 120),
        charCount: a.clipboard.charCount ?? null,
        timestamp: a.timestamp
      })
    }
    if (a.keyframePath) keyframeCount += 1
  }

  const variables = (extras.variables ?? []).map((v) => ({
    key: v.key,
    label: sanitizeModelString(v.label, 120) ?? v.key,
    kind: v.kind,
    exampleSanitized: sanitizeModelString(v.exampleSanitized, 200)
  }))

  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: session.sessionId,
    durationMs,
    recordMode: session.recordMode ?? null,
    actions: polishedSession.actions.map((a) => ({
      order: a.order,
      text: sanitizeModelString(a.text, 200) ?? '[redacted]',
      category: a.category,
      timestamp: a.timestamp,
      sourceEventIds: [...a.sourceEventIds],
      appName: sanitizeModelString(a.appName ?? null, 80),
      documentTitle: sanitizeModelString(a.documentTitle ?? null, 120),
      elementLabel: sanitizeModelString(a.elementLabel ?? null, 120),
      elementRole: sanitizeModelString(a.elementRole ?? null, 64),
      clipboardHost: sanitizeModelString(a.clipboard?.urlHost ?? null, 120),
      clipboardContentType: a.clipboard?.contentType ?? null,
      // Relative path only — strip anything that looks absolute.
      keyframePath: relativeKeyframeOnly(a.keyframePath),
      inferred: a.inferred ?? null,
      verified: a.verified ?? null
    })),
    screens,
    clipboardEvents,
    variables,
    keyframeCount
  }
}

function relativeKeyframeOnly(path: string | undefined | null): string | null {
  if (!path) return null
  if (path.includes('..') || path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) {
    return null
  }
  return sanitizeModelString(path, 200)
}
