import { EventEmitter } from 'events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M1-HF3-B — the actual main wiring of the Record dropdown: src/main/index.ts is imported with
 * fake Electron and fake sibling modules, and the real windowTransitions controller, factory
 * and IPC relay run unmodified. Fails if production omits the factory, route or relay.
 * No app UI, capture or provider starts.
 */

const h = vi.hoisted(() => ({
  windows: [] as any[],
  ipc: new Map<string, (...a: any[]) => any>(),
  shortcuts: new Map<string, () => void>(),
  appHandlers: new Map<string, Array<(...a: any[]) => void>>(),
  tel: { active: false, teardownFailed: false }
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  class FakeWebContents extends EventEmitter {
    static seq = 0
    id = ++FakeWebContents.seq
    sent: Array<[string, unknown]> = []
    send(ch: string, payload?: unknown) {
      this.sent.push([ch, payload])
    }
    destroyed = false
    isDestroyed() {
      return this.destroyed
    }
    setWindowOpenHandler() {}
  }
  class BrowserWindow extends EventEmitter {
    opts: any
    bounds: { x: number; y: number; width: number; height: number }
    visible: boolean
    focused = false
    destroyed = false
    loaded: Array<{ kind: 'url' | 'file'; target: string; hash?: string }> = []
    pillCalls = 0
    private contents = new FakeWebContents()
    /** Like Electron: a destroyed window throws on webContents access. */
    get webContents() {
      if (this.destroyed) throw new TypeError('Object has been destroyed')
      return this.contents
    }
    constructor(opts: any = {}) {
      super()
      this.opts = opts
      this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 1, height: opts.height ?? 1 }
      this.visible = opts.show !== false
      h.windows.push(this)
    }
    getBounds() {
      return { ...this.bounds }
    }
    setBounds(b: any) {
      this.pillCalls++
      this.bounds = { ...b }
    }
    setPosition(x: number, y: number) {
      this.pillCalls++
      this.bounds = { ...this.bounds, x, y }
    }
    show() {
      this.visible = true
      this.focused = true
      this.emit('show')
      this.emit('focus')
    }
    hide() {
      this.visible = false
      this.emit('hide')
    }
    focus() {
      this.focused = true
      this.emit('focus')
    }
    blur() {
      this.focused = false
      this.emit('blur')
    }
    isVisible() {
      return this.visible
    }
    isFocused() {
      return this.focused
    }
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.contents.destroyed = true
      this.emit('closed')
    }
    loadURL(url: string) {
      this.loaded.push({ kind: 'url', target: url })
      return Promise.resolve()
    }
    loadFile(file: string, o?: { hash?: string }) {
      this.loaded.push({ kind: 'file', target: file, hash: o?.hash })
      return Promise.resolve()
    }
    setWindowButtonVisibility() {}
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop() {}
    moveTop() {}
    setOpacity() {}
    setIgnoreMouseEvents() {}
    static fromWebContents(wc: unknown) {
      return h.windows.find((w) => !w.destroyed && w.webContents === wc) ?? null
    }
    static getAllWindows() {
      return h.windows.filter((w) => !w.destroyed)
    }
  }
  const workArea = { x: 0, y: 34, width: 1512, height: 948 }
  return {
    app: {
      on: (ev: string, fn: (...a: any[]) => void) => {
        const list = h.appHandlers.get(ev) ?? []
        list.push(fn)
        h.appHandlers.set(ev, list)
      },
      whenReady: () => Promise.resolve(),
      requestSingleInstanceLock: () => true,
      setAsDefaultProtocolClient: () => true,
      quit: () => {},
      getPath: () => '/nonexistent-test-path',
      isPackaged: false
    },
    BrowserWindow,
    ipcMain: {
      handle: (ch: string, fn: (...a: any[]) => any) => h.ipc.set(ch, fn),
      on: (ch: string, fn: (...a: any[]) => any) => h.ipc.set(ch, fn)
    },
    screen: {
      getPrimaryDisplay: () => ({ workAreaSize: { width: 1512, height: 948 }, workArea, bounds: workArea }),
      getDisplayNearestPoint: () => ({ workArea }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 })
    },
    Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
    globalShortcut: {
      register: (acc: string, fn: () => void) => {
        h.shortcuts.set(acc, fn)
        return true
      },
      unregisterAll: () => h.shortcuts.clear()
    },
    shell: { openExternal: () => {} }
  }
})
vi.mock('dotenv', () => ({ config: () => ({}) }))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: () => {} },
  optimizer: { watchWindowShortcuts: () => {} },
  is: { dev: false }
}))
vi.mock('./store', () => ({
  getSnapshot: () => ({ onboardingComplete: true, onboardingStep: 'done', pillPosition: null, session: null }),
  getWorkflow: () => null,
  loadStore: () => {},
  registerStoreIpc: () => {},
  setLastPermissionRevokeAt: () => {},
  setOnboardingComplete: () => {},
  setOnboardingStep: () => {},
  setPillPosition: () => {},
  setSession: () => {},
  setTeam: () => {}
}))
vi.mock('./tray', () => ({ createTray: () => ({}), destroyTray: () => {}, setTrayMode: () => {}, setTrayRecording: () => {} }))
vi.mock('./permissions', () => ({
  getPermissions: () => ({ screen: 'granted', accessibility: 'granted', microphone: 'granted' }),
  registerPermissionIpc: () => {},
  setBeforeOpenSettings: () => {},
  startPermissionWatch: () => {},
  stopPermissionWatch: () => {}
}))
vi.mock('./auth', () => ({ googleAuth: async () => null, isValidEmail: () => true, sessionForEmail: () => null }))
vi.mock('./team', () => ({
  createTeam: () => null,
  inviteToTeam: () => null,
  isValidInviteCode: () => false,
  removeMember: () => null,
  renameTeam: () => null,
  resendInvite: () => null,
  revokeInvite: () => null,
  teamFromInvite: () => null
}))
vi.mock('./automation', () => ({ registerAutomationIpc: () => {}, stopActiveAutomationRun: () => {} }))
vi.mock('./telemetry', () => ({
  flushTelemetryOnQuit: async () => {},
  initTelemetry: async () => {},
  registerTelemetryIpc: () => {},
  hasActiveRecording: () => h.tel.active,
  stopActiveRecording: async () => {},
  getTelemetryRecorder: () => ({
    isNarrating: () => false,
    getRecordingStatus: () => ({ teardownFailed: h.tel.teardownFailed })
  }),
  onCaptureStatus: () => () => {}
}))

async function boot() {
  vi.resetModules()
  h.windows.length = 0
  h.ipc.clear()
  h.shortcuts.clear()
  h.appHandlers.clear()
  await import('./index')
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

const pill = () => h.windows[0]
const child = () => h.windows.filter((w) => w.opts?.webPreferences?.additionalArguments && !w.destroyed).at(-1) ?? null
const invoke = (ch: string, sender: unknown, ...args: unknown[]) => h.ipc.get(ch)!({ sender }, ...args)
const send = (ch: string, sender: unknown, ...args: unknown[]) => h.ipc.get(ch)!({ sender }, ...args)
const snapshot = {
  revision: 1,
  recordMode: 'one-app',
  selectedAppId: 'chrome',
  narrate: true,
  apps: [
    { id: 'chrome', name: 'Chrome', detail: 'synthetic' },
    { id: 'figma', name: 'Figma', detail: 'synthetic' }
  ],
  screenGranted: true,
  micGranted: true,
  busy: false
}
const sentTo = (win: any, ch: string) => win.webContents.sent.filter(([c]: [string]) => c === ch).map(([, p]: [string, unknown]) => p)

async function openReady() {
  const opening = invoke('dropdown:open', pill().webContents)
  const c = child()!
  send('dropdown:measured', c.webContents, 330)
  send('dropdown:ready', c.webContents)
  return { ack: await opening, c }
}

beforeEach(async () => {
  h.tel.active = false
  h.tel.teardownFailed = false
  await boot()
})

describe('actual main wiring of the Record dropdown', () => {
  it('registers the scoped relay and builds the child only on a pill open, with the restricted surface', async () => {
    for (const ch of ['dropdown:open', 'dropdown:close', 'dropdown:snapshot', 'dropdown:hello', 'dropdown:measured', 'dropdown:ready', 'dropdown:command', 'dropdown:dismiss', 'dropdown:dragStart', 'dropdown:dragEnd']) {
      expect(h.ipc.has(ch), ch).toBe(true)
    }
    expect(h.windows).toHaveLength(1) // only the pill: the dropdown is lazy
    const { ack, c } = await openReady()
    expect(ack).toMatchObject({ current: true, open: true, placement: 'above' })
    expect(c.opts.show).toBe(false)
    expect(c.opts.webPreferences).toMatchObject({ contextIsolation: true, additionalArguments: ['--gray-surface=record-dropdown'] })
    expect(c.opts.webPreferences.preload).toMatch(/preload[\\/]index\.js$/)
    expect(c.loaded).toEqual([expect.objectContaining({ kind: 'file', hash: 'record-dropdown' })])
    expect(c.visible).toBe(true)
    expect(pill().pillCalls).toBe(0) // the stationary pill was never moved or resized
    // Right-aligned, 8 px above the pill.
    expect(ack.bounds).toMatchObject({ width: 266, height: 330, x: pill().bounds.x + 94 - 266, y: pill().bounds.y - 8 - 330 })
  })

  it('refuses a foreign sender: nothing is created', async () => {
    const stranger = { id: 999 }
    const ack = await invoke('dropdown:open', stranger)
    expect(ack).toMatchObject({ current: false, open: false, error: 'no_owner' })
    expect(child()).toBeNull()
  })

  it('relays snapshots pill → child only, and commands child → pill once, exactly as allowed', async () => {
    const { c } = await openReady()
    send('dropdown:snapshot', pill().webContents, snapshot)
    expect(sentTo(c, 'dropdown:snapshot').at(-1)).toMatchObject({ selectedAppId: 'chrome', apps: snapshot.apps })
    send('dropdown:snapshot', c.webContents, { ...snapshot, selectedAppId: 'figma' })
    expect(sentTo(c, 'dropdown:snapshot').at(-1)).toMatchObject({ selectedAppId: 'chrome' })
    send('dropdown:hello', c.webContents)
    expect(sentTo(c, 'dropdown:snapshot')).toHaveLength(2)

    send('dropdown:command', c.webContents, { id: 'a-1', type: 'selectApp', value: 'figma' })
    send('dropdown:command', c.webContents, { id: 'a-1', type: 'selectApp', value: 'figma' }) // replay
    send('dropdown:command', c.webContents, { id: 'a-2', type: 'selectApp', value: 'not-offered' })
    send('dropdown:command', c.webContents, { id: 'a-3', type: 'setRecordMode', value: 'everything' })
    send('dropdown:command', c.webContents, { id: 'a-4', type: 'telemetryStart' })
    send('dropdown:command', c.webContents, { id: '../x', type: 'start' })
    send('dropdown:command', pill().webContents, { id: 'a-5', type: 'start' }) // wrong sender
    send('dropdown:command', c.webContents, { id: 'a-6', type: 'start' })
    send('dropdown:command', c.webContents, { id: 'a-6', type: 'start' }) // duplicate Start
    expect(sentTo(pill(), 'dropdown:command')).toEqual([
      { id: 'a-1', type: 'selectApp', value: 'figma' },
      { id: 'a-6', type: 'start' }
    ])
  })

  it('applies only valid measurements; dismiss and outside focus close the child and tell the pill', async () => {
    const { c } = await openReady()
    for (const bad of [NaN, 0, 5, 1e9, '300']) send('dropdown:measured', c.webContents, bad)
    expect(c.bounds.height).toBe(330)
    send('dropdown:measured', c.webContents, 400)
    expect(c.bounds.height).toBe(400)
    send('dropdown:dismiss', c.webContents)
    expect(c.visible).toBe(false)
    expect(sentTo(pill(), 'dropdown:closed').at(-1)).toMatchObject({ reason: 'request' })

    await openReady()
    c.blur()
    pill().focused = false
    await new Promise((r) => setTimeout(r, 120))
    expect(c.visible).toBe(false)
    expect(sentTo(pill(), 'dropdown:closed').at(-1)).toMatchObject({ reason: 'outside' })
    expect(pill().visible).toBe(true)
  })

  it('a child that fails to load is destroyed and the pill gets a settled failure; the retry builds one replacement', async () => {
    const opening = invoke('dropdown:open', pill().webContents)
    const first = child()!
    first.webContents.emit('did-fail-load')
    expect(await opening).toMatchObject({ open: false, error: 'load_failed' })
    expect(first.destroyed).toBe(true)
    const { ack, c } = await (async () => {
      const p = invoke('dropdown:open', pill().webContents)
      const c2 = h.windows.filter((w) => w.opts?.webPreferences?.additionalArguments).at(-1)
      send('dropdown:ready', c2.webContents)
      return { ack: await p, c: c2 }
    })()
    expect(ack.open).toBe(true)
    expect(c).not.toBe(first)
    expect(h.windows.filter((w) => w.opts?.webPreferences?.additionalArguments && !w.destroyed)).toHaveLength(1)
  })

  it('a crash after readiness closes only the child; hiding the pill closes the dropdown first', async () => {
    const { c } = await openReady()
    c.webContents.emit('render-process-gone')
    expect(c.destroyed).toBe(true)
    expect(sentTo(pill(), 'dropdown:closed').at(-1)).toMatchObject({ reason: 'child_closed' })
    expect(pill().destroyed).toBe(false)

    const again = await openReady()
    h.shortcuts.get('Alt+H')!()
    await new Promise((r) => setTimeout(r, 0))
    expect(again.c.visible).toBe(false)
    expect(pill().visible).toBe(false)
  })

  it('header drag runs on the pill gesture owner with the matching token only', async () => {
    const { c } = await openReady()
    expect(await invoke('dropdown:dragStart', pill().webContents)).toBeNull()
    const token = await invoke('dropdown:dragStart', c.webContents)
    expect(typeof token).toBe('number')
    expect(await invoke('dropdown:dragEnd', c.webContents, token + 1)).toBe(false)
    expect(await invoke('dropdown:dragEnd', c.webContents, token)).toBe(true)
    // Child blur also ends a gesture (no stuck poller).
    await invoke('dropdown:dragStart', c.webContents)
    c.emit('blur')
    expect(await invoke('dropdown:dragEnd', c.webContents, token)).toBe(false)
  })

  it('pill destruction destroys the child (owner disposal)', async () => {
    const { c } = await openReady()
    pill().destroy()
    expect(c.destroyed).toBe(true)
  })
})

// Keep EventEmitter referenced for the fake module factory's dynamic import.
void EventEmitter
