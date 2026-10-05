import { spawn as spawnChild } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFromValueTail,
  CHILD_STOP_GRACE_MS,
  JxaAccessibilityProvider,
  type JxaKeyEvent
} from './JxaAccessibilityProvider'
import { JXA_PARENT_LIFETIME } from './jxaScript'
import type { InteractionPartial } from '../providers'

// Child-ownership tests (M2) swap in fake children; everything else uses the real module.
const fake = vi.hoisted(() => ({ spawn: null as null | ((...args: unknown[]) => unknown) }))
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) =>
      fake.spawn ? fake.spawn(...args) : real.spawn(...args)
  }
})

describe('appendFromValueTail', () => {
  it('returns the appended suffix by length delta', () => {
    expect(appendFromValueTail(5, 'hello world', 11)).toBe(' world')
    expect(appendFromValueTail(10, 'abcdefghijX', 11)).toBe('X')
  })

  it('returns null when length did not grow', () => {
    expect(appendFromValueTail(11, 'hello world', 11)).toBeNull()
    expect(appendFromValueTail(12, 'hello', 5)).toBeNull()
  })
})

describe('JxaAccessibilityProvider', () => {
  it('emits focus_changed and selection_changed from a sample', () => {
    const provider = new JxaAccessibilityProvider()
    const events: InteractionPartial[] = []
    // Drive without spawning osascript.
    provider['onEvent'] = (p) => events.push(p)
    provider['enabled'] = true

    provider.emitFromSample({
      appName: 'Messages',
      appBundleId: 'com.apple.MobileSMS',
      windowTitle: 'Alex',
      documentTitle: 'Alex',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      elementPath: ['Conversation', 'Messages'],
      selectedLabels: ['Alex']
    })

    expect(events.some((e) => e.type === 'focus_changed')).toBe(true)
    expect(events.some((e) => e.type === 'selection_changed')).toBe(true)
    const sel = events.find((e) => e.type === 'selection_changed')
    expect(sel?.data?.selectedLabels?.[0]).toBe('Alex')
  })

  it('emits inferred element_activated after button focus then state change', () => {
    const provider = new JxaAccessibilityProvider()
    const events: InteractionPartial[] = []
    provider['onEvent'] = (p) => events.push(p)
    provider['enabled'] = true

    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXButton',
      elementLabel: 'Send',
      valueLength: null,
      selectedLabels: []
    })
    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      selectedLabels: ['Alex']
    })

    const act = events.find((e) => e.type === 'element_activated')
    expect(act).toBeTruthy()
    expect(act?.data?.inferred).toBe(true)
    expect(act?.data?.elementLabel).toBe('Send')
  })

  it('disables itself when sample reports an error', () => {
    const provider = new JxaAccessibilityProvider()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    provider['onEvent'] = () => {}
    provider.handleLine(JSON.stringify({ error: 'not trusted' }))
    expect(provider.enabled).toBe(false)
    spy.mockRestore()
  })

  it('does not re-emit focus_changed when only the field length changes', () => {
    const { provider, events } = harness()
    const base = {
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      selectedLabels: []
    }
    provider.emitFromSample({ ...base, valueLength: 0 })
    provider.emitFromSample({ ...base, valueLength: 1 })
    provider.emitFromSample({ ...base, valueLength: 2 })

    // Typing must not produce one focus event per character.
    expect(events.filter((e) => e.type === 'focus_changed')).toHaveLength(1)
  })

  it('tolerates transient faults and only disables after repeated ones', () => {
    const { provider } = harness()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 4; i++) provider.handleLine(JSON.stringify({ k: 'fault' }))
    expect(provider.enabled).toBe(true)
    provider.handleLine(JSON.stringify({ k: 'fault' }))
    expect(provider.enabled).toBe(false)
    spy.mockRestore()
  })
})

/** Drive the provider without spawning osascript. */
function harness(): { provider: JxaAccessibilityProvider; events: InteractionPartial[] } {
  const provider = new JxaAccessibilityProvider()
  const events: InteractionPartial[] = []
  provider['onEvent'] = (p) => events.push(p)
  provider['enabled'] = true
  return { provider, events }
}

function key(overrides: Partial<JxaKeyEvent> & { code: number }): JxaKeyEvent {
  return { chars: null, base: null, ...overrides }
}

/** A printable character key (keyCode is irrelevant for these). */
function char(ch: string): JxaKeyEvent {
  return key({ code: 0, chars: ch, base: ch })
}

describe('JxaAccessibilityProvider typing capture', () => {
  it('aggregates keystrokes into one text_input on Return', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      selectedLabels: []
    })

    for (const ch of 'hey') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 36 })) // Return

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0].data?.typedText).toBe('hey')
    expect(typed[0].data?.submitKey).toBe('Return')
    expect(typed[0].data?.elementLabel).toBe('Message')
    expect(typed[0].target?.appName).toBe('Messages')
  })

  it('applies backspace to the buffered text', () => {
    const { provider, events } = harness()
    for (const ch of 'helo') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 51 })) // Backspace
    provider.handleKey(char('l'))
    provider.handleKey(char('o'))
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('hello')
    // keyCount counts physical presses, including the correction.
    expect(typed?.data?.keyCount).toBe(7)
  })

  it('never buffers characters typed into a secure field', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Safari',
      elementRole: 'AXSecureTextField',
      elementLabel: 'Password',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hunter2') provider.handleKey(char(ch))
    provider.flush()

    expect(events.some((e) => e.type === 'text_input')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('hunter')
  })

  it('honours the secure flag reported with the key event itself', () => {
    const { provider, events } = harness()
    provider.handleKey({ code: 0, chars: 's', base: 's', secure: true })
    provider.flush()
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })

  it('starts a new entry when focus moves to another element', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'To',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'ben') provider.handleKey(char(ch))

    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'Subject',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hi') provider.handleKey(char(ch))
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(2)
    expect(typed[0].data?.typedText).toBe('ben')
    expect(typed[0].data?.elementLabel).toBe('To')
    expect(typed[1].data?.typedText).toBe('hi')
    expect(typed[1].data?.elementLabel).toBe('Subject')
  })

  it('redacts sensitive text before it leaves the provider', () => {
    const { provider, events } = harness()
    for (const ch of 'ben@example.com') provider.handleKey(char(ch))
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('[email]')
    expect(typed?.data?.typedTextRedacted).toBe(true)
  })

  it('reports chords as shortcuts instead of typed text', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 1, chars: 's', base: 's', cmd: true }))

    const shortcut = events.find((e) => e.type === 'keyboard_shortcut')
    expect(shortcut?.data?.shortcut).toBe('Cmd+S')
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })

  it('flushes in-progress typing before recording a chord', () => {
    const { provider, events } = harness()
    for (const ch of 'draft') provider.handleKey(char(ch))
    provider.handleKey(key({ code: 36, cmd: true })) // Cmd+Enter to send

    const types = events.map((e) => e.type)
    expect(types).toEqual(['text_input', 'keyboard_shortcut'])
    expect(events[0].data?.typedText).toBe('draft')
    expect(events[1].data?.shortcut).toBe('Cmd+Enter')
  })

  it('captures copy and paste chords, which accelerators could not', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 8, chars: 'c', base: 'c', cmd: true }))
    provider.handleKey(key({ code: 9, chars: 'v', base: 'v', cmd: true }))

    expect(events.map((e) => e.data?.shortcut)).toEqual(['Cmd+C', 'Cmd+V'])
  })

  it('ignores arrow keys as characters but keeps the entry open', () => {
    const { provider, events } = harness()
    provider.handleKey(char('a'))
    provider.handleKey(key({ code: 123 })) // Left arrow
    provider.handleKey(char('b'))
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0].data?.typedText).toBe('ab')
  })

  it('drops NSEvent private-use characters for function keys', () => {
    const { provider, events } = harness()
    provider.handleKey(key({ code: 122, chars: '\uF704', base: '\uF704' }))
    provider.flush()
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })
})

describe('JxaAccessibilityProvider click capture', () => {
  it('emits a click carrying the Accessibility identity of the target', () => {
    const { provider, events } = harness()
    provider.handleLine(
      JSON.stringify({
        k: 'click',
        button: 'left',
        count: 1,
        x: 300,
        y: 200,
        app: 'Messages',
        appBundleId: 'com.apple.MobileSMS',
        role: 'AXButton',
        label: 'Send',
        path: ['Conversation', 'Messages']
      })
    )

    const click = events.find((e) => e.type === 'click')
    expect(click).toBeTruthy()
    expect(click!.data?.elementLabel).toBe('Send')
    expect(click!.data?.elementRole).toBe('AXButton')
    expect(click!.data?.elementPath).toEqual(['Conversation', 'Messages'])
    expect(click!.data?.clickButton).toBe('left')
    expect(click!.target?.accessibleLabel).toBe('Send')
  })

  it('drops JXA bridge garbage roles so clicks fall back to coords tier', () => {
    const { provider, events } = harness()
    provider.handleClick({
      button: 'left',
      count: 1,
      x: 100,
      y: 200,
      app: 'Google Chrome',
      role: '[object Ref]',
      label: undefined
    })
    const click = events.find((e) => e.type === 'click')
    expect(click?.data?.elementRole).toBeUndefined()
    expect(click?.data?.targetTier).toBe('coords')
    expect(click?.target?.tier).toBe('coords')
  })

  it('marks unlabeled AXGroup clicks as coords tier', () => {
    const { provider, events } = harness()
    provider.handleClick({
      button: 'left',
      count: 1,
      x: 150,
      y: 250,
      app: 'Figma',
      role: 'AXGroup',
      label: undefined,
      windowBounds: { x: 100, y: 200, width: 900, height: 700 }
    })
    const click = events.find((e) => e.type === 'click')
    expect(click?.data?.targetTier).toBe('coords')
    expect(click?.data?.clickWindowX).toBe(50)
    expect(click?.data?.clickWindowY).toBe(50)
  })

  it('emits key_pressed for bare Escape with no typing buffer', () => {
    const { provider, events } = harness()
    provider.handleKey({
      code: 53,
      chars: '\u001b',
      app: 'Finder'
    })
    expect(events.some((e) => e.type === 'key_pressed' && e.data?.shortcut === 'Escape')).toBe(
      true
    )
  })

  it('folds Enter into submitKey when typing is in progress', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hi') provider.handleKey(char(ch))
    provider.handleKey({ code: 36, chars: '\r', app: 'Messages' })
    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('hi')
    expect(typed?.data?.submitKey).toBe('Return')
    expect(events.some((e) => e.type === 'key_pressed')).toBe(false)
  })

  it('clamps an implausible click count', () => {
    const { provider, events } = harness()
    provider.handleClick({ button: 'right', count: 99, label: 'Row' })
    const click = events.find((e) => e.type === 'click')
    expect(click?.data?.clickCount).toBe(10)
    expect(click?.data?.clickButton).toBe('right')
  })

  it('flushes typing when the click lands on a different element', () => {
    const { provider, events } = harness()
    provider.emitFromSample({
      appName: 'Mail',
      elementRole: 'AXTextField',
      elementLabel: 'Subject',
      valueLength: 0,
      selectedLabels: []
    })
    for (const ch of 'hi') provider.handleKey(char(ch))
    provider.handleClick({ button: 'left', label: 'Send', role: 'AXButton', app: 'Mail' })

    const types = events.map((e) => e.type)
    expect(types).toContain('text_input')
    expect(types.indexOf('text_input')).toBeLessThan(types.indexOf('click'))
  })
})

describe('AX valueTail typing fallback', () => {
  it('aggregates typed text from valueTail when key monitors are silent', () => {
    vi.useFakeTimers()
    const { provider, events } = harness()
    const base = {
      appName: 'Terminal',
      elementRole: 'AXTextArea',
      elementLabel: 'shell',
      selectedLabels: [],
      secure: false
    }
    provider.emitFromSample({ ...base, valueLength: 10, valueTail: 'prompt> ls' })
    provider.emitFromSample({ ...base, valueLength: 12, valueTail: 'prompt> ls -' })
    provider.emitFromSample({ ...base, valueLength: 13, valueTail: 'prompt> ls -l' })
    vi.advanceTimersByTime(1300)
    provider.flush()

    const typed = events.find((e) => e.type === 'text_input')
    // sanitizeTypedText trims leading whitespace.
    expect(typed?.data?.typedText).toBe('-l')
    vi.useRealTimers()
  })

  it('does not use valueTail while key events are actively arriving', () => {
    vi.useFakeTimers()
    const { provider, events } = harness()
    const base = {
      appName: 'Messages',
      elementRole: 'AXTextArea',
      elementLabel: 'Message',
      selectedLabels: [],
      secure: false
    }
    provider.emitFromSample({ ...base, valueLength: 0, valueTail: '' })
    provider.handleKey(char('h'))
    provider.handleKey(char('i'))
    // Length also grows via AX — must not double-append.
    provider.emitFromSample({ ...base, valueLength: 2, valueTail: 'hi' })
    vi.advanceTimersByTime(1300)
    provider.flush()

    const typed = events.filter((e) => e.type === 'text_input')
    expect(typed).toHaveLength(1)
    expect(typed[0]?.data?.typedText).toBe('hi')
    vi.useRealTimers()
  })
})

describe('capability reporting', () => {
  it('reports that keys are not captured when accessibility is denied', () => {
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => false })
    const seen: boolean[] = []
    provider['onEvent'] = () => {}
    provider.onCapabilityChange(({ capturesKeys }) => seen.push(capturesKeys))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    provider.handleLine(JSON.stringify({ k: 'ready', trusted: false, monitors: true }))

    expect(provider.capturesKeys).toBe(false)
    expect(seen).toEqual([false])
    warn.mockRestore()
  })

  it('reports that keys are captured once the sensor confirms monitors', () => {
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    provider['onEvent'] = () => {}
    provider.handleLine(
      JSON.stringify({ k: 'ready', trusted: true, monitors: true, secureApi: true })
    )
    expect(provider.capturesKeys).toBe(true)
  })
})

/** Stand-in for the osascript child: pipes, signals and exit are scripted by the test. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = { end: vi.fn() }
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  signals: string[] = []
  /** When false the child ignores SIGTERM (a stuck sensor). */
  honorsTerm = true
  kill(sig: NodeJS.Signals) {
    this.signals.push(sig)
    if (sig === 'SIGKILL' || this.honorsTerm) setTimeout(() => this.exit(null, sig), 0)
    return true
  }
  exit(code: number | null, sig: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return
    this.exitCode = code
    this.signalCode = sig
    this.emit('exit', code, sig)
  }
  line(obj: unknown) {
    this.stdout.write(JSON.stringify(obj) + '\n')
  }
}

describe('child ownership (M2)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const children: FakeChild[] = []

  function useFakeChildren() {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    fake.spawn = () => {
      const c = new FakeChild()
      children.push(c)
      return c
    }
  }

  afterEach(() => {
    fake.spawn = null
    children.length = 0
    Object.defineProperty(process, 'platform', platform)
    vi.useRealTimers()
  })

  const sample = (label: string) => ({ appName: 'FixtureApp', role: 'AXButton', title: label })

  it('a stopped child is owned until it exits: no replacement, no late output, no false disable', async () => {
    useFakeChildren()
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    const first: InteractionPartial[] = []
    const second: InteractionPartial[] = []
    provider.start((p) => first.push(p))
    const old = children[0]
    old.honorsTerm = false
    const stopping = provider.stop() // old child is still alive (ignoring SIGTERM)
    expect(provider.teardownPending).toBe(true)
    // A replacement cannot overlap the unexited child.
    provider.start((p) => second.push(p))
    expect(children).toHaveLength(1)
    expect(provider.enabled).toBe(false)

    old.line(sample('OldLate'))
    await new Promise((r) => setTimeout(r, 10))
    expect(first).toHaveLength(0)
    expect(second).toHaveLength(0)
    old.exit(1) // exit during an intentional stop is not a sensor failure
    await stopping
    expect(provider.teardownPending).toBe(false)

    provider.start((p) => second.push(p))
    expect(children).toHaveLength(2)
    expect(provider.enabled).toBe(true)
    children[1].line(sample('Current'))
    await new Promise((r) => setTimeout(r, 10))
    expect(second.length).toBeGreaterThan(0)
    expect(second.some((p) => JSON.stringify(p).includes('OldLate'))).toBe(false)
    await provider.stop()
  })

  it('stop resolves only after the child exits: SIGTERM, then SIGKILL after the grace period', async () => {
    vi.useFakeTimers()
    useFakeChildren()
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    provider.start(() => {})
    const child = children[0]
    child.honorsTerm = false
    let stopped = false
    const stopping = provider.stop().then(() => (stopped = true))
    expect(child.signals).toEqual(['SIGTERM'])
    expect(child.stdin.end).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(CHILD_STOP_GRACE_MS - 1)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopped).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a child that never reports exit is a typed teardown failure, still owned, with no timers left', async () => {
    vi.useFakeTimers()
    useFakeChildren()
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    provider.start(() => {})
    const child = children[0]
    child.kill = (sig: NodeJS.Signals) => {
      child.signals.push(sig)
      return true
    }
    let outcome: string | null = null
    const stopping = provider.stop().then(
      () => (outcome = 'resolved'),
      (err: Error) => (outcome = err.name === 'Error' && /did not exit/.test(err.message) ? 'timeout' : 'other')
    )
    await vi.advanceTimersByTimeAsync(CHILD_STOP_GRACE_MS + 499)
    expect(outcome).toBe(null)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(outcome).toBe('timeout')
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    // Never treated as stopped: the child stays owned and blocks a replacement.
    expect(provider.teardownPending).toBe(true)
    provider.start(() => {})
    expect(children).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    // A late observed exit finally releases ownership.
    child.exit(null, 'SIGKILL')
    expect(provider.teardownPending).toBe(false)
  })

  it('kill throwing on every signal still settles as a typed failure at the deadline', async () => {
    vi.useFakeTimers()
    useFakeChildren()
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    provider.start(() => {})
    const child = children[0]
    child.kill = () => {
      throw new Error('EPERM')
    }
    child.stdin.end = vi.fn(() => {
      throw new Error('EPIPE')
    })
    let rejected = false
    const stopping = provider.stop().catch(() => (rejected = true))
    await vi.advanceTimersByTimeAsync(CHILD_STOP_GRACE_MS + 500)
    await stopping
    expect(rejected).toBe(true)
    expect(provider.teardownPending).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('the sensor is spawned with its parent pid so it can detect parent loss', () => {
    useFakeChildren()
    const calls: unknown[][] = []
    const make = fake.spawn!
    fake.spawn = (...args: unknown[]) => {
      calls.push(args)
      return make(...args)
    }
    const provider = new JxaAccessibilityProvider({ isAccessibilityTrusted: () => true })
    const scope = { self: ['electron'], deny: ['1password'], allow: ['google chrome'] }
    provider.start(() => {}, scope)
    const opts = calls[0][2] as { env: Record<string, string> }
    expect(opts.env.GRAY_JXA_PARENT_PID).toBe(String(process.pid))
    // M3-C: the sensor enforces this scope before reading; no scope = it reads nothing.
    expect(JSON.parse(opts.env.GRAY_JXA_SCOPE)).toEqual(scope)
    void provider.stop()
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * No-capture lifetime fixture: a real osascript runs ONLY the sensor's parent-lifetime check
 * in a loop (no Cocoa/AX import, no monitors, nothing read). An intermediate parent spawns
 * it; killing that parent must make the child exit on its own. Process ids only.
 */
describe.runIf(process.platform === 'darwin')('JXA parent lifetime (no-capture fixture)', () => {
  it('keeps running while its parent lives and exits by itself after the parent is killed', async () => {
    const loop = `${JXA_PARENT_LIFETIME}\nwhile (true) { exitIfOrphaned(); delay(0.05); }`
    const parentSrc = [
      "const { spawn } = require('child_process')",
      "const c = spawn('osascript', ['-l', 'JavaScript', '-e', process.env.GRAY_FIXTURE_LOOP], {",
      "  stdio: 'ignore', env: { ...process.env, GRAY_JXA_PARENT_PID: String(process.pid) } })",
      'process.stdout.write(String(c.pid) + "\\n")',
      'setInterval(() => {}, 1000)'
    ].join('\n')
    const parent = spawnChild(process.execPath, ['-e', parentSrc], {
      env: { ...process.env, GRAY_FIXTURE_LOOP: loop, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const childPid = await new Promise<number>((resolve, reject) => {
      parent.stdout!.once('data', (d) => resolve(Number(String(d).trim())))
      parent.once('exit', () => reject(new Error('fixture parent exited early')))
    })
    try {
      expect(childPid).toBeGreaterThan(0)
      await new Promise((r) => setTimeout(r, 800))
      expect(alive(childPid)).toBe(true)
      parent.kill('SIGKILL')
      await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5000, interval: 50 })
    } finally {
      if (alive(childPid)) process.kill(childPid, 'SIGKILL')
      if (parent.exitCode === null) parent.kill('SIGKILL')
    }
  }, 15_000)
})
