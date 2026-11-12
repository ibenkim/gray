import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import {
  sanitizeLabel,
  sanitizeTypedText,
  sanitizeWindowTitle
} from '../../../shared/telemetry/sanitize'
import type { AppScope, InteractionPartial, InteractionProvider } from '../providers'
import { looksLikeShellNoise } from '../automation/groundText'
import { resolveTargetTier } from '../axTarget'
import { JXA_SENSOR_SCRIPT } from './jxaScript'

export type JxaElementBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type JxaSample = {
  appName?: string
  appBundleId?: string
  windowTitle?: string
  documentTitle?: string
  elementRole?: string
  elementSubrole?: string
  elementLabel?: string
  valueLength?: number | null
  /** Last ≤160 chars of non-secure AXValue — used when key monitors are silent. */
  valueTail?: string | null
  elementPath?: string[]
  selectedLabels?: string[]
  secure?: boolean
  error?: string
  bounds?: JxaElementBounds | null
  dialogs?: string[]
  errorState?: string | null
  pb?: number | null
}

/**
 * Infer newly appended text from an AX value-length change + trailing window.
 * Returns null when the change is not a simple append we can trust.
 */
export function appendFromValueTail(
  prevLen: number,
  nextTail: string,
  nextLen: number
): string | null {
  const delta = nextLen - prevLen
  if (delta <= 0) return null
  if (delta > 160) return null
  if (delta > nextTail.length) return nextTail
  return nextTail.slice(-delta)
}

export type JxaKeyEvent = {
  code: number
  chars?: string | null
  base?: string | null
  cmd?: boolean
  opt?: boolean
  ctrl?: boolean
  shift?: boolean
  repeat?: boolean
  secure?: boolean
  app?: string | null
  appBundleId?: string | null
  pb?: number | null
}

export type JxaClickEvent = {
  button?: 'left' | 'right'
  count?: number
  x?: number | null
  y?: number | null
  cmd?: boolean
  opt?: boolean
  ctrl?: boolean
  shift?: boolean
  app?: string | null
  appBundleId?: string | null
  role?: string | null
  subrole?: string | null
  identifier?: string | null
  label?: string | null
  valueLength?: number | null
  enabled?: boolean | null
  path?: string[]
  bounds?: JxaElementBounds | null
  /** Frame of the owning AXWindow when known. */
  windowBounds?: JxaElementBounds | null
  containerRole?: string | null
  containerLabel?: string | null
  rowIndex?: number | null
  siblingCount?: number | null
  /** 'poll' when synthesized from pressedMouseButtons; omit for NSEvent monitor. */
  via?: string | null
}

function sanitizeBounds(raw: JxaElementBounds | null | undefined): JxaElementBounds | undefined {
  if (!raw) return undefined
  if (
    typeof raw.x !== 'number' ||
    typeof raw.y !== 'number' ||
    typeof raw.width !== 'number' ||
    typeof raw.height !== 'number'
  ) {
    return undefined
  }
  if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return undefined
  if (!Number.isFinite(raw.width) || !Number.isFinite(raw.height)) return undefined
  if (raw.width < 0 || raw.height < 0) return undefined
  return {
    x: Math.round(raw.x),
    y: Math.round(raw.y),
    width: Math.round(raw.width),
    height: Math.round(raw.height)
  }
}

export type JxaCapabilities = {
  trusted: boolean
  monitors: boolean
  secureApi: boolean
}

const TEXT_ROLES = new Set(['AXTextField', 'AXTextArea', 'AXComboBox', 'AXSearchField'])

const ACTIVATABLE_ROLES = new Set([
  'AXButton',
  'AXMenuItem',
  'AXMenuButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXLink'
])

const ACTIVATION_WINDOW_MS = 1500
const FIELD_SETTLE_MS = 800
/** Typing is flushed into one text_input event after this much quiet. */
const TYPING_IDLE_MS = 1200
/** Bound on one entry's buffered characters; beyond it the entry is kept but uncertain. */
const MAX_BUFFER_CHARS = 2000
const MAX_CONSECUTIVE_FAULTS = 5

/** macOS virtual key codes that are edits or navigation rather than characters. */
const KEY_RETURN = 36
const KEY_KEYPAD_ENTER = 76
const KEY_TAB = 48
const KEY_ESCAPE = 53
const KEY_BACKSPACE = 51
const KEY_FORWARD_DELETE = 117

const SPECIAL_KEY_NAMES: Record<number, string> = {
  [KEY_RETURN]: 'Enter',
  [KEY_KEYPAD_ENTER]: 'Enter',
  [KEY_TAB]: 'Tab',
  [KEY_ESCAPE]: 'Esc',
  [KEY_BACKSPACE]: 'Delete',
  [KEY_FORWARD_DELETE]: 'ForwardDelete',
  49: 'Space',
  115: 'Home',
  116: 'PageUp',
  119: 'End',
  121: 'PageDown',
  123: 'Left',
  124: 'Right',
  125: 'Down',
  126: 'Up'
}

/** Keys that move the caret without changing text — they must not split an entry. */
const NAVIGATION_KEYS = new Set([115, 116, 119, 121, 123, 124, 125, 126])

type TypingBuffer = {
  chars: string[]
  /** Internal "entry is non-empty" gate (includes edits); never emitted. */
  keyCount: number
  /** A secure-field entry: holds no characters and flushes as credential_entered. */
  secure?: boolean
  /** Buffered character count (bounded by MAX_BUFFER_CHARS). */
  size?: number
  /** Input was dropped at the bound: the key text is incomplete. */
  overflow?: boolean
  /** Field identity (label + ancestor path + position) when the entry began; absent = unprovable. */
  fieldId?: string
  /** A sample showed a different field under the same label while the entry was open. */
  identityBroken?: boolean
  /** Characters came from key presses / from AX value deltas (no keys observed). */
  fromKeys?: boolean
  fromAx?: boolean
  contextKey: string
  appName?: string
  appBundleId?: string
  documentTitle?: string
  elementRole?: string
  elementLabel?: string
  redacted: boolean
  /** Recorder-clock readings: first and latest input of this entry. */
  startedAt: number
  lastAt: number
}

/**
 * macOS input + Accessibility provider backed by a long-lived
 * `osascript -l JavaScript` child (see JXA_SENSOR_SCRIPT).
 *
 * Produces real click and typing events by way of NSEvent global monitors, and
 * element identity via the Accessibility API. Both require the host app to hold
 * the Accessibility permission; without it the child stays alive but reports
 * `monitors: false` / empty AX attributes, and the recorder falls back to
 * accelerator-based shortcut capture.
 */
export class JxaAccessibilityProvider implements InteractionProvider {
  enabled = true
  private child: ChildProcessWithoutNullStreams | null = null
  /** Owned termination of `child`; the child is retained until its exit is observed. */
  private terminating: Promise<void> | null = null
  private rl: ReadlineInterface | null = null
  private onEvent: ((partial: InteractionPartial) => void) | null = null
  private disabled = false
  private faults = 0
  private lastFocusKey: string | null = null
  private lastSelectionKey: string | null = null
  private lastDialogKey: string | null = null
  private lastField: {
    label?: string
    role?: string
    length: number
    at: number
    grew: boolean
  } | null = null
  private pendingActivation: {
    label?: string
    role?: string
    appName?: string
    at: number
  } | null = null
  private fieldSettleTimer: ReturnType<typeof setTimeout> | null = null

  /** Latest AX context, used to attribute keystrokes to an element. */
  private context: {
    appName?: string
    appBundleId?: string
    documentTitle?: string
    elementRole?: string
    elementLabel?: string
    secure: boolean
    /** Label + ancestor path + position; absent when the sample has no bounds. */
    fieldId?: string
  } = { secure: false }

  private typing: TypingBuffer | null = null
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private capabilities: JxaCapabilities | null = null
  private onCapabilities: ((info: { capturesKeys: boolean }) => void) | null = null
  private readonly isAccessibilityTrusted: () => boolean
  /** Baseline for AX valueTail diffs (fallback when NSEvent keys never arrive). */
  private lastValueLen: { contextKey: string; length: number } | null = null
  /**
   * The focused ordinary field's complete AXValue (only when it fits the sensor's tail window),
   * with when it was observed: the committed value an entry is checked against at flush.
   */
  private lastFieldValue: { fieldId?: string; value: string | null; at: number } | null = null
  /** When key events are flowing, ignore valueTail to avoid double-counting. */
  /** Monotonic ms of the last key event; null until one arrives. */
  private lastKeyEventAt: number | null = null
  /** The recorder's monotonic clock, so occurrence times share its origin. */
  private now: () => number = () => performance.now()
  private pasteboard: number | undefined

  pasteboardCount(): number | undefined {
    return this.pasteboard
  }

  /** Track the sensor's pasteboard changeCount; an unknown count matches nothing. */
  private notePasteboard(pb: unknown): void {
    this.pasteboard = typeof pb === 'number' && Number.isFinite(pb) ? pb : undefined
  }

  constructor(opts: { isAccessibilityTrusted?: () => boolean } = {}) {
    this.isAccessibilityTrusted = opts.isAccessibilityTrusted ?? (() => true)
  }

  /**
   * True when real key presses are expected to arrive. The recorder uses this to
   * decide whether it must register global accelerators instead (which steal the
   * chord from the recorded app).
   */
  get capturesKeys(): boolean {
    if (this.disabled || process.platform !== 'darwin') return false
    if (this.capabilities) return this.capabilities.monitors && this.capabilities.trusted
    // Before the handshake arrives, trust status is the best predictor.
    return this.isAccessibilityTrusted()
  }

  /**
   * Notified once the child reports what it can actually observe, which may
   * contradict the optimistic guess made at start time.
   */
  onCapabilityChange(cb: (info: { capturesKeys: boolean }) => void): void {
    this.onCapabilities = cb
    if (this.capabilities) cb({ capturesKeys: this.capturesKeys })
  }

  start(onEvent: (partial: InteractionPartial) => void, scope?: AppScope, clock?: () => number): void {
    if (clock) this.now = clock
    this.pasteboard = undefined
    if (this.disabled || process.platform !== 'darwin') {
      this.enabled = false
      return
    }
    // Never overlap children: a previous child that has not been observed to exit blocks
    // a replacement (the recorder refuses to start while `teardownPending`).
    if (this.child) {
      console.error('[telemetry/ax] previous sensor has not exited; not starting another')
      this.enabled = false
      return
    }
    this.enabled = true
    this.onEvent = onEvent
    this.lastFocusKey = null
    this.lastSelectionKey = null
    this.lastDialogKey = null
    this.lastField = null
    this.pendingActivation = null
    this.faults = 0
    this.capabilities = null
    this.context = { secure: false }
    this.typing = null

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_SENSOR_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // The sensor exits on its own once this process is no longer its parent, and reads
        // nothing from apps outside `scope` (no scope = reads nothing).
        env: { ...process.env, GRAY_JXA_PARENT_PID: String(process.pid), GRAY_JXA_SCOPE: JSON.stringify(scope ?? null) }
      })
    } catch (err) {
      console.error('[telemetry/ax] spawn failed', err instanceof Error ? err.name : 'error')
      this.disable()
      return
    }
    this.child = child

    // Every callback is bound to this exact child: an old child's late output or exit can
    // never feed or clear a newer generation.
    const rl = createInterface({ input: child.stdout })
    this.rl = rl
    rl.on('line', (line) => {
      if (this.child === child) this.handleLine(line)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      // The sensor speaks on stdout; anything here is a real failure. Log only that it
      // happened, never the payload, which could contain AX contents.
      if (this.child === child && String(chunk).trim()) console.error('[telemetry/ax] sensor stderr')
    })

    child.on('error', (err) => {
      if (this.child !== child) return
      console.error('[telemetry/ax] process error', err.name)
      this.disable()
    })

    child.on('exit', (code) => {
      if (this.child !== child) return
      // An exit during an intentional stop (onEvent already cleared) is the expected outcome.
      if (this.onEvent && !this.disabled && code !== 0 && code !== null) {
        console.error('[telemetry/ax] exited', code)
        this.disable()
      }
      this.child = null
      this.rl = null
    })
  }

  /** True while a stopped child has not yet been observed to exit (no replacement allowed). */
  get teardownPending(): boolean {
    return !!this.child && !this.onEvent
  }

  /**
   * Resolves once the child is observed to exit (SIGTERM, then SIGKILL after a grace
   * period); rejects with ChildTerminationError if it has not exited by the deadline. The
   * child stays owned until it exits; repeated calls join the same termination.
   */
  stop(): Promise<void> {
    this.flush()
    if (this.fieldSettleTimer) {
      clearTimeout(this.fieldSettleTimer)
      this.fieldSettleTimer = null
    }
    if (this.typingTimer) {
      clearTimeout(this.typingTimer)
      this.typingTimer = null
    }
    this.onEvent = null
    this.pendingActivation = null
    this.lastField = null
    try {
      this.rl?.close()
    } catch {
      /* ignore */
    }
    this.rl = null
    const child = this.child
    if (!child) return Promise.resolve()
    if (!this.terminating) {
      const t = terminateChild(child)
      this.terminating = t
      // Only an observed exit releases ownership (the exit handler clears `child`).
      void t.then(
        () => {
          if (this.terminating === t) this.terminating = null
        },
        () => {
          if (this.terminating === t) this.terminating = null
        }
      )
    }
    return this.terminating
  }

  /**
   * The sensor samples on its own schedule, so there is nothing to request. Kept
   * so callers can signal "state probably just changed" without special-casing.
   */
  poke(): void {
    /* no-op: the sensor re-samples right after every observed input */
  }

  /** Emit any in-progress typing immediately (session stop, app switch, …). */
  flush(): void {
    this.flushTyping()
  }

  /** Exposed for tests — parse one stdout NDJSON line. */
  handleLine(line: string): void {
    if (!this.onEvent || this.disabled) return
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      return
    }

    switch (parsed.k) {
      case 'ready': {
        const caps: JxaCapabilities = {
          trusted: parsed.trusted === true,
          monitors: parsed.monitors === true,
          secureApi: parsed.secureApi === true
        }
        this.capabilities = caps
        if (!caps.trusted) {
          console.warn(
            '[telemetry/ax] Accessibility permission not granted — clicks, typing and ' +
              'element labels will not be captured. Grant it in System Settings › ' +
              'Privacy & Security › Accessibility, then restart the app.'
          )
        } else if (!caps.monitors) {
          console.warn('[telemetry/ax] input monitors unavailable — falling back to shortcuts only')
        }
        this.onCapabilities?.({ capturesKeys: this.capturesKeys })
        return
      }
      case 'stats':
        return
      case 'key':
        this.faults = 0
        this.notePasteboard(parsed.pb)
        this.handleKey(parsed as unknown as JxaKeyEvent)
        return
      case 'copy':
        this.faults = 0
        this.handleCopy(parsed)
        return
      case 'click':
        this.faults = 0
        this.handleClick(parsed as unknown as JxaClickEvent)
        return
      case 'scroll':
        this.faults = 0
        this.handleScroll(parsed as {
          axis?: 'vertical' | 'horizontal'
          delta?: number
          x?: number | null
          y?: number | null
          app?: string | null
          appBundleId?: string | null
          role?: string | null
          label?: string | null
          windowBounds?: JxaElementBounds | null
          containerRole?: string | null
          containerLabel?: string | null
        })
        return
      case 'fault': {
        // Transient AX read failures happen; only give up if they persist.
        this.faults += 1
        if (this.faults >= MAX_CONSECUTIVE_FAULTS) {
          console.error('[telemetry/ax] repeated sensor faults — disabling')
          this.disable()
        }
        return
      }
      default: {
        const sample = parsed as unknown as JxaSample
        if (sample.error) {
          console.error('[telemetry/ax] sample error')
          this.disable()
          return
        }
        this.faults = 0
        this.notePasteboard(sample.pb)
        this.emitFromSample(sample)
      }
    }
  }

  /** Unit-test helper: process an AX sample without spawning. */
  emitFromSample(sample: JxaSample): void {
    if (!this.onEvent) return

    const appName = sanitizeLabel(sample.appName)
    const appBundleId = sanitizeLabel(sample.appBundleId)
    const windowTitle = sanitizeWindowTitle(sample.windowTitle)
    const documentTitle = sanitizeWindowTitle(sample.documentTitle)
    const elementRole = sanitizeLabel(sample.elementRole)
    const elementSubrole = sanitizeLabel(sample.elementSubrole)
    const elementLabel = sanitizeLabel(sample.elementLabel)
    const elementPath = (sample.elementPath ?? [])
      .map((p) => sanitizeLabel(p))
      .filter((p): p is string => !!p)
      .slice(0, 3)
    const selectedLabels = (sample.selectedLabels ?? [])
      .map((l) => sanitizeLabel(l))
      .filter((l): l is string => !!l)
      .slice(0, 5)
    const dialogs = (sample.dialogs ?? [])
      .map((d) => sanitizeLabel(d))
      .filter((d): d is string => !!d)
      .slice(0, 8)
    const errorState = sanitizeLabel(sample.errorState ?? undefined)
    const elementBounds = sanitizeBounds(sample.bounds)
    const secure =
      sample.secure === true ||
      elementRole === 'AXSecureTextField' ||
      elementSubrole === 'AXSecureTextField'
    // A secure field never yields a length, even if a sensor reported one.
    const valueLength =
      !secure && typeof sample.valueLength === 'number' && sample.valueLength >= 0
        ? sample.valueLength
        : undefined

    const baseData = {
      appName,
      appBundleId,
      windowTitle,
      documentTitle,
      elementRole,
      elementSubrole,
      elementLabel,
      elementPath: elementPath.length ? elementPath : undefined,
      selectedLabels: selectedLabels.length ? selectedLabels : undefined,
      dialogs: dialogs.length ? dialogs : undefined,
      errorState,
      elementBounds
    }

    // Focus context drives keystroke attribution. Deliberately excludes
    // valueLength: typing changes it constantly and must not look like a new
    // element (that would emit a focus_changed per character).
    const nextContextKey = [appName, documentTitle, elementRole, elementLabel].join('|')
    if (this.typing && this.typing.contextKey !== nextContextKey) {
      this.flushTyping()
    }
    const fieldId = elementBounds
      ? [nextContextKey, elementPath.join('>'), elementBounds.x, elementBounds.y].join('|')
      : undefined
    this.context = {
      appName,
      appBundleId,
      documentTitle,
      elementRole,
      elementLabel,
      secure,
      fieldId
    }
    // Same label, different field (path/position): the open entry can no longer be confirmed.
    if (this.typing && (!fieldId || this.typing.fieldId !== fieldId)) this.typing.identityBroken = true
    // The open entry belongs to this same target (a different one was flushed above).
    if (secure) this.secureOpenEntry()

    if (nextContextKey !== this.lastFocusKey) {
      this.lastFocusKey = nextContextKey
      this.lastValueLen = null
      this.onEvent({
        type: 'focus_changed',
        target: {
          role: elementRole,
          accessibleLabel: elementLabel,
          visibleLabel: elementLabel,
          appName,
          appBundleId,
          fieldType: secure ? 'password' : elementRole && TEXT_ROLES.has(elementRole) ? 'text' : undefined
        },
        data: {
          ...baseData,
          field: secure
            ? { label: elementLabel, fieldType: 'password', valueCategory: 'redacted' }
            : elementRole && TEXT_ROLES.has(elementRole)
              ? {
                  label: elementLabel,
                  fieldType: 'text',
                  completed: (valueLength ?? 0) > 0,
                  valueCategory: (valueLength ?? 0) > 0 ? 'text' : 'empty',
                  valueLength
                }
              : undefined
        }
      })
    }

    // Surface dialogs/sheets as error signals when they newly appear.
    const dialogKey = dialogs.join('|')
    if (dialogKey && dialogKey !== this.lastDialogKey) {
      this.lastDialogKey = dialogKey
      const fileKind = classifyFileDialog(dialogs[0] || errorState || '')
      if (fileKind) {
        this.onEvent({
          type: 'file_dialog',
          data: {
            ...baseData,
            fileDialogKind: fileKind,
            message: dialogs[0] || errorState || undefined,
            dialogs
          }
        })
      } else {
        this.onEvent({
          type: 'error',
          data: {
            ...baseData,
            message: errorState || dialogs[0],
            errorState: errorState || dialogs[0],
            dialogs
          }
        })
      }
    } else if (!dialogKey) {
      this.lastDialogKey = null
    }

    this.ingestValueTail(sample, nextContextKey)
    const complete =
      !secure &&
      typeof sample.valueTail === 'string' &&
      typeof sample.valueLength === 'number' &&
      sample.valueTail.length === sample.valueLength
    this.lastFieldValue = {
      fieldId,
      value: complete ? (sample.valueTail as string) : null,
      at: this.now()
    }

    const selectionKey = selectedLabels.join('|')
    if (selectionKey && selectionKey !== this.lastSelectionKey) {
      this.lastSelectionKey = selectionKey
      this.onEvent({
        type: 'selection_changed',
        target: {
          accessibleLabel: selectedLabels[0],
          visibleLabel: selectedLabels[0],
          appName,
          appBundleId
        },
        data: {
          ...baseData,
          selectionLabel: selectedLabels[0],
          selectedLabels
        }
      })
    }

    // Track activatable focus for inferred activation. Real clicks are reported
    // directly; this still covers keyboard-driven activation.
    if (elementRole && ACTIVATABLE_ROLES.has(elementRole)) {
      this.pendingActivation = {
        label: elementLabel,
        role: elementRole,
        appName,
        at: this.now()
      }
    } else if (this.pendingActivation) {
      const age = this.now() - this.pendingActivation.at
      if (age <= ACTIVATION_WINDOW_MS) {
        const act = this.pendingActivation
        this.pendingActivation = null
        this.onEvent({
          type: 'element_activated',
          target: {
            role: act.role,
            accessibleLabel: act.label,
            visibleLabel: act.label,
            appName: act.appName
          },
          data: {
            ...baseData,
            elementRole: act.role,
            elementLabel: act.label,
            inferred: true
          }
        })
      } else {
        this.pendingActivation = null
      }
    }

    // Field completion: length grew then settled.
    if (elementRole && TEXT_ROLES.has(elementRole) && valueLength != null) {
      const prev = this.lastField
      if (!prev || prev.label !== elementLabel || prev.role !== elementRole) {
        this.lastField = {
          label: elementLabel,
          role: elementRole,
          length: valueLength,
          at: this.now(),
          grew: false
        }
      } else if (valueLength > prev.length) {
        this.lastField = {
          ...prev,
          length: valueLength,
          at: this.now(),
          grew: true
        }
        if (this.fieldSettleTimer) clearTimeout(this.fieldSettleTimer)
        this.fieldSettleTimer = setTimeout(() => {
          const field = this.lastField
          if (!field || !field.grew || !this.onEvent) return
          this.onEvent({
            type: 'field_completed',
            target: {
              role: field.role,
              accessibleLabel: field.label,
              visibleLabel: field.label,
              appName,
              fieldType: 'text'
            },
            data: {
              appName,
              appBundleId,
              documentTitle,
              elementRole: field.role,
              elementLabel: field.label,
              field: {
                label: field.label,
                fieldType: 'text',
                completed: true,
                valueCategory: 'text',
                valueLength: field.length
              }
            }
          })
          field.grew = false
        }, FIELD_SETTLE_MS)
      } else if (valueLength < prev.length) {
        // Length dropped — may indicate send/clear; keep tracking.
        this.lastField = {
          ...prev,
          length: valueLength,
          at: this.now(),
          grew: false
        }
      }
    }
  }

  /**
   * When NSEvent key monitors are silent, recover typed characters from AX
   * value length + trailing window (never for secure fields).
   */
  private ingestValueTail(sample: JxaSample, contextKey: string): void {
    if (!this.onEvent) return
    if (sample.secure === true || this.context.secure) {
      this.lastValueLen = null
      return
    }
    if (typeof sample.valueTail !== 'string') return
    if (typeof sample.valueLength !== 'number' || sample.valueLength < 0) return

    const prev = this.lastValueLen?.contextKey === contextKey ? this.lastValueLen : null
    this.lastValueLen = { contextKey, length: sample.valueLength }

    // Key monitors own the buffer when they are delivering events.
    if (this.lastKeyEventAt !== null && this.now() - this.lastKeyEventAt < 1500) return
    if (!prev) return

    if (sample.valueLength < prev.length) {
      this.flushTyping()
      return
    }

    const appended = appendFromValueTail(prev.length, sample.valueTail, sample.valueLength)
    if (!appended) return
    // Terminal AXValue is the whole scrollback — refuse prompt/output fragments.
    if (
      /terminal|iterm|warp|kitty/i.test(this.context.appName ?? '') &&
      looksLikeShellNoise(appended)
    ) {
      return
    }

    const buffer = this.ensureTypingFromContext()
    buffer.fromAx = true
    this.pushChars(buffer, appended)
    buffer.keyCount += Math.max(1, appended.length)
    this.armTypingTimer()
  }

  private ensureTypingFromContext(): TypingBuffer {
    const appName = this.context.appName
    const contextKey = [
      appName,
      this.context.documentTitle,
      this.context.elementRole,
      this.context.elementLabel
    ].join('|')

    if (this.typing && this.typing.contextKey === contextKey) return this.typing
    if (this.typing) this.flushTyping()

    this.typing = {
      chars: [],
      keyCount: 0,
      contextKey,
      appName,
      appBundleId: this.context.appBundleId,
      documentTitle: this.context.documentTitle,
      elementRole: this.context.elementRole,
      elementLabel: this.context.elementLabel,
      redacted: false,
      fieldId: this.context.fieldId,
      startedAt: this.now(),
      lastAt: this.now()
    }
    return this.typing
  }

  /** A copy the sensor verified (one pasteboard change by the in-scope chord app). */
  handleCopy(line: Record<string, unknown>): void {
    if (!this.onEvent || typeof line.pb !== 'number') return
    this.notePasteboard(line.pb)
    const appName = sanitizeLabel(typeof line.app === 'string' ? line.app : undefined)
    if (!appName) return
    const appBundleId = sanitizeLabel(typeof line.appBundleId === 'string' ? line.appBundleId : undefined)
    const types = Array.isArray(line.types) ? line.types.filter((t): t is string => typeof t === 'string') : []
    // The focused element is only meaningful if the AX context is the copying app's.
    const el: { elementLabel?: string; elementRole?: string } = this.context.appName === appName ? this.context : {}
    this.onEvent({
      type: 'clipboard_changed',
      target: { appName, appBundleId, accessibleLabel: el.elementLabel },
      data: { appName, appBundleId, elementRole: el.elementRole, elementLabel: el.elementLabel },
      copy: { text: typeof line.text === 'string' ? line.text : null, types, pasteboard: line.pb }
    })
  }

  /** Exposed for tests — handle one observed key press. */
  handleKey(event: JxaKeyEvent): void {
    if (!this.onEvent) return
    this.lastKeyEventAt = this.now()

    const secure = event.secure === true || this.context.secure
    const isChord = event.cmd === true || event.ctrl === true
    const code = typeof event.code === 'number' ? event.code : -1
    // Before any path (chord, submit, idle, Stop) can flush the open entry as text.
    if (secure) this.secureOpenEntry()

    if (isChord) {
      // A chord usually ends an entry (Cmd+Enter sends, Cmd+S saves).
      this.flushTyping()
      const chord = describeChord(event)
      if (!chord) return
      this.onEvent({
        type: 'keyboard_shortcut',
        target: {
          appName: this.context.appName,
          appBundleId: this.context.appBundleId,
          accessibleLabel: this.context.elementLabel
        },
        data: {
          appName: event.app ? sanitizeLabel(event.app) : this.context.appName,
          appBundleId: this.context.appBundleId,
          documentTitle: this.context.documentTitle,
          elementRole: this.context.elementRole,
          elementLabel: this.context.elementLabel,
          shortcut: chord
        }
      })
      return
    }

    if (secure) {
      // Never buffer characters typed into a password field: only that a credential was entered.
      // Characters already buffered for this same field (focus race) are discarded, not emitted.
      const buffer = this.ensureTyping(event)
      buffer.secure = true
      buffer.chars = []
      buffer.keyCount += 1
      if (code === KEY_RETURN || code === KEY_KEYPAD_ENTER) this.flushTyping('Return')
      else if (code === KEY_TAB) this.flushTyping('Tab')
      else this.armTypingTimer()
      return
    }

    // Shift+Return in a multi-line field is a newline, not a submit.
    if (code === KEY_RETURN && event.shift === true && this.context.elementRole === 'AXTextArea') {
      const buffer = this.ensureTyping(event)
      buffer.keyCount += 1
      buffer.fromKeys = true
      this.pushChars(buffer, '\n')
      this.armTypingTimer()
      return
    }
    if (code === KEY_RETURN || code === KEY_KEYPAD_ENTER) {
      this.countKey(event)
      if (this.typing && this.typing.keyCount > 0) {
        this.flushTyping('Return')
      } else {
        this.emitBareKey('Return', event)
      }
      return
    }
    if (code === KEY_TAB) {
      this.countKey(event)
      if (this.typing && this.typing.keyCount > 0) {
        this.flushTyping('Tab')
      } else {
        this.emitBareKey('Tab', event)
      }
      return
    }
    if (code === KEY_ESCAPE) {
      this.countKey(event)
      if (this.typing && this.typing.keyCount > 0) {
        this.flushTyping('Escape')
      } else {
        this.emitBareKey('Escape', event)
      }
      return
    }
    if (code === KEY_BACKSPACE) {
      const buffer = this.ensureTyping(event)
      buffer.keyCount += 1
      const popped = buffer.chars.pop()
      if (popped) buffer.size = Math.max(0, (buffer.size ?? 0) - popped.length)
      this.armTypingTimer()
      return
    }
    if (NAVIGATION_KEYS.has(code)) {
      if (event.repeat === true) return
      if (this.typing && this.typing.keyCount > 0) {
        this.countKey(event)
        this.armTypingTimer()
        return
      }
      const name = SPECIAL_KEY_NAMES[code]
      if (name) this.emitBareKey(name, event)
      return
    }
    if (code === KEY_FORWARD_DELETE) {
      // Editing/caret movement: keeps the entry open but adds no characters.
      this.countKey(event)
      this.armTypingTimer()
      return
    }

    const printable = printableChars(event.chars)
    if (!printable) {
      this.countKey(event)
      return
    }

    const buffer = this.ensureTyping(event)
    buffer.keyCount += 1
    buffer.fromKeys = true
    this.pushChars(buffer, printable)
    this.armTypingTimer()
  }

  handleScroll(event: {
    axis?: 'vertical' | 'horizontal'
    delta?: number
    x?: number | null
    y?: number | null
    app?: string | null
    appBundleId?: string | null
    role?: string | null
    label?: string | null
    windowBounds?: JxaElementBounds | null
    containerRole?: string | null
    containerLabel?: string | null
  }): void {
    if (!this.onEvent) return
    const appName = sanitizeLabel(event.app ?? undefined) ?? this.context.appName
    const appBundleId = sanitizeLabel(event.appBundleId ?? undefined) ?? this.context.appBundleId
    const clickX =
      typeof event.x === 'number' && Number.isFinite(event.x) ? Math.round(event.x) : undefined
    const clickY =
      typeof event.y === 'number' && Number.isFinite(event.y) ? Math.round(event.y) : undefined
    const windowBounds = sanitizeBounds(event.windowBounds)
    let clickWindowX: number | undefined
    let clickWindowY: number | undefined
    if (windowBounds && clickX != null && clickY != null) {
      clickWindowX = clickX - windowBounds.x
      clickWindowY = clickY - windowBounds.y
    }
    this.onEvent({
      type: 'scroll',
      target: {
        role: sanitizeLabel(event.role ?? undefined),
        accessibleLabel: sanitizeLabel(event.label ?? undefined),
        visibleLabel: sanitizeLabel(event.label ?? undefined),
        appName,
        appBundleId,
        listContext: {
          containerRole: sanitizeLabel(event.containerRole ?? undefined),
          containerLabel: sanitizeLabel(event.containerLabel ?? undefined)
        }
      },
      data: {
        appName,
        appBundleId,
        documentTitle: this.context.documentTitle,
        scrollAxis: event.axis === 'horizontal' ? 'horizontal' : 'vertical',
        scrollDelta: typeof event.delta === 'number' ? event.delta : undefined,
        scrollContainerRole: sanitizeLabel(event.containerRole ?? undefined),
        scrollContainerLabel: sanitizeLabel(event.containerLabel ?? undefined),
        elementRole: sanitizeLabel(event.role ?? undefined),
        elementLabel: sanitizeLabel(event.label ?? undefined),
        clickX,
        clickY,
        clickWindowX,
        clickWindowY,
        windowBounds
      }
    })
  }

  /** Exposed for tests — handle one observed mouse press. */
  handleClick(event: JxaClickEvent): void {
    if (!this.onEvent) return

    const appName = sanitizeLabel(event.app ?? undefined) ?? this.context.appName
    const appBundleId = sanitizeLabel(event.appBundleId ?? undefined) ?? this.context.appBundleId
    const role = sanitizeLabel(event.role ?? undefined)
    const subrole = sanitizeLabel(event.subrole ?? undefined)
    const label = sanitizeLabel(event.label ?? undefined)
    const path = (event.path ?? [])
      .map((p) => sanitizeLabel(p))
      .filter((p): p is string => !!p)
      .slice(0, 3)

    // Clicking a different element ends the previous entry.
    if (this.typing && label && label !== this.typing.elementLabel) {
      this.flushTyping()
    }

    // A click resolves activation directly — no need to infer one afterwards.
    this.pendingActivation = null

    const clickX =
      typeof event.x === 'number' && Number.isFinite(event.x) ? Math.round(event.x) : undefined
    const clickY =
      typeof event.y === 'number' && Number.isFinite(event.y) ? Math.round(event.y) : undefined
    const bounds = sanitizeBounds(event.bounds)
    const windowBounds = sanitizeBounds(event.windowBounds)
    const identifier = sanitizeLabel(event.identifier ?? undefined)
    const enabled = typeof event.enabled === 'boolean' ? event.enabled : undefined
    const listContext =
      event.containerRole || event.rowIndex != null || event.siblingCount != null
        ? {
            rowIndex:
              typeof event.rowIndex === 'number' && event.rowIndex >= 0
                ? Math.round(event.rowIndex)
                : undefined,
            siblingCount:
              typeof event.siblingCount === 'number' && event.siblingCount >= 0
                ? Math.round(event.siblingCount)
                : undefined,
            containerRole: sanitizeLabel(event.containerRole ?? undefined),
            containerLabel: sanitizeLabel(event.containerLabel ?? undefined)
          }
        : undefined

    let elementNorm: { x: number; y: number } | undefined
    if (
      bounds &&
      clickX != null &&
      clickY != null &&
      bounds.width > 0 &&
      bounds.height > 0
    ) {
      elementNorm = {
        x: Math.min(1, Math.max(0, (clickX - bounds.x) / bounds.width)),
        y: Math.min(1, Math.max(0, (clickY - bounds.y) / bounds.height))
      }
    }

    const hasModifiers =
      event.cmd === true || event.opt === true || event.ctrl === true || event.shift === true

    let clickWindowX: number | undefined
    let clickWindowY: number | undefined
    if (windowBounds && clickX != null && clickY != null) {
      clickWindowX = clickX - windowBounds.x
      clickWindowY = clickY - windowBounds.y
    }

    const tier = resolveTargetTier({
      role,
      label,
      clickX,
      clickY
    })

    this.onEvent({
      type: 'click',
      target: {
        role,
        accessibleLabel: label,
        visibleLabel: label,
        identifier,
        appName,
        appBundleId,
        enabled,
        tier,
        listContext,
        fieldType: role && TEXT_ROLES.has(role) ? 'text' : undefined
      },
      data: {
        appName,
        appBundleId,
        documentTitle: this.context.documentTitle,
        elementRole: role,
        elementSubrole: subrole,
        elementLabel: label,
        elementIdentifier: identifier,
        elementEnabled: enabled,
        elementPath: path.length ? path : undefined,
        listContext,
        targetTier: tier,
        clickButton: event.button === 'right' ? 'right' : 'left',
        clickCount: clampClickCount(event.count),
        clickModifiers: hasModifiers
          ? {
              cmd: event.cmd === true,
              opt: event.opt === true,
              ctrl: event.ctrl === true,
              shift: event.shift === true
            }
          : undefined,
        clickX,
        clickY,
        clickWindowX,
        clickWindowY,
        windowBounds,
        elementNorm,
        elementBounds: bounds
      }
    })
  }

  /** Evidence the open entry is secure: discard its characters; it flushes as credential_entered. */
  private secureOpenEntry(): void {
    if (!this.typing || this.typing.secure) return
    this.typing.secure = true
    this.typing.chars = []
  }

  /** Bounded append: past MAX_BUFFER_CHARS input is dropped and the entry marked incomplete. */
  private pushChars(buffer: TypingBuffer, text: string): void {
    const size = buffer.size ?? 0
    if (size + text.length > MAX_BUFFER_CHARS) {
      buffer.overflow = true
      return
    }
    buffer.chars.push(text)
    buffer.size = size + text.length
  }

  /**
   * The same field's complete AXValue observed at or after the entry's last input. An entry is
   * exact only when that committed value equals the key text: then the field held nothing else
   * and nothing (IME, caret moves, selection replacement, autocomplete, overflow) changed it.
   */
  private committedValue(buffer: TypingBuffer): string | null {
    // Only key input can be confirmed: an AX-delta entry would be compared with its own source.
    if (!buffer.fromKeys || buffer.fromAx || buffer.identityBroken || !buffer.fieldId) return null
    const field = this.lastFieldValue
    if (!field || field.fieldId !== buffer.fieldId || field.at < buffer.lastAt) return null
    return field.value ? field.value : null
  }

  private countKey(event: JxaKeyEvent): void {
    if (!this.typing) return
    if (event.repeat === true) return
    this.typing.keyCount += 1
  }

  private ensureTyping(event: JxaKeyEvent): TypingBuffer {
    const appName = sanitizeLabel(event.app ?? undefined) ?? this.context.appName
    const contextKey = [
      appName,
      this.context.documentTitle,
      this.context.elementRole,
      this.context.elementLabel
    ].join('|')

    if (this.typing && this.typing.contextKey === contextKey) return this.typing
    if (this.typing) this.flushTyping()

    this.typing = {
      chars: [],
      keyCount: 0,
      contextKey,
      appName,
      appBundleId: this.context.appBundleId,
      documentTitle: this.context.documentTitle,
      elementRole: this.context.elementRole,
      elementLabel: this.context.elementLabel,
      redacted: false,
      fieldId: this.context.fieldId,
      startedAt: this.now(),
      lastAt: this.now()
    }
    return this.typing
  }

  private armTypingTimer(): void {
    if (this.typing) this.typing.lastAt = this.now()
    if (this.typingTimer) clearTimeout(this.typingTimer)
    this.typingTimer = setTimeout(() => {
      this.typingTimer = null
      this.flushTyping()
    }, TYPING_IDLE_MS)
  }

  private flushTyping(submitKey?: string): void {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer)
      this.typingTimer = null
    }
    const buffer = this.typing
    this.typing = null
    if (!buffer || !this.onEvent) return
    if (buffer.keyCount === 0) return

    if (buffer.secure) {
      this.onEvent({
        type: 'credential_entered',
        startedAt: buffer.startedAt,
        occurredAt: submitKey ? this.now() : buffer.lastAt,
        target: {
          role: buffer.elementRole,
          accessibleLabel: buffer.elementLabel,
          visibleLabel: buffer.elementLabel,
          appName: buffer.appName,
          appBundleId: buffer.appBundleId,
          fieldType: 'password'
        },
        data: {
          appName: buffer.appName,
          appBundleId: buffer.appBundleId,
          documentTitle: buffer.documentTitle,
          elementRole: buffer.elementRole,
          elementLabel: buffer.elementLabel,
          submitKey
        }
      })
      return
    }

    const { text, redacted, truncated } = sanitizeTypedText(buffer.chars.join(''))
    if (!text && !submitKey) return
    const committed = buffer.overflow || truncated ? null : this.committedValue(buffer)
    const confirmed = committed != null && sanitizeTypedText(committed).text === text

    const role = buffer.elementRole
    this.onEvent({
      type: 'text_input',
      // When the entry happened, not when it was flushed (idle timer, focus change, Stop).
      startedAt: buffer.startedAt,
      occurredAt: submitKey ? this.now() : buffer.lastAt,
      target: {
        role,
        accessibleLabel: buffer.elementLabel,
        visibleLabel: buffer.elementLabel,
        appName: buffer.appName,
        appBundleId: buffer.appBundleId,
        fieldType: role && TEXT_ROLES.has(role) ? 'text' : undefined
      },
      data: {
        appName: buffer.appName,
        appBundleId: buffer.appBundleId,
        documentTitle: buffer.documentTitle,
        elementRole: role,
        elementLabel: buffer.elementLabel,
        typedText: text,
        typedTextRedacted: redacted || buffer.redacted ? true : undefined,
        ...(text
          ? {
              // Key text either way; the field value only ever confirms it.
              textQuality: confirmed ? 'exact' : 'uncertain',
              // Recorded only when known: mixed key/AX entries carry no method.
              ...(buffer.fromKeys && !buffer.fromAx
                ? { textSource: 'keys' }
                : buffer.fromAx && !buffer.fromKeys
                  ? { textSource: 'ax_value_delta' }
                  : {})
            }
          : {}),
        submitKey
      }
    })
  }

  /** Bare Enter/Esc/Tab/arrows when no typing buffer absorbed them. */
  private emitBareKey(key: string, event: JxaKeyEvent): void {
    if (!this.onEvent) return
    if (event.repeat === true) return
    this.onEvent({
      type: 'key_pressed',
      target: {
        appName: this.context.appName,
        appBundleId: this.context.appBundleId,
        accessibleLabel: this.context.elementLabel,
        role: this.context.elementRole
      },
      data: {
        appName: event.app ? sanitizeLabel(event.app) : this.context.appName,
        appBundleId: this.context.appBundleId,
        documentTitle: this.context.documentTitle,
        elementRole: this.context.elementRole,
        elementLabel: this.context.elementLabel,
        shortcut: key
      }
    })
  }

  private disable(): void {
    this.disabled = true
    this.enabled = false
    void this.stop().catch(() => undefined)
  }
}

/** Grace period before SIGKILL; the barrier never waits longer than grace + settle. */
export const CHILD_STOP_GRACE_MS = 1000
const CHILD_STOP_SETTLE_MS = 500

/** The child was not observed to exit by the deadline: teardown is unconfirmed. */
export class ChildTerminationError extends Error {
  constructor() {
    super('[telemetry/ax] sensor did not exit')
  }
}

/**
 * End stdin, SIGTERM, then SIGKILL after the grace period. Resolves only on an observed
 * exit; rejects with ChildTerminationError at the deadline (never a silent success). Every
 * teardown path is attempted even if one throws; timers and the listener are removed.
 */
export function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let kill: ReturnType<typeof setTimeout> | null = null
    let giveUp: ReturnType<typeof setTimeout> | null = null
    const clear = () => {
      if (kill) clearTimeout(kill)
      if (giveUp) clearTimeout(giveUp)
      child.removeListener('exit', done)
    }
    const done = () => {
      clear()
      resolve()
    }
    child.once('exit', done)
    try {
      child.stdin.end()
    } catch {
      /* ignore */
    }
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    kill = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, CHILD_STOP_GRACE_MS)
    giveUp = setTimeout(() => {
      clear()
      reject(new ChildTerminationError())
    }, CHILD_STOP_GRACE_MS + CHILD_STOP_SETTLE_MS)
  })
}

function clampClickCount(count?: number): number | undefined {
  if (typeof count !== 'number' || !Number.isFinite(count)) return undefined
  return Math.min(10, Math.max(1, Math.round(count)))
}

/** Detect Open/Save file dialogs from sheet titles. */
function classifyFileDialog(title: string): 'open' | 'save' | null {
  const t = title.toLowerCase()
  if (/\b(save|export|download as|save as)\b/.test(t)) return 'save'
  if (/\b(open|choose|select|import|upload|attach)\b/.test(t)) return 'open'
  return null
}

/**
 * Keep only characters a text field would actually receive. NSEvent encodes
 * arrows and function keys in the Unicode private-use area, which must not be
 * mistaken for typed text.
 */
function printableChars(chars?: string | null): string | null {
  if (!chars) return null
  let out = ''
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) continue
    if (code >= 0xf700 && code <= 0xf8ff) continue
    out += ch
  }
  return out.length ? out : null
}

/** Render an observed chord the way the automation compiler expects it. */
export function describeChord(event: JxaKeyEvent): string | null {
  const parts: string[] = []
  if (event.cmd) parts.push('Cmd')
  if (event.ctrl) parts.push('Ctrl')
  if (event.opt) parts.push('Alt')
  if (event.shift) parts.push('Shift')

  const special = SPECIAL_KEY_NAMES[event.code]
  let key = special
  if (!key) {
    const base = printableChars(event.base) ?? printableChars(event.chars)
    if (!base) return null
    key = base.length === 1 ? base.toUpperCase() : base
  }
  if (!key) return null

  // A bare special key with no modifiers is not a shortcut worth recording.
  if (parts.length === 0) return null
  parts.push(key)
  return parts.join('+')
}
