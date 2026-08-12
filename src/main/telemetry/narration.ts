import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  type WriteStream
} from 'fs'
import { resolve, sep } from 'path'
import OpenAI, { toFile } from 'openai'
import { newId } from '../../shared/id'
import {
  SCHEMA_VERSION,
  type NarrationMarker,
  type PolishedAction,
  type PolishedSession,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import type { StoredNarration } from './store/TelemetryStore'

export type NarrationSpan = {
  text: string
  startMs: number
  endMs: number
  marker?: NarrationMarker
}

export type { StoredNarration }

const ABSOLUTE_MS_FLOOR = 1_000_000_000_000 // ~2001 in epoch ms

/**
 * Detect marker keywords in narration text (capture-spec Intent stream).
 * "only" / "never" map to decision_point (conditional language).
 */
export function parseMarkers(text: string): NarrationMarker | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (/\bskip\s+this\b/.test(t)) return 'skip_this'
  if (/\bcheck\s+here\b/.test(t)) return 'check_here'
  if (/\boptional\b/.test(t)) return 'optional'
  if (/\bdecision\b/.test(t) || /\bonly\b/.test(t) || /\bnever\b/.test(t)) {
    return 'decision_point'
  }
  return null
}

/**
 * Normalize spans to session-relative elapsedMs. Absolute wall-clock values
 * (when startMs looks like epoch ms) are converted using sessionStartedAtMs.
 * Also backfills markers from text when missing.
 */
export function alignNarration(
  spans: Array<{ text: string; startMs: number; endMs: number; marker?: NarrationMarker }>,
  sessionStartedAtMs: number
): NarrationSpan[] {
  return spans.map((s) => {
    const looksAbsolute =
      sessionStartedAtMs >= ABSOLUTE_MS_FLOOR && s.startMs >= ABSOLUTE_MS_FLOOR
    const startMs = looksAbsolute
      ? Math.max(0, Math.round(s.startMs - sessionStartedAtMs))
      : Math.max(0, Math.round(s.startMs))
    const endMs = looksAbsolute
      ? Math.max(startMs, Math.round(s.endMs - sessionStartedAtMs))
      : Math.max(startMs, Math.round(s.endMs))
    const text = s.text.trim()
    const marker = s.marker ?? parseMarkers(text) ?? undefined
    return { text, startMs, endMs, ...(marker ? { marker } : {}) }
  })
}

/**
 * Attach overlapping narration spans onto polished actions by elapsedMs.
 * Action window is [actionElapsed, nextActionElapsed) (last action +5s).
 */
export function attachNarration(
  polished: PolishedSession,
  spans: NarrationSpan[],
  sessionStartedAtMs: number
): PolishedSession {
  if (!spans.length || !polished.actions.length) return polished

  const actions: PolishedAction[] = polished.actions.map((action, i) => {
    const start = Math.max(0, Date.parse(action.timestamp) - sessionStartedAtMs)
    const next = polished.actions[i + 1]
    const end = next
      ? Math.max(start, Date.parse(next.timestamp) - sessionStartedAtMs)
      : start + 5_000
    const overlapping = spans.filter((s) => s.startMs < end && s.endMs > start)
    if (!overlapping.length) return action

    const narrationText = overlapping
      .map((s) => s.text)
      .join(' ')
      .trim()
      .slice(0, 800)
    const marker =
      overlapping.map((s) => s.marker).find((m): m is NarrationMarker => !!m) ??
      parseMarkers(narrationText) ??
      undefined

    return {
      ...action,
      ...(narrationText ? { narrationText } : {}),
      ...(marker ? { marker } : {})
    }
  })

  return { ...polished, actions }
}

/** Build narration_span (+ marker) events for the session stream. */
export function narrationSpansToEvents(
  sessionId: string,
  spans: NarrationSpan[],
  sequenceStart: number,
  sessionStartedAtMs: number
): TelemetryEvent[] {
  const events: TelemetryEvent[] = []
  let sequence = sequenceStart
  for (const span of spans) {
    const text = span.text.slice(0, 800)
    const timestamp = new Date(sessionStartedAtMs + span.startMs).toISOString()
    events.push({
      schemaVersion: SCHEMA_VERSION,
      eventId: newId('tevt'),
      sessionId,
      sequence: sequence++,
      timestamp,
      elapsedMs: span.startMs,
      type: 'narration_span',
      data: {
        narrationText: text,
        narrationStartMs: span.startMs,
        narrationEndMs: span.endMs,
        ...(span.marker ? { marker: span.marker } : {})
      }
    })
    if (span.marker) {
      events.push({
        schemaVersion: SCHEMA_VERSION,
        eventId: newId('tevt'),
        sessionId,
        sequence: sequence++,
        timestamp,
        elapsedMs: span.startMs,
        type: 'marker',
        data: {
          marker: span.marker,
          narrationText: text
        }
      })
    }
  }
  return events
}

/**
 * Transcribe a local audio file with OpenAI Whisper.
 * Prefers segment timestamps; falls back to sentence-proportional timing.
 */
export async function transcribeNarration(
  audioPath: string,
  apiKey: string
): Promise<NarrationSpan[]> {
  if (!existsSync(audioPath)) return []
  let size = 0
  try {
    size = statSync(audioPath).size
  } catch {
    return []
  }
  if (size < 64) return []

  const client = new OpenAI({ apiKey })
  const filename = audioPath.endsWith('.wav') ? 'narration.wav' : 'narration.webm'
  const file = await toFile(createReadStream(audioPath), filename)

  try {
    const result = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['segment']
    })

    const segments = (
      result as {
        segments?: Array<{ start?: number; end?: number; text?: string }>
        text?: string
        duration?: number
      }
    ).segments

    if (Array.isArray(segments) && segments.length > 0) {
      return segments
        .map((seg) => {
          const text = (seg.text ?? '').trim()
          const startMs = Math.max(0, Math.round((seg.start ?? 0) * 1000))
          const endMs = Math.max(startMs, Math.round((seg.end ?? seg.start ?? 0) * 1000))
          const marker = parseMarkers(text) ?? undefined
          return { text, startMs, endMs, ...(marker ? { marker } : {}) }
        })
        .filter((s) => s.text.length > 0)
    }

    const text = (result as { text?: string }).text?.trim() ?? ''
    if (!text) return []
    const durationMs = Math.round(((result as { duration?: number }).duration ?? 0) * 1000)
    return splitBySentence(text, durationMs > 0 ? durationMs : estimateDurationMs(text))
  } catch (err) {
    console.error(
      '[telemetry] narration transcription failed',
      err instanceof Error ? err.name : 'error'
    )
    return []
  }
}

function estimateDurationMs(text: string): number {
  // ~2.5 words/sec speaking rate
  const words = text.split(/\s+/).filter(Boolean).length
  return Math.max(1000, Math.round((words / 2.5) * 1000))
}

function splitBySentence(text: string, durationMs: number): NarrationSpan[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (sentences.length === 0) return []
  if (sentences.length === 1) {
    const marker = parseMarkers(sentences[0]) ?? undefined
    return [
      {
        text: sentences[0],
        startMs: 0,
        endMs: Math.max(0, durationMs),
        ...(marker ? { marker } : {})
      }
    ]
  }
  const each = durationMs / sentences.length
  return sentences.map((sentence, i) => {
    const startMs = Math.round(i * each)
    const endMs = Math.round((i + 1) * each)
    const marker = parseMarkers(sentence) ?? undefined
    return { text: sentence, startMs, endMs, ...(marker ? { marker } : {}) }
  })
}

/**
 * Main-process mic audio sink. Renderer MediaRecorder sends chunks via IPC;
 * this class writes `{rootDir}/narration/{sessionId}.webm`.
 * Supports injectTranscript for tests without real audio.
 */
export class NarrationRecorder {
  private sessionId: string | null = null
  private lastSessionId: string | null = null
  private audioPath: string | null = null
  private stream: WriteStream | null = null
  private injectedSpans: NarrationSpan[] | null = null
  private chunkCount = 0
  private closed = false

  constructor(private readonly rootDir: string) {}

  begin(sessionId: string): { audioPath: string } {
    if (this.sessionId === sessionId && this.stream && !this.closed) {
      return { audioPath: this.audioPath! }
    }
    this.endSync()
    this.sessionId = sessionId
    this.lastSessionId = sessionId
    this.injectedSpans = null
    this.chunkCount = 0
    this.closed = false
    const dir = this.narrationDir()
    mkdirSync(dir, { recursive: true })
    this.audioPath = resolve(dir, `${sessionId}.webm`)
    this.stream = createWriteStream(this.audioPath)
    this.stream.on('error', (err) => {
      console.error('[telemetry] narration write failed', err instanceof Error ? err.name : 'error')
    })
    return { audioPath: this.audioPath }
  }

  appendChunk(sessionId: string, chunk: Buffer): void {
    if (!this.sessionId || this.sessionId !== sessionId || !this.stream || this.closed) return
    if (!chunk || chunk.length === 0) return
    this.stream.write(chunk)
    this.chunkCount += 1
  }

  /** Test helper — skip Whisper and use these spans on finalize. */
  injectTranscript(spans: NarrationSpan[]): void {
    this.injectedSpans = spans.map((s) => ({
      ...s,
      text: s.text.trim(),
      marker: s.marker ?? parseMarkers(s.text) ?? undefined
    }))
  }

  isActive(): boolean {
    return !!this.sessionId && !this.closed
  }

  getSessionId(): string | null {
    return this.sessionId ?? this.lastSessionId
  }

  getAudioPath(): string | null {
    return this.audioPath
  }

  async end(): Promise<{
    sessionId: string | null
    audioPath: string | null
    hadChunks: boolean
  }> {
    const sessionId = this.sessionId ?? this.lastSessionId
    const audioPath = this.audioPath
    const hadChunks = this.chunkCount > 0
    await this.endAsync()
    return { sessionId, audioPath, hadChunks }
  }

  /**
   * Finalize capture, transcribe (or use injected spans), align to session.
   * Safe if the write stream was already closed by narrationStop.
   */
  async finalize(opts: {
    apiKey: string | null
    sessionStartedAtMs: number
    sessionId?: string
    /** Override / inject spans (also used by tests). */
    spans?: NarrationSpan[]
  }): Promise<NarrationSpan[]> {
    const { sessionId, audioPath, hadChunks } = await this.end()
    const id = opts.sessionId ?? sessionId
    if (!id) return []

    let spans: NarrationSpan[] = opts.spans ?? this.injectedSpans ?? []
    if (spans.length === 0 && audioPath && hadChunks && opts.apiKey) {
      spans = await transcribeNarration(audioPath, opts.apiKey)
    }
    const aligned = alignNarration(spans, opts.sessionStartedAtMs)
    this.injectedSpans = null
    this.chunkCount = 0
    return aligned
  }

  private narrationDir(): string {
    const root = resolve(this.rootDir)
    const dir = resolve(root, 'narration')
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    if (dir !== root && !dir.startsWith(rootWithSep)) {
      throw new Error('[telemetry] narration path escaped root')
    }
    return dir
  }

  private endSync(): void {
    if (this.stream) {
      try {
        this.stream.end()
      } catch {
        /* ignore */
      }
      this.stream = null
    }
    if (this.sessionId) this.lastSessionId = this.sessionId
    this.sessionId = null
    this.closed = true
  }

  private endAsync(): Promise<void> {
    return new Promise((resolvePromise) => {
      if (this.sessionId) this.lastSessionId = this.sessionId
      this.sessionId = null
      this.closed = true
      if (!this.stream) {
        resolvePromise()
        return
      }
      const s = this.stream
      this.stream = null
      s.end(() => resolvePromise())
      s.on('error', () => resolvePromise())
    })
  }
}

/** Empty placeholder written when narrate capture begins. */
export function emptyNarration(sessionId: string, audioPath?: string): StoredNarration {
  return {
    sessionId,
    spans: [],
    transcribedAt: '',
    ...(audioPath ? { audioPath } : {})
  }
}

export function buildStoredNarration(
  sessionId: string,
  spans: NarrationSpan[],
  audioPath?: string | null
): StoredNarration {
  return {
    sessionId,
    spans,
    transcribedAt: new Date().toISOString(),
    ...(audioPath ? { audioPath } : {})
  }
}

/** Persist narration events + JSON; safe to call with empty spans. */
export async function persistNarrationResult(
  store: {
    saveNarration?(sessionId: string, narration: StoredNarration): Promise<void>
    appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<unknown>
    readSessionEvents(sessionId: string): Promise<TelemetryEvent[]>
  },
  sessionId: string,
  spans: NarrationSpan[],
  sessionStartedAtMs: number,
  audioPath?: string | null
): Promise<StoredNarration> {
  const stored = buildStoredNarration(sessionId, spans, audioPath)
  if (store.saveNarration) {
    await store.saveNarration(sessionId, stored)
  }
  if (spans.length > 0) {
    const existing = await store.readSessionEvents(sessionId)
    const maxSeq = existing.reduce((m, e) => Math.max(m, e.sequence), -1)
    const events = narrationSpansToEvents(sessionId, spans, maxSeq + 1, sessionStartedAtMs)
    if (events.length > 0) {
      await store.appendEvents(sessionId, events)
    }
  }
  return stored
}
