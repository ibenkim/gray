import type {
  AutomationOp,
  AutomationScript,
  IntentVerb,
  RunFailureCode,
  RunMode
} from '../../shared/telemetry/schema'
import { JxaActuator } from './JxaActuator'
import type {
  Actuator,
  ActuatorResult,
  ResolutionStats,
  RunEvent,
  RunnerControl,
  StepMeta
} from './types'

/** Auto-retries before holding for user repair. */
const REPAIR_BUDGET = 2

export type AutomationRunnerOptions = {
  runId: string
  sessionId: string
  script: AutomationScript
  /** Pre-filled variable answers (key → value). */
  variables?: Record<string, string>
  actuator?: Actuator
  onEvent: (event: RunEvent) => void
  /** Runtime mode — default supervised. */
  mode?: RunMode
  /**
   * Destination scope. When set, open_url hosts must match an allowed
   * address id or a resolved address template host.
   */
  allowedAddressIds?: string[]
  /** Address templates used to resolve allowedAddressIds → hosts. */
  addresses?: Array<{ id: string; kind: string; template: string }>
  /** Workflow step intent/authorization by order (for Commit gates, Create hooks). */
  stepMeta?: StepMeta[]
}

type HoldKind = 'question' | 'error' | 'manual' | null

/**
 * Sequential automation runner. Emits RunEvents for the pill UI.
 * Control via pause/resume/stop/retry/skip/takeOver/answer.
 */
export class AutomationRunner {
  private readonly runId: string
  private readonly script: AutomationScript
  private readonly onEvent: (event: RunEvent) => void
  private readonly actuator: Actuator
  private readonly ownsActuator: boolean
  private readonly mode: RunMode
  private readonly allowedAddressIds: Set<string> | null
  private readonly allowedHosts: Set<string>
  private readonly intentByOrder: Map<number, IntentVerb>
  private readonly summaryByOrder: Map<number, string>
  private variables: Record<string, string>
  private opIndex = 0
  private paused = false
  private stopped = false
  private hold: HoldKind = null
  private running = false
  private waitResolve: (() => void) | null = null
  private controlQueue: RunnerControl[] = []
  private resolution: ResolutionStats = { tier1: 0, tier2: 0 }
  /** A step was skipped or not run (simulated), so the run cannot report done. */
  private incomplete = false

  constructor(opts: AutomationRunnerOptions) {
    this.runId = opts.runId
    this.script = opts.script
    this.onEvent = opts.onEvent
    this.variables = { ...(opts.variables ?? {}) }
    this.mode = opts.mode ?? 'supervised'
    // An empty scope allows nothing; only an omitted scope (pure runner tests) is unchecked.
    this.allowedAddressIds = opts.allowedAddressIds ? new Set(opts.allowedAddressIds) : null
    this.allowedHosts = resolveAllowedHosts(opts.allowedAddressIds, opts.addresses)
    this.intentByOrder = new Map()
    this.summaryByOrder = new Map()
    for (const m of opts.stepMeta ?? []) {
      if (m.intent) this.intentByOrder.set(m.order, m.intent)
      if (m.summary) this.summaryByOrder.set(m.order, m.summary)
    }
    if (opts.actuator) {
      this.actuator = opts.actuator
      this.ownsActuator = false
    } else {
      this.actuator = new JxaActuator()
      this.ownsActuator = true
    }
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.stopped = false
    this.opIndex = 0
    this.incomplete = false
    this.resolution = { tier1: 0, tier2: 0 }
    try {
      await this.actuator.start()
    } catch (err) {
      const msg =
        err instanceof Error && err.message === 'AUTOMATION_ACCESSIBILITY_DENIED'
          ? 'Accessibility permission is required to run automated workflows.'
          : 'Could not start the automation actuator.'
      this.onEvent({
        type: 'stepFailed',
        runId: this.runId,
        stepOrder: this.script.ops[0]?.stepOrder ?? 1,
        opIndex: 0,
        label: this.script.ops[0]?.label ?? 'Start automation',
        message: msg,
        code: 'precondition_unmet'
      })
      this.onEvent({
        type: 'finished',
        runId: this.runId,
        outcome: 'stopped',
        resolution: { ...this.resolution }
      })
      this.running = false
      return
    }

    try {
      while (!this.stopped && this.opIndex < this.script.ops.length) {
        await this.drainControls()
        if (this.stopped) break
        while (this.paused && !this.stopped) {
          await this.waitForControl()
          await this.drainControls()
        }
        if (this.stopped) break

        const op = this.script.ops[this.opIndex]
        const label = op.label ?? defaultLabel(op)
        this.onEvent({
          type: 'stepStarted',
          runId: this.runId,
          stepOrder: op.stepOrder,
          opIndex: this.opIndex,
          label,
          op: op.op
        })

        const outcome = await this.executeOp(op, label)
        if (outcome === 'done') {
          this.onEvent({
            type: 'stepDone',
            runId: this.runId,
            stepOrder: op.stepOrder,
            opIndex: this.opIndex,
            label
          })
          this.opIndex += 1
        } else if (outcome === 'simulated') {
          this.onEvent({
            type: 'stepDone',
            runId: this.runId,
            stepOrder: op.stepOrder,
            opIndex: this.opIndex,
            label: label.startsWith('[Simulated]') ? label : `[Simulated] ${label}`,
            simulated: true
          })
          this.incomplete = true
          this.opIndex += 1
        } else if (outcome === 'skip') {
          this.onEvent({
            type: 'stepDone',
            runId: this.runId,
            stepOrder: op.stepOrder,
            opIndex: this.opIndex,
            label,
            skipped: true
          })
          this.incomplete = true
          this.opIndex += 1
        } else if (outcome === 'stopped') {
          break
        }
        // retry keeps same opIndex; hold waits inside executeOp
      }
    } finally {
      if (this.ownsActuator) this.actuator.stop()
      this.running = false
    }

    this.onEvent({
      type: 'finished',
      runId: this.runId,
      outcome: this.stopped ? 'stopped' : this.incomplete ? 'incomplete' : 'done',
      resolution: { ...this.resolution }
    })
  }

  control(cmd: RunnerControl): void {
    this.controlQueue.push(cmd)
    if (this.waitResolve) {
      const r = this.waitResolve
      this.waitResolve = null
      r()
    }
  }

  isRunning(): boolean {
    return this.running
  }

  private async executeOp(
    op: AutomationOp,
    label: string
  ): Promise<'done' | 'skip' | 'stopped' | 'retry' | 'simulated'> {
    // Simulated mode dispatches only known read-only queries; anything else (clicks, keys,
    // typing, app launch, navigation — even a URL can create records — and manual or
    // question steps) is reported, not run.
    if (this.mode === 'simulated' && op.op !== 'wait_for') {
      return 'simulated'
    }

    if (op.op === 'manual') {
      return this.holdForError(
        op,
        label,
        op.prompt ?? 'Complete this step manually',
        true,
        'unexpected_state'
      )
    }

    if (op.op === 'ask_user') {
      return this.holdForQuestion(op, label)
    }

    // Supervised: gate Commit / submit-like ops for approval.
    if (this.mode === 'supervised' && this.looksLikeCommit(op)) {
      const summary =
        this.summaryByOrder.get(op.stepOrder) ?? label
      const approved = await this.holdForApproval(op, label, `Approve commit: ${summary}`)
      if (approved !== 'done') return approved
    }

    // Scope check before open_url.
    if (op.op === 'open_url' && this.allowedAddressIds) {
      const url =
        op.url ?? (op.urlVariableKey ? this.variables[op.urlVariableKey] : undefined)
      if (url && !this.urlInScope(url)) {
        return this.holdForError(
          op,
          label,
          'This destination is outside the authorized scope.',
          false,
          'out_of_scope'
        )
      }
    }

    // Narrate navigation before open_app / open_url.
    if (op.op === 'open_app' || op.op === 'open_url') {
      this.onEvent({
        type: 'navigating',
        runId: this.runId,
        stepOrder: op.stepOrder,
        opIndex: this.opIndex,
        destination: navigationDestination(op, this.variables)
      })
    }

    // Idempotency hook before create-like ops (stub always continues).
    if (this.looksLikeCreate(op)) {
      await checkIdempotencyStub(op)
    }

    const timeout = op.timeoutMs || 15_000
    let lastMessage = `Failed: ${op.op}`
    let lastCode: RunFailureCode = 'unexpected_state'

    for (let attempt = 0; attempt <= REPAIR_BUDGET; attempt++) {
      if (this.stopped) return 'stopped'
      try {
        const result = await this.runWithTimeout(() => this.dispatch(op), timeout)
        if (result.ok) {
          await this.afterSuccess(op)
          this.recordResolution(op)
          return 'done'
        }
        lastMessage = humanError(result.error) || `Failed: ${op.op}`
        lastCode = toFailureCode(result.error)
        if (!isRepairable(lastCode) || attempt >= REPAIR_BUDGET) break
        // Auto-repair: brief pause then retry.
        await sleep(200)
      } catch {
        lastMessage = 'Step timed out'
        lastCode = 'timeout'
        if (attempt >= REPAIR_BUDGET) break
        await sleep(200)
      }
    }

    // Repairable failures that burned the budget → repair_exhausted; else the mapped code.
    const holdCode: RunFailureCode = isRepairable(lastCode) ? 'repair_exhausted' : lastCode
    return this.holdForError(op, label, lastMessage, false, holdCode)
  }

  private async afterSuccess(op: AutomationOp): Promise<void> {
    // Let UI settle between sequenced clicks / navigations / typing.
    if (
      op.op === 'click_at' ||
      op.op === 'scroll' ||
      op.op === 'activate_element' ||
      op.op === 'keystroke' ||
      op.op === 'type_text'
    ) {
      await sleep(280)
    } else if (op.op === 'open_url' || op.op === 'open_app') {
      await sleep(500)
    }

    if (op.op !== 'type_text') return
    const wantsReadback =
      /\bfill\b/i.test(op.label ?? '') ||
      op.elementLabel != null ||
      op.elementRole != null
    if (!wantsReadback) return

    const params = {
      waitCondition: 'element_exists' as const,
      waitValue: null,
      appName: op.appName,
      appBundleId: op.appBundleId,
      elementRole: op.elementRole,
      elementLabel: op.elementLabel
    }

    if (this.actuator.readField) {
      const rb = await this.actuator.readField(params)
      if (!rb.ok) {
        // Soft failure — do not fail the step on stub/readback miss.
        return
      }
      return
    }

    // Lightweight existence check when no readField.
    if (op.elementLabel) {
      await this.actuator.query(params)
    }
  }

  private recordResolution(op: AutomationOp): void {
    if (op.op === 'open_url') this.resolution.tier1 += 1
    else if (op.op === 'open_app' || op.op === 'activate_element') this.resolution.tier2 += 1
  }

  private looksLikeCommit(op: AutomationOp): boolean {
    if (this.intentByOrder.get(op.stepOrder) === 'Commit') return true
    const hay = `${op.label ?? ''} ${op.elementLabel ?? ''} ${op.prompt ?? ''}`
    return /\b(submit|save|send|confirm|publish|post|commit)\b/i.test(hay)
  }

  private looksLikeCreate(op: AutomationOp): boolean {
    if (this.intentByOrder.get(op.stepOrder) === 'Create') return true
    const hay = `${op.label ?? ''} ${op.elementLabel ?? ''}`
    return /\b(create|new|add|insert)\b/i.test(hay)
  }

  private urlInScope(url: string): boolean {
    if (!this.allowedAddressIds) return true
    let host = ''
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      // Relative / non-URL templates — allow exact id/template match only.
      return (
        this.allowedAddressIds.has(url) ||
        [...this.allowedAddressIds].some((id) => url.includes(id))
      )
    }
    if (this.allowedHosts.has(host)) return true
    // Also allow when an allowed id equals the host string.
    if (this.allowedAddressIds.has(host)) return true
    return false
  }

  private async dispatch(op: AutomationOp): Promise<{ ok: boolean; error?: string }> {
    switch (op.op) {
      case 'open_app':
        return this.actuator.activateApp(op.appName, op.appBundleId)
      case 'open_url': {
        const url =
          op.url ??
          (op.urlVariableKey ? this.variables[op.urlVariableKey] : undefined)
        if (!url) return { ok: false, error: 'missing_url' }
        return this.actuator.openUrl(url, op.appName)
      }
      case 'activate_element': {
        if (!op.elementLabel) return { ok: false, error: 'missing_label' }
        // A recorded middle press is not an AXPress either: unsupported, before any effect.
        if (op.clickButton === 'middle') return { ok: false, error: 'click_unsupported' }
        // The recorded app must be verified frontmost before any press, keystroke or click.
        const activated = await this.activateRecordedApp(op, 120)
        if (!activated.ok) return activated
        const pressed = await this.actuator.pressElement({
          appName: op.appName,
          appBundleId: op.appBundleId,
          elementRole: op.elementRole,
          elementLabel: op.elementLabel,
          elementPath: op.elementPath,
          // The recorded window, when known, must be found (exactly, once) before any press.
          windowTitle: op.windowTitle?.trim() || null
        })
        if (pressed.ok) return pressed
        // Fallbacks are for a label that was not found in the verified window. A failed app or
        // window identity (absent, ambiguous, unfocusable) stops before any other input.
        if (pressed.error !== 'element_not_found') return pressed
        // Infer fallbacks when a single AX label cannot be found.
        const addressBar = /address|omnibox|search bar|\burl\b/i.test(op.elementLabel)
        if (addressBar) {
          const focus = await this.actuator.keystroke('Cmd+L')
          if (focus.ok) return focus
        }
        if (!this.actuator.clickAt) return pressed
        // The coordinate fallback lands only in the verified recorded app's live window.
        const fallback = await this.resolveClickPoint(op)
        if (!fallback) return pressed
        return this.actuator.clickAt(fallback.x, fallback.y, clickOptionsFromOp(op))
      }
      case 'click_at': {
        if (!this.actuator.clickAt) return { ok: false, error: 'click_unsupported' }
        // Middle click is not replayable; never convert it to a left click.
        if (op.clickButton === 'middle') return { ok: false, error: 'click_unsupported' }
        // Coordinates are meaningful only in the recorded app: stop if it cannot be activated.
        const activated = await this.activateRecordedApp(op, 120)
        if (!activated.ok) return activated
        const point = await this.resolveClickPoint(op)
        if (!point) return { ok: false, error: 'missing_point' }
        return this.actuator.clickAt(point.x, point.y, clickOptionsFromOp(op))
      }
      case 'scroll': {
        if (!this.actuator.scrollAt) return { ok: false, error: 'scroll_unsupported' }
        if (op.scrollDelta == null) return { ok: false, error: 'missing_delta' }
        const activated = await this.activateRecordedApp(op, 80)
        if (!activated.ok) return activated
        const point = await this.resolveClickPoint(op)
        if (!point) return { ok: false, error: 'missing_point' }
        return this.actuator.scrollAt(
          point.x,
          point.y,
          op.scrollAxis === 'horizontal' ? 'horizontal' : 'vertical',
          op.scrollDelta
        )
      }
      case 'keystroke':
        if (!op.chord) return { ok: false, error: 'missing_chord' }
        return this.actuator.keystroke(op.chord)
      case 'type_text': {
        const key = op.variableKey
        // A supplied variable wins; otherwise fall back to text captured during
        // the recording.
        const text = (key ? this.variables[key] : undefined) ?? op.literalText ?? undefined
        if (!text) return { ok: false, error: 'missing_variable' }
        if (this.actuator.typeText) return this.actuator.typeText(text)
        // Last resort only — prefer System Events typing from JxaActuator.typeText.
        if (this.actuator.setClipboard) {
          const clip = this.actuator.setClipboard(text)
          if (!clip.ok) return clip
          return this.actuator.keystroke('Cmd+V')
        }
        return { ok: false, error: 'type_unsupported' }
      }
      case 'set_clipboard': {
        const key = op.variableKey
        const text =
          (key ? this.variables[key] : undefined) ?? op.literalText ?? undefined
        if (!text) return { ok: false, error: 'missing_variable' }
        if (this.actuator.setClipboard) {
          return this.actuator.setClipboard(text)
        }
        return { ok: false, error: 'clipboard_unsupported' }
      }
      case 'wait_for':
        return this.waitForCondition(op)
      default:
        return { ok: false, error: 'unknown_op' }
    }
  }

  private async waitForCondition(op: AutomationOp): Promise<{ ok: boolean; error?: string }> {
    if (!op.waitCondition) return { ok: false, error: 'missing_condition' }
    const deadline = Date.now() + (op.timeoutMs || 15_000)
    while (Date.now() < deadline) {
      if (this.stopped) return { ok: false, error: 'stopped' }
      const r = await this.actuator.query({
        waitCondition: op.waitCondition,
        waitValue: op.waitValue,
        appName: op.appName,
        appBundleId: op.appBundleId,
        elementRole: op.elementRole,
        elementLabel: op.elementLabel
      })
      if (r.ok) return { ok: true }
      await sleep(400)
    }
    return { ok: false, error: 'wait_timeout' }
  }

  /** A targeted op needs its recorded app frontmost; without a known app there is nothing to bind. */
  private async activateRecordedApp(op: AutomationOp, settleMs: number): Promise<ActuatorResult> {
    if (!op.appName && !op.appBundleId) return { ok: false, error: 'app_not_found' }
    const act = await this.actuator.activateApp(op.appName, op.appBundleId)
    if (!act.ok) return { ok: false, error: act.error ?? 'app_not_found' }
    await sleep(settleMs)
    return { ok: true }
  }

  /**
   * Window-relative offset re-anchored to the live window frame; absolute screen coordinates
   * only when the point was outside the recorded window (menu bar, Dock).
   */
  private async resolveClickPoint(
    op: AutomationOp
  ): Promise<{ x: number; y: number } | null> {
    // The recorded window's identity is its title; without one the anchor names no window.
    const title = op.windowTitle?.trim()
    if (!title) return null
    return resolveClickPoint(op, async () => {
      if (!this.actuator.windowBounds) return null
      const r = await this.actuator.windowBounds(op.appName, op.appBundleId, title)
      return r.ok && r.bounds ? r.bounds : null
    })
  }

  private async holdForApproval(
    op: AutomationOp,
    label: string,
    prompt: string
  ): Promise<'done' | 'skip' | 'stopped' | 'retry'> {
    // An approval sent before this prompt was shown cannot approve it.
    this.controlQueue = this.controlQueue.filter((c) => c.kind !== 'approve')
    this.hold = 'question'
    this.onEvent({
      type: 'question',
      runId: this.runId,
      stepOrder: op.stepOrder,
      opIndex: this.opIndex,
      label,
      prompt,
      variableKey: null
    })

    while (this.hold === 'question' && !this.stopped) {
      await this.waitForControl()
      const cmd = this.controlQueue.shift()
      if (!cmd) continue
      if (cmd.kind === 'stop') {
        this.stopped = true
        this.hold = null
        return 'stopped'
      }
      if (cmd.kind === 'skip') {
        this.hold = null
        return 'skip'
      }
      // Only an explicit approval commits; Take Over, Retry or an answer do not.
      if (cmd.kind === 'approve') {
        this.hold = null
        return 'done'
      }
      if (cmd.kind === 'pause') this.paused = true
      if (cmd.kind === 'resume') this.paused = false
    }
    return 'stopped'
  }

  private async holdForQuestion(
    op: AutomationOp,
    label: string
  ): Promise<'done' | 'skip' | 'stopped' | 'retry'> {
    this.hold = 'question'
    this.onEvent({
      type: 'question',
      runId: this.runId,
      stepOrder: op.stepOrder,
      opIndex: this.opIndex,
      label,
      prompt: op.prompt ?? 'Provide a value to continue',
      variableKey: op.variableKey
    })

    while (this.hold === 'question' && !this.stopped) {
      await this.waitForControl()
      const cmd = this.controlQueue.shift()
      if (!cmd) continue
      if (cmd.kind === 'stop') {
        this.stopped = true
        this.hold = null
        return 'stopped'
      }
      if (cmd.kind === 'skip') {
        this.hold = null
        return 'skip'
      }
      if (cmd.kind === 'answer') {
        const key = cmd.variableKey ?? op.variableKey
        if (key) this.variables[key] = cmd.value
        this.hold = null
        return 'done'
      }
      if (cmd.kind === 'pause') this.paused = true
      if (cmd.kind === 'resume') this.paused = false
    }
    return this.stopped ? 'stopped' : 'done'
  }

  private async holdForError(
    op: AutomationOp,
    label: string,
    message: string,
    manual: boolean,
    code: RunFailureCode
  ): Promise<'done' | 'skip' | 'stopped' | 'retry'> {
    this.hold = manual ? 'manual' : 'error'
    this.onEvent({
      type: 'stepFailed',
      runId: this.runId,
      stepOrder: op.stepOrder,
      opIndex: this.opIndex,
      label,
      message,
      code,
      manual
    })

    while ((this.hold === 'error' || this.hold === 'manual') && !this.stopped) {
      await this.waitForControl()
      const cmd = this.controlQueue.shift()
      if (!cmd) continue
      if (cmd.kind === 'stop') {
        this.stopped = true
        this.hold = null
        return 'stopped'
      }
      if (cmd.kind === 'skip') {
        this.hold = null
        return 'skip'
      }
      if (cmd.kind === 'retry') {
        this.hold = null
        return 'retry'
      }
      if (cmd.kind === 'takeOver') {
        // User finishes this op by hand; pause until they resume so the next
        // automated op does not race ahead while they are still working.
        this.hold = null
        this.paused = true
        return 'done'
      }
      if (cmd.kind === 'pause') this.paused = true
      if (cmd.kind === 'resume') this.paused = false
    }
    return this.stopped ? 'stopped' : 'done'
  }

  private async drainControls(): Promise<void> {
    while (this.controlQueue.length) {
      const cmd = this.controlQueue.shift()!
      if (cmd.kind === 'pause') this.paused = true
      else if (cmd.kind === 'resume') this.paused = false
      else if (cmd.kind === 'stop') this.stopped = true
      else {
        // retry/skip/answer/takeOver only meaningful during hold — re-queue
        this.controlQueue.unshift(cmd)
        break
      }
    }
  }

  private waitForControl(): Promise<void> {
    if (this.controlQueue.length) return Promise.resolve()
    return new Promise((resolve) => {
      this.waitResolve = resolve
    })
  }

  private async runWithTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), ms)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function navigationDestination(
  op: AutomationOp,
  variables: Record<string, string>
): string {
  if (op.op === 'open_app') return op.appName ?? 'app'
  const url =
    op.url ?? (op.urlVariableKey ? variables[op.urlVariableKey] : undefined)
  if (!url) return 'URL'
  try {
    return new URL(url).hostname || url
  } catch {
    return url.length > 48 ? `${url.slice(0, 47)}…` : url
  }
}

function resolveAllowedHosts(
  ids: string[] | undefined,
  addresses: Array<{ id: string; kind: string; template: string }> | undefined
): Set<string> {
  const hosts = new Set<string>()
  if (!ids?.length) return hosts
  const idSet = new Set(ids)
  for (const id of ids) {
    // Treat bare host-like ids as hosts.
    if (id.includes('.') && !id.includes('://')) hosts.add(id.toLowerCase())
    try {
      hosts.add(new URL(id).hostname.toLowerCase())
    } catch {
      /* not a URL */
    }
  }
  for (const addr of addresses ?? []) {
    if (!idSet.has(addr.id)) continue
    try {
      const host = new URL(addr.template).hostname.toLowerCase()
      if (host) hosts.add(host)
    } catch {
      /* template may be a path or deeplink */
    }
  }
  return hosts
}

/** Stub idempotency check — always continues. Structure hook for real checks later. */
async function checkIdempotencyStub(_op: AutomationOp): Promise<{ ok: true }> {
  return { ok: true }
}

function isRepairable(code: RunFailureCode): boolean {
  return (
    code !== 'out_of_scope' &&
    code !== 'auth_required' &&
    code !== 'wrong_identity' &&
    code !== 'branch_unknown'
  )
}

export function toFailureCode(error?: string): RunFailureCode {
  switch (error) {
    case 'element_not_found':
    case 'app_not_found':
    case 'missing_label':
    case 'missing_point':
      return 'target_not_found'
    case 'wait_timeout':
    case 'timeout':
      return 'timeout'
    case 'missing_url':
      // Unresolvable URL/variable — retrying will not help.
      return 'precondition_unmet'
    case 'navigation_failed':
      return 'navigation_failed'
    case 'out_of_scope':
      return 'out_of_scope'
    case 'value_mismatch':
      return 'value_mismatch'
    case 'auth_required':
      return 'auth_required'
    case 'wrong_identity':
      return 'wrong_identity'
    case 'address_stale':
      return 'address_stale'
    case 'missing_variable':
    case 'missing_condition':
      return 'precondition_unmet'
    case 'press_failed':
    case 'click_unsupported':
    case 'type_unsupported':
    case 'clipboard_unsupported':
    case 'clipboard_write_failed':
      return 'unexpected_state'
    case 'stopped':
      return 'unexpected_state'
    default:
      return 'unexpected_state'
  }
}

function defaultLabel(op: AutomationOp): string {
  switch (op.op) {
    case 'open_app':
      return `Open ${op.appName ?? 'app'}`
    case 'open_url':
      return 'Open URL'
    case 'activate_element':
      return `Click ${op.elementLabel ?? 'element'}`
    case 'click_at':
      return 'Click at position'
    case 'scroll':
      return 'Scroll'
    case 'keystroke':
      return `Press ${op.chord ?? 'keys'}`
    case 'type_text':
      return op.literalText ? `Type "${truncateLabel(op.literalText)}"` : 'Type text'
    case 'set_clipboard':
      return 'Copy to clipboard'
    case 'wait_for':
      return 'Wait'
    case 'ask_user':
      return op.prompt ?? 'Ask for input'
    case 'manual':
      return op.prompt ?? 'Manual step'
    default:
      return 'Step'
  }
}

function truncateLabel(text: string, max = 40): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function clickOptionsFromOp(op: AutomationOp): {
  button?: 'left' | 'right'
  count?: number
  modifiers?: { cmd?: boolean; opt?: boolean; ctrl?: boolean; shift?: boolean }
} {
  return {
    button: op.clickButton === 'right' ? 'right' : 'left',
    count: op.clickCount ?? 1,
    modifiers: op.clickModifiers
      ? {
          cmd: op.clickModifiers.cmd === true,
          opt: op.clickModifiers.opt === true,
          ctrl: op.clickModifiers.ctrl === true,
          shift: op.clickModifiers.shift === true
        }
      : undefined
  }
}

const SIZE_TOLERANCE = 8

/** Resolve a click/scroll point from its recorded window anchor and the live window frame. */
export async function resolveClickPoint(
  op: Pick<
    AutomationOp,
    | 'clickX'
    | 'clickY'
    | 'clickWindowX'
    | 'clickWindowY'
    | 'windowWidth'
    | 'windowHeight'
  >,
  fetchBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
): Promise<{ x: number; y: number } | null> {
  const hasAnchor =
    op.clickWindowX != null &&
    op.clickWindowY != null &&
    op.windowWidth != null &&
    op.windowHeight != null &&
    op.windowWidth > 0 &&
    op.windowHeight > 0

  // Only a point inside the recorded window, re-anchored to that app's live window, is
  // resolved. Absolute screen coordinates (no anchor, or outside the window: menu bar, Dock)
  // carry no verified display or window identity, so they are not executed.
  if (
    !hasAnchor ||
    op.clickWindowX! < 0 ||
    op.clickWindowY! < 0 ||
    op.clickWindowX! > op.windowWidth! ||
    op.clickWindowY! > op.windowHeight!
  ) {
    return null
  }

  // An in-window point needs the live window: no frame means no click, never a stale guess.
  const now = await fetchBounds()
  if (!now || !(now.width > 0 && now.height > 0)) return null
  const dw = Math.abs(now.width - op.windowWidth!)
  const dh = Math.abs(now.height - op.windowHeight!)
  const sx = dw > SIZE_TOLERANCE ? now.width / op.windowWidth! : 1
  const sy = dh > SIZE_TOLERANCE ? now.height / op.windowHeight! : 1
  let x = now.x + Math.round(op.clickWindowX! * sx)
  let y = now.y + Math.round(op.clickWindowY! * sy)
  // Clamp inside the current window rect.
  x = Math.min(now.x + now.width - 1, Math.max(now.x, x))
  y = Math.min(now.y + now.height - 1, Math.max(now.y, y))
  return { x, y }
}

function humanError(code?: string): string {
  switch (code) {
    case 'element_not_found':
      return 'Could not find the UI element.'
    case 'app_not_found':
      return 'Could not find the application.'
    case 'timeout':
    case 'wait_timeout':
      return 'Timed out waiting for the UI.'
    case 'missing_variable':
      return 'A required value is missing.'
    case 'missing_url':
      return 'A URL is required for this step.'
    case 'press_failed':
      return 'Could not click the element.'
    case 'out_of_scope':
      return 'This destination is outside the authorized scope.'
    default:
      return code ? `Automation error: ${code}` : ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
