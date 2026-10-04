import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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
  return new TelemetryQueue(store)
}

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
    // Durable outbox still holds the unsent event.
    const outbox = JSON.parse(readFileSync(join(h.userData, 'telemetry-unsent.json'), 'utf8'))
    expect(outbox).toHaveLength(1)
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
    expect(existsSync(join(h.userData, 'telemetry-unsent.json'))).toBe(true)
  })
})
