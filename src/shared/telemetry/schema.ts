import { z } from 'zod'

export const SCHEMA_VERSION = 1 as const

export const TelemetryEventTypeSchema = z.enum([
  'session_started',
  'session_stopped',
  'navigation',
  'click',
  'text_input',
  'field_completed',
  'selection_changed',
  'form_submitted',
  'keyboard_shortcut',
  'error',
  'screen_changed',
  'focus_changed',
  'clipboard_changed',
  'paste_detected',
  'element_activated',
  'keyframe_captured'
])

export type TelemetryEventType = z.infer<typeof TelemetryEventTypeSchema>

export const ViewportSchema = z.object({
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative()
})

export const TelemetryTargetSchema = z
  .object({
    role: z.string().max(64).optional(),
    tagName: z.string().max(64).optional(),
    accessibleLabel: z.string().max(120).optional(),
    visibleLabel: z.string().max(80).optional(),
    analyticsId: z.string().max(120).optional(),
    fieldType: z.string().max(64).optional(),
    formLabel: z.string().max(120).optional(),
    appName: z.string().max(120).optional(),
    appBundleId: z.string().max(200).optional()
  })
  .strict()

export type TelemetryTarget = z.infer<typeof TelemetryTargetSchema>

export const ValueCategorySchema = z.enum([
  'empty',
  'text',
  'email',
  'phone',
  'url',
  'number',
  'date',
  'selection',
  'boolean',
  'sensitive',
  'redacted',
  'unknown'
])

export type ValueCategory = z.infer<typeof ValueCategorySchema>

export const FieldDataSchema = z
  .object({
    label: z.string().max(120).optional(),
    fieldType: z.string().max(64).optional(),
    completed: z.boolean().optional(),
    valueCategory: ValueCategorySchema.optional(),
    valueLength: z.number().int().nonnegative().optional(),
    /** Only present when the field is on the explicit allowlist. */
    sanitizedValue: z.string().max(200).optional()
  })
  .strict()

export const ClipboardContentTypeSchema = z.enum(['url', 'text', 'image', 'file', 'other'])
export type ClipboardContentType = z.infer<typeof ClipboardContentTypeSchema>

/** Sanitized clipboard metadata — never the raw value. */
export const ClipboardDataSchema = z
  .object({
    contentType: ClipboardContentTypeSchema,
    urlHost: z.string().max(200).optional(),
    urlPath: z.string().max(200).optional(),
    charCount: z.number().int().nonnegative().optional(),
    contentHash: z.string().max(64)
  })
  .strict()

export type ClipboardData = z.infer<typeof ClipboardDataSchema>

export const ElementBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  })
  .strict()

export type ElementBounds = z.infer<typeof ElementBoundsSchema>

export const TargetResolutionSchema = z.enum(['ax', 'coords', 'none'])
export type TargetResolution = z.infer<typeof TargetResolutionSchema>

export const SemanticOpSchema = z.enum([
  'copy',
  'paste',
  'save',
  'submit',
  'undo',
  'redo',
  'select_all',
  'cut',
  'other'
])
export type SemanticOp = z.infer<typeof SemanticOpSchema>

export const ScreenAfterDeltaSchema = z
  .object({
    appName: z.string().max(120).optional(),
    documentTitle: z.string().max(200).optional(),
    urlHost: z.string().max(200).optional()
  })
  .strict()

export type ScreenAfterDelta = z.infer<typeof ScreenAfterDeltaSchema>

export const ScreenStateRefSchema = z
  .object({
    id: z.string().max(80),
    appName: z.string().max(120).optional(),
    documentTitle: z.string().max(200).optional(),
    urlHost: z.string().max(200).optional()
  })
  .strict()

export type ScreenStateRef = z.infer<typeof ScreenStateRefSchema>

export const ActivitySegmentKindSchema = z.enum([
  'navigation',
  'interaction',
  'data_transfer',
  'waiting',
  'review'
])
export type ActivitySegmentKind = z.infer<typeof ActivitySegmentKindSchema>

export const ActivitySegmentSchema = z
  .object({
    id: z.string().min(1).max(80),
    index: z.number().int().nonnegative(),
    kind: ActivitySegmentKindSchema,
    appName: z.string().max(120).optional(),
    documentTitle: z.string().max(200).optional(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    actionOrders: z.array(z.number().int().positive()).min(1)
  })
  .strict()

export type ActivitySegment = z.infer<typeof ActivitySegmentSchema>

export const TelemetryEventDataSchema = z
  .object({
    appName: z.string().max(120).optional(),
    appBundleId: z.string().max(200).optional(),
    windowTitle: z.string().max(200).optional(),
    urlHost: z.string().max(200).optional(),
    urlPath: z.string().max(200).optional(),
    shortcut: z.string().max(64).optional(),
    message: z.string().max(300).optional(),
    field: FieldDataSchema.optional(),
    selectionLabel: z.string().max(120).optional(),
    formLabel: z.string().max(120).optional(),
    headings: z.array(z.string().max(80)).max(12).optional(),
    buttons: z.array(z.string().max(80)).max(20).optional(),
    dialogs: z.array(z.string().max(80)).max(8).optional(),
    loading: z.boolean().optional(),
    errorState: z.string().max(200).optional(),
    successMessage: z.string().max(200).optional(),
    idleGapMs: z.number().int().nonnegative().optional(),
    ignored: z.boolean().optional(),
    documentTitle: z.string().max(200).optional(),
    elementRole: z.string().max(64).optional(),
    elementSubrole: z.string().max(64).optional(),
    elementLabel: z.string().max(120).optional(),
    elementPath: z.array(z.string().max(80)).max(3).optional(),
    selectedLabels: z.array(z.string().max(120)).max(5).optional(),
    clipboard: ClipboardDataSchema.optional(),
    charCountDelta: z.number().int().optional(),
    matchedClipboardHash: z.string().max(64).optional(),
    inferred: z.boolean().optional(),
    verified: z.boolean().optional(),
    /** Relative path only — never base64, never absolute. */
    keyframePath: z.string().max(300).optional(),
    /**
     * Text the user typed, after redaction. Absent when the target was a
     * password/secure field or the text redacted down to nothing.
     */
    typedText: z.string().max(500).optional(),
    /** True when redaction removed part of the typed text. */
    typedTextRedacted: z.boolean().optional(),
    /** Physical key presses behind a text_input event (includes edits). */
    keyCount: z.number().int().nonnegative().optional(),
    /** Key that ended the entry, e.g. "Return" or "Tab". */
    submitKey: z.string().max(24).optional(),
    clickButton: z.enum(['left', 'right']).optional(),
    clickCount: z.number().int().positive().max(10).optional(),
    /** Screen coordinates of a click (top-left origin), when observed. */
    clickX: z.number().int().optional(),
    clickY: z.number().int().optional(),
    /** Accessibility frame of the target element (top-left origin), when observed. */
    elementBounds: ElementBoundsSchema.optional()
  })
  .strict()

export type TelemetryEventData = z.infer<typeof TelemetryEventDataSchema>

export const TelemetryEventSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    eventId: z.string().min(1).max(80),
    sessionId: z.string().min(1).max(80),
    sequence: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
    elapsedMs: z.number().int().nonnegative(),
    type: TelemetryEventTypeSchema,
    page: z.string().max(200).optional(),
    route: z.string().max(300).optional(),
    viewport: ViewportSchema.optional(),
    target: TelemetryTargetSchema.optional(),
    data: TelemetryEventDataSchema.optional(),
    screenStateId: z.string().max(80).optional()
  })
  .strict()

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>

export const CaptureStatusSchema = z.enum(['recording', 'stopped', 'failed'])
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>

export const ProcessingStatusSchema = z.enum([
  'not_started',
  'polishing',
  'summarizing',
  'complete',
  'failed'
])
export type ProcessingStatus = z.infer<typeof ProcessingStatusSchema>

/** Safe machine codes only — never raw OpenAI / credential text. */
export const ProcessingErrorCodeSchema = z.enum([
  'OPENAI_API_KEY_MISSING',
  'OPENAI_AUTHENTICATION_FAILED',
  'OPENAI_REQUEST_FAILED',
  'OPENAI_INVALID_OUTPUT',
  'OPENAI_UNKNOWN_EVIDENCE',
  'POLISH_FAILED',
  'WORKFLOW_EMPTY_ACTIONS',
  'WORKFLOW_ALREADY_RUNNING',
  'SESSION_NOT_READY',
  'AUTOMATION_COMPILE_FAILED',
  'AUTOMATION_SCRIPT_MISSING',
  'AUTOMATION_ACCESSIBILITY_DENIED'
])
export type ProcessingErrorCode = z.infer<typeof ProcessingErrorCodeSchema>

export const TelemetrySessionMetaSchema = z
  .object({
    sessionId: z.string().min(1).max(80),
    ownerEmail: z.string().email().optional(),
    startedAt: z.string().datetime(),
    stoppedAt: z.string().datetime().optional(),
    captureStatus: CaptureStatusSchema,
    processingStatus: ProcessingStatusSchema,
    processingErrorCode: ProcessingErrorCodeSchema.optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    recordMode: z.enum(['one-app', 'full-screen']).optional(),
    selectedAppId: z.string().max(80).optional(),
    /**
     * Legacy single status kept optional for older meta files.
     * Prefer captureStatus + processingStatus.
     */
    status: z.enum(['recording', 'stopped', 'processing', 'ready', 'failed']).optional(),
    /** @deprecated Never write raw vendor errors here. */
    error: z.string().max(400).optional()
  })
  .strict()

export type TelemetrySessionMeta = z.infer<typeof TelemetrySessionMetaSchema>

/**
 * Normalize legacy `{ status }` meta into captureStatus + processingStatus.
 * Strips unsafe `error` strings that may contain API-key material.
 */
export function normalizeSessionMeta(raw: unknown): TelemetrySessionMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>

  let captureStatus = data.captureStatus as CaptureStatus | undefined
  let processingStatus = data.processingStatus as ProcessingStatus | undefined
  const legacy = data.status as string | undefined

  if (!captureStatus || !processingStatus) {
    switch (legacy) {
      case 'recording':
        captureStatus = 'recording'
        processingStatus = 'not_started'
        break
      case 'stopped':
        captureStatus = 'stopped'
        processingStatus = 'not_started'
        break
      case 'processing':
        captureStatus = 'stopped'
        processingStatus = 'summarizing'
        break
      case 'ready':
        captureStatus = 'stopped'
        processingStatus = 'complete'
        break
      case 'failed':
        captureStatus = 'stopped'
        processingStatus = 'failed'
        break
      default:
        captureStatus = captureStatus ?? 'stopped'
        processingStatus = processingStatus ?? 'not_started'
    }
  }

  const processingErrorCode =
    typeof data.processingErrorCode === 'string' &&
    ProcessingErrorCodeSchema.safeParse(data.processingErrorCode).success
      ? (data.processingErrorCode as ProcessingErrorCode)
      : legacy === 'failed'
        ? 'OPENAI_REQUEST_FAILED'
        : undefined

  const candidate = {
    sessionId: data.sessionId,
    ownerEmail: data.ownerEmail,
    startedAt: data.startedAt,
    stoppedAt: data.stoppedAt,
    captureStatus,
    processingStatus,
    processingErrorCode,
    schemaVersion: SCHEMA_VERSION,
    recordMode: data.recordMode,
    selectedAppId: data.selectedAppId
    // intentionally omit legacy error / status from persisted shape
  }

  const parsed = TelemetrySessionMetaSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export const PolishedActionSchema = z
  .object({
    order: z.number().int().positive(),
    text: z.string().min(1).max(300),
    category: z.enum([
      'navigation',
      'interaction',
      'input',
      'submission',
      'shortcut',
      'error',
      'recovery',
      'idle',
      'session',
      'clipboard'
    ]),
    timestamp: z.string().datetime(),
    sourceEventIds: z.array(z.string()).min(1),
    appName: z.string().max(120).optional(),
    documentTitle: z.string().max(200).optional(),
    elementLabel: z.string().max(120).optional(),
    elementRole: z.string().max(64).optional(),
    clipboard: ClipboardDataSchema.optional(),
    keyframePath: z.string().max(300).optional(),
    inferred: z.boolean().optional(),
    verified: z.boolean().optional(),
    /** Redacted text the user typed during this action, when captured. */
    typedText: z.string().max(300).optional(),
    clickButton: z.enum(['left', 'right']).optional(),
    clickCount: z.number().int().positive().max(10).optional(),
    clickX: z.number().int().optional(),
    clickY: z.number().int().optional(),
    /** How well the click/activation target was resolved. */
    targetResolution: TargetResolutionSchema.optional(),
    /** Semantic classification of typed/field values (never raw secrets). */
    inputKind: ValueCategorySchema.optional(),
    /** Screen-state id observed immediately before this action. */
    screenBeforeId: z.string().max(80).optional(),
    /** Screen-state id observed as a result of this action. */
    screenAfterId: z.string().max(80).optional(),
    /** Changed-only fields after the action (omit unchanged). */
    screenAfter: ScreenAfterDeltaSchema.optional(),
    /** Idle/wait duration preceding this action (ms). */
    waitedMs: z.number().int().nonnegative().optional(),
    /** Semantic shortcut / clipboard operation when known. */
    semanticOp: SemanticOpSchema.optional(),
    elementBounds: ElementBoundsSchema.optional()
  })
  .strict()

export type PolishedAction = z.infer<typeof PolishedActionSchema>

export const PolishedSessionSchema = z
  .object({
    sessionId: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    polishedAt: z.string().datetime(),
    sequenceRange: z.object({
      min: z.number().int().nonnegative(),
      max: z.number().int().nonnegative()
    }),
    actions: z.array(PolishedActionSchema),
    /** Activity groups for hierarchical model packing. */
    segments: z.array(ActivitySegmentSchema).optional(),
    /** Compact screen-state reference table used by segments/actions. */
    screens: z.array(ScreenStateRefSchema).optional()
  })
  .strict()

export type PolishedSession = z.infer<typeof PolishedSessionSchema>

export const WorkflowStepCategorySchema = z.enum([
  'navigation',
  'interaction',
  'data_entry',
  'execution',
  'verification',
  'error_recovery',
  'other'
])

export const WorkflowActionTypeSchema = z.enum([
  'click',
  'type',
  'paste',
  'copy',
  'navigate',
  'select',
  'submit',
  'shortcut',
  'wait',
  'activate',
  'other'
])
export type WorkflowActionType = z.infer<typeof WorkflowActionTypeSchema>

export const WorkflowRetryHintSchema = z.enum([
  'none',
  'retry_once',
  'retry_until',
  'ask_user',
  'skip'
])
export type WorkflowRetryHint = z.infer<typeof WorkflowRetryHintSchema>

export const WorkflowStepAlternativeSchema = z
  .object({
    interpretation: z.string().min(1).max(300),
    confidence: z.number().min(0).max(1)
  })
  .strict()

export type WorkflowStepAlternative = z.infer<typeof WorkflowStepAlternativeSchema>

export const WorkflowStepSchema = z
  .object({
    order: z.number().int().positive(),
    action: z.string().min(1).max(400),
    category: WorkflowStepCategorySchema,
    appName: z.string().max(120).nullable(),
    evidenceEventIds: z.array(z.string()).min(1),
    confidence: z.number().min(0).max(1),
    /** OpenAI structured outputs require nullable (not optional) for new fields. */
    objective: z.string().max(300).nullable(),
    actionType: WorkflowActionTypeSchema.nullable(),
    targetRole: z.string().max(64).nullable(),
    targetLabel: z.string().max(120).nullable(),
    inputKind: ValueCategorySchema.nullable(),
    inputVariableKey: z.string().max(40).nullable(),
    inputLiteral: z.string().max(300).nullable(),
    preconditions: z.array(z.string().max(200)).max(6).nullable(),
    expectedChange: z.string().max(300).nullable(),
    completionCheck: z.string().max(300).nullable(),
    dependsOnSteps: z.array(z.number().int().positive()).max(20).nullable(),
    retryHint: WorkflowRetryHintSchema.nullable(),
    alternatives: z.array(WorkflowStepAlternativeSchema).max(3).nullable(),
    needsClarification: z.boolean().nullable()
  })
  .strict()

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const WorkflowVariableSchema = z
  .object({
    key: z.string().max(40),
    label: z.string().max(120),
    kind: z.enum(['document', 'url', 'recipient', 'text', 'search', 'message', 'filename', 'date']),
    exampleSanitized: z.string().max(200).nullable()
  })
  .strict()

export type WorkflowVariable = z.infer<typeof WorkflowVariableSchema>

export const ExtractedWorkflowSchema = z
  .object({
    title: z.string().min(1).max(160),
    goal: z.string().max(400).nullable(),
    summary: z.string().min(1).max(800),
    outcome: z.enum(['completed', 'partial', 'failed', 'unknown']),
    steps: z.array(WorkflowStepSchema).min(1).max(80),
    warnings: z.array(z.string().max(300)).max(20),
    /** OpenAI structured outputs require nullable (not optional). */
    variables: z.array(WorkflowVariableSchema).max(20).nullable()
  })
  .strict()

export type ExtractedWorkflow = z.infer<typeof ExtractedWorkflowSchema>

/** Fill v2 nullable fields so legacy stored steps still validate. */
export function withWorkflowStepDefaults<T extends Record<string, unknown>>(
  step: T
): T & {
  objective: string | null
  actionType: WorkflowActionType | null
  targetRole: string | null
  targetLabel: string | null
  inputKind: ValueCategory | null
  inputVariableKey: string | null
  inputLiteral: string | null
  preconditions: string[] | null
  expectedChange: string | null
  completionCheck: string | null
  dependsOnSteps: number[] | null
  retryHint: WorkflowRetryHint | null
  alternatives: WorkflowStepAlternative[] | null
  needsClarification: boolean | null
} {
  return {
    ...step,
    objective: (step.objective as string | null | undefined) ?? null,
    actionType: (step.actionType as WorkflowActionType | null | undefined) ?? null,
    targetRole: (step.targetRole as string | null | undefined) ?? null,
    targetLabel: (step.targetLabel as string | null | undefined) ?? null,
    inputKind: (step.inputKind as ValueCategory | null | undefined) ?? null,
    inputVariableKey: (step.inputVariableKey as string | null | undefined) ?? null,
    inputLiteral: (step.inputLiteral as string | null | undefined) ?? null,
    preconditions: (step.preconditions as string[] | null | undefined) ?? null,
    expectedChange: (step.expectedChange as string | null | undefined) ?? null,
    completionCheck: (step.completionCheck as string | null | undefined) ?? null,
    dependsOnSteps: (step.dependsOnSteps as number[] | null | undefined) ?? null,
    retryHint: (step.retryHint as WorkflowRetryHint | null | undefined) ?? null,
    alternatives: (step.alternatives as WorkflowStepAlternative[] | null | undefined) ?? null,
    needsClarification: (step.needsClarification as boolean | null | undefined) ?? null
  }
}

export function normalizeExtractedWorkflow(raw: unknown): ExtractedWorkflow | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const steps = Array.isArray(data.steps)
    ? data.steps.map((s) =>
        typeof s === 'object' && s ? withWorkflowStepDefaults(s as Record<string, unknown>) : s
      )
    : data.steps
  const parsed = ExtractedWorkflowSchema.safeParse({ ...data, steps })
  return parsed.success ? parsed.data : null
}

export const StoredVariablesSchema = z
  .object({
    sessionId: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    extractedAt: z.string().datetime(),
    variables: z.array(WorkflowVariableSchema)
  })
  .strict()

export type StoredVariables = z.infer<typeof StoredVariablesSchema>

/** Alias matching the product naming in the summarizer spec. */
export const WorkflowSchema = ExtractedWorkflowSchema

export const TokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  })
  .strict()

export type TokenUsage = z.infer<typeof TokenUsageSchema>

export const StoredWorkflowResultSchema = z
  .object({
    sessionId: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    extractedAt: z.string().datetime(),
    model: z.string().max(80),
    workflow: ExtractedWorkflowSchema,
    usage: TokenUsageSchema.optional()
  })
  .strict()

export type StoredWorkflowResult = z.infer<typeof StoredWorkflowResultSchema>

// ── Automation script (compiled executable ops) ──

export const AutomationOpKindSchema = z.enum([
  'open_app',
  'open_url',
  'activate_element',
  'click_at',
  'keystroke',
  'type_text',
  'set_clipboard',
  'wait_for',
  'ask_user',
  'manual'
])

export type AutomationOpKind = z.infer<typeof AutomationOpKindSchema>

export const WaitForConditionSchema = z.enum([
  'app_frontmost',
  'window_title_contains',
  'element_exists'
])

export type WaitForCondition = z.infer<typeof WaitForConditionSchema>

/**
 * Flat op shape (nullable fields) for OpenAI Structured Outputs.
 * Discriminated by `op`; unused fields are null.
 */
export const AutomationOpSchema = z
  .object({
    op: AutomationOpKindSchema,
    stepOrder: z.number().int().positive(),
    evidenceEventIds: z.array(z.string()).min(1),
    confidence: z.number().min(0).max(1),
    timeoutMs: z.number().int().positive().max(120_000),
    /** Human-readable label for the run ledger. */
    label: z.string().max(200).nullable(),
    appName: z.string().max(120).nullable(),
    appBundleId: z.string().max(200).nullable(),
    url: z.string().max(500).nullable(),
    urlVariableKey: z.string().max(40).nullable(),
    elementRole: z.string().max(64).nullable(),
    elementLabel: z.string().max(120).nullable(),
    elementPath: z.array(z.string().max(80)).max(3).nullable(),
    chord: z.string().max(64).nullable(),
    variableKey: z.string().max(40).nullable(),
    /**
     * Constant text to type when the recording showed the same text every time.
     * Ignored when `variableKey` is set — variables always win.
     */
    literalText: z.string().max(500).nullable(),
    waitCondition: WaitForConditionSchema.nullable(),
    waitValue: z.string().max(200).nullable(),
    prompt: z.string().max(300).nullable(),
    /** Absolute screen point for click_at (top-left origin). */
    clickX: z.number().int().nullable(),
    clickY: z.number().int().nullable()
  })
  .strict()

export type AutomationOp = z.infer<typeof AutomationOpSchema>

export const AutomationScriptSchema = z
  .object({
    ops: z.array(AutomationOpSchema).min(1).max(200),
    warnings: z.array(z.string().max(300)).max(20)
  })
  .strict()

export type AutomationScript = z.infer<typeof AutomationScriptSchema>

export const StoredAutomationScriptSchema = z
  .object({
    sessionId: z.string(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    compiledAt: z.string().datetime(),
    model: z.string().max(80),
    script: AutomationScriptSchema,
    /** True when editor steps changed after compile — recompile before next run. */
    stale: z.boolean().optional(),
    usage: TokenUsageSchema.optional()
  })
  .strict()

export type StoredAutomationScript = z.infer<typeof StoredAutomationScriptSchema>

/** Safe session id for filenames: alphanumeric, underscore, hyphen. */
export const SessionIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid session id')

export function parseTelemetryEvent(raw: unknown): TelemetryEvent {
  return TelemetryEventSchema.parse(raw)
}

export function safeParseTelemetryEvent(raw: unknown): TelemetryEvent | null {
  const result = TelemetryEventSchema.safeParse(raw)
  return result.success ? result.data : null
}
