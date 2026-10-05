import type {
  ScreenshotCaptureStatus,
  TelemetryEvent,
  TelemetryEventType,
  TelemetryTarget
} from '../../shared/telemetry/schema'

/**
 * Optional element-level interaction source (macOS input monitors + Accessibility).
 * Disabled by default — active-win capture alone produces no click/typing events.
 */
export interface InteractionProvider {
  readonly enabled: boolean
  /** `scope` is enforced by the source before it reads app content (M3-C); absent = read nothing. */
  start(onEvent: (partial: InteractionPartial) => void, scope?: AppScope): void
  /**
   * May resolve later: a child-backed provider settles once its process has exited, and
   * rejects if exit could not be confirmed (teardown failure, never a silent success).
   */
  stop(): void | Promise<void>
  /** True while a stopped source has not confirmed shutdown; no replacement may start. */
  readonly teardownPending?: boolean
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
    | 'key_pressed'
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

/** Hard denylist — password managers, banking, messaging (capture-spec §5). */
const APP_DENYLIST = [
  '1password',
  '1password for safari',
  'bitwarden',
  'lastpass',
  'dashlane',
  'keeper',
  'enpass',
  'keychain access',
  'chase',
  'wells fargo',
  'bank of america',
  'capital one',
  'paypal',
  'venmo',
  'cash app',
  'messages',
  'whatsapp',
  'signal',
  'telegram',
  'imessage'
]
const APP_ALIASES: Record<string, string[]> = {
  chrome: ['google chrome', 'chrome', 'chromium'],
  figma: ['figma'],
  slack: ['slack'],
  finder: ['finder'],
  mail: ['mail']
}

/**
 * Which apps a recording may read, lowercased. Serialized to the accessibility sensor, which
 * applies the same rule (`appAllowed` in ax/jxaScript.ts) before any content read.
 * ponytail: app-name substrings, not bundle IDs; switch when the app picker carries bundle IDs.
 */
export type AppScope = { self: string[]; deny: string[]; allow: string[] | null }

export function appScope(opts: { recordMode?: string; selectedAppId?: string; ignoreAppNames?: string[] }): AppScope {
  const selected = opts.recordMode === 'one-app' && opts.selectedAppId ? opts.selectedAppId.toLowerCase() : null
  return {
    self: (opts.ignoreAppNames ?? ['ghost', 'Electron', 'yuh']).map((n) => n.toLowerCase()),
    deny: APP_DENYLIST,
    allow: selected ? (APP_ALIASES[selected] ?? [selected]) : null
  }
}

/** Unknown app (no name) = not in scope. */
export function appInScope(scope: AppScope, appName?: string): boolean {
  if (!appName) return false
  const lower = appName.toLowerCase()
  if (scope.self.includes(lower)) return false
  if (scope.deny.some((n) => lower.includes(n))) return false
  return !scope.allow || scope.allow.some((n) => lower.includes(n))
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
 * Optional keyframe screenshot source. Production uses DisabledScreenshotProvider (M3-A):
 * no unredacted pixels are acquired until a scoped, masked source exists.
 */
export interface ScreenshotProvider {
  readonly enabled: boolean
  /** What sessions recorded with this provider may claim about screenshots. */
  readonly availability?: ScreenshotCaptureStatus
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
  readonly availability = 'disabled_privacy' as const
  async captureKeyframe(): Promise<null> {
    return null
  }
}
