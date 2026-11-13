import { tmpdir } from 'os'
import { describe, expect, it, vi } from 'vitest'
import { PolishedSessionSchema, type ArtifactRef, type TelemetryEvent } from '../../shared/telemetry/schema'

/**
 * M10 — screenshot artifact contract on the real TelemetryRecorder with a synthetic frame
 * provider (no pixels, no screen). Every capture, crop and discard is counted.
 */
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  clipboard: { readText: () => '', readImage: () => ({ isEmpty: () => true }) },
  screen: {
    getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }),
    getAllDisplays: () => []
  }
}))
vi.mock('active-win', () => ({ default: async () => undefined }))

import { TelemetryRecorder } from './capture'
import { polishSession } from './polish'
import type { InteractionPartial, InteractionProvider, KeyframeResult, ScreenshotProvider } from './providers'
import { InMemoryTelemetryStore } from './store/InMemoryTelemetryStore'

const DISPLAY = { id: 1, x: -1440, y: 0, width: 1440, height: 900, scale: 2, binding: 'primary' as const }

class Interaction implements InteractionProvider {
  readonly enabled = true
  readonly capturesKeys = true
  emit: ((p: InteractionPartial) => void) | null = null
  start(onEvent: (p: InteractionPartial) => void): void {
    this.emit = onEvent
  }
  stop(): void {}
}

class Frames implements ScreenshotProvider {
  readonly enabled = true
  captures = 0
  crops: Array<{ source: string }> = []
  discarded: string[] = []
  stored = new Set<string>()
  gate: Promise<void> | null = null
  constructor(
    private readonly opts: { redaction?: 'masked' | 'none'; display?: boolean; crop?: boolean; discard?: boolean } = {}
  ) {
    if (opts.crop === false) this.cropFrom = undefined
    if (opts.discard === false) this.discard = undefined
  }
  async captureKeyframe(): Promise<KeyframeResult> {
    this.captures += 1
    if (this.gate) await this.gate
    const relativePath = `sessions/s/shots/f${this.captures}.jpg`
    this.stored.add(relativePath)
    return {
      relativePath,
      redaction: this.opts.redaction ?? 'masked',
      ...(this.opts.display === false ? {} : { display: DISPLAY })
    }
  }
  cropFrom? = async (source: string): Promise<KeyframeResult> => {
    this.crops.push({ source })
    const relativePath = `sessions/s/shots/c${this.crops.length}.jpg`
    this.stored.add(relativePath)
    return { relativePath, redaction: this.opts.redaction ?? 'masked' }
  }
  discard? = async (p: string): Promise<void> => {
    this.discarded.push(p)
    this.stored.delete(p)
  }
}

async function record(frames: ScreenshotProvider, clock?: () => number) {
  const store = new InMemoryTelemetryStore()
  const interaction = new Interaction()
  const recorder = new TelemetryRecorder(store, { interaction, screenshot: frames, ...(clock ? { clock } : {}) })
  const events: TelemetryEvent[] = []
  recorder.onEvent((e) => events.push(e))
  await recorder.startRecording({})
  const click = (
    elementBounds?: { x: number; y: number; width: number; height: number },
    extra: Partial<InteractionPartial> = {}
  ) =>
    interaction.emit!({ type: 'click', data: { appName: 'FixtureApp', elementLabel: 'Save', elementBounds }, ...extra })
  const refs = () => events.filter((e) => e.type === 'keyframe_captured').map((e) => e.data!.artifact as ArtifactRef)
  const clicks = () => events.filter((e) => e.type === 'click')
  return { recorder, store, events, click, refs, clicks, interaction }
}

const settle = () => new Promise((r) => setTimeout(r, 900))

describe('M10 artifact contract (synthetic frames)', () => {
  it('no frame before the action: pre is unavailable, never an after-action frame', async () => {
    const f = new Frames()
    const r = await record(f)
    r.click()
    await settle()
    const [pre, post] = r.refs()
    const action = r.clicks()[0]
    expect(pre).toEqual({ actionEventId: action.eventId, phase: 'pre', status: 'unavailable', reason: 'no_prior_frame' })
    expect(post).toMatchObject({ actionEventId: action.eventId, phase: 'post', status: 'stored', redaction: 'masked', display: DISPLAY })
    // Acquired after the settle deadline, i.e. after the action.
    expect(post.capturedAtMs!).toBeGreaterThanOrEqual(action.elapsedMs + 600)
    expect(f.captures).toBe(1)
    await r.recorder.stopRecording()
  })

  it('pre references the last earlier frame with its age; crop is cut from the same post frame', async () => {
    const f = new Frames()
    const r = await record(f)
    r.click()
    await settle()
    await new Promise((res) => setTimeout(res, 400)) // past the 1 s spacing
    r.click({ x: -1000, y: 100, width: 80, height: 30 })
    await settle()
    const refs = r.refs()
    const second = r.clicks()[1].eventId
    const firstPost = refs.find((x) => x.phase === 'post')!
    const pre = refs.find((x) => x.actionEventId === second && x.phase === 'pre')!
    expect(pre).toMatchObject({ status: 'dedup', relativePath: firstPost.relativePath })
    expect(pre.ageMs!).toBeGreaterThan(0)
    const post = refs.find((x) => x.actionEventId === second && x.phase === 'post')!
    const crop = refs.find((x) => x.actionEventId === second && x.phase === 'crop')!
    expect(crop).toMatchObject({ status: 'stored', sourcePath: post.relativePath, cropRect: { x: -1000, y: 100, width: 80, height: 30 } })
    // One full frame per action; the crop is not a second capture.
    expect(f.captures).toBe(2)
    expect(f.crops).toEqual([{ source: post.relativePath }])
    await r.recorder.stopRecording()
  })

  it.each([
    ['outside the source display', new Frames(), { x: 10, y: 10, width: 50, height: 50 }, 'denied', 'invalid_crop'],
    ['source display unknown', new Frames({ display: false }), { x: -1000, y: 100, width: 80, height: 30 }, 'denied', 'source_display_unknown'],
    ['no crop support', new Frames({ crop: false }), { x: -1000, y: 100, width: 80, height: 30 }, 'unavailable', 'crop_unsupported']
  ])('a crop %s is rejected, not kept whole', async (_n, f, rect, status, reason) => {
    const r = await record(f)
    r.click(rect)
    await settle()
    expect(r.refs().find((x) => x.phase === 'crop')).toMatchObject({ status, reason })
    expect(f.crops).toHaveLength(0)
    expect(f.captures).toBe(1)
    await r.recorder.stopRecording()
  })

  it('an unredacted frame is discarded and never referenced', async () => {
    const f = new Frames({ redaction: 'none' })
    const r = await record(f)
    r.click()
    await settle()
    expect(r.refs().find((x) => x.phase === 'post')).toMatchObject({ status: 'denied', reason: 'unredacted' })
    expect(f.discarded).toEqual(['sessions/s/shots/f1.jpg'])
    expect(f.stored.size).toBe(0)
    expect(JSON.stringify(r.events)).not.toContain('f1.jpg')
    await r.recorder.stopRecording()
  })

  it('an absolute or escaping frame path is discarded, never referenced or counted saved', async () => {
    const f = new Frames()
    f.captureKeyframe = async () => ({ relativePath: '/Users/someone/shot.jpg', redaction: 'masked', display: DISPLAY })
    const r = await record(f)
    r.click()
    await settle()
    expect(r.refs().find((x) => x.phase === 'post')).toMatchObject({ status: 'denied', reason: 'unsafe_path' })
    expect(f.discarded).toEqual(['/Users/someone/shot.jpg'])
    const stopped = await r.recorder.stopRecording()
    expect(stopped.artifacts.saved).toBe(0)
  })

  it('a source that cannot discard is not used at all', async () => {
    const f = new Frames({ discard: false })
    const r = await record(f)
    r.click()
    await settle()
    expect(r.refs().find((x) => x.phase === 'post')).toMatchObject({ status: 'unavailable', reason: 'no_discard' })
    expect(f.captures).toBe(0)
    await r.recorder.stopRecording()
  })

  it('pause during the settle wait denies the post frame: nothing is captured', async () => {
    const f = new Frames()
    const r = await record(f)
    r.click()
    await r.recorder.pauseRecording()
    const post = r.refs().find((x) => x.phase === 'post')
    // Recorded while paused is refused by the recorder; the request still settled as denied.
    expect(post === undefined || post.status === 'denied').toBe(true)
    expect(f.captures).toBe(0)
    await r.recorder.stopRecording()
  })

  it('a frame completing after Stop is discarded (its pixels may postdate the session)', async () => {
    const f = new Frames()
    let release!: () => void
    f.gate = new Promise((res) => (release = res))
    const r = await record(f)
    r.click()
    await settle()
    const stopping = r.recorder.stopRecording()
    release()
    await stopping
    expect(f.discarded).toEqual(['sessions/s/shots/f1.jpg'])
    expect(r.refs().some((x) => x.status === 'stored')).toBe(false)
  })

  it('rapid actions: every action settles pre and post; frames are spaced and bounded', async () => {
    const f = new Frames()
    const r = await record(f)
    for (let i = 0; i < 5; i++) r.click()
    await settle()
    const ids = r.clicks().map((c) => c.eventId)
    for (const id of ids) {
      const mine = r.refs().filter((x) => x.actionEventId === id)
      expect(mine.map((x) => x.phase).sort()).toEqual(['post', 'pre'])
    }
    const posts = r.refs().filter((x) => x.phase === 'post')
    expect(posts.filter((x) => x.status === 'stored')).toHaveLength(1)
    // The others settle explicitly (spaced by the 1 s minimum), never silently dropped.
    expect(posts.filter((x) => x.status !== 'stored').map((x) => [x.status, x.reason])).toEqual(
      Array(4).fill(['throttled', 'min_interval'])
    )
    expect(f.captures).toBe(1)
    await r.recorder.stopRecording()
  })

  it('polish links artifacts to their own action, including unavailable ones', async () => {
    const f = new Frames()
    const r = await record(f)
    r.click()
    await settle()
    const stopped = await r.recorder.stopRecording()
    const polished = await polishSession(r.store, stopped.sessionId!)
    const save = polished.actions.find((a) => a.sourceEventIds.includes(r.clicks()[0].eventId))!
    expect(save.artifacts?.map((a) => [a.phase, a.status])).toEqual([
      ['pre', 'unavailable'],
      ['post', 'stored']
    ])
    expect(save.keyframePath).toBe(r.refs().find((x) => x.phase === 'post')!.relativePath)
  })

  it('R1: a frame still being acquired when the action occurred is not its "pre"', async () => {
    const f = new Frames()
    const r = await record(f)
    r.click()
    let release!: () => void
    f.gate = new Promise((res) => (release = res))
    await new Promise((res) => setTimeout(res, 750)) // A's post requested, pixels pending
    const occurred = performance.now() // B happens now…
    await new Promise((res) => setTimeout(res, 50))
    release()
    await new Promise((res) => setTimeout(res, 20)) // …A's frame completes after it
    r.click(undefined, { occurredAt: occurred }) // …and B is delivered late
    const second = r.clicks()[1].eventId
    const pre = r.refs().find((x) => x.actionEventId === second && x.phase === 'pre')!
    expect(pre.status).toBe('unavailable')
    expect(pre.relativePath).toBeUndefined()
    const aPost = r.refs().find((x) => x.phase === 'post' && x.status === 'stored')!
    expect(aPost.capturedAtMs!).toBeGreaterThanOrEqual(aPost.requestedAtMs! + 50)
    await r.recorder.stopRecording()
  })

  it('R2: a burst beyond the job bound still settles every action visibly', async () => {
    const f = new Frames()
    const r = await record(f)
    for (let i = 0; i < 20; i++) r.click()
    await settle()
    for (const c of r.clicks()) {
      const mine = r.refs().filter((x) => x.actionEventId === c.eventId)
      expect(mine.map((x) => x.phase).sort()).toEqual(['post', 'pre'])
    }
    expect(r.refs().some((x) => x.reason === 'job_limit')).toBe(true)
    await r.recorder.stopRecording()
  })

  it('R2: the per-session cap counts requests that reached the provider, not stored frames', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const f = new Frames()
      f.captureKeyframe = async () => {
        f.captures += 1
        return null // every request errors
      }
      const r = await record(f, () => now)
      for (let i = 0; i < 125; i++) {
        now += 2000
        r.click()
        await vi.advanceTimersByTimeAsync(800)
      }
      expect(f.captures).toBe(120)
      const posts = r.refs().filter((x) => x.phase === 'post')
      expect(posts.filter((x) => x.reason === 'session_cap')).toHaveLength(5)
      const stopping = r.recorder.stopRecording()
      await vi.runAllTimersAsync()
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })

  it('R3: a frame that must go but cannot be deleted is retried at Stop and fails the save', async () => {
    const f = new Frames({ redaction: 'none' })
    let attempts = 0
    f.discard = async () => {
      attempts += 1
      throw new Error('EPERM synthetic')
    }
    const r = await record(f)
    r.click()
    await settle()
    const stopped = await r.recorder.stopRecording()
    expect(attempts).toBe(2)
    expect(stopped.artifacts.failed).toBe(1)
    expect(stopped.artifacts.paths).toEqual([])
  })

  it('R4: artifacts survive folding into fill_field and click collapsing', async () => {
    const f = new Frames()
    const r = await record(f)
    const field = { appName: 'FixtureApp', elementLabel: 'Name', elementRole: 'AXTextField' }
    r.interaction.emit!({ type: 'click', data: field })
    r.interaction.emit!({ type: 'text_input', data: { ...field, typedText: 'synthetic' } })
    await settle()
    await new Promise((res) => setTimeout(res, 400))
    r.interaction.emit!({ type: 'click', data: { appName: 'FixtureApp', elementLabel: 'Go', elementRole: 'AXButton' } })
    r.interaction.emit!({ type: 'click', data: { appName: 'FixtureApp', elementLabel: 'Go', elementRole: 'AXButton' } })
    await settle()
    const stopped = await r.recorder.stopRecording()
    const polished = await polishSession(r.store, stopped.sessionId!)
    const [fieldClick, go1, go2] = r.clicks().map((c) => c.eventId)
    const fill = polished.actions.find((a) => a.sourceEventIds.includes(fieldClick))!
    expect(fill.l1Op).toBe('fill_field') // the click really was folded into the typing
    expect(fill.artifacts?.map((a) => a.phase).sort()).toEqual(['post', 'pre'])
    const go = polished.actions.find((a) => a.sourceEventIds.includes(go1))!
    expect(go.sourceEventIds).toContain(go2)
    const owned = r.refs().filter((x) => x.actionEventId === go1 || x.actionEventId === go2)
    expect(owned).toHaveLength(4)
    expect(go.artifacts).toHaveLength(4)
  })

  it('R1 residual: a pre must be ≤ 5 s old even at its oldest possible acquisition', async () => {
    vi.useFakeTimers()
    try {
      let now = 1000
      const f = new Frames()
      const r = await record(f, () => now)
      r.click() // A at 1000
      let release!: () => void
      f.gate = new Promise((res) => (release = res))
      now = 1700
      await vi.advanceTimersByTimeAsync(800) // A's post requested at 1700, pixels pending
      now = 7700
      release()
      await vi.advanceTimersByTimeAsync(0) // completes at 7700
      now = 7800
      r.click() // B: completion was 100 ms earlier, but the pixels may be 6100 ms old
      const b = r.clicks()[1].eventId
      expect(r.refs().find((x) => x.actionEventId === b && x.phase === 'pre')).toMatchObject({
        status: 'unavailable',
        reason: 'prior_frame_stale'
      })
      // Control: a frame requested ≤ 5 s before the action is referenced, with that upper-bound age.
      now = 9000
      f.gate = null
      await vi.advanceTimersByTimeAsync(800) // B's post: requested and complete at 9000
      now = 9500
      r.click()
      const c = r.clicks()[2].eventId
      expect(r.refs().find((x) => x.actionEventId === c && x.phase === 'pre')).toMatchObject({ status: 'dedup', ageMs: 500 })
      const stopping = r.recorder.stopRecording()
      await vi.runAllTimersAsync()
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })

  it('R3 residual: an undeletable frame is reported after Stop and deleted by a later retry', async () => {
    const f = new Frames({ redaction: 'none' })
    let healthy = false
    let attempts = 0
    f.discard = async (p: string) => {
      attempts += 1
      if (!healthy) throw new Error('EPERM synthetic')
      f.stored.delete(p)
    }
    const r = await record(f)
    r.click()
    await settle()
    const stopped = await r.recorder.stopRecording()
    expect(stopped.artifacts).toMatchObject({ failed: 1, undeleted: ['sessions/s/shots/f1.jpg'] })
    expect(f.stored.size).toBe(1) // still on disk, and reported
    // The recorder only deletes inside the session's own frame layout.
    expect(await r.recorder.retryUndeleted('other', ['sessions/s/shots/f1.jpg'])).toEqual(['sessions/s/shots/f1.jpg'])
    expect(await r.recorder.retryUndeleted('s', ['sessions/s/shots/f1.jpg'])).toEqual(['sessions/s/shots/f1.jpg'])
    healthy = true
    expect(await r.recorder.retryUndeleted('s', ['sessions/s/shots/f1.jpg'])).toEqual([])
    expect(f.stored.size).toBe(0)
    expect(attempts).toBe(4)
  })

  it('R4 residual: a collapsed burst keeps 30 refs, counts the rest, and round-trips the schema', async () => {
    const f = new Frames()
    const r = await record(f)
    for (let i = 0; i < 20; i++) r.click() // same target, collapsed into one action
    await settle()
    const stopped = await r.recorder.stopRecording()
    const polished = await polishSession(r.store, stopped.sessionId!)
    const owner = polished.actions.find((a) => a.sourceEventIds.includes(r.clicks()[19].eventId))!
    expect(owner.sourceEventIds).toEqual(expect.arrayContaining(r.clicks().map((c) => c.eventId)))
    expect(owner.artifacts).toHaveLength(30)
    expect(owner.artifactsOmitted).toBe(10)
    expect(PolishedSessionSchema.safeParse(polished).success).toBe(true)
  })
})
