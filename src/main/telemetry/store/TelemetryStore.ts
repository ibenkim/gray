import type {
  AutomationScript,
  ExtractedWorkflow,
  PolishedSession,
  ProcessingErrorCode,
  ProcessingStatus,
  CaptureStatus,
  StoredAutomationScript,
  StoredVariables,
  StoredWorkflowResult,
  TelemetryEvent,
  TelemetrySessionMeta,
  WorkflowVariable
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
  saveVariables?(sessionId: string, variables: WorkflowVariable[]): Promise<StoredVariables>
  getVariables?(sessionId: string): Promise<StoredVariables | null>
  saveAutomationScript?(
    sessionId: string,
    script: AutomationScript,
    model: string,
    opts?: { stale?: boolean }
  ): Promise<StoredAutomationScript>
  getAutomationScript?(sessionId: string): Promise<StoredAutomationScript | null>
  markAutomationStale?(sessionId: string, stale: boolean): Promise<StoredAutomationScript | null>
  saveKeyframe?(
    sessionId: string,
    eventId: string,
    jpeg: Buffer
  ): Promise<{ absolutePath: string; relativePath: string }>
  /** Absolute root for keyframe files (optional). */
  keyframesRoot?(): string
}
