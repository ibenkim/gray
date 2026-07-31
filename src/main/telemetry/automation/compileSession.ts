import type { StoredAutomationScript } from '../../../shared/telemetry/schema'
import type { TelemetryConfig } from '../config'
import {
  TelemetryProcessingError,
  logProcessingFailure,
  userMessageForCode
} from '../errors'
import type { TelemetryStore } from '../store/TelemetryStore'
import { compileAutomationScript, type CompileAutomationDeps } from './compile'

export type CompileSessionResult =
  | {
      ok: true
      sessionId: string
      automation: StoredAutomationScript
    }
  | {
      ok: false
      sessionId: string
      error: string
      errorCode: string
    }

/**
 * Retry / standalone compile for a session that already has a stored workflow.
 */
export async function compileSessionAutomation(
  store: TelemetryStore,
  config: TelemetryConfig,
  sessionId: string,
  deps: CompileAutomationDeps = {}
): Promise<CompileSessionResult> {
  const meta = await store.getSessionMeta(sessionId)
  if (!meta || meta.captureStatus === 'recording') {
    return {
      ok: false,
      sessionId,
      error: userMessageForCode('SESSION_NOT_READY'),
      errorCode: 'SESSION_NOT_READY'
    }
  }

  const stored = await store.getWorkflow(sessionId)
  const polished = await store.readPolishedSession(sessionId)
  if (!stored || !polished || polished.actions.length === 0) {
    return {
      ok: false,
      sessionId,
      error: userMessageForCode('SESSION_NOT_READY'),
      errorCode: 'SESSION_NOT_READY'
    }
  }

  try {
    const automation = await compileAutomationScript(
      store,
      config,
      sessionId,
      stored.workflow,
      polished,
      deps
    )
    return { ok: true, sessionId, automation }
  } catch (err) {
    const mapped =
      err instanceof TelemetryProcessingError
        ? err
        : new TelemetryProcessingError('AUTOMATION_COMPILE_FAILED')
    logProcessingFailure('automation-compile', err)
    return {
      ok: false,
      sessionId,
      error: userMessageForCode(mapped.code),
      errorCode: mapped.code
    }
  }
}
