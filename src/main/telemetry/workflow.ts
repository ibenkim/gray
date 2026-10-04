import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  ExtractedWorkflowSchema,
  ModelExtractedWorkflowSchema,
  normalizeStepParams,
  withWorkflowStepDefaults,
  type Address,
  type ExtractedWorkflow,
  type PolishedAction,
  type PolishedSession,
  type StoredWorkflowResult,
  type TelemetrySessionMeta,
  type TokenUsage,
  type WorkflowQuestion,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import type {
  EditorStep,
  FixOption,
  FixStep,
  StepApp,
  Workflow,
  WorkflowQuestionRef,
  WorkflowRunContract
} from '../../shared/types'
import { extractAddresses } from './addresses'
import type { TelemetryConfig } from './config'
import { TelemetryProcessingError, mapToProcessingError } from './errors'
import { sanitizeModelString } from './modelSanitize'
import {
  MODEL_INPUT_CHAR_BUDGET,
  prepareWorkflowModelInput,
  type CompactWorkflowModelInput,
  type PreparedWorkflowModelInput
} from './modelInput'
import {
  CLASSIFY_INSTRUCTIONS,
  EXTRACT_INSTRUCTIONS,
  WORKFLOW_CHUNK_INSTRUCTIONS,
  WORKFLOW_INSTRUCTIONS
} from './prompt'
import type { TelemetryStore } from './store/TelemetryStore'
import { extractWorkflowVariables } from './variables'

type ParsedResponse = {
  output_parsed: unknown
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
  /** Provider response id, when returned. */
  id?: string
  /** Provider request id header, when the SDK exposes it. */
  _request_id?: string | null
}

export type OpenAIResponsesClient = {
  responses: {
    parse: (body: unknown) => Promise<ParsedResponse>
  }
}

/** Observed acknowledgement ids for one stage request (never invented). */
export type ResponseReceipt = { responseId?: string; requestId?: string }

export type InterpretationStage = 'classify' | 'extract' | 'single'

export type ExtractWorkflowDeps = {
  createClient?: (apiKey: string) => OpenAIResponsesClient
}

/**
 * SDK default is 2 hidden retries; an ambiguous timeout could then cause extra remote
 * work the user never saw. Every stage request is attempted exactly once by the client.
 */
export function defaultClient(apiKey: string): OpenAIResponsesClient {
  const client = new OpenAI({ apiKey, maxRetries: 0 })
  return {
    responses: {
      parse: (body: unknown) =>
        client.responses.parse(
          body as Parameters<typeof client.responses.parse>[0]
        ) as unknown as Promise<ParsedResponse>
    }
  }
}

export function usageFromResponse(response: {
  usage?: { input_tokens?: number; output_tokens?: number }
}): TokenUsage | undefined {
  const input = response.usage?.input_tokens
  const output = response.usage?.output_tokens
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return { inputTokens: input, outputTokens: output }
}

export function logTokenUsage(stage: string, usage: TokenUsage | undefined): void {
  if (!usage) return
  console.info(
    `[telemetry] tokens stage=${stage} in=${usage.inputTokens} out=${usage.outputTokens}`
  )
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b
  if (!b) return a
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens
  }
}

/**
 * One OpenAI Responses API call per completed session (never per event),
 * unless the packed payload exceeds the char budget — then map-reduce chunks.
 * Prefer classify→extract staged calls; always run deterministic question enum.
 * Uses Structured Outputs; rejects invalid model output instead of saving it.
 */
export async function extractWorkflow(
  store: TelemetryStore,
  config: TelemetryConfig,
  session: TelemetrySessionMeta,
  polished: PolishedSession,
  deps: ExtractWorkflowDeps = {}
): Promise<StoredWorkflowResult> {
  if (!config.openaiApiKey) {
    throw new TelemetryProcessingError('OPENAI_API_KEY_MISSING')
  }
  if (polished.actions.length === 0) {
    throw new TelemetryProcessingError('WORKFLOW_EMPTY_ACTIONS')
  }

  const events = await store.readSessionEvents(session.sessionId)
  const variables: WorkflowVariable[] = extractWorkflowVariables(events, polished)
  const addresses = extractAddresses(events, polished)
  if (store.saveVariables && variables.length > 0) {
    try {
      await store.saveVariables(session.sessionId, variables)
    } catch (err) {
      console.error('[telemetry] saveVariables failed', err instanceof Error ? err.name : 'error')
    }
  }

  const prepared = prepareWorkflowModelInput(session, polished, { variables, addresses })
  const createClient = deps.createClient ?? defaultClient
  const client = createClient(config.openaiApiKey)
  const model = config.openaiModel

  const { workflow, usage } =
    prepared.estimatedChars > MODEL_INPUT_CHAR_BUDGET && (polished.segments?.length ?? 0) > 1
      ? await extractWorkflowChunked(
          client,
          model,
          session,
          polished,
          variables,
          addresses,
          prepared
        )
      : await extractWorkflowStaged(client, model, prepared, variables, addresses)

  assertEvidence(workflow, polished)
  return store.saveWorkflow(session.sessionId, workflow, model, { usage })
}

async function parseWorkflowResponse(
  client: OpenAIResponsesClient,
  model: string,
  system: string,
  userPayload: unknown,
  formatName: string
): Promise<{ parsed: unknown; usage?: TokenUsage; receipt: ResponseReceipt }> {
  let response: ParsedResponse
  try {
    response = await client.responses.parse({
      model,
      store: false,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(userPayload) }
      ],
      text: {
        // Lean schema — full Address trees / z.record break Structured Outputs.
        format: zodTextFormat(ModelExtractedWorkflowSchema, formatName)
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }
  const receipt: ResponseReceipt = {}
  if (typeof response.id === 'string' && response.id) receipt.responseId = response.id.slice(0, 120)
  if (typeof response._request_id === 'string' && response._request_id) {
    receipt.requestId = response._request_id.slice(0, 120)
  }
  return { parsed: response.output_parsed, usage: usageFromResponse(response), receipt }
}

export type StagedInterpretationHooks = {
  /** Acknowledged, already-validated classify checkpoint to reuse instead of re-requesting. */
  classifyCheckpoint?: { classified: ExtractedWorkflow }
  /** Called before each stage request is dispatched. */
  onStageStart?: (stage: InterpretationStage) => Promise<void>
  /**
   * Called after a stage response was received and locally validated. `classified` is the
   * evidence-valid classification, or null when the response was unusable (never reusable).
   */
  onStageAcknowledged?: (
    stage: InterpretationStage,
    receipt: ResponseReceipt,
    classified?: ExtractedWorkflow | null
  ) => Promise<void>
}

const PARTIAL_EXTRACT_WARNING =
  'The detailed extraction stage returned an invalid result; this shows the first-stage interpretation only.'

export type PartialReason = 'extract_invalid_output' | 'extract_invalid_evidence'

/**
 * Declared bounded stages: classify → extract (or one single-pass fallback when classify
 * output is unusable). Every stage's citations are validated against the approved alias map
 * before anything is reused or the next request is sent. Later stages carry only the given
 * body plus sanitized model output in the same alias namespace.
 */
export async function runStagedInterpretation(
  client: OpenAIResponsesClient,
  model: string,
  prepared: PreparedWorkflowModelInput,
  variables: WorkflowVariable[],
  addresses: Address[],
  hooks: StagedInterpretationHooks = {}
): Promise<{
  workflow: ExtractedWorkflow
  usage?: TokenUsage
  partial: boolean
  partialReason?: PartialReason
}> {
  let totalUsage: TokenUsage | undefined
  let classified: ExtractedWorkflow | null
  if (hooks.classifyCheckpoint) {
    classified = hooks.classifyCheckpoint.classified
  } else {
    await hooks.onStageStart?.('classify')
    const classify = await parseWorkflowResponse(
      client,
      model,
      CLASSIFY_INSTRUCTIONS,
      prepared.body,
      'workflow_classify'
    )
    logTokenUsage('workflow_classify', classify.usage)
    totalUsage = classify.usage
    try {
      classified = finalizeParsedWorkflow(classify.parsed, prepared, variables, addresses, {
        skipQuestions: true
      })
    } catch (err) {
      logStageRejection('classify', err)
      classified = null
    }
    await hooks.onStageAcknowledged?.('classify', classify.receipt, classified)
  }

  if (!classified) {
    await hooks.onStageStart?.('single')
    const single = await parseWorkflowResponse(
      client,
      model,
      WORKFLOW_INSTRUCTIONS,
      prepared.body,
      'workflow_summary'
    )
    logTokenUsage('workflow', single.usage)
    totalUsage = addUsage(totalUsage, single.usage)
    await hooks.onStageAcknowledged?.('single', single.receipt)
    try {
      const workflow = finalizeParsedWorkflow(single.parsed, prepared, variables, addresses)
      return { workflow, usage: totalUsage, partial: false }
    } catch (err) {
      logStageRejection('single', err)
      throw err
    }
  }

  await hooks.onStageStart?.('extract')
  const extract = await parseWorkflowResponse(
    client,
    model,
    EXTRACT_INSTRUCTIONS,
    {
      telemetry: prepared.body,
      addrs: prepared.body.addrs ?? [],
      classified: compactClassified(classified, prepared)
    },
    'workflow_extract'
  )
  logTokenUsage('workflow_extract', extract.usage)
  totalUsage = addUsage(totalUsage, extract.usage)
  await hooks.onStageAcknowledged?.('extract', extract.receipt)

  try {
    const workflow = finalizeParsedWorkflow(extract.parsed, prepared, variables, addresses)
    return { workflow, usage: totalUsage, partial: false }
  } catch (err) {
    // Extract invalid (shape or evidence): fall back to the verified classification only,
    // revalidated, explicitly labelled partial. Unknown evidence is never accepted.
    logStageRejection('extract', err)
    assertEvidenceIds(classified, new Set(prepared.evidenceMap.values()))
    const workflow = withQuestions(classified)
    const invalidEvidence =
      err instanceof TelemetryProcessingError && err.code === 'OPENAI_UNKNOWN_EVIDENCE'
    return {
      workflow: {
        ...workflow,
        warnings: [...workflow.warnings, PARTIAL_EXTRACT_WARNING].slice(-20)
      },
      usage: totalUsage,
      partial: true,
      partialReason: invalidEvidence ? 'extract_invalid_evidence' : 'extract_invalid_output'
    }
  }
}

/** Counts-only diagnostic for a rejected stage response — never ids, text or bodies. */
export type EvidenceDiagnostics = {
  reason: 'empty' | 'unknown' | 'namespace'
  steps: number
  citations: number
  known: number
  unknown: number
}

export class EvidenceValidationError extends TelemetryProcessingError {
  constructor(readonly diagnostics: EvidenceDiagnostics) {
    super('OPENAI_UNKNOWN_EVIDENCE')
  }
}

function logStageRejection(stage: InterpretationStage, err: unknown): void {
  if (err instanceof EvidenceValidationError) {
    const d = err.diagnostics
    console.info(
      `[telemetry] evidence rejected stage=${stage} reason=${d.reason} steps=${d.steps} citations=${d.citations} known=${d.known} unknown=${d.unknown}`
    )
    return
  }
  const code = err instanceof TelemetryProcessingError ? err.code : 'OPENAI_INVALID_OUTPUT'
  console.info(`[telemetry] stage output rejected stage=${stage} code=${code}`)
}

/** Values that belong to another namespace (order numbers, step/screen/address/event ids). */
const OTHER_NAMESPACE_RE = /^(?:\d+|step_\w+|s\d+|addr\w*|tevt_.+)$/

/**
 * Strict alias validation for one stage response: every step cites a nonempty array of
 * exact approved aliases. No placeholder, coercion or silent dropping.
 */
function validateAliasEvidence(
  rawSteps: Array<Record<string, unknown>>,
  aliases: Map<string, string>
): void {
  let citations = 0
  let known = 0
  let unknown = 0
  let empty = false
  let namespace = false
  for (const step of rawSteps) {
    const ids = Array.isArray(step.evidenceEventIds) ? step.evidenceEventIds : []
    if (ids.length === 0) empty = true
    for (const id of ids) {
      citations += 1
      if (typeof id === 'string' && aliases.has(id)) {
        known += 1
      } else {
        unknown += 1
        if (typeof id === 'string' && OTHER_NAMESPACE_RE.test(id)) namespace = true
      }
    }
  }
  if (empty || unknown > 0) {
    throw new EvidenceValidationError({
      reason: unknown > 0 ? (namespace ? 'namespace' : 'unknown') : 'empty',
      steps: rawSteps.length,
      citations,
      known,
      unknown
    })
  }
}

/**
 * Staged interpretation: classify → extract, then deterministic questions.
 * Falls back to a single WORKFLOW_INSTRUCTIONS call if classify output is unusable.
 */
async function extractWorkflowStaged(
  client: OpenAIResponsesClient,
  model: string,
  prepared: PreparedWorkflowModelInput,
  variables: WorkflowVariable[],
  addresses: Address[]
): Promise<{ workflow: ExtractedWorkflow; usage?: TokenUsage }> {
  const { workflow, usage } = await runStagedInterpretation(
    client,
    model,
    prepared,
    variables,
    addresses
  )
  return { workflow, usage }
}

/**
 * Validated first-stage output re-sent to extract. Canonical citations are mapped back to the
 * approved aliases (one model-facing namespace); prose is re-sanitized, identity fields are not.
 */
function compactClassified(w: ExtractedWorkflow, prepared: PreparedWorkflowModelInput): unknown {
  const toAlias = new Map<string, string>()
  for (const [alias, full] of prepared.evidenceMap) toAlias.set(full, alias)
  return {
    title: sanitizeProse(w.title),
    goal: sanitizeProse(w.goal),
    summary: sanitizeProse(w.summary),
    outcome: w.outcome,
    warnings: sanitizeDerived(w.warnings),
    variables: sanitizeDerived(w.variables),
    steps: w.steps.map((s) => ({
      order: s.order,
      id: s.id,
      intent: s.intent,
      summary: sanitizeProse(s.summary),
      action: sanitizeProse(s.action),
      category: s.category,
      appName: sanitizeProse(s.appName),
      evidenceEventIds: s.evidenceEventIds.map((full) => {
        const alias = toAlias.get(full)
        // Callers validated membership; an unmapped id here is a contract violation.
        if (!alias) throw new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
        return alias
      }),
      confidence: s.confidence,
      needsClarification: s.needsClarification,
      alternatives: sanitizeDerived(s.alternatives),
      objective: sanitizeProse(s.objective),
      actionType: s.actionType
    }))
  }
}

function sanitizeProse(value: string | null | undefined): string | null {
  return value == null ? null : sanitizeModelString(value, 800)
}

/** Deep prose sanitization for free-text containers (warnings, alternatives, variables). */
function sanitizeDerived(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeModelString(value, 800)
  if (Array.isArray(value)) return value.map(sanitizeDerived)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeDerived(v)])
    )
  }
  return value
}

/**
 * Map-reduce for long sessions: summarize each segment chunk, then assemble
 * a final workflow from bounded summaries + the last chunk's full detail.
 */
async function extractWorkflowChunked(
  client: OpenAIResponsesClient,
  model: string,
  session: TelemetrySessionMeta,
  polished: PolishedSession,
  variables: WorkflowVariable[],
  addresses: Address[],
  fullPrepared: PreparedWorkflowModelInput
): Promise<{ workflow: ExtractedWorkflow; usage?: TokenUsage }> {
  const segments = polished.segments ?? []
  const chunkSize = Math.max(1, Math.ceil(segments.length / 3))
  const chunks: PolishedAction[][] = []

  for (let i = 0; i < segments.length; i += chunkSize) {
    const slice = segments.slice(i, i + chunkSize)
    const orders = new Set(slice.flatMap((s) => s.actionOrders))
    const actions = polished.actions.filter(
      (a) => orders.has(a.order) && a.category !== 'session' && a.category !== 'idle'
    )
    if (actions.length) chunks.push(actions)
  }

  if (chunks.length <= 1) {
    return extractWorkflowStaged(client, model, fullPrepared, variables, addresses)
  }

  let totalUsage: TokenUsage | undefined
  const summaries: ExtractedWorkflow[] = []

  for (let i = 0; i < chunks.length - 1; i++) {
    const chunkPolished: PolishedSession = {
      ...polished,
      actions: chunks[i],
      segments: undefined,
      screens: polished.screens
    }
    const prepared = prepareWorkflowModelInput(session, chunkPolished, {
      variables,
      addresses,
      maxActions: 48
    })
    const { parsed, usage } = await parseWorkflowResponse(
      client,
      model,
      WORKFLOW_CHUNK_INSTRUCTIONS,
      prepared.body,
      'workflow_chunk_summary'
    )
    logTokenUsage(`workflow_chunk_${i + 1}`, usage)
    totalUsage = addUsage(totalUsage, usage)
    summaries.push(
      finalizeParsedWorkflow(parsed, prepared, variables, addresses, { skipQuestions: true })
    )
  }

  const finalChunk = chunks[chunks.length - 1]
  const finalPolished: PolishedSession = {
    ...polished,
    actions: finalChunk,
    segments: undefined,
    screens: polished.screens
  }
  const finalPrepared = prepareWorkflowModelInput(session, finalPolished, {
    variables,
    addresses,
    maxActions: 48
  })

  const carryForward = {
    priorSummaries: summaries.map((s) => ({
      title: s.title,
      goal: s.goal,
      summary: s.summary.slice(0, 400),
      steps: s.steps.slice(0, 12).map((st) => ({
        order: st.order,
        id: st.id,
        intent: st.intent,
        summary: st.summary,
        action: st.action,
        category: st.category,
        appName: st.appName,
        confidence: st.confidence,
        objective: st.objective,
        actionType: st.actionType,
        needsClarification: st.needsClarification
      }))
    })),
    finalChunk: finalPrepared.body as CompactWorkflowModelInput,
    vars: finalPrepared.body.vars,
    addrs: finalPrepared.body.addrs
  }

  const { parsed, usage } = await parseWorkflowResponse(
    client,
    model,
    WORKFLOW_INSTRUCTIONS,
    { mode: 'assemble_from_chunks', ...carryForward },
    'workflow_summary'
  )
  logTokenUsage('workflow_assemble', usage)
  totalUsage = addUsage(totalUsage, usage)

  // The assemble request's only alias namespace is the final chunk's acts[].ids.
  const workflow = finalizeParsedWorkflow(parsed, finalPrepared, variables, addresses)
  void fullPrepared
  return { workflow, usage: totalUsage }
}

function finalizeParsedWorkflow(
  parsed: unknown,
  prepared: PreparedWorkflowModelInput,
  variables: WorkflowVariable[],
  addresses: Address[],
  opts: { skipQuestions?: boolean } = {}
): ExtractedWorkflow {
  if (!parsed) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  if (typeof parsed !== 'object' || !parsed || !Array.isArray((parsed as ExtractedWorkflow).steps)) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const raw = parsed as Record<string, unknown>
  const rawSteps = (Array.isArray(raw.steps) ? raw.steps : []).filter(
    (s): s is Record<string, unknown> => !!s && typeof s === 'object'
  )
  if (!rawSteps.length) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }
  // Membership before anything else: no placeholder, no coercion, no dropped citations.
  validateAliasEvidence(rawSteps, prepared.evidenceMap)
  const sanitizedSteps = rawSteps
    .map((s, idx) => {
      const defaults = withWorkflowStepDefaults({
        ...s,
        // Drop nested fields that commonly fail Zod when the model invents shapes.
        requires: Array.isArray(s.requires) ? s.requires : null,
        params: normalizeStepParams(s.params),
        position:
          s.position && typeof s.position === 'object' ? s.position : null,
        effect: Array.isArray(s.effect) ? s.effect : null,
        alternatives: Array.isArray(s.alternatives) ? s.alternatives : null,
        order: typeof s.order === 'number' ? s.order : idx + 1,
        action:
          typeof s.action === 'string' && s.action.trim()
            ? s.action
            : typeof s.summary === 'string' && s.summary.trim()
              ? s.summary
              : `Step ${idx + 1}`,
        category: typeof s.category === 'string' ? s.category : 'other',
        evidenceEventIds: s.evidenceEventIds as string[],
        confidence: typeof s.confidence === 'number' ? s.confidence : 0.5
      })
      return defaults
    })

  const withDefaults = {
    title:
      typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled workflow',
    goal: typeof raw.goal === 'string' ? raw.goal : null,
    summary:
      typeof raw.summary === 'string' && raw.summary.trim()
        ? raw.summary
        : 'Recorded workflow',
    outcome:
      raw.outcome === 'completed' ||
      raw.outcome === 'partial' ||
      raw.outcome === 'failed' ||
      raw.outcome === 'unknown'
        ? raw.outcome
        : 'unknown',
    steps: sanitizedSteps,
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((w): w is string => typeof w === 'string')
      : [],
    // Never trust model addresses — deterministic extraction owns this layer.
    addresses: null,
    commits: Array.isArray(raw.commits) ? raw.commits : null,
    writes: Array.isArray(raw.writes) ? raw.writes : null,
    inputs: Array.isArray(raw.inputs) ? raw.inputs : null,
    authorizationScope:
      raw.authorizationScope && typeof raw.authorizationScope === 'object'
        ? raw.authorizationScope
        : null,
    branches: Array.isArray(raw.branches) ? raw.branches : null,
    questions: Array.isArray(raw.questions) ? raw.questions : null,
    variables: Array.isArray(raw.variables) ? raw.variables : null
  }

  let validated = ExtractedWorkflowSchema.safeParse(withDefaults)
  if (!validated.success) {
    // Salvage: strip complex nested L3 fields that often fail, keep core steps.
    const preSalvageIssues = validated.error.issues
      .slice(0, 6)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
    console.error(
      '[telemetry] workflow schema validation failed; salvaging core fields',
      preSalvageIssues
    )
    const stripped = {
      ...withDefaults,
      steps: sanitizedSteps.map((s) =>
        withWorkflowStepDefaults({
          ...s,
          requires: null,
          position: null,
          effect: null,
          params: null,
          authorization: null,
          onFail: null,
          idempotencyKey: null
        })
      ),
      authorizationScope: null,
      branches: null,
      questions: null,
      addresses: null
    }
    validated = ExtractedWorkflowSchema.safeParse(stripped)
    if (!validated.success) {
      const issues = validated.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
      console.error('[telemetry] workflow salvage failed', issues)
      throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
    }
  }

  // Validated aliases → canonical persisted event ids.
  const expandedSteps = validated.data.steps.map((step, idx) =>
    withWorkflowStepDefaults({
      ...step,
      id: step.id ?? `step_${idx + 1}`,
      evidenceEventIds: step.evidenceEventIds.map((alias) => prepared.evidenceMap.get(alias)!)
    })
  )

  const base: ExtractedWorkflow = {
    ...validated.data,
    steps: expandedSteps,
    addresses: addresses.length ? addresses : null,
    variables:
      validated.data.variables && validated.data.variables.length > 0
        ? validated.data.variables
        : variables.length
          ? variables
          : null
  }

  if (opts.skipQuestions) return base
  return withQuestions(base)
}

/** Merge model questions with the deterministic question pass. */
function withQuestions(base: ExtractedWorkflow): ExtractedWorkflow {
  const enumerated = enumerateWorkflowQuestions(base)
  const mergedQuestions = mergeQuestions(base.questions, enumerated)
  return { ...base, questions: mergedQuestions.length ? mergedQuestions : null }
}

/**
 * Deterministic question pass from needsClarification/alternatives,
 * absolute positions, and narration-like conditionals in step text.
 */
export function enumerateWorkflowQuestions(workflow: ExtractedWorkflow): WorkflowQuestion[] {
  const questions: WorkflowQuestion[] = []
  let n = 1
  const push = (q: Omit<WorkflowQuestion, 'id'> & { id?: string }) => {
    if (questions.length >= 30) return
    questions.push({
      id: q.id ?? `q_${n++}`,
      prompt: q.prompt,
      relatedStepId: q.relatedStepId,
      kind: q.kind
    })
  }

  for (const step of workflow.steps) {
    const stepId = step.id
    if (step.needsClarification) {
      const alt = step.alternatives?.[0]?.interpretation
      push({
        prompt: alt
          ? `Clarify step “${step.summary ?? step.action}”: ${alt}`
          : `Clarify ambiguous step: ${step.summary ?? step.action}`,
        relatedStepId: stepId,
        kind: step.alternatives?.length ? 'branch' : 'other'
      })
    } else if (step.alternatives && step.alternatives.length > 0) {
      push({
        prompt: `Choose interpretation for “${step.summary ?? step.action}”: ${step.alternatives
          .map((a) => a.interpretation)
          .join(' | ')}`,
        relatedStepId: stepId,
        kind: 'branch'
      })
    }

    if (step.position?.strategy === 'absolute') {
      push({
        prompt: `Position for “${step.summary ?? step.action}” used an absolute row/index — confirm the intended row or matching rule.`,
        relatedStepId: stepId,
        kind: 'absolute_position'
      })
    }

    const blob = `${step.summary ?? ''} ${step.action} ${step.objective ?? ''}`
    if (/\b(if|unless|only when|otherwise|depending on)\b/i.test(blob) && step.intent !== 'Decide') {
      const hasBranch = (workflow.branches ?? []).some((b) => b.atStepId === stepId)
      if (!hasBranch) {
        push({
          prompt: `Conditional language in “${step.summary ?? step.action}” has no sourced branch — what should happen?`,
          relatedStepId: stepId,
          kind: 'branch'
        })
      }
    }

    if (step.intent === 'Decide' && !(workflow.branches ?? []).some((b) => b.atStepId === stepId)) {
      push({
        prompt: `Decision at “${step.summary ?? step.action}” needs a confirmed branch condition.`,
        relatedStepId: stepId,
        kind: 'branch'
      })
    }
  }

  return questions
}

function mergeQuestions(
  fromModel: WorkflowQuestion[] | null | undefined,
  enumerated: WorkflowQuestion[]
): WorkflowQuestion[] {
  const out: WorkflowQuestion[] = []
  const seen = new Set<string>()
  for (const q of [...(fromModel ?? []), ...enumerated]) {
    const key = `${q.kind}|${q.relatedStepId ?? ''}|${q.prompt.slice(0, 80)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(q)
    if (out.length >= 30) break
  }
  return out
}

export function assertEvidence(workflow: ExtractedWorkflow, polished: PolishedSession): void {
  assertEvidenceIds(workflow, new Set(polished.actions.flatMap((a) => a.sourceEventIds)))
}

/** Every step must cite at least one known evidence id. */
export function assertEvidenceIds(workflow: ExtractedWorkflow, known: Set<string>): void {
  for (const step of workflow.steps) {
    if (!step.evidenceEventIds.length) {
      throw new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
    }
    for (const id of step.evidenceEventIds) {
      if (!known.has(id)) {
        throw new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
      }
    }
  }
}

function mapAppName(appName: string | null | undefined): StepApp | undefined {
  if (!appName) return undefined
  const lower = appName.toLowerCase()
  if (lower.includes('figma')) return { id: 'figma', name: 'Figma' }
  if (lower.includes('chrome') || lower.includes('safari') || lower.includes('firefox'))
    return { id: 'chrome', name: 'Chrome' }
  if (lower.includes('slack')) return { id: 'slack', name: 'Slack' }
  if (lower.includes('finder')) return { id: 'finder', name: 'Finder' }
  if (lower.includes('mail') || lower.includes('outlook')) return { id: 'mail', name: 'Mail' }
  return undefined
}

function shortenDestinationLabel(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'this destination'
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      const u = new URL(trimmed)
      const host = u.hostname.replace(/^www\./, '')
      const path = u.pathname.replace(/\/$/, '')
      if (path && path !== '/') {
        const leaf = path.split('/').filter(Boolean).pop()
        if (leaf) return decodeURIComponent(leaf.replace(/[-_]/g, ' '))
      }
      return host
    }
  } catch {
    /* fall through */
  }
  const leaf = trimmed.split(/[/\\]/).filter(Boolean).pop() ?? trimmed
  return leaf.length > 48 ? `${leaf.slice(0, 45)}…` : leaf
}

/** One plain sentence per destination policy (§6.2 / §9.2). */
export function requiresSummaryForStep(
  step: ExtractedWorkflow['steps'][number],
  addresses: Address[] | null | undefined
): string | undefined {
  const req = step.requires?.[0]
  if (!req) return undefined
  if (req.description && /gray will|start with/i.test(req.description)) {
    return req.description
  }
  let label: string | undefined
  if (req.ref) {
    const addr = addresses?.find((a) => a.id === req.ref)
    label = addr ? shortenDestinationLabel(addr.template) : shortenDestinationLabel(req.ref)
  } else if (req.account) {
    label = shortenDestinationLabel(req.account)
  } else if (req.description) {
    label = shortenDestinationLabel(req.description)
  }
  const dest = label ?? 'this destination'
  switch (req.policy) {
    case 'auto':
      return `Gray will open ${dest} itself.`
    case 'assist':
      return `Gray will ask you to complete access to ${dest}.`
    case 'stage':
      return `Start with ${dest} open.`
    default:
      return undefined
  }
}

function fixOptionsFromAlternatives(
  alternatives: ExtractedWorkflow['steps'][number]['alternatives']
): FixOption[] {
  const alts = alternatives ?? []
  const options: FixOption[] = [
    { id: 'ask-each-time', label: 'Ask each time', kind: 'default' }
  ]
  for (let i = 0; i < alts.length; i++) {
    options.push({
      id: `alt-${i}`,
      label: alts[i].interpretation,
      kind: i === 0 ? 'suggested' : 'default'
    })
  }
  options.push({ id: 'other', label: 'Other…', kind: 'other' })
  return options
}

function fixForStep(
  step: ExtractedWorkflow['steps'][number],
  stepId: string,
  questions: WorkflowQuestion[] | null | undefined
): FixStep | undefined {
  const related = (questions ?? []).filter((q) => q.relatedStepId === stepId)
  const needsFix =
    step.needsClarification === true ||
    (step.alternatives != null && step.alternatives.length > 0) ||
    related.length > 0
  if (!needsFix) return undefined

  const prompt =
    related[0]?.prompt ??
    (step.alternatives?.[0]
      ? `Clarify “${step.summary ?? step.action}”`
      : `Clarify ambiguous step: ${step.summary ?? step.action}`)

  return {
    prompt,
    options: fixOptionsFromAlternatives(step.alternatives),
    selectedOptionId: 'ask-each-time',
    collapsed: false
  }
}

function buildRunContract(extracted: ExtractedWorkflow): WorkflowRunContract | undefined {
  const destinations = [
    ...new Set([
      ...(extracted.authorizationScope?.destinations ?? []),
      ...(extracted.addresses ?? []).map((a) => a.id)
    ])
  ]
  const hasContract =
    (extracted.inputs?.length ?? 0) > 0 ||
    (extracted.writes?.length ?? 0) > 0 ||
    (extracted.commits?.length ?? 0) > 0 ||
    destinations.length > 0 ||
    !!extracted.authorizationScope

  if (!hasContract) return undefined

  return {
    inputs: extracted.inputs ?? [],
    writes: extracted.writes ?? [],
    commits: extracted.commits ?? [],
    destinations,
    authorizationLevel: extracted.authorizationScope?.level,
    authorizationExpires: extracted.authorizationScope?.expires ?? null
  }
}

/**
 * Map an extracted workflow into the app's editor Workflow shape (best-effort).
 * Carries summary/goal, step intent/confidence, FixStep cards from questions,
 * and a slim run contract for the review UI (§9).
 */
export function toEditorWorkflow(
  extracted: ExtractedWorkflow,
  id: string,
  sessionId?: string
): Workflow {
  const questions: WorkflowQuestionRef[] = (extracted.questions ?? []).map((q) => ({
    id: q.id,
    prompt: q.prompt,
    relatedStepId: q.relatedStepId,
    kind: q.kind
  }))

  const steps: EditorStep[] = extracted.steps.map((s, i) => {
    const stepId = s.id ?? `step_${i + 1}`
    const confidence = typeof s.confidence === 'number' ? s.confidence : undefined
    return {
      id: stepId,
      index: i + 1,
      title: s.summary ?? s.action,
      app: mapAppName(s.appName),
      intent: s.intent ?? undefined,
      confidence,
      requiresSummary: requiresSummaryForStep(s, extracted.addresses),
      fix: fixForStep(s, stepId, extracted.questions)
    }
  })

  return {
    id,
    name: extracted.title,
    metaLabel: `${extracted.steps.length} steps`,
    trigger: {},
    steps,
    status: 'off',
    runCount: 0,
    hoursReturned: '0',
    scope: 'personal',
    sessionId,
    automationStale: false,
    summary: extracted.summary,
    goal: extracted.goal ?? undefined,
    questions: questions.length ? questions : undefined,
    runContract: buildRunContract(extracted),
    contractAccepted: false
  }
}
