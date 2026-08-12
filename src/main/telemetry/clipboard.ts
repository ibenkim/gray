import { createHash } from 'crypto'
import { clipboard } from 'electron'
import type { ClipboardContentType, ClipboardData } from '../../shared/telemetry/schema'
import { sanitizeTypedText, sanitizeUrl } from '../../shared/telemetry/sanitize'

const POLL_MS = 500
/** Persist redacted plaintext at or below this size; larger stays hash-only. */
const TEXT_PERSIST_MAX = 500
const SENSITIVE_RE =
  /(password|passwd|passcode|secret|token|auth|api[_-]?key|credit|card|cvv|ssn|pin|cookie|session)/i

export type ClipboardChange = {
  clipboard: ClipboardData
  /** Full value held in-memory for the session (also may appear redacted on clipboard.text). */
  rawValue?: string
}

export type ClipboardWatcherOptions = {
  pollMs?: number
  /** Hashes Ghost itself wrote — ignore so we don't echo our own clipboard. */
  ignoreHashes?: Set<string>
  readText?: () => string
  readFormats?: () => string[]
  now?: () => number
}

/**
 * Poll Electron clipboard for changes. Never registers global shortcuts,
 * so Cmd+C/V keep working in the target app.
 */
export class ClipboardWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastHash: string | null = null
  private readonly sessionValues = new Map<string, string>()
  private readonly ignoreHashes: Set<string>
  private readonly pollMs: number
  private readonly readText: () => string
  private readonly readFormats: () => string[]
  private onChange: ((change: ClipboardChange) => void) | null = null
  /** Most recent non-sensitive clipboard snapshot for paste inference. */
  private latest: { at: number; clipboard: ClipboardData } | null = null

  constructor(opts: ClipboardWatcherOptions = {}) {
    this.pollMs = opts.pollMs ?? POLL_MS
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

  start(onChange: (change: ClipboardChange) => void): void {
    this.onChange = onChange
    this.lastHash = null
    this.sessionValues.clear()
    this.latest = null
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.pollMs)
    this.tick()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.onChange = null
    // Keep sessionValues until the next start() so stop→process can still
    // resolve clipboard hashes into set_clipboard literals for replay.
    this.latest = null
    this.lastHash = null
  }

  /** In-memory session value for workflow variable promotion. */
  getRawValue(contentHash: string): string | undefined {
    return this.sessionValues.get(contentHash)
  }

  /** Snapshot of in-session clipboard plaintext (never persisted to JSONL). */
  snapshotSessionValues(): Map<string, string> {
    return new Map(this.sessionValues)
  }

  getLatest(): { at: number; clipboard: ClipboardData } | null {
    return this.latest
  }

  /** Test/helper: process a text snapshot without Electron. */
  ingestText(text: string, formats: string[] = ['text/plain']): ClipboardChange | null {
    return this.process(text, formats)
  }

  private tick(): void {
    const text = this.readText()
    const formats = this.readFormats()
    this.process(text, formats)
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

    if (trimmed) {
      this.sessionValues.set(contentHash, trimmed)
    }
    this.latest = { at: Date.now(), clipboard: clipboardData }

    const change: ClipboardChange = {
      clipboard: clipboardData,
      rawValue: trimmed || undefined
    }
    this.onChange?.(change)
    return change
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
