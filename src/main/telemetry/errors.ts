import type { ProcessingErrorCode } from '../../shared/telemetry/schema'
import { looksLikeApiKeyMaterial } from './modelSanitize'

export class TelemetryProcessingError extends Error {
  readonly code: ProcessingErrorCode

  constructor(code: ProcessingErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'TelemetryProcessingError'
    this.code = code
  }
}

export const SAFE_USER_MESSAGES: Record<ProcessingErrorCode, string> = {
  OPENAI_API_KEY_MISSING:
    'Workflow processing is unavailable because the OpenAI API configuration is invalid.',
  OPENAI_AUTHENTICATION_FAILED:
    'Workflow processing is unavailable because the OpenAI API configuration is invalid.',
  OPENAI_REQUEST_FAILED: 'Workflow processing failed. Your recording was saved and can be retried.',
  OPENAI_INVALID_OUTPUT:
    'Workflow processing returned an invalid result. Your recording was saved and can be retried.',
  OPENAI_UNKNOWN_EVIDENCE:
    'Workflow processing returned unsupported evidence references. Your recording was saved and can be retried.',
  POLISH_FAILED: 'Could not polish this recording. Try recording again.',
  WORKFLOW_EMPTY_ACTIONS: 'Not enough recorded actions to summarize a workflow.',
  WORKFLOW_ALREADY_RUNNING: 'Workflow processing is already running for this session.',
  SESSION_NOT_READY: 'This session is not ready for workflow processing.',
  AUTOMATION_COMPILE_FAILED:
    'Could not compile an automation script for this workflow. You can retry compile later.',
  AUTOMATION_SCRIPT_MISSING:
    'No automation script is available for this workflow yet. Recompile or run with the mock engine.',
  AUTOMATION_ACCESSIBILITY_DENIED:
    'Accessibility permission is required to run automated workflows.'
}

export function userMessageForCode(code: ProcessingErrorCode): string {
  return SAFE_USER_MESSAGES[code]
}

/** Map vendor / runtime errors to safe codes. Never forward raw messages upstream. */
export function mapToProcessingError(err: unknown): TelemetryProcessingError {
  if (err instanceof TelemetryProcessingError) return err

  const status =
    typeof err === 'object' && err && 'status' in err
      ? Number((err as { status?: number }).status)
      : undefined
  const msg = err instanceof Error ? err.message : String(err)

  if (/OPENAI_API_KEY is not set|API key is missing|API_KEY_MISSING/i.test(msg)) {
    return new TelemetryProcessingError('OPENAI_API_KEY_MISSING')
  }
  if (status === 401 || /401|Incorrect API key|authentication|unauthorized/i.test(msg)) {
    return new TelemetryProcessingError('OPENAI_AUTHENTICATION_FAILED')
  }
  if (/unknown evidence|evidenceEventId/i.test(msg)) {
    return new TelemetryProcessingError('OPENAI_UNKNOWN_EVIDENCE')
  }
  if (/invalid|structured|ZodError|output_parsed|parse/i.test(msg)) {
    return new TelemetryProcessingError('OPENAI_INVALID_OUTPUT')
  }
  if (/empty actions|no polished actions/i.test(msg)) {
    return new TelemetryProcessingError('WORKFLOW_EMPTY_ACTIONS')
  }
  if (looksLikeApiKeyMaterial(msg)) {
    return new TelemetryProcessingError('OPENAI_AUTHENTICATION_FAILED')
  }
  return new TelemetryProcessingError('OPENAI_REQUEST_FAILED')
}

/** Log only safe code — never the vendor body. */
export function logProcessingFailure(scope: string, err: unknown): ProcessingErrorCode {
  const mapped = mapToProcessingError(err)
  console.error(`[telemetry] ${scope} failed code=${mapped.code}`)
  return mapped.code
}
