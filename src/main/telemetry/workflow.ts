import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  ExtractedWorkflowSchema,
  withWorkflowStepDefaults,
  type ExtractedWorkflow,
  type PolishedAction,
  type PolishedSession,
  type StoredWorkflowResult,
  type TelemetrySessionMeta,
  type TokenUsage,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import type { TelemetryConfig } from './config'
import { TelemetryProcessingError, mapToProcessingError } from './errors'
import {
  MODEL_INPUT_CHAR_BUDGET,
  prepareWorkflowModelInput,
  type CompactWorkflowModelInput,
  type PreparedWorkflowModelInput
} from './modelInput'
import {
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
  if (store.saveVariables && variables.length > 0) {
    try {
      await store.saveVariables(session.sessionId, variables)
    } catch (err) {
      console.error('[telemetry] saveVariables failed', err instanceof Error ? err.name : 'error')
    }
  }

  const prepared = prepareWorkflowModelInput(session, polished, { variables })
  const createClient = deps.createClient ?? defaultClient
  const client = createClient(config.openaiApiKey)
  const model = config.openaiModel

  const { workflow, usage } =
    prepared.estimatedChars > MODEL_INPUT_CHAR_BUDGET && (polished.segments?.length ?? 0) > 1
      ? await extractWorkflowChunked(client, model, session, polished, variables, prepared)
      : await extractWorkflowSingle(client, model, prepared, variables)

  assertEvidence(workflow, polished)
  return store.saveWorkflow(session.sessionId, workflow, model, { usage })
}

async function extractWorkflowSingle(
  client: OpenAIResponsesClient,
  model: string,
  prepared: PreparedWorkflowModelInput,
  variables: WorkflowVariable[]
): Promise<{ workflow: ExtractedWorkflow; usage?: TokenUsage }> {
  let response: { output_parsed: unknown; usage?: { input_tokens?: number; output_tokens?: number } }
  try {
    response = await client.responses.parse({
      model,
      store: false,
      input: [
        {
          role: 'system',
          content: WORKFLOW_INSTRUCTIONS
        },
        {
          role: 'user',
          content: JSON.stringify(prepared.body)
        }
      ],
      text: {
        format: zodTextFormat(ExtractedWorkflowSchema, 'workflow_summary')
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }

  const usage = usageFromResponse(response)
  logTokenUsage('workflow', usage)

  const workflow = finalizeParsedWorkflow(response.output_parsed, prepared, variables)
  return { workflow, usage }
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
    return extractWorkflowSingle(client, model, fullPrepared, variables)
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
      maxActions: 48
    })
    let response: {
      output_parsed: unknown
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    try {
      response = await client.responses.parse({
        model,
        store: false,
        input: [
          { role: 'system', content: WORKFLOW_CHUNK_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify(prepared.body) }
        ],
        text: {
          format: zodTextFormat(ExtractedWorkflowSchema, 'workflow_chunk_summary')
        }
      })
    } catch (err) {
      throw mapToProcessingError(err)
    }
    const usage = usageFromResponse(response)
    logTokenUsage(`workflow_chunk_${i + 1}`, usage)
    totalUsage = addUsage(totalUsage, usage)
    summaries.push(finalizeParsedWorkflow(response.output_parsed, prepared, variables))
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
    maxActions: 48
  })

  const carryForward = {
    priorSummaries: summaries.map((s) => ({
      title: s.title,
      goal: s.goal,
      summary: s.summary.slice(0, 400),
      steps: s.steps.slice(0, 12).map((st) => ({
        order: st.order,
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
    vars: finalPrepared.body.vars
  }

  let response: {
    output_parsed: unknown
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  try {
    response = await client.responses.parse({
      model,
      store: false,
      input: [
        { role: 'system', content: WORKFLOW_INSTRUCTIONS },
        {
          role: 'user',
          content: JSON.stringify({
            mode: 'assemble_from_chunks',
            ...carryForward
          })
        }
      ],
      text: {
        format: zodTextFormat(ExtractedWorkflowSchema, 'workflow_summary')
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }

  const usage = usageFromResponse(response)
  logTokenUsage('workflow_assemble', usage)
  totalUsage = addUsage(totalUsage, usage)

  const preparedForResolve: PreparedWorkflowModelInput = {
    body: finalPrepared.body,
    evidenceMap: fullPrepared.evidenceMap,
    resolveEvidence: fullPrepared.resolveEvidence,
    estimatedChars: fullPrepared.estimatedChars
  }
  const workflow = finalizeParsedWorkflow(response.output_parsed, preparedForResolve, variables)
  return { workflow, usage: totalUsage }
}

function finalizeParsedWorkflow(
  parsed: unknown,
  prepared: PreparedWorkflowModelInput,
  variables: WorkflowVariable[]
): ExtractedWorkflow {
  if (!parsed) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const withDefaults =
    typeof parsed === 'object' && parsed && Array.isArray((parsed as ExtractedWorkflow).steps)
      ? {
          ...(parsed as ExtractedWorkflow),
          steps: (parsed as ExtractedWorkflow).steps.map((s) =>
            withWorkflowStepDefaults(s as unknown as Record<string, unknown>)
          )
        }
      : parsed

  const validatedResult = ExtractedWorkflowSchema.safeParse(withDefaults)
  if (!validatedResult.success) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const expandedSteps = validatedResult.data.steps.map((step) =>
    withWorkflowStepDefaults({
      ...step,
      evidenceEventIds: prepared.resolveEvidence(step.evidenceEventIds)
    })
  )

  return {
    ...validatedResult.data,
    steps: expandedSteps,
    variables:
      validatedResult.data.variables && validatedResult.data.variables.length > 0
        ? validatedResult.data.variables
        : variables.length
          ? variables
          : null
  }
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

/**
 * Map an extracted workflow into the app's editor Workflow shape (best-effort).
 */
export function toEditorWorkflow(
  extracted: ExtractedWorkflow,
  id: string,
  sessionId?: string
): {
  id: string
  name: string
  metaLabel: string
  trigger: { cadence?: undefined }
  steps: Array<{
    id: string
    index: number
    title: string
  }>
  status: 'off'
  runCount: 0
  hoursReturned: string
  scope: 'personal'
  sessionId?: string
  automationStale?: boolean
} {
  return {
    id,
    name: extracted.title,
    metaLabel: `${extracted.steps.length} steps`,
    trigger: {},
    steps: extracted.steps.map((s, i) => ({
      id: `step_${i + 1}`,
      index: i + 1,
      title: s.action
    })),
    status: 'off',
    runCount: 0,
    hoursReturned: '0',
    scope: 'personal',
    sessionId,
    automationStale: false
  }
}
