import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION } from '../../../shared/telemetry/schema'
import { FileTelemetryStore } from './FileTelemetryStore'
import { InMemoryTelemetryStore } from './InMemoryTelemetryStore'

describe('FileTelemetryStore session layout', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes new sessions under sessions/{id}/', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-sess-'))
    const store = new FileTelemetryStore(dir, { isPackaged: false, isDev: true })
    await store.createSession({ sessionId: 'tsess_new' })

    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'meta.json'))).toBe(true)
    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'events.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'shots'))).toBe(true)
    expect(existsSync(join(dir, 'meta', 'tsess_new.json'))).toBe(false)

    const saved = await store.saveKeyframe('tsess_new', 'tevt_1', Buffer.from('jpeg'))
    expect(saved.relativePath).toBe('sessions/tsess_new/shots/tevt_1.jpg')
    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'shots', 'tevt_1.jpg'))).toBe(true)

    await store.saveNarration('tsess_new', {
      sessionId: 'tsess_new',
      spans: [{ text: 'only if empty', startMs: 0, endMs: 1000, marker: 'optional' }],
      transcribedAt: '2026-08-12T12:00:00.000Z'
    })
    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'narration.json'))).toBe(true)
    const narration = await store.getNarration('tsess_new')
    expect(narration?.spans[0]?.text).toBe('only if empty')

    await store.saveGroundTruth(
      'tsess_new',
      '# Ground truth\n## Steps\n1. Locate — Find it\n'
    )
    expect(existsSync(join(dir, 'sessions', 'tsess_new', 'ground_truth.md'))).toBe(true)
    const gt = await store.getGroundTruth('tsess_new')
    expect(gt).toContain('Locate')
  })

  it('reads legacy flat paths as fallback', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-legacy-'))
    mkdirSync(join(dir, 'meta'), { recursive: true })
    mkdirSync(join(dir, 'normalized'), { recursive: true })
    mkdirSync(join(dir, 'narration'), { recursive: true })

    const meta = {
      sessionId: 'tsess_old',
      startedAt: '2026-07-29T04:28:43.153Z',
      captureStatus: 'stopped',
      processingStatus: 'complete',
      schemaVersion: SCHEMA_VERSION
    }
    writeFileSync(join(dir, 'meta', 'tsess_old.json'), JSON.stringify(meta) + '\n')
    writeFileSync(join(dir, 'normalized', 'tsess_old.jsonl'), '')
    writeFileSync(
      join(dir, 'narration', 'tsess_old.json'),
      JSON.stringify({
        sessionId: 'tsess_old',
        spans: [{ text: 'legacy span', startMs: 10, endMs: 20 }]
      }) + '\n'
    )

    const store = new FileTelemetryStore(dir, { isPackaged: false, isDev: true })
    const got = await store.getSessionMeta('tsess_old')
    expect(got?.sessionId).toBe('tsess_old')
    expect(got?.captureStatus).toBe('stopped')

    const narration = await store.getNarration('tsess_old')
    expect(narration?.spans[0]?.text).toBe('legacy span')

    // Writes for legacy sessions stay on legacy paths
    await store.savePolishedSession('tsess_old', {
      sessionId: 'tsess_old',
      schemaVersion: SCHEMA_VERSION,
      polishedAt: '2026-07-29T04:28:48.452Z',
      sequenceRange: { min: 0, max: 0 },
      actions: []
    })
    expect(existsSync(join(dir, 'polished', 'tsess_old.json'))).toBe(true)
    expect(existsSync(join(dir, 'sessions', 'tsess_old', 'polished.json'))).toBe(false)

    const kf = await store.saveKeyframe('tsess_old', 'tevt_x', Buffer.from('x'))
    expect(kf.relativePath).toBe('tsess_old/tevt_x.jpg')
    expect(existsSync(join(dir, 'keyframes', 'tsess_old', 'tevt_x.jpg'))).toBe(true)
  })
})

describe('InMemoryTelemetryStore narration / ground truth', () => {
  it('round-trips narration and ground truth', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_m' })
    await store.saveNarration('tsess_m', {
      sessionId: 'tsess_m',
      spans: [{ text: 'hi', startMs: 0, endMs: 1 }],
      transcribedAt: '2026-08-12T12:00:00.000Z'
    })
    expect((await store.getNarration('tsess_m'))?.spans).toHaveLength(1)

    await store.saveGroundTruth('tsess_m', { steps: [], variables: [], branches: [], questions: [] })
    const raw = await store.getGroundTruth('tsess_m')
    expect(raw).toContain('"steps"')
    expect(JSON.parse(raw!).variables).toEqual([])

    const kf = await store.saveKeyframe('tsess_m', 'tevt_1', Buffer.from('j'))
    expect(kf.relativePath).toBe('sessions/tsess_m/shots/tevt_1.jpg')
  })
})

describe('FileTelemetryStore automation path (session layout)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('persists automation.json under the session directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-auto-sess-'))
    const store = new FileTelemetryStore(dir, { isPackaged: false, isDev: true })
    await store.createSession({ sessionId: 'tsess_file' })
    await store.saveAutomationScript(
      'tsess_file',
      {
        ops: [
          {
            op: 'open_app',
            stepOrder: 1,
            evidenceEventIds: ['tevt_1'],
            confidence: 0.9,
            timeoutMs: 10000,
            label: 'Open Terminal',
            appName: 'Terminal',
            appBundleId: null,
            url: null,
            urlVariableKey: null,
            elementRole: null,
            elementLabel: null,
            elementPath: null,
            chord: null,
            variableKey: null,
            literalText: null,
            waitCondition: null,
            waitValue: null,
            prompt: null,
            clickX: null,
            clickY: null
          }
        ],
        warnings: []
      },
      'gpt-test'
    )
    const path = join(dir, 'sessions', 'tsess_file', 'automation.json')
    expect(existsSync(path)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).sessionId).toBe('tsess_file')
  })
})
