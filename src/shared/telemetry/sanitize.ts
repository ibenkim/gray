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

/** Strip query/hash and keep host + limited path from a URL. */
export function sanitizeUrl(raw?: string | null): { urlHost?: string; urlPath?: string } {
  if (!raw) return {}
  try {
    const u = new URL(raw)
    // Never keep credentials, query, or hash (tokens often live there).
    return {
      urlHost: truncate(u.host, 200),
      urlPath: truncate(u.pathname, MAX_PATH)
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
        urlPath: truncate(data.clipboard.urlPath, MAX_PATH)
      }
    }

    // Never keep absolute paths for keyframes — relative only.
    if (data.keyframePath) {
      if (
        data.keyframePath.includes('..') ||
        data.keyframePath.startsWith('/') ||
        /^[A-Za-z]:\\/.test(data.keyframePath)
      ) {
        delete data.keyframePath
      } else {
        data.keyframePath = truncate(data.keyframePath, 300)
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
  return false
}
