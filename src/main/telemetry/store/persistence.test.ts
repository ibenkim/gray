import { appendFileSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { EVENT_SCHEMA_VERSION, type TelemetryEvent } from '../../../shared/telemetry/schema'
import { FileTelemetryStore } from './FileTelemetryStore'

// M7: synthetic events in an isolated temp root only.
const SID = 'tsess_m7_persist'

function evt(sequence: number): TelemetryEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId: `tevt_m7_${sequence}`,
    sessionId: SID,
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    elapsedMs: sequence * 1000,
    type: 'click',
    data: { appName: 'FixtureApp', elementLabel: `Synthetic ${sequence}` }
  }
}

async function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'gray-m7-store-'))
  const store = new FileTelemetryStore(root, { isPackaged: false, isDev: true })
  await store.createSession({ sessionId: SID })
  const eventsPath = join(root, 'sessions', SID, 'events.jsonl')
  return { store, eventsPath }
}

describe('FileTelemetryStore persistence (M7)', () => {
  it('concurrent appends of the same events store each once and release every lock', async () => {
    const { store, eventsPath } = await fresh()
    const batch = [evt(0), evt(1), evt(2)]
    const results = await Promise.all([store.appendEvents(SID, batch), store.appendEvents(SID, batch), store.appendEvents(SID, [evt(1), evt(3)])])
    expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(4)
    expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(4)
    const lines = readFileSync(eventsPath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(4)
    expect(store.heldLocks()).toBe(0)
  })

  it('a torn final line stays as counted evidence and cannot swallow the next append', async () => {
    const { store, eventsPath } = await fresh()
    await store.appendEvents(SID, [evt(0)])
    appendFileSync(eventsPath, '{"schemaVersion":1,"receivedAt":"2026-01-01T00:00:00.000Z","event":{"eventId":"tev')
    await store.appendEvents(SID, [evt(1)])
    const { events, invalidLines } = await store.readSessionEventsChecked(SID)
    expect(events.map((e) => e.sequence)).toEqual([0, 1])
    expect(invalidLines).toBe(1)
  })

  it('a failed append releases its lock and reports the failure', async () => {
    const { store } = await fresh()
    await expect(store.appendEvents('tsess_missing', [evt(0)])).rejects.toThrow(/unknown session/)
    await store.appendEvents(SID, [evt(0)])
    expect(store.heldLocks()).toBe(0)
  })
})
