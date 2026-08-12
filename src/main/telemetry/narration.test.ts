import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type PolishedSession } from '../../shared/telemetry/schema'
import {
  alignNarration,
  attachNarration,
  NarrationRecorder,
  parseMarkers,
  persistNarrationResult,
  type NarrationSpan
} from './narration'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' }
}))

describe('parseMarkers', () => {
  it('detects decision / optional / skip this / check here', () => {
    expect(parseMarkers('This is a decision point')).toBe('decision_point')
    expect(parseMarkers('This step is optional')).toBe('optional')
    expect(parseMarkers('Skip this part')).toBe('skip_this')
    expect(parseMarkers('Check here before saving')).toBe('check_here')
  })

  it('maps only / never to decision_point', () => {
    expect(parseMarkers('Only if the cell is empty')).toBe('decision_point')
    expect(parseMarkers('Never overwrite existing values')).toBe('decision_point')
  })

  it('returns null when no marker keywords', () => {
    expect(parseMarkers('Click the submit button')).toBeNull()
    expect(parseMarkers('')).toBeNull()
  })

  it('prefers skip_this over decision when both present', () => {
    expect(parseMarkers('Skip this decision')).toBe('skip_this')
  })
})

describe('alignNarration', () => {
  it('keeps audio-relative times and backfills markers', () => {
    const aligned = alignNarration(
      [
        { text: 'optional confirmation', startMs: 100, endMs: 400 },
        { text: 'click save', startMs: 500, endMs: 800 }
      ],
      Date.parse('2026-01-01T00:00:00.000Z')
    )
    expect(aligned[0]).toMatchObject({
      text: 'optional confirmation',
      startMs: 100,
      endMs: 400,
      marker: 'optional'
    })
    expect(aligned[1].marker).toBeUndefined()
  })

  it('converts absolute wall-clock times to elapsedMs', () => {
    const start = Date.parse('2026-06-01T12:00:00.000Z')
    const aligned = alignNarration(
      [
        {
          text: 'hello',
          startMs: start + 1500,
          endMs: start + 2500
        }
      ],
      start
    )
    expect(aligned[0].startMs).toBe(1500)
    expect(aligned[0].endMs).toBe(2500)
  })
})

describe('attachNarration', () => {
  const sessionStartedAtMs = Date.parse('2026-06-01T12:00:00.000Z')

  function polished(actions: PolishedSession['actions']): PolishedSession {
    return {
      sessionId: 'tsess_n',
      schemaVersion: SCHEMA_VERSION,
      polishedAt: new Date().toISOString(),
      sequenceRange: { min: 0, max: actions.length },
      actions
    }
  }

  it('attaches overlapping spans onto polished actions', () => {
    const session = polished([
      {
        order: 1,
        text: 'Clicked Submit',
        category: 'interaction',
        timestamp: new Date(sessionStartedAtMs + 1000).toISOString(),
        sourceEventIds: ['e1'],
        appName: 'Safari'
      },
      {
        order: 2,
        text: 'Typed email',
        category: 'input',
        timestamp: new Date(sessionStartedAtMs + 5000).toISOString(),
        sourceEventIds: ['e2'],
        appName: 'Safari'
      }
    ])

    const spans: NarrationSpan[] = [
      {
        text: 'only if the field is empty',
        startMs: 1200,
        endMs: 3000,
        marker: 'decision_point'
      },
      {
        text: 'check here for typos',
        startMs: 5100,
        endMs: 7000,
        marker: 'check_here'
      }
    ]

    const next = attachNarration(session, spans, sessionStartedAtMs)
    expect(next.actions[0].narrationText).toBe('only if the field is empty')
    expect(next.actions[0].marker).toBe('decision_point')
    expect(next.actions[1].narrationText).toBe('check here for typos')
    expect(next.actions[1].marker).toBe('check_here')
  })

  it('leaves actions untouched when nothing overlaps', () => {
    const session = polished([
      {
        order: 1,
        text: 'Clicked Submit',
        category: 'interaction',
        timestamp: new Date(sessionStartedAtMs + 1000).toISOString(),
        sourceEventIds: ['e1']
      }
    ])
    const next = attachNarration(
      session,
      [{ text: 'later note', startMs: 20_000, endMs: 21_000 }],
      sessionStartedAtMs
    )
    expect(next.actions[0].narrationText).toBeUndefined()
    expect(next.actions[0].marker).toBeUndefined()
  })
})

describe('NarrationRecorder + persist', () => {
  it('finalizes injected transcript without Whisper and writes store events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'narration-'))
    const recorder = new NarrationRecorder(dir)
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_narr' })
    await store.stopSession('tsess_narr')

    recorder.begin('tsess_narr')
    recorder.injectTranscript([
      { text: 'skip this field', startMs: 0, endMs: 1200 },
      { text: 'click continue', startMs: 1200, endMs: 2400 }
    ])
    const started = Date.parse('2026-06-01T12:00:00.000Z')
    const spans = await recorder.finalize({
      apiKey: null,
      sessionStartedAtMs: started,
      sessionId: 'tsess_narr'
    })
    expect(spans[0].marker).toBe('skip_this')

    await persistNarrationResult(store, 'tsess_narr', spans, started)
    const saved = await store.getNarration('tsess_narr')
    expect(saved?.spans).toHaveLength(2)
    expect(saved?.transcribedAt).toBeTruthy()

    const events = await store.readSessionEvents('tsess_narr')
    expect(events.some((e) => e.type === 'narration_span')).toBe(true)
    expect(events.some((e) => e.type === 'marker' && e.data?.marker === 'skip_this')).toBe(true)
  })
})
