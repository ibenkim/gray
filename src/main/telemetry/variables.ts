import {
  SCHEMA_VERSION,
  type PolishedSession,
  type StoredVariables,
  type TelemetryEvent,
  type WorkflowVariable
} from '../../shared/telemetry/schema'
import { sanitizeLabel } from '../../shared/telemetry/sanitize'
import { sanitizeModelString } from './modelSanitize'

const MESSAGING_APPS = /^(messages|slack|mail|outlook|discord|telegram|whatsapp)/i

/**
 * Deterministic workflow-variable extractor (no LLM).
 * Pulls document titles, copied URLs, and messaging recipients from evidence.
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

  return [...byKey.values()]
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
