import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  ExtractedWorkflowSchema,
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

export type OpenAIResponsesClient = {
  responses: {
    parse: (body: unknown) => Promise<{
      output_parsed: unknown
      usage?: {
        input_tokens?: number
        output_tokens?: number
        total_tokens?: number
      }
    }>
  }
}

export type ExtractWorkflowDeps = {
  createClient?: (apiKey: string) => OpenAIResponsesClient
}

function defaultClient(apiKey: string): OpenAIResponsesClient {
  const client = new OpenAI({ apiKey })
  return {
    responses: {
      parse: (body: unknown) =>
        client.responses.parse(body as Parameters<typeof client.responses.parse>[0]) as Promise<{
          output_parsed: unknown
          usage?: {
            input_tokens?: number
            output_tokens?: number
            total_tokens?: number
          }
        }>
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
): Promise<{ parsed: unknown; usage?: TokenUsage }> {
  let response: { output_parsed: unknown; usage?: { input_tokens?: number; output_tokens?: number } }
  try {
    response = await client.responses.parse({
      model,
      store: false,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(userPayload) }
      ],
      text: {
        format: zodTextFormat(ExtractedWorkflowSchema, formatName)
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }
  return { parsed: response.output_parsed, usage: usageFromResponse(response) }
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
  const classify = await parseWorkflowResponse(
    client,
    model,
    CLASSIFY_INSTRUCTIONS,
    prepared.body,
    'workflow_classify'
  )
  logTokenUsage('workflow_classify', classify.usage)
  let totalUsage = classify.usage

  let classified: ExtractedWorkflow | null = null
  try {
    classified = finalizeParsedWorkflow(classify.parsed, prepared, variables, addresses, {
      skipQuestions: true
    })
  } catch {
    classified = null
  }

  if (!classified) {
    const single = await parseWorkflowResponse(
      client,
      model,
      WORKFLOW_INSTRUCTIONS,
      prepared.body,
      'workflow_summary'
    )
    logTokenUsage('workflow', single.usage)
    totalUsage = addUsage(totalUsage, single.usage)
    const workflow = finalizeParsedWorkflow(single.parsed, prepared, variables, addresses)
    return { workflow, usage: totalUsage }
  }

  const extract = await parseWorkflowResponse(
    client,
    model,
    EXTRACT_INSTRUCTIONS,
    {
      telemetry: prepared.body,
      addrs: prepared.body.addrs ?? [],
      classified: compactClassified(classified)
    },
    'workflow_extract'
  )
  logTokenUsage('workflow_extract', extract.usage)
  totalUsage = addUsage(totalUsage, extract.usage)

  let workflow: ExtractedWorkflow
  try {
    workflow = finalizeParsedWorkflow(extract.parsed, prepared, variables, addresses)
  } catch {
    // Extract failed validation — keep classified + deterministic questions.
    workflow = finalizeParsedWorkflow(classified, prepared, variables, addresses)
  }

  return { workflow, usage: totalUsage }
}

function compactClassified(w: ExtractedWorkflow): unknown {
  return {
    title: w.title,
    goal: w.goal,
    summary: w.summary,
    outcome: w.outcome,
    warnings: w.warnings,
    variables: w.variables,
    steps: w.steps.map((s) => ({
      order: s.order,
      id: s.id,
      intent: s.intent,
      summary: s.summary,
      action: s.action,
      category: s.category,
      appName: s.appName,
      evidenceEventIds: s.evidenceEventIds,
      confidence: s.confidence,
      needsClarification: s.needsClarification,
      alternatives: s.alternatives,
      objective: s.objective,
      actionType: s.actionType
    }))
  }
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
        evidenceEventIds: st.evidenceEventIds,
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

  const preparedForResolve: PreparedWorkflowModelInput = {
    body: finalPrepared.body,
    evidenceMap: fullPrepared.evidenceMap,
    resolveEvidence: fullPrepared.resolveEvidence,
    estimatedChars: fullPrepared.estimatedChars
  }
  const workflow = finalizeParsedWorkflow(parsed, preparedForResolve, variables, addresses)
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
  const withDefaults = {
    ...raw,
    steps: (raw.steps as ExtractedWorkflow['steps']).map((s) =>
      withWorkflowStepDefaults(s as unknown as Record<string, unknown>)
    ),
    addresses: raw.addresses ?? null,
    commits: raw.commits ?? null,
    writes: raw.writes ?? null,
    inputs: raw.inputs ?? null,
    authorizationScope: raw.authorizationScope ?? null,
    branches: raw.branches ?? null,
    questions: raw.questions ?? null,
    variables: raw.variables ?? null
  }

  const validatedResult = ExtractedWorkflowSchema.safeParse(withDefaults)
  if (!validatedResult.success) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const expandedSteps = validatedResult.data.steps.map((step, idx) =>
    withWorkflowStepDefaults({
      ...step,
      id: step.id ?? `step_${idx + 1}`,
      evidenceEventIds: prepared.resolveEvidence(step.evidenceEventIds)
    })
  )

  const persistedAddresses =
    validatedResult.data.addresses && validatedResult.data.addresses.length > 0
      ? validatedResult.data.addresses
      : addresses.length
        ? addresses
        : null

  const base: ExtractedWorkflow = {
    ...validatedResult.data,
    steps: expandedSteps,
    addresses: persistedAddresses,
    variables:
      validatedResult.data.variables && validatedResult.data.variables.length > 0
        ? validatedResult.data.variables
        : variables.length
          ? variables
          : null
  }

  if (opts.skipQuestions) return base

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
  const known = new Set(polished.actions.flatMap((a) => a.sourceEventIds))
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
