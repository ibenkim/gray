import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type { TelemetryEvent } from '../../shared/telemetry/schema'
import type { TelemetryStore } from './store/TelemetryStore'

const BATCH_SIZE = 20
const FLUSH_MS = 2000
const MAX_QUEUE = 2000
const MAX_ATTEMPTS = 6
const BASE_BACKOFF_MS = 250

type Queued = {
  event: TelemetryEvent
  attempts: number
  /** Failed past the retry budget: retained (never silently dropped) until an explicit drain. */
  parked?: boolean
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
}

/** Extra attempts an explicit drain (Stop / local retry) grants parked events. */
const DRAIN_ATTEMPTS = 3

/**
 * Browser-side queue semantics adapted for the Electron main process:
 * preserve sequence, batch ~20 / 2s, dedupe by eventId, bounded exponential backoff.
 * Failed events are retained (durably) rather than dropped; overflow and store
 * rejections are counted per session so Stop can report an incomplete save.
 * `flush` is a shared promise: concurrent callers join the in-flight append.
 */
export class TelemetryQueue {
  private queue: Queued[] = []
  private seen = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushPromise: Promise<void> | null = null
  private stats = new Map<string, SessionStats>()
  private durablePath: string

  constructor(private readonly store: TelemetryStore) {
    this.durablePath = join(app.getPath('userData'), 'telemetry-unsent.json')
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
    for (const event of events) {
      if (this.seen.has(event.eventId)) continue
      if (this.queue.length >= MAX_QUEUE) {
        // Drop oldest to enforce max size; the loss is counted, never silent.
        const dropped = this.queue.shift()
        if (dropped) {
          this.seen.delete(dropped.event.eventId)
          this.statsFor(dropped.event.sessionId).dropped += 1
        }
      }
      this.seen.add(event.eventId)
      this.queue.push({ event, attempts: 0 })
    }
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
    return { ...this.statsFor(sessionId), pending: this.pendingFor(sessionId) }
  }

  /** Load the durable outbox without starting the timer (local save retry after relaunch). */
  restoreOutbox(): void {
    this.restore()
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
          } catch (err) {
            anyFailure = true
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

  private persist(): void {
    try {
      mkdirSync(dirname(this.durablePath), { recursive: true })
      const tmp = `${this.durablePath}.${process.pid}.tmp`
      writeFileSync(
        tmp,
        JSON.stringify(
          this.queue.map((q) => ({ event: q.event, attempts: q.attempts })),
          null,
          0
        ),
        'utf8'
      )
      renameSync(tmp, this.durablePath)
    } catch (err) {
      console.error(
        '[telemetry] failed to persist unsent queue',
        err instanceof Error ? err.name : 'error'
      )
    }
  }

  private restore(): void {
    if (!existsSync(this.durablePath)) return
    try {
      const raw = JSON.parse(readFileSync(this.durablePath, 'utf8')) as Array<{
        event: TelemetryEvent
        attempts?: number
      }>
      if (!Array.isArray(raw)) return
      for (const item of raw) {
        if (!item?.event?.eventId) continue
        if (this.seen.has(item.event.eventId)) continue
        this.seen.add(item.event.eventId)
        this.queue.push({ event: item.event, attempts: item.attempts ?? 0 })
      }
    } catch (err) {
      console.error(
        '[telemetry] failed to restore unsent queue',
        err instanceof Error ? err.name : 'error'
      )
    }
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
