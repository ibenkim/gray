import type { TelemetryEvent, TelemetryEventType, TelemetryTarget } from '../../shared/telemetry/schema'

/**
 * Optional element-level interaction source (macOS input monitors + Accessibility).
 * Disabled by default — active-win capture alone produces no click/typing events.
 */
export interface InteractionProvider {
  readonly enabled: boolean
  start(onEvent: (partial: InteractionPartial) => void): void
  stop(): void
  /** Force an immediate sample (e.g. after app/window or clipboard change). */
  poke?(): void
  /**
   * Whether this provider observes real key presses. When true the recorder skips
   * registering global shortcut accelerators, which would otherwise swallow those
   * chords from the app being recorded.
   */
  readonly capturesKeys?: boolean
  /** Flush any buffered in-progress typing (called before the session stops). */
  flush?(): void
  /**
   * Report capabilities discovered after start — the provider cannot know whether
   * the OS will actually deliver input events until its child process reports back.
   */
  onCapabilityChange?(cb: (info: { capturesKeys: boolean }) => void): void
}

export type InteractionPartial = {
  type: Extract<
    TelemetryEventType,
    | 'click'
    | 'scroll'
    | 'text_input'
    | 'keyboard_shortcut'
    | 'field_completed'
    | 'selection_changed'
    | 'form_submitted'
    | 'focus_changed'
    | 'element_activated'
    | 'error'
    | 'state_change'
    | 'file_dialog'
    | 'download'
    | 'marker'
  >
  target?: TelemetryTarget
  data?: TelemetryEvent['data']
}

export class NoopInteractionProvider implements InteractionProvider {
  readonly enabled = false
  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
}

export type KeyframeReason =
  | 'app_changed'
  | 'activation'
  | 'clipboard'
  | 'settle'
  | 'ambiguous'
  | 'pre_action'
  | 'post_action'
  | 'target_crop'

/**
 * Optional redacted keyframe screenshot source.
 * Disabled by default — do not store base64 screenshots in event files.
 */
export interface ScreenshotProvider {
  readonly enabled: boolean
  captureKeyframe(
    screenStateId: string,
    opts?: {
      reason?: KeyframeReason
      bounds?: { x: number; y: number; width: number; height: number }
      sessionId?: string
      eventId?: string
    }
  ): Promise<{ path?: string; relativePath?: string } | null>
}

export class DisabledScreenshotProvider implements ScreenshotProvider {
  readonly enabled = false
  async captureKeyframe(): Promise<null> {
    return null
  }
}
