import { appendFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EVENT_SCHEMA_VERSION,
  LEGACY_EVENT_SCHEMA_VERSION,
  type PolishedSession,
  type TelemetryEvent
} from '../../shared/telemetry/schema'

/**
 * M6 — monotonic time and explicit occurrence order. Virtual clocks only; the system clock is
 * never changed (vi.setSystemTime fakes Date inside this process). All content is synthetic.
 */

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir() },
  clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true }) },
  globalShortcut: { register: () => true, unregister: () => {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) }
}))
vi.mock('active-win', () => ({ default: async () => undefined }))

const { TelemetryRecorder } = await import('./capture')
const { polishSession } = await import('./polish')
const { InMemoryTelemetryStore } = await import('./store/InMemoryTelemetryStore')
const { FileTelemetryStore } = await import('./store/FileTelemetryStore')
const { createWorkflowModelInput } = await import('./modelInput')

afterEach(() => {
  vi.useRealTimers()
})

const SID = 'tsess_m6_timing'
const WALL = Date.parse('2026-06-01T12:00:00.000Z')

function ev(sequence: number, elapsedMs: number, type: TelemetryEvent['type'], wallMs: number, data: TelemetryEvent['data'] = {}): TelemetryEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `tevt_${sequence}`,
    sessionId: SID,
    sequence,
    timestamp: new Date(wallMs).toISOString(),
    elapsedMs,
    type,
    data
  }
}

const click = (label: string) => ({ appName: 'FixtureApp', elementLabel: label, elementRole: 'AXButton' })

async function polish(events: TelemetryEvent[]): Promise<PolishedSession> {
  const store = new InMemoryTelemetryStore()
  await store.createSession({ sessionId: SID })
  await store.appendEvents(SID, events)
  return polishSession(store, SID)
}

/** Polished output without wall-clock display fields. */
function shape(p: PolishedSession) {
  return {
    timing: p.timing,
    segments: p.segments,
    actions: p.actions.map(({ timestamp: _t, ...rest }) => rest)
  }
}

describe('capture clock (M6)', () => {
  it('elapsedMs follows the monotonic clock while the wall clock jumps both ways', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(WALL)
    let mono = 50_000
    const store = new InMemoryTelemetryStore()
    const recorder = new TelemetryRecorder(store, { clock: () => mono })
    const events: TelemetryEvent[] = []
    recorder.onEvent((e) => events.push(e))
    await recorder.startRecording({})

    mono += 1_000
    vi.setSystemTime(WALL - 3_600_000) // wall jumps back an hour
    recorder.recordEvent('click', { data: click('A') })
    mono += 2_000
    vi.setSystemTime(WALL + 86_400_000) // then forward a day (or a timezone/NTP change)
    recorder.recordEvent('click', { data: click('B') })
    recorder.recordEvent('click', { data: click('C') }) // same monotonic instant

    const clicks = events.filter((e) => e.type === 'click')
    expect(clicks.map((e) => e.elapsedMs)).toEqual([1_000, 3_000, 3_000])
    expect(clicks.map((e) => e.sequence)).toEqual([...clicks.map((e) => e.sequence)].sort((a, b) => a - b))
    expect(events.every((e) => e.schemaVersion === EVENT_SCHEMA_VERSION)).toBe(true)
  })

  it('pause and resume are recorded on the timeline', async () => {
    let mono = 0
    const recorder = new TelemetryRecorder(new InMemoryTelemetryStore(), { clock: () => mono })
    const events: TelemetryEvent[] = []
    recorder.onEvent((e) => events.push(e))
    await recorder.startRecording({})
    mono = 1_000
    await recorder.pauseRecording()
    mono = 61_000
    await recorder.resumeRecording()
    const marks = events.filter((e) => e.type === 'session_paused' || e.type === 'session_resumed')
    expect(marks.map((e) => [e.type, e.elapsedMs])).toEqual([
      ['session_paused', 1_000],
      ['session_resumed', 61_000]
    ])
    expect(recorder.getRecordingStatus()).toMatchObject({ phase: 'recording' })
  })
})

describe('polish on the monotonic timeline (M6)', () => {
  const base = [
    ev(0, 0, 'session_started', WALL),
    ev(1, 1_000, 'click', WALL + 1_000, click('Open')),
    ev(2, 41_000, 'click', WALL + 41_000, click('Save')),
    ev(3, 41_000, 'click', WALL + 41_000, click('Close'))
  ]

  it('wall-clock jumps cannot change durations, order, waits or merges', async () => {
    const steady = await polish(base)
    // Same events, wall timestamps scrambled (backward and forward jumps).
    const jumped = await polish(
      base.map((e, i) => ({ ...e, timestamp: new Date(WALL + [0, -7_200_000, 86_400_000, -1][i]).toISOString() }))
    )
    expect(shape(jumped)).toEqual(shape(steady))
    expect(steady.timing).toBe('monotonic')
    const save = steady.actions.find((a) => a.elementLabel === 'Save')
    expect(save).toMatchObject({ elapsedMs: 41_000, waitedMs: 40_000 })
    // Equal occurrence time: emitted sequence decides order.
    expect(steady.actions.map((a) => a.elementLabel).filter(Boolean)).toEqual(['Open', 'Save', 'Close'])
  })

  it('a paused span is not user waiting', async () => {
    const paused = await polish([
      base[0],
      base[1],
      ev(4, 2_000, 'session_paused', WALL + 2_000),
      ev(5, 40_000, 'session_resumed', WALL + 40_000),
      { ...base[2], sequence: 6, eventId: 'tevt_6' }
    ])
    const save = paused.actions.find((a) => a.elementLabel === 'Save')
    expect(save?.elapsedMs).toBe(41_000)
    expect(save?.waitedMs).toBeUndefined()
  })
})

describe('legacy v1 events (M6)', () => {
  it('decode explicitly and are never upgraded to verified timing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gray-m6-legacy-'))
    const store = new FileTelemetryStore(root, { isPackaged: false, isDev: true })
    await store.createSession({ sessionId: SID })
    const legacy = { ...ev(0, 0, 'session_started', WALL), schemaVersion: LEGACY_EVENT_SCHEMA_VERSION }
    const legacyClick = { ...ev(1, 1_000, 'click', WALL + 1_000, click('Open')), schemaVersion: LEGACY_EVENT_SCHEMA_VERSION }
    appendFileSync(
      join(root, 'sessions', SID, 'events.jsonl'),
      [legacy, legacyClick].map((event) => JSON.stringify({ schemaVersion: 1, receivedAt: new Date(WALL).toISOString(), event })).join('\n') + '\n'
    )
    const events = await store.readSessionEvents(SID)
    expect(events.map((e) => e.schemaVersion)).toEqual([1, 1])
    const polished = await polishSession(store, SID)
    expect(polished.timing).toBe('legacy_unverified')
  })

  it('unverified timing yields no waits, action times or waiting segments downstream (M6-R1)', async () => {
    const legacy = (e: TelemetryEvent): TelemetryEvent => ({ ...e, schemaVersion: LEGACY_EVENT_SCHEMA_VERSION })
    // A legacy wall-clock jump that would read as a one-hour wait before Continue.
    const events = [
      ev(0, 0, 'session_started', WALL),
      ev(1, 1_000, 'click', WALL + 1_000, click('Open')),
      ev(2, 3_601_000, 'click', WALL + 3_601_000, click('Continue')),
      ev(3, 3_602_000, 'session_stopped', WALL + 3_602_000)
    ]
    for (const [name, input] of [
      ['all v1', events.map(legacy)],
      ['mixed', [legacy(events[0]), ...events.slice(1)]]
    ] as const) {
      const p = await polish([...input])
      expect(p.timing, name).toBe('legacy_unverified')
      expect(p.actions.some((a) => a.waitedMs !== undefined || a.elapsedMs !== undefined), name).toBe(false)
      expect(p.segments?.some((s) => s.kind === 'waiting'), name).toBe(false)
      const meta = { sessionId: SID, startedAt: new Date(WALL).toISOString(), stoppedAt: new Date(WALL + 3_602_000).toISOString(), captureStatus: 'stopped', processingStatus: 'not_started', schemaVersion: 1 } as const
      const body = createWorkflowModelInput(meta, p)
      expect(JSON.stringify(body.acts), name).not.toMatch(/"w":/)
      expect(body, name).not.toHaveProperty('dur')
    }
    // The same shape with verified timing keeps the wait.
    const verified = await polish(events)
    expect(verified.actions.find((a) => a.elementLabel === 'Continue')?.waitedMs).toBe(3_600_000)
  })

  it('one legacy event makes the whole session unverified', async () => {
    const mixed = await polish([
      ev(0, 0, 'session_started', WALL),
      { ...ev(1, 1_000, 'click', WALL + 1_000, click('Open')), schemaVersion: LEGACY_EVENT_SCHEMA_VERSION }
    ])
    expect(mixed.timing).toBe('legacy_unverified')
  })
})

describe('model input on a long log (M6-R2)', () => {
  it('computes duration without an argument spread and still reaches the action budget', () => {
    const n = 150_000
    const actions = Array.from({ length: n }, (_, i) => ({
      order: i + 1,
      text: `Clicked item ${i}`,
      category: 'interaction' as const,
      timestamp: new Date(WALL + i).toISOString(),
      elapsedMs: i,
      sourceEventIds: [`tevt_${i}`],
      appName: 'FixtureApp',
      elementLabel: `item ${i}`
    }))
    const polished: PolishedSession = {
      sessionId: SID,
      schemaVersion: 1,
      polishedAt: new Date(WALL).toISOString(),
      sequenceRange: { min: 0, max: n },
      actions,
      timing: 'monotonic'
    }
    const meta = { sessionId: SID, startedAt: new Date(WALL).toISOString(), captureStatus: 'stopped', processingStatus: 'not_started', schemaVersion: 1 } as const
    const body = createWorkflowModelInput(meta, polished)
    expect(body.dur).toBe(n - 1)
    expect(body.acts.length).toBeLessThanOrEqual(48)
    expect(body.acts.length).toBeGreaterThan(0)
  })
})
