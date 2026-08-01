import type { AutomationOp, AutomationScript } from '../../shared/telemetry/schema'
import { JxaActuator } from './JxaActuator'
import type { Actuator, RunEvent, RunnerControl } from './types'

export type AutomationRunnerOptions = {
  runId: string
  sessionId: string
  script: AutomationScript
  /** Pre-filled variable answers (key → value). */
  variables?: Record<string, string>
  actuator?: Actuator
  onEvent: (event: RunEvent) => void
  /** Resolve a variable key to a value when ask_user is answered. */
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
  private variables: Record<string, string>
  private opIndex = 0
  private paused = false
  private stopped = false
  private hold: HoldKind = null
  private running = false
  private waitResolve: (() => void) | null = null
  private controlQueue: RunnerControl[] = []

  constructor(opts: AutomationRunnerOptions) {
    this.runId = opts.runId
    this.script = opts.script
    this.onEvent = opts.onEvent
    this.variables = { ...(opts.variables ?? {}) }
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
        message: msg
      })
      this.onEvent({ type: 'finished', runId: this.runId, outcome: 'stopped' })
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
        } else if (outcome === 'skip') {
          this.onEvent({
            type: 'stepDone',
            runId: this.runId,
            stepOrder: op.stepOrder,
            opIndex: this.opIndex,
            label
          })
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
      outcome: this.stopped ? 'stopped' : 'done'
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
  ): Promise<'done' | 'skip' | 'stopped' | 'retry'> {
    if (op.op === 'manual') {
      return this.holdForError(op, label, op.prompt ?? 'Complete this step manually', true)
    }

    if (op.op === 'ask_user') {
      return this.holdForQuestion(op, label)
    }

    const timeout = op.timeoutMs || 15_000
    try {
      const result = await this.runWithTimeout(() => this.dispatch(op), timeout)
      if (result.ok) return 'done'
      return this.holdForError(
        op,
        label,
        humanError(result.error) || `Failed: ${op.op}`,
        false
      )
    } catch {
      return this.holdForError(op, label, 'Step timed out', false)
    }
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
        const pressed = await this.actuator.pressElement({
          appName: op.appName,
          appBundleId: op.appBundleId,
          elementRole: op.elementRole,
          elementLabel: op.elementLabel,
          elementPath: op.elementPath
        })
        if (pressed.ok) return pressed
        // Infer fallbacks when a single AX label cannot be found.
        const addressBar = /address|omnibox|search bar|\burl\b/i.test(op.elementLabel)
        if (addressBar) {
          const focus = await this.actuator.keystroke('Cmd+L')
          if (focus.ok) return focus
        }
        if (op.clickX != null && op.clickY != null && this.actuator.clickAt) {
          return this.actuator.clickAt(op.clickX, op.clickY)
        }
        return pressed
      }
      case 'click_at': {
        if (op.clickX == null || op.clickY == null) {
          return { ok: false, error: 'missing_point' }
        }
        if (!this.actuator.clickAt) return { ok: false, error: 'click_unsupported' }
        return this.actuator.clickAt(op.clickX, op.clickY)
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
    manual: boolean
  ): Promise<'done' | 'skip' | 'stopped' | 'retry'> {
    this.hold = manual ? 'manual' : 'error'
    this.onEvent({
      type: 'stepFailed',
      runId: this.runId,
      stepOrder: op.stepOrder,
      opIndex: this.opIndex,
      label,
      message,
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
    default:
      return code ? `Automation error: ${code}` : ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
