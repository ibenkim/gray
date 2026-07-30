import {
  SCHEMA_VERSION,
  type ExtractedWorkflow,
  type PolishedSession,
  type StoredWorkflowResult,
  type TelemetryEvent,
  type TelemetrySessionMeta
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
    model: string
  ): Promise<StoredWorkflowResult> {
    const stored: StoredWorkflowResult = {
      sessionId,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      model,
      workflow
    }
    this.workflows.set(sessionId, stored)
    return stored
  }

  async getWorkflow(sessionId: string): Promise<StoredWorkflowResult | null> {
    return this.workflows.get(sessionId) ?? null
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
