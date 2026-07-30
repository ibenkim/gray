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
}

/**
 * Browser-side queue semantics adapted for the Electron main process:
 * preserve sequence, batch ~20 / 2s, flush on stop, dedupe by eventId,
 * bounded exponential backoff + jitter, no retry on permanent 4xx-like errors,
 * persist unsent events to a durable file and restore on start.
 */
export class TelemetryQueue {
  private queue: Queued[] = []
  private seen = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private flushing = false
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
        // Drop oldest to enforce max size, but keep durable snapshot current.
        const dropped = this.queue.shift()
        if (dropped) this.seen.delete(dropped.event.eventId)
      }
      this.seen.add(event.eventId)
      this.queue.push({ event, attempts: 0 })
    }
    this.persist()
    if (this.queue.length >= BATCH_SIZE) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, BATCH_SIZE)
        const bySession = new Map<string, Queued[]>()
        for (const item of batch) {
          const list = bySession.get(item.event.sessionId) ?? []
          list.push(item)
          bySession.set(item.event.sessionId, list)
        }

        let anyFailure = false
        for (const [sessionId, items] of bySession) {
          try {
            await this.store.appendEvents(
              sessionId,
              items.map((i) => i.event)
            )
            // Remove successfully appended items.
            const ids = new Set(items.map((i) => i.event.eventId))
            this.queue = this.queue.filter((q) => !ids.has(q.event.eventId))
            for (const id of ids) this.seen.delete(id)
          } catch (err) {
            anyFailure = true
            const permanent = isPermanentError(err)
            for (const item of items) {
              item.attempts += 1
              if (permanent || item.attempts >= MAX_ATTEMPTS) {
                // Drop permanent / exhausted items so we don't loop forever.
                this.queue = this.queue.filter((q) => q.event.eventId !== item.event.eventId)
                this.seen.delete(item.event.eventId)
                console.error(
                  '[telemetry] dropping event after failure',
                  item.event.eventId,
                  err instanceof Error ? err.message : err
                )
              }
            }
            if (!permanent) {
              const attempt = Math.min(
                ...items.map((i) => i.attempts),
                MAX_ATTEMPTS
              )
              const delay = backoffMs(attempt)
              await sleep(delay)
            }
          }
        }

        this.persist()
        if (anyFailure) break
        if (this.queue.length === 0) break
      }
    } finally {
      this.flushing = false
      this.persist()
    }
  }

  size(): number {
    return this.queue.length
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
      console.error('[telemetry] failed to persist unsent queue', err)
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
      console.error('[telemetry] failed to restore unsent queue', err)
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
  const exp = Math.min(BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt - 1)), 8000)
  const jitter = Math.floor(Math.random() * 200)
  return exp + jitter
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
