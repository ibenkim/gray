import type { TelemetryEvent, TelemetryEventData, ValueCategory } from './schema'

const MAX_LABEL = 80
const MAX_TITLE = 200
const MAX_PATH = 200

/** Field names / types treated as sensitive by default. */
const SENSITIVE_NAME_RE =
  /(password|passwd|passcode|secret|token|auth|authorization|api[_-]?key|credit|card|cvv|ssn|pin|cookie|session)/i

const SENSITIVE_TYPES = new Set([
  'password',
  'email',
  'tel',
  'phone',
  'credit-card',
  'card',
  'token',
  'hidden',
  'secret'
])

/** Explicit allowlist of analytics ids whose sanitized values may be recorded. */
const VALUE_ALLOWLIST = new Set<string>([
  // Add `data-analytics-id` values here when a field's sanitized value is safe.
])

export function truncate(text: string | undefined | null, max: number): string | undefined {
  if (text == null) return undefined
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned
}

export function isSensitiveField(opts: {
  label?: string
  fieldType?: string
  name?: string
  analyticsId?: string
}): boolean {
  if (opts.fieldType && SENSITIVE_TYPES.has(opts.fieldType.toLowerCase())) return true
  if (opts.label && SENSITIVE_NAME_RE.test(opts.label)) return true
  if (opts.name && SENSITIVE_NAME_RE.test(opts.name)) return true
  if (opts.analyticsId && SENSITIVE_NAME_RE.test(opts.analyticsId)) return true
  return false
}

export function isValueAllowlisted(analyticsId?: string): boolean {
  return !!analyticsId && VALUE_ALLOWLIST.has(analyticsId)
}

export function categorizeValue(
  value: unknown,
  opts: { fieldType?: string; sensitive?: boolean } = {}
): ValueCategory {
  if (opts.sensitive) return 'sensitive'
  if (value == null || value === '') return 'empty'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (opts.fieldType === 'email') return 'email'
  if (opts.fieldType === 'tel' || opts.fieldType === 'phone') return 'phone'
  if (opts.fieldType === 'url') return 'url'
  if (opts.fieldType === 'date' || opts.fieldType === 'datetime-local') return 'date'
  if (typeof value === 'string') {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'email'
    if (/^https?:\/\//i.test(value)) return 'url'
    if (/^\+?[\d\s().-]{7,}$/.test(value)) return 'phone'
    return 'text'
  }
  return 'unknown'
}

export function sanitizeFieldValue(opts: {
  value: unknown
  label?: string
  fieldType?: string
  name?: string
  analyticsId?: string
  privateMarked?: boolean
}): {
  completed: boolean
  valueCategory: ValueCategory
  valueLength?: number
  sanitizedValue?: string
} {
  const sensitive =
    opts.privateMarked ||
    isSensitiveField({
      label: opts.label,
      fieldType: opts.fieldType,
      name: opts.name,
      analyticsId: opts.analyticsId
    })

  const completed =
    opts.value != null && opts.value !== '' && !(typeof opts.value === 'boolean' && !opts.value)

  const valueCategory = categorizeValue(opts.value, {
    fieldType: opts.fieldType,
    sensitive
  })

  const valueLength =
    typeof opts.value === 'string'
      ? opts.value.length
      : opts.value == null
        ? 0
        : String(opts.value).length

  const result: {
    completed: boolean
    valueCategory: ValueCategory
    valueLength?: number
    sanitizedValue?: string
  } = {
    completed,
    valueCategory: sensitive ? 'redacted' : valueCategory,
    valueLength
  }

  if (!sensitive && isValueAllowlisted(opts.analyticsId) && typeof opts.value === 'string') {
    result.sanitizedValue = truncate(opts.value, 200)
  }

  return result
}

const MAX_TYPED = 500

/**
 * Structural redactions applied to captured keystrokes. Ordered: the most
 * specific patterns run first so a token is not partly eaten by a later rule.
 */
const TYPED_REDACTIONS: Array<{ re: RegExp; with: string }> = [
  { re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, with: '[email]' },
  // Vendor-prefixed credentials (OpenAI, GitHub, Slack, Stripe, …).
  {
    re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abpsr])[-_][A-Za-z0-9_-]{10,}/gi,
    with: '[token]'
  },
  // Bare high-entropy strings: long, mixed letters *and* digits.
  {
    re: /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}\b/g,
    with: '[token]'
  }
]

/** Digit runs long enough to be a card / account / SSN, ignoring separators. */
const DIGIT_GROUP_RE = /\d(?:[\d\s-]{7,}\d)?/g

/**
 * Redact a captured keystroke sequence so it is safe to persist.
 *
 * Keeps ordinary prose (that is the point — the recording needs to know what was
 * typed) while removing credentials, addresses, and long numbers. Callers must
 * still drop the text entirely for secure/sensitive fields.
 */
export function sanitizeTypedText(raw: string | undefined | null): {
  text?: string
  redacted: boolean
} {
  if (raw == null) return { redacted: false }

  // Normalize whitespace/control characters into single spaces.
  let text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return { redacted: false }

  let redacted = false

  for (const rule of TYPED_REDACTIONS) {
    text = text.replace(rule.re, () => {
      redacted = true
      return rule.with
    })
  }

  text = text.replace(DIGIT_GROUP_RE, (match) => {
    const digits = match.replace(/\D/g, '')
    if (digits.length < 9) return match
    redacted = true
    // Preserve surrounding spacing so the sentence still reads correctly.
    const lead = /^\s/.test(match) ? ' ' : ''
    const tail = /\s$/.test(match) ? ' ' : ''
    return `${lead}[number]${tail}`
  })

  text = text.replace(/\s+/g, ' ').trim()
  if (!text) return { redacted }

  if (text.length > MAX_TYPED) {
    text = `${text.slice(0, MAX_TYPED - 1)}…`
  }

  return { text, redacted }
}

const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'ref_src',
  'ref_url'
])

const CREDENTIAL_QUERY_KEYS =
  /^(token|access_token|refresh_token|id_token|auth|authorization|code|session|sid|jwt|api[_-]?key|password|secret)$/i

/** High-entropy query/path segments that look like session credentials. */
const CREDENTIAL_VALUE_RE =
  /^(?:[A-Za-z0-9_-]{32,}|[A-Fa-f0-9]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/

export type SanitizedUrl = {
  urlHost?: string
  urlPath?: string
  /** Tracking-stripped query; omitted when empty or when URL was rejected. */
  urlQuery?: string
  /** True when the URL contained credentials / session tokens and must not be stored. */
  rejected?: boolean
}

/**
 * Canonicalize a URL for capture and address extraction.
 * - Keeps host + path
 * - Strips tracking params (utm_*, gclid, referrer chains)
 * - Drops ephemeral fragments
 * - Rejects URLs containing session tokens / auth codes (hard rule)
 */
export function sanitizeUrl(raw?: string | null): SanitizedUrl {
  if (!raw) return {}
  try {
    const u = new URL(raw)
    // Embedded credentials in the authority are never kept.
    if (u.username || u.password) return { rejected: true }

    const kept = new URLSearchParams()
    for (const [key, value] of u.searchParams.entries()) {
      const lower = key.toLowerCase()
      if (TRACKING_PARAMS.has(lower)) continue
      if (CREDENTIAL_QUERY_KEYS.test(key) || CREDENTIAL_VALUE_RE.test(value)) {
        return { rejected: true }
      }
      kept.append(key, value)
    }

    // Path segments that look like opaque session tokens.
    for (const segment of u.pathname.split('/')) {
      if (segment.length >= 40 && CREDENTIAL_VALUE_RE.test(segment)) {
        return { rejected: true }
      }
    }

    const query = kept.toString()
    return {
      urlHost: truncate(u.host, 200),
      urlPath: truncate(u.pathname, MAX_PATH),
      urlQuery: query ? truncate(query, 300) : undefined
    }
  } catch {
    return {}
  }
}

export function sanitizeWindowTitle(title?: string | null): string | undefined {
  if (!title) return undefined
  // Drop obvious secret-looking fragments.
  let t = title
  t = t.replace(/(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '[redacted]')
  t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
  return truncate(t, MAX_TITLE)
}

export function sanitizeLabel(label?: string | null): string | undefined {
  return truncate(label, MAX_LABEL)
}

/** Re-apply redaction to a normalized event (server-side second pass). */
export function redactEvent(event: TelemetryEvent): TelemetryEvent {
  const data = event.data ? { ...event.data } : undefined
  const target = event.target ? { ...event.target } : undefined

  if (target) {
    target.accessibleLabel = sanitizeLabel(target.accessibleLabel)
    target.visibleLabel = sanitizeLabel(target.visibleLabel)
    target.formLabel = sanitizeLabel(target.formLabel)
    if (
      isSensitiveField({
        label: target.accessibleLabel ?? target.visibleLabel,
        fieldType: target.fieldType,
        analyticsId: target.analyticsId
      })
    ) {
      // Ensure we never carry a raw value through target.
      target.fieldType = target.fieldType ?? 'sensitive'
    }
  }

  if (data) {
    data.windowTitle = sanitizeWindowTitle(data.windowTitle)
    data.appName = sanitizeLabel(data.appName)
    data.message = truncate(data.message, 300)
    data.selectionLabel = sanitizeLabel(data.selectionLabel)
    data.formLabel = sanitizeLabel(data.formLabel)
    data.errorState = truncate(data.errorState, 200)
    data.successMessage = truncate(data.successMessage, 200)
    data.documentTitle = sanitizeWindowTitle(data.documentTitle)
    data.elementRole = sanitizeLabel(data.elementRole)
    data.elementSubrole = sanitizeLabel(data.elementSubrole)
    data.elementLabel = sanitizeLabel(data.elementLabel)
    data.elementPath = data.elementPath
      ?.map((p) => sanitizeLabel(p))
      .filter((p): p is string => !!p)
      .slice(0, 3)
    data.selectedLabels = data.selectedLabels
      ?.map((l) => sanitizeLabel(l))
      .filter((l): l is string => !!l)
      .slice(0, 5)
    data.headings = data.headings
      ?.map((h) => sanitizeLabel(h))
      .filter((h): h is string => !!h)
      .slice(0, 12)
    data.buttons = data.buttons
      ?.map((b) => sanitizeLabel(b))
      .filter((b): b is string => !!b)
      .slice(0, 20)
    data.dialogs = data.dialogs
      ?.map((d) => sanitizeLabel(d))
      .filter((d): d is string => !!d)
      .slice(0, 8)

    if (data.clipboard) {
      data.clipboard = {
        ...data.clipboard,
        urlHost: truncate(data.clipboard.urlHost, 200),
        urlPath: truncate(data.clipboard.urlPath, MAX_PATH),
        urlQuery: truncate(data.clipboard.urlQuery, 300),
        text: data.clipboard.text ? truncate(data.clipboard.text, 500) : undefined
      }
      if (data.clipboard.text) {
        const { text, redacted } = sanitizeTypedText(data.clipboard.text)
        if (!text || looksLikeClipboardSecret(text)) {
          delete data.clipboard.text
        } else {
          data.clipboard.text = text
          if (redacted) data.typedTextRedacted = true
        }
      }
    }

    // Never keep absolute paths for keyframes — relative only.
    for (const pathKey of [
      'keyframePath',
      'preShotPath',
      'postShotPath',
      'targetCropPath'
    ] as const) {
      const p = data[pathKey]
      if (!p) continue
      if (p.includes('..') || p.startsWith('/') || /^[A-Za-z]:\\/.test(p)) {
        delete data[pathKey]
      } else {
        data[pathKey] = truncate(p, 300)
      }
    }

    data.narrationText = truncate(data.narrationText, 800)
    data.filePath = truncate(data.filePath, 400)
    data.fileName = truncate(data.fileName, 200)
    data.downloadSourceUrl = truncate(data.downloadSourceUrl, 500)
    data.stateChangeDetail = truncate(data.stateChangeDetail, 200)
    data.stateChangeElement = sanitizeLabel(data.stateChangeElement)
    data.elementIdentifier = sanitizeLabel(data.elementIdentifier)
    data.urlQuery = truncate(data.urlQuery, 300)

    // Typed text: drop outright for sensitive targets, otherwise re-redact.
    if (data.typedText != null) {
      const targetSensitive =
        isSensitiveField({
          label: data.elementLabel ?? target?.accessibleLabel ?? target?.visibleLabel,
          fieldType: data.field?.fieldType ?? target?.fieldType,
          analyticsId: target?.analyticsId
        }) ||
        data.elementRole === 'AXSecureTextField' ||
        data.field?.valueCategory === 'sensitive' ||
        data.field?.valueCategory === 'redacted'

      if (targetSensitive) {
        delete data.typedText
        data.typedTextRedacted = true
      } else {
        const { text, redacted } = sanitizeTypedText(data.typedText)
        if (text) {
          data.typedText = text
          if (redacted) data.typedTextRedacted = true
        } else {
          delete data.typedText
          if (redacted) data.typedTextRedacted = true
        }
      }
    }

    if (data.field) {
      const field = { ...data.field }
      const sensitive =
        field.valueCategory === 'sensitive' ||
        field.valueCategory === 'redacted' ||
        isSensitiveField({
          label: field.label,
          fieldType: field.fieldType,
          analyticsId: target?.analyticsId
        })
      if (sensitive) {
        field.valueCategory = 'redacted'
        delete field.sanitizedValue
      } else if (field.sanitizedValue && !isValueAllowlisted(target?.analyticsId)) {
        delete field.sanitizedValue
      }
      field.label = sanitizeLabel(field.label)
      data.field = field
    }

    // Drop any accidental credential-looking keys from open data.
    const scrubbed = scrubSecrets(data)
    return {
      ...event,
      page: sanitizeLabel(event.page) ?? event.page,
      route: truncate(event.route, 300) ?? event.route,
      target,
      data: scrubbed
    }
  }

  return {
    ...event,
    page: sanitizeLabel(event.page) ?? event.page,
    route: truncate(event.route, 300) ?? event.route,
    target
  }
}

function scrubSecrets(data: TelemetryEventData): TelemetryEventData {
  const clone: TelemetryEventData = { ...data }
  for (const key of Object.keys(clone) as (keyof TelemetryEventData)[]) {
    const val = clone[key]
    if (typeof val === 'string' && SENSITIVE_NAME_RE.test(key)) {
      delete clone[key]
    }
  }
  return clone
}

function looksLikeClipboardSecret(text: string): boolean {
  if (SENSITIVE_NAME_RE.test(text)) return true
  if (/\bsk-[A-Za-z0-9_\-]{8,}\b/.test(text)) return true
  if (/bearer\s+[A-Za-z0-9._\-]+/i.test(text)) return true
  return false
}

/** Whether an event should be dropped (ignored / empty / invalid). */
export function shouldDropEvent(event: TelemetryEvent): boolean {
  if (event.data?.ignored) return true
  if (!event.type || !event.eventId || !event.sessionId) return true
  // Empty screen_changed with no useful payload.
  if (
    event.type === 'screen_changed' &&
    !event.data?.windowTitle &&
    !event.data?.appName &&
    !event.page
  ) {
    return true
  }
  // Typing that redacted away entirely carries no signal beyond "something happened".
  if (event.type === 'text_input' && !event.data?.typedText && !event.data?.submitKey) {
    return true
  }
  return false
}
