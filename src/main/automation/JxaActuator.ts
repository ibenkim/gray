import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import { clipboard, systemPreferences } from 'electron'
import { JXA_ACTUATOR_SCRIPT } from './jxaActuatorScript'
import type { Actuator, ActuatorResult, QueryParams } from './types'

type Pending = {
  resolve: (r: ActuatorResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let cmdSeq = 0

/**
 * macOS Accessibility actuation via a long-lived `osascript -l JavaScript` child.
 * Clipboard write/read uses Electron's clipboard module (not JXA).
 */
export class JxaActuator implements Actuator {
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: ReadlineInterface | null = null
  private pending = new Map<string, Pending>()
  private started = false

  static isAccessibilityTrusted(prompt = false): boolean {
    if (process.platform !== 'darwin') return false
    try {
      return systemPreferences.isTrustedAccessibilityClient(prompt)
    } catch {
      return false
    }
  }

  async start(): Promise<void> {
    if (this.started) return
    if (process.platform !== 'darwin') {
      throw new Error('JxaActuator is macOS-only')
    }
    if (!JxaActuator.isAccessibilityTrusted(true)) {
      throw new Error('AUTOMATION_ACCESSIBILITY_DENIED')
    }

    this.child = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_ACTUATOR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', () => {
      /* swallow — never log AX contents */
    })
    this.child.on('error', () => {
      this.failAll('actuator_process_error')
      this.stop()
    })
    this.child.on('exit', () => {
      this.failAll('actuator_exited')
      this.child = null
      this.rl = null
      this.started = false
    })
    this.started = true

    // Warm-up ping
    const ping = await this.send({ type: 'ping' }, 5000)
    if (!ping.ok) {
      this.stop()
      throw new Error('actuator_ping_failed')
    }
  }

  stop(): void {
    this.failAll('actuator_stopped')
    try {
      if (this.child?.stdin.writable) {
        this.child.stdin.write(JSON.stringify({ id: 'quit', type: 'quit' }) + '\n')
      }
    } catch {
      /* ignore */
    }
    try {
      this.rl?.close()
    } catch {
      /* ignore */
    }
    this.rl = null
    if (this.child) {
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      this.child = null
    }
    this.started = false
  }

  async activateApp(
    appName: string | null,
    appBundleId: string | null
  ): Promise<ActuatorResult> {
    return this.send({ type: 'activateApp', appName, appBundleId })
  }

  async openUrl(url: string, appName?: string | null): Promise<ActuatorResult> {
    return this.send({ type: 'openUrl', url, appName: appName ?? null })
  }

  async clickAt(
    x: number,
    y: number,
    button: 'left' | 'right' = 'left'
  ): Promise<ActuatorResult> {
    return this.send({ type: 'clickAt', x, y, button })
  }

  async pressElement(params: {
    appName: string | null
    appBundleId: string | null
    elementRole: string | null
    elementLabel: string
    elementPath?: string[] | null
  }): Promise<ActuatorResult> {
    return this.send({
      type: 'pressElement',
      appName: params.appName,
      appBundleId: params.appBundleId,
      elementRole: params.elementRole,
      elementLabel: params.elementLabel,
      elementPath: params.elementPath ?? null
    })
  }

  async keystroke(chord: string): Promise<ActuatorResult> {
    return this.send({ type: 'keystroke', chord })
  }

  async query(params: QueryParams): Promise<ActuatorResult> {
    return this.send({
      type: 'query',
      waitCondition: params.waitCondition,
      waitValue: params.waitValue ?? null,
      appName: params.appName ?? null,
      appBundleId: params.appBundleId ?? null,
      elementRole: params.elementRole ?? null,
      elementLabel: params.elementLabel ?? null
    })
  }

  /**
   * Readback stub — always succeeds until JXA field-value query lands.
   * Runner calls this after fill-like type_text ops.
   */
  async readField(_params: QueryParams): Promise<ActuatorResult> {
    return { ok: true }
  }

  async typeText(text: string): Promise<ActuatorResult> {
    // Type through System Events so ordinary data_entry never depends on the
    // clipboard (and never fails with clipboard_write_failed).
    const typed = await this.send({ type: 'typeText', text })
    if (typed.ok) return typed
    // Fallback for odd Unicode / apps that swallow keystroke(): paste once.
    try {
      clipboard.writeText(text)
    } catch {
      return { ok: false, error: typed.error ?? 'type_failed' }
    }
    return this.keystroke('Cmd+V')
  }

  setClipboard(text: string): ActuatorResult {
    try {
      clipboard.writeText(text)
      return { ok: true }
    } catch {
      return { ok: false, error: 'clipboard_write_failed' }
    }
  }

  private send(
    body: Record<string, unknown>,
    timeoutMs = 15_000
  ): Promise<ActuatorResult> {
    if (!this.child || !this.started) {
      return Promise.resolve({ ok: false, error: 'actuator_not_started' })
    }
    const id = `cmd_${++cmdSeq}`
    return new Promise<ActuatorResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout' })
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child!.stdin.write(JSON.stringify({ ...body, id }) + '\n')
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: 'write_failed' })
      }
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let result: ActuatorResult & { id?: string }
    try {
      result = JSON.parse(trimmed) as ActuatorResult & { id?: string }
    } catch {
      return
    }
    const id = result.id
    if (!id) return
    const pending = this.pending.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(id)
    pending.resolve({
      ok: !!result.ok,
      error: result.error,
      matched: result.matched,
      matchedLabel: result.matchedLabel,
      matchedRole: result.matchedRole
    })
  }

  private failAll(error: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error })
      this.pending.delete(id)
    }
  }
}
