import {
  SCHEMA_VERSION,
  type PolishedAction,
  type PolishedSession,
  type TelemetryEvent
} from '../../shared/telemetry/schema'
import { redactEvent, shouldDropEvent } from '../../shared/telemetry/sanitize'
import type { TelemetryStore } from './store/TelemetryStore'

const IDLE_GAP_MS = 30_000
const CLICK_COLLAPSE_MS = 800

/**
 * Deterministic polisher — sorts, dedupes, re-redacts, collapses noise,
 * associates navigation with screen changes, marks idle gaps.
 * Does not invent user intent.
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

  const actions: PolishedAction[] = []
  let order = 1
  let lastClickKey: string | null = null
  let lastClickAt = 0
  let pendingField: TelemetryEvent | null = null
  let lastNav: TelemetryEvent | null = null
  let lastTs = 0

  const push = (
    text: string,
    category: PolishedAction['category'],
    source: TelemetryEvent[],
    appName?: string
  ) => {
    if (source.length === 0) return
    actions.push({
      order: order++,
      text,
      category,
      timestamp: source[0].timestamp,
      sourceEventIds: source.map((s) => s.eventId),
      appName: appName ?? source[0].data?.appName ?? source[0].target?.appName
    })
  }

  for (const event of events) {
    const ts = Date.parse(event.timestamp)
    if (lastTs && ts - lastTs >= IDLE_GAP_MS) {
      push(`Idle for ${Math.round((ts - lastTs) / 1000)}s`, 'idle', [event])
    }
    lastTs = ts || lastTs

    switch (event.type) {
      case 'session_started':
        push('Started recording', 'session', [event])
        break
      case 'session_stopped':
        push('Stopped recording', 'session', [event])
        break
      case 'navigation': {
        lastNav = event
        const label =
          event.data?.windowTitle ||
          event.data?.appName ||
          event.page ||
          'a page'
        push(`Opened ${label}`, 'navigation', [event], event.data?.appName)
        break
      }
      case 'screen_changed': {
        if (lastNav && sameScreen(lastNav, event)) {
          // Associate — already covered by navigation text; skip duplicate.
          lastNav = null
          break
        }
        const label = event.data?.windowTitle || event.page || event.data?.appName
        if (label) {
          push(`Screen changed to ${label}`, 'navigation', [event], event.data?.appName)
        }
        break
      }
      case 'click': {
        const key = targetKey(event)
        if (key && key === lastClickKey && ts - lastClickAt < CLICK_COLLAPSE_MS) {
          // Collapse repeated clicks on the same target — attach id to prior.
          const prior = actions[actions.length - 1]
          if (prior && !prior.sourceEventIds.includes(event.eventId)) {
            prior.sourceEventIds.push(event.eventId)
          }
          lastClickAt = ts
          break
        }
        lastClickKey = key
        lastClickAt = ts
        const name =
          event.target?.visibleLabel ||
          event.target?.accessibleLabel ||
          event.target?.analyticsId ||
          'a control'
        push(`Selected ${name}`, 'interaction', [event])
        break
      }
      case 'field_completed': {
        pendingField = event
        const label =
          event.data?.field?.label ||
          event.target?.accessibleLabel ||
          event.target?.visibleLabel ||
          'a field'
        push(`Completed the ${label} field`, 'input', [event])
        break
      }
      case 'form_submitted': {
        const sources = pendingField ? [pendingField, event] : [event]
        const form =
          event.data?.formLabel ||
          event.target?.formLabel ||
          'the form'
        push(`Submitted ${form}`, 'submission', sources)
        pendingField = null
        break
      }
      case 'selection_changed': {
        const label =
          event.data?.selectionLabel ||
          event.target?.visibleLabel ||
          'a selection'
        push(`Changed selection to ${label}`, 'interaction', [event])
        break
      }
      case 'keyboard_shortcut': {
        const shortcut = event.data?.shortcut || 'a shortcut'
        push(`Used shortcut ${shortcut}`, 'shortcut', [event])
        break
      }
      case 'error': {
        const msg = event.data?.message || event.data?.errorState || 'an error'
        push(`Encountered ${msg}`, 'error', [event])
        break
      }
      default:
        break
    }
  }

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
  if (!t) return null
  return [
    t.analyticsId,
    t.role,
    t.tagName,
    t.visibleLabel,
    t.accessibleLabel,
    t.appName
  ]
    .filter(Boolean)
    .join('|')
}

function sameScreen(a: TelemetryEvent, b: TelemetryEvent): boolean {
  if (a.screenStateId && b.screenStateId) return a.screenStateId === b.screenStateId
  return (
    a.data?.windowTitle === b.data?.windowTitle &&
    a.data?.appName === b.data?.appName &&
    a.data?.urlHost === b.data?.urlHost
  )
}
