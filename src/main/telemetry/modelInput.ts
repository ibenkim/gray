import { SCHEMA_VERSION, type PolishedSession, type TelemetrySessionMeta } from '../../shared/telemetry/schema'
import { sanitizeModelString } from './modelSanitize'

export type WorkflowModelAction = {
  order: number
  text: string
  category: string
  timestamp: string
  sourceEventIds: string[]
  appName: string | null
}

export type WorkflowModelInput = {
  schemaVersion: typeof SCHEMA_VERSION
  sessionId: string
  durationMs: number | null
  recordMode: 'one-app' | 'full-screen' | null
  actions: WorkflowModelAction[]
}

/**
 * Build the only payload sent to OpenAI.
 * Excludes ownerEmail, errors, env, paths, and raw event envelopes.
 * Preserves sourceEventIds verbatim (not string-sanitized).
 */
export function createWorkflowModelInput(
  session: TelemetrySessionMeta,
  polishedSession: PolishedSession
): WorkflowModelInput {
  const started = Date.parse(session.startedAt)
  const stopped = session.stoppedAt ? Date.parse(session.stoppedAt) : NaN
  const durationMs =
    Number.isFinite(started) && Number.isFinite(stopped) ? Math.max(0, stopped - started) : null

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
      appName: sanitizeModelString(a.appName ?? null, 80)
    }))
  }
}
