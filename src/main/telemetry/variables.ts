import {
  SCHEMA_VERSION,
  type PolishedSession,
  type StoredVariables,
  type TelemetryEvent,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import { sanitizeLabel } from '../../shared/telemetry/sanitize'
import { searchQueryFromTitle } from './automation/groundText'
import { sanitizeModelString } from './modelSanitize'

const MESSAGING_APPS = /^(messages|slack|mail|outlook|discord|telegram|whatsapp)/i
const SEARCH_LABEL = /search|query|find|omnibox|address bar|google|bing|duckduckgo/i
const MESSAGE_LABEL = /message|compose|chat|imessage|body|subject/i
const FILENAME_LABEL = /file\s*name|filename|title|rename|name/i
const DATE_LABEL = /date|when|deadline|due|range/i

/**
 * Deterministic workflow-variable extractor (no LLM).
 * Pulls document titles, copied URLs, messaging recipients, and
 * inputKind-driven parameters (search, message, filename, date) from evidence.
 */
export function extractWorkflowVariables(
  events: TelemetryEvent[],
  polished?: PolishedSession | null
): WorkflowVariable[] {
  const byKey = new Map<string, WorkflowVariable>()

  const docCounts = new Map<string, { app?: string; title: string; count: number }>()
  for (const e of events) {
    const title = e.data?.documentTitle || e.data?.windowTitle
    const app = e.data?.appName
    if (!title || !app) continue
    if (/^(ghost|electron|yuh)$/i.test(app)) continue
    const key = `${app.toLowerCase()}|${title.toLowerCase()}`
    const prev = docCounts.get(key)
    if (prev) prev.count += 1
    else docCounts.set(key, { app, title, count: 1 })
  }
  let bestDoc: { app?: string; title: string; count: number } | null = null
  for (const d of docCounts.values()) {
    if (!bestDoc || d.count > bestDoc.count) bestDoc = d
  }
  if (bestDoc && bestDoc.count >= 1) {
    const appLabel = bestDoc.app ? `${bestDoc.app} file` : 'Document'
    byKey.set('file', {
      key: 'file',
      label: sanitizeLabel(appLabel) ?? 'Document',
      kind: 'document',
      exampleSanitized: sanitizeModelString(bestDoc.title, 200)
    })
  }

  if (!byKey.has('file') && polished) {
    for (const a of polished.actions) {
      if (a.documentTitle && a.appName) {
        byKey.set('file', {
          key: 'file',
          label: sanitizeLabel(`${a.appName} file`) ?? 'Document',
          kind: 'document',
          exampleSanitized: sanitizeModelString(a.documentTitle, 200)
        })
        break
      }
    }
  }

  for (const e of events) {
    if (e.type !== 'clipboard_changed') continue
    const clip = e.data?.clipboard
    if (!clip || clip.contentType !== 'url') continue
    const hostPath = [clip.urlHost, clip.urlPath].filter(Boolean).join('')
    byKey.set('link', {
      key: 'link',
      label: 'Shared link',
      kind: 'url',
      exampleSanitized: hostPath ? sanitizeModelString(hostPath, 200) : null
    })
    break
  }

  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    const app = e.data?.appName ?? ''
    if (!MESSAGING_APPS.test(app)) continue
    const selected = e.data?.selectedLabels?.[0] || e.data?.selectionLabel
    if (!selected) continue
    const upcoming = events.slice(i, i + 8)
    const hasCompose = upcoming.some(
      (u) =>
        (u.type === 'focus_changed' ||
          u.type === 'paste_detected' ||
          u.type === 'text_input' ||
          u.type === 'field_completed') &&
        (u.data?.appName ?? app) === app
    )
    if (hasCompose || e.type === 'selection_changed') {
      byKey.set('recipient', {
        key: 'recipient',
        label: 'Messages conversation',
        kind: 'recipient',
        exampleSanitized: sanitizeModelString(selected, 200)
      })
      break
    }
  }

  if (polished) {
    for (const a of polished.actions) {
      maybeAddTypedVar(byKey, a.typedText, a.elementLabel, a.elementRole, a.inputKind, a.documentTitle)
    }
  } else {
    for (const e of events) {
      if (e.type !== 'text_input' || !e.data?.typedText) continue
      maybeAddTypedVar(
        byKey,
        e.data.typedText,
        e.data.elementLabel || e.target?.accessibleLabel || e.target?.visibleLabel,
        e.data.elementRole,
        e.data.field?.valueCategory,
        e.data.documentTitle
      )
    }
  }

  if (!byKey.has('search') && polished) {
    for (const a of polished.actions) {
      const q = searchQueryFromTitle(a.documentTitle)
      if (q) {
        byKey.set('search', {
          key: 'search',
          label: 'Search query',
          kind: 'search',
          exampleSanitized: sanitizeModelString(q, 200)
        })
        break
      }
    }
  }

  return [...byKey.values()]
}

function resolveTypedKind(
  typedText: string,
  label: string | undefined,
  role: string | undefined,
  inputKind: string | undefined
): WorkflowVariable['kind'] | null {
  const field = `${label ?? ''} ${role ?? ''}`.toLowerCase()
  if (inputKind === 'date' || DATE_LABEL.test(field)) return 'date'
  if (SEARCH_LABEL.test(field) || role === 'AXSearchField') return 'search'
  if (MESSAGE_LABEL.test(field)) return 'message'
  if (FILENAME_LABEL.test(field)) return 'filename'
  if (inputKind === 'email' || inputKind === 'phone' || inputKind === 'url') return 'text'
  if (typedText.length >= 2 && typedText.length <= 80) return 'text'
  return null
}

function maybeAddTypedVar(
  byKey: Map<string, WorkflowVariable>,
  typedText: string | undefined,
  label: string | undefined,
  role: string | undefined,
  inputKind: string | undefined,
  documentTitle: string | undefined
): void {
  if (!typedText) return
  if (/^\[(email|token|number)\]$/.test(typedText.trim())) return

  const resolved = resolveTypedKind(typedText, label, role, inputKind)
  if (!resolved) return

  const key = resolved === 'text' ? 'text' : resolved
  if (byKey.has(key)) return

  const example =
    resolved === 'search' ? searchQueryFromTitle(documentTitle) || typedText : typedText

  const labels: Record<string, string> = {
    search: 'Search query',
    message: 'Message text',
    filename: 'File name',
    date: 'Date value',
    text: label ? sanitizeLabel(label) ?? 'Text' : 'Text'
  }

  byKey.set(key, {
    key,
    label: labels[key] ?? 'Text',
    kind: resolved,
    exampleSanitized: sanitizeModelString(example, 200)
  })
}

export function toStoredVariables(
  sessionId: string,
  variables: WorkflowVariable[]
): StoredVariables {
  return {
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    extractedAt: new Date().toISOString(),
    variables
  }
}
