const MAX_MODEL_STRING = 160

const API_KEY_RE = /\b(sk-[A-Za-z0-9_\-]{8,}|sk-proj-[A-Za-z0-9_\-]{8,})\b/gi
const API_KEY_ERR_RE = /Incorrect API key provided:?\s*/gi
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const TOKEN_RE =
  /\b(api[_-]?key|token|password|secret|authorization|bearer)\s*[:=]\s*\S+/gi
const TMPDIR_RE = /\bTMPDIR\s*=\s*\S+/gi
const CF_BUNDLE_RE = /\b__CFBundleIdentifier\s*=\s*\S+/gi
const XPC_FLAGS_RE = /\bXPC_FLAGS\s*=\s*\S+/gi
const VAR_FOLDERS_RE = /\/var\/folders\/[^\s]+/gi
const ABS_PATH_RE = /(?:^|[\s"'`])(\/(?:Users|home|tmp|private|var|opt|Library)\/[^\s"'`]+)/g
const WIN_PATH_RE = /[A-Za-z]:\\[^\s"'`]+/g

/**
 * Server-side sanitizer for strings bound for the OpenAI model.
 * Does not modify evidence / source event IDs (callers must not pass those through this).
 */
export function sanitizeModelString(
  value: string | null | undefined,
  max = MAX_MODEL_STRING
): string | null {
  if (value == null) return null
  let s = String(value)
  s = s.replace(API_KEY_ERR_RE, '')
  s = s.replace(API_KEY_RE, '[redacted-key]')
  s = s.replace(EMAIL_RE, '[email]')
  s = s.replace(TOKEN_RE, '$1=[redacted]')
  s = s.replace(TMPDIR_RE, 'TMPDIR=[redacted]')
  s = s.replace(CF_BUNDLE_RE, '__CFBundleIdentifier=[redacted]')
  s = s.replace(XPC_FLAGS_RE, 'XPC_FLAGS=[redacted]')
  s = s.replace(VAR_FOLDERS_RE, '[tmp-path]')
  s = s.replace(ABS_PATH_RE, (m) =>
    m.replace(/\/(?:Users|home|tmp|private|var|opt|Library)\/[^\s"'`]+/, '[path]')
  )
  s = s.replace(WIN_PATH_RE, '[path]')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (s.length > max) return `${s.slice(0, max - 1)}…`
  return s
}

export function looksLikeApiKeyMaterial(text: string): boolean {
  return /sk-[A-Za-z0-9_\-]{8,}/i.test(text) || /Incorrect API key provided/i.test(text)
}
