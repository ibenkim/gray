import { createHash } from 'crypto'
import { z } from 'zod'
import {
  type ReviewErrorCode,
  type SaveErrorCode,
  type TelemetrySessionMeta
} from '../../shared/telemetry/schema'
import type { RecordingSummary, ReviewPreview } from '../../shared/types'
import { userMessageForCode } from './errors'
import { extractAddresses } from './addresses'
import {
  MODEL_INPUT_CHAR_BUDGET,
  prepareWorkflowModelInput,
  type CompactModelAction,
  type CompactWorkflowModelInput,
  type PreparedWorkflowModelInput
} from './modelInput'
import { sanitizeModelString } from './modelSanitize'
import { polishSession } from './polish'
import {
  CLASSIFY_INSTRUCTIONS,
  CLASSIFY_INSTRUCTIONS_VERSION,
  EXTRACT_INSTRUCTIONS,
  EXTRACT_INSTRUCTIONS_VERSION,
  WORKFLOW_INSTRUCTIONS,
  WORKFLOW_INSTRUCTIONS_VERSION
} from './prompt'
import type { TelemetryStore } from './store/TelemetryStore'
import { extractWorkflowVariables } from './variables'

/**
 * Owner of the immutable prepared review (M1-HF): the exact sanitized text dataset a
 * user approves, its digest, and approval validation. Requests may only be built from
 * a validated prepared review — never from a fresh read of local capture data.
 */

export const REVIEW_PURPOSE = 'interpretation_text' as const
export const REVIEW_PROVIDER = 'openai' as const
export const REVIEW_POLICY_VERSION = 'm1hf-text-1'
export const PROMPT_VERSION = `c${CLASSIFY_INSTRUCTIONS_VERSION}-e${EXTRACT_INSTRUCTIONS_VERSION}-w${WORKFLOW_INSTRUCTIONS_VERSION}-${sha256(
  [CLASSIFY_INSTRUCTIONS, EXTRACT_INSTRUCTIONS, WORKFLOW_INSTRUCTIONS].join('\0')
).slice(0, 8)}`

export const REVIEW_STAGES =
  'Classify, then extract. If the classify result is unusable, one single-pass request replaces extract. The extract request repeats this payload plus the sanitized classify result.'

export const REVIEW_EXCLUSIONS = [
  'Screenshots and screen video',
  'Raw microphone audio',
  'Narration transcript (not included in this build)',
  'Raw clipboard contents',
  'The raw event archive, including secure-field values',
  'Automation compilation (stays held; this approval does not enable it)'
]

const DIGEST_RE = /^[a-f0-9]{64}$/

export const PreparedReviewSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(80),
    revision: z.number().int().positive(),
    digest: z.string().regex(DIGEST_RE),
    preparedAt: z.string().datetime(),
    provider: z.literal(REVIEW_PROVIDER),
    model: z.string().max(80),
    purpose: z.literal(REVIEW_PURPOSE),
    promptVersion: z.string().max(40),
    policyVersion: z.string().max(40),
    legacyUnverified: z.boolean(),
    inputFingerprint: z.string().regex(DIGEST_RE),
    body: z.record(z.unknown()),
    evidenceMap: z.array(z.tuple([z.string().max(12), z.string().max(80)])).max(4000),
    stats: z
      .object({
        actions: z.number().int().nonnegative(),
        elided: z.boolean(),
        bytes: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict()

export type PreparedReview = z.infer<typeof PreparedReviewSchema>

export type ReviewResult =
  | { ok: true; review: PreparedReview }
  | { ok: false; code: ReviewErrorCode }

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Deterministic JSON (sorted keys) so the digest identifies content, not key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Digest covers everything that defines the request, excluding revision/timestamp. */
export function reviewDigest(review: Omit<PreparedReview, 'digest' | 'revision' | 'preparedAt'>): string {
  return sha256(canonicalJson(review))
}

/**
 * New-format sessions need a verified complete save. Legacy sessions (no delivery
 * metadata) may be reviewed as available evidence, flagged unverified.
 */
export function reviewEligibility(
  meta: TelemetrySessionMeta
): { ok: true; legacyUnverified: boolean } | { ok: false; code: ReviewErrorCode } {
  if (meta.delivery) {
    const state = meta.delivery.save.state
    if (state === 'complete') return { ok: true, legacyUnverified: false }
    if (state === 'legacy_unverified') return { ok: true, legacyUnverified: true }
    return { ok: false, code: 'NOT_SAVED' }
  }
  return meta.captureStatus === 'stopped'
    ? { ok: true, legacyUnverified: true }
    : { ok: false, code: 'NOT_SAVED' }
}

function eventFingerprint(events: Array<{ eventId: string; sequence: number }>): string {
  return sha256(events.map((e) => `${e.eventId}:${e.sequence}`).join('\n'))
}

/** Remove fields this build never sends (narration) and sanitize address parameter values. */
function scrubAction(a: CompactModelAction): CompactModelAction {
  const { nt: _nt, mk: _mk, ...rest } = a
  return rest
}

function scrubBody(body: CompactWorkflowModelInput): CompactWorkflowModelInput {
  const out: CompactWorkflowModelInput = { ...body, acts: body.acts.map(scrubAction) }
  if (body.segs) out.segs = body.segs.map((s) => ({ ...s, acts: s.acts.map(scrubAction) }))
  if (body.addrs) {
    out.addrs = body.addrs.map((a) =>
      a.p
        ? {
            ...a,
            p: Object.fromEntries(
              Object.entries(a.p).map(([k, v]) => [k, sanitizeModelString(v, 80) ?? ''])
            )
          }
        : a
    )
  }
  return out
}

async function readCurrentReview(
  store: TelemetryStore,
  sessionId: string
): Promise<PreparedReview | null> {
  const parsed = PreparedReviewSchema.safeParse(
    await store.readDeliveryArtifact(sessionId, 'review')
  )
  return parsed.success && parsed.data.sessionId === sessionId ? parsed.data : null
}

/**
 * Prepare (or reuse) the immutable review for a saved session. Local-only: polishes
 * and packs existing evidence; creates no client and sends nothing.
 */
export async function prepareReview(
  store: TelemetryStore,
  sessionId: string,
  model: string
): Promise<ReviewResult> {
  const meta = await store.getSessionMeta(sessionId)
  if (!meta) return { ok: false, code: 'NOT_SAVED' }
  const eligible = reviewEligibility(meta)
  if (!eligible.ok) return eligible

  const { events, invalidLines } = await store.readSessionEventsChecked(sessionId)
  if (invalidLines > 0) return { ok: false, code: 'LOCAL_FILES_INVALID' }

  let polished
  try {
    polished = await polishSession(store, sessionId)
  } catch {
    return { ok: false, code: 'POLISH_FAILED' }
  }
  if (polished.actions.length === 0) return { ok: false, code: 'WORKFLOW_EMPTY_ACTIONS' }

  const variables = extractWorkflowVariables(events, polished)
  const addresses = extractAddresses(events, polished)
  const prepared = prepareWorkflowModelInput(meta, polished, { variables, addresses })
  const body = scrubBody(prepared.body)
  if (body.acts.length === 0) return { ok: false, code: 'WORKFLOW_EMPTY_ACTIONS' }
  const serialized = JSON.stringify(body)
  // No unreviewed chunked requests: an oversized dataset stays local.
  if (serialized.length > MODEL_INPUT_CHAR_BUDGET) return { ok: false, code: 'PREPARE_TOO_LARGE' }

  const content = {
    version: 1 as const,
    sessionId,
    provider: REVIEW_PROVIDER,
    model,
    purpose: REVIEW_PURPOSE,
    promptVersion: PROMPT_VERSION,
    policyVersion: REVIEW_POLICY_VERSION,
    legacyUnverified: eligible.legacyUnverified,
    inputFingerprint: eventFingerprint(events),
    body: body as Record<string, unknown>,
    evidenceMap: [...prepared.evidenceMap.entries()],
    stats: {
      actions: body.acts.length,
      elided: !!body.elided,
      bytes: Buffer.byteLength(serialized, 'utf8')
    }
  }
  const digest = reviewDigest(content)
  const existing = await readCurrentReview(store, sessionId)
  if (existing?.digest === digest) return { ok: true, review: existing }

  const review: PreparedReview = {
    ...content,
    revision: Math.max(existing?.revision ?? 0, meta.delivery?.review.revision ?? 0) + 1,
    digest,
    preparedAt: new Date().toISOString()
  }
  await store.saveDeliveryArtifact(sessionId, 'review', review)
  return { ok: true, review }
}

/**
 * Validate an approval against the stored review immediately before use: same
 * revision/digest, untampered content, unchanged evidence/model/policy, still eligible.
 */
export async function validateApproval(
  store: TelemetryStore,
  sessionId: string,
  revision: number,
  digest: string,
  model: string
): Promise<ReviewResult> {
  const meta = await store.getSessionMeta(sessionId)
  if (!meta) return { ok: false, code: 'NOT_SAVED' }
  const eligible = reviewEligibility(meta)
  if (!eligible.ok) return eligible
  const review = await readCurrentReview(store, sessionId)
  if (!review || review.revision !== revision || review.digest !== digest) {
    return { ok: false, code: 'REVIEW_STALE' }
  }
  const { digest: _d, revision: _r, preparedAt: _p, ...content } = review
  if (reviewDigest(content) !== digest) return { ok: false, code: 'REVIEW_STALE' }
  if (
    review.model !== model ||
    review.promptVersion !== PROMPT_VERSION ||
    review.policyVersion !== REVIEW_POLICY_VERSION ||
    review.legacyUnverified !== eligible.legacyUnverified
  ) {
    return { ok: false, code: 'REVIEW_STALE' }
  }
  const { events, invalidLines } = await store.readSessionEventsChecked(sessionId)
  if (invalidLines > 0) return { ok: false, code: 'LOCAL_FILES_INVALID' }
  if (eventFingerprint(events) !== review.inputFingerprint) return { ok: false, code: 'REVIEW_STALE' }
  return { ok: true, review }
}

/** Frozen request input reconstructed from the approved review only. */
export function toPreparedInput(review: PreparedReview): PreparedWorkflowModelInput {
  const evidenceMap = new Map(review.evidenceMap)
  return {
    body: review.body as unknown as CompactWorkflowModelInput,
    evidenceMap,
    resolveEvidence: (ids: string[]) => ids.map((id) => evidenceMap.get(id) ?? id).filter(Boolean),
    estimatedChars: review.stats.bytes
  }
}

export function reviewPreview(review: PreparedReview): ReviewPreview {
  const body = review.body as unknown as CompactWorkflowModelInput
  const categories = ['Recorded actions: app names, element labels and roles, action types']
  if (body.acts.some((a) => a.tx)) categories.push('Typed text after redaction')
  if (body.acts.some((a) => a.d || a.h) || body.screens?.length) {
    categories.push('Window/document titles and website host/path (credential URLs rejected)')
  }
  if (body.acts.some((a) => a.x != null || a.wx != null)) categories.push('Click coordinates')
  if (body.vars?.length) categories.push('Detected input variables with sanitized examples')
  if (body.addrs?.length) categories.push('Detected destinations (URL/file templates)')
  if (body.dur != null) categories.push('Recording duration and mode')
  return {
    sessionId: review.sessionId,
    revision: review.revision,
    digest: review.digest,
    provider: review.provider,
    model: review.model,
    purpose: 'Interpret this recording into a draft workflow',
    stages: REVIEW_STAGES,
    payloadText: JSON.stringify(body, null, 2),
    bytes: review.stats.bytes,
    actionCount: review.stats.actions,
    elided: review.stats.elided,
    categories,
    exclusions: REVIEW_EXCLUSIONS,
    legacyUnverified: review.legacyUnverified
  }
}

export const REVIEW_ERROR_TEXT: Record<ReviewErrorCode, string> = {
  POLISH_FAILED: 'The recording is saved, but its local review could not be prepared.',
  PREPARE_TOO_LARGE:
    'The recording is saved, but it is too long to review and send in one request in this build.',
  WORKFLOW_EMPTY_ACTIONS: 'The recording is saved, but it has no actions to interpret.',
  NOT_SAVED: 'This recording is not completely saved, so it cannot be sent.',
  LOCAL_FILES_INVALID:
    'Some saved files for this recording could not be read, so it cannot be reviewed.',
  REVIEW_STALE: 'The review changed since it was shown. Review it again before approving.'
}

export const SAVE_ERROR_TEXT: Record<SaveErrorCode, string> = {
  EVENTS_NOT_PERSISTED:
    'Some recorded steps are not written to disk yet. They are kept and can be saved again.',
  EVENTS_REJECTED: 'Some recorded steps could not be stored.',
  EVENTS_DROPPED: 'Some recorded steps were lost because the recorder fell behind.',
  ARTIFACT_FAILED: 'Some screenshots could not be saved.',
  AUDIO_INCOMPLETE: 'Narration audio may be incomplete.',
  MANIFEST_WRITE_FAILED: 'The recording could not be marked as saved.',
  STOP_FAILED: 'The recording could not be finished cleanly.',
  INTERRUPTED: 'Saving was interrupted before it finished (the app closed).',
  METADATA_INVALID: 'This recording’s save record could not be read.',
  START_FAILED: 'Recording could not start; nothing was captured after the failure.',
  SOURCE_TEARDOWN_FAILED:
    'An input monitor did not confirm it stopped, so this recording cannot be verified as complete.'
}

/** Save causes a same-session local retry can still fix (events retained in the outbox). */
const RETRYABLE_SAVE: SaveErrorCode[] = ['EVENTS_NOT_PERSISTED', 'MANIFEST_WRITE_FAILED']

/** Safe Library/toast summary — state, dates and counts only. */
export function toRecordingSummary(meta: TelemetrySessionMeta): RecordingSummary {
  const d = meta.delivery
  const save = d?.save
  const interp = d?.interpretation
  const approval = d?.review.approval
  return {
    sessionId: meta.sessionId,
    startedAt: meta.startedAt,
    ...(meta.stoppedAt ? { stoppedAt: meta.stoppedAt } : {}),
    saveState: save?.state ?? 'legacy_unverified',
    ...(save?.errorCode
      ? { saveErrorCode: save.errorCode, saveMessage: SAVE_ERROR_TEXT[save.errorCode] }
      : {}),
    canRetrySave:
      save?.state === 'incomplete' && !!save.errorCode && RETRYABLE_SAVE.includes(save.errorCode),
    reviewState: d?.review.state ?? 'pending',
    ...(d?.review.errorCode
      ? { reviewErrorCode: d.review.errorCode, reviewMessage: REVIEW_ERROR_TEXT[d.review.errorCode] }
      : {}),
    interpretationState: interp?.state ?? 'not_started',
    ...(interp?.errorCode
      ? {
          interpretationErrorCode: interp.errorCode,
          interpretationMessage: userMessageForCode(interp.errorCode)
        }
      : {}),
    ...(interp?.stage ? { stage: interp.stage } : {}),
    ...(approval
      ? {
          approvedAt: approval.approvedAt,
          approvedModel: approval.model,
          approvalCurrent:
            approval.revision === d?.review.revision && approval.digest === d?.review.digest
        }
      : {}),
    ...(interp?.partial ? { partial: true } : {}),
    ...(interp?.state === 'complete' && interp.workflowId ? { workflowId: interp.workflowId } : {}),
    ...(save?.storedEvents != null ? { storedEvents: save.storedEvents } : {}),
    ...(save?.artifacts ? { artifactsSaved: save.artifacts.saved } : {}),
    ...(save?.audio ? { audio: save.audio.state } : {})
  }
}
