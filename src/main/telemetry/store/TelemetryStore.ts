import type {
  AutomationScript,
  ExtractedWorkflow,
  NarrationMarker,
  PolishedSession,
  ProcessingErrorCode,
  ProcessingStatus,
  CaptureStatus,
  StoredAutomationScript,
  StoredVariables,
  StoredWorkflowResult,
  TelemetryEvent,
  TelemetrySessionMeta,
  TokenUsage,
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

/** Persisted voice narration transcript aligned to session elapsedMs. */
export type StoredNarrationSpan = {
  text: string
  startMs: number
  endMs: number
  marker?: NarrationMarker
}

export type StoredNarration = {
  sessionId: string
  spans: StoredNarrationSpan[]
  /** ISO timestamp when transcribed; empty string for capture placeholder. */
  transcribedAt: string
  audioPath?: string
}

export interface TelemetryStore {
  createSession(input: CreateSessionInput): Promise<TelemetrySessionMeta>
  appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<AppendEventsResult>
  stopSession(sessionId: string): Promise<TelemetrySessionMeta>
  readSessionEvents(sessionId: string): Promise<TelemetryEvent[]>
  readPolishedSession(sessionId: string): Promise<PolishedSession | null>
  savePolishedSession(sessionId: string, polished: PolishedSession): Promise<void>
  saveWorkflow(
    sessionId: string,
    workflow: ExtractedWorkflow,
    model: string,
    opts?: { usage?: TokenUsage }
  ): Promise<StoredWorkflowResult>
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
    opts?: { stale?: boolean; usage?: TokenUsage }
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
  saveNarration?(sessionId: string, narration: StoredNarration): Promise<void>
  getNarration?(sessionId: string): Promise<StoredNarration | null>
  /** Persist ground-truth markdown or structured JSON (serialized). */
  saveGroundTruth?(sessionId: string, groundTruth: string | object): Promise<void>
  /** Raw ground-truth file contents (markdown or JSON string), if present. */
  getGroundTruth?(sessionId: string): Promise<string | null>
}
