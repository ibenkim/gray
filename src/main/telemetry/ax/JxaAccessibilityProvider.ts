import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface, type Interface as ReadlineInterface } from 'readline'
import {
  sanitizeLabel,
  sanitizeWindowTitle
} from '../../../shared/telemetry/sanitize'
import type { InteractionPartial, InteractionProvider } from '../providers'
import { JXA_AX_SCRIPT } from './jxaScript'

export type JxaSample = {
  appName?: string
  appBundleId?: string
  windowTitle?: string
  documentTitle?: string
  elementRole?: string
  elementSubrole?: string
  elementLabel?: string
  valueLength?: number | null
  elementPath?: string[]
  selectedLabels?: string[]
  error?: string
}

const TEXT_ROLES = new Set([
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXSearchField'
])

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

/**
 * macOS Accessibility via a long-lived `osascript -l JavaScript` child.
 * Polls ~every 400ms; poke() forces an immediate sample after app/clipboard changes.
 * Replaceable later with NativeAxObserverProvider behind the same interface.
 */
export class JxaAccessibilityProvider implements InteractionProvider {
  enabled = true
  private child: ChildProcessWithoutNullStreams | null = null
  private rl: ReadlineInterface | null = null
  private onEvent: ((partial: InteractionPartial) => void) | null = null
  private disabled = false
  private lastFocusKey: string | null = null
  private lastSelectionKey: string | null = null
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

  start(onEvent: (partial: InteractionPartial) => void): void {
    if (this.disabled || process.platform !== 'darwin') {
      this.enabled = false
      return
    }
    this.onEvent = onEvent
    this.lastFocusKey = null
    this.lastSelectionKey = null
    this.lastField = null
    this.pendingActivation = null

    try {
      this.child = spawn('osascript', ['-l', 'JavaScript', '-e', JXA_AX_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (err) {
      console.error('[telemetry/ax] spawn failed', err instanceof Error ? err.name : 'error')
      this.disable()
      return
    }

    this.rl = createInterface({ input: this.child.stdout })
    this.rl.on('line', (line) => this.handleLine(line))

    this.child.stderr.on('data', () => {
      /* swallow — never log AX contents */
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
    if (this.fieldSettleTimer) {
      clearTimeout(this.fieldSettleTimer)
      this.fieldSettleTimer = null
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

  poke(): void {
    if (!this.child || this.disabled) return
    try {
      this.child.stdin.write('\n')
    } catch {
      /* ignore */
    }
  }

  /** Exposed for tests — parse a stdout JSON line into InteractionPartials. */
  handleLine(line: string): void {
    if (!this.onEvent || this.disabled) return
    const trimmed = line.trim()
    if (!trimmed) return
    let sample: JxaSample
    try {
      sample = JSON.parse(trimmed) as JxaSample
    } catch {
      return
    }
    if (sample.error) {
      console.error('[telemetry/ax] sample error')
      this.disable()
      return
    }
    this.emitFromSample(sample)
  }

  /** Unit-test helper: process a sample without spawning. */
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
      selectedLabels: selectedLabels.length ? selectedLabels : undefined
    }

    const focusKey = [
      appName,
      documentTitle,
      elementRole,
      elementLabel,
      valueLength ?? ''
    ].join('|')
    if (focusKey !== this.lastFocusKey) {
      this.lastFocusKey = focusKey
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

    // Track activatable focus for inferred activation.
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
        // Screen/field changed shortly after focusing a button → inferred activation.
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

  private disable(): void {
    this.disabled = true
    this.enabled = false
    this.stop()
  }
}
