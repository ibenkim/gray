import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import {
  AutomationOpSchema,
  AutomationScriptSchema,
  type Address,
  type AutomationOp,
  type AutomationScript,
  type ExtractedWorkflow,
  type PolishedAction,
  type PolishedSession,
  type StoredAutomationScript,
  type WorkflowVariable
} from '../../../shared/telemetry/schema'
import { resolveAddressTemplate } from '../addresses'
import type { TelemetryConfig } from '../config'
import { TelemetryProcessingError, mapToProcessingError } from '../errors'
import type { TelemetryStore } from '../store/TelemetryStore'
import { logTokenUsage, usageFromResponse, type OpenAIResponsesClient } from '../workflow'
import { AUTOMATION_COMPILE_INSTRUCTIONS } from './automationPrompt'
import {
  allowedLiteralsFromPolished,
  isAllowedLiteral,
  looksLikeShellNoise,
  pickLiteralFromEvidence,
  searchQueryFromTitle
} from './groundText'

export type CompileAutomationDeps = {
  createClient?: (apiKey: string) => OpenAIResponsesClient
  /** In-memory clipboard plaintext from the just-finished recording (hash → text). */
  clipboardByHash?: Map<string, string> | Record<string, string>
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
    literalText: null,
    waitCondition: null,
    waitValue: null,
    clickX: null,
    clickY: null,
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
  polished: PolishedSession,
  clipboardByHash?: Map<string, string> | Record<string, string>
): AutomationScript {
  const stepOrders = new Set(workflow.steps.map((s) => s.order))
  const varKeys = new Set((workflow.variables ?? []).map((v) => v.key))
  const byEvent = actionByEventId(polished)
  const knownEvents = new Set(polished.actions.flatMap((a) => a.sourceEventIds))
  const warnings = [...script.warnings]
  const allowedLiterals = allowedLiteralsFromPolished(polished)
  const clipMap = toClipboardMap(clipboardByHash)

  // Clipboard plaintext captured in-session may be replayed via set_clipboard.
  for (const text of clipMap.values()) {
    if (text.trim() && !looksLikeShellNoise(text)) allowedLiterals.add(text.trim())
  }
  // Editor / extracted step text is authoritative when the user edits a step.
  for (const lit of literalsFromWorkflowSteps(workflow)) {
    if (lit.trim() && !looksLikeShellNoise(lit)) allowedLiterals.add(lit.trim())
  }

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

    if (op.op === 'type_text') {
      const hasVariable = !!op.variableKey && varKeys.has(op.variableKey)
      let literal = op.literalText?.trim() || null

      // Never trust model-invented strings — only evidence.
      if (literal && !isAllowedLiteral(literal, allowedLiterals)) {
        const fromEvidence = pickLiteralFromEvidence(op.evidenceEventIds, byEvent)
        if (fromEvidence && isAllowedLiteral(fromEvidence, allowedLiterals)) {
          warnings.push(
            `Replaced invented literalText at step ${op.stepOrder} with captured evidence`
          )
          literal = fromEvidence
          op = { ...op, literalText: fromEvidence }
        } else {
          literal = null
          op = { ...op, literalText: null }
        }
      }

      if (literal && looksLikeShellNoise(literal)) {
        literal = null
        op = { ...op, literalText: null }
        warnings.push(`Dropped shell-noise literalText at step ${op.stepOrder}`)
      }

      if (!hasVariable && !literal) {
        const recovered = pickLiteralFromEvidence(op.evidenceEventIds, byEvent)
        if (recovered && !looksLikeShellNoise(recovered)) {
          op = { ...op, literalText: recovered, variableKey: null }
        } else {
          op = toManual(op, 'Missing captured text for this step')
          warnings.push(`Downgraded type_text at step ${op.stepOrder}: no grounded text`)
        }
      } else if (!hasVariable && op.variableKey) {
        op = { ...op, variableKey: null }
      }
    }

    if (op.op === 'set_clipboard') {
      const hasVariable = !!op.variableKey && varKeys.has(op.variableKey)
      let literal = op.literalText?.trim() || null

      if (literal && !isAllowedLiteral(literal, allowedLiterals)) {
        literal = null
        op = { ...op, literalText: null }
      }

      if (!hasVariable && !literal) {
        const fromClip = clipboardTextFromEvidence(op.evidenceEventIds, byEvent, clipMap)
        const fromTyped = pickLiteralFromEvidence(op.evidenceEventIds, byEvent)
        const recovered = fromClip ?? fromTyped
        if (recovered && !looksLikeShellNoise(recovered)) {
          op = { ...op, literalText: recovered, variableKey: null }
        } else {
          op = toManual(op, 'Copy the needed text, then continue')
          warnings.push(`Downgraded set_clipboard at step ${op.stepOrder}: no captured content`)
        }
      } else if (!hasVariable && op.variableKey) {
        op = { ...op, variableKey: null }
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

  const collapsed = collapseRedundantTypeTexts(ops, warnings)
  const withTabs = ensureBrowserNewTab(collapsed, polished, warnings)
  const withClicks = preferClickAtWhenGrounded(withTabs, polished, byEvent, warnings)
  const withInferred = recoverInferredActions(withClicks, workflow, polished, warnings)
  const withAddresses = preferAddressNavigation(withInferred, workflow, warnings)
  const withIntent = applyEditorIntentToOps(withAddresses, workflow, polished, warnings)
  const withInjected = injectClickOpsFromEvidence(withIntent, workflow, polished, warnings)
  // After click injection — Drive "New → Sheets" coords are flaky; prefer create URL.
  const withCreateSheet = rewriteCreateSheetClicks(withInjected, workflow, polished, warnings)
  // Capture often misses the Sheets menu click and typed rename — recover from polished evidence.
  const withEvidence = ensureCreateRenameFromEvidence(
    withCreateSheet,
    workflow,
    polished,
    warnings
  )
  const withWaits = injectWaitOpsFromStepSemantics(withEvidence, workflow, polished, warnings)
  const withNav = collapseRedundantBrowserNav(withWaits, warnings)
  // Re-order again after wait injection / nav collapse so Untitled waits never precede create.
  const ordered = orderCreateSheetSequences(withNav, warnings)
  const finalOps = hoistCreateSheetBeforeMisplacedWaits(ordered, warnings)


  return AutomationScriptSchema.parse({
    ops: finalOps,
    warnings: warnings.slice(0, 20)
  })
}

/**
 * Deterministically add wait_for ops from step.completionCheck / expectedChange
 * and polished waitedMs when the compile model omitted them.
 */
export function injectWaitOpsFromStepSemantics(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const out = [...ops]
  const byStep = new Map<number, AutomationOp[]>()
  for (const op of out) {
    const list = byStep.get(op.stepOrder) ?? []
    list.push(op)
    byStep.set(op.stepOrder, list)
  }

  for (const step of workflow.steps) {
    const stepOps = byStep.get(step.order) ?? []
    if (stepOps.some((o) => o.op === 'wait_for')) continue

    const hint = [step.completionCheck, step.expectedChange].filter(Boolean).join(' ')
    const wait = inferWaitFromText(hint, step.appName)
    if (!wait) {
      // Fall back to polished waitedMs on evidence actions.
      const waited = polished.actions
        .filter((a) => step.evidenceEventIds.some((id) => a.sourceEventIds.includes(id)))
        .map((a) => a.waitedMs ?? 0)
        .reduce((m, v) => Math.max(m, v), 0)
      if (waited >= 5000 && step.appName) {
        const insertAt = out.findIndex((o) => o.stepOrder === step.order)
        const waitOp: AutomationOp = {
          op: 'wait_for',
          stepOrder: step.order,
          evidenceEventIds: step.evidenceEventIds,
          confidence: Math.min(step.confidence, 0.7),
          timeoutMs: Math.min(60_000, Math.max(5_000, waited)),
          label: `Wait for ${step.appName}`,
          appName: step.appName,
          appBundleId: null,
          url: null,
          urlVariableKey: null,
          elementRole: null,
          elementLabel: null,
          elementPath: null,
          chord: null,
          variableKey: null,
          literalText: null,
          waitCondition: 'app_frontmost',
          waitValue: step.appName,
          prompt: null,
          clickX: null,
          clickY: null
        }
        if (insertAt >= 0) out.splice(insertAt + stepOps.length, 0, waitOp)
        else out.push(waitOp)
        warnings.push(`Injected wait_for for step ${step.order} from waitedMs`)
      }
      continue
    }

    const insertAt = out.findIndex((o) => o.stepOrder === step.order)
    const waitOp: AutomationOp = {
      op: 'wait_for',
      stepOrder: step.order,
      evidenceEventIds: step.evidenceEventIds,
      confidence: Math.min(step.confidence, 0.75),
      timeoutMs: 15_000,
      label: wait.label,
      appName: step.appName,
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: wait.condition === 'element_exists' ? step.targetRole : null,
      elementLabel: wait.condition === 'element_exists' ? step.targetLabel : null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: wait.condition,
      waitValue: wait.value,
      prompt: null,
      clickX: null,
      clickY: null
    }
    if (insertAt >= 0) out.splice(insertAt + stepOps.length, 0, waitOp)
    else out.push(waitOp)
    warnings.push(`Injected wait_for for step ${step.order} from completionCheck/expectedChange`)
  }

  return out
}

function isPlausibleWaitValue(value: string): boolean {
  const t = value.trim()
  if (t.length < 2 || t.length > 80) return false
  // Reject completionCheck prose leaked as the wait value.
  if (/\.\s+\S/.test(t)) return false
  if (/^(is|are|becomes|will|should|the|an|a)\b/i.test(t)) return false
  return true
}

function inferWaitFromText(
  text: string,
  appName: string | null
): { condition: 'app_frontmost' | 'window_title_contains' | 'element_exists'; value: string; label: string } | null {
  if (!text.trim()) return null
  const quotedWindow = text.match(
    /window(?: title)?(?:\s+contains)?\s+[“"']([^”"']+)[”"']/i
  )
  if (quotedWindow?.[1] && isPlausibleWaitValue(quotedWindow[1])) {
    return {
      condition: 'window_title_contains',
      value: quotedWindow[1].slice(0, 80),
      label: `Wait for window ${quotedWindow[1].slice(0, 40)}`
    }
  }
  const titledDoc = text.match(
    /\b((?:Untitled(?:\s+spreadsheet|\s+document)?)|[\w][\w\s-]{1,40})\s*[-—|]\s*Google (?:Sheets|Docs|Drive)\b/i
  )
  if (titledDoc?.[0] && isPlausibleWaitValue(titledDoc[0])) {
    return {
      condition: 'window_title_contains',
      value: titledDoc[0].slice(0, 80),
      label: `Wait for ${titledDoc[0].slice(0, 40)}`
    }
  }
  const elementMatch = text.match(/(?:element|field|button|control)\s+[“"']([^”"']+)[”"']/i)
  if (elementMatch?.[1] && isPlausibleWaitValue(elementMatch[1])) {
    return {
      condition: 'element_exists',
      value: elementMatch[1].slice(0, 80),
      label: `Wait for ${elementMatch[1].slice(0, 40)}`
    }
  }
  if (/frontmost|app (is )?open|application/i.test(text) && appName) {
    return {
      condition: 'app_frontmost',
      value: appName,
      label: `Wait for ${appName}`
    }
  }
  if (/load|appear|finish|ready|cleared/i.test(text) && appName) {
    return {
      condition: 'app_frontmost',
      value: appName,
      label: `Wait for ${appName}`
    }
  }
  return null
}

/** Well-known destinations when capture lacked a concrete URL. */
const DESTINATION_URLS: Array<{ re: RegExp; url: string; label: string }> = [
  { re: /\bgoogle\s*drive\b/i, url: 'https://drive.google.com/', label: 'Open Google Drive' },
  { re: /\bdrive\.google\.com\b/i, url: 'https://drive.google.com/', label: 'Open Google Drive' },
  { re: /\bgoogle\s*docs\b/i, url: 'https://docs.google.com/', label: 'Open Google Docs' },
  { re: /\bdocs\.google\.com\b/i, url: 'https://docs.google.com/', label: 'Open Google Docs' },
  { re: /\bgmail\b/i, url: 'https://mail.google.com/', label: 'Open Gmail' },
  { re: /\bgoogle\s*calendar\b/i, url: 'https://calendar.google.com/', label: 'Open Google Calendar' },
  { re: /\byoutube\b/i, url: 'https://www.youtube.com/', label: 'Open YouTube' }
]

function quotedName(text: string): string | null {
  const m = text.match(/[“"]([^”"]+)[”"]/)
  const name = m?.[1]?.replace(/\s*[-—|].*$/, '').trim()
  if (!name || name.length < 2 || name.length > 120) return null
  if (/ground|element|button|fake|manual/i.test(name)) return null
  return name
}

/** True when the step means "create a new Google Sheet", not "create columns…". */
export function isCreateSheetIntent(blob: string): boolean {
  if (/\bcreate\s+columns?\b/i.test(blob)) return false
  // Opening a named sheet (even if UI passed through Untitled) is not "create".
  if (/\bopen(?:ed|ing)?\b/i.test(blob) && /\bspreadsheet\b/i.test(blob) && !/\buntitled\b/i.test(blob)) {
    return false
  }
  if (/\b(inspect|select|edit|enter|type|fill|rename|renamed)\b/i.test(blob) && !/\b(create|new)\b/i.test(blob)) {
    return false
  }
  if (/\b(create|new)\s+(a\s+)?(new\s+)?(google\s*)?(spreadsheet|sheets?)\b/i.test(blob)) {
    return true
  }
  if (/\b(create|new)\b/i.test(blob) && /\bgoogle\s*sheets?\b/i.test(blob)) return true
  if (/\bcreate\b/i.test(blob) && /\bspreadsheet\b/i.test(blob) && !/\bcolumns?\b/i.test(blob)) {
    return true
  }
  // Exact create phrasing from polish/model — not "open Data Logs … untitled view".
  if (/\bopen(?:ed)?\s+(an?\s+)?untitled\s+spreadsheet\b/i.test(blob)) return true
  if (/\b(create|new)\b/i.test(blob) && /untitled\s+spreadsheet/i.test(blob)) return true
  return false
}

const CREATE_SHEET_URL = 'https://docs.google.com/spreadsheets/create'

function isCreateSheetUrl(url: string | null | undefined): boolean {
  return !!url && /docs\.google\.com\/spreadsheets\/create/i.test(url)
}

/** Capture saw navigation through docs.google.com/spreadsheets/create. */
export function polishedImpliesCreateSheet(polished: PolishedSession): boolean {
  for (const a of polished.actions) {
    const detail = a.screenAfter?.stateChangeDetail ?? ''
    if (/spreadsheets\/create/i.test(detail)) return true
    if (/spreadsheets\/create/i.test(a.documentTitle ?? '')) return true
  }
  return false
}

/**
 * Infer rename target from polished title transitions
 * (Untitled spreadsheet → Data Collection - Google Sheets).
 */
export function renameNameFromPolishedTitleChange(polished: PolishedSession): string | null {
  for (const a of polished.actions) {
    const detail = a.screenAfter?.stateChangeDetail ?? ''
    const m = detail.match(
      /Title:\s*Untitled(?:\s+spreadsheet)?(?:\s*[-—|]\s*Google Sheets)?\s*→\s*(.+?)(?:\s*[-—|]\s*Google Sheets)?\s*$/i
    )
    if (m?.[1]) {
      const name = m[1].trim()
      if (name.length >= 2 && name.length <= 120 && !/^untitled/i.test(name)) return name
    }
  }
  let sawUntitled = false
  for (const a of polished.actions) {
    const t = (a.documentTitle ?? '').trim()
    if (/^untitled(\s+spreadsheet)?(\s*[-—|].*)?$/i.test(t)) {
      sawUntitled = true
      continue
    }
    if (!sawUntitled) continue
    const named = t.match(/^(.+?)\s*[-—|]\s*Google Sheets$/i)
    if (named?.[1] && !/^untitled/i.test(named[1])) return named[1].trim()
  }
  return null
}

function isDriveDocumentTitle(title: string | null | undefined): boolean {
  return !!title && (/drive\.google\.com/i.test(title) || /google drive/i.test(title))
}

/**
 * When Drive New → Sheets menu clicks are missing from capture, still emit create URL.
 * When typed rename is missing but the title changed, emit click + type + Enter.
 * Drop open_url to the captured sheet id / unresolved file variable during create flows.
 */
export function ensureCreateRenameFromEvidence(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  let out = [...ops]
  const addrImpliesCreate = (workflow.addresses ?? []).some((a) =>
    /spreadsheets\/create/i.test(a.template)
  )
  const impliesCreate = polishedImpliesCreateSheet(polished) || addrImpliesCreate
  const hasCreate = out.some((o) => o.op === 'open_url' && isCreateSheetUrl(o.url))

  if (impliesCreate && !hasCreate) {
    const untitledWaitIdx = out.findIndex(
      (o) => o.op === 'wait_for' && /untitled/i.test(o.waitValue ?? '')
    )
    const driveClickIdx = out.findIndex((o) => {
      if (o.op !== 'click_at' || o.clickX == null) return false
      return polished.actions.some(
        (a) =>
          a.sourceEventIds.some((id) => o.evidenceEventIds.includes(id)) &&
          isDriveDocumentTitle(a.documentTitle)
      )
    })
    const seedIdx = driveClickIdx >= 0 ? driveClickIdx : untitledWaitIdx
    if (seedIdx >= 0) {
      const seed = out[seedIdx]!
      const createOp = baseFromOp(seed, {
        op: 'open_url',
        url: CREATE_SHEET_URL,
        label: 'Create a new Google Sheet',
        clickX: null,
        clickY: null,
        urlVariableKey: null,
        waitCondition: null,
        waitValue: null,
        confidence: Math.min(seed.confidence, 0.85),
        timeoutMs: Math.max(seed.timeoutMs, 15_000)
      })
      if (driveClickIdx >= 0) {
        out[driveClickIdx] = createOp
        warnings.push(
          'Replaced Drive New-menu click_at with spreadsheets/create (menu follow-up often uncaptured)'
        )
      } else {
        out.splice(untitledWaitIdx, 0, createOp)
        warnings.push('Inserted spreadsheets/create before Untitled wait from capture evidence')
      }
    }
  }

  const hasCreateNow = out.some((o) => o.op === 'open_url' && isCreateSheetUrl(o.url))
  if (hasCreateNow) {
    out = out.filter((o) => {
      if (o.op !== 'open_url') return true
      if (isCreateSheetUrl(o.url)) return true
      if (o.url && /spreadsheets\/d\//i.test(o.url)) {
        warnings.push(`Dropped open_url to existing sheet id at step ${o.stepOrder} (create flow)`)
        return false
      }
      if (!o.url && o.urlVariableKey) {
        warnings.push(
          `Dropped unresolved open_url variable “${o.urlVariableKey}” at step ${o.stepOrder} (create flow)`
        )
        return false
      }
      return true
    })
  } else {
    out = out.map((o) => {
      if (o.op !== 'open_url' || o.url || !o.urlVariableKey) return o
      const v = workflow.variables?.find((x) => x.key === o.urlVariableKey)
      const ex = v?.exampleSanitized
      if (ex && /^https?:\/\//i.test(ex)) {
        warnings.push(`Resolved open_url from variable “${o.urlVariableKey}”`)
        return { ...o, url: ex, urlVariableKey: null }
      }
      warnings.push(`Downgraded open_url missing url for variable “${o.urlVariableKey}”`)
      return toManual(o, `Missing URL for variable ${o.urlVariableKey}`)
    })
  }

  const renameName = renameNameFromPolishedTitleChange(polished)
  const alreadyTypesRename =
    !!renameName &&
    out.some(
      (o) =>
        o.op === 'type_text' &&
        (o.literalText ?? '').trim().toLowerCase() === renameName.toLowerCase()
    )
  if (renameName && !alreadyTypesRename) {
    const untitledWaitIdx = out.findIndex(
      (o) => o.op === 'wait_for' && /untitled/i.test(o.waitValue ?? '')
    )
    const titleClick = polished.actions.find(
      (a) =>
        a.clickX != null &&
        a.clickY != null &&
        a.clickY < 160 &&
        /docs\.google\.com|spreadsheet/i.test(a.documentTitle ?? '')
    )
    const seed =
      (untitledWaitIdx >= 0 ? out[untitledWaitIdx] : null) ??
      out.find((o) => o.op === 'click_at' && o.clickY != null && o.clickY < 160) ??
      out.find((o) => o.op === 'open_url' && isCreateSheetUrl(o.url)) ??
      out[0]
    if (seed) {
      if (titleClick) {
        const dropIdx = out.findIndex(
          (o) =>
            o.op === 'click_at' &&
            o.clickX === titleClick.clickX &&
            o.clickY === titleClick.clickY
        )
        if (dropIdx >= 0) out.splice(dropIdx, 1)
      }
      const renameOps = renameOpsFor(seed, renameName, polished, warnings)
      const insertAt = untitledWaitIdx >= 0 ? untitledWaitIdx + 1 : out.length
      out.splice(Math.min(insertAt, out.length), 0, ...renameOps)
      warnings.push(`Inferred rename “${renameName}” from polished title change`)
    }
  }

  return orderCreateSheetSequences(out, warnings)
}

/**
 * Replace the first create-sheet click_at in a step with the stable create URL,
 * then reorder that step so create → wait Untitled → rename/type → later waits.
 */
export function rewriteCreateSheetClicks(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const stepByOrder = new Map(workflow.steps.map((s) => [s.order, s]))
  const rewritten = new Set<number>()
  const out: AutomationOp[] = []

  for (const op of ops) {
    const step = stepByOrder.get(op.stepOrder)
    const stepBlob = [op.label, step?.action, step?.summary].filter(Boolean).join(' ')
    const evidenceBlob = polished.actions
      .filter((a) => a.sourceEventIds.some((id) => op.evidenceEventIds.includes(id)))
      .map((a) => `${a.documentTitle ?? ''} ${a.text ?? ''}`)
      .join(' ')
    const wantsCreate =
      isCreateSheetIntent(stepBlob) ||
      (/\b(create|new)\b/i.test(stepBlob) && /untitled\s+spreadsheet/i.test(evidenceBlob))

    const stepAlreadyCreates = ops.some(
      (o) => o.stepOrder === op.stepOrder && o.op === 'open_url' && isCreateSheetUrl(o.url)
    )

    if (
      op.op === 'click_at' &&
      !rewritten.has(op.stepOrder) &&
      !stepAlreadyCreates &&
      wantsCreate
    ) {
      rewritten.add(op.stepOrder)
      warnings.push(`Rewrote create-sheet click_at → open_url at step ${op.stepOrder}`)
      out.push(
        baseFromOp(op, {
          op: 'open_url',
          url: CREATE_SHEET_URL,
          label: 'Create a new Google Sheet',
          clickX: null,
          clickY: null,
          confidence: Math.min(op.confidence, 0.85),
          timeoutMs: Math.max(op.timeoutMs, 15_000)
        })
      )
      continue
    }

    out.push(op)
  }

  return orderCreateSheetSequences(out, warnings)
}

/**
 * Cross-step: if Untitled wait_for (or rename clicks) appear before the create URL
 * in the flat op list, move them immediately after create + its Untitled wait.
 */
export function hoistCreateSheetBeforeMisplacedWaits(
  ops: AutomationOp[],
  warnings: string[]
): AutomationOp[] {
  const createIdx = ops.findIndex((o) => o.op === 'open_url' && isCreateSheetUrl(o.url))
  if (createIdx < 0) return ops

  const before = ops.slice(0, createIdx)
  const createOp = ops[createIdx]!
  const after = ops.slice(createIdx + 1)

  const misplaced = before.filter(
    (o) =>
      (o.op === 'wait_for' && /untitled/i.test(o.waitValue ?? '')) ||
      (o.op === 'click_at' && o.stepOrder === createOp.stepOrder) ||
      (o.op === 'type_text' && o.stepOrder === createOp.stepOrder)
  )
  if (misplaced.length === 0) return ops

  const keptBefore = before.filter((o) => !misplaced.includes(o))
  warnings.push('Hoisted create-sheet URL ahead of misplaced Untitled wait/rename ops')
  return [...keptBefore, createOp, ...misplaced, ...after]
}

/**
 * Ensure create-sheet steps run as: open_url create → wait Untitled → clicks/type → other waits.
 * Fixes stalled runs where wait_for Untitled preceded the create URL.
 */
export function orderCreateSheetSequences(
  ops: AutomationOp[],
  warnings: string[]
): AutomationOp[] {
  const orders = [...new Set(ops.map((o) => o.stepOrder))].sort((a, b) => a - b)
  const out: AutomationOp[] = []

  for (const order of orders) {
    const stepOps = ops.filter((o) => o.stepOrder === order)
    const createIdx = stepOps.findIndex((o) => o.op === 'open_url' && isCreateSheetUrl(o.url))
    if (createIdx < 0) {
      out.push(...stepOps)
      continue
    }

    const createOp = stepOps[createIdx]!
    const rest = stepOps.filter((_, i) => i !== createIdx)
    const prefix = rest.filter((o) => o.op === 'open_app')
    const untitledWaits = rest.filter(
      (o) =>
        o.op === 'wait_for' &&
        o.waitCondition === 'window_title_contains' &&
        /untitled/i.test(o.waitValue ?? '')
    )
    const otherWaits = rest.filter(
      (o) => o.op === 'wait_for' && !untitledWaits.includes(o)
    )
    const actions = rest.filter((o) => o.op !== 'open_app' && o.op !== 'wait_for')

    let waitUntitled = untitledWaits[0]
    if (!waitUntitled) {
      waitUntitled = baseFromOp(createOp, {
        op: 'wait_for',
        url: null,
        waitCondition: 'window_title_contains',
        waitValue: 'Untitled spreadsheet',
        label: 'Wait for new spreadsheet',
        timeoutMs: 20_000,
        confidence: Math.min(createOp.confidence, 0.8)
      })
      warnings.push(`Injected wait_for Untitled after create at step ${order}`)
    }

    const ordered = [...prefix, createOp, waitUntitled, ...actions, ...otherWaits]
    if (createIdx > 0 || untitledWaits.length === 0 || rest.indexOf(untitledWaits[0]!) < createIdx) {
      warnings.push(`Reordered create-sheet sequence at step ${order}`)
    }
    out.push(...ordered)
  }

  return out
}

/**
 * Intent-aware destination. Prefer create/rename/open-by-name over a bare site URL.
 */
export function inferUrlFromText(text: string): { url: string; label: string } | null {
  const https = text.match(/https?:\/\/[^\s"'<>]+/i)
  if (https?.[0]) {
    return { url: https[0].replace(/[.,);]+$/, ''), label: `Open ${https[0]}` }
  }
  // Creating a Doc/Sheet is not the Drive homepage.
  if (/\b(create|new)\b/i.test(text) && /\b(google\s*)?docs?\b/i.test(text)) {
    return {
      url: 'https://docs.google.com/document/create',
      label: 'Create a new Google Doc'
    }
  }
  if (isCreateSheetIntent(text)) {
    return {
      url: 'https://docs.google.com/spreadsheets/create',
      label: 'Create a new Google Sheet'
    }
  }
  // Rename / open-by-name need typing — not a homepage open_url.
  if (/\brenam(?:e|ed|ing)\b/i.test(text) || quotedName(text)) {
    return null
  }
  for (const d of DESTINATION_URLS) {
    if (d.re.test(text)) return { url: d.url, label: d.label }
  }
  return null
}

function baseFromOp(op: AutomationOp, patch: Partial<AutomationOp>): AutomationOp {
  return {
    ...op,
    elementLabel: null,
    elementRole: null,
    elementPath: null,
    chord: null,
    url: null,
    urlVariableKey: null,
    variableKey: null,
    literalText: null,
    waitCondition: null,
    waitValue: null,
    prompt: null,
    clickX: null,
    clickY: null,
    ...patch
  }
}

function renameTargetFromText(text: string): string | null {
  const quoted = quotedName(text)
  if (quoted && !/^untitled$/i.test(quoted)) return quoted
  const patterns = [
    /\brenam(?:e|ed|ing)(?:\s+the\s+(?:document|file|doc|spreadsheet))?\s+to\s+(.+?)(?:\s+in\s+google|\s*[.!,:]|$)/i,
    /\brenam(?:e|ed|ing)\s+to\s+(.+?)(?:\s+document\b|\s+spreadsheet\b|\s+in\s+google|\s*[.!,:]|$)/i
  ]
  for (const re of patterns) {
    const m = text.match(re)
    let name = m?.[1]?.replace(/[“"]/g, '').trim()
    if (!name || name.length < 2 || name.length > 120) continue
    if (/^untitled$/i.test(name)) continue
    // "Data Outputs from Lab spreadsheet" → drop trailing type noun.
    name = name.replace(/\s+(?:document|spreadsheet|sheet|file|doc)$/i, '').trim()
    if (name.length >= 2) return name
  }
  return null
}

function searchQueryFromStepAction(text: string): string | null {
  const quoted = quotedName(text)
  if (quoted && /\bsearch\b/i.test(text)) return quoted
  const m = text.match(
    /\bsearch(?:\s+(?:google|bing|the\s+web))?\s+for\s+[“"]?([^”"\n.]+)/i
  )
  const q = m?.[1]?.replace(/[“"]/g, '').trim()
  if (!q || q.length < 1 || q.length > 200) return null
  return q
}

/** Literals the user authored in step text — allowed even when absent from capture. */
export function literalsFromWorkflowSteps(workflow: ExtractedWorkflow): string[] {
  const out: string[] = []
  for (const s of workflow.steps) {
    const q = quotedName(s.action)
    if (q) out.push(q)
    const rename = renameTargetFromText(s.action)
    if (rename) out.push(rename)
    const search = searchQueryFromStepAction(s.action)
    if (search) out.push(search)
  }
  return out
}

/**
 * Force ops to honor edited step actions (rename target, search query, labels).
 * Runs after LLM compile + recovery so UI edits always win.
 */
export function applyEditorIntentToOps(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const stepByOrder = new Map(workflow.steps.map((s) => [s.order, s]))
  const out: AutomationOp[] = []

  // Rebuild step-by-step so rename/search edits replace wrong LLM ops cleanly.
  const orders = [...new Set(ops.map((o) => o.stepOrder))].sort((a, b) => a - b)
  for (const order of orders) {
    const step = stepByOrder.get(order)
    const stepOps = ops.filter((o) => o.stepOrder === order)
    if (!step) {
      out.push(...stepOps)
      continue
    }

    const preserved = stepOps.filter((o) => o.op === 'wait_for' || o.op === 'open_app')
    const seed = stepOps[0]!

    if (/\brenam(?:e|ed|ing)\b/i.test(step.action)) {
      const name = renameTargetFromText(step.action)
      if (name) {
        out.push(...renameOpsFor(seed, name, polished, warnings))
        out.push(...preserved.filter((o) => o.op === 'wait_for'))
        warnings.push(`Applied editor rename “${name}” for step ${order}`)
        continue
      }
    }

    const search = searchQueryFromStepAction(step.action)
    if (search) {
      let applied = false
      for (const o of stepOps) {
        if (o.op === 'type_text') {
          if (o.literalText !== search) {
            applied = true
            out.push({
              ...o,
              literalText: search,
              variableKey: null,
              label: `Search for ${search}`
            })
          } else {
            out.push(o)
          }
        } else {
          out.push(o)
        }
      }
      if (applied) {
        warnings.push(`Applied editor search query “${search}” for step ${order}`)
      }
      continue
    }

    out.push(...stepOps)
  }

  // Ledger text follows the edited step title, not LLM op labels.
  return out.map((o) => {
    const action = stepByOrder.get(o.stepOrder)?.action
    if (!action) return o
    return { ...o, label: action }
  })
}

function topLeftClickForOp(
  op: AutomationOp,
  polished: PolishedSession
): { x: number; y: number } | null {
  const points: Array<{ x: number; y: number }> = []
  for (const a of polished.actions) {
    if (a.clickX == null || a.clickY == null) continue
    if (!a.sourceEventIds.some((id) => op.evidenceEventIds.includes(id))) continue
    points.push({ x: a.clickX, y: a.clickY })
  }
  // Fallback: any top-of-screen click (Docs title / rename control is ~y<160).
  if (!points.length) {
    for (const a of polished.actions) {
      if (a.clickX != null && a.clickY != null && a.clickY < 160) {
        points.push({ x: a.clickX, y: a.clickY })
      }
    }
  }
  if (!points.length) return null
  points.sort((a, b) => a.y - b.y || a.x - b.x)
  return points[0] ?? null
}

function renameOpsFor(
  op: AutomationOp,
  name: string,
  polished: PolishedSession | null,
  warnings: string[]
): AutomationOp[] {
  const clean = name.replace(/\s+document$/i, '').trim()
  warnings.push(`Inferred rename “${clean}” for step ${op.stepOrder}`)
  const out: AutomationOp[] = []
  const pt = polished ? topLeftClickForOp(op, polished) : null
  if (pt) {
    out.push(
      baseFromOp(op, {
        op: 'click_at',
        clickX: pt.x,
        clickY: pt.y,
        label: 'Focus document title',
        confidence: Math.min(op.confidence, 0.8)
      })
    )
  }
  out.push(
    baseFromOp(op, {
      op: 'type_text',
      literalText: clean,
      label: `Rename to “${clean}”`,
      confidence: Math.min(op.confidence, 0.75)
    })
  )
  out.push(
    baseFromOp(op, {
      op: 'keystroke',
      chord: 'Enter',
      label: 'Confirm rename',
      confidence: Math.min(op.confidence, 0.7),
      timeoutMs: 3000
    })
  )
  return out
}

function inferOpsFromStepText(
  op: AutomationOp,
  blob: string,
  warnings: string[],
  polished: PolishedSession | null = null
): AutomationOp[] {
  // Rename must win over "… document" open-by-name heuristics.
  if (/\brenam(?:e|ed|ing)\b/i.test(blob)) {
    const name = renameTargetFromText(blob)
    if (name) return renameOpsFor(op, name, polished, warnings)
  }

  if (isCreateSheetIntent(blob)) {
    warnings.push(`Inferred create-sheet flow for step ${op.stepOrder}`)
    return [
      baseFromOp(op, {
        op: 'open_url',
        url: 'https://docs.google.com/spreadsheets/create',
        label: 'Create a new Google Sheet',
        confidence: Math.min(op.confidence, 0.8)
      })
    ]
  }

  if (/\b(create|new)\b/i.test(blob) && /\b(google\s*)?docs?\b/i.test(blob)) {
    const title =
      quotedName(blob) ||
      blob.match(/\btitling\s+[“"]?([^”"\n.]+)/i)?.[1]?.trim() ||
      null
    warnings.push(`Inferred create-doc flow for step ${op.stepOrder}`)
    const out: AutomationOp[] = [
      baseFromOp(op, {
        op: 'open_url',
        url: 'https://docs.google.com/document/create',
        label: 'Create a new Google Doc',
        confidence: Math.min(op.confidence, 0.8)
      })
    ]
    if (title && !/^untitled$/i.test(title)) {
      out.push(
        baseFromOp(op, {
          op: 'type_text',
          literalText: title,
          label: `Title document “${title}”`,
          confidence: Math.min(op.confidence, 0.7)
        })
      )
    }
    return out
  }

  const docName =
    quotedName(blob) ||
    blob.match(/\b(?:open|select)\s+(?:the\s+)?(.+?)\s+document\b/i)?.[1]?.replace(
      /\s*[-—|].*$/,
      ''
    )?.trim() ||
    null
  if (
    docName &&
    docName.length >= 2 &&
    docName.length <= 120 &&
    !/ground|element|button|fake|manual/i.test(docName) &&
    /\b(open|select|ending on)\b/i.test(blob) &&
    !/\brenam(?:e|ed|ing)\b/i.test(blob)
  ) {
    warnings.push(`Inferred type_text “${docName}” for document open at step ${op.stepOrder}`)
    return [
      baseFromOp(op, {
        op: 'type_text',
        literalText: docName,
        label: `Open “${docName}”`,
        confidence: Math.min(op.confidence, 0.7)
      }),
      baseFromOp(op, {
        op: 'keystroke',
        chord: 'Enter',
        label: 'Open selected document',
        confidence: Math.min(op.confidence, 0.7),
        timeoutMs: 3000
      })
    ]
  }

  const inferred = inferUrlFromText(blob)
  if (inferred) {
    warnings.push(`Inferred open_url ${inferred.url} for step ${op.stepOrder}`)
    return [
      baseFromOp(op, {
        op: 'open_url',
        url: inferred.url,
        label: inferred.label,
        confidence: Math.min(op.confidence, 0.75)
      })
    ]
  }
  return []
}

/**
 * Holistic recovery: when compile/grounding left a manual (or fragile address-bar
 * activate), infer open_url / Cmd+L / document search from step text + titles.
 * Also rewrites bare Drive/Docs homepage opens that ignore create/rename intent.
 */
export function recoverInferredActions(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const stepByOrder = new Map(workflow.steps.map((s) => [s.order, s]))
  const out: AutomationOp[] = []
  const renameStepsDone = new Set<number>()

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    if (
      op.op === 'activate_element' &&
      /address|omnibox|search bar|\burl\b/i.test(op.elementLabel ?? '')
    ) {
      warnings.push(
        `Using Cmd+L instead of activate_element for address bar at step ${op.stepOrder}`
      )
      out.push(
        baseFromOp(op, {
          op: 'keystroke',
          chord: 'Cmd+L',
          label: op.label ?? 'Focus the address bar',
          confidence: Math.min(op.confidence, 0.85)
        })
      )
      continue
    }

    const step = stepByOrder.get(op.stepOrder)
    const evidenceTitles = polished.actions
      .filter((a) => a.sourceEventIds.some((id) => op.evidenceEventIds.includes(id)))
      .map((a) => a.documentTitle ?? a.text ?? '')
    const blob = [op.label, op.prompt, step?.action, ...evidenceTitles].filter(Boolean).join(' ')

    // Rename steps: never "open document named X" — click title (if known) + type + confirm.
    // Do not fall back to op.literalText (often the old Untitled title from capture).
    if (/\brenam(?:e|ed|ing)\b/i.test(blob) && !renameStepsDone.has(op.stepOrder)) {
      const name = renameTargetFromText(blob)
      if (name) {
        renameStepsDone.add(op.stepOrder)
        while (
          i + 1 < ops.length &&
          ops[i + 1]!.stepOrder === op.stepOrder &&
          (ops[i + 1]!.op === 'type_text' ||
            ops[i + 1]!.op === 'keystroke' ||
            ops[i + 1]!.op === 'open_url' ||
            ops[i + 1]!.op === 'manual' ||
            ops[i + 1]!.op === 'activate_element')
        ) {
          i += 1
        }
        out.push(...renameOpsFor(op, name, polished, warnings))
        continue
      }
    }

    // LLM often emits open_url https://drive.google.com/ for a "create/rename" step.
    if (
      op.op === 'open_url' &&
      op.url &&
      /docs\.google\.com\/?$|drive\.google\.com\/?$/i.test(op.url) &&
      (/\b(create|new|rename)\b/i.test(blob) || quotedName(blob))
    ) {
      const inferred = inferOpsFromStepText(op, blob, warnings, polished)
      if (inferred.length) {
        out.push(...inferred)
        continue
      }
    }

    if (op.op !== 'manual') {
      out.push(op)
      continue
    }

    const inferred = inferOpsFromStepText(op, blob, warnings, polished)
    if (inferred.length) {
      out.push(...inferred)
      continue
    }

    out.push(op)
  }

  return dedupeConsecutiveOpenUrls(out)
}

/** Drop back-to-back identical open_url ops (common after recovery + LLM). */
function dedupeConsecutiveOpenUrls(ops: AutomationOp[]): AutomationOp[] {
  const out: AutomationOp[] = []
  for (const op of ops) {
    const prev = out[out.length - 1]
    if (
      op.op === 'open_url' &&
      prev?.op === 'open_url' &&
      prev.url &&
      op.url &&
      prev.url.replace(/\/$/, '') === op.url.replace(/\/$/, '') &&
      prev.stepOrder === op.stepOrder
    ) {
      continue
    }
    out.push(op)
  }
  return out
}

/**
 * Cmd+T + open_url (new tab) = two tabs. Cmd+L before open_url is redundant.
 * Drop the extras so each navigation opens exactly one tab.
 */
export function collapseRedundantBrowserNav(
  ops: AutomationOp[],
  warnings: string[]
): AutomationOp[] {
  const out: AutomationOp[] = []
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!

    if (op.op === 'keystroke' && /^cmd\+t$/i.test(op.chord ?? '')) {
      const hasOpenUrl = ops.slice(i + 1, i + 8).some((o) => o.op === 'open_url')
      if (hasOpenUrl) {
        warnings.push('Dropped Cmd+T before open_url to avoid opening two tabs')
        continue
      }
    }

    if (op.op === 'keystroke' && /^cmd\+l$/i.test(op.chord ?? '')) {
      const hasOpenUrl = ops.slice(i + 1, i + 5).some((o) => o.op === 'open_url')
      if (hasOpenUrl) {
        warnings.push('Dropped Cmd+L before open_url (redundant)')
        continue
      }
    }

    // Orphan keystroke with no chord (LLM placeholder after open_url).
    if (op.op === 'keystroke' && !op.chord) {
      warnings.push(`Dropped keystroke without chord at step ${op.stepOrder}`)
      continue
    }

    // After create-doc/sheet, a homepage Drive/Docs open_url in the same step is noise.
    if (
      op.op === 'open_url' &&
      op.url &&
      /^(https?:\/\/)?(drive\.google\.com\/?|docs\.google\.com\/?)$/i.test(op.url)
    ) {
      const sameStep = ops.filter((o) => o.stepOrder === op.stepOrder && o.op === 'open_url')
      const hasCreate = sameStep.some((o) =>
        /docs\.google\.com\/(document|spreadsheets)\/create/i.test(o.url ?? '')
      )
      if (hasCreate) {
        warnings.push(`Dropped redundant homepage open_url after create at step ${op.stepOrder}`)
        continue
      }
    }

    out.push(op)
  }
  return out
}

const BROWSER_APP_RE = /chrome|chromium|safari|edge|brave|arc|firefox/i

/**
 * Holistic pass: if the recording started on a New Tab (or navigates via the
 * address bar), do not reuse Chrome's previous front tab. Inject Cmd+T after
 * open_app when missing, and mark open_url ops as new-tab navigations.
 */
export function ensureBrowserNewTab(
  ops: AutomationOp[],
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const usedNewTab = polished.actions.some(
    (a) =>
      /new tab/i.test(a.documentTitle ?? '') ||
      /new tab/i.test(a.text ?? '') ||
      /address and search bar/i.test(a.elementLabel ?? '')
  )
  if (!usedNewTab) return ops

  const out: AutomationOp[] = []
  let injected = false
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    out.push(op)
    if (injected) continue
    if (op.op !== 'open_app' || !BROWSER_APP_RE.test(op.appName ?? '')) continue

    const rest = ops.slice(i + 1)
    const alreadyHasNewTab = rest.some(
      (o) => o.op === 'keystroke' && /^cmd\+t$/i.test(o.chord ?? '')
    )
    // open_url already creates a new tab — injecting Cmd+T would open two.
    if (rest.some((o) => o.op === 'open_url')) {
      injected = true
      continue
    }

    const navigates =
      rest.some((o) => o.op === 'type_text') ||
      rest.some(
        (o) =>
          o.op === 'activate_element' &&
          /address|omnibox|search bar|url/i.test(o.elementLabel ?? '')
      ) ||
      rest.some((o) => o.op === 'keystroke' && /^cmd\+l$/i.test(o.chord ?? ''))
    if (alreadyHasNewTab || !navigates) {
      injected = true
      continue
    }

    out.push({
      ...op,
      op: 'keystroke',
      chord: 'Cmd+T',
      label: 'Open a new tab',
      evidenceEventIds: op.evidenceEventIds,
      elementLabel: null,
      elementRole: null,
      elementPath: null,
      url: null,
      urlVariableKey: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: null,
      clickY: null,
      confidence: Math.min(op.confidence, 0.85),
      timeoutMs: 3000
    })
    warnings.push('Inserted Cmd+T so replay opens a new tab instead of reusing the previous one')
    injected = true
  }
  return out
}

function resolveStepOrderForClick(
  action: PolishedAction,
  workflow: ExtractedWorkflow,
  polished: PolishedSession
): number {
  for (const s of workflow.steps) {
    if (action.sourceEventIds.some((id) => s.evidenceEventIds.includes(id))) {
      return s.order
    }
  }

  // Holistic windowing: assign the click to the step whose evidence is nearest
  // before it (prev step context), falling forward to the next step when closer.
  type Anchor = { order: number; actionOrder: number }
  const anchors: Anchor[] = []
  for (const s of workflow.steps) {
    for (const a of polished.actions) {
      if (!a.sourceEventIds.some((id) => s.evidenceEventIds.includes(id))) continue
      anchors.push({ order: s.order, actionOrder: a.order })
    }
  }
  if (!anchors.length) return workflow.steps[0]?.order ?? 1

  anchors.sort((a, b) => a.actionOrder - b.actionOrder)
  let best = anchors[0]!.order
  let bestScore = Infinity
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!
    const dist = Math.abs(action.order - a.actionOrder)
    // Prefer the preceding step (click continues that step) over jumping ahead.
    const score = action.order >= a.actionOrder ? dist : dist + 0.25
    if (score < bestScore) {
      bestScore = score
      best = a.order
    }
  }
  return best
}

/**
 * Clicks are first-class. If polished evidence has clickX/Y that no op covers,
 * inject click_at into the matching step (placed before trailing wait_for),
 * using prev/next step evidence windows for assignment.
 */
export function injectClickOpsFromEvidence(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  warnings: string[]
): AutomationOp[] {
  const clicks = polished.actions
    .filter((a) => a.clickX != null && a.clickY != null)
    .sort((a, b) => a.order - b.order)
  if (!clicks.length) return ops

  const coveredXy = new Set<string>()
  const coveredEvents = new Set<string>()
  for (const op of ops) {
    if (op.op !== 'click_at' && op.op !== 'activate_element') continue
    for (const id of op.evidenceEventIds) coveredEvents.add(id)
    if (op.clickX != null && op.clickY != null) {
      coveredXy.add(`${op.clickX},${op.clickY}`)
    }
  }

  const byStep = new Map<number, AutomationOp[]>()
  for (const op of ops) {
    const list = byStep.get(op.stepOrder) ?? []
    list.push(op)
    byStep.set(op.stepOrder, list)
  }

  let injected = 0
  for (const action of clicks) {
    const xyKey = `${action.clickX},${action.clickY}`
    if (coveredXy.has(xyKey)) continue
    if (action.sourceEventIds.some((id) => coveredEvents.has(id))) continue

    const stepOrder = resolveStepOrderForClick(action, workflow, polished)
    const seed =
      (byStep.get(stepOrder) ?? [])[0] ??
      ops[0] ??
      null
    if (!seed) continue

    const clickOp = baseFromOp(seed, {
      op: 'click_at',
      stepOrder,
      evidenceEventIds:
        action.sourceEventIds.length > 0 ? action.sourceEventIds : seed.evidenceEventIds,
      clickX: action.clickX!,
      clickY: action.clickY!,
      appName: action.appName ?? seed.appName,
      label: action.elementLabel
        ? `Click ${action.elementLabel}`
        : 'Click at recorded position',
      confidence: Math.min(seed.confidence, 0.8),
      timeoutMs: 8000
    })

    const list = byStep.get(stepOrder) ?? []
    const waitIdx = list.findIndex((o) => o.op === 'wait_for')
    if (waitIdx >= 0) list.splice(waitIdx, 0, clickOp)
    else list.push(clickOp)
    byStep.set(stepOrder, list)
    coveredXy.add(xyKey)
    for (const id of action.sourceEventIds) coveredEvents.add(id)
    injected += 1
  }

  if (!injected) return ops
  warnings.push(`Injected ${injected} click_at op(s) from recorded cursor positions`)

  const orders = [...byStep.keys()].sort((a, b) => a - b)
  return orders.flatMap((order) => byStep.get(order) ?? [])
}

/** Prefer click_at when evidence has screen coordinates and activate_element is ungrounded. */
export function preferClickAtWhenGrounded(
  ops: AutomationOp[],
  polished: PolishedSession,
  byEvent: Map<string, PolishedAction>,
  warnings: string[]
): AutomationOp[] {
  return ops.map((op) => {
    if (op.op !== 'manual' && op.op !== 'activate_element') return op
    let x: number | null = null
    let y: number | null = null
    for (const id of op.evidenceEventIds) {
      const a = byEvent.get(id)
      if (a?.clickX != null && a?.clickY != null) {
        x = a.clickX
        y = a.clickY
        break
      }
    }
    if (x == null || y == null) {
      for (const a of polished.actions) {
        if (
          a.clickX != null &&
          a.clickY != null &&
          a.sourceEventIds.some((id) => op.evidenceEventIds.includes(id))
        ) {
          x = a.clickX
          y = a.clickY
          break
        }
      }
    }
    if (x == null || y == null) return op
    if (op.op === 'activate_element' && op.elementLabel) return op
    warnings.push(`Using click_at (${x},${y}) for step ${op.stepOrder}`)
    return {
      ...op,
      op: 'click_at',
      clickX: x,
      clickY: y,
      label: op.label ?? 'Click at recorded position',
      prompt: null,
      elementLabel: null,
      elementRole: null,
      elementPath: null
    }
  })
}

function toClipboardMap(
  raw?: Map<string, string> | Record<string, string>
): Map<string, string> {
  if (!raw) return new Map()
  if (raw instanceof Map) return raw
  return new Map(Object.entries(raw))
}

function clipboardTextFromEvidence(
  evidenceIds: string[],
  byEvent: Map<string, PolishedAction>,
  clipMap: Map<string, string>
): string | null {
  for (const id of evidenceIds) {
    const a = byEvent.get(id)
    const hash = a?.clipboard?.contentHash
    if (!hash) continue
    const text = clipMap.get(hash)?.trim()
    if (text) return text
  }
  return null
}

/**
 * Successive address-bar / same-field edits: keep only the final type_text.
 * Prefer a later literal that is not a prefix of an earlier scrap.
 */
export function collapseRedundantTypeTexts(
  ops: AutomationOp[],
  warnings: string[]
): AutomationOp[] {
  const typeIdx: number[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]?.op === 'type_text') typeIdx.push(i)
  }
  if (typeIdx.length < 2) return ops

  const drop = new Set<number>()
  for (let a = 0; a < typeIdx.length; a++) {
    for (let b = a + 1; b < typeIdx.length; b++) {
      const earlier = ops[typeIdx[a]!]!
      const later = ops[typeIdx[b]!]!
      if ((earlier.appName ?? '') !== (later.appName ?? '')) continue
      const el = (earlier.elementLabel ?? '').toLowerCase()
      const ll = (later.elementLabel ?? '').toLowerCase()
      // Same field, or both unlabeled (typical omnibox).
      if (el && ll && el !== ll) continue
      const et = earlier.literalText?.trim() ?? ''
      const lt = later.literalText?.trim() ?? ''
      if (!et || !lt) continue
      // Drop earlier scrap when later contains it, or earlier is a tiny fragment.
      if (lt.includes(et) || et.length <= 3) {
        drop.add(typeIdx[a]!)
      }
    }
  }

  if (drop.size) {
    warnings.push('Collapsed successive typed edits into the final captured text')
  }
  return ops.filter((_, i) => !drop.has(i))
}

/**
 * Prefer first-class addresses over click-path navigation.
 * When a step requires an address ref, emit open_url / open_app from the
 * address template and drop same-step click/activate pathing.
 */
export function preferAddressNavigation(
  ops: AutomationOp[],
  workflow: ExtractedWorkflow,
  warnings: string[]
): AutomationOp[] {
  const addresses = new Map((workflow.addresses ?? []).map((a) => [a.id, a]))
  if (!addresses.size) return ops

  const stepAddr = new Map<number, Address>()
  for (const step of workflow.steps) {
    const ref = step.requires?.find((r) => r.ref && addresses.has(r.ref))?.ref
    if (!ref) continue
    const addr = addresses.get(ref)
    if (addr) stepAddr.set(step.order, addr)
  }
  if (!stepAddr.size) return ops

  const out: AutomationOp[] = []
  const opened = new Set<number>()

  for (const op of ops) {
    const addr = stepAddr.get(op.stepOrder)
    if (!addr) {
      out.push(op)
      continue
    }

    // Drop click-path navigation once we can open via address.
    if (
      (op.op === 'click_at' || op.op === 'activate_element') &&
      !/type|fill|cell|field|button|send|share/i.test(op.label ?? op.elementLabel ?? '')
    ) {
      if (!opened.has(op.stepOrder)) {
        out.push(...addressOpenOps(op, addr, warnings))
        opened.add(op.stepOrder)
      } else {
        warnings.push(
          `Dropped click-path op in favor of address ${addr.id} at step ${op.stepOrder}`
        )
      }
      continue
    }

    if (op.op === 'manual' && !opened.has(op.stepOrder)) {
      out.push(...addressOpenOps(op, addr, warnings))
      opened.add(op.stepOrder)
      continue
    }

    if (op.op === 'open_url' && addr.kind === 'url') {
      const resolved = resolveAddressTemplate(addr.template, addr.params)
      if (resolved && (!op.url || /drive\.google\.com\/?$/i.test(op.url))) {
        warnings.push(`Using address ${addr.id} template for open_url at step ${op.stepOrder}`)
        out.push({ ...op, url: resolved, label: op.label ?? `Open ${addr.id}` })
        opened.add(op.stepOrder)
        continue
      }
    }

    out.push(op)
  }

  // Steps that referenced an address but had no ops yet — prepend open.
  for (const [order, addr] of stepAddr) {
    if (opened.has(order)) continue
    if (ops.some((o) => o.stepOrder === order)) continue
    const evidence =
      workflow.steps.find((s) => s.order === order)?.evidenceEventIds ?? ['tevt_unknown']
    const seed: AutomationOp = {
      op: 'manual',
      stepOrder: order,
      evidenceEventIds: evidence,
      confidence: 0.7,
      timeoutMs: 15_000,
      label: null,
      appName: workflow.steps.find((s) => s.order === order)?.appName ?? null,
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: null,
      elementLabel: null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: null,
      clickY: null
    }
    out.push(...addressOpenOps(seed, addr, warnings))
  }

  return out.sort((a, b) => a.stepOrder - b.stepOrder || 0)
}

function addressOpenOps(seed: AutomationOp, addr: Address, warnings: string[]): AutomationOp[] {
  if (addr.kind === 'url') {
    const url = resolveAddressTemplate(addr.template, addr.params)
    warnings.push(`Address ${addr.id} → open_url ${url}`)
    return [
      {
        ...seed,
        op: 'open_url',
        url,
        urlVariableKey: null,
        elementRole: null,
        elementLabel: null,
        elementPath: null,
        chord: null,
        literalText: null,
        prompt: null,
        clickX: null,
        clickY: null,
        label: seed.label ?? `Open ${addr.id}`,
        confidence: Math.max(seed.confidence, 0.75)
      }
    ]
  }

  if (addr.kind === 'app_doc' || addr.kind === 'deeplink') {
    const appName = seed.appName
    if (appName) {
      warnings.push(`Address ${addr.id} → open_app ${appName}`)
      return [
        {
          ...seed,
          op: 'open_app',
          url: null,
          label: seed.label ?? `Open ${appName}`,
          confidence: Math.max(seed.confidence, 0.7)
        }
      ]
    }
  }

  if (addr.kind === 'file') {
    warnings.push(`Address ${addr.id} file path left as manual (no file opener op)`)
    return [
      {
        ...seed,
        op: 'manual',
        prompt: `Open file ${resolveAddressTemplate(addr.template, addr.params)}`,
        label: seed.label ?? 'Open file'
      }
    ]
  }

  return [seed]
}

function prepareCompileInput(
  workflow: ExtractedWorkflow,
  polished: PolishedSession,
  variables: WorkflowVariable[],
  clipboardByHash?: Map<string, string> | Record<string, string>
): unknown {
  const clipMap = toClipboardMap(clipboardByHash)
  return {
    workflow: {
      title: workflow.title,
      addresses: workflow.addresses ?? null,
      steps: workflow.steps.map((s) => ({
        order: s.order,
        id: s.id ?? null,
        action: s.action,
        category: s.category,
        appName: s.appName,
        evidenceEventIds: s.evidenceEventIds,
        confidence: s.confidence,
        intent: s.intent ?? null,
        summary: s.summary ?? null,
        requires: s.requires ?? null,
        position: s.position ?? null,
        effect: s.effect ?? null,
        params: s.params ?? null,
        authorization: s.authorization ?? null,
        objective: s.objective ?? null,
        actionType: s.actionType ?? null,
        targetRole: s.targetRole ?? null,
        targetLabel: s.targetLabel ?? null,
        inputKind: s.inputKind ?? null,
        inputVariableKey: s.inputVariableKey ?? null,
        inputLiteral: s.inputLiteral ?? null,
        preconditions: s.preconditions ?? null,
        expectedChange: s.expectedChange ?? null,
        completionCheck: s.completionCheck ?? null,
        dependsOnSteps: s.dependsOnSteps ?? null,
        retryHint: s.retryHint ?? null,
        needsClarification: s.needsClarification ?? null
      }))
    },
    actions: polished.actions.map((a) => {
      const searchQuery = searchQueryFromTitle(a.documentTitle)
      const clipText =
        a.clipboard?.contentHash && clipMap.has(a.clipboard.contentHash)
          ? clipMap.get(a.clipboard.contentHash)!.slice(0, 500)
          : null
      return {
        order: a.order,
        text: a.text,
        category: a.category,
        sourceEventIds: a.sourceEventIds,
        appName: a.appName ?? null,
        documentTitle: a.documentTitle ?? null,
        searchQuery,
        elementLabel: a.elementLabel ?? null,
        elementRole: a.elementRole ?? null,
        typedText: a.typedText ?? null,
        inputKind: a.inputKind ?? null,
        targetResolution: a.targetResolution ?? null,
        waitedMs: a.waitedMs ?? null,
        screenBeforeId: a.screenBeforeId ?? null,
        screenAfterId: a.screenAfterId ?? null,
        semanticOp: a.semanticOp ?? null,
        clickX: a.clickX ?? null,
        clickY: a.clickY ?? null,
        clickButton: a.clickButton ?? null,
        clipboard: a.clipboard
          ? {
              contentType: a.clipboard.contentType,
              urlHost: a.clipboard.urlHost ?? null,
              urlPath: a.clipboard.urlPath ?? null,
              /** Present only in-memory for this compile call — replay via set_clipboard. */
              text: clipText
            }
          : null,
        inferred: a.inferred ?? null,
        verified: a.verified ?? null
      }
    }),
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

  let response: {
    output_parsed: unknown
    usage?: { input_tokens?: number; output_tokens?: number }
  }
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
          content: JSON.stringify(
            prepareCompileInput(workflow, polished, variables, deps.clipboardByHash)
          )
        }
      ],
      text: {
        format: zodTextFormat(AutomationScriptSchema, 'automation_script')
      }
    })
  } catch (err) {
    throw mapToProcessingError(err)
  }

  const usage = usageFromResponse(response)
  logTokenUsage('automation_compile', usage)

  const parsed = response.output_parsed
  if (!parsed) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const validated = AutomationScriptSchema.safeParse(parsed)
  if (!validated.success) {
    throw new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }

  const grounded = validateAndGroundScript(
    validated.data,
    workflow,
    polished,
    deps.clipboardByHash
  )
  return store.saveAutomationScript(sessionId, grounded, model, { stale: false, usage })
}
