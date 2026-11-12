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
const { JxaAccessibilityProvider } = await import('./ax/JxaAccessibilityProvider')
const { prepareReview, reviewDigest, validateApproval, REVIEW_POLICY_VERSION } = await import('./uploadReview')

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

describe('M6-B: occurrence time, sequencing owner, audio window, candidates', () => {
  /** Real provider buffering, no child process: start only wires the recorder's callback and clock. */
  function fakeSensor() {
    const provider = new JxaAccessibilityProvider()
    provider.start = (onEvent, _scope, clock) => {
      provider['onEvent'] = onEvent
      if (clock) provider['now'] = clock
    }
    provider.stop = async () => {}
    return provider
  }
  const key = (chars: string) => ({ code: 0, chars, app: 'FixtureApp' })

  it('a typing entry keeps when it happened and is sequenced before later events', async () => {
    let mono = 0
    const sensor = fakeSensor()
    const recorder = new TelemetryRecorder(new InMemoryTelemetryStore(), { clock: () => mono, interaction: sensor })
    const events: TelemetryEvent[] = []
    recorder.onEvent((e) => events.push(e))
    await recorder.startRecording({})
    mono = 1_000
    sensor.handleKey(key('a'))
    mono = 1_500
    sensor.handleKey(key('b'))
    mono = 10_000 // the idle flush has not fired; another source records first
    recorder.recordEvent('app_switch', { data: { appName: 'OtherApp' } })

    const [typed, sw] = [events.find((e) => e.type === 'text_input'), events.find((e) => e.type === 'app_switch')]
    expect(typed).toMatchObject({ elapsedMs: 1_500, startElapsedMs: 1_000, data: { typedText: 'ab' } })
    expect(typed!.sequence).toBeLessThan(sw!.sequence)
    expect(sw!.elapsedMs).toBe(10_000)
    // Occurrence order agrees with emitted order.
    const elapsed = [...events].sort((a, b) => a.sequence - b.sequence).map((e) => e.elapsedMs)
    expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b))
    await recorder.stopRecording()
  })

  // M6-B-R1: provider events that do not flush the typing buffer themselves.
  for (const [name, interrupt] of [
    ['scroll', (s: InstanceType<typeof JxaAccessibilityProvider>) => s.handleScroll({ axis: 'vertical', delta: 3, app: 'FixtureApp' })],
    ['same-field click', (s: InstanceType<typeof JxaAccessibilityProvider>) => s.handleClick({ app: 'FixtureApp', role: 'AXTextField', label: 'Name', x: 10, y: 10 })],
    ['unlabelled click', (s: InstanceType<typeof JxaAccessibilityProvider>) => s.handleClick({ app: 'FixtureApp', x: 10, y: 10 })]
  ] as const) {
    it(`buffered typing is recorded before a later provider ${name} (through prepared review)`, async () => {
      let mono = 50_000
      const sensor = fakeSensor()
      sensor['context'] = { appName: 'FixtureApp', elementRole: 'AXTextField', elementLabel: 'Name', secure: false }
      const store = new FileTelemetryStore(mkdtempSync(join(tmpdir(), 'gray-m6b-seq-')), { isPackaged: false, isDev: true })
      const recorder = new TelemetryRecorder(store, { clock: () => mono, interaction: sensor })
      const { sessionId } = await recorder.startRecording({})
      mono = 51_000
      sensor.handleKey(key('a'))
      mono = 51_500
      sensor.handleKey(key('b'))
      mono = 52_000
      interrupt(sensor)
      mono = 53_000
      await recorder.stopRecording()
      // Main's Stop marks the save complete; the recorder alone does not.
      await store.updateDelivery(sessionId!, (d) => ({ ...d!, save: { state: 'complete' } }), { captureStatus: 'stopped' })

      const events = (await store.readSessionEvents(sessionId!)).sort((a, b) => a.sequence - b.sequence)
      const seen = events.filter((e) => e.type !== 'session_started' && e.type !== 'session_stopped')
      expect(seen.map((e) => [e.type, e.elapsedMs]), name).toEqual([
        ['text_input', 1_500],
        [name === 'scroll' ? 'scroll' : 'click', 2_000]
      ])
      const elapsed = events.map((e) => e.elapsedMs)
      expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b))

      const review = await prepareReview(store, sessionId!, 'test-model')
      expect(review, name).toMatchObject({ ok: true })
      const acts = JSON.stringify((review as { review: { body: { acts: unknown[] } } }).review.body.acts)
      const typed = acts.indexOf('ab')
      expect(typed, name).toBeGreaterThan(-1)
      expect(typed, name).toBeLessThan(acts.indexOf(name === 'scroll' ? 'croll' : 'lick'))
    })
  }

  it("a typing entry's own duration is not waiting, and its action starts at the first key", async () => {
    const typed = { ...ev(2, 50_000, 'text_input', WALL + 50_000, { appName: 'FixtureApp', elementRole: 'AXTextField', elementLabel: 'Name', typedText: 'hello' }), startElapsedMs: 41_000 }
    const p = await polish([
      ev(0, 0, 'session_started', WALL),
      ev(1, 1_000, 'click', WALL + 1_000, click('Open')),
      typed,
      ev(3, 51_000, 'click', WALL + 51_000, click('Save'))
    ])
    const entry = p.actions.find((a) => a.typedText === 'hello')
    expect(entry).toMatchObject({ elapsedMs: 41_000, waitedMs: 40_000 })
    expect(p.actions.find((a) => a.elementLabel === 'Save')?.waitedMs).toBeUndefined()
  })

  it('narration is placed from the recorded audio start and ends at the first pause', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: SID })
    await store.appendEvents(SID, [
      ev(0, 0, 'session_started', WALL),
      ev(1, 2_000, 'narration_started', WALL + 2_000),
      ev(2, 3_000, 'click', WALL + 3_000, click('A')),
      ev(3, 10_000, 'click', WALL + 10_000, click('B')),
      ev(4, 12_000, 'session_paused', WALL + 12_000),
      ev(5, 20_000, 'session_resumed', WALL + 20_000),
      ev(6, 30_000, 'click', WALL + 30_000, click('C'))
    ])
    // Audio-relative spans: "first" is at session 2.0–3.5s; "late" would be after the pause.
    await store.saveNarration!(SID, {
      sessionId: SID,
      spans: [
        { text: 'first', startMs: 0, endMs: 1_500 },
        { text: 'late', startMs: 12_000, endMs: 13_000 }
      ]
    } as never)
    const p = await polishSession(store, SID)
    expect(p.narrationTiming).toBe('audio_start_main_receipt')
    const text = Object.fromEntries(p.actions.filter((a) => a.elementLabel).map((a) => [a.elementLabel, a.narrationText]))
    expect(text).toEqual({ A: 'first', B: undefined, C: undefined })
  })

  it('4s gaps are candidates only; final segments are unchanged and legacy has none', async () => {
    const events = [
      ev(0, 0, 'session_started', WALL),
      ev(1, 1_000, 'click', WALL + 1_000, click('A')),
      ev(2, 6_000, 'click', WALL + 6_000, click('B')),
      ev(3, 7_000, 'click', WALL + 7_000, click('C'))
    ]
    const p = await polish(events)
    const order = (l: string) => p.actions.find((a) => a.elementLabel === l)!.order
    expect(p.segmentCandidates).toEqual([{ afterOrder: order('A'), beforeOrder: order('B'), gapMs: 5_000 }])
    expect(p.segments).toHaveLength(1)
    const legacy = await polish(events.map((e) => ({ ...e, schemaVersion: LEGACY_EVENT_SCHEMA_VERSION })))
    expect(legacy.segmentCandidates).toBeUndefined()
  })
})

describe('M8-A: secure evidence through persistence and prepared review', () => {
  function fakeSensor() {
    const provider = new JxaAccessibilityProvider()
    provider.start = (onEvent, _scope, clock) => {
      provider['onEvent'] = onEvent
      if (clock) provider['now'] = clock
    }
    provider.stop = async () => {}
    return provider
  }
  const ENTRY = { appName: 'FixtureApp', elementRole: 'AXTextField', elementLabel: 'Entry', selectedLabels: [] }

  async function record(after: (s: InstanceType<typeof JxaAccessibilityProvider>) => void) {
    const sensor = fakeSensor()
    const store = new FileTelemetryStore(mkdtempSync(join(tmpdir(), 'gray-m8a-')), { isPackaged: false, isDev: true })
    const recorder = new TelemetryRecorder(store, { interaction: sensor })
    const { sessionId } = await recorder.startRecording({})
    sensor.emitFromSample(ENTRY)
    for (const ch of 'fixture') sensor.handleKey({ code: 0, chars: ch, base: ch, app: 'FixtureApp' })
    after(sensor)
    await recorder.stopRecording()
    await store.updateDelivery(sessionId!, (d) => ({ ...d!, save: { state: 'complete' } }), { captureStatus: 'stopped' })
    return { store, sessionId: sessionId! }
  }

  it.each([
    ['a later sample shows the same target is secure, then Stop', (s: InstanceType<typeof JxaAccessibilityProvider>) =>
      s.emitFromSample({ ...ENTRY, elementSubrole: 'AXSecureTextField', secure: true })],
    ['a secure chord (Cmd+Return)', (s: InstanceType<typeof JxaAccessibilityProvider>) =>
      s.handleKey({ code: 36, chars: null, base: null, cmd: true, secure: true, app: 'FixtureApp' })]
  ] as const)('%s: characters never reach storage or the review', async (_name, after) => {
    const { store, sessionId } = await record(after)
    const events = await store.readSessionEvents(sessionId)
    expect(events.some((e) => e.type === 'text_input')).toBe(false)
    expect(events.filter((e) => e.type === 'credential_entered')).toHaveLength(1)
    const review = await prepareReview(store, sessionId, 'test-model')
    expect(review).toMatchObject({ ok: true })
    const all = JSON.stringify({ events, review })
    expect(all).not.toContain('fixture')
    // The review keeps the step, as a sensitive input with no literal.
    expect((review as { review: { body: { acts: unknown[] } } }).review.body.acts).toEqual(
      expect.arrayContaining([expect.objectContaining({ e: 'Entry', k: 'sensitive' })])
    )
  })

  it('ordinary input is still recorded and reviewed (control)', async () => {
    const { store, sessionId } = await record(() => {})
    const review = await prepareReview(store, sessionId, 'test-model')
    expect(JSON.stringify(review)).toContain('fixture')
  })

  it('a review prepared under the previous privacy policy is stale at approval and is re-prepared', async () => {
    const { store, sessionId } = await record(() => {})
    const current = (await prepareReview(store, sessionId, 'test-model')) as { ok: true; review: any }
    expect(await validateApproval(store, sessionId, current.review.revision, current.review.digest, 'test-model'))
      .toMatchObject({ ok: true })
    // The same immutable review as an older build wrote it: valid digest, older policy.
    const { digest: _d, revision, preparedAt, ...content } = current.review
    const old = { ...content, policyVersion: 'm1hf-text-1' }
    const oldReview = { ...old, revision, preparedAt, digest: reviewDigest(old) }
    await store.saveDeliveryArtifact(sessionId, 'review', oldReview)
    expect(await validateApproval(store, sessionId, revision, oldReview.digest, 'test-model'))
      .toMatchObject({ ok: false, code: 'REVIEW_STALE' })
    const again = (await prepareReview(store, sessionId, 'test-model')) as { ok: true; review: any }
    expect(again.review).toMatchObject({ policyVersion: REVIEW_POLICY_VERSION, revision: revision + 1 })
  })
})
