import { z } from 'zod'

export const SCHEMA_VERSION = 1 as const

export const TelemetryEventTypeSchema = z.enum([
  'session_started',
  'session_stopped',
  'navigation',
  'app_switch',
  'window_switch',
  'click',
  'scroll',
  'text_input',
  'field_completed',
  'selection_changed',
  'form_submitted',
  'keyboard_shortcut',
  /** Bare special key (Enter/Esc/Tab/arrows) when no typing buffer absorbed it. */
  'key_pressed',
  'error',
  'screen_changed',
  'state_change',
  'focus_changed',
  'clipboard_changed',
  'paste_detected',
  'element_activated',
  'keyframe_captured',
  'file_dialog',
  'download',
  'narration_span',
  'marker'
])

export type TelemetryEventType = z.infer<typeof TelemetryEventTypeSchema>

export const ViewportSchema = z.object({
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative()
})

export const DisplayInfoSchema = z
  .object({
    scale: z.number().positive(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  })
  .strict()

export type DisplayInfo = z.infer<typeof DisplayInfoSchema>

export const WindowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  })
  .strict()

export type WindowBounds = z.infer<typeof WindowBoundsSchema>

/** How the target was resolved — ax preferred; visual/ocr deferred. */
export const TargetTierSchema = z.enum(['ax', 'coords', 'none', 'visual'])
export type TargetTier = z.infer<typeof TargetTierSchema>

export const ListContextSchema = z
  .object({
    rowIndex: z.number().int().nonnegative().optional(),
    siblingCount: z.number().int().nonnegative().optional(),
    precedingNonEmpty: z.number().int().nonnegative().optional(),
    columnHeader: z.string().max(80).optional(),
    containerRole: z.string().max(64).optional(),
    containerLabel: z.string().max(120).optional()
  })
  .strict()

export type ListContext = z.infer<typeof ListContextSchema>

export const TelemetryTargetSchema = z
  .object({
    role: z.string().max(64).optional(),
    tagName: z.string().max(64).optional(),
    accessibleLabel: z.string().max(120).optional(),
    visibleLabel: z.string().max(80).optional(),
    analyticsId: z.string().max(120).optional(),
    /** AXIdentifier when available. */
    identifier: z.string().max(120).optional(),
    fieldType: z.string().max(64).optional(),
    formLabel: z.string().max(120).optional(),
    appName: z.string().max(120).optional(),
    appBundleId: z.string().max(200).optional(),
    enabled: z.boolean().optional(),
    tier: TargetTierSchema.optional(),
    listContext: ListContextSchema.optional()
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

/**
 * Clipboard metadata. Plaintext may be stored under a size threshold after
 * redaction; sensitive content never persists a value.
 */
export const ClipboardDataSchema = z
  .object({
    contentType: ClipboardContentTypeSchema,
    urlHost: z.string().max(200).optional(),
    urlPath: z.string().max(200).optional(),
    /** Sanitized query kept for address extraction (tracking params stripped). */
    urlQuery: z.string().max(300).optional(),
    charCount: z.number().int().nonnegative().optional(),
    contentHash: z.string().max(64),
    /** Redacted plaintext under size threshold; absent for sensitive/oversized. */
    text: z.string().max(500).optional(),
    /** Links copy → paste as one transfer. */
    pairId: z.string().max(80).optional()
  })
  .strict()

export type ClipboardData = z.infer<typeof ClipboardDataSchema>

export const ClickModifiersSchema = z
  .object({
    cmd: z.boolean().optional(),
    opt: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional()
  })
  .strict()

export type ClickModifiers = z.infer<typeof ClickModifiersSchema>

export const ElementNormSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1)
  })
  .strict()

export type ElementNorm = z.infer<typeof ElementNormSchema>

export const StateChangeKindSchema = z.enum([
  'spinner_gone',
  'table_rendered',
  'row_count_changed',
  'toast_appeared',
  'dialog_appeared',
  'dialog_dismissed',
  'loading_started',
  'loading_finished',
  'title_changed',
  'url_changed',
  'other'
])
export type StateChangeKind = z.infer<typeof StateChangeKindSchema>

export const NarrationMarkerSchema = z.enum([
  'decision_point',
  'optional',
  'skip_this',
  'check_here'
])
export type NarrationMarker = z.infer<typeof NarrationMarkerSchema>

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
    urlHost: z.string().max(200).optional(),
    /** Attached from a following state_change event. */
    stateChangeKind: StateChangeKindSchema.optional(),
    stateChangeDetail: z.string().max(200).optional()
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
    /** Process id of the frontmost app (for disambiguation). */
    pid: z.number().int().positive().optional(),
    windowTitle: z.string().max(200).optional(),
    windowBounds: WindowBoundsSchema.optional(),
    display: DisplayInfoSchema.optional(),
    urlHost: z.string().max(200).optional(),
    urlPath: z.string().max(200).optional(),
    /** Sanitized query string (tracking + credentials stripped). */
    urlQuery: z.string().max(300).optional(),
    /** False for redirects / automatic navigations. */
    userInitiated: z.boolean().optional(),
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
    elementIdentifier: z.string().max(120).optional(),
    elementEnabled: z.boolean().optional(),
    elementPath: z.array(z.string().max(80)).max(8).optional(),
    selectedLabels: z.array(z.string().max(120)).max(5).optional(),
    listContext: ListContextSchema.optional(),
    targetTier: TargetTierSchema.optional(),
    clipboard: ClipboardDataSchema.optional(),
    charCountDelta: z.number().int().optional(),
    matchedClipboardHash: z.string().max(64).optional(),
    /** Links a paste_detected to its clipboard_changed. */
    clipboardPairId: z.string().max(80).optional(),
    inferred: z.boolean().optional(),
    verified: z.boolean().optional(),
    /** Relative path only — never base64, never absolute. */
    keyframePath: z.string().max(300).optional(),
    preShotPath: z.string().max(300).optional(),
    postShotPath: z.string().max(300).optional(),
    targetCropPath: z.string().max(300).optional(),
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
    clickButton: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().positive().max(10).optional(),
    clickModifiers: ClickModifiersSchema.optional(),
    /** Screen coordinates of a click (top-left origin), when observed. */
    clickX: z.number().int().optional(),
    clickY: z.number().int().optional(),
    /** Window-relative click coordinates. */
    clickWindowX: z.number().int().optional(),
    clickWindowY: z.number().int().optional(),
    /** Position inside the target bbox, 0–1 on each axis. */
    elementNorm: ElementNormSchema.optional(),
    /** Accessibility frame of the target element (top-left origin), when observed. */
    elementBounds: ElementBoundsSchema.optional(),
    /** Scroll payload. */
    scrollAxis: z.enum(['vertical', 'horizontal']).optional(),
    scrollDelta: z.number().optional(),
    scrollContainerRole: z.string().max(64).optional(),
    scrollContainerLabel: z.string().max(120).optional(),
    scrollPositionBefore: z.number().optional(),
    scrollPositionAfter: z.number().optional(),
    /** Structured state-change description. */
    stateChangeKind: StateChangeKindSchema.optional(),
    stateChangeElement: z.string().max(120).optional(),
    stateChangeDetail: z.string().max(200).optional(),
    /** File dialog / download. */
    filePath: z.string().max(400).optional(),
    fileName: z.string().max(200).optional(),
    fileExtension: z.string().max(32).optional(),
    fileDialogKind: z.enum(['open', 'save']).optional(),
    downloadSourceUrl: z.string().max(500).optional(),
    /** Narration / markers. */
    narrationText: z.string().max(800).optional(),
    narrationStartMs: z.number().int().nonnegative().optional(),
    narrationEndMs: z.number().int().nonnegative().optional(),
    marker: NarrationMarkerSchema.optional()
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
    clickButton: z.enum(['left', 'right', 'middle']).optional(),
    clickCount: z.number().int().positive().max(10).optional(),
    clickX: z.number().int().optional(),
    clickY: z.number().int().optional(),
    /** Window-relative click offset (top-left of owning window). */
    clickWindowX: z.number().int().optional(),
    clickWindowY: z.number().int().optional(),
    /** Window size at record time — used to rescale the offset after resize. */
    windowWidth: z.number().int().nonnegative().optional(),
    windowHeight: z.number().int().nonnegative().optional(),
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
    elementBounds: ElementBoundsSchema.optional(),
    /** L1 denoised op: fill_field / transfer / reveal when merged. */
    l1Op: z.enum(['fill_field', 'transfer', 'reveal']).optional(),
    transferSourceLabel: z.string().max(120).optional(),
    transferDestLabel: z.string().max(120).optional(),
    clipboardPairId: z.string().max(80).optional(),
    listContext: ListContextSchema.optional(),
    clickModifiers: ClickModifiersSchema.optional(),
    elementNorm: ElementNormSchema.optional(),
    /** Aggregated scroll for reveal actions. */
    scrollAxis: z.enum(['vertical', 'horizontal']).optional(),
    scrollDelta: z.number().optional(),
    narrationText: z.string().max(800).optional(),
    marker: NarrationMarkerSchema.optional(),
    userInitiated: z.boolean().optional()
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

/** L1 / execution hints — resolver verbs must NOT appear as L2 intent. */
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
  'fill_field',
  'transfer',
  'reveal',
  'other'
])
export type WorkflowActionType = z.infer<typeof WorkflowActionTypeSchema>

/** L2 intent verbs — a step is a goal, not a recorded action. */
export const IntentVerbSchema = z.enum([
  'Locate',
  'Read',
  'Transform',
  'Fill',
  'Create',
  'Decide',
  'Verify',
  'Commit',
  'Wait'
])
export type IntentVerb = z.infer<typeof IntentVerbSchema>

export const ResolutionPolicySchema = z.enum(['auto', 'assist', 'stage'])
export type ResolutionPolicy = z.infer<typeof ResolutionPolicySchema>

export const StepRequirementSchema = z
  .object({
    ref: z.string().max(80).nullable(),
    account: z.string().max(200).nullable(),
    noModal: z.boolean().nullable(),
    policy: ResolutionPolicySchema,
    description: z.string().max(200).nullable()
  })
  .strict()

export type StepRequirement = z.infer<typeof StepRequirementSchema>

export const PositionStrategySchema = z.enum([
  'first_empty_row',
  'match_row',
  'newest',
  'last',
  'absolute'
])
export type PositionStrategy = z.infer<typeof PositionStrategySchema>

export const StepPositionSchema = z
  .object({
    strategy: PositionStrategySchema,
    column: z.string().max(40).nullable(),
    matchValue: z.string().max(200).nullable()
  })
  .strict()

export type StepPosition = z.infer<typeof StepPositionSchema>

export const StepEffectSchema = z
  .object({
    kind: z.enum(['row_count', 'readback', 'element_present', 'url_matches', 'other']),
    column: z.string().max(80).nullable(),
    equals: z.string().max(300).nullable(),
    delta: z.string().max(40).nullable(),
    detail: z.string().max(200).nullable()
  })
  .strict()

export type StepEffect = z.infer<typeof StepEffectSchema>

export const AuthorizationClassSchema = z.enum([
  'read',
  'bounded_write',
  'commit',
  'destructive'
])
export type AuthorizationClass = z.infer<typeof AuthorizationClassSchema>

export const WorkflowRetryHintSchema = z.enum([
  'none',
  'retry_once',
  'retry_until',
  'ask_user',
  'skip',
  'halt_and_return_control'
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
    needsClarification: z.boolean().nullable(),
    /** L2 intent step id (stable across re-interpretation). */
    id: z.string().max(40).nullable(),
    intent: IntentVerbSchema.nullable(),
    summary: z.string().max(300).nullable(),
    requires: z.array(StepRequirementSchema).max(8).nullable(),
    /**
     * OpenAI structured outputs do not support z.record reliably — store as
     * key/value entries and convert at the edges when needed.
     */
    params: z
      .array(z.object({ key: z.string().max(40), value: z.string().max(200) }).strict())
      .max(20)
      .nullable(),
    position: StepPositionSchema.nullable(),
    effect: z.array(StepEffectSchema).max(6).nullable(),
    idempotencyKey: z.string().max(120).nullable(),
    onFail: WorkflowRetryHintSchema.nullable(),
    authorization: AuthorizationClassSchema.nullable()
  })
  .strict()

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>
export type WorkflowStepParam = { key: string; value: string }

export const WorkflowVariableSchema = z
  .object({
    key: z.string().max(40),
    label: z.string().max(120),
    kind: z.enum(['document', 'url', 'recipient', 'text', 'search', 'message', 'filename', 'date']),
    exampleSanitized: z.string().max(200).nullable()
  })
  .strict()

export type WorkflowVariable = z.infer<typeof WorkflowVariableSchema>

export const AddressKindSchema = z.enum(['url', 'file', 'deeplink', 'record', 'app_doc'])
export type AddressKind = z.infer<typeof AddressKindSchema>

export const AddressVerifySchema = z
  .object({
    urlMatches: z.string().max(300).nullable(),
    elementPresent: z
      .object({
        text: z.string().max(120).nullable(),
        role: z.string().max(64).nullable()
      })
      .nullable(),
    accountIndicator: z.string().max(200).nullable()
  })
  .strict()

export type AddressVerify = z.infer<typeof AddressVerifySchema>

export const AddressHealthSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    lastOk: z.string().datetime().nullable()
  })
  .strict()

export type AddressHealth = z.infer<typeof AddressHealthSchema>

/** First-class destination — shared across steps, repairable in one place. */
export const AddressSchema = z
  .object({
    id: z.string().min(1).max(80),
    kind: AddressKindSchema,
    template: z.string().max(500),
    params: z
      .array(z.object({ key: z.string().max(40), value: z.string().max(200) }).strict())
      .max(20)
      .nullable(),
    identityAccount: z.string().max(200).nullable(),
    identityProvider: z.string().max(80).nullable(),
    stability: z.enum(['high', 'medium', 'low']),
    verify: AddressVerifySchema,
    fallback: z.array(z.string().max(80)).max(4).nullable(),
    health: AddressHealthSchema.nullable(),
    policy: ResolutionPolicySchema,
    needsReview: z.boolean().nullable()
  })
  .strict()

export type Address = z.infer<typeof AddressSchema>

export const WorkflowBranchSchema = z
  .object({
    id: z.string().max(40),
    atStepId: z.string().max(40),
    condition: z.string().max(300),
    /** Required — narration vs cross-run; missing source → question, not branch. */
    source: z.enum(['narration', 'cross_run', 'user']),
    confidence: z.number().min(0).max(1)
  })
  .strict()

export type WorkflowBranch = z.infer<typeof WorkflowBranchSchema>

export const AuthorizationScopeSchema = z
  .object({
    destinations: z.array(z.string().max(80)).max(20),
    level: AuthorizationClassSchema,
    expires: z.string().datetime().nullable()
  })
  .strict()

export type AuthorizationScope = z.infer<typeof AuthorizationScopeSchema>

export const WorkflowQuestionSchema = z
  .object({
    id: z.string().max(40),
    prompt: z.string().min(1).max(400),
    relatedStepId: z.string().max(40).nullable(),
    kind: z.enum([
      'branch',
      'value_source',
      'position',
      'search_intent',
      'absolute_position',
      'other'
    ])
  })
  .strict()

export type WorkflowQuestion = z.infer<typeof WorkflowQuestionSchema>

export const ExtractedWorkflowSchema = z
  .object({
    title: z.string().min(1).max(160),
    goal: z.string().max(400).nullable(),
    summary: z.string().min(1).max(800),
    outcome: z.enum(['completed', 'partial', 'failed', 'unknown']),
    steps: z.array(WorkflowStepSchema).min(1).max(80),
    warnings: z.array(z.string().max(300)).max(20),
    /** OpenAI structured outputs require nullable (not optional). */
    variables: z.array(WorkflowVariableSchema).max(20).nullable(),
    addresses: z.array(AddressSchema).max(20).nullable(),
    commits: z.array(z.string().max(40)).max(20).nullable(),
    writes: z.array(z.string().max(80)).max(20).nullable(),
    inputs: z.array(z.string().max(40)).max(20).nullable(),
    authorizationScope: AuthorizationScopeSchema.nullable(),
    branches: z.array(WorkflowBranchSchema).max(20).nullable(),
    questions: z.array(WorkflowQuestionSchema).max(30).nullable()
  })
  .strict()

export type ExtractedWorkflow = z.infer<typeof ExtractedWorkflowSchema>

/**
 * Lean schema for OpenAI Structured Outputs.
 * Addresses are injected deterministically — the model must leave them null.
 * Avoids deep Address trees that break Responses API parsing.
 */
export const ModelExtractedWorkflowSchema = z
  .object({
    title: z.string().min(1).max(160),
    goal: z.string().max(400).nullable(),
    summary: z.string().min(1).max(800),
    outcome: z.enum(['completed', 'partial', 'failed', 'unknown']),
    steps: z.array(WorkflowStepSchema).min(1).max(80),
    warnings: z.array(z.string().max(300)).max(20),
    variables: z.array(WorkflowVariableSchema).max(20).nullable(),
    /** Always null from the model — filled from deterministic extractAddresses. */
    addresses: z.null(),
    commits: z.array(z.string().max(40)).max(20).nullable(),
    writes: z.array(z.string().max(80)).max(20).nullable(),
    inputs: z.array(z.string().max(40)).max(20).nullable(),
    authorizationScope: AuthorizationScopeSchema.nullable(),
    branches: z.array(WorkflowBranchSchema).max(20).nullable(),
    questions: z.array(WorkflowQuestionSchema).max(30).nullable()
  })
  .strict()

export type ModelExtractedWorkflow = z.infer<typeof ModelExtractedWorkflowSchema>

export const RunFailureCodeSchema = z.enum([
  'target_not_found',
  'target_ambiguous',
  'precondition_unmet',
  'navigation_failed',
  'address_stale',
  'auth_required',
  'wrong_identity',
  'value_mismatch',
  'unexpected_state',
  'branch_unknown',
  'timeout',
  'out_of_scope',
  'repair_exhausted'
])
export type RunFailureCode = z.infer<typeof RunFailureCodeSchema>

export const RunModeSchema = z.enum(['simulated', 'supervised', 'authorized'])
export type RunMode = z.infer<typeof RunModeSchema>

/** Fill nullable fields so legacy stored steps still validate. */
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
  id: string | null
  intent: IntentVerb | null
  summary: string | null
  requires: StepRequirement[] | null
  params: WorkflowStepParam[] | null
  position: StepPosition | null
  effect: StepEffect[] | null
  idempotencyKey: string | null
  onFail: WorkflowRetryHint | null
  authorization: AuthorizationClass | null
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
    needsClarification: (step.needsClarification as boolean | null | undefined) ?? null,
    id: (step.id as string | null | undefined) ?? null,
    intent: (step.intent as IntentVerb | null | undefined) ?? null,
    summary: (step.summary as string | null | undefined) ?? null,
    requires: (step.requires as StepRequirement[] | null | undefined) ?? null,
    params: normalizeStepParams(step.params),
    position: (step.position as StepPosition | null | undefined) ?? null,
    effect: (step.effect as StepEffect[] | null | undefined) ?? null,
    idempotencyKey: (step.idempotencyKey as string | null | undefined) ?? null,
    onFail: (step.onFail as WorkflowRetryHint | null | undefined) ?? null,
    authorization: (step.authorization as AuthorizationClass | null | undefined) ?? null
  }
}

/** Accept legacy record-shaped params or entry arrays. */
export function normalizeStepParams(raw: unknown): WorkflowStepParam[] | null {
  if (raw == null) return null
  if (Array.isArray(raw)) {
    const entries = raw
      .filter(
        (e): e is { key: string; value: string } =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as { key?: unknown }).key === 'string' &&
          typeof (e as { value?: unknown }).value === 'string'
      )
      .map((e) => ({ key: e.key.slice(0, 40), value: e.value.slice(0, 200) }))
    return entries.length ? entries : null
  }
  if (typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'string')
      .map(([key, value]) => ({
        key: key.slice(0, 40),
        value: String(value).slice(0, 200)
      }))
    return entries.length ? entries : null
  }
  return null
}

export function normalizeExtractedWorkflow(raw: unknown): ExtractedWorkflow | null {
  if (!raw || typeof raw !== 'object') return null
  const data = raw as Record<string, unknown>
  const steps = Array.isArray(data.steps)
    ? data.steps.map((s) =>
        typeof s === 'object' && s ? withWorkflowStepDefaults(s as Record<string, unknown>) : s
      )
    : data.steps
  const parsed = ExtractedWorkflowSchema.safeParse({
    ...data,
    steps,
    addresses: data.addresses ?? null,
    commits: data.commits ?? null,
    writes: data.writes ?? null,
    inputs: data.inputs ?? null,
    authorizationScope: data.authorizationScope ?? null,
    branches: data.branches ?? null,
    questions: data.questions ?? null
  })
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
  'scroll',
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
    clickY: z.number().int().nullable(),
    /** Window-relative click offset — preferred over absolute when available. */
    clickWindowX: z.number().int().nullable().optional(),
    clickWindowY: z.number().int().nullable().optional(),
    /** Recorded window size for rescaling the offset after resize. */
    windowWidth: z.number().int().nonnegative().nullable().optional(),
    windowHeight: z.number().int().nonnegative().nullable().optional(),
    clickButton: z.enum(['left', 'right', 'middle']).nullable().optional(),
    clickCount: z.number().int().positive().max(10).nullable().optional(),
    /** Modifier flags for click_at — all fields required-nullable for Structured Outputs. */
    clickModifiers: z
      .object({
        cmd: z.boolean().nullable(),
        opt: z.boolean().nullable(),
        ctrl: z.boolean().nullable(),
        shift: z.boolean().nullable()
      })
      .strict()
      .nullable()
      .optional(),
    /** Scroll wheel: axis + signed delta (positive = down / right). */
    scrollAxis: z.enum(['vertical', 'horizontal']).nullable().optional(),
    scrollDelta: z.number().nullable().optional()
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
