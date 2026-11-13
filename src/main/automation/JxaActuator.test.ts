import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { describe, expect, it, vi } from 'vitest'

/**
 * M9 — the real JxaActuator over its line protocol with a fake child: replies are written to a
 * fake stdout exactly as the JXA host prints them. No osascript, no Accessibility, no input.
 */
const h = vi.hoisted(() => ({ reply: (_cmd: Record<string, unknown>) => ({}) as Record<string, unknown> }))

vi.mock('electron', () => ({
  clipboard: { writeText: () => {} },
  systemPreferences: { isTrustedAccessibilityClient: () => true }
}))
vi.mock('child_process', () => ({
  spawn: () => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const cmd = JSON.parse(line)
        stdout.write(JSON.stringify({ id: cmd.id, ...h.reply(cmd) }) + '\n')
      }
    })
    return Object.assign(new EventEmitter(), { stdout, stdin, stderr: new PassThrough(), kill: () => {} })
  }
}))

const { JxaActuator } = await import('./JxaActuator')
const { JXA_ACTUATOR_SCRIPT } = await import('./jxaActuatorScript')

async function actuator(reply: (cmd: Record<string, unknown>) => Record<string, unknown>) {
  h.reply = (cmd) => (cmd.type === 'ping' ? { ok: true } : reply(cmd))
  const a = new JxaActuator()
  await a.start()
  return a
}

describe.runIf(process.platform === 'darwin')('JxaActuator protocol (M9)', () => {
  it('carries the live window frame from the host response, including negative origins', async () => {
    const a = await actuator(() => ({ ok: true, bounds: { x: -1440, y: -200, width: 800, height: 600 } }))
    expect(await a.windowBounds('Figma', null)).toEqual({
      ok: true,
      bounds: { x: -1440, y: -200, width: 800, height: 600 },
      error: undefined,
      matched: undefined,
      matchedLabel: undefined,
      matchedRole: undefined
    })
    a.stop()
  })

  it('drops a malformed or empty frame rather than passing it to the click resolver', async () => {
    for (const bounds of [{ x: 0, y: 0, width: 0, height: 600 }, { x: 'a', y: 0, width: 5, height: 5 }, null]) {
      const a = await actuator(() => ({ ok: true, bounds }))
      expect((await a.windowBounds('Figma', null)).bounds).toBeUndefined()
      a.stop()
    }
  })
})

/**
 * The actual host command handler (script text up to its stdin loop) over a synthetic System
 * Events: processes, windows and buttons are plain objects; AXPress is recorded, never sent.
 */
type Proc = { name: string; bundle: string; front?: boolean; focusThrows?: boolean; windows: string[]; menu?: boolean }
function host(procs: Proc[]) {
  const pressed: string[] = []
  const button = (owner: string) => ({
    attributes: { byName: (n: string) => (n === 'AXRole' ? { value: () => 'AXButton' } : n === 'AXTitle' ? { value: () => 'Share' } : null) },
    actions: { byName: () => ({ perform: () => pressed.push(owner) }) }
  })
  const win = (owner: string, title: string) => ({
    name: () => title,
    attributes: {
      byName: (n: string) =>
        n === 'AXPosition'
          ? { value: () => ({ x: 10, y: 20 }) }
          : n === 'AXSize'
            ? { value: () => ({ width: 300, height: 200 }) }
            : n === 'AXChildren'
              ? { value: () => [button(`${owner}:${title}`)] }
              : null
    }
  })
  const sysProcs = procs.map((p) => ({
    name: () => p.name,
    bundleIdentifier: () => p.bundle,
    frontmost: p.front ?? false,
    windows: () => p.windows.map((t) => win(p.name, t)),
    // A menu bar whose item matches the label too: pressed only if the menu bar is searched.
    menuBars: () => (p.menu ? [{ attributes: { byName: (n: string) => (n === 'AXChildren' ? { value: () => [button(`${p.name} menu`)] } : null) } }] : [])
  }))
  sysProcs.forEach((sp, i) => {
    Object.defineProperty(sp, 'frontmost', {
      get: () => procs[i].front ?? false,
      set: () => {
        if (procs[i].focusThrows) throw new Error('focus refused')
      }
    })
  })
  const se = { applicationProcesses: Object.assign(() => sysProcs, { whose: () => sysProcs.filter((_, i) => procs[i].front) }) }
  const $: any = new Proxy({}, { get: () => () => ({}) })
  const prefix = JXA_ACTUATOR_SCRIPT.slice(0, JXA_ACTUATOR_SCRIPT.indexOf('var stdin'))
  const handle = new Function('$', 'ObjC', 'Application', prefix + '; return handle;')($, { import: () => {} }, (n: string) => {
    if (n === 'System Events') return se
    throw new Error('no scripting bridge')
  })
  return { handle: handle as (cmd: Record<string, unknown>) => Record<string, unknown>, pressed }
}

describe('JXA actuator host handler (M9 R3/R4)', () => {
  const OTHER = { name: 'Notes', bundle: 'com.apple.Notes', front: true, windows: ['Other'] }

  it('pressElement never substitutes the front app for a missing named app', () => {
    const h = host([OTHER])
    const r = h.handle({ id: '1', type: 'pressElement', appName: 'Figma', appBundleId: 'com.figma.Desktop', elementRole: 'AXButton', elementLabel: 'Share' })
    expect(r).toMatchObject({ ok: false, error: 'app_not_found' })
    expect(h.pressed).toEqual([])
  })

  it('control: the named, focusable app is pressed', () => {
    const h = host([OTHER, { name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Fixture document'] }])
    const r = h.handle({ id: '0', type: 'pressElement', appName: 'Figma', appBundleId: 'com.figma.Desktop', elementRole: 'AXButton', elementLabel: 'Share' })
    expect(r).toMatchObject({ ok: true })
    expect(h.pressed).toEqual(['Figma:Fixture document'])
  })

  it('pressElement stops when the named app cannot be made frontmost', () => {
    const h = host([OTHER, { name: 'Figma', bundle: 'com.figma.Desktop', focusThrows: true, windows: ['Fixture document'] }])
    const r = h.handle({ id: '2', type: 'pressElement', appName: 'Figma', appBundleId: 'com.figma.Desktop', elementRole: 'AXButton', elementLabel: 'Share' })
    expect(r).toMatchObject({ ok: false, error: 'activate_failed' })
    expect(h.pressed).toEqual([])
  })

  const press = (h: ReturnType<typeof host>, windowTitle: string | null) =>
    h.handle({ id: 'p', type: 'pressElement', appName: 'Figma', appBundleId: 'com.figma.Desktop', elementRole: 'AXButton', elementLabel: 'Share', windowTitle })

  it('R4: a press for a recorded window that is absent presses nothing', () => {
    const h = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Other document'], menu: true }])
    expect(press(h, 'Recorded document')).toMatchObject({ ok: false, error: 'no_window' })
    expect(h.pressed).toEqual([])
  })

  it('R4: two windows with the recorded title are ambiguous: no bounds, no press', () => {
    const h = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Recorded document', 'Recorded document'] }])
    expect(h.handle({ id: 'w', type: 'windowBounds', appName: 'Figma', appBundleId: 'com.figma.Desktop', windowTitle: 'Recorded document' })).toMatchObject({
      ok: false,
      error: 'no_window'
    })
    expect(press(h, 'Recorded document')).toMatchObject({ ok: false, error: 'no_window' })
    expect(h.pressed).toEqual([])
  })

  it('R4: with the recorded window found, the press stays in it (menu bar not searched)', () => {
    const h = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Other document', 'Recorded document'], menu: true }])
    expect(press(h, 'Recorded document')).toMatchObject({ ok: true })
    expect(h.pressed).toEqual(['Figma:Recorded document'])
    // Without a recorded window the legacy order (menu bar first) is unchanged.
    const legacy = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Other document'], menu: true }])
    press(legacy, null)
    expect(legacy.pressed).toEqual(['Figma menu'])
  })

  it('windowBounds for a named window that is absent is no_window, not another window', () => {
    const h = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['Fixture document'] }])
    expect(h.handle({ id: '3', type: 'windowBounds', appName: 'Figma', appBundleId: 'com.figma.Desktop', windowTitle: 'Deleted document' })).toMatchObject({
      ok: false,
      error: 'no_window'
    })
    // Exact title only: a prefix, a superstring or an untitled window is not the recorded one.
    const near = host([{ name: 'Figma', bundle: 'com.figma.Desktop', windows: ['', 'Fixture document 2'] }])
    expect(near.handle({ id: '5', type: 'windowBounds', appName: 'Figma', appBundleId: 'com.figma.Desktop', windowTitle: 'Fixture document' })).toMatchObject({
      ok: false,
      error: 'no_window'
    })
    // Control: the named window that exists still resolves.
    expect(h.handle({ id: '4', type: 'windowBounds', appName: 'Figma', appBundleId: 'com.figma.Desktop', windowTitle: 'Fixture document' })).toMatchObject({
      ok: true,
      bounds: { x: 10, y: 20, width: 300, height: 200 }
    })
  })
})
