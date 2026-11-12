import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from '../../shared/telemetry/schema'
import type { AppendEventsResult, TelemetryStore } from './store/TelemetryStore'

// Synthetic events only; the queue's durable outbox goes to an isolated temp dir.
const h = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.userData } }))

const { TelemetryQueue } = await import('./queue')

function evt(sessionId: string, sequence: number): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `tevt_q_${sessionId}_${sequence}`,
    sessionId,
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    elapsedMs: sequence * 1000,
    type: 'click',
    data: { appName: 'FixtureApp', elementLabel: `Synthetic ${sequence}` }
  }
}

/** Store whose append acknowledgement the test controls. */
function controlledStore(impl: (events: TelemetryEvent[]) => Promise<AppendEventsResult>) {
  const appended: TelemetryEvent[] = []
  const store = {
    appendEvents: vi.fn(async (_sid: string, events: TelemetryEvent[]) => {
      const r = await impl(events)
      appended.push(...events.slice(0, r.accepted))
      return r
    })
  } as unknown as TelemetryStore
  return { store, appended }
}

function newQueue(store: TelemetryStore) {
  h.userData = mkdtempSync(join(tmpdir(), 'gray-hf-queue-'))
  return new TelemetryQueue(store, { outboxPath: outbox() })
}
const outbox = () => join(h.userData, 'root', 'outbox', 'unsent-v2.json')

afterEach(() => {
  vi.useRealTimers()
})

describe('TelemetryQueue completion barrier', () => {
  it('drain joins an in-flight append instead of returning early', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { store, appended } = controlledStore(async (events) => {
      await gate
      return { accepted: events.length, duplicates: 0, rejected: 0 }
    })
    const q = newQueue(store)
    q.enqueue([evt('s1', 0), evt('s1', 1)])
    const first = q.flush()
    let drained = false
    const drain = q.drain('s1').then((r) => {
      drained = true
      return r
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(drained).toBe(false)
    expect(appended).toHaveLength(0)
    release()
    const result = await drain
    await first
    expect(result).toMatchObject({ accepted: 2, pending: 0, rejected: 0, dropped: 0 })
    expect(appended).toHaveLength(2)
  })

  it('retains events after transient failures and reports them pending (never dropped)', async () => {
    const { store } = controlledStore(async () => {
      throw new Error('EIO synthetic disk failure')
    })
    const q = newQueue(store)
    q.enqueue([evt('s2', 0)])
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers()
    const pendingDrain = q.drain('s2')
    await vi.runAllTimersAsync()
    const result = await pendingDrain
    expect(store.appendEvents).toHaveBeenCalledTimes(3)
    expect(result.pending).toBe(1)
    expect(result.accepted).toBe(0)
    // Durable outbox still holds the unsent event (drain awaits the snapshot).
    const saved = JSON.parse(readFileSync(outbox(), 'utf8'))
    expect(saved).toMatchObject({ version: 2 })
    expect(saved.events).toHaveLength(1)
    // Logs carry a count only: no event id, payload or raw error text.
    const logged = errors.mock.calls.flat().join(' ')
    expect(logged).not.toContain('tevt_q_')
    expect(logged).not.toContain('Synthetic')
    expect(logged).not.toContain('EIO')
    errors.mockRestore()
  })

  it('a permanent store error parks events; an explicit later drain retries them', async () => {
    let fail = true
    const { store, appended } = controlledStore(async (events) => {
      if (fail) throw new Error('unknown session')
      return { accepted: events.length, duplicates: 0, rejected: 0 }
    })
    const q = newQueue(store)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    q.enqueue([evt('s3', 0)])
    expect((await q.drain('s3')).pending).toBe(1)
    fail = false
    const retried = await q.drain('s3')
    expect(retried).toMatchObject({ pending: 0, accepted: 1 })
    expect(appended).toHaveLength(1)
  })

  it('counts store rejections and privacy filtering separately', async () => {
    const { store } = controlledStore(async () => ({
      accepted: 1,
      duplicates: 0,
      rejected: 1,
      filtered: 1
    }))
    const q = newQueue(store)
    q.enqueue([evt('s4', 0), evt('s4', 1), evt('s4', 2)])
    expect(await q.drain('s4')).toMatchObject({ accepted: 1, rejected: 1, filtered: 1, pending: 0 })
  })

  it('overflow is counted as dropped for the evicted session', async () => {
    const { store } = controlledStore(async () => {
      throw new Error('EIO')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = newQueue(store)
    // Hold the queue full without flushing: 2,000 cap + 3 more evicts 3 oldest.
    const flushSpy = vi.spyOn(q, 'flush').mockResolvedValue()
    const events = Array.from({ length: 2003 }, (_, i) => evt('s5', i))
    for (let i = 0; i < events.length; i += 100) q.enqueue(events.slice(i, i + 100))
    flushSpy.mockRestore()
    expect(q.size()).toBe(2000)
    vi.useFakeTimers()
    const pendingDrain = q.drain('s5')
    await vi.runAllTimersAsync()
    const result = await pendingDrain
    expect(result.dropped).toBe(3)
    expect(existsSync(outbox())).toBe(true)
  })
})

describe('durable outbox (M7)', () => {
  const failing = () =>
    controlledStore(async () => {
      throw new Error('EIO')
    }).store

  it('enqueue does no synchronous outbox write; snapshots coalesce and Stop awaits the last', async () => {
    const q = newQueue(failing())
    vi.spyOn(q, 'flush').mockResolvedValue()
    for (let i = 0; i < 2001; i++) q.enqueue([evt('s6', i)])
    // Nothing is written on the enqueue path itself, not even the directory.
    expect(existsSync(dirname(outbox()))).toBe(false)
    expect(q.snapshotWrites).toBe(0)
    await q.persisted()
    expect(q.snapshotWrites).toBeLessThanOrEqual(2)
    expect(JSON.parse(readFileSync(outbox(), 'utf8')).events).toHaveLength(2000)
  })

  it('restore validates, caps at capacity and counts the losses', async () => {
    const q0 = newQueue(failing())
    vi.spyOn(q0, 'flush').mockResolvedValue()
    mkdirSync(dirname(outbox()), { recursive: true })
    const items = Array.from({ length: 2003 }, (_, i) => ({ event: evt('s7', i), attempts: 0 }))
    items.push({ event: { ...evt('s7', 9999), type: 'not_a_type' } as never, attempts: 0 })
    writeFileSync(outbox(), JSON.stringify({ version: 2, events: items }))
    const { store, appended } = controlledStore(async (events) => ({ accepted: events.length, duplicates: 0, rejected: 0 }))
    const q = new TelemetryQueue(store, { outboxPath: outbox() })
    q.restoreOutbox()
    expect(q.size()).toBe(2000)
    const r = await q.drain('s7')
    expect(r).toMatchObject({ accepted: 2000, dropped: 3, rejected: 1, pending: 0 })
    expect(appended[0].sequence).toBe(3)
  })

  it('an unreadable or wrong-version outbox is quarantined, not replayed or overwritten', async () => {
    newQueue(failing())
    mkdirSync(dirname(outbox()), { recursive: true })
    writeFileSync(outbox(), JSON.stringify([{ event: evt('s8', 0), attempts: 0 }]))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = new TelemetryQueue(failing(), { outboxPath: outbox() })
    q.restoreOutbox()
    expect(q.size()).toBe(0)
    expect(existsSync(outbox())).toBe(false)
    expect(readdirSync(dirname(outbox())).some((f) => f.startsWith('unsent-v2.json.unreadable-'))).toBe(true)
  })

  it('a failed quarantine keeps the damaged outbox until it is preserved; no snapshot replaces it', async () => {
    newQueue(failing())
    const dir = dirname(outbox())
    mkdirSync(dir, { recursive: true })
    writeFileSync(outbox(), 'damaged-bytes')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = new TelemetryQueue(failing(), { outboxPath: outbox() })
    vi.spyOn(q, 'flush').mockResolvedValue()
    chmodSync(dir, 0o555)
    try {
      q.restoreOutbox()
      expect(readFileSync(outbox(), 'utf8')).toBe('damaged-bytes')
      q.enqueue([evt('s10', 0)])
      await q.persisted()
      expect(readFileSync(outbox(), 'utf8')).toBe('damaged-bytes')
    } finally {
      chmodSync(dir, 0o755)
    }
    q.enqueue([evt('s10', 1)])
    await q.persisted()
    const kept = readdirSync(dir).filter((f) => f.startsWith('unsent-v2.json.unreadable-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('damaged-bytes')
    expect(JSON.parse(readFileSync(outbox(), 'utf8')).events).toHaveLength(2)
  })

  it('overflow never evicts the in-flight batch: every input is counted exactly once', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { store } = controlledStore(async (events) => {
      await held
      return { accepted: events.length, duplicates: 0, rejected: 0 }
    })
    const q = newQueue(store)
    for (let i = 0; i < 2001; i++) q.enqueue([evt('s11', i)])
    expect(q.size()).toBe(2000)
    release()
    const r = await q.drain('s11')
    expect(r.accepted + r.dropped + r.pending).toBe(2001)
    expect(r).toMatchObject({ accepted: 2000, dropped: 1, pending: 0 })
  })

  it('overflow never evicts any group of the selected batch, across sessions', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { store } = controlledStore(async (events) => {
      await held
      return { accepted: events.length, duplicates: 0, rejected: 0 }
    })
    const q = newQueue(store)
    // One batch: session A's group appends (held) while B's 19 wait behind it.
    q.enqueue([evt('a', 0)])
    for (let i = 0; i < 19; i++) q.enqueue([evt('b', i)])
    for (let i = 0; i < 1981; i++) q.enqueue([evt('c', i)])
    expect(q.size()).toBe(2000)
    release()
    const [a, b, c] = [await q.drain('a'), await q.drain('b'), await q.drain('c')]
    expect(b).toMatchObject({ accepted: 19, dropped: 0 })
    expect(c).toMatchObject({ accepted: 1980, dropped: 1, pending: 0 })
    expect(a.accepted + b.accepted + c.accepted + c.dropped).toBe(2001)
  })

  it('the pre-M7 userData outbox is quarantined once and never replayed', async () => {
    newQueue(failing())
    const legacy = join(h.userData, 'telemetry-unsent.json')
    writeFileSync(legacy, JSON.stringify([{ event: evt('s9', 0), attempts: 0 }]))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const q = new TelemetryQueue(failing(), { outboxPath: outbox() })
    q.restoreOutbox()
    expect(q.size()).toBe(0)
    expect(existsSync(legacy)).toBe(false)
    expect(readdirSync(h.userData).filter((f) => f.startsWith('telemetry-unsent.json.legacy-'))).toHaveLength(1)
  })
})
