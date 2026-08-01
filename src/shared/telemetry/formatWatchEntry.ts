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
      const doc = event.data?.documentTitle || event.data?.windowTitle
      const label = doc || event.data?.appName || event.page || 'a page'
      return {
        time,
        text: doc && event.data?.appName ? `Opened ${doc} in ${event.data.appName}` : `Opened ${label}`,
        appName
      }
    }
    case 'screen_changed': {
      const label = event.data?.documentTitle || event.data?.windowTitle || event.page
      if (!label) return null
      return { time, text: `Looking at ${label}`, appName }
    }
    case 'focus_changed': {
      const name =
        event.data?.elementLabel ||
        event.target?.accessibleLabel ||
        event.data?.elementRole ||
        'a control'
      return { time, text: `Focused ${name}`, appName }
    }
    case 'click':
    case 'element_activated': {
      const name =
        event.data?.elementLabel ||
        event.target?.visibleLabel ||
        event.target?.accessibleLabel ||
        event.target?.analyticsId ||
        'a control'
      const verb = event.type === 'click' ? 'Clicked' : 'Selected'
      return { time, text: `${verb} ${name}`, appName }
    }
    case 'text_input': {
      const typed = event.data?.typedText
      const label = event.data?.elementLabel || event.target?.accessibleLabel
      if (!typed) {
        if (!event.data?.submitKey) return null
        return {
          time,
          text: label ? `Pressed ${event.data.submitKey} in ${label}` : `Pressed ${event.data.submitKey}`,
          appName
        }
      }
      const shown = typed.length > 60 ? `${typed.slice(0, 59)}…` : typed
      return { time, text: label ? `Typed "${shown}" into ${label}` : `Typed "${shown}"`, appName }
    }
    case 'field_completed': {
      const label =
        event.data?.field?.label ||
        event.data?.elementLabel ||
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
      const label =
        event.data?.selectionLabel ||
        event.data?.selectedLabels?.[0] ||
        event.target?.visibleLabel ||
        'selection'
      return { time, text: `Selected ${label}`, appName }
    }
    case 'clipboard_changed': {
      const clip = event.data?.clipboard
      if (!clip) return { time, text: 'Copied to clipboard', appName }
      if (clip.contentType === 'url' && clip.urlHost) {
        return { time, text: `Copied ${clip.urlHost} link`, appName }
      }
      return { time, text: `Copied ${clip.contentType}`, appName }
    }
    case 'paste_detected': {
      const host = event.data?.clipboard?.urlHost
      return { time, text: host ? `Pasted ${host} link` : 'Pasted clipboard', appName }
    }
    case 'keyboard_shortcut':
      return { time, text: `Shortcut ${event.data?.shortcut ?? ''}`, appName }
    case 'keyframe_captured':
      return null
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
