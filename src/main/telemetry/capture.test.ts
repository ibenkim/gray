import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent } from '../../shared/telemetry/schema'

const register = vi.fn(() => true)
const unregister = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true }) },
  globalShortcut: {
    register: (accelerator: string, cb: () => void) => register(accelerator, cb),
    unregister: (accelerator: string) => unregister(accelerator)
  },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } })
  }
}))

// active-win is a native module and needs screen-recording permission; the
// recorder must work without it for these tests.
vi.mock('active-win', () => ({ default: async () => undefined }))

import { TelemetryRecorder } from './capture'
import type { InteractionPartial, InteractionProvider } from './providers'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'

class FakeInteractionProvider implements InteractionProvider {
  readonly enabled = true
  capturesKeys: boolean
  emit: ((partial: InteractionPartial) => void) | null = null
  flushed = 0
  stopped = 0

  constructor(capturesKeys = true) {
    this.capturesKeys = capturesKeys
  }

  start(onEvent: (partial: InteractionPartial) => void): void {
    this.emit = onEvent
  }
  stop(): void {
    this.stopped += 1
  }
  flush(): void {
    this.flushed += 1
  }
}

async function startRecorder(
  provider: InteractionProvider,
  opts: Parameters<TelemetryRecorder['startRecording']>[0] = {}
): Promise<{ recorder: TelemetryRecorder; events: TelemetryEvent[] }> {
  const store = new InMemoryTelemetryStore()
  const recorder = new TelemetryRecorder(store, { interaction: provider })
  const events: TelemetryEvent[] = []
  recorder.onEvent((e) => events.push(e))
  await recorder.startRecording(opts)
  return { recorder, events }
}

beforeEach(() => {
  register.mockClear()
  unregister.mockClear()
})

describe('TelemetryRecorder shortcut strategy', () => {
  it('does not claim accelerators when the provider observes keys passively', async () => {
    const provider = new FakeInteractionProvider(true)
    await startRecorder(provider)
    // Registering would steal the chord from the app being recorded.
    expect(register).not.toHaveBeenCalled()
  })

  it('falls back to accelerators when the provider cannot observe keys', async () => {
    const provider = new FakeInteractionProvider(false)
    await startRecorder(provider)
    expect(register).toHaveBeenCalled()
  })

  it('flushes buffered typing before stopping', async () => {
    const provider = new FakeInteractionProvider(true)
    const { recorder } = await startRecorder(provider)
    await recorder.stopRecording()
    expect(provider.flushed).toBe(1)
    expect(provider.stopped).toBe(1)
  })
})

describe('TelemetryRecorder interaction filtering', () => {
  it('discards typing that happened inside Ghost itself', async () => {
    const provider = new FakeInteractionProvider()
    const { events } = await startRecorder(provider, { ignoreAppNames: ['ghost', 'Electron'] })

    provider.emit!({
      type: 'text_input',
      target: { appName: 'ghost' },
      data: { appName: 'ghost', typedText: 'my private note' }
    })

    expect(events.some((e) => e.type === 'text_input')).toBe(false)
    expect(JSON.stringify(events)).not.toContain('private note')
  })

  it('records typing from the app being recorded', async () => {
    const provider = new FakeInteractionProvider()
    const { events } = await startRecorder(provider)

    provider.emit!({
      type: 'text_input',
      target: { appName: 'Notes' },
      data: { appName: 'Notes', elementLabel: 'Note body', typedText: 'on my way' }
    })

    const typed = events.find((e) => e.type === 'text_input')
    expect(typed?.data?.typedText).toBe('on my way')
  })

  it('discards interactions from denylisted messaging apps', async () => {
    const provider = new FakeInteractionProvider()
    const { events } = await startRecorder(provider)

    provider.emit!({
      type: 'text_input',
      target: { appName: 'Messages' },
      data: { appName: 'Messages', elementLabel: 'Message', typedText: 'secret chat' }
    })

    expect(events.some((e) => e.type === 'text_input')).toBe(false)
  })

  it('discards interactions from other apps in one-app mode', async () => {
    const provider = new FakeInteractionProvider()
    const { events } = await startRecorder(provider, {
      recordMode: 'one-app',
      selectedAppId: 'chrome'
    })

    provider.emit!({
      type: 'click',
      data: { appName: 'Slack', elementLabel: 'Send' }
    })
    provider.emit!({
      type: 'click',
      data: { appName: 'Google Chrome', elementLabel: 'Search' }
    })

    const clicks = events.filter((e) => e.type === 'click')
    expect(clicks).toHaveLength(1)
    expect(clicks[0].data?.elementLabel).toBe('Search')
  })
})

describe('TelemetryRecorder paste detection', () => {
  it('turns an observed paste chord into a paste_detected event', async () => {
    const provider = new FakeInteractionProvider()
    const store = new InMemoryTelemetryStore()
    const recorder = new TelemetryRecorder(store, { interaction: provider })
    const events: TelemetryEvent[] = []
    recorder.onEvent((e) => events.push(e))
    await recorder.startRecording()

    // Seed a clipboard entry the paste can be matched against.
    recorder['clipboard'].ingestText('https://figma.com/file/abc')

    provider.emit!({
      type: 'keyboard_shortcut',
      data: { appName: 'Notes', shortcut: 'Cmd+V' }
    })

    const paste = events.find((e) => e.type === 'paste_detected')
    expect(paste).toBeTruthy()
    expect(paste!.data?.clipboard?.urlHost).toBe('figma.com')
    // The chord is reported as a paste, not duplicated as a shortcut.
    expect(events.some((e) => e.type === 'keyboard_shortcut')).toBe(false)
  })

  it('keeps other chords as shortcuts', async () => {
    const provider = new FakeInteractionProvider()
    const { events } = await startRecorder(provider)

    provider.emit!({
      type: 'keyboard_shortcut',
      data: { appName: 'Figma', shortcut: 'Cmd+S' }
    })

    expect(events.find((e) => e.type === 'keyboard_shortcut')?.data?.shortcut).toBe('Cmd+S')
  })
})
