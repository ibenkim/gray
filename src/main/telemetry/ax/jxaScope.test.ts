import { describe, expect, it } from 'vitest'
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

function sensor(scope: unknown, front: App) {
  const env = {
    front,
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
    IsSecureEventInputEnabled: () => false,
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
      out[0] = name === 'AXRole' ? 'AXButton' : 'Synthetic label'
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
          // The loop runs `loopBudget` pumps, then the parent "exits" and the sensor stops.
          if (--env.loopBudget < 0) env.alive = false
        }
      }
    }
  }
  const $: any = new Proxy(function () {}, { get: (_t, p: string) => (p in known ? known[p] : deep), apply: () => deep })
  const ObjC = { import: () => {}, bindFunction: () => {}, unwrap: (v: unknown) => v }
  const Ref = () => [] as unknown[]
  /** System Events: process metadata is free; windows and attributes are content reads. */
  const element = (): any => ({
    attributes: {
      byName: (n: string) => {
        env.reads += 1
        if (n === 'AXParent' || n === 'AXSelectedRows' || n === 'AXSelectedChildren' || n === 'AXChildren') return null
        return { value: () => (n === 'AXRole' ? 'AXTextField' : n === 'AXValue' ? 'synthetic typed value' : 'Synthetic title') }
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
  try {
    new Function('$', 'ObjC', 'Ref', 'Application', JXA_SENSOR_SCRIPT)($, ObjC, Ref, Application)
  } catch (e) {
    if (!(e instanceof Exit)) throw e
  }
  env.alive = true
  const fire = (mask: number, evt: unknown) => env.handlers.filter((x) => x.mask & mask).forEach((x) => x.fn(evt))
  let charReads = 0
  return {
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
    }
  }
}

const CHROME: App = { name: 'Google Chrome', bundleId: 'com.google.Chrome' }
const ONE_APP_CHROME = { self: ['ghost', 'electron', 'yuh'], deny: ['1password', 'messages'], allow: ['google chrome', 'chrome', 'chromium'] }
const FULL_SCREEN = { self: ['ghost', 'electron', 'yuh'], deny: ['1password', 'messages'], allow: null }

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
    const full = exercise(FULL_SCREEN, { name: 'Figma', bundleId: 'com.figma.Desktop' })
    expect(full.kinds).toEqual(['ax', 'key', 'click', 'scroll'])
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

  it('host and sensor apply the same scope rule', async () => {
    const { appScope, appInScope } = await import('../providers')
    const table = ['Google Chrome', 'Chromium', 'Slack', '1Password 7', 'Messages', 'Electron', 'Figma', '']
    for (const opts of [
      { recordMode: 'one-app' as const, selectedAppId: 'chrome' },
      { recordMode: 'full-screen' as const },
      { recordMode: 'one-app' as const, selectedAppId: 'figma', ignoreAppNames: ['Gray'] }
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
