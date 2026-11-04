import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * M3-B — clipboard scope on the actual production composition: real initTelemetry,
 * TelemetryRecorder, ClipboardWatcher and FileTelemetryStore. Fakes only at the native
 * boundary: Electron's clipboard (every read counted — main must never read it), active-window
 * reads and the accessibility child (the test emits what the sensor would: chords, verified
 * copies and the pasteboard changeCount). All content is synthetic; network denied.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  devDir: '',
  clip: { text: '', reads: 0 },
  ix: { cb: null as null | ((p: unknown) => void), pb: 0 }
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
    pasteboardCount() {
      return h.ix.pb
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
/** What the sensor emits for a copy it verified (one pasteboard change by `appName`). */
function verifiedCopy(text: string, appName?: string) {
  h.ix.pb += 1
  h.ix.cb?.({
    type: 'clipboard_changed',
    target: appName ? { appName } : undefined,
    data: appName ? { appName } : {},
    copy: { text, types: ['public.utf8-plain-text'], pasteboard: h.ix.pb }
  })
}
function paste(appName = 'Google Chrome') {
  h.ix.cb?.({ type: 'keyboard_shortcut', target: { appName }, data: { appName, shortcut: 'Cmd+V' } })
}

beforeEach(async () => {
  vi.resetModules()
  h.handlers.clear()
  h.devDir = mkdtempSync(join(tmpdir(), 'gray-m3b-clipboard-'))
  Object.assign(h.clip, { text: '', reads: 0 })
  h.ix.cb = null
  h.ix.pb = 0
  mod = await import('./index')
  await mod.initTelemetry()
  mod.registerTelemetryIpc()
})

describe('M3-B clipboard scope (actual production composition)', () => {
  it('clipboard is read only after an in-scope copy', async () => {
    const owner = new FakeOwner()
    h.clip.text = 'synthetic pre-session clipboard'
    const start = await call(owner, 'telemetry:sessionStart', { recordMode: 'one-app', selectedAppId: 'chrome', narrate: false })
    expect(start.ok).toBe(true)
    const sessionId = start.status.sessionId
    await vi.waitFor(() => expect(h.ix.cb).not.toBeNull())
    await sleep(1200) // idle: nothing may be read

    verifiedCopy('synthetic denylisted copy', '1Password')
    verifiedCopy('synthetic unknown-app copy')
    verifiedCopy('synthetic out-of-scope copy', 'Slack')
    expect((await call(owner, 'telemetry:sessionPause', { sessionId })).ok).toBe(true)
    verifiedCopy('synthetic paused copy', 'Google Chrome')
    expect((await call(owner, 'telemetry:sessionResume', { sessionId })).ok).toBe(true)
    await sleep(200)

    verifiedCopy('synthetic in-scope copy', 'Google Chrome')
    paste() // pasteboard still holds that copy: matched
    h.ix.pb += 1 // an excluded app copies (the sensor emits nothing for it)
    paste() // must not claim the earlier in-scope text
    verifiedCopy('synthetic in-scope cut', 'Google Chrome')
    await call(owner, 'telemetry:sessionStop', { sessionId })
    verifiedCopy('synthetic copy after Stop', 'Google Chrome')
    await sleep(200)

    const ev = events(sessionId)
    const measured = {
      electronReads: h.clip.reads,
      clipboardEvents: ev.filter((e) => e.type === 'clipboard_changed').map((e) => ({ app: e.data?.appName ?? e.target?.appName ?? null, text: e.data?.clipboard?.text ?? null })),
      pastes: ev.filter((e) => e.type === 'paste_detected').map((e) => e.data?.clipboard?.text ?? null),
      nonHollow: { events: ev.length, appSwitch: ev.filter((e) => e.type === 'app_switch').length }
    }
    console.log('M3B-MEASURE ' + JSON.stringify(measured))

    expect(measured.nonHollow.appSwitch).toBeGreaterThan(0)
    expect(measured.electronReads).toBe(0)
    expect(measured.clipboardEvents).toEqual([
      { app: 'Google Chrome', text: 'synthetic in-scope copy' },
      { app: 'Google Chrome', text: 'synthetic in-scope cut' }
    ])
    // R4: the second paste followed an unobserved copy, so it carries no clipboard content.
    expect(measured.pastes).toEqual(['synthetic in-scope copy'])
    expect(ev.filter((e) => e.type === 'keyboard_shortcut' && e.data?.shortcut === 'Cmd+V')).toHaveLength(1)
    expect(JSON.stringify(ev)).not.toContain('synthetic pre-session')

    // A second session starts clean: the previous copy matches no paste; a new copy records.
    const second = await call(owner, 'telemetry:sessionStart', { recordMode: 'one-app', selectedAppId: 'chrome', narrate: false })
    await vi.waitFor(() => expect(h.ix.cb).not.toBeNull())
    verifiedCopy('synthetic second recording copy', 'Google Chrome')
    await call(owner, 'telemetry:sessionStop', { sessionId: second.status.sessionId })
    expect(events(second.status.sessionId).filter((e) => e.type === 'clipboard_changed').map((e) => e.data?.clipboard?.text)).toEqual(['synthetic second recording copy'])
    expect(h.clip.reads).toBe(0)
  }, 30000)
})
