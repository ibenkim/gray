import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M2-R2 — the actual application lifecycle hooks in src/main/index.ts (before-quit, hide,
 * logout, permission revocation, focus loss, tray), driven through fake Electron and module
 * boundaries installed before the entry is imported. The telemetry barrier itself is a
 * controllable fake here; its behavior is covered by lifecycle.test.ts. No app UI starts.
 */

type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void }
function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const h = vi.hoisted(() => {
  /** A permissive stand-in: any property is a callable that records and returns the stub. */
  const calls: string[] = []
  function stub(name: string, overrides: Record<string, unknown> = {}): any {
    const target: Record<string, unknown> = { ...overrides }
    return new Proxy(target, {
      get(t, key) {
        if (typeof key === 'symbol') return undefined
        if (key in t) return t[key as string]
        if (key === 'then') return undefined
        const fn = (...args: unknown[]) => {
          calls.push(`${name}.${key}`)
          return key.startsWith('is') ? false : key.startsWith('get') ? stub(`${name}.${key}()`) : fn
        }
        return fn
      }
    })
  }
  return {
    stub,
    calls,
    appHandlers: new Map<string, Array<(...a: any[]) => void>>(),
    ipc: new Map<string, (...a: any[]) => unknown>(),
    shortcuts: new Map<string, () => void>(),
    quit: 0,
    windows: [] as any[],
    permissionChange: null as null | ((prev: unknown, next: unknown) => void),
    focusHook: null as null | ((focused: boolean) => void),
    captureStatus: null as null | ((s: unknown) => void),
    trayRecording: [] as string[],
    tel: {
      active: false,
      narrating: false,
      teardownFailed: false,
      stopCalls: [] as string[],
      stop: (_reason: string): Promise<void> => Promise.resolve()
    }
  }
})

vi.mock('electron', () => {
  class BrowserWindow {
    visible = true
    hidden = 0
    destroyed = false
    webContents = h.stub('webContents')
    constructor() {
      h.windows.push(this)
      return new Proxy(this, {
        get(t, key) {
          if (key in t) return (t as any)[key]
          return h.stub('window')[key as string]
        }
      })
    }
    isVisible() {
      return this.visible
    }
    hide() {
      this.hidden += 1
      this.visible = false
    }
    show() {
      this.visible = true
    }
    destroy() {
      this.destroyed = true
    }
    isDestroyed() {
      return this.destroyed
    }
    static fromWebContents() {
      return null
    }
    static getAllWindows() {
      return []
    }
  }
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
      quit: () => {
        h.quit += 1
      },
      getPath: () => '/nonexistent-test-path',
      isPackaged: false
    },
    BrowserWindow,
    ipcMain: {
      handle: (ch: string, fn: (...a: any[]) => unknown) => h.ipc.set(ch, fn),
      on: (ch: string, fn: (...a: any[]) => unknown) => h.ipc.set(ch, fn)
    },
    screen: {
      getPrimaryDisplay: () => ({
        workAreaSize: { width: 1440, height: 900 },
        workArea: { x: 0, y: 0, width: 1440, height: 900 },
        bounds: { x: 0, y: 0, width: 1440, height: 900 }
      })
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
vi.mock('../store', () => ({
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
vi.mock('../tray', () => ({
  createTray: () => ({}),
  destroyTray: () => {},
  setTrayMode: () => {},
  setTrayRecording: (phase: string) => h.trayRecording.push(phase)
}))
vi.mock('../permissions', () => ({
  getPermissions: () => ({ screen: 'granted', accessibility: 'granted', microphone: 'granted' }),
  registerPermissionIpc: () => {},
  setBeforeOpenSettings: () => {},
  startPermissionWatch: (cb: (prev: unknown, next: unknown) => void) => {
    h.permissionChange = cb
  },
  stopPermissionWatch: () => {}
}))
vi.mock('../auth', () => ({ googleAuth: async () => null, isValidEmail: () => true, sessionForEmail: () => null }))
vi.mock('../team', () => ({
  createTeam: () => null,
  inviteToTeam: () => null,
  isValidInviteCode: () => false,
  removeMember: () => null,
  renameTeam: () => null,
  resendInvite: () => null,
  revokeInvite: () => null,
  teamFromInvite: () => null
}))
vi.mock('../windowTransitions', () => ({
  PILL_H: 24,
  PILL_W: 94,
  PILL_WINDOW_OPTIONS: {},
  RECORD_DROPDOWN_HASH: 'record-dropdown',
  registerTransitionIpc: () => {},
  // HF3-B: the real dropdown wiring is covered by src/main/recordDropdown.test.ts.
  createRecordDropdownWiring: () => ({ create: () => null, notifyClosed: () => {} }),
  createWindowTransitions: () =>
    h.stub('transitions', {
      attachPill: (_win: unknown, hooks: { onFocusChange?: (f: boolean) => void }) => {
        h.focusHook = hooks.onFocusChange ?? null
      }
    })
}))
vi.mock('../automation', () => ({ registerAutomationIpc: () => {}, stopActiveAutomationRun: () => {} }))
vi.mock('./index', () => ({
  flushTelemetryOnQuit: async () => {},
  initTelemetry: async () => {},
  registerTelemetryIpc: () => {},
  hasActiveRecording: () => h.tel.active,
  stopActiveRecording: (reason: string) => {
    h.tel.stopCalls.push(reason)
    return h.tel.stop(reason)
  },
  getTelemetryRecorder: () => ({
    isNarrating: () => h.tel.narrating,
    getRecordingStatus: () => ({ teardownFailed: h.tel.teardownFailed }),
    onStatus: () => () => {}
  }),
  onCaptureStatus: (cb: (s: unknown) => void) => {
    h.captureStatus = cb
    return () => {}
  }
}))

async function boot() {
  vi.resetModules()
  h.appHandlers.clear()
  h.ipc.clear()
  h.shortcuts.clear()
  h.windows.length = 0
  h.quit = 0
  h.trayRecording.length = 0
  h.permissionChange = null
  h.focusHook = null
  Object.assign(h.tel, { active: false, narrating: false, teardownFailed: false, stopCalls: [], stop: () => Promise.resolve() })
  await import('../index')
  // whenReady resolved: let the startup chain (telemetry init, tray, pill, shortcuts) run.
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

function beforeQuit() {
  const event = { prevented: 0, preventDefault() { this.prevented += 1 } }
  for (const fn of h.appHandlers.get('before-quit') ?? []) fn(event)
  return event
}

const pill = () => h.windows[0]
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  await boot()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('before-quit hook', () => {
  it('holds the first quit, awaits the barrier, holds every repeated quit, then re-enters quit exactly once', async () => {
    const barrier = deferred()
    h.tel.active = true
    h.tel.stop = () => barrier.promise
    const first = beforeQuit()
    expect(first.prevented).toBe(1)
    expect(h.tel.stopCalls).toEqual(['quit'])
    // Repeated quits while the barrier runs never bypass it, even if the predicate flips.
    h.tel.active = false
    expect(beforeQuit().prevented).toBe(1)
    expect(beforeQuit().prevented).toBe(1)
    expect(h.tel.stopCalls).toEqual(['quit'])
    await flush()
    expect(h.quit).toBe(0)
    barrier.resolve()
    await flush()
    await flush()
    expect(h.quit).toBe(1)
    // The re-entered quit proceeds.
    expect(beforeQuit().prevented).toBe(0)
  })

  it('waits while only an unfinished save is pending (recorder idle) and is a no-op when nothing is pending', async () => {
    h.tel.active = false
    expect(beforeQuit().prevented).toBe(0)
    expect(h.tel.stopCalls).toEqual([])
    await boot()
    h.tel.active = true // e.g. phase idle but the durable save outcome is still pending
    const barrier = deferred()
    h.tel.stop = () => barrier.promise
    expect(beforeQuit().prevented).toBe(1)
    barrier.resolve()
    await flush()
    await flush()
    expect(h.quit).toBe(1)
  })

  it('a barrier rejection still quits exactly once', async () => {
    h.tel.active = true
    h.tel.stop = () => Promise.reject(new Error('synthetic save failure'))
    beforeQuit()
    await flush()
    await flush()
    expect(h.quit).toBe(1)
  })

  it('a stuck barrier quits at the 10 s deadline (repeats held meanwhile) with the timer cleared', async () => {
    vi.useFakeTimers()
    h.tel.active = true
    h.tel.stop = () => new Promise(() => {})
    beforeQuit()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(h.quit).toBe(0)
    expect(beforeQuit().prevented).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.quit).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('hide, logout, permission and focus hooks', () => {
  it('Alt+H hides only after the stop/save barrier resolves', async () => {
    const barrier = deferred()
    h.tel.active = true
    h.tel.stop = () => barrier.promise
    h.shortcuts.get('Alt+H')!()
    await flush()
    expect(h.tel.stopCalls).toEqual(['hide'])
    expect(pill().hidden).toBe(0)
    barrier.resolve()
    await flush()
    expect(pill().hidden).toBe(1)
  })

  it('Alt+H keeps the indicator visible when a source did not confirm shutdown', async () => {
    h.tel.active = true
    h.tel.teardownFailed = true
    h.shortcuts.get('Alt+H')!()
    await flush()
    await flush()
    expect(h.tel.stopCalls).toEqual(['hide'])
    expect(pill().hidden).toBe(0)
  })

  it('logout awaits the barrier before tearing down the pill', async () => {
    const barrier = deferred()
    h.tel.active = true
    h.tel.stop = () => barrier.promise
    const done = Promise.resolve(h.ipc.get('auth:logout')!({}))
    await flush()
    expect(h.tel.stopCalls).toEqual(['logout'])
    expect(pill().destroyed).toBe(false)
    barrier.resolve()
    await done
    expect(pill().destroyed).toBe(true)
  })

  it.each([true, false])('logout retains the indicator after failed teardown (active=%s)', async (active) => {
    h.tel.active = active
    h.tel.teardownFailed = true
    const indicator = pill()
    await h.ipc.get('auth:logout')!({})
    expect(h.tel.stopCalls).toEqual(['logout'])
    expect(indicator.destroyed).toBe(false)
    expect(indicator.visible).toBe(true)
    expect(h.windows).toHaveLength(1) // no onboarding/auth transition
  })

  it('revoking a used permission runs the barrier; microphone only while narrating', async () => {
    h.tel.active = true
    const granted = { screen: 'granted', accessibility: 'granted', microphone: 'granted' }
    h.permissionChange!(granted, { ...granted, microphone: 'denied' })
    expect(h.tel.stopCalls).toEqual([])
    h.tel.narrating = true
    h.permissionChange!(granted, { ...granted, microphone: 'denied' })
    h.permissionChange!(granted, { ...granted, accessibility: 'denied' })
    h.permissionChange!(granted, { ...granted, screen: 'denied' })
    expect(h.tel.stopCalls).toEqual(['permission_revoked', 'permission_revoked', 'permission_revoked'])
    h.tel.active = false
    h.permissionChange!(granted, { ...granted, screen: 'denied' })
    expect(h.tel.stopCalls).toHaveLength(3)
  })

  it('ordinary focus loss of the pill never stops a visible recording', async () => {
    h.tel.active = true
    h.focusHook!(false)
    h.focusHook!(true)
    h.focusHook!(false)
    await flush()
    expect(h.tel.stopCalls).toEqual([])
    expect(pill().hidden).toBe(0)
  })

  it('the tray shows Saving while only the durable save is pending, and a teardown failure', async () => {
    h.captureStatus!({ phase: 'recording', saving: false, starting: false, teardownFailed: false })
    h.captureStatus!({ phase: 'idle', saving: true, starting: false, teardownFailed: false })
    h.captureStatus!({ phase: 'idle', saving: false, starting: true, teardownFailed: false })
    h.captureStatus!({ phase: 'idle', saving: false, starting: false, teardownFailed: true })
    h.captureStatus!({ phase: 'idle', saving: false, starting: false, teardownFailed: false })
    expect(h.trayRecording).toEqual(['recording', 'stopping', 'starting', 'teardown_failed', 'idle'])
  })
})
