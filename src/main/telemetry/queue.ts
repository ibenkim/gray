import { existsSync, readFileSync, renameSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { app } from 'electron'
import { TelemetryEventSchema, type TelemetryEvent } from '../../shared/telemetry/schema'
import type { TelemetryStore } from './store/TelemetryStore'

const BATCH_SIZE = 20
const FLUSH_MS = 2000
const MAX_QUEUE = 2000
const MAX_ATTEMPTS = 6
const BASE_BACKOFF_MS = 250
const OUTBOX_VERSION = 2

type Queued = {
  event: TelemetryEvent
  attempts: number
  /** Failed past the retry budget: retained (never silently dropped) until an explicit drain. */
  parked?: boolean
  /** Owned by the current store append: never evicted on overflow, so it is counted once. */
  inFlight?: boolean
}

type SessionStats = {
  accepted: number
  duplicates: number
  /** Store refused as invalid — data loss. */
  rejected: number
  /** Intentional privacy filtering — not a loss. */
  filtered: number
  /** Evicted by queue overflow — data loss. */
  dropped: number
}

export type DrainResult = SessionStats & {
  /** Still unsent for this session (retained in memory + durable outbox). */
  pending: number
  pendingIds: string[]
  /** Ids whose append returned a final disposition in this process (tracked once a session failed or was restored). */
  settledIds: string[]
}

/** Extra attempts an explicit drain (Stop / local retry) grants parked events. */
const DRAIN_ATTEMPTS = 3

/**
 * Browser-side queue semantics adapted for the Electron main process:
 * preserve sequence, batch ~20 / 2s, dedupe by eventId, bounded exponential backoff.
 * Failed events are retained (durably) rather than dropped; overflow and store
 * rejections are counted per session so Stop can report an incomplete save.
 * `flush` is a shared promise: concurrent callers join the in-flight append.
 *
 * Durable outbox (M7): bound to the store's root, versioned, written off the enqueue path by
 * one serialized async writer that coalesces to the latest snapshot. Crash window: events
 * enqueued since the last completed snapshot. A crash always leaves its session without a
 * terminal event, so it is reported incomplete — never a successful save.
 */
export class TelemetryQueue {
  private queue: Queued[] = []
  private seen = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushPromise: Promise<void> | null = null
  private stats = new Map<string, SessionStats>()
  private readonly durablePath: string | null
  private writing: Promise<void> | null = null
  private dirty = false
  /** Damaged outbox whose quarantine failed: no snapshot may replace it until it is preserved. */
  private unpreserved: string | null = null
  /** Ids settled by a completed append, per session restored or with a failed append (retry proof). */
  private settled = new Map<string, Set<string>>()
  /** Snapshot writes completed (instrumentation for tests/benchmarks). */
  snapshotWrites = 0

  constructor(
    private readonly store: TelemetryStore,
    opts: { outboxPath?: string | null } = {}
  ) {
    this.durablePath =
      opts.outboxPath !== undefined ? opts.outboxPath : (store.outboxPath?.() ?? null)
  }

  start(): void {
    this.restore()
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.flush()
    }, FLUSH_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  enqueue(events: TelemetryEvent[]): void {
    for (const event of events) this.admit(event, 0)
    this.persist()
    if (this.queue.length >= BATCH_SIZE) {
      void this.flush()
    }
  }

  flush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    if (!this.queue.some((q) => !q.parked)) return Promise.resolve()
    this.flushPromise = this.runFlush().finally(() => {
      this.flushPromise = null
    })
    return this.flushPromise
  }

  /**
   * Completion barrier for one session: joins any in-flight append, gives parked
   * events a bounded retry budget, and reports what was stored vs still pending/lost.
   */
  async drain(sessionId: string): Promise<DrainResult> {
    for (const q of this.queue) {
      if (q.event.sessionId !== sessionId) continue
      q.parked = false
      // Bounded: at most DRAIN_ATTEMPTS more tries (~1.75s of backoff) before reporting pending.
      q.attempts = Math.max(0, MAX_ATTEMPTS - DRAIN_ATTEMPTS)
    }
    for (let round = 0; round <= MAX_ATTEMPTS && this.unparkedFor(sessionId) > 0; round++) {
      await this.flush()
    }
    // A flush started by someone else may still own the last batch.
    if (this.flushPromise) await this.flushPromise
    await this.persisted()
    const pendingIds = this.queue
      .filter((q) => q.event.sessionId === sessionId)
      .map((q) => q.event.eventId)
    return {
      ...this.statsFor(sessionId),
      pending: pendingIds.length,
      pendingIds,
      settledIds: [...(this.settled.get(sessionId) ?? [])]
    }
  }

  /** Load the durable outbox without starting the timer (local save retry after relaunch). */
  restoreOutbox(): void {
    this.restore()
  }

  /** Resolves once the latest outbox snapshot is written (Stop awaits it). */
  async persisted(): Promise<void> {
    while (this.writing) await this.writing
  }

  size(): number {
    return this.queue.length
  }

  private async runFlush(): Promise<void> {
    try {
      while (this.queue.some((q) => !q.parked)) {
        const batch = this.queue.filter((q) => !q.parked).slice(0, BATCH_SIZE)
        const bySession = new Map<string, Queued[]>()
        for (const item of batch) {
          const list = bySession.get(item.event.sessionId) ?? []
          list.push(item)
          bySession.set(item.event.sessionId, list)
        }

        let anyFailure = false
        // The whole selected batch is owned until its groups finish, not only the group appending.
        for (const item of batch) item.inFlight = true
        try {
          for (const [sessionId, items] of bySession) {
            try {
              const result = await this.store.appendEvents(
                sessionId,
                items.map((i) => i.event)
              )
              const stats = this.statsFor(sessionId)
              stats.accepted += result.accepted
              stats.duplicates += result.duplicates
              stats.rejected += result.rejected
              stats.filtered += result.filtered ?? 0
              const ids = new Set(items.map((i) => i.event.eventId))
              this.queue = this.queue.filter((q) => !ids.has(q.event.eventId))
              for (const id of ids) this.seen.delete(id)
              const settled = this.settled.get(sessionId)
              if (settled) for (const id of ids) settled.add(id)
            } catch (err) {
              anyFailure = true
              // From the first failure on, settlements are tracked: only then can work be pending.
              if (!this.settled.has(sessionId)) this.settled.set(sessionId, new Set())
              const permanent = isPermanentError(err)
              let parkedNow = 0
              for (const item of items) {
                item.attempts += 1
                if (permanent || item.attempts >= MAX_ATTEMPTS) {
                  if (!item.parked) parkedNow += 1
                  item.parked = true
                }
              }
              if (parkedNow > 0) {
                // Safe summary only — no event ids, payloads or raw error bodies.
                console.error(
                  `[telemetry] ${parkedNow} event(s) not persisted; retained for retry` +
                    (permanent ? ' (permanent store error)' : '')
                )
              }
              if (!permanent) {
                const attempt = Math.min(...items.map((i) => i.attempts), MAX_ATTEMPTS)
                await sleep(backoffMs(attempt))
              }
            }
          }
        } finally {
          for (const item of batch) item.inFlight = false
        }

        this.persist()
        if (anyFailure) break
      }
    } finally {
      this.persist()
    }
  }

  private statsFor(sessionId: string): SessionStats {
    let s = this.stats.get(sessionId)
    if (!s) {
      s = { accepted: 0, duplicates: 0, rejected: 0, filtered: 0, dropped: 0 }
      this.stats.set(sessionId, s)
    }
    return s
  }

  private pendingFor(sessionId: string): number {
    return this.queue.filter((q) => q.event.sessionId === sessionId).length
  }

  private unparkedFor(sessionId: string): number {
    return this.queue.filter((q) => q.event.sessionId === sessionId && !q.parked).length
  }

  /** Bounded admission shared by enqueue and restore: overflow evicts the oldest, counted. */
  private admit(event: TelemetryEvent, attempts: number): void {
    if (this.seen.has(event.eventId)) return
    if (this.queue.length >= MAX_QUEUE) {
      const i = this.queue.findIndex((q) => !q.inFlight)
      if (i >= 0) {
        const [dropped] = this.queue.splice(i, 1)
        this.seen.delete(dropped.event.eventId)
        this.statsFor(dropped.event.sessionId).dropped += 1
      }
    }
    this.seen.add(event.eventId)
    this.queue.push({ event, attempts })
  }

  /** Mark the outbox dirty; one async writer coalesces to the latest state. No sync I/O. */
  private persist(): void {
    if (!this.durablePath) return
    this.dirty = true
    if (!this.writing) {
      this.writing = this.writeLoop().finally(() => {
        this.writing = null
      })
    }
  }

  private async writeLoop(): Promise<void> {
    const path = this.durablePath!
    while (this.dirty) {
      this.dirty = false
      // First await before any work: nothing below runs on the enqueue call stack.
      try {
        await mkdir(dirname(path), { recursive: true })
        if (this.unpreserved) {
          await rename(path, this.unpreserved)
          this.unpreserved = null
        }
      } catch (err) {
        console.error(
          '[telemetry] outbox unavailable; snapshot skipped',
          err instanceof Error ? err.name : 'error'
        )
        continue
      }
      const body = JSON.stringify({
        version: OUTBOX_VERSION,
        events: this.queue.map((q) => ({ event: q.event, attempts: q.attempts }))
      })
      try {
        const tmp = `${path}.${process.pid}.tmp`
        await writeFile(tmp, body, 'utf8')
        // Atomic replace: the last good snapshot survives a failed write.
        await rename(tmp, path)
        this.snapshotWrites += 1
      } catch (err) {
        console.error(
          '[telemetry] failed to persist unsent queue',
          err instanceof Error ? err.name : 'error'
        )
      }
    }
  }

  private restore(): void {
    quarantineLegacyOutbox()
    const path = this.durablePath
    if (!path || !existsSync(path)) return
    let items: Array<{ event?: unknown; attempts?: unknown }>
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; events?: unknown }
      if (raw?.version !== OUTBOX_VERSION || !Array.isArray(raw.events)) throw new Error('version')
      items = raw.events
    } catch {
      // Unreadable or foreign: keep it as evidence, never replay or overwrite it.
      if (!quarantine(path, 'unreadable')) this.unpreserved = `${path}.unreadable-${Date.now()}`
      return
    }
    for (const item of items) {
      const parsed = TelemetryEventSchema.safeParse(item?.event)
      if (!parsed.success) {
        const sid = (item?.event as { sessionId?: unknown } | undefined)?.sessionId
        if (typeof sid === 'string') this.statsFor(sid).rejected += 1
        continue
      }
      const attempts = typeof item.attempts === 'number' && item.attempts >= 0 ? item.attempts : 0
      const sid = parsed.data.sessionId
      if (!this.settled.has(sid)) this.settled.set(sid, new Set())
      this.admit(parsed.data, attempts)
    }
  }
}

/** Rename aside (never delete): the file stays available for inspection, read-only. */
function quarantine(path: string, why: string): boolean {
  try {
    renameSync(path, `${path}.${why}-${Date.now()}`)
    console.error(`[telemetry] outbox quarantined (${why})`)
    return true
  } catch {
    return false // left in place; the writer retries before any snapshot
  }
}

/**
 * The pre-M7 outbox lived in userData, unbound to any storage root or version, so replaying it
 * could mix roots. It is quarantined once, not imported; affected sessions stay incomplete.
 */
function quarantineLegacyOutbox(): void {
  try {
    const legacy = join(app.getPath('userData'), 'telemetry-unsent.json')
    if (existsSync(legacy)) quarantine(legacy, 'legacy')
  } catch {
    /* no app paths (tests) */
  }
}

function isPermanentError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  // Mimic "do not retry permanent 4xx": validation / unknown session / path errors.
  return (
    /unknown session|Invalid session|path traversal|ZodError|cannot run in production/i.test(
      msg
    )
  )
}

function backoffMs(attempt: number): number {
  // Capped at ~1s so an explicit drain (Stop) settles within a few seconds.
  const exp = BASE_BACKOFF_MS * Math.pow(2, Math.min(2, Math.max(0, attempt - 1)))
  const jitter = Math.floor(Math.random() * 200)
  return exp + jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
