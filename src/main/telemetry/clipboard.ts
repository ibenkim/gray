import { createHash } from 'crypto'
import { clipboard } from 'electron'
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
  /** Hashes Ghost itself wrote — ignore so we don't echo our own clipboard. */
  ignoreHashes?: Set<string>
  readText?: () => string
  readFormats?: () => string[]
  now?: () => number
}

/**
 * Reads the clipboard only when asked (M3-B): the recorder calls `readNow` after an observed
 * in-scope copy/cut chord. No timer, no read at Start/Resume, no raw plaintext kept. Never
 * registers global shortcuts, so Cmd+C/V keep working in the target app.
 */
export class ClipboardWatcher {
  private lastHash: string | null = null
  private readonly ignoreHashes: Set<string>
  private readonly readText: () => string
  private readonly readFormats: () => string[]
  /** Most recent non-sensitive clipboard snapshot for paste inference. */
  private latest: { at: number; clipboard: ClipboardData } | null = null

  constructor(opts: ClipboardWatcherOptions = {}) {
    this.ignoreHashes = opts.ignoreHashes ?? new Set()
    this.readText =
      opts.readText ??
      (() => {
        try {
          return clipboard.readText() || ''
        } catch {
          return ''
        }
      })
    this.readFormats =
      opts.readFormats ??
      (() => {
        try {
          return clipboard.availableFormats()
        } catch {
          return []
        }
      })
  }

  /** Forget the previous session's copy (de-duplication and paste matching start clean). */
  reset(): void {
    this.latest = null
    this.lastHash = null
  }

  /** One read after an observed in-scope copy; null when unchanged, sensitive or empty. */
  readNow(): ClipboardChange | null {
    return this.process(this.readText(), this.readFormats())
  }

  getLatest(): { at: number; clipboard: ClipboardData } | null {
    return this.latest
  }

  /** Test/helper: process a text snapshot without Electron. */
  ingestText(text: string, formats: string[] = ['text/plain']): ClipboardChange | null {
    return this.process(text, formats)
  }

  private process(text: string, formats: string[]): ClipboardChange | null {
    const trimmed = text ?? ''
    const contentHash = hashContent(trimmed, formats)
    if (contentHash === this.lastHash) return null
    this.lastHash = contentHash

    if (this.ignoreHashes.has(contentHash)) return null
    if (!trimmed && !formats.some((f) => f.includes('image') || f.includes('file'))) {
      return null
    }
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

    this.latest = { at: Date.now(), clipboard: clipboardData }
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
  if (formats.some((f) => /image\//i.test(f))) return 'image'
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
