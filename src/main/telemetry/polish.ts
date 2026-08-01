import {
  SCHEMA_VERSION,
  type ClipboardData,
  type PolishedAction,
  type PolishedSession,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { redactEvent, shouldDropEvent } from '../../shared/telemetry/sanitize'
import type { TelemetryStore } from './store/TelemetryStore'

const IDLE_GAP_MS = 30_000
const CLICK_COLLAPSE_MS = 800
const PASTE_CHAIN_MS = 8_000

type ActionDraft = Omit<PolishedAction, 'order'> & { order?: number }

/**
 * Deterministic polisher — sorts, dedupes, re-redacts, collapses noise,
 * preserves structured evidence, merges copy→paste→send chains,
 * and marks verified outcomes. Does not invent user intent.
 */
export async function polishSession(
  store: TelemetryStore,
  sessionId: string
): Promise<PolishedSession> {
  const raw = await store.readSessionEvents(sessionId)
  const byId = new Map<string, TelemetryEvent>()
  for (const e of raw) {
    const redacted = redactEvent(e)
    if (shouldDropEvent(redacted)) continue
    if (!byId.has(redacted.eventId)) byId.set(redacted.eventId, redacted)
  }

  const events = [...byId.values()].sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence
    return a.timestamp.localeCompare(b.timestamp)
  })

  const drafts: ActionDraft[] = []
  let lastClickKey: string | null = null
  let lastClickAt = 0
  let pendingField: TelemetryEvent | null = null
  let lastNav: TelemetryEvent | null = null
  let lastDocKey: string | null = null
  let lastTs = 0
  let pendingClipboard: { event: TelemetryEvent; clip: ClipboardData; at: number } | null =
    null
  let pendingPaste: { event: TelemetryEvent; at: number } | null = null

  const push = (draft: ActionDraft) => {
    drafts.push(draft)
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const ts = Date.parse(event.timestamp)
    if (lastTs && ts - lastTs >= IDLE_GAP_MS) {
      push({
        text: `Idle for ${Math.round((ts - lastTs) / 1000)}s`,
        category: 'idle',
        timestamp: event.timestamp,
        sourceEventIds: [event.eventId]
      })
    }
    lastTs = ts || lastTs

    switch (event.type) {
      case 'session_started':
        push({
          text: 'Started recording',
          category: 'session',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId]
        })
        break
      case 'session_stopped':
        push({
          text: 'Stopped recording',
          category: 'session',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId]
        })
        break
      case 'navigation': {
        lastNav = event
        const doc = event.data?.documentTitle || event.data?.windowTitle
        const app = event.data?.appName
        const label = doc || app || event.page || 'a page'
        const text = doc && app ? `Opened ${doc} in ${app}` : `Opened ${label}`
        const docKey = `${app ?? ''}|${doc ?? ''}`
        lastDocKey = docKey
        push({
          text,
          category: 'navigation',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: app,
          documentTitle: doc
        })
        break
      }
      case 'screen_changed': {
        const doc = event.data?.documentTitle || event.data?.windowTitle
        const app = event.data?.appName
        const docKey = `${app ?? ''}|${doc ?? ''}`
        if (lastNav && sameScreen(lastNav, event)) {
          lastNav = null
          // Enrich prior nav with document title if missing.
          const prior = drafts[drafts.length - 1]
          if (prior && doc && !prior.documentTitle) prior.documentTitle = doc
          break
        }
        if (docKey && docKey === lastDocKey) {
          // Collapse repeated screen_changed within the same document.
          break
        }
        lastDocKey = docKey
        if (doc || event.page || app) {
          const text =
            doc && app ? `Viewing ${doc} in ${app}` : `Screen changed to ${doc || event.page || app}`
          push({
            text,
            category: 'navigation',
            timestamp: event.timestamp,
            sourceEventIds: [event.eventId],
            appName: app,
            documentTitle: doc
          })
        }
        break
      }
      case 'focus_changed': {
        const label =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        const role = event.data?.elementRole || event.target?.role
        if (!label && !role) break
        push({
          text: label ? `Focused ${label}` : `Focused ${role}`,
          category: 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: role
        })
        break
      }
      case 'text_input': {
        const typed = event.data?.typedText
        const label =
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel
        if (!typed) {
          // Nothing but a submit key survived redaction — record the keypress.
          if (event.data?.submitKey) {
            push({
              text: label
                ? `Pressed ${event.data.submitKey} in ${label}`
                : `Pressed ${event.data.submitKey}`,
              category: 'input',
              timestamp: event.timestamp,
              sourceEventIds: [event.eventId],
              appName: event.data?.appName,
              documentTitle: event.data?.documentTitle,
              elementLabel: label,
              elementRole: event.data?.elementRole
            })
          }
          break
        }
        pendingField = event
        const shown = typed.length > 120 ? `${typed.slice(0, 119)}…` : typed
        push({
          text: label ? `Typed "${shown}" into ${label}` : `Typed "${shown}"`,
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: event.data?.elementRole,
          typedText: shown
        })
        break
      }
      case 'click':
      case 'element_activated': {
        const key = targetKey(event)
        if (key && key === lastClickKey && ts - lastClickAt < CLICK_COLLAPSE_MS) {
          const prior = drafts[drafts.length - 1]
          if (prior && !prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          lastClickAt = ts
          break
        }
        lastClickKey = key
        lastClickAt = ts
        const name =
          event.data?.elementLabel ||
          event.target?.visibleLabel ||
          event.target?.accessibleLabel ||
          event.target?.analyticsId ||
          'a control'
        const isSend = /^(send|submit|share|post|done)$/i.test(name.trim())
        const inferred = event.data?.inferred === true || event.type === 'element_activated'

        // Merge copy→paste→send into one submission when close in time.
        if (
          isSend &&
          pendingPaste &&
          ts - pendingPaste.at < PASTE_CHAIN_MS
        ) {
          const sources = [
            ...(pendingClipboard ? [pendingClipboard.event.eventId] : []),
            pendingPaste.event.eventId,
            event.eventId
          ]
          const verified = detectVerified(events, i)
          const clip = pendingClipboard?.clip
          const host = clip?.urlHost
          push({
            text: host
              ? `Pasted and sent ${host} link`
              : 'Pasted clipboard content and sent',
            category: 'submission',
            timestamp: pendingPaste.event.timestamp,
            sourceEventIds: sources,
            appName: event.data?.appName,
            documentTitle: event.data?.documentTitle,
            elementLabel: name,
            elementRole: event.data?.elementRole,
            clipboard: clip,
            inferred,
            verified
          })
          pendingClipboard = null
          pendingPaste = null
          break
        }

        // "Clicked" is only honest for an observed mouse press; a focus-transition
        // guess stays vaguer on purpose.
        const verb = isSend ? 'Activated' : event.type === 'click' ? 'Clicked' : 'Selected'
        push({
          text: `${verb} ${name}`,
          category: isSend ? 'submission' : 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: name,
          elementRole: event.data?.elementRole || event.target?.role,
          inferred: inferred || undefined,
          verified: isSend ? detectVerified(events, i) : undefined,
          clickButton: event.data?.clickButton,
          clickCount: event.data?.clickCount,
          clickX: event.data?.clickX,
          clickY: event.data?.clickY
        })
        break
      }
      case 'field_completed': {
        pendingField = event
        const label =
          event.data?.field?.label ||
          event.data?.elementLabel ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel ||
          'a field'
        push({
          text: `Completed the ${label} field`,
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label,
          elementRole: event.data?.elementRole
        })
        break
      }
      case 'form_submitted': {
        const sources = pendingField
          ? [pendingField.eventId, event.eventId]
          : [event.eventId]
        const form =
          event.data?.formLabel || event.target?.formLabel || 'the form'
        push({
          text: `Submitted ${form}`,
          category: 'submission',
          timestamp: event.timestamp,
          sourceEventIds: sources,
          appName: event.data?.appName,
          verified: detectVerified(events, i)
        })
        pendingField = null
        break
      }
      case 'selection_changed': {
        const label =
          event.data?.selectionLabel ||
          event.data?.selectedLabels?.[0] ||
          event.target?.visibleLabel ||
          'a selection'
        push({
          text: `Changed selection to ${label}`,
          category: 'interaction',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          elementLabel: label
        })
        break
      }
      case 'clipboard_changed': {
        const clip = event.data?.clipboard
        if (!clip) break
        pendingClipboard = { event, clip, at: ts }
        const desc =
          clip.contentType === 'url' && clip.urlHost
            ? `Copied ${clip.urlHost} link`
            : `Copied ${clip.contentType} to clipboard`
        push({
          text: desc,
          category: 'clipboard',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          clipboard: clip
        })
        break
      }
      case 'paste_detected': {
        pendingPaste = { event, at: ts }
        const host = event.data?.clipboard?.urlHost || pendingClipboard?.clip.urlHost
        push({
          text: host ? `Pasted ${host} link` : 'Pasted clipboard content',
          category: 'input',
          timestamp: event.timestamp,
          sourceEventIds: [
            ...(pendingClipboard ? [pendingClipboard.event.eventId] : []),
            event.eventId
          ],
          appName: event.data?.appName,
          documentTitle: event.data?.documentTitle,
          clipboard: event.data?.clipboard || pendingClipboard?.clip,
          inferred: true
        })
        break
      }
      case 'keyboard_shortcut': {
        const shortcut = event.data?.shortcut || 'a shortcut'
        push({
          text: `Used shortcut ${shortcut}`,
          category: 'shortcut',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName
        })
        break
      }
      case 'keyframe_captured':
        // Attach path to the most recent non-session action; don't emit a standalone step.
        if (event.data?.keyframePath && drafts.length > 0) {
          const prior = drafts[drafts.length - 1]
          if (prior.category !== 'session' && prior.category !== 'idle') {
            prior.keyframePath = event.data.keyframePath
            if (!prior.sourceEventIds.includes(event.eventId)) {
              prior.sourceEventIds.push(event.eventId)
            }
          }
        }
        break
      case 'error': {
        const msg = event.data?.message || event.data?.errorState || 'an error'
        push({
          text: `Encountered ${msg}`,
          category: 'error',
          timestamp: event.timestamp,
          sourceEventIds: [event.eventId],
          appName: event.data?.appName
        })
        break
      }
      default:
        break
    }
  }

  const actions: PolishedAction[] = drafts.map((d, i) => ({
    ...d,
    order: i + 1
  }))

  const sequenceRange = {
    min: events.length ? events[0].sequence : 0,
    max: events.length ? events[events.length - 1].sequence : 0
  }

  const polished: PolishedSession = {
    sessionId,
    schemaVersion: SCHEMA_VERSION,
    polishedAt: new Date().toISOString(),
    sequenceRange,
    actions
  }

  await store.savePolishedSession(sessionId, polished)
  return polished
}

function targetKey(event: TelemetryEvent): string | null {
  const t = event.target
  const d = event.data
  if (!t && !d?.elementLabel) return null
  return [
    t?.analyticsId,
    d?.elementRole || t?.role,
    t?.tagName,
    d?.elementLabel || t?.visibleLabel || t?.accessibleLabel,
    t?.appName || d?.appName
  ]
    .filter(Boolean)
    .join('|')
}

function sameScreen(a: TelemetryEvent, b: TelemetryEvent): boolean {
  if (a.screenStateId && b.screenStateId) return a.screenStateId === b.screenStateId
  return (
    (a.data?.documentTitle || a.data?.windowTitle) ===
      (b.data?.documentTitle || b.data?.windowTitle) &&
    a.data?.appName === b.data?.appName &&
    a.data?.urlHost === b.data?.urlHost
  )
}

/** Look ahead briefly for corroborating state after a submit/send. */
function detectVerified(events: TelemetryEvent[], index: number): boolean {
  const base = events[index]
  const baseTs = Date.parse(base.timestamp)
  for (let j = index + 1; j < Math.min(events.length, index + 6); j++) {
    const e = events[j]
    const ts = Date.parse(e.timestamp)
    if (ts - baseTs > 4000) break
    // Field cleared after send.
    if (
      e.type === 'focus_changed' &&
      e.data?.field?.valueLength === 0 &&
      e.data?.appName === base.data?.appName
    ) {
      return true
    }
    if (e.type === 'selection_changed' && e.data?.appName === base.data?.appName) {
      return true
    }
    if (
      e.type === 'screen_changed' &&
      e.data?.successMessage
    ) {
      return true
    }
    if (e.data?.verified === true) return true
  }
  // Heuristic: Send/Share button activation in Messages/Slack counts as likely sent.
  const label = base.data?.elementLabel || base.target?.visibleLabel || ''
  if (/^(send|share|post)$/i.test(label.trim())) return true
  return false
}
