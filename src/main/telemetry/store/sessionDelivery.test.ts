import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from '../../../shared/telemetry/schema'
import { toRecordingSummary } from '../uploadReview'
import { FileTelemetryStore } from './FileTelemetryStore'

// Synthetic sessions only, in a fresh temp root per test.
function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'gray-hf-store-'))
}
function open(root: string): FileTelemetryStore {
  return new FileTelemetryStore(root, { isPackaged: false, isDev: true })
}
function evt(sessionId: string, sequence: number): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `tevt_sd_${sequence}`,
    sessionId,
    sequence,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    elapsedMs: sequence * 1000,
    type: 'click',
    data: { appName: 'FixtureApp', elementLabel: 'Synthetic' }
  }
}
function writeLegacyMeta(root: string, sessionId: string, startedAt: string): void {
  mkdirSync(join(root, 'meta'), { recursive: true })
  writeFileSync(
    join(root, 'meta', `${sessionId}.json`),
    JSON.stringify({ sessionId, startedAt, status: 'stopped', schemaVersion: SCHEMA_VERSION })
  )
}

describe('session discovery', () => {
  it('empty store lists nothing', async () => {
    expect(await open(freshRoot()).listSessions()).toEqual([])
  })

  it('a recreated adapter discovers both layouts newest-first without known ids', async () => {
    const root = freshRoot()
    const first = open(root)
    await first.createSession({ sessionId: 'tsess_new' })
    writeLegacyMeta(root, 'tsess_legacy', '2020-01-01T00:00:00.000Z')

    const listed = await open(root).listSessions()
    expect(listed.map((m) => m.sessionId)).toEqual(['tsess_new', 'tsess_legacy'])
    expect(listed[0].delivery?.save.state).toBe('recording')
    // Legacy: no delivery metadata, so completeness/consent are never implied.
    expect(listed[1].delivery).toBeUndefined()
    const legacy = toRecordingSummary(listed[1])
    expect(legacy.saveState).toBe('legacy_unverified')
    expect(legacy.approvedAt).toBeUndefined()
    expect(legacy.canRetrySave).toBe(false)
  })

  it('current layout wins over a legacy duplicate; bad names, bad json and symlinks are skipped', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_dup' })
    writeLegacyMeta(root, 'tsess_dup', '2019-01-01T00:00:00.000Z')
    mkdirSync(join(root, 'sessions', 'bad name'), { recursive: true })
    mkdirSync(join(root, 'sessions', 'tsess_corrupt'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'tsess_corrupt', 'meta.json'), '{ truncated')
    const outside = mkdtempSync(join(tmpdir(), 'gray-hf-outside-'))
    writeFileSync(
      join(outside, 'meta.json'),
      JSON.stringify({ sessionId: 'tsess_link', startedAt: '2026-01-01T00:00:00.000Z' })
    )
    symlinkSync(outside, join(root, 'sessions', 'tsess_link'))

    const listed = await open(root).listSessions()
    expect(listed.map((m) => m.sessionId)).toEqual(['tsess_dup'])
    expect(listed[0].delivery).toBeDefined()
  })

  it('limit bounds the page', async () => {
    const root = freshRoot()
    const store = open(root)
    for (let i = 0; i < 5; i++) await store.createSession({ sessionId: `tsess_p${i}` })
    expect(await store.listSessions({ limit: 2 })).toHaveLength(2)
  })
})

describe('delivery state', () => {
  it('round-trips through a fresh adapter and serializes concurrent mutations', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_d' })
    await Promise.all([
      store.updateDelivery('tsess_d', (d) => ({ ...d!, save: { ...d!.save, state: 'saving' } })),
      store.updateDelivery('tsess_d', (d) => ({
        ...d!,
        review: { state: 'prepared', revision: 1, digest: 'a'.repeat(64) }
      }))
    ])
    const meta = await open(root).getSessionMeta('tsess_d')
    expect(meta?.delivery?.save.state).toBe('saving')
    expect(meta?.delivery?.review).toMatchObject({ state: 'prepared', revision: 1 })
  })

  it('a malformed new-format delivery becomes an incomplete save, never legacy', async () => {
    const root = freshRoot()
    await open(root).createSession({ sessionId: 'tsess_m' })
    const path = join(root, 'sessions', 'tsess_m', 'meta.json')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.delivery.save.state = 'uploaded'
    writeFileSync(path, JSON.stringify(raw))
    const meta = await open(root).getSessionMeta('tsess_m')
    expect(meta?.delivery?.save).toMatchObject({ state: 'incomplete', errorCode: 'METADATA_INVALID' })
    expect(toRecordingSummary(meta!).saveState).toBe('incomplete')
  })

  it('a failed metadata write leaves the previous state intact', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_ro' })
    const dir = join(root, 'sessions', 'tsess_ro')
    chmodSync(dir, 0o500)
    try {
      await expect(
        store.updateDelivery('tsess_ro', (d) => ({ ...d!, save: { state: 'complete' } }))
      ).rejects.toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
    expect((await open(root).getSessionMeta('tsess_ro'))?.delivery?.save.state).toBe('recording')
  })

  it('review/checkpoint artifacts persist for both layouts', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_r' })
    writeLegacyMeta(root, 'tsess_lr', '2020-01-01T00:00:00.000Z')
    await store.saveDeliveryArtifact('tsess_r', 'review', { v: 'current' })
    await store.saveDeliveryArtifact('tsess_lr', 'checkpoint', { v: 'legacy' })
    const fresh = open(root)
    expect(await fresh.readDeliveryArtifact('tsess_r', 'review')).toEqual({ v: 'current' })
    expect(await fresh.readDeliveryArtifact('tsess_lr', 'checkpoint')).toEqual({ v: 'legacy' })
    expect(await fresh.readDeliveryArtifact('tsess_r', 'checkpoint')).toBeNull()
  })
})

describe('evidence checks', () => {
  it('counts truncated/corrupt event lines instead of silently skipping them', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_e' })
    await store.appendEvents('tsess_e', [evt('tsess_e', 0), evt('tsess_e', 1)])
    appendFileSync(join(root, 'sessions', 'tsess_e', 'events.jsonl'), '{"schemaVersion":1,"ev')
    const checked = await open(root).readSessionEventsChecked('tsess_e')
    expect(checked.events).toHaveLength(2)
    expect(checked.invalidLines).toBe(1)
  })

  it('artifactSize verifies stored frames and refuses traversal', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_a' })
    const saved = await store.saveKeyframe('tsess_a', 'tevt_frame', Buffer.from('synthetic-jpeg'))
    expect(await store.artifactSize(saved.relativePath)).toBe(14)
    expect(await store.artifactSize('sessions/tsess_a/shots/missing.jpg')).toBeNull()
    expect(await store.artifactSize('../../etc/passwd')).toBeNull()
  })
})

describe('screenshot availability (M3-A)', () => {
  it('file and in-memory stores round-trip disabled availability; create stays idempotent', async () => {
    const { InMemoryTelemetryStore } = await import('./InMemoryTelemetryStore')
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_sc', screenshotCapture: 'disabled_privacy' })
    // Re-creating an existing id never relabels it.
    const again = await store.createSession({ sessionId: 'tsess_sc', screenshotCapture: 'unknown' })
    expect(again.screenshotCapture).toBe('disabled_privacy')
    expect((await open(root).getSessionMeta('tsess_sc'))?.screenshotCapture).toBe('disabled_privacy')

    const mem = new InMemoryTelemetryStore()
    await mem.createSession({ sessionId: 'tsess_mem', screenshotCapture: 'disabled_privacy' })
    expect((await mem.createSession({ sessionId: 'tsess_mem' })).screenshotCapture).toBe('disabled_privacy')
    expect(toRecordingSummary((await mem.getSessionMeta('tsess_mem'))!).screenshotCapture).toBe('disabled_privacy')
  })

  it('save, review preparation, approval and interpretation updates keep it', async () => {
    const root = freshRoot()
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_keep', screenshotCapture: 'disabled_privacy' })
    await store.stopSession('tsess_keep')
    await store.updateDelivery('tsess_keep', (d) => ({ ...d!, save: { state: 'complete', storedEvents: 2 } }))
    await store.updateDelivery('tsess_keep', (d) => ({ ...d!, review: { state: 'prepared', revision: 1, digest: 'b'.repeat(64) } }))
    await store.updateDelivery('tsess_keep', (d) => ({
      ...d!,
      review: { ...d!.review, state: 'approved', approval: { revision: 1, digest: 'b'.repeat(64), principal: 'synthetic-local-user', approvedAt: '2026-01-01T00:00:00.000Z', purpose: 'interpretation_text', provider: 'openai', model: 'test-model', promptVersion: 'p1', policyVersion: 'v1', legacyUnverified: false } }
    }))
    await store.updateDelivery('tsess_keep', (d) => ({ ...d!, interpretation: { state: 'complete', workflowId: 'wf_x' } }))
    const meta = (await open(root).getSessionMeta('tsess_keep'))!
    expect(meta.screenshotCapture).toBe('disabled_privacy')
    expect(meta.delivery?.review.approval).toMatchObject({ revision: 1, model: 'test-model' })
    expect(toRecordingSummary(meta)).toMatchObject({ screenshotCapture: 'disabled_privacy', saveState: 'complete', interpretationState: 'complete' })
  })

  it('legacy sessions and their image files stay intact and read as unknown; malformed never becomes a claim', async () => {
    const root = freshRoot()
    writeLegacyMeta(root, 'tsess_legacy', '2020-01-01T00:00:00.000Z')
    mkdirSync(join(root, 'keyframes', 'tsess_legacy'), { recursive: true })
    const image = join(root, 'keyframes', 'tsess_legacy', 'tevt_old.jpg')
    writeFileSync(image, Buffer.from('synthetic-legacy-jpeg'))
    const store = open(root)
    await store.createSession({ sessionId: 'tsess_new', screenshotCapture: 'disabled_privacy' })
    const listed = await store.listSessions({ limit: 10 })
    const legacy = listed.find((m) => m.sessionId === 'tsess_legacy')!
    expect(legacy.screenshotCapture).toBeUndefined()
    expect(toRecordingSummary(legacy).screenshotCapture).toBe('unknown')
    expect(readFileSync(image, 'utf8')).toBe('synthetic-legacy-jpeg')

    // A malformed value: still listed, delivery intact, status unknown (not disabled).
    const path = join(root, 'sessions', 'tsess_new', 'meta.json')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.screenshotCapture = 'available'
    writeFileSync(path, JSON.stringify(raw))
    const meta = await open(root).getSessionMeta('tsess_new')
    expect(meta).not.toBeNull()
    expect(meta!.screenshotCapture).toBe('unknown')
    expect(meta!.delivery?.save.state).toBe('recording')
    expect(toRecordingSummary(meta!).screenshotCapture).toBe('unknown')
  })
})
