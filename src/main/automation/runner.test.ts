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

import { AutomationOpKindSchema, type AutomationOp, type AutomationScript } from '../../shared/telemetry/schema'
import { AutomationRunner, resolveClickPoint, toFailureCode } from './runner'
import type { Actuator, ActuatorResult, QueryParams, RunEvent } from './types'

class FakeActuator implements Actuator {
  calls: string[] = []
  failNext: string | null = null
  /** Fail pressElement this many times, then succeed. */
  failPressTimes = 0
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

  async openUrl(url: string, appName?: string | null): Promise<ActuatorResult> {
    this.calls.push(`openUrl:${url}:${appName ?? ''}`)
    return { ok: true }
  }

  async clickAt(
    x: number,
    y: number,
    options?: { button?: 'left' | 'right'; count?: number; modifiers?: { cmd?: boolean } }
  ): Promise<ActuatorResult> {
    const btn = typeof options === 'object' ? options?.button ?? 'left' : 'left'
    const count = typeof options === 'object' ? options?.count ?? 1 : 1
    const mods =
      typeof options === 'object' && options?.modifiers?.cmd ? '+cmd' : ''
    this.calls.push(`clickAt:${x},${y}:${btn}x${count}${mods}`)
    return { ok: true }
  }

  async scrollAt(
    x: number,
    y: number,
    axis: 'vertical' | 'horizontal',
    delta: number
  ): Promise<ActuatorResult> {
    this.calls.push(`scrollAt:${x},${y}:${axis}:${delta}`)
    return { ok: true }
  }

  windowBoundsResult: { x: number; y: number; width: number; height: number } | null = null

  /** Title of the only live window; a request for another title finds no window. */
  liveWindowTitle = 'Doc'

  async windowBounds(
    appName: string | null,
    _appBundleId: string | null,
    windowTitle?: string | null
  ): Promise<ActuatorResult> {
    this.calls.push(`windowBounds:${appName}`)
    if (!this.windowBoundsResult || windowTitle !== this.liveWindowTitle) return { ok: false, error: 'no_window' }
    return { ok: true, bounds: this.windowBoundsResult }
  }

  pressWindows: Array<string | null | undefined> = []
  /** Host reply for every press (e.g. no_window), when set. */
  pressError: string | null = null

  async pressElement(params: {
    appName: string | null
    elementLabel: string
    windowTitle?: string | null
  }): Promise<ActuatorResult> {
    this.calls.push(`press:${params.elementLabel}`)
    this.pressWindows.push(params.windowTitle)
    if (this.pressError) return { ok: false, error: this.pressError }
    if (this.failPressTimes > 0) {
      this.failPressTimes -= 1
      return { ok: false, error: 'element_not_found' }
    }
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

  setClipboard(text: string): ActuatorResult {
    this.calls.push(`clipboard:${text}`)
    return { ok: true }
  }

  async readField(params: QueryParams): Promise<ActuatorResult> {
    this.calls.push(`readField:${params.elementLabel ?? ''}`)
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
    literalText: null,
    waitCondition: null,
    waitValue: null,
    prompt: null,
    clickX: null,
    clickY: null,
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
      // Avoid supervised Commit gate on "Send"
      mode: 'authorized',
      onEvent: (e) => events.push(e)
    })

    await runner.start()

    // M9: the press re-verifies its recorded app is frontmost first.
    expect(actuator.calls).toEqual(['activateApp:Messages', 'activateApp:Messages', 'press:Send'])
    expect(events.filter((e) => e.type === 'stepDone')).toHaveLength(2)
    expect(events.some((e) => e.type === 'navigating' && e.destination === 'Messages')).toBe(
      true
    )
    expect(events.at(-1)).toMatchObject({
      type: 'finished',
      outcome: 'done',
      resolution: { tier1: 0, tier2: 2 }
    })
  })

  it('auto-repairs up to 2 times before holding with repair_exhausted', async () => {
    const actuator = new FakeActuator()
    actuator.failNext = 'press'
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'activate_element',
          elementLabel: 'Ok',
          appName: 'Messages',
          label: 'Click Ok'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_repair',
      sessionId: 'tsess_1',
      script,
      actuator,
      mode: 'authorized',
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') {
          expect(e.code).toBe('repair_exhausted')
          actuator.failNext = null
          setTimeout(() => runner.control({ kind: 'retry' }), 5)
        }
      }
    })

    await runner.start()

    // 1 initial + 2 auto-repairs, then user retry succeeds → 4 presses
    expect(actuator.calls.filter((c) => c.startsWith('press:'))).toHaveLength(4)
    expect(events.filter((e) => e.type === 'stepFailed')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'stepDone')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('succeeds within repair budget without holding', async () => {
    const actuator = new FakeActuator()
    actuator.failPressTimes = 2 // fail twice, succeed on 3rd (within budget)
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'activate_element',
          elementLabel: 'Ok',
          appName: 'Messages',
          label: 'Click Ok'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_repair_ok',
      sessionId: 'tsess_1',
      script,
      actuator,
      mode: 'authorized',
      onEvent: (e) => events.push(e)
    })

    await runner.start()

    expect(actuator.calls.filter((c) => c.startsWith('press:'))).toHaveLength(3)
    expect(events.some((e) => e.type === 'stepFailed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('maps actuator errors to RunFailureCode', () => {
    expect(toFailureCode('element_not_found')).toBe('target_not_found')
    expect(toFailureCode('app_not_found')).toBe('target_not_found')
    expect(toFailureCode('wait_timeout')).toBe('timeout')
    expect(toFailureCode('timeout')).toBe('timeout')
    expect(toFailureCode('missing_url')).toBe('precondition_unmet')
    expect(toFailureCode('missing_variable')).toBe('precondition_unmet')
    expect(toFailureCode('out_of_scope')).toBe('out_of_scope')
  })

  it('simulated mode dispatches only read-only queries (M5)', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const chords = ['Cmd+S', 'Cmd+Enter', 'Delete', 'Cmd+W', 'Cmd+X', 'Cmd+V', 'Cmd+L', 'Cmd+Shift+K', 'a']
    const ops = [
      baseOp({ op: 'open_app', appName: 'Safari', label: 'Open Safari' }),
      baseOp({ op: 'open_url', url: 'https://example.com/create', label: 'Open create page' }),
      baseOp({ op: 'type_text', literalText: 'hello', label: 'Type hello' }),
      baseOp({ op: 'set_clipboard', literalText: 'hello', label: 'Copy hello' }),
      baseOp({ op: 'activate_element', elementLabel: 'Go', label: 'Click Go' }),
      baseOp({ op: 'click_at', clickX: 10, clickY: 10, label: 'Click point' }),
      baseOp({ op: 'scroll', clickX: 10, clickY: 10, scrollDelta: 3, label: 'Scroll' }),
      ...chords.map((chord) => baseOp({ op: 'keystroke', chord, label: `Press ${chord}` })),
      baseOp({ op: 'manual', prompt: 'Submit the form by hand', label: 'Submit manually' }),
      baseOp({ op: 'ask_user', prompt: 'Which account?', variableKey: 'acct', label: 'Ask account' }),
      baseOp({ op: 'wait_for', waitCondition: 'app_frontmost', appName: 'Safari', label: 'Wait frontmost' })
    ].map((op, i) => ({ ...op, stepOrder: i + 1 }))

    const runner = new AutomationRunner({
      runId: 'run_sim',
      sessionId: 'tsess_1',
      script: { ops, warnings: [] },
      actuator,
      mode: 'simulated',
      onEvent: (e) => events.push(e)
    })
    await runner.start()

    expect(new Set(ops.map((o) => o.op))).toEqual(new Set(AutomationOpKindSchema.options)) // full op union
    expect(actuator.calls).toEqual(['query:app_frontmost'])
    const notRun = events.filter((e) => e.type === 'stepDone' && e.simulated)
    expect(notRun).toHaveLength(ops.length - 1)
    expect(events.some((e) => e.type === 'navigating' || e.type === 'question' || e.type === 'stepFailed')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'incomplete' })
  })

  it('a commit is approved only by an explicit approve (M5)', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const runner = new AutomationRunner({
      runId: 'run_approve',
      sessionId: 'tsess_1',
      script: {
        ops: [baseOp({ op: 'keystroke', chord: 'Cmd+Enter', label: 'Send message' })],
        warnings: []
      },
      actuator,
      onEvent: (e) => events.push(e)
    })
    runner.control({ kind: 'approve' }) // sent before the prompt: must not count
    const run = runner.start()
    await vi.waitFor(() => expect(events.some((e) => e.type === 'question')).toBe(true))
    for (const cmd of [{ kind: 'takeOver' }, { kind: 'retry' }, { kind: 'answer', value: 'yes' }] as const) {
      runner.control(cmd)
      await new Promise((r) => setTimeout(r, 10))
      expect(actuator.calls).toEqual([])
    }
    runner.control({ kind: 'approve' })
    await run
    expect(actuator.calls).toEqual(['keystroke:Cmd+Enter'])
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('an empty address scope allows no URL (M5)', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const runner = new AutomationRunner({
      runId: 'run_scope',
      sessionId: 'tsess_1',
      script: { ops: [baseOp({ op: 'open_url', url: 'https://example.com/', label: 'Open' })], warnings: [] },
      actuator,
      allowedAddressIds: [],
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') setTimeout(() => runner.control({ kind: 'stop' }), 1)
      }
    })
    await runner.start()
    expect(events.find((e) => e.type === 'stepFailed')).toMatchObject({ code: 'out_of_scope' })
    expect(actuator.calls).toEqual([])
  })

  it('a skipped step is not reported as done (M5)', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const runner = new AutomationRunner({
      runId: 'run_skip',
      sessionId: 'tsess_1',
      script: { ops: [baseOp({ op: 'manual', prompt: 'Do it', label: 'Manual' })], warnings: [] },
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') setTimeout(() => runner.control({ kind: 'skip' }), 1)
      }
    })
    await runner.start()
    expect(events.find((e) => e.type === 'stepDone')).toMatchObject({ skipped: true })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'incomplete' })
  })

  it('halts open_url outside allowedAddressIds with out_of_scope', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'open_url',
          url: 'https://evil.example/phish',
          label: 'Open evil'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_scope',
      sessionId: 'tsess_1',
      script,
      actuator,
      mode: 'authorized',
      allowedAddressIds: ['addr_ok'],
      addresses: [
        { id: 'addr_ok', kind: 'url', template: 'https://safe.example/home' }
      ],
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') {
          setTimeout(() => runner.control({ kind: 'stop' }), 5)
        }
      }
    })

    await runner.start()

    expect(actuator.calls).not.toContain('openUrl:https://evil.example/phish:')
    const failed = events.find((e) => e.type === 'stepFailed')
    expect(failed).toMatchObject({ code: 'out_of_scope' })
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'stopped' })
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

  it('set_clipboard uses recorded literalText when no variable is supplied', async () => {
    const actuator = new FakeActuator()
    const runner = new AutomationRunner({
      runId: 'run_clip',
      sessionId: 'tsess_1',
      script: {
        ops: [baseOp({ op: 'set_clipboard', literalText: 'paste me', label: null })],
        warnings: []
      },
      actuator,
      onEvent: () => {}
    })
    await runner.start()
    expect(actuator.calls).toContain('clipboard:paste me')
  })

  it('types text recorded during the session when no variable is supplied', async () => {
    const actuator = new FakeActuator()
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [baseOp({ op: 'type_text', literalText: 'Q3 report', label: null })],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_literal',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => events.push(e)
    })
    await runner.start()

    expect(actuator.calls).toContain('type:Q3 report')
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
    // The ledger shows what will be typed.
    expect(events.find((e) => e.type === 'stepStarted')).toMatchObject({
      label: 'Type "Q3 report"'
    })
  })

  it('prefers a supplied variable over recorded literal text', async () => {
    const actuator = new FakeActuator()
    const script: AutomationScript = {
      ops: [
        baseOp({ op: 'type_text', variableKey: 'subject', literalText: 'recorded', label: null })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_var',
      sessionId: 'tsess_1',
      script,
      actuator,
      variables: { subject: 'live value' },
      onEvent: () => {}
    })
    await runner.start()

    expect(actuator.calls).toContain('type:live value')
    expect(actuator.calls).not.toContain('type:recorded')
  })

  it('calls readField after fill-labeled type_text', async () => {
    const actuator = new FakeActuator()
    const runner = new AutomationRunner({
      runId: 'run_fill',
      sessionId: 'tsess_1',
      script: {
        ops: [
          baseOp({
            op: 'type_text',
            literalText: 'Ada',
            label: 'Fill name',
            elementLabel: 'Name',
            elementRole: 'AXTextField',
            appName: 'Forms'
          })
        ],
        warnings: []
      },
      actuator,
      onEvent: () => {}
    })
    await runner.start()
    expect(actuator.calls).toContain('type:Ada')
    expect(actuator.calls).toContain('readField:Name')
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
        }),
        baseOp({
          op: 'open_app',
          stepOrder: 2,
          appName: 'Slack',
          label: 'Open Slack'
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
          setTimeout(() => {
            runner.control({ kind: 'takeOver' })
            // Resume after the user finishes the takeover work.
            setTimeout(() => runner.control({ kind: 'resume' }), 5)
          }, 5)
        }
      }
    })

    await runner.start()
    expect(events.some((e) => e.type === 'stepFailed' && e.manual)).toBe(true)
    expect(actuator.calls).toContain('activateApp:Slack')
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('activate_element falls back to Cmd+L for address bar', async () => {
    const actuator = new FakeActuator()
    actuator.failNext = 'press'
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'activate_element',
          elementLabel: 'Address and search bar',
          elementRole: 'AXTextField',
          appName: 'Google Chrome',
          label: 'Focus omnibox'
        })
      ],
      warnings: []
    }

    const runner = new AutomationRunner({
      runId: 'run_addr',
      sessionId: 'tsess_1',
      script,
      actuator,
      mode: 'authorized',
      onEvent: (e) => events.push(e)
    })

    await runner.start()
    expect(actuator.calls).toContain('press:Address and search bar')
    expect(actuator.calls).toContain('keystroke:Cmd+L')
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

  it('replays click_at with count and button fidelity', async () => {
    const actuator = new FakeActuator()
    actuator.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'click_at',
          appName: 'Figma',
          clickX: 50,
          clickY: 60,
          clickWindowX: 50,
          clickWindowY: 60,
          windowWidth: 800,
          windowHeight: 600,
          windowTitle: 'Doc',
          clickButton: 'right',
          clickCount: 2,
          clickModifiers: { cmd: true },
          label: 'Cmd-right double'
        })
      ],
      warnings: []
    }
    const runner = new AutomationRunner({
      runId: 'run_click',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => events.push(e)
    })
    await runner.start()
    expect(actuator.calls.some((c) => c.includes('clickAt:50,60:rightx2+cmd'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'finished', outcome: 'done' })
  })

  it('anchors click_at to a moved window via windowBounds', async () => {
    const actuator = new FakeActuator()
    actuator.windowBoundsResult = { x: 200, y: 100, width: 800, height: 600 }
    const events: RunEvent[] = []
    const script: AutomationScript = {
      ops: [
        baseOp({
          op: 'click_at',
          appName: 'Figma',
          clickX: 140,
          clickY: 180,
          clickWindowX: 40,
          clickWindowY: 80,
          windowWidth: 800,
          windowHeight: 600,
          windowTitle: 'Doc',
          label: 'Anchored click'
        })
      ],
      warnings: []
    }
    const runner = new AutomationRunner({
      runId: 'run_anchor',
      sessionId: 'tsess_1',
      script,
      actuator,
      onEvent: (e) => events.push(e)
    })
    await runner.start()
    // origin moved to 200,100 → click at 240,180
    expect(actuator.calls.some((c) => c.startsWith('clickAt:240,180'))).toBe(true)
  })
})

describe('M9: a point op acts only in the verified recorded app', () => {
  async function run(op: Partial<AutomationOp>, setup: (a: FakeActuator) => void = () => {}) {
    const actuator = new FakeActuator()
    setup(actuator)
    const events: RunEvent[] = []
    const runner: AutomationRunner = new AutomationRunner({
      runId: 'run_m9',
      sessionId: 'tsess_1',
      script: { ops: [baseOp({ label: 'Point', ...op })], warnings: [] },
      actuator,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'stepFailed') setTimeout(() => runner.control({ kind: 'stop' }), 1)
      }
    })
    await runner.start()
    return { calls: actuator.calls, failed: events.find((e) => e.type === 'stepFailed') }
  }
  const anchored = { clickX: 140, clickY: 180, clickWindowX: 40, clickWindowY: 80, windowWidth: 800, windowHeight: 600, windowTitle: 'Doc' }

  it('failed activation stops click_at and scroll before any input', async () => {
    const click = await run({ op: 'click_at', appName: 'Figma', ...anchored }, (a) => (a.failNext = 'activateApp'))
    expect(click.failed).toBeDefined()
    expect(click.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
    const scroll = await run({ op: 'scroll', appName: 'Figma', scrollDelta: 3, ...anchored }, (a) => (a.failNext = 'activateApp'))
    expect(scroll.calls.some((c) => c.startsWith('scrollAt'))).toBe(false)
  })

  it('a point op with no recorded app is never clicked', async () => {
    const r = await run({ op: 'click_at', appName: null, appBundleId: null, clickX: 5, clickY: 5 })
    expect(r.failed).toBeDefined()
    expect(r.calls).toEqual([])
  })

  it('a missing live window frame stops the click instead of using recorded screen coords', async () => {
    const r = await run({ op: 'click_at', appName: 'Figma', ...anchored })
    expect(r.calls).toContain('windowBounds:Figma')
    expect(r.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
    expect(r.failed).toBeDefined()
  })

  it('middle click is never replayed as a left click', async () => {
    const r = await run({ op: 'click_at', appName: 'Figma', clickButton: 'middle', ...anchored }, (a) => {
      a.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(r.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
    expect(r.failed).toBeDefined()
  })

  it('R2: a recorded middle press on an AX target is unsupported before any AXPress', async () => {
    const r = await run({ op: 'activate_element', appName: 'Figma', elementLabel: 'Share', clickButton: 'middle' })
    expect(r.calls).toEqual([])
    expect(r.failed).toBeDefined()
  })

  it('R3: failed activation stops activate_element before AXPress and before the Cmd+L fallback', async () => {
    const r = await run({ op: 'activate_element', appName: 'Safari', elementLabel: 'Address and search bar' }, (a) => {
      a.failNext = 'activateApp'
    })
    expect(r.calls.filter((c) => !c.startsWith('activateApp'))).toEqual([])
    const none = await run({ op: 'activate_element', appName: null, appBundleId: null, elementLabel: 'Share' })
    expect(none.calls).toEqual([])
  })

  it('R4: an absolute-only point (no window anchor) is never executed, and no bounds are guessed', async () => {
    const r = await run({ op: 'click_at', appName: 'Figma', clickX: 5000, clickY: 5000 }, (a) => {
      a.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(r.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
    expect(r.failed).toBeDefined()
  })

  it('R4: the recorded window is required by title: another window of the same app is not used', async () => {
    const other = await run({ op: 'click_at', appName: 'Figma', ...anchored, windowTitle: 'Recorded document' }, (a) => {
      a.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
      a.liveWindowTitle = 'Other document'
    })
    expect(other.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
    expect(other.failed).toBeDefined()
    // No recorded title: the anchor names no window, so no bounds are even requested.
    const untitled = await run({ op: 'click_at', appName: 'Figma', ...anchored, windowTitle: null }, (a) => {
      a.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
    })
    expect(untitled.calls.some((c) => c.startsWith('windowBounds') || c.startsWith('clickAt'))).toBe(false)
    // Control: the recorded window present → the click lands in it.
    const same = await run({ op: 'click_at', appName: 'Figma', ...anchored }, (a) => {
      a.windowBoundsResult = { x: -1200, y: -200, width: 800, height: 600 }
    })
    expect(same.calls).toContain('clickAt:-1160,-120:leftx1')
  })

  it('R4: activate_element forwards its recorded window to the press', async () => {
    let seen: Array<string | null | undefined> = []
    await run({ op: 'activate_element', appName: 'Figma', elementLabel: 'Share', windowTitle: 'Recorded document' }, (a) => {
      seen = a.pressWindows
    })
    expect(seen).toEqual(['Recorded document'])
  })

  it.each(['no_window', 'activate_failed', 'app_not_found'])(
    'R4: a press that fails window/app identity (%s) sends no Cmd+L and no click fallback',
    async (error) => {
      const r = await run(
        { op: 'activate_element', appName: 'Safari', elementLabel: 'Address and search bar', windowTitle: 'Recorded document', ...anchored },
        (a) => {
          a.pressError = error
          a.windowBoundsResult = { x: 0, y: 0, width: 800, height: 600 }
        }
      )
      expect(r.calls.filter((c) => c.startsWith('keystroke') || c.startsWith('clickAt'))).toEqual([])
      expect(r.failed).toBeDefined()
    }
  )

  it('control: a label not found in the verified window may still use the Cmd+L fallback', async () => {
    const r = await run({ op: 'activate_element', appName: 'Safari', elementLabel: 'Address and search bar' }, (a) => {
      a.pressError = 'element_not_found'
    })
    expect(r.calls).toContain('keystroke:Cmd+L')
  })

  it('the activate_element coordinate fallback needs activation and the live window', async () => {
    const r = await run(
      { op: 'activate_element', appName: 'Figma', elementLabel: 'Share', ...anchored },
      (a) => {
        a.failPressTimes = 99
        a.failNext = 'activateApp'
      }
    )
    expect(r.calls.some((c) => c.startsWith('clickAt'))).toBe(false)
  })
})

describe('resolveClickPoint', () => {
  it('M9: an in-window point with no live window frame is not clicked (no stale absolute guess)', async () => {
    const pt = await resolveClickPoint(
      {
        clickX: 10,
        clickY: 20,
        clickWindowX: 5,
        clickWindowY: 5,
        windowWidth: 100,
        windowHeight: 100
      },
      async () => null
    )
    expect(pt).toBeNull()
  })

  it('M9: an out-of-window offset (menu bar, Dock) is not clicked at recorded screen coords', async () => {
    const pt = await resolveClickPoint(
      {
        clickX: 50,
        clickY: -10,
        clickWindowX: 10,
        clickWindowY: -20,
        windowWidth: 100,
        windowHeight: 100
      },
      async () => ({ x: 0, y: 0, width: 100, height: 100 })
    )
    expect(pt).toBeNull()
  })

  it('scales the offset when the window was resized', async () => {
    const pt = await resolveClickPoint(
      {
        clickX: 50,
        clickY: 50,
        clickWindowX: 50,
        clickWindowY: 50,
        windowWidth: 100,
        windowHeight: 100
      },
      async () => ({ x: 0, y: 0, width: 200, height: 200 })
    )
    expect(pt).toEqual({ x: 100, y: 100 })
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
