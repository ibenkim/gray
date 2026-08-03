import {
  SCHEMA_VERSION,
  type AutomationScript,
  type ExtractedWorkflow,
  type PolishedSession,
  type StoredAutomationScript,
  type StoredVariables,
  type StoredWorkflowResult,
  type TelemetryEvent,
  type TelemetrySessionMeta,
  type WorkflowVariable
} from '../../../shared/telemetry/schema'
import type {
  AppendEventsResult,
  CreateSessionInput,
  SessionMetaPatch,
  TelemetryStore
} from './TelemetryStore'

/** Test-only store — never used in production. */
export class InMemoryTelemetryStore implements TelemetryStore {
  sessions = new Map<string, TelemetrySessionMeta>()
  events = new Map<string, TelemetryEvent[]>()
  polished = new Map<string, PolishedSession>()
  workflows = new Map<string, StoredWorkflowResult>()
  variables = new Map<string, StoredVariables>()
  automation = new Map<string, StoredAutomationScript>()
  keyframes = new Map<string, Buffer>()

  async ensureReady(): Promise<void> {
    /* no-op */
  }

  async createSession(input: CreateSessionInput): Promise<TelemetrySessionMeta> {
    const existing = this.sessions.get(input.sessionId)
    if (existing) return existing
    const meta: TelemetrySessionMeta = {
      sessionId: input.sessionId,
      ownerEmail: input.ownerEmail,
      startedAt: new Date().toISOString(),
      captureStatus: 'recording',
      processingStatus: 'not_started',
      schemaVersion: SCHEMA_VERSION,
      recordMode: input.recordMode,
      selectedAppId: input.selectedAppId
    }
    this.sessions.set(input.sessionId, meta)
    this.events.set(input.sessionId, [])
    return meta
  }

  async appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<AppendEventsResult> {
    const list = this.events.get(sessionId) ?? []
    const seen = new Set(list.map((e) => e.eventId))
    let accepted = 0
    let duplicates = 0
    for (const e of events) {
      if (seen.has(e.eventId)) {
        duplicates += 1
        continue
      }
      seen.add(e.eventId)
      list.push(e)
      accepted += 1
    }
    this.events.set(sessionId, list)
    return { accepted, duplicates, rejected: 0 }
  }

  async stopSession(sessionId: string): Promise<TelemetrySessionMeta> {
    return this.updateSessionMeta(sessionId, {
      captureStatus: 'stopped',
      stoppedAt: new Date().toISOString()
    })
  }

  async readSessionEvents(sessionId: string): Promise<TelemetryEvent[]> {
    return [...(this.events.get(sessionId) ?? [])]
  }

  async readPolishedSession(sessionId: string): Promise<PolishedSession | null> {
    return this.polished.get(sessionId) ?? null
  }

  async savePolishedSession(sessionId: string, polished: PolishedSession): Promise<void> {
    this.polished.set(sessionId, polished)
  }

  async saveWorkflow(
    sessionId: string,
    workflow: ExtractedWorkflow,
    model: string,
    opts?: { usage?: import('../../../shared/telemetry/schema').TokenUsage }
  ): Promise<StoredWorkflowResult> {
    const stored: StoredWorkflowResult = {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      model,
      workflow,
      usage: opts?.usage
    }
    this.workflows.set(sessionId, stored)
    return stored
  }

  async getWorkflow(sessionId: string): Promise<StoredWorkflowResult | null> {
    return this.workflows.get(sessionId) ?? null
  }

  async saveVariables(sessionId: string, variables: WorkflowVariable[]): Promise<StoredVariables> {
    const stored: StoredVariables = {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      variables
    }
    this.variables.set(sessionId, stored)
    return stored
  }

  async getVariables(sessionId: string): Promise<StoredVariables | null> {
    return this.variables.get(sessionId) ?? null
  }

  async saveAutomationScript(
    sessionId: string,
    script: AutomationScript,
    model: string,
    opts: { stale?: boolean; usage?: import('../../../shared/telemetry/schema').TokenUsage } = {}
  ): Promise<StoredAutomationScript> {
    const stored: StoredAutomationScript = {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      compiledAt: new Date().toISOString(),
      model,
      script,
      stale: opts.stale ?? false,
      usage: opts.usage
    }
    this.automation.set(sessionId, stored)
    return stored
  }

  async getAutomationScript(sessionId: string): Promise<StoredAutomationScript | null> {
    return this.automation.get(sessionId) ?? null
  }

  async markAutomationStale(
    sessionId: string,
    stale: boolean
  ): Promise<StoredAutomationScript | null> {
    const existing = this.automation.get(sessionId)
    if (!existing) return null
    const next = { ...existing, stale }
    this.automation.set(sessionId, next)
    return next
  }

  async saveKeyframe(
    sessionId: string,
    eventId: string,
    jpeg: Buffer
  ): Promise<{ absolutePath: string; relativePath: string }> {
    const relativePath = `${sessionId}/${eventId}.jpg`
    this.keyframes.set(relativePath, jpeg)
    return { absolutePath: `/tmp/${relativePath}`, relativePath }
  }

  keyframesRoot(): string {
    return '/tmp/keyframes'
  }

  async getSessionMeta(sessionId: string): Promise<TelemetrySessionMeta | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async updateSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<TelemetrySessionMeta> {
    const meta = this.sessions.get(sessionId)
    if (!meta) throw new Error('unknown session')
    const next: TelemetrySessionMeta = {
      ...meta,
      captureStatus: patch.captureStatus ?? meta.captureStatus,
      processingStatus: patch.processingStatus ?? meta.processingStatus,
      stoppedAt: patch.stoppedAt ?? meta.stoppedAt,
      processingErrorCode:
        patch.processingErrorCode === null
          ? undefined
          : (patch.processingErrorCode ?? meta.processingErrorCode)
    }
    this.sessions.set(sessionId, next)
    return next
  }
}
