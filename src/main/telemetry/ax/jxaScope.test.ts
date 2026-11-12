import { describe, expect, it, vi } from 'vitest'
import { JXA_SENSOR_SCRIPT } from './jxaScript'

/**
 * M3-C — the actual sensor source runs in Node against a synthetic ObjC/AX bridge. Every
 * content read (AX attributes, System Events attributes, key characters) is counted; no
 * osascript, no monitor, no real input. Scope arrives as GRAY_JXA_SCOPE like at spawn.
 */

type App = { name: string | null; bundleId: string | null }
const PARENT = 4242
const MASK = { key: 1, left: 2, right: 4, scroll: 8 }
const CMD = 1 << 20

class Exit extends Error {}

type SecureOpts = {
  /** Focused / clicked element identity (both bridges); defaults keep earlier tests unchanged. */
  role?: string
  subrole?: string
  secureInput?: boolean
  /** IsSecureEventInputEnabled cannot be bound: the check is unavailable. */
  bindFails?: boolean
  /** Native AX lookup of this attribute fails (kAXErrorCannotComplete). */
  failAttr?: string
  /** The element provably has no subrole (kAXErrorNoValue), like most ordinary fields. */
  noSubrole?: boolean
  /** Native AX read succeeds but returns a value that cannot be converted to a string. */
  opaqueAttr?: string
}

function sensor(scope: unknown, front: App, steps: Array<(s: Sensor) => void> = [], opts: SecureOpts = {}) {
  const env = {
    /** AXValue reads through either bridge (content of a text field). */
    valueReads: 0,
    front,
    /** Pasteboard: changeCount is metadata; stringForType/types are content reads. */
    pb: 7,
    board: { text: 'synthetic pasteboard' as string | null, types: ['public.utf8-plain-text'] },
    pbReads: 0,
    onRead: null as null | (() => void),
    /** App owning the element under the pointer (null = unresolvable). */
    elementApp: null as string | null,
    alive: true,
    loopBudget: 1,
    reads: 0,
    lines: [] as Array<Record<string, any>>,
    handlers: [] as Array<{ mask: number; fn: (evt: unknown) => void }>
  }
  const deep: any = new Proxy(function () {}, { get: (_t, p) => (p === Symbol.toPrimitive ? () => 0 : deep), apply: () => deep })
  const objc = (v: string | null) => (v === null ? null : { js: v })
  const known: Record<string, unknown> = {
    getenv: (k: string) => (k === 'GRAY_JXA_PARENT_PID' ? String(PARENT) : k === 'GRAY_JXA_SCOPE' && scope !== undefined ? JSON.stringify(scope) : undefined),
    getppid: () => (env.alive ? PARENT : 1),
    exit: () => {
      throw new Exit()
    },
    NSFileHandle: { fileHandleWithStandardOutput: { writeData: (t: string) => env.lines.push(JSON.parse(t)) } },
    NSString: { alloc: { initWithUTF8String: (t: string) => ({ dataUsingEncoding: () => t.trim() }) } },
    IsSecureEventInputEnabled: () => opts.secureInput === true,
    NSPasteboardTypeString: 'public.utf8-plain-text',
    NSPasteboard: {
      generalPasteboard: {
        get changeCount() {
          return env.pb
        },
        stringForType: () => {
          env.pbReads += 1
          env.onRead?.()
          return env.board.text === null ? null : { js: env.board.text }
        },
        get types() {
          env.pbReads += 1
          return { count: env.board.types.length, objectAtIndex: (i: number) => ({ js: env.board.types[i] }) }
        }
      }
    },
    NSWorkspace: {
      sharedWorkspace: {
        get frontmostApplication() {
          return env.front.name || env.front.bundleId
            ? { localizedName: objc(env.front.name), bundleIdentifier: objc(env.front.bundleId) }
            : null
        }
      }
    },
    AXUIElementCreateSystemWide: () => ({ sys: true }),
    CFStringCreateWithCString: (_a: unknown, t: string) => t,
    AXUIElementCopyElementAtPosition: (_s: unknown, _x: number, _y: number, out: unknown[]) => {
      out[0] = { el: true }
      return 0
    },
    AXUIElementGetPid: (_el: unknown, out: unknown[]) => {
      if (env.elementApp === null) return -1
      out[0] = 99
      return 0
    },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: () => ({ localizedName: objc(env.elementApp) }) },
    AXUIElementCopyAttributeValue: (_el: unknown, name: string, out: unknown[]) => {
      env.reads += 1
      if (name === 'AXParent' || name === 'AXFrame' || name === 'AXEnabled') return -1
      if (name === opts.failAttr) return -25204
      if (name === opts.opaqueAttr) {
        out[0] = {}
        return 0
      }
      if (name === 'AXSubrole' && opts.noSubrole) return -25212
      if (name === 'AXValue') env.valueReads += 1
      if (name === 'AXSubrole' && opts.subrole) out[0] = opts.subrole
      else out[0] = name === 'AXRole' ? (opts.role ?? 'AXButton') : 'Synthetic label'
      return 0
    },
    NSEvent: {
      addGlobalMonitorForEventsMatchingMaskHandler: (mask: number, fn: (evt: unknown) => void) => {
        env.handlers.push({ mask, fn })
        return { token: true }
      },
      pressedMouseButtons: 0
    },
    NSEventMaskKeyDown: MASK.key,
    NSEventMaskLeftMouseDown: MASK.left,
    NSEventMaskRightMouseDown: MASK.right,
    NSEventMaskScrollWheel: MASK.scroll,
    NSEventModifierFlagCommand: CMD,
    NSEventModifierFlagOption: 1 << 19,
    NSEventModifierFlagControl: 1 << 18,
    NSEventModifierFlagShift: 1 << 17,
    NSEventTypeRightMouseDown: 3,
    AXIsProcessTrusted: () => true,
    CGEventGetLocation: () => ({ x: 10, y: 20 }),
    NSRunLoop: {
      currentRunLoop: {
        runUntilDate: () => {
          // Scripted steps run one per pump; then `loopBudget` pumps, then the parent "exits".
          const step = steps.shift()
          if (step) step(api)
          else if (--env.loopBudget < 0) env.alive = false
        }
      }
    }
  }
  const $: any = new Proxy(function () {}, { get: (_t, p: string) => (p in known ? known[p] : deep), apply: () => deep })
  const ObjC = {
    import: () => {},
    bindFunction: () => {
      if (opts.bindFails) throw new Error('unavailable')
    },
    unwrap: (v: unknown) => v
  }
  const Ref = () => [] as unknown[]
  /** System Events: process metadata is free; windows and attributes are content reads. */
  const element = (): any => ({
    attributes: {
      byName: (n: string) => {
        env.reads += 1
        if (n === 'AXParent' || n === 'AXSelectedRows' || n === 'AXSelectedChildren' || n === 'AXChildren') return null
        if (n === 'AXValue') env.valueReads += 1
        if (n === 'AXSubrole' && opts.subrole) return { value: () => opts.subrole }
        return { value: () => (n === 'AXRole' ? (opts.role ?? 'AXTextField') : n === 'AXValue' ? 'synthetic typed value' : 'Synthetic title') }
      }
    }
  })
  const Application = () => ({
    applicationProcesses: {
      whose: () => [
        {
          name: () => env.front.name,
          bundleIdentifier: () => env.front.bundleId,
          windows: () => {
            env.reads += 1
            return [element()]
          },
          attributes: {
            byName: (n: string) => {
              env.reads += 1
              return n === 'AXFocusedUIElement' ? { value: () => element() } : null
            }
          }
        }
      ]
    }
  })
  const fire = (mask: number, evt: unknown) => env.handlers.filter((x) => x.mask & mask).forEach((x) => x.fn(evt))
  let charReads = 0
  const api = {
    env,
    get charReads() {
      return charReads
    },
    key(cmd = false) {
      fire(MASK.key, {
        keyCode: 8,
        modifierFlags: cmd ? CMD : 0,
        isARepeat: false,
        get characters() {
          charReads += 1
          return { js: 'c' }
        },
        get charactersIgnoringModifiers() {
          charReads += 1
          return { js: 'c' }
        }
      })
    },
    click() {
      fire(MASK.left, { type: 1, clickCount: 1, modifierFlags: 0, CGEvent: {} })
    },
    scroll() {
      fire(MASK.scroll, { scrollingDeltaX: 0, scrollingDeltaY: 3, CGEvent: {} })
    },
    /** Cmd+C (keyCode 8) or Cmd+X (7) in the front app. */
    copy(cut = false) {
      fire(MASK.key, {
        keyCode: cut ? 7 : 8,
        modifierFlags: CMD,
        isARepeat: false,
        characters: { js: cut ? 'x' : 'c' },
        charactersIgnoringModifiers: { js: cut ? 'x' : 'c' }
      })
    },
    copies() {
      return env.lines.filter((l) => l.k === 'copy')
    }
  }
  try {
    new Function('$', 'ObjC', 'Ref', 'Application', JXA_SENSOR_SCRIPT)($, ObjC, Ref, Application)
  } catch (e) {
    if (!(e instanceof Exit)) throw e
  }
  env.alive = true
  return api
}
type Sensor = ReturnType<typeof sensor>

const CHROME: App = { name: 'Google Chrome', bundleId: 'com.google.Chrome' }
const ONE_APP_CHROME = { self: ['gray', 'electron'], deny: ['1password', 'messages'], allow: ['google chrome', 'chrome', 'chromium'] }
const FULL_SCREEN = { self: ['gray', 'electron'], deny: ['1password', 'messages'], allow: null }

/** One sample, one key, one click, one scroll in the front app; what the sensor read and emitted. */
function exercise(scope: unknown, front: App, elementApp: string | null = null) {
  const s = sensor(scope, front)
  s.env.elementApp = elementApp
  s.key()
  s.click()
  s.scroll()
  return { reads: s.env.reads + s.charReads, kinds: s.env.lines.map((l) => l.k).filter((k) => k !== 'ready' && k !== 'stats') }
}

describe('M3-C sensor scope (actual JXA sensor source, synthetic bridge)', () => {
  it('reads and emits nothing for an excluded, unknown or unscoped app', () => {
    const measured = {
      outOfScope: exercise(ONE_APP_CHROME, { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }),
      denylisted: exercise(FULL_SCREEN, { name: '1Password 7', bundleId: 'com.agilebits.onepassword7' }),
      self: exercise(FULL_SCREEN, { name: 'Electron', bundleId: 'com.github.Electron' }),
      unknown: exercise(FULL_SCREEN, { name: null, bundleId: null }),
      noPolicy: exercise(undefined, CHROME),
      // Front app in scope, but the pointer is over another (excluded) app's window.
      backgroundWindow: exercise(ONE_APP_CHROME, CHROME, 'Slack')
    }
    console.log('M3C-MEASURE ' + JSON.stringify(measured))
    expect(measured.outOfScope).toEqual({ reads: 0, kinds: [] })
    expect(measured.denylisted).toEqual({ reads: 0, kinds: [] })
    expect(measured.self).toEqual({ reads: 0, kinds: [] })
    expect(measured.unknown).toEqual({ reads: 0, kinds: [] })
    expect(measured.noPolicy).toEqual({ reads: 0, kinds: [] })
    // The sample and key are Chrome's (in scope); the click/scroll over Slack read nothing.
    expect(measured.backgroundWindow.kinds).toEqual(['ax', 'key'])
  })

  it('an in-scope app is still observed (non-hollow)', () => {
    const r = exercise(ONE_APP_CHROME, CHROME, 'Google Chrome')
    expect(r.kinds).toEqual(['ax', 'key', 'click', 'scroll'])
    expect(r.reads).toBeGreaterThan(5)
    const full = exercise(FULL_SCREEN, { name: 'Figma', bundleId: 'com.figma.Desktop' }, 'Figma')
    expect(full.kinds).toEqual(['ax', 'key', 'click', 'scroll'])
  })

  it('an unresolvable pointer owner is unknown and denied (R2)', () => {
    const known = exercise(ONE_APP_CHROME, CHROME, 'Google Chrome')
    const unknown = exercise(ONE_APP_CHROME, CHROME, null)
    const keyOnly = exercise(ONE_APP_CHROME, CHROME, 'Slack')
    expect(unknown.kinds).toEqual(['ax', 'key'])
    // Same reads as a pointer over an excluded app: the sample and key only, no element content.
    expect(unknown.reads).toBe(keyOnly.reads)
    expect(known.reads).toBeGreaterThan(unknown.reads)
  })

  it('switching away mid-entry stops reads', () => {
    const s = sensor(ONE_APP_CHROME, CHROME)
    s.key()
    const inChrome = s.env.lines.filter((l) => l.k === 'key').length
    s.env.front = { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }
    const r0 = s.env.reads + s.charReads
    s.key()
    s.key(true)
    s.click()
    expect(s.env.reads + s.charReads - r0).toBe(0)
    expect(s.env.lines.filter((l) => l.k === 'key').length).toBe(inChrome)
    expect(s.env.lines.some((l) => l.app === 'Slack' || l.appName === 'Slack')).toBe(false)
  })

  it('Select apps with several apps reads exactly those apps (multi-select)', async () => {
    const { appScope, appInScope } = await import('../providers')
    const scope = appScope({ recordMode: 'one-app', selectedAppId: 'chrome', selectedAppIds: ['chrome', 'figma'] })
    expect(appInScope(scope, 'Google Chrome')).toBe(true)
    expect(appInScope(scope, 'Figma')).toBe(true)
    expect(appInScope(scope, 'Slack')).toBe(false)
    expect(appInScope(scope, 'Messages')).toBe(false)
    // Full screen ignores any app choice; denied and own apps stay out either way.
    const full = appScope({ recordMode: 'full-screen', selectedAppIds: ['chrome'] })
    expect(full.allow).toBeNull()
    expect(appInScope(full, '1Password 7')).toBe(false)
    const s = sensor(scope, { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' })
    s.key()
    expect(s.env.lines.some((l) => l.k === 'key')).toBe(false)
  })

  it('host and sensor apply the same scope rule', async () => {
    const { appScope, appInScope } = await import('../providers')
    const table = ['Google Chrome', 'Chromium', 'Slack', '1Password 7', 'Messages', 'Electron', 'Figma', '']
    for (const opts of [
      { recordMode: 'one-app' as const, selectedAppId: 'chrome' },
      { recordMode: 'full-screen' as const },
      { recordMode: 'one-app' as const, selectedAppId: 'figma', ignoreAppNames: ['Gray'] },
      { recordMode: 'one-app' as const, selectedAppId: 'chrome', selectedAppIds: ['chrome', 'figma'] }
    ]) {
      const scope = appScope(opts)
      for (const name of table) {
        const s = sensor(scope, { name: name || null, bundleId: null })
        s.key()
        const sensorAllows = s.env.lines.some((l) => l.k === 'key')
        expect([opts, name, sensorAllows]).toEqual([opts, name, appInScope(scope, name || undefined)])
      }
    }
  })
})

describe('M3-B copy provenance (actual JXA sensor source, synthetic pasteboard)', () => {
  const write = (text: string) => (x: Sensor) => {
    x.env.pb += 1
    x.env.board.text = text
  }

  it('reads the pasteboard once after one change by the in-scope chord app', () => {
    const s = sensor(ONE_APP_CHROME, CHROME, [(x) => x.copy(), write('synthetic chrome copy'), (x) => x.copy(true), write('synthetic chrome cut')])
    expect(s.copies().map((l) => [l.app, l.text, l.pb])).toEqual([
      ['Google Chrome', 'synthetic chrome copy', 8],
      ['Google Chrome', 'synthetic chrome cut', 9]
    ])
    expect(s.env.pbReads).toBe(4) // string + types, once per verified copy
    expect(s.env.lines.filter((l) => l.k === 'key').every((l) => typeof l.pb === 'number')).toBe(true)
  })

  it('discards copies whose source is not established (R1)', () => {
    const slack = { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }
    const cases = {
      // Cmd+C in Chrome, then excluded Slack replaces the clipboard before the change is seen.
      switchedThenWritten: sensor(ONE_APP_CHROME, CHROME, [(x) => x.copy(), (x) => { x.env.front = slack }, write('synthetic excluded Slack copy')]),
      // Two writers before the check: provenance unknown.
      twoChanges: sensor(FULL_SCREEN, CHROME, [(x) => x.copy(), (x) => { x.env.pb += 2; x.env.board.text = 'synthetic figma copy' }]),
      // The clipboard changes while it is being read.
      changedDuringRead: sensor(ONE_APP_CHROME, CHROME, [(x) => { x.env.onRead = () => { x.env.pb += 1 } ; x.copy() }, write('synthetic racing copy')]),
      // Copy in an out-of-scope app: no pending copy at all.
      outOfScope: sensor(ONE_APP_CHROME, slack, [(x) => x.copy(), write('synthetic slack copy')])
    }
    for (const [name, s] of Object.entries(cases)) expect([name, s.copies()]).toEqual([name, []])
    expect(cases.switchedThenWritten.env.pbReads).toBe(0)
    expect(cases.twoChanges.env.pbReads).toBe(0)
    expect(cases.outOfScope.env.pbReads).toBe(0)
  })

  it('leaving the chord app, even for one pump, cancels the pending copy (re-review R1)', () => {
    const slack = { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' }
    const s = sensor(ONE_APP_CHROME, CHROME, [
      (x) => x.copy(), // no selection: unchanged count
      (x) => { x.env.front = slack }, // an excluded app is observed in front
      (x) => { x.env.pb += 1; x.env.board.text = 'synthetic excluded Slack copy' },
      (x) => { x.env.front = CHROME } // back in Chrome before the change is checked again
    ])
    expect(s.copies()).toEqual([])
    expect(s.env.pbReads).toBe(0)
  })

  it('a change first seen after the settle window is not attributed (re-review R1)', () => {
    let now = 1_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const s = sensor(ONE_APP_CHROME, CHROME, [
        (x) => x.copy(),
        (x) => { now += 600; x.env.pb += 1; x.env.board.text = 'synthetic late write' }
      ])
      expect(s.copies()).toEqual([])
      expect(s.env.pbReads).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('a no-op copy never reports pre-existing or later content (R1)', () => {
    let now = 1_000_000
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const s = sensor(ONE_APP_CHROME, CHROME, [
        (x) => x.copy(), // nothing selected: the pasteboard does not change
        () => { now += 600 }, // settle window passes
        () => {},
        write('synthetic later background write')
      ])
      expect(s.copies()).toEqual([])
      expect(s.env.pbReads).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('M8-A secure fields (actual JXA sensor source, synthetic bridge)', () => {
  /** A sample, a key and a click on the focused element; what was read and emitted. */
  function secureRun(opts: SecureOpts) {
    const s = sensor(FULL_SCREEN, CHROME, [], opts)
    s.env.elementApp = 'Google Chrome'
    s.key()
    s.click()
    const line = (k: string) => s.env.lines.find((l) => l.k === k)!
    return { s, ax: line('ax'), key: line('key'), click: line('click') }
  }

  it.each([
    ['secure subrole on an ordinary text field', { role: 'AXTextField', subrole: 'AXSecureTextField' }],
    ['secure role', { role: 'AXSecureTextField' }],
    ['global secure input', { secureInput: true }],
    ['unavailable secure-input check (fails closed)', { bindFails: true }],
    ['focused element lookup fails', { role: 'AXTextField', failAttr: 'AXFocusedUIElement' }],
    ['role lookup fails', { role: 'AXTextField', failAttr: 'AXRole' }],
    ['subrole lookup fails', { role: 'AXTextField', failAttr: 'AXSubrole' }],
    ['role read succeeds but cannot be converted', { role: 'AXTextField', opaqueAttr: 'AXRole' }],
    ['subrole read succeeds but cannot be converted', { role: 'AXTextField', opaqueAttr: 'AXSubrole' }]
  ] as Array<[string, SecureOpts]>)('%s: no value, length, tail or key characters are read', (_name, opts) => {
    const { s, ax, key, click } = secureRun(opts)
    expect(s.charReads).toBe(0)
    expect(ax).toMatchObject({ secure: true, valueLength: null, valueTail: null })
    expect(key).toMatchObject({ secure: true, chars: null, base: null })
    if (opts.failAttr === 'AXFocusedUIElement') {
      // Only focus is unknown; the clicked element's own role/subrole prove it ordinary.
      expect(s.env.valueReads).toBe(1)
    } else {
      expect(s.env.valueReads).toBe(0)
      expect(click.valueLength).toBeNull()
    }
  })

  it.each([
    ['with a subrole', {}],
    ['with no subrole (provably absent)', { noSubrole: true }]
  ])('an ordinary text field %s is still read (non-hollow)', (_n, extra) => {
    const { s, ax, key } = secureRun({ role: 'AXTextField', ...extra })
    expect(s.env.valueReads).toBeGreaterThan(0)
    expect(ax).toMatchObject({ secure: false, valueTail: 'synthetic typed value' })
    expect(key).toMatchObject({ secure: false, chars: 'c' })
  })
})
