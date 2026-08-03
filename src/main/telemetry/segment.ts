import {
  type ActivitySegment,
  type ActivitySegmentKind,
  type PolishedAction,
  type ScreenStateRef
} from '../../shared/telemetry/schema'

const IDLE_SPLIT_MS = 8_000
const BURST_GAP_MS = 2_500

/**
 * Deterministic activity segmentation for hierarchical model packing.
 * Splits on app/window changes, target changes, input bursts, idle gaps,
 * and screen-state transitions. Does not invent user intent.
 */
export function segmentActions(actions: PolishedAction[]): {
  segments: ActivitySegment[]
  screens: ScreenStateRef[]
} {
  const content = actions.filter((a) => a.category !== 'session')
  if (content.length === 0) {
    return { segments: [], screens: collectScreens(actions) }
  }

  const groups: PolishedAction[][] = []
  let current: PolishedAction[] = []

  const flush = () => {
    if (current.length) {
      groups.push(current)
      current = []
    }
  }

  for (const action of content) {
    const prev = current[current.length - 1]
    if (!prev) {
      current.push(action)
      continue
    }

    if (shouldSplit(prev, action)) {
      flush()
    }
    current.push(action)
  }
  flush()

  const segments: ActivitySegment[] = groups.map((group, index) => {
    const startMs = Date.parse(group[0].timestamp) || 0
    const endMs = Date.parse(group[group.length - 1].timestamp) || startMs
    return {
      id: `seg_${index + 1}`,
      index,
      kind: inferSegmentKind(group),
      appName: dominant(group.map((a) => a.appName)),
      documentTitle: dominant(group.map((a) => a.documentTitle)),
      startMs,
      endMs: Math.max(endMs, startMs),
      actionOrders: group.map((a) => a.order)
    }
  })

  return { segments, screens: collectScreens(actions) }
}

function shouldSplit(prev: PolishedAction, next: PolishedAction): boolean {
  if (next.waitedMs != null && next.waitedMs >= IDLE_SPLIT_MS) return true
  if (next.category === 'idle') return true

  const prevApp = (prev.appName ?? '').toLowerCase()
  const nextApp = (next.appName ?? '').toLowerCase()
  if (prevApp && nextApp && prevApp !== nextApp) return true

  const prevDoc = (prev.documentTitle ?? '').toLowerCase()
  const nextDoc = (next.documentTitle ?? '').toLowerCase()
  if (prevDoc && nextDoc && prevDoc !== nextDoc && prevApp === nextApp) {
    // Document change within same app is a segment boundary for navigation-heavy flows.
    if (next.category === 'navigation' || prev.category === 'navigation') return true
  }

  if (
    prev.screenAfterId &&
    next.screenBeforeId &&
    prev.screenAfterId !== next.screenBeforeId &&
    (next.category === 'navigation' || prev.category === 'navigation')
  ) {
    return true
  }

  const prevTarget = targetKey(prev)
  const nextTarget = targetKey(next)
  if (
    prevTarget &&
    nextTarget &&
    prevTarget !== nextTarget &&
    isInputLike(prev) !== isInputLike(next) &&
    gapMs(prev, next) > BURST_GAP_MS
  ) {
    return true
  }

  // Clipboard copy in one app followed by paste/submit elsewhere already split on app.
  if (prev.category === 'clipboard' && next.category !== 'clipboard' && gapMs(prev, next) > BURST_GAP_MS) {
    return true
  }

  return false
}

function inferSegmentKind(group: PolishedAction[]): ActivitySegmentKind {
  if (group.every((a) => a.category === 'idle' || a.waitedMs)) return 'waiting'
  if (group.some((a) => a.category === 'clipboard' || a.semanticOp === 'copy' || a.semanticOp === 'paste')) {
    return 'data_transfer'
  }
  if (group.every((a) => a.category === 'navigation')) return 'navigation'
  if (group.some((a) => a.category === 'navigation') && group.every((a) => a.category === 'navigation' || a.category === 'idle')) {
    return 'navigation'
  }
  if (
    group.every(
      (a) =>
        a.category === 'interaction' ||
        a.category === 'idle' ||
        (a.category === 'shortcut' && !a.semanticOp)
    ) &&
    !group.some((a) => a.category === 'input' || a.category === 'submission')
  ) {
    return 'review'
  }
  return 'interaction'
}

function collectScreens(actions: PolishedAction[]): ScreenStateRef[] {
  const byId = new Map<string, ScreenStateRef>()
  for (const a of actions) {
    for (const id of [a.screenBeforeId, a.screenAfterId]) {
      if (!id || byId.has(id)) continue
      const delta = a.screenAfterId === id ? a.screenAfter : undefined
      byId.set(id, {
        id,
        appName: delta?.appName ?? a.appName,
        documentTitle: delta?.documentTitle ?? a.documentTitle,
        urlHost: delta?.urlHost
      })
    }
  }
  return [...byId.values()]
}

function targetKey(a: PolishedAction): string | null {
  const parts = [a.elementRole, a.elementLabel, a.appName].filter(Boolean)
  return parts.length ? parts.join('|') : null
}

function isInputLike(a: PolishedAction): boolean {
  return (
    a.category === 'input' ||
    a.category === 'submission' ||
    a.semanticOp === 'paste' ||
    !!a.typedText
  )
}

function gapMs(prev: PolishedAction, next: PolishedAction): number {
  if (next.waitedMs != null) return next.waitedMs
  const a = Date.parse(prev.timestamp)
  const b = Date.parse(next.timestamp)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.max(0, b - a)
}

function dominant(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>()
  for (const v of values) {
    if (!v) continue
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}

/**
 * Classify typed / field values into a ValueCategory-compatible input kind
 * without storing raw sensitive content.
 */
export function classifyInputKind(
  typedText: string | undefined,
  opts: { fieldLabel?: string; fieldType?: string; elementRole?: string } = {}
): import('../../shared/telemetry/schema').ValueCategory | undefined {
  if (!typedText && !opts.fieldLabel && !opts.fieldType) return undefined
  const label = `${opts.fieldLabel ?? ''} ${opts.elementRole ?? ''}`.toLowerCase()
  if (/password|passwd|secret|token|secure/.test(label) || opts.fieldType === 'password') {
    return 'sensitive'
  }
  if (/email|e-mail/.test(label) || opts.fieldType === 'email') return 'email'
  if (/phone|tel|mobile/.test(label) || opts.fieldType === 'tel' || opts.fieldType === 'phone') {
    return 'phone'
  }
  if (/date|when|deadline/.test(label) || opts.fieldType === 'date') return 'date'
  if (/url|link|href/.test(label) || opts.fieldType === 'url') return 'url'
  if (/search|query|find|omnibox|address/.test(label) || opts.elementRole === 'AXSearchField') {
    return 'text'
  }
  if (!typedText) return 'unknown'
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typedText)) return 'email'
  if (/^https?:\/\//i.test(typedText)) return 'url'
  if (
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(typedText) ||
    /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(typedText)
  ) {
    return 'date'
  }
  // Phone after date so ISO dates are not misclassified.
  if (/^\+?[\d\s().-]{7,}$/.test(typedText) && /\d{3,}/.test(typedText)) return 'phone'
  if (/^\d+(\.\d+)?$/.test(typedText.trim())) return 'number'
  if (/^\[(email|token|number)\]$/.test(typedText.trim())) return 'redacted'
  return 'text'
}

/** Map shortcut chords to semantic operations. */
export function semanticOpFromShortcut(shortcut: string | undefined): import('../../shared/telemetry/schema').SemanticOp | undefined {
  if (!shortcut) return undefined
  const s = shortcut.toLowerCase().replace(/\s+/g, '')
  if (/(cmd|ctrl|meta)\+c$/.test(s)) return 'copy'
  if (/(cmd|ctrl|meta)\+v$/.test(s)) return 'paste'
  if (/(cmd|ctrl|meta)\+x$/.test(s)) return 'cut'
  if (/(cmd|ctrl|meta)\+s$/.test(s)) return 'save'
  if (/(cmd|ctrl|meta)\+z$/.test(s)) return 'undo'
  if (/(cmd|ctrl|meta)\+shift\+z$/.test(s) || /(cmd|ctrl|meta)\+y$/.test(s)) return 'redo'
  if (/(cmd|ctrl|meta)\+a$/.test(s)) return 'select_all'
  if (/^(enter|return)$/.test(s)) return 'submit'
  return 'other'
}
