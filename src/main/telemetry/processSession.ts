import { newId } from '../../shared/id'
import type {
  PolishedSession,
  StoredAutomationScript,
  StoredWorkflowResult,
  TelemetrySessionMeta
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
import { extractWorkflow, toEditorWorkflow, type ExtractWorkflowDeps } from './workflow'

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
      const prior =
        opts.skipPolishIfPresent !== false ? await store.readPolishedSession(sessionId) : null
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
