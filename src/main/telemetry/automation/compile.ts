import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  AutomationOpSchema,
  AutomationScriptSchema,
  type AutomationOp,
  type AutomationScript,
  type ExtractedWorkflow,
  type PolishedAction,
  type PolishedSession,
  type StoredAutomationScript,
  type WorkflowVariable
} from '../../../shared/telemetry/schema'
import type { TelemetryConfig } from '../config'
import { TelemetryProcessingError, mapToProcessingError } from '../errors'
import type { OpenAIResponsesClient } from '../workflow'
import type { TelemetryStore } from '../store/TelemetryStore'
import { AUTOMATION_COMPILE_INSTRUCTIONS } from './automationPrompt'

export type CompileAutomationDeps = {
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

function actionByEventId(polished: PolishedSession): Map<string, PolishedAction> {
  const map = new Map<string, PolishedAction>()
  for (const action of polished.actions) {
    for (const id of action.sourceEventIds) {
      map.set(id, action)
    }
  }
  return map
}

function labelsRolesForEvidence(
  evidenceIds: string[],
  byEvent: Map<string, PolishedAction>
): { labels: Set<string>; roles: Set<string>; apps: Set<string> } {
  const labels = new Set<string>()
  const roles = new Set<string>()
  const apps = new Set<string>()
  for (const id of evidenceIds) {
    const a = byEvent.get(id)
    if (!a) continue
    if (a.elementLabel) labels.add(a.elementLabel.toLowerCase())
    if (a.elementRole) roles.add(a.elementRole.toLowerCase())
    if (a.appName) apps.add(a.appName.toLowerCase())
  }
  return { labels, roles, apps }
}

function toManual(op: AutomationOp, reason: string): AutomationOp {
  return {
    ...op,
    op: 'manual',
    prompt: op.prompt ?? reason,
    label: op.label ?? 'Complete this step manually',
    elementRole: null,
    elementLabel: null,
    elementPath: null,
    chord: null,
    url: null,
    urlVariableKey: null,
    variableKey: null,
    waitCondition: null,
    waitValue: null,
    confidence: Math.min(op.confidence, 0.4)
  }
}

/**
 * Ground ops against polished evidence. Hallucinated activate_element targets
 * become `manual` instead of failing the whole script. Invalid stepOrder /
 * variable refs throw.
 */
export function validateAndGroundScript(
  script: AutomationScript,
  workflow: ExtractedWorkflow,
  polished: PolishedSession
): AutomationScript {
  const stepOrders = new Set(workflow.steps.map((s) => s.order))
  const varKeys = new Set((workflow.variables ?? []).map((v) => v.key))
  const byEvent = actionByEventId(polished)
  const knownEvents = new Set(polished.actions.flatMap((a) => a.sourceEventIds))
  const warnings = [...script.warnings]

  const ops: AutomationOp[] = script.ops.map((raw) => {
    const parsed = AutomationOpSchema.safeParse(raw)
    if (!parsed.success) {
      throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
    }
    let op = parsed.data

    if (!stepOrders.has(op.stepOrder)) {
      throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
    }

    for (const id of op.evidenceEventIds) {
      if (!knownEvents.has(id)) {
        throw new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
      }
    }

    if (op.op === 'type_text' || op.op === 'set_clipboard') {
      if (!op.variableKey || !varKeys.has(op.variableKey)) {
        op = toManual(op, 'Missing variable for text/clipboard step')
        warnings.push(`Downgraded op at step ${op.stepOrder}: unknown variable`)
      }
    }

    if (op.op === 'ask_user' && op.variableKey && !varKeys.has(op.variableKey)) {
      // Allow ask_user to introduce a key; keep as-is but clear bad key.
      op = { ...op, variableKey: null }
    }

    if (op.op === 'activate_element') {
      const grounded = labelsRolesForEvidence(op.evidenceEventIds, byEvent)
      const labelOk =
        !!op.elementLabel &&
        (grounded.labels.has(op.elementLabel.toLowerCase()) ||
          [...grounded.labels].some(
            (l) =>
              l.includes(op.elementLabel!.toLowerCase()) ||
              op.elementLabel!.toLowerCase().includes(l)
          ))
      const roleOk =
        !op.elementRole ||
        grounded.roles.has(op.elementRole.toLowerCase()) ||
        grounded.roles.size === 0
      if (!labelOk || !op.elementLabel) {
        op = toManual(op, `Could not ground element "${op.elementLabel ?? '?'}"`)
        warnings.push(`Downgraded activate_element at step ${op.stepOrder}: ungrounded target`)
      } else if (!roleOk) {
        op = toManual(op, `Could not ground role "${op.elementRole}"`)
        warnings.push(`Downgraded activate_element at step ${op.stepOrder}: ungrounded role`)
      }
    }

    if (op.op === 'open_app' && !op.appName) {
      op = toManual(op, 'Missing app name')
      warnings.push(`Downgraded open_app at step ${op.stepOrder}: missing app`)
    }

    if (op.op === 'open_url' && !op.url && !op.urlVariableKey) {
      op = toManual(op, 'Missing URL')
      warnings.push(`Downgraded open_url at step ${op.stepOrder}: missing url`)
    }

    if (op.op === 'keystroke' && !op.chord) {
      op = toManual(op, 'Missing keystroke chord')
      warnings.push(`Downgraded keystroke at step ${op.stepOrder}: missing chord`)
    }

    if (op.op === 'wait_for' && !op.waitCondition) {
      op = toManual(op, 'Missing wait condition')
      warnings.push(`Downgraded wait_for at step ${op.stepOrder}: missing condition`)
    }

    return op
  })

  return AutomationScriptSchema.parse({
    ops,
    warnings: warnings.slice(0, 20)
  })
}

function prepareCompileInput(
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  variables: WorkflowVariable[]
): unknown {
  return {
    workflow: {
      title: workflow.title,
      steps: workflow.steps.map((s) => ({
        order: s.order,
        action: s.action,
        category: s.category,
        appName: s.appName,
        evidenceEventIds: s.evidenceEventIds,
        confidence: s.confidence
      }))
    },
    actions: polished.actions.map((a) => ({
      order: a.order,
      text: a.text,
      category: a.category,
      sourceEventIds: a.sourceEventIds,
      appName: a.appName ?? null,
      documentTitle: a.documentTitle ?? null,
      elementLabel: a.elementLabel ?? null,
      elementRole: a.elementRole ?? null,
      clipboard: a.clipboard
        ? {
            contentType: a.clipboard.contentType,
            urlHost: a.clipboard.urlHost ?? null,
            urlPath: a.clipboard.urlPath ?? null
          }
        : null,
      inferred: a.inferred ?? null,
      verified: a.verified ?? null
    })),
    variables: (variables.length ? variables : workflow.variables ?? []).map((v) => ({
      key: v.key,
      label: v.label,
      kind: v.kind,
      exampleSanitized: v.exampleSanitized
    }))
  }
}

/**
 * Second LLM pass: compile ExtractedWorkflow + polished actions into AutomationScript.
 */
export async function compileAutomationScript(
  store: TelemetryStore,
  config: TelemetryConfig,
  sessionId: string,
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  deps: CompileAutomationDeps = {}
): Promise<StoredAutomationScript> {
  if (!config.openaiApiKey) {
    throw new TelemetryProcessingError('OPENAI_API_KEY_MISSING')
  }
  if (!store.saveAutomationScript || !store.getAutomationScript) {
    throw new TelemetryProcessingError('AUTOMATION_COMPILE_FAILED')
  }

  const variables =
    (store.getVariables ? (await store.getVariables(sessionId))?.variables : undefined) ??
    workflow.variables ??
    []

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
          content: AUTOMATION_COMPILE_INSTRUCTIONS
        },
        {
          role: 'user',
          content: JSON.stringify(prepareCompileInput(workflow, polished, variables))
        }
      ],
      text: {
        format: zodTextFormat(AutomationScriptSchema, 'automation_script')
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }

  const parsed = response.output_parsed
  if (!parsed) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const validated = AutomationScriptSchema.safeParse(parsed)
  if (!validated.success) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const grounded = validateAndGroundScript(validated.data, workflow, polished)
  return store.saveAutomationScript(sessionId, grounded, model, { stale: false })
}
