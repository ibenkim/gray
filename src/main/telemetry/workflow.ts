import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  ExtractedWorkflowSchema,
  type ExtractedWorkflow,
  type PolishedSession,
  type StoredWorkflowResult,
  type TelemetrySessionMeta,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import type { TelemetryConfig } from './config'
import { TelemetryProcessingError, mapToProcessingError } from './errors'
import { createWorkflowModelInput } from './modelInput'
import { WORKFLOW_INSTRUCTIONS } from './prompt'
import type { TelemetryStore } from './store/TelemetryStore'
import { extractWorkflowVariables } from './variables'

export type OpenAIResponsesClient = {
  responses: {
    parse: (body: unknown) => Promise<{ output_parsed: unknown }>
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
        }>
    }
  }
}

/**
 * One OpenAI Responses API call per completed session (never per event).
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

  const modelInput = createWorkflowModelInput(session, polished, { variables })
  const createClient = deps.createClient ?? defaultClient
  const client = createClient(config.openaiApiKey)
  const model = config.openaiModel

  let response: { output_parsed: unknown }
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
          content: JSON.stringify(modelInput)
        }
      ],
      text: {
        format: zodTextFormat(ExtractedWorkflowSchema, 'workflow_summary')
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }

  const parsed = response.output_parsed
  if (!parsed) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const validatedResult = ExtractedWorkflowSchema.safeParse(parsed)
  if (!validatedResult.success) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  // Prefer deterministic variables when the model omitted them.
  const workflow: ExtractedWorkflow = {
    ...validatedResult.data,
    variables:
      validatedResult.data.variables && validatedResult.data.variables.length > 0
        ? validatedResult.data.variables
        : variables.length
          ? variables
          : null
  }

  assertEvidence(workflow, polished)
  return store.saveWorkflow(session.sessionId, workflow, model)
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
  id: string
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
    scope: 'personal'
  }
}
