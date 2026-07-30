import type {
  ExtractedWorkflow,
  PolishedSession,
  ProcessingErrorCode,
  ProcessingStatus,
  CaptureStatus,
  StoredWorkflowResult,
  TelemetryEvent,
  TelemetrySessionMeta
} from '../../../shared/telemetry/schema'

export type CreateSessionInput = {
  sessionId: string
  ownerEmail?: string
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
}

export type AppendEventsResult = {
  accepted: number
  duplicates: number
  rejected: number
}

export type SessionMetaPatch = {
  captureStatus?: CaptureStatus
  processingStatus?: ProcessingStatus
  processingErrorCode?: ProcessingErrorCode | null
  stoppedAt?: string
}

export interface TelemetryStore {
  createSession(input: CreateSessionInput): Promise<TelemetrySessionMeta>
  appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<AppendEventsResult>
  stopSession(sessionId: string): Promise<TelemetrySessionMeta>
  readSessionEvents(sessionId: string): Promise<TelemetryEvent[]>
  readPolishedSession(sessionId: string): Promise<PolishedSession | null>
  savePolishedSession(sessionId: string, polished: PolishedSession): Promise<void>
  saveWorkflow(sessionId: string, workflow: ExtractedWorkflow, model: string): Promise<StoredWorkflowResult>
  getWorkflow(sessionId: string): Promise<StoredWorkflowResult | null>
  getSessionMeta(sessionId: string): Promise<TelemetrySessionMeta | null>
  updateSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<TelemetrySessionMeta>
  ensureReady(): Promise<void>
}
