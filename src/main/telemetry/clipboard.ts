import { createHash } from 'crypto'
import type { ClipboardContentType, ClipboardData } from '../../shared/telemetry/schema'
import { sanitizeTypedText, sanitizeUrl } from '../../shared/telemetry/sanitize'

/** Persist redacted plaintext at or below this size; larger stays hash-only. */
const TEXT_PERSIST_MAX = 500
const SENSITIVE_RE =
  /(password|passwd|passcode|secret|token|auth|api[_-]?key|credit|card|cvv|ssn|pin|cookie|session)/i

export type ClipboardChange = {
  clipboard: ClipboardData
}

export type ClipboardWatcherOptions = {
  /** Hashes Gray itself wrote — ignore so we don't echo our own clipboard. */
  ignoreHashes?: Set<string>
}

/**
 * Classifies a verified copy (M3-B). The main process never reads the clipboard: the
 * accessibility sensor reads it once, after an in-scope Cmd/Ctrl+C|X that changed the
 * pasteboard exactly once (see `checkCopy` in ax/jxaScript.ts). No raw plaintext is kept.
 */
export class ClipboardWatcher {
  private lastHash: string | null = null
  private readonly ignoreHashes: Set<string>
  /** Most recent recorded copy and the pasteboard changeCount it was read at. */
  private latest: { at: number; clipboard: ClipboardData; pasteboard?: number } | null = null

  constructor(opts: ClipboardWatcherOptions = {}) {
    this.ignoreHashes = opts.ignoreHashes ?? new Set()
  }

  /** Forget the previous session's copy (de-duplication and paste matching start clean). */
  reset(): void {
    this.latest = null
    this.lastHash = null
  }

  /**
   * The last recorded copy, only while the pasteboard still holds it: `pasteboard` is the
   * current changeCount, so content copied elsewhere since (or never verified) matches nothing.
   */
  getLatest(pasteboard?: number): { at: number; clipboard: ClipboardData } | null {
    const latest = this.latest
    if (!latest || latest.pasteboard === undefined || latest.pasteboard !== pasteboard) return null
    return latest
  }

  /** One verified copy; null when unchanged, sensitive or empty. */
  ingestText(text: string, formats: string[] = ['text/plain'], pasteboard?: number): ClipboardChange | null {
    return this.process(text, formats, pasteboard)
  }

  private process(text: string, formats: string[], pasteboard?: number): ClipboardChange | null {
    const trimmed = text ?? ''
    const contentHash = hashContent(trimmed, formats)
    if (contentHash === this.lastHash) return null
    this.lastHash = contentHash

    if (this.ignoreHashes.has(contentHash)) return null
    if (!trimmed && !['image', 'file'].includes(classifyContent('', formats))) return null
    if (looksSensitive(trimmed)) return null

    const contentType = classifyContent(trimmed, formats)
    const sanitized =
      contentType === 'url' ? sanitizeUrl(trimmed.trim()) : ({} as ReturnType<typeof sanitizeUrl>)
    if (sanitized.rejected) return null

    let persistedText: string | undefined
    if (
      trimmed &&
      trimmed.length <= TEXT_PERSIST_MAX &&
      (contentType === 'text' || contentType === 'url')
    ) {
      const { text } = sanitizeTypedText(trimmed)
      persistedText = text
    }

    const clipboardData: ClipboardData = {
      contentType,
      urlHost: sanitized.urlHost,
      urlPath: sanitized.urlPath,
      urlQuery: sanitized.urlQuery,
      charCount: trimmed.length,
      contentHash,
      text: persistedText
    }

    this.latest = { at: Date.now(), clipboard: clipboardData, pasteboard }
    return { clipboard: clipboardData }
  }
}

export function hashContent(text: string, formats: string[] = []): string {
  return createHash('sha256')
    .update(formats.slice().sort().join(','))
    .update('\0')
    .update(text)
    .digest('hex')
    .slice(0, 32)
}

export function classifyContent(text: string, formats: string[]): ClipboardContentType {
  if (formats.some((f) => /image\/|^public\.(png|tiff|jpeg|heic)$/i.test(f))) return 'image'
  if (formats.some((f) => /file/i.test(f) || /public\.file/i.test(f))) return 'file'
  const t = text.trim()
  if (!t) return formats.length ? 'other' : 'text'
  if (/^https?:\/\//i.test(t)) return 'url'
  try {
    const u = new URL(t)
    if (u.protocol === 'http:' || u.protocol === 'https:') return 'url'
  } catch {
    /* not a url */
  }
  return 'text'
}

export function looksSensitive(text: string): boolean {
  if (!text) return false
  if (SENSITIVE_RE.test(text)) return true
  if (/\bsk-[A-Za-z0-9_\-]{8,}\b/.test(text)) return true
  if (/bearer\s+[A-Za-z0-9._\-]+/i.test(text)) return true
  return false
}

/**
 * Infer a paste when a focused text field's char count jumps by ~clipboard length
 * within `windowMs` of a clipboard_changed event.
 */
export function inferPaste(opts: {
  fieldCharCountBefore: number
  fieldCharCountAfter: number
  clipboard: ClipboardData
  clipboardAt: number
  now: number
  windowMs?: number
}): { matched: boolean; charCountDelta: number } {
  const windowMs = opts.windowMs ?? 3000
  const delta = opts.fieldCharCountAfter - opts.fieldCharCountBefore
  const clipLen = opts.clipboard.charCount ?? 0
  if (opts.now - opts.clipboardAt > windowMs) return { matched: false, charCountDelta: delta }
  if (clipLen <= 0 || delta <= 0) return { matched: false, charCountDelta: delta }
  // Allow small tolerance for trailing newlines / wrapping.
  const matched = Math.abs(delta - clipLen) <= 2 || delta >= clipLen
  return { matched, charCountDelta: delta }
}
