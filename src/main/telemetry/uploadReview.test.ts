import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, type TelemetryEvent } from '../../shared/telemetry/schema'
import type { TelemetryConfig } from './config'
import { FileTelemetryStore } from './store/FileTelemetryStore'

// Synthetic fixtures; the only fake is the OpenAI Responses transport boundary.
const h = vi.hoisted(() => ({
  ctorOptions: [] as unknown[],
  bodies: [] as Array<{ model: string; store: boolean; input: Array<{ role: string; content: string }> }>,
  respond: [] as Array<(body: unknown) => Promise<unknown>>
}))

vi.mock('openai', () => {
  class OpenAI {
    constructor(opts: unknown) {
      h.ctorOptions.push(opts)
    }
    responses = {
      parse: (body: never) => {
        h.bodies.push(body)
        const next = h.respond.shift()
        return next ? next(body) : Promise.reject(new Error('no scripted response'))
      }
    }
  }
  return { default: OpenAI, OpenAI, toFile: async () => ({}) }
})

const { prepareReview, reviewPreview, validateApproval, PROMPT_VERSION } = await import(
  './uploadReview'
)
const { processApprovedSession, ResultSaveError } = await import('./processSession')

const CANARIES = [
  'CANARYKEY1234567890abcdef',
  'canary.person@example.com',
  'CANARYPW99',
  'CANARYTOKEN77',
  'CANARYNARRATION',
  'CANARYCLIPKEY12345678'
]
const SID = 'tsess_review_fixture'
/** Event clock just after the session's real start, so narration aligns to actions. */
const BASE_MS = Date.now() + 1_000

function evt(sequence: number, partial: Partial<TelemetryEvent>): TelemetryEvent {
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: `tevt_rv_${sequence}`,
    sessionId: SID,
    sequence,
    timestamp: new Date(BASE_MS + sequence * 1000).toISOString(),
    elapsedMs: sequence * 1000,
    type: 'click',
    ...partial
  } as TelemetryEvent
}

const fixtureEvents: TelemetryEvent[] = [
  evt(0, { type: 'session_started', data: { message: 'Recording started' } }),
  evt(1, {
    type: 'app_switch',
    data: {
      appName: 'FixtureBrowser',
      documentTitle: 'https://fixture.example/reset?access_token=CANARYTOKEN77',
      urlHost: 'fixture.example',
      urlPath: '/reset'
    }
  }),
  evt(2, {
    type: 'click',
    data: { appName: 'FixtureBrowser', elementLabel: 'password=CANARYPW99', elementRole: 'AXButton' }
  }),
  evt(3, {
    type: 'text_input',
    data: {
      appName: 'FixtureBrowser',
      elementLabel: 'API key',
      elementRole: 'AXTextField',
      typedText: 'sk-proj-CANARYKEY1234567890abcdef',
      submitKey: 'Return'
    }
  }),
  evt(4, {
    type: 'text_input',
    data: {
      appName: 'FixtureBrowser',
      elementLabel: 'Contact',
      elementRole: 'AXTextField',
      typedText: 'canary.person@example.com'
    }
  }),
  evt(5, {
    type: 'clipboard_changed',
    data: {
      appName: 'FixtureBrowser',
      clipboard: {
        contentType: 'text',
        contentHash: 'synthetichash1',
        charCount: 24,
        text: 'sk-CANARYCLIPKEY12345678'
      }
    }
  }),
  evt(6, { type: 'session_stopped', data: { message: 'Recording stopped' } })
]

const config: TelemetryConfig = {
  storage: 'file',
  devDir: '/nonexistent',
  openaiApiKey: 'sk-test-synthetic-not-a-real-key-0000000000',
  openaiModel: 'test-model',
  isDev: true,
  isPackaged: false
}

function classifyOutput() {
  return {
    title: 'Synthetic fixture task',
    goal: null,
    summary: 'Open the fixture page and submit the form.',
    outcome: 'completed',
    steps: [
      {
        order: 1,
        action: 'Submit the fixture form',
        category: 'interaction',
        appName: 'FixtureBrowser',
        evidenceEventIds: ['e0'],
        confidence: 0.8
      }
    ],
    warnings: [],
    variables: null,
    addresses: null,
    commits: null,
    writes: null,
    inputs: null,
    authorizationScope: null,
    branches: null,
    questions: null
  }
}

function ok(output: unknown, id: string) {
  return async () => ({ output_parsed: output, id, _request_id: `req_${id}` })
}

async function savedFixture(): Promise<FileTelemetryStore> {
  const root = mkdtempSync(join(tmpdir(), 'gray-hf-review-'))
  const store = new FileTelemetryStore(root, { isPackaged: false, isDev: true })
  await store.createSession({ sessionId: SID })
  await store.appendEvents(SID, fixtureEvents)
  await store.saveNarration(SID, {
    sessionId: SID,
    spans: [{ text: 'CANARYNARRATION do the thing', startMs: 0, endMs: 60_000 }],
    transcribedAt: new Date(BASE_MS).toISOString()
  })
  await store.updateDelivery(
    SID,
    (d) => ({ ...d!, save: { state: 'complete' } }),
    { captureStatus: 'stopped', stoppedAt: new Date(BASE_MS + 10_000).toISOString() }
  )
  return store
}

function allOutbound(): string {
  return JSON.stringify(h.bodies)
}

beforeEach(() => {
  h.ctorOptions.length = 0
  h.bodies.length = 0
  h.respond.length = 0
})

describe('prepared review', () => {
  it('is local only and contains no canaries; preview shows exactly the payload', async () => {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(h.ctorOptions).toHaveLength(0)
    expect(h.bodies).toHaveLength(0)

    const preview = reviewPreview(r.review)
    expect(JSON.parse(preview.payloadText)).toEqual(r.review.body)
    expect(preview.exclusions.join(' ')).toMatch(/audio/i)
    expect(preview.exclusions.join(' ')).toMatch(/Screenshots/)
    const persisted = readFileSync(
      join((store as unknown as { root: string }).root, 'sessions', SID, 'review.json'),
      'utf8'
    )
    for (const c of CANARIES) {
      expect(persisted).not.toContain(c)
      expect(preview.payloadText).not.toContain(c)
    }
    // Narration did align to actions locally, but transcript fields are not sent in this build.
    const polished = await store.readPolishedSession(SID)
    expect(polished?.actions.some((a) => a.narrationText?.includes('CANARYNARRATION'))).toBe(true)
    expect(preview.payloadText).not.toMatch(/"nt"|"mk"/)
  })

  it('reopening the same evidence reuses the revision; changed evidence is a new revision', async () => {
    const store = await savedFixture()
    const a = await prepareReview(store, SID, 'test-model')
    const b = await prepareReview(store, SID, 'test-model')
    expect(a.ok && b.ok && a.review.revision === b.review.revision).toBe(true)
    await store.appendEvents(SID, [
      evt(7, { type: 'click', data: { appName: 'FixtureBrowser', elementLabel: 'Extra' } })
    ])
    const c = await prepareReview(store, SID, 'test-model')
    expect(c.ok && a.ok && c.review.revision).toBe(a.ok ? a.review.revision + 1 : -1)
  })

  it('an incomplete new-format save cannot be prepared', async () => {
    const store = await savedFixture()
    await store.updateDelivery(SID, (d) => ({
      ...d!,
      save: { state: 'incomplete', errorCode: 'EVENTS_NOT_PERSISTED' }
    }))
    expect(await prepareReview(store, SID, 'test-model')).toEqual({ ok: false, code: 'NOT_SAVED' })
  })
})

describe('approval validation', () => {
  it('rejects stale revision/digest, changed evidence, changed model and tampering', async () => {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    if (!r.ok) throw new Error('prepare failed')
    const { revision, digest } = r.review
    expect((await validateApproval(store, SID, revision, digest, 'test-model')).ok).toBe(true)
    expect(await validateApproval(store, SID, revision + 1, digest, 'test-model')).toEqual({
      ok: false,
      code: 'REVIEW_STALE'
    })
    expect(await validateApproval(store, SID, revision, 'f'.repeat(64), 'test-model')).toEqual({
      ok: false,
      code: 'REVIEW_STALE'
    })
    expect(await validateApproval(store, SID, revision, digest, 'other-model')).toEqual({
      ok: false,
      code: 'REVIEW_STALE'
    })
    // Tamper with the stored payload but keep its digest field.
    const tampered = { ...r.review, body: { ...r.review.body, injected: 'extra' } }
    await store.saveDeliveryArtifact(SID, 'review', tampered)
    expect((await validateApproval(store, SID, revision, digest, 'test-model')).ok).toBe(false)
    expect(h.bodies).toHaveLength(0)
  })

  it('changed evidence after preview makes the approval stale', async () => {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    if (!r.ok) throw new Error('prepare failed')
    await store.appendEvents(SID, [evt(8, { type: 'click', data: { appName: 'X' } })])
    expect(
      await validateApproval(store, SID, r.review.revision, r.review.digest, 'test-model')
    ).toEqual({ ok: false, code: 'REVIEW_STALE' })
  })

  it('pins the prompt version into the reviewed identity', () => {
    expect(PROMPT_VERSION).toMatch(/^c\d+-e\d+-w\d+-[a-f0-9]{8}$/)
  })
})

describe('approved operation (fake Responses boundary)', () => {
  async function approved() {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    if (!r.ok) throw new Error('prepare failed')
    return { store, review: r.review }
  }
  const attempt = { attemptId: 'att_fixture_1', workflowId: 'wf_fixture_1' }

  it('classify then extract from the frozen payload; no hidden retries; receipts persisted', async () => {
    const { store, review } = await approved()
    await store.updateDelivery(SID, (d) => ({
      ...d!,
      interpretation: { state: 'sending', ...attempt, digest: review.digest }
    }))
    h.respond.push(ok(classifyOutput(), 'resp_classify'), ok(classifyOutput(), 'resp_extract'))
    const result = await processApprovedSession(store, config, review, attempt)

    expect(h.ctorOptions).toEqual([expect.objectContaining({ maxRetries: 0 })])
    expect(h.bodies).toHaveLength(2)
    for (const body of h.bodies) expect(body.store).toBe(false)
    // Stage 1 user content is byte-identical to the approved payload.
    expect(h.bodies[0].input[1].content).toBe(JSON.stringify(review.body))
    // Stage 2 carries only the approved payload + sanitized classify output.
    const extractPayload = JSON.parse(h.bodies[1].input[1].content)
    expect(Object.keys(extractPayload).sort()).toEqual(['addrs', 'classified', 'telemetry'])
    expect(extractPayload.telemetry).toEqual(review.body)
    for (const c of CANARIES) expect(allOutbound()).not.toContain(c)

    expect(result.partial).toBe(false)
    expect(result.receipts.map((x) => [x.stage, x.responseId, x.requestId])).toEqual([
      ['classify', 'resp_classify', 'req_resp_classify'],
      ['extract', 'resp_extract', 'req_resp_extract']
    ])
    const stored = await store.getWorkflow(SID)
    expect(stored?.provenance).toMatchObject({
      workflowId: 'wf_fixture_1',
      reviewDigest: review.digest,
      attemptId: 'att_fixture_1'
    })
    expect(stored?.workflow.steps[0].evidenceEventIds.every((id) => id.startsWith('tevt_rv_'))).toBe(
      true
    )
  })

  it('an invalid extract is an explicit partial result, not silent success', async () => {
    const { store, review } = await approved()
    await store.updateDelivery(SID, (d) => ({ ...d!, interpretation: { state: 'sending' } }))
    h.respond.push(ok(classifyOutput(), 'r1'), ok({ nonsense: true }, 'r2'))
    const result = await processApprovedSession(store, config, review, attempt)
    expect(result.partial).toBe(true)
    expect(result.stored.workflow.warnings.join(' ')).toMatch(/first-stage interpretation only/)
  })

  it('a failed extract keeps the acknowledged classify checkpoint; retry does not resend it', async () => {
    const { store, review } = await approved()
    await store.updateDelivery(SID, (d) => ({ ...d!, interpretation: { state: 'sending' } }))
    h.respond.push(ok(classifyOutput(), 'r1'), async () => {
      throw Object.assign(new Error('Connection error.'), { status: undefined })
    })
    await expect(processApprovedSession(store, config, review, attempt)).rejects.toMatchObject({
      code: 'OPENAI_REQUEST_FAILED'
    })
    expect(h.bodies).toHaveLength(2)

    h.bodies.length = 0
    h.respond.push(ok(classifyOutput(), 'r3'))
    await processApprovedSession(store, config, review, { ...attempt, attemptId: 'att_fixture_2' })
    expect(h.bodies).toHaveLength(1)
    expect(h.bodies[0].input[0].content).not.toBe(h.bodies[0].input[1].content)
    expect(JSON.parse(h.bodies[0].input[1].content)).toHaveProperty('classified')
  })

  it('maps provider failures to safe codes and never fabricates a result', async () => {
    const { store, review } = await approved()
    await store.updateDelivery(SID, (d) => ({ ...d!, interpretation: { state: 'sending' } }))
    h.respond.push(async () => {
      throw Object.assign(new Error('401 Incorrect API key provided: sk-test-...'), { status: 401 })
    })
    await expect(processApprovedSession(store, config, review, attempt)).rejects.toMatchObject({
      code: 'OPENAI_AUTHENTICATION_FAILED'
    })
    h.respond.push(ok({ steps: 'not-an-array' }, 'bad'), ok({ steps: [] }, 'bad2'))
    await expect(processApprovedSession(store, config, review, attempt)).rejects.toMatchObject({
      code: 'OPENAI_INVALID_OUTPUT'
    })
    expect(await store.getWorkflow(SID)).toBeNull()
  })

  it('missing key fails before any client exists', async () => {
    const { store, review } = await approved()
    await expect(
      processApprovedSession(store, { ...config, openaiApiKey: null }, review, attempt)
    ).rejects.toMatchObject({ code: 'OPENAI_API_KEY_MISSING' })
    expect(h.ctorOptions).toHaveLength(0)
    expect(h.bodies).toHaveLength(0)
  })

  it('a result-write failure is RESULT_SAVE_FAILED with a local retry, not success', async () => {
    const { store, review } = await approved()
    await store.updateDelivery(SID, (d) => ({ ...d!, interpretation: { state: 'sending' } }))
    h.respond.push(ok(classifyOutput(), 'r1'), ok(classifyOutput(), 'r2'))
    const realSave = store.saveWorkflow.bind(store)
    const spy = vi.spyOn(store, 'saveWorkflow').mockRejectedValueOnce(new Error('ENOSPC'))
    let caught: unknown
    try {
      await processApprovedSession(store, config, review, attempt)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ResultSaveError)
    expect(await store.getWorkflow(SID)).toBeNull()
    spy.mockImplementation(realSave)
    await (caught as InstanceType<typeof ResultSaveError>).pending.save()
    expect((await store.getWorkflow(SID))?.provenance?.attemptId).toBe('att_fixture_1')
    expect(h.bodies).toHaveLength(2)
  })
})

describe('evidence contract (M1-HF2)', () => {
  const attempt = { attemptId: 'att_ev_1', workflowId: 'wf_ev_1' }

  async function approvedFixture() {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    if (!r.ok) throw new Error('prepare failed')
    await store.updateDelivery(SID, (d) => ({ ...d!, interpretation: { state: 'sending' } }))
    return { store, review: r.review }
  }
  function output(evidence: unknown[][]) {
    return {
      ...classifyOutput(),
      steps: evidence.map((ids, i) => ({
        order: i + 1,
        action: `Synthetic step ${i + 1}`,
        category: 'interaction',
        appName: 'FixtureBrowser',
        evidenceEventIds: ids,
        confidence: 0.7
      }))
    }
  }
  function aliases(review: { evidenceMap: Array<[string, string]> }) {
    return review.evidenceMap.map(([a]) => a)
  }

  it('aliases are a distinct namespace from action order; several map uniquely to approved events', async () => {
    const { review } = await approvedFixture()
    const a = aliases(review)
    expect(a.length).toBeGreaterThan(2)
    expect(a.every((x) => /^e\d+$/.test(x))).toBe(true)
    expect(new Set(review.evidenceMap.map(([, f]) => f)).size).toBe(a.length)
    const orders = (review.body.acts as Array<{ i: number }>).map((x) => String(x.i))
    expect(a.some((x) => orders.includes(x))).toBe(false)
  })

  it('model-facing requests carry aliases only; persisted citations are canonical approved ids', async () => {
    const { store, review } = await approvedFixture()
    const a = aliases(review)
    h.respond.push(ok(output([[a[0], a[1]], [a[2]]]), 'c'), ok(output([[a[1]], [a[2], a[0]]]), 'x'))
    const result = await processApprovedSession(store, config, review, attempt)
    // User-content datasets (not the instructions, which name the forbidden form) have no tevt_.
    for (const body of h.bodies) expect(body.input[1].content).not.toMatch(/tevt_/)
    const extract = JSON.parse(h.bodies[1].input[1].content)
    const telemetryIds = new Set((extract.telemetry.acts as Array<{ ids: string[] }>).flatMap((x) => x.ids))
    for (const step of extract.classified.steps) {
      for (const id of step.evidenceEventIds) expect(telemetryIds.has(id)).toBe(true)
    }
    const approved = new Set(review.evidenceMap.map(([, f]) => f))
    for (const step of result.stored.workflow.steps) {
      expect(step.evidenceEventIds.length).toBeGreaterThan(0)
      for (const id of step.evidenceEventIds) expect(approved.has(id)).toBe(true)
    }
    expect(result.partial).toBe(false)
  })

  it.each([
    ['unknown alias', ['e999']],
    ['action order number', ['1']],
    ['screen id', ['s0']],
    ['step id', ['step_1']],
    ['address id', ['addr_1']],
    ['canonical event id', ['tevt_rv_2']],
    ['mixed valid/invalid', ['e0', 'tevt_rv_2']]
  ])('valid classify + extract citing %s → verified partial, same identity, no extra request', async (_n, bad) => {
    const { store, review } = await approvedFixture()
    const a = aliases(review)
    h.respond.push(ok(output([[a[0]], [a[1]]]), 'c'), ok(output([bad, [a[1]]]), 'x'))
    const result = await processApprovedSession(store, config, review, attempt)
    expect(h.bodies).toHaveLength(2)
    expect(result.partial).toBe(true)
    expect(result.stored.provenance).toMatchObject({ workflowId: 'wf_ev_1', partial: true })
    expect(result.receipts.map((x) => x.stage)).toEqual(['classify', 'extract'])
    const approved = new Set(review.evidenceMap.map(([, f]) => f))
    for (const step of result.stored.workflow.steps) {
      for (const id of step.evidenceEventIds) expect(approved.has(id)).toBe(true)
    }
    expect(JSON.stringify(result.stored)).not.toContain('tevt_unknown')
  })

  it('empty classify evidence is never checkpointed; an invalid single fallback fails safely', async () => {
    const { store, review } = await approvedFixture()
    h.respond.push(ok(output([[]]), 'c'), ok(output([['1']]), 's'))
    await expect(processApprovedSession(store, config, review, attempt)).rejects.toMatchObject({
      code: 'OPENAI_UNKNOWN_EVIDENCE'
    })
    expect(h.bodies).toHaveLength(2)
    expect(await store.readDeliveryArtifact(SID, 'checkpoint')).toBeNull()
    expect(await store.getWorkflow(SID)).toBeNull()
  })

  it('a bad classification cannot poison retry: the retry re-requests classify', async () => {
    const { store, review } = await approvedFixture()
    const a = aliases(review)
    h.respond.push(ok(output([['s0']]), 'c1'), ok(output([['e999']]), 's1'))
    await expect(processApprovedSession(store, config, review, attempt)).rejects.toBeTruthy()
    h.bodies.length = 0
    h.respond.push(ok(output([[a[0]]]), 'c2'), ok(output([[a[0]]]), 'x2'))
    const retried = await processApprovedSession(store, config, review, {
      ...attempt,
      attemptId: 'att_ev_2'
    })
    expect(h.bodies).toHaveLength(2)
    expect(h.bodies[0].input[0].content).toMatch(/Classify telemetry/)
    expect(retried.stored.provenance?.workflowId).toBe('wf_ev_1')
  })

  it('poisoned or old-version checkpoints are rejected for reuse; valid ones are reused', async () => {
    const { store, review } = await approvedFixture()
    const a = aliases(review)
    const valid = (await (async () => {
      h.respond.push(ok(output([[a[0]]]), 'c'), async () => {
        throw new Error('Connection error.')
      })
      await processApprovedSession(store, config, review, attempt).catch(() => {})
      return store.readDeliveryArtifact(SID, 'checkpoint')
    })()) as { classified: { steps: Array<{ evidenceEventIds: string[] }> } }
    expect(valid).not.toBeNull()

    // Poisoned: shape-valid, digest-matching, but cites an id outside the approved set.
    const poisoned = JSON.parse(JSON.stringify(valid))
    poisoned.classified.steps[0].evidenceEventIds = ['tevt_not_approved']
    await store.saveDeliveryArtifact(SID, 'checkpoint', poisoned)
    h.bodies.length = 0
    h.respond.push(ok(output([[a[0]]]), 'c2'), ok(output([[a[0]]]), 'x2'))
    await processApprovedSession(store, config, review, attempt)
    expect(h.bodies).toHaveLength(2) // classify re-requested

    // Old v1 shape (pre-M1-HF2) is never reused.
    await store.saveDeliveryArtifact(SID, 'checkpoint', { ...valid, version: 1 })
    h.bodies.length = 0
    h.respond.push(ok(output([[a[0]]]), 'c3'), ok(output([[a[0]]]), 'x3'))
    await processApprovedSession(store, config, review, attempt)
    expect(h.bodies).toHaveLength(2)

    // Valid v2 checkpoint is reused: extract only.
    await store.saveDeliveryArtifact(SID, 'checkpoint', valid)
    h.bodies.length = 0
    h.respond.push(ok(output([[a[0]]]), 'x4'))
    await processApprovedSession(store, config, review, attempt)
    expect(h.bodies).toHaveLength(1)
  })

  it('a review approved under the previous prompt contract is stale (fresh approval required)', async () => {
    const store = await savedFixture()
    const r = await prepareReview(store, SID, 'test-model')
    if (!r.ok) throw new Error('prepare failed')
    expect(PROMPT_VERSION.startsWith('c2-e2-w9-')).toBe(true)
    const { reviewDigest } = await import('./uploadReview')
    const { digest: _d, revision, preparedAt, ...content } = r.review
    const older = { ...content, promptVersion: 'c1-e1-w8-00000000' }
    const olderDigest = reviewDigest(older)
    await store.saveDeliveryArtifact(SID, 'review', { ...older, digest: olderDigest, revision, preparedAt })
    expect(await validateApproval(store, SID, revision, olderDigest, 'test-model')).toEqual({
      ok: false,
      code: 'REVIEW_STALE'
    })
    expect(h.bodies).toHaveLength(0)
  })
})
