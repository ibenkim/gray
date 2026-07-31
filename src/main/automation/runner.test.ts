import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  clipboard: {
    writeText: vi.fn(),
    readText: vi.fn(() => '')
  },
  systemPreferences: {
    isTrustedAccessibilityClient: vi.fn(() => true)
  }
}))

import type { AutomationScript } from '../../shared/telemetry/schema'
import { AutomationRunner } from './runner'
import type { Actuator, ActuatorResult, QueryParams, RunEvent } from './types'

class FakeActuator implements Actuator {
  calls: string[] = []
  failNext: string | null = null
  started = false

  async start(): Promise<void> {
    this.started = true
  }

  stop(): void {
    this.started = false
  }

  async activateApp(appName: string | null): Promise<ActuatorResult> {
    this.calls.push(`activateApp:${appName}`)
    if (this.failNext === 'activateApp') return { ok: false, error: 'app_not_found' }
    return { ok: true }
  }

  async openUrl(url: string): Promise<ActuatorResult> {
    this.calls.push(`openUrl:${url}`)
    return { ok: true }
  }

  async pressElement(params: {
    appName: string | null
    elementLabel: string
  }): Promise<ActuatorResult> {
    this.calls.push(`press:${params.elementLabel}`)
    if (this.failNext === 'press') return { ok: false, error: 'element_not_found' }
    return { ok: true }
  }

  async keystroke(chord: string): Promise<ActuatorResult> {
    this.calls.push(`keystroke:${chord}`)
    return { ok: true }
  }

  async query(params: QueryParams): Promise<ActuatorResult> {
    this.calls.push(`query:${params.waitCondition}`)
    return { ok: true }
  }

  async typeText(text: string): Promise<ActuatorResult> {
    this.calls.push(`type:${text}`)
    return { ok: true }
  }
}

function baseOp(
  overrides: Partial<AutomationScript['ops'][number]> & { op: AutomationScript['ops'][number]['op'] }
): AutomationScript['ops'][number] {
  return {
    stepOrder: 1,
    evidenceEventIds: ['tevt_1'],
    confidence: 0.9,
    timeoutMs: 5000,
    label: null,
    appName: null,
    appBundleId: null,
    url: null,
    urlVariableKey: null,
    elementRole: null,
    elementLabel: null,
    elementPath: null,
    chord: null,
    variableKey: null,
    waitCondition: null,
    waitValue: null,
    prompt: null,
    ...overrides
  }
}

describe('AutomationRunner', () => {
  it('runs open_app and activate_element sequentially', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({ op: 'open_app', appName: 'Messages', label: 'Open Messages' }),
        baseOp({
          op: 'activate_element',
          stepOrder: 2,
          appName: 'Messages',
          elementLabel: 'Send',
          elementRole: 'AXButton',
          label: 'Click Send'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_1',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => events.push(e)
    })

    await runner.start()

    expect(actuator.calls).toEqual(['activateApp:Messages', 'press:Send'])
    expect(events.filter((e) => e.type === 'stepDone')).toHaveLength(2)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('holds on failure and retries', async () => {
    const actuator = new FakeActuator()
    actuator.failNext = 'press'
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'activate_element',
          elementLabel: 'Send',
          appName: 'Messages',
          label: 'Click Send'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_2',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') {
          actuator.failNext = null
          setTimeout(() => runner.control({ kind: 'retry' }), 5)
        }
      }
    })

    await runner.start()

    expect(events.some((e) => e.type === 'stepFailed')).toBe(true)
    expect(events.filter((e) => e.type === 'stepDone')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('ask_user holds until answered', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'ask_user',
          prompt: 'Who should receive this?',
          variableKey: 'recipient',
          label: 'Ask recipient'
        }),
        baseOp({
          op: 'type_text',
          stepOrder: 2,
          variableKey: 'recipient',
          label: 'Type recipient'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_3',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'question') {
          setTimeout(
            () => runner.control({ kind: 'answer', value: 'Ada', variableKey: 'recipient' }),
            5
          )
        }
      }
    })

    await runner.start()

    expect(events.some((e) => e.type === 'question')).toBe(true)
    expect(actuator.calls).toContain('type:Ada')
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('manual op holds for takeOver', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'manual',
          prompt: 'Finish this by hand',
          label: 'Manual'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_4',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed' && e.manual) {
          setTimeout(() => runner.control({ kind: 'takeOver' }), 5)
        }
      }
    })

    await runner.start()
    expect(events.some((e) => e.type === 'stepFailed' && e.manual)).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('stop aborts the run', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({ op: 'manual', prompt: 'Wait', label: 'Manual' }),
        baseOp({ op: 'open_app', stepOrder: 2, appName: 'Slack', label: 'Open Slack' })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_5',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') {
          setTimeout(() => runner.control({ kind: 'stop' }), 5)
        }
      }
    })

    await runner.start()
    expect(actuator.calls).not.toContain('activateApp:Slack')
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'stopped' })
  })
})

describe('schema round-trip', () => {
  it('parses a stored automation script', async () => {
    const { StoredAutomationScriptSchema, SCHEMA_VERSION } = await import(
      '../../shared/telemetry/schema'
    )
    const raw = {
      sessionId: 'tsess_x',
      schemaVersion: SCHEMA_VERSION,
      compiledAt: '2026-07-29T04:28:48.452Z',
      model: 'gpt-test',
      script: {
        ops: [
          baseOp({ op: 'open_app', appName: 'Terminal', label: 'Open Terminal' })
        ],
        warnings: []
      },
      stale: false
    }
    const parsed = StoredAutomationScriptSchema.parse(raw)
    expect(parsed.script.ops[0].op).toBe('open_app')
  })
})
