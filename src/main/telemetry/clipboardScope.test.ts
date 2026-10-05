import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M3-B — clipboard scope on the actual production composition: real initTelemetry,
 * TelemetryRecorder, ClipboardWatcher and FileTelemetryStore. Fakes only at the native
 * boundary: Electron's clipboard (every read counted), active-window reads and the
 * accessibility child (the test emits its chords). All content is synthetic; network denied.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  devDir: '',
  clip: { text: '', reads: 0 },
  ix: { cb: null as null | ((p: unknown) => void) }
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.devDir },
  BrowserWindow: {
    getAllWindows: () => [],
    fromWebContents: (wc: { trusted?: boolean } | undefined) => (wc?.trusted ? {} : null)
  },
  ipcMain: { handle: (c: string, fn: (...a: unknown[]) => unknown) => h.handlers.set(c, fn) },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1, size: { width: 1000, height: 800 }, workAreaSize: { width: 1000, height: 780 } })
  },
  clipboard: {
    readText: () => {
      h.clip.reads += 1
      return h.clip.text
    },
    availableFormats: () => (h.clip.text ? ['text/plain'] : [])
  },
  globalShortcut: { register: () => true, unregister: () => {} }
}))
vi.mock('active-win', () => ({
  default: async () => ({ title: 'Synthetic page', owner: { name: 'Google Chrome', processId: 4242 }, bounds: { x: 0, y: 0, width: 800, height: 600 } })
}))
vi.mock('openai', () => ({ default: class {}, OpenAI: class {}, toFile: async () => ({}) }))
vi.mock('../store', () => ({ getSnapshot: () => ({ session: null }) }))
vi.mock('./config', () => ({
  loadTelemetryConfig: () => ({ storage: 'file', devDir: h.devDir, openaiApiKey: null, openaiModel: 'test-model', isDev: true, isPackaged: false })
}))
vi.mock('./ax/JxaAccessibilityProvider', () => ({
  JxaAccessibilityProvider: class {
    readonly enabled = true
    readonly capturesKeys = true
    start(cb: (p: unknown) => void) {
      h.ix.cb = cb
    }
    async stop() {
      h.ix.cb = null
    }
  }
}))

class FakeOwner extends EventEmitter {
  readonly trusted = true
  send() {}
  isDestroyed() {
    return false
  }
}

let mod: typeof import('./index')
const call = (sender: unknown, channel: string, ...args: unknown[]): Promise<any> =>
  Promise.resolve(h.handlers.get(channel)!({ sender }, ...args))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function events(sessionId: string): Array<{ type: string; target?: { appName?: string }; data?: Record<string, any> }> {
  const p = join(h.devDir, 'sessions', sessionId, 'events.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).event) : []
}
/** A copy/cut chord as the interaction provider reports it (its own app identity). */
function chord(shortcut: string, appName?: string) {
  h.ix.cb?.({ type: 'keyboard_shortcut', target: appName ? { appName } : undefined, data: { ...(appName ? { appName } : {}), shortcut } })
}

beforeEach(async () => {
  vi.resetModules()
  h.handlers.clear()
  h.devDir = mkdtempSync(join(tmpdir(), 'gray-m3b-clipboard-'))
  Object.assign(h.clip, { text: '', reads: 0 })
  h.ix.cb = null
  mod = await import('./index')
  await mod.initTelemetry()
  mod.registerTelemetryIpc()
})

describe('M3-B clipboard scope (actual production composition)', () => {
  it('clipboard is read only after an in-scope copy', async () => {
    const owner = new FakeOwner()
    const reads: Record<string, number> = {}
    const phase = async (name: string, fn: () => unknown | Promise<unknown>, wait = 450) => {
      const r0 = h.clip.reads
      await fn()
      await sleep(wait)
      reads[name] = h.clip.reads - r0
    }
    h.clip.text = 'synthetic pre-session clipboard'
    let sessionId = ''
    await phase('start', async () => {
      const res = await call(owner, 'telemetry:sessionStart', { recordMode: 'one-app', selectedAppId: 'chrome', narrate: false })
      expect(res.ok).toBe(true)
      sessionId = res.status.sessionId
      await vi.waitFor(() => expect(h.ix.cb).not.toBeNull())
    })
    await phase('idle', () => {
      h.clip.text = 'synthetic idle change'
    }, 1200)
    await phase('denylisted', () => {
      h.clip.text = 'synthetic denylisted copy'
      chord('Cmd+C', '1Password')
    })
    await phase('unknownApp', () => {
      h.clip.text = 'synthetic unknown-app copy'
      chord('Cmd+C')
    })
    await phase('outOfScope', () => {
      h.clip.text = 'synthetic out-of-scope copy'
      chord('Cmd+C', 'Slack')
    })
    await phase('pausedAndResume', async () => {
      expect((await call(owner, 'telemetry:sessionPause', { sessionId })).ok).toBe(true)
      h.clip.text = 'synthetic paused copy'
      chord('Cmd+C', 'Google Chrome')
      await sleep(300)
      expect((await call(owner, 'telemetry:sessionResume', { sessionId })).ok).toBe(true)
    })
    await phase('inScope', async () => {
      h.clip.text = 'synthetic in-scope copy'
      chord('Cmd+C', 'Google Chrome')
      await sleep(450)
      chord('Cmd+C', 'Google Chrome') // repeat of the same content: no second event
      await sleep(450)
      h.clip.text = 'synthetic in-scope cut'
      chord('Cmd+X', 'Google Chrome')
    })
    const r0 = h.clip.reads
    h.clip.text = 'synthetic copy pending at Stop'
    chord('Cmd+C', 'Google Chrome')
    const t0 = Date.now()
    expect((await call(owner, 'telemetry:sessionStop', { sessionId })).ok).toBe(true)
    const stopMs = Date.now() - t0
    await sleep(450)
    reads.pendingAtStop = h.clip.reads - r0

    const raw = (mod.getTelemetryRecorder() as unknown as { getClipboardSessionValues?: () => Map<string, string> }).getClipboardSessionValues?.()
    const ev = events(sessionId)
    const clips = ev.filter((e) => e.type === 'clipboard_changed')
    const measured = {
      reads,
      clipboardEvents: clips.map((e) => ({ app: e.data?.appName ?? e.target?.appName ?? null, text: e.data?.clipboard?.text ?? null })),
      rawRetained: raw ? raw.size : 0,
      nonHollow: { events: ev.length, appSwitch: ev.filter((e) => e.type === 'app_switch').length, shortcuts: ev.filter((e) => e.type === 'keyboard_shortcut').length },
      stopMs
    }
    console.log('M3B-MEASURE ' + JSON.stringify(measured))

    // Non-hollow: the session recorded ordinary events and the chords themselves.
    expect(measured.nonHollow.appSwitch).toBeGreaterThan(0)
    expect(measured.nonHollow.shortcuts).toBeGreaterThan(3)
    // Reads only for in-scope copy/cut chords during the active generation.
    expect(reads).toMatchObject({ start: 0, idle: 0, denylisted: 0, unknownApp: 0, outOfScope: 0, pausedAndResume: 0, pendingAtStop: 0 })
    expect(reads.inScope).toBe(3)
    expect(measured.clipboardEvents).toEqual([
      { app: 'Google Chrome', text: 'synthetic in-scope copy' },
      { app: 'Google Chrome', text: 'synthetic in-scope cut' }
    ])
    expect(measured.rawRetained).toBe(0)

    // A second session starts clean: no read at Start, one in-scope copy recorded.
    const r1 = h.clip.reads
    const second = await call(owner, 'telemetry:sessionStart', { recordMode: 'one-app', selectedAppId: 'chrome', narrate: false })
    await vi.waitFor(() => expect(h.ix.cb).not.toBeNull())
    await sleep(300)
    expect(h.clip.reads - r1).toBe(0)
    h.clip.text = 'synthetic second recording copy'
    chord('Cmd+C', 'Google Chrome')
    await sleep(450)
    await call(owner, 'telemetry:sessionStop', { sessionId: second.status.sessionId })
    expect(events(second.status.sessionId).filter((e) => e.type === 'clipboard_changed').map((e) => e.data?.clipboard?.text)).toEqual(['synthetic second recording copy'])
  }, 30000)
})
