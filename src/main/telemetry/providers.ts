import type { TelemetryEvent, TelemetryTarget } from '../../shared/telemetry/schema'

/**
 * Optional element-level interaction source (macOS Accessibility, etc.).
 * Disabled by default — active-win capture does not produce click/field events.
 */
export interface InteractionProvider {
  readonly enabled: boolean
  start(onEvent: (partial: InteractionPartial) => void): void
  stop(): void
}

export type InteractionPartial = {
  type: 'click' | 'field_completed' | 'selection_changed' | 'form_submitted'
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

/**
 * Optional redacted keyframe screenshot source.
 * Disabled by default — do not store base64 screenshots in event files.
 */
export interface ScreenshotProvider {
  readonly enabled: boolean
  captureKeyframe(_screenStateId: string): Promise<{ path?: string } | null>
}

export class DisabledScreenshotProvider implements ScreenshotProvider {
  readonly enabled = false
  async captureKeyframe(): Promise<null> {
    return null
  }
}
