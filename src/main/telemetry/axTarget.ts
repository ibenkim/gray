import type { TargetResolution, TargetTier } from '../../shared/telemetry/schema'

/** Roles that can be pressed / filled via Accessibility when a label exists. */
export const ACTIONABLE_AX_ROLES = new Set([
  'AXButton',
  'AXMenuItem',
  'AXMenuButton',
  'AXCheckBox',
  'AXRadioButton',
  'AXPopUpButton',
  'AXLink',
  'AXTextField',
  'AXTextArea',
  'AXComboBox',
  'AXSearchField',
  'AXSecureTextField',
  'AXSlider',
  'AXIncrementor',
  'AXDisclosureTriangle',
  'AXTab',
  'AXToolbarButton'
])

/** Container / layout roles that are never meaningful click targets by themselves. */
export const WEAK_AX_ROLES = new Set([
  'AXGroup',
  'AXUnknown',
  'AXWindow',
  'AXScrollArea',
  'AXSplitGroup',
  'AXWebArea',
  'AXImage',
  'AXStaticText',
  'AXLayoutArea',
  'AXLayoutItem',
  'AXList',
  'AXOutline',
  'AXTable',
  'AXRow',
  'AXColumn',
  'AXCell',
  'AXBrowser',
  'AXScrollBar',
  'AXSplitter',
  'AXToolbar',
  'AXRadioGroup',
  'AXTabGroup',
  'AXPage'
])

/**
 * True when role + label are enough to drive AXPress / field fill at replay.
 * Unlabeled containers (AXGroup, window, canvas) are never actionable.
 */
export function isActionableAxTarget(
  role: string | null | undefined,
  label: string | null | undefined
): boolean {
  const r = role?.trim()
  if (!r || WEAK_AX_ROLES.has(r)) return false
  if (!ACTIONABLE_AX_ROLES.has(r)) return false
  const lab = label?.trim()
  return !!lab
}

export type ResolveTargetTierOpts = {
  role?: string | null
  label?: string | null
  clickX?: number | null
  clickY?: number | null
}

/**
 * Prefer actionable AX; otherwise fall back to recorded screen coordinates.
 * Generic roles alone never count as `ax`.
 */
export function resolveTargetTier(opts: ResolveTargetTierOpts): TargetTier {
  if (isActionableAxTarget(opts.role, opts.label)) return 'ax'
  if (opts.clickX != null && opts.clickY != null) return 'coords'
  return 'none'
}

/** Same ladder as resolveTargetTier, restricted to polished TargetResolution. */
export function resolveTargetResolution(opts: ResolveTargetTierOpts): TargetResolution {
  const tier = resolveTargetTier(opts)
  return tier === 'visual' ? 'none' : tier
}
