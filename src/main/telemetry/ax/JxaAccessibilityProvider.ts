import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import {
  sanitizeLabel,
  sanitizeTypedText,
  sanitizeWindowTitle
} from '../../../shared/telemetry/sanitize'
import type { InteractionPartial, InteractionProvider } from '../providers'
import { looksLikeShellNoise } from '../automation/groundText'
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
  keyCount: number
  contextKey: string
  appName?: string
  appBundleId?: string
  documentTitle?: string
  elementRole?: string
  elementLabel?: string
  redacted: boolean
  startedAt: number
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
  } = { secure: false }

  private typing: TypingBuffer | null = null
  private typingTimer: ReturnType<typeof setTimeout> | null = null
  private capabilities: JxaCapabilities | null = null
  private onCapabilities: ((info: { capturesKeys: boolean }) => void) | null = null
  private readonly isAccessibilityTrusted: () => boolean
  /** Baseline for AX valueTail diffs (fallback when NSEvent keys never arrive). */
  private lastValueLen: { contextKey: string; length: number } | null = null
  /** When key events are flowing, ignore valueTail to avoid double-counting. */
  private lastKeyEventAt = 0

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

  start(onEvent: (partial: InteractionPartial) => void): void {
    if (this.disabled || process.platform !== 'darwin') {
      this.enabled = false
      return
    }
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

    try {
      this.child = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_SENSOR_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      console.error('[telemetry/ax] spawn failed', err instanceof Error ? err.name : 'error')
      this.disable()
      return
    }

    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))

    this.child.stderr.on('data', (chunk: Buffer) => {
      // The sensor speaks on stdout; anything here is a real failure. Log only the
      // first line and never the payload, which could contain AX contents.
      const first = String(chunk).split('\n')[0]?.trim()
      if (first) console.error('[telemetry/ax] sensor stderr:', first.slice(0, 200))
    })

    this.child.on('error', (err) => {
      console.error('[telemetry/ax] process error', err.name)
      this.disable()
    })

    this.child.on('exit', (code) => {
      if (!this.disabled && code !== 0 && code !== null) {
        console.error('[telemetry/ax] exited', code)
        this.disable()
      }
      this.child = null
      this.rl = null
    })
  }

  stop(): void {
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
    if (this.child) {
      try {
        this.child.stdin.end()
      } catch {
        /* ignore */
      }
      try {
        this.child.kill('SIGTERM')
      } catch {
        /* ignore */
      }
      this.child = null
    }
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
        this.handleKey(parsed as unknown as JxaKeyEvent)
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
          app?: string | null
          appBundleId?: string | null
          role?: string | null
          label?: string | null
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
    const valueLength =
      typeof sample.valueLength === 'number' && sample.valueLength >= 0
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
    this.context = {
      appName,
      appBundleId,
      documentTitle,
      elementRole,
      elementLabel,
      secure: sample.secure === true || elementRole === 'AXSecureTextField'
    }

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
          fieldType: elementRole && TEXT_ROLES.has(elementRole) ? 'text' : undefined
        },
        data: {
          ...baseData,
          field:
            elementRole && TEXT_ROLES.has(elementRole)
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
        at: Date.now()
      }
    } else if (this.pendingActivation) {
      const age = Date.now() - this.pendingActivation.at
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
          at: Date.now(),
          grew: false
        }
      } else if (valueLength > prev.length) {
        this.lastField = {
          ...prev,
          length: valueLength,
          at: Date.now(),
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
          at: Date.now(),
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
    if (this.lastKeyEventAt && Date.now() - this.lastKeyEventAt < 1500) return
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
    buffer.chars.push(appended)
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
      startedAt: Date.now()
    }
    return this.typing
  }

  /** Exposed for tests — handle one observed key press. */
  handleKey(event: JxaKeyEvent): void {
    if (!this.onEvent) return
    this.lastKeyEventAt = Date.now()

    const secure = event.secure === true || this.context.secure
    const isChord = event.cmd === true || event.ctrl === true
    const code = typeof event.code === 'number' ? event.code : -1

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
      // Never buffer characters typed into a password field.
      if (this.typing) {
        this.typing.redacted = true
        this.flushTyping()
      }
      return
    }

    if (code === KEY_RETURN || code === KEY_KEYPAD_ENTER) {
      this.countKey(event)
      this.flushTyping('Return')
      return
    }
    if (code === KEY_TAB) {
      this.countKey(event)
      this.flushTyping('Tab')
      return
    }
    if (code === KEY_ESCAPE) {
      this.countKey(event)
      this.flushTyping('Escape')
      return
    }
    if (code === KEY_BACKSPACE) {
      const buffer = this.ensureTyping(event)
      buffer.keyCount += 1
      buffer.chars.pop()
      this.armTypingTimer()
      return
    }
    if (code === KEY_FORWARD_DELETE || NAVIGATION_KEYS.has(code)) {
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
    buffer.chars.push(printable)
    this.armTypingTimer()
  }

  handleScroll(event: {
    axis?: 'vertical' | 'horizontal'
    delta?: number
    app?: string | null
    appBundleId?: string | null
    role?: string | null
    label?: string | null
    containerRole?: string | null
    containerLabel?: string | null
  }): void {
    if (!this.onEvent) return
    const appName = sanitizeLabel(event.app ?? undefined) ?? this.context.appName
    const appBundleId = sanitizeLabel(event.appBundleId ?? undefined) ?? this.context.appBundleId
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
        elementLabel: sanitizeLabel(event.label ?? undefined)
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
        tier: role || label ? 'ax' : clickX != null ? 'coords' : 'none',
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
        targetTier: role || label ? 'ax' : clickX != null ? 'coords' : 'none',
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
        elementNorm,
        elementBounds: bounds
      }
    })
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
      startedAt: Date.now()
    }
    return this.typing
  }

  private armTypingTimer(): void {
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

    const { text, redacted } = sanitizeTypedText(buffer.chars.join(''))
    if (!text && !submitKey) return

    const role = buffer.elementRole
    this.onEvent({
      type: 'text_input',
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
        keyCount: buffer.keyCount,
        submitKey
      }
    })
  }

  private disable(): void {
    this.disabled = true
    this.enabled = false
    this.stop()
  }
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
