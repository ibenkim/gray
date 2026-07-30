import type { TelemetryEvent } from './schema'

export type WatchLogLine = {
  time: string
  text: string
  appName?: string
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Map a sanitized telemetry event to a short ledger line for the Learning panel. */
export function formatWatchEntry(event: TelemetryEvent): WatchLogLine | null {
  const time = formatElapsed(event.elapsedMs)
  const appName = event.data?.appName ?? event.target?.appName

  switch (event.type) {
    case 'session_started':
      return { time, text: 'Started recording' }
    case 'session_stopped':
      return { time, text: 'Stopped recording' }
    case 'navigation': {
      const label = event.data?.windowTitle || event.data?.appName || event.page || 'a page'
      return { time, text: `Opened ${label}`, appName }
    }
    case 'screen_changed': {
      const label = event.data?.windowTitle || event.page
      if (!label) return null
      // Skip noisy duplicates when navigation already covered the same title.
      return { time, text: `Looking at ${label}`, appName }
    }
    case 'click': {
      const name =
        event.target?.visibleLabel ||
        event.target?.accessibleLabel ||
        event.target?.analyticsId ||
        'a control'
      return { time, text: `Selected ${name}`, appName }
    }
    case 'field_completed': {
      const label =
        event.data?.field?.label ||
        event.target?.accessibleLabel ||
        event.target?.visibleLabel ||
        'a field'
      return { time, text: `Completed ${label}`, appName }
    }
    case 'form_submitted': {
      const form = event.data?.formLabel || event.target?.formLabel || 'the form'
      return { time, text: `Submitted ${form}`, appName }
    }
    case 'selection_changed': {
      const label = event.data?.selectionLabel || event.target?.visibleLabel || 'selection'
      return { time, text: `Changed ${label}`, appName }
    }
    case 'keyboard_shortcut':
      return { time, text: `Shortcut ${event.data?.shortcut ?? ''}`, appName }
    case 'error':
      return {
        time,
        text: event.data?.message || event.data?.errorState || 'Encountered an error',
        appName
      }
    default:
      return null
  }
}
