import { z } from 'zod'
import { newId } from '../../shared/id'
import {
  ExtractedWorkflowSchema,
  StageReceiptSchema,
  type ExtractedWorkflow,
  type PolishedSession,
  type StageReceipt,
  type StoredAutomationScript,
  type StoredWorkflowResult,
  type TelemetrySessionMeta
} from '../../shared/telemetry/schema'
import { compileAutomationScript, type CompileAutomationDeps } from './automation/compile'
import type { TelemetryConfig } from './config'
import {
  TelemetryProcessingError,
  logProcessingFailure,
  userMessageForCode
} from './errors'
import { polishSession } from './polish'
import type { TelemetryStore } from './store/TelemetryStore'
import { toPreparedInput, type PreparedReview } from './uploadReview'
import {
  assertEvidenceIds,
  defaultClient,
  extractWorkflow,
  runStagedInterpretation,
  toEditorWorkflow,
  type ExtractWorkflowDeps,
  type OpenAIResponsesClient
} from './workflow'

const inFlight = new Set<string>()

export type ProcessWorkflowResult =
  | {
      ok: true
      sessionId: string
      polished: PolishedSession
      workflow: ReturnType<typeof toEditorWorkflow>
      extracted: StoredWorkflowResult['workflow']
      automation?: StoredAutomationScript | null
      meta: TelemetrySessionMeta
    }
  | {
      ok: false
      sessionId: string
      error: string
      errorCode: string
      polished?: PolishedSession
      meta?: TelemetrySessionMeta
    }

/**
 * Polish (if needed) + OpenAI summarization + non-fatal automation compile.
 * Idempotent for complete sessions. Preserves polished data when AI fails.
 */
export async function processSessionWorkflow(
  store: TelemetryStore,
  config: TelemetryConfig,
  sessionId: string,
  opts: {
    skipPolishIfPresent?: boolean
    deps?: ExtractWorkflowDeps
    compileDeps?: CompileAutomationDeps
    skipCompile?: boolean
  } = {}
): Promise<ProcessWorkflowResult> {
  if (inFlight.has(sessionId)) {
    return {
      ok: false,
      sessionId,
      error: userMessageForCode('WORKFLOW_ALREADY_RUNNING'),
      errorCode: 'WORKFLOW_ALREADY_RUNNING'
    }
  }

  inFlight.add(sessionId)
  try {
    let meta = await store.getSessionMeta(sessionId)
    if (!meta) {
      return {
        ok: false,
        sessionId,
        error: userMessageForCode('SESSION_NOT_READY'),
        errorCode: 'SESSION_NOT_READY'
      }
    }

    if (meta.captureStatus === 'recording') {
      return {
        ok: false,
        sessionId,
        error: userMessageForCode('SESSION_NOT_READY'),
        errorCode: 'SESSION_NOT_READY',
        meta
      }
    }

    const existing = await store.getWorkflow(sessionId)
    if (meta.processingStatus === 'complete' && existing) {
      const editor = toEditorWorkflow(existing.workflow, newId('wf'), sessionId)
      const automation =
        store.getAutomationScript ? await store.getAutomationScript(sessionId) : null
      return {
        ok: true,
        sessionId,
        polished: (await store.readPolishedSession(sessionId)) ?? {
          sessionId,
          schemaVersion: 1,
          polishedAt: new Date().toISOString(),
          sequenceRange: { min: 0, max: 0 },
          actions: []
        },
        workflow: editor,
        extracted: existing.workflow,
        automation,
        meta
      }
    }

    // ── polish ──
    meta = await store.updateSessionMeta(sessionId, {
      processingStatus: 'polishing',
      processingErrorCode: null
    })

    let polished: PolishedSession
    try {
      // Re-interpretation always restarts from L0 unless explicitly opted out —
      // otherwise prompt improvements cannot recover information an earlier polish discarded.
      const prior =
        opts.skipPolishIfPresent === true ? await store.readPolishedSession(sessionId) : null
      polished = prior ?? (await polishSession(store, sessionId))
    } catch (err) {
      logProcessingFailure('polish', err)
      meta = await store.updateSessionMeta(sessionId, {
        captureStatus: 'stopped',
        processingStatus: 'failed',
        processingErrorCode: 'POLISH_FAILED'
      })
      return {
        ok: false,
        sessionId,
        error: userMessageForCode('POLISH_FAILED'),
        errorCode: 'POLISH_FAILED',
        meta
      }
    }

    // ── summarize ──
    meta = await store.updateSessionMeta(sessionId, {
      captureStatus: 'stopped',
      processingStatus: 'summarizing',
      processingErrorCode: null
    })

    try {
      const stored = await extractWorkflow(store, config, meta, polished, opts.deps)
      meta = await store.updateSessionMeta(sessionId, {
        captureStatus: 'stopped',
        processingStatus: 'complete',
        processingErrorCode: null
      })

      let automation: StoredAutomationScript | null = null
      if (!opts.skipCompile) {
        try {
          automation = await compileAutomationScript(
            store,
            config,
            sessionId,
            stored.workflow,
            polished,
            opts.compileDeps
          )
        } catch (compileErr) {
          logProcessingFailure('automation-compile', compileErr)
          automation = store.getAutomationScript
            ? await store.getAutomationScript(sessionId)
            : null
        }
      }

      return {
        ok: true,
        sessionId,
        polished,
        workflow: toEditorWorkflow(stored.workflow, newId('wf'), sessionId),
        extracted: stored.workflow,
        automation,
        meta
      }
    } catch (err) {
      const mapped =
        err instanceof TelemetryProcessingError ? err : new TelemetryProcessingError('OPENAI_REQUEST_FAILED')
      const code = logProcessingFailure('workflow', err)
      meta = await store.updateSessionMeta(sessionId, {
        captureStatus: 'stopped',
        processingStatus: 'failed',
        processingErrorCode: mapped.code ?? code
      })
      return {
        ok: false,
        sessionId,
        error: userMessageForCode(mapped.code),
        errorCode: mapped.code,
        polished,
        meta
      }
    }
  } finally {
    inFlight.delete(sessionId)
  }
}

export function __resetProcessingLocksForTests(): void {
  inFlight.clear()
}

/**
 * Acknowledged, evidence-validated classify output for one approved revision; lets an
 * explicit retry skip it. v2: only validated classifications are ever written, and every
 * load is revalidated against the approved evidence map (v1 checkpoints are never reused).
 */
const CHECKPOINT_VERSION = 2
const CheckpointSchema = z
  .object({
    version: z.literal(CHECKPOINT_VERSION),
    revision: z.number().int().positive(),
    digest: z.string(),
    attemptId: z.string(),
    classified: ExtractedWorkflowSchema,
    receipts: z.array(StageReceiptSchema).max(6)
  })
  .strict()

/** Reuse a checkpoint only if it matches this approval and every citation is approved evidence. */
async function loadValidCheckpoint(
  store: TelemetryStore,
  review: PreparedReview,
  approvedIds: Set<string>
): Promise<z.infer<typeof CheckpointSchema> | null> {
  const raw = await store.readDeliveryArtifact(review.sessionId, 'checkpoint')
  if (raw == null) return null
  const parsed = CheckpointSchema.safeParse(raw)
  const valid =
    parsed.success &&
    parsed.data.digest === review.digest &&
    parsed.data.revision === review.revision &&
    parsed.data.classified.steps.every(
      (s) => s.evidenceEventIds.length > 0 && s.evidenceEventIds.every((id) => approvedIds.has(id))
    )
  if (!valid) {
    console.info('[telemetry] checkpoint rejected for reuse')
    return null
  }
  console.info('[telemetry] checkpoint reused stage=classify')
  return parsed.data
}

export class ResultSaveError extends TelemetryProcessingError {
  constructor(readonly pending: { workflow: ExtractedWorkflow; save: () => Promise<StoredWorkflowResult> }) {
    super('RESULT_SAVE_FAILED')
  }
}

/**
 * The single approved interpretation operation (M1-HF). Builds every request only from
 * the validated prepared review; never re-reads capture data and never compiles.
 * Stage start/acknowledgement is persisted so progress and checkpoints survive a restart.
 */
export async function processApprovedSession(
  store: TelemetryStore,
  config: TelemetryConfig,
  review: PreparedReview,
  attempt: { attemptId: string; workflowId: string },
  deps: { createClient?: (apiKey: string) => OpenAIResponsesClient; onProgress?: () => void } = {}
): Promise<{ stored: StoredWorkflowResult; partial: boolean; receipts: StageReceipt[] }> {
  if (!config.openaiApiKey) throw new TelemetryProcessingError('OPENAI_API_KEY_MISSING')
  const sessionId = review.sessionId
  const prepared = toPreparedInput(review)
  const approvedIds = new Set(prepared.evidenceMap.values())
  // Each alias must map to exactly one approved event (and vice versa).
  if (approvedIds.size !== prepared.evidenceMap.size) {
    throw new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
  }
  const checkpoint = await loadValidCheckpoint(store, review, approvedIds)
  const receipts: StageReceipt[] = checkpoint ? [...checkpoint.receipts] : []

  const client = (deps.createClient ?? defaultClient)(config.openaiApiKey)
  const { workflow, usage, partial } = await runStagedInterpretation(
    client,
    review.model,
    prepared,
    // Deterministic local enrichment is skipped: nothing beyond the approved dataset.
    [],
    [],
    {
      classifyCheckpoint: checkpoint ? { classified: checkpoint.classified } : undefined,
      onStageStart: async (stage) => {
        await store.updateDelivery(sessionId, (d) => ({
          ...d!,
          interpretation: { ...d!.interpretation, stage }
        }))
        deps.onProgress?.()
      },
      onStageAcknowledged: async (stage, receipt, classified) => {
        const r: StageReceipt = {
          stage,
          attemptId: attempt.attemptId,
          ...receipt,
          at: new Date().toISOString()
        }
        receipts.push(r)
        // Only an evidence-valid classification becomes reusable; receipts persist regardless.
        if (stage === 'classify' && classified) {
          await store.saveDeliveryArtifact(sessionId, 'checkpoint', {
            version: CHECKPOINT_VERSION,
            revision: review.revision,
            digest: review.digest,
            attemptId: attempt.attemptId,
            classified,
            receipts: [r]
          })
        }
        await store.updateDelivery(sessionId, (d) => ({
          ...d!,
          interpretation: { ...d!.interpretation, receipts: receipts.slice(-6) }
        }))
        deps.onProgress?.()
      }
    }
  )
  // Defense in depth: stages already validated; the persisted result must still match.
  assertEvidenceIds(workflow, approvedIds)

  const save = () =>
    store.saveWorkflow(sessionId, workflow, review.model, {
      usage,
      provenance: {
        workflowId: attempt.workflowId,
        reviewRevision: review.revision,
        reviewDigest: review.digest,
        attemptId: attempt.attemptId,
        partial,
        receipts: receipts.slice(-6)
      }
    })
  let stored: StoredWorkflowResult
  try {
    stored = await save()
  } catch {
    // A received result is not success until it is durable; keep it for a local retry.
    throw new ResultSaveError({ workflow, save })
  }
  return { stored, partial, receipts }
}
