/** Shared domain types — single source for main + both renderers. */

export type WorkflowStatus = 'on' | 'off'

/** Local wall-clock time on this Mac. */
export type TimeOfDay = {
  hour: number
  minute: number
}

/** 0 = Sunday … 6 = Saturday (JS `Date.getDay()`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * Structured schedule cadence. Display strings and "next run" are derived
 * via `formatSchedule` / `nextRun` — never stored as free text.
 */
export type ScheduleCadence =
  | { kind: 'daily'; time: TimeOfDay }
  | { kind: 'weekly'; days: Weekday[]; time: TimeOfDay }
  | { kind: 'monthly'; day: number; time: TimeOfDay }
  | { kind: 'custom'; label: string; time: TimeOfDay; intervalDays: number }

export type Trigger = {
  /** Undefined = manual-only (Run still works). */
  cadence?: ScheduleCadence
}

/** An app referenced by a step, rendered as an inline chip (icon + name). */
export type StepApp = {
  id: 'figma' | 'chrome' | 'slack' | 'finder' | 'mail'
  name: string
}

/** A voice note captured alongside a step while narrating. */
export type VoiceNote = {
  text: string
}

export type FixOption = {
  id: string
  label: string
  kind: 'default' | 'suggested' | 'other'
}

/**
 * A clarifying question the AI asks about a step.
 * Selections are never terminal: a resolved card collapses into a chip-token
 * that re-expands on click.
 */
export type FixStep = {
  prompt: string
  options: FixOption[]
  selectedOptionId: string
  customValue?: string
  /** True once a chip has been picked — renders as chip-token + chevron. */
  collapsed: boolean
}

/** Transient lifecycle of an editor step after an edit commits. */
export type StepPhase = 'normal' | 'forming' | 'resolved'

export type EditorStep = {
  id: string
  index: number
  title: string
  app?: StepApp
  voiceNote?: VoiceNote
  fix?: FixStep
  phase?: StepPhase
}

/** Personal = owner's Workflows list; team = also listed on Shared. */
export type WorkflowScope = 'personal' | 'team'

/**
 * Unified workflow entity — Library row, editor draft, and run target.
 * Pill drafts get an `id` at organize-time; Save upserts into the store.
 */
export type Workflow = {
  id: string
  name: string
  /** Editor meta line, e.g. "6 steps · 1:24". */
  metaLabel: string
  trigger: Trigger
  steps: EditorStep[]
  status: WorkflowStatus
  /** Lifetime completed-run count shown in the Library. */
  runCount: number
  hoursReturned: string
  /**
   * Share scope. Defaults to `personal`. When `team`, the workflow stays in
   * the sharer's Workflows list and also appears on Shared.
   */
  scope?: WorkflowScope
  /** Member id of who shared to the team (when `scope` is `team`). */
  sharedBy?: string
  /** Display name for the Shared page "shared by …" chip. */
  sharedByName?: string
  /**
   * Telemetry session that produced this workflow. Links to the compiled
   * automation script under development-data/telemetry/automation/.
   */
  sessionId?: string
  /** True when editor steps changed after the last successful compile. */
  automationStale?: boolean
}

// ── Running (ephemeral ledger in the pill) ──

export type RunStepStatus =
  | 'pending'
  | 'active'
  | 'question'
  | 'error'
  | 'skipped'
  | 'done'

export type RunQuestion = {
  prompt: string
  options: FixOption[]
  answerId: string | null
  customValue?: string
}

/** Ephemeral mid-run failure (6.4) — mocked until real step execution lands. */
export type RunError = {
  message: string
  /** True after the user picks "Take over" — resume continues from the next step. */
  takenOver?: boolean
}

export type RunStep = {
  id: string
  index: number
  /** Present/imperative wording, e.g. "Paste them into Crit page". */
  label: string
  /** Past-tense wording once done, e.g. "Pasted them into Crit page". */
  doneLabel: string
  app?: StepApp
  voiceNote?: VoiceNote
  /** Present when this is an "Ask each time" step: the run holds here. */
  question?: RunQuestion
  /** Present when this step failed and is holding for help. */
  error?: RunError
  /**
   * Mock failure trigger (Phase 2) — first completion attempt becomes an
   * error hold; Retry clears this so the re-attempt succeeds.
   */
  mockFailOnce?: boolean
  status: RunStepStatus
}

export type SummaryOutcome = 'stopped' | 'done'

// ── Persisted run record ──

export type RunOutcome = 'done' | 'stopped' | 'paused'

export type QuestionReceipt = {
  stepId: string
  prompt: string
  answerId: string
  answerLabel: string
  customValue?: string
  answeredAt: string
}

export type RunStepResult = {
  stepId: string
  index: number
  label: string
  doneLabel: string
  status: 'done' | 'skipped' | 'held' | 'pending' | 'active'
  startedAt?: string
  endedAt?: string
  app?: StepApp
  voiceNote?: VoiceNote
}

/**
 * Persisted run — written when a pill run reaches summary (done or stopped).
 * Ephemeral ledger state still comes from `makeRunSteps` during the run.
 */
export type Run = {
  id: string
  workflowId: string
  startedAt: string
  endedAt?: string
  outcome: RunOutcome
  steps: RunStepResult[]
  questions: QuestionReceipt[]
  artifactLinks?: { label: string; url: string }[]
  /** Minutes returned; omitted for stopped runs. */
  returnedMinutes?: number
  /** Set when a 10-min error hold auto-stops the run. */
  stopReason?: string
}

// ── Workspace supporting entities ──

export type Suggestion = {
  id: string
  title: string
  /** Display string for the proposed schedule (seed/copy). */
  schedule: string
  /** Plain-language description segments; app chip is rendered inline. */
  descriptionBefore: string
  app: StepApp
  descriptionAfter: string
  noticedLine: string
}

export type ActivityEntry = {
  id: string
  workflowId: string
  name: string
  timeLabel: string
  group: 'coming-up' | 'today' | 'yesterday'
  kind: 'scheduled' | 'run'
  /** For runs — deep-links Log / run detail. */
  runId?: string
  /** ISO fire time for a scheduled occurrence (skip identity). */
  occurrenceAt?: string
  /** For runs. */
  outcome?: 'done' | 'paused' | 'stopped'
  /** Coming-up occurrences the user skipped (grayed, one-time). */
  skipped?: boolean
  /**
   * Mid-run hold mirrored from the pill (Phase 2 writes; Phase 3 renders 2.5).
   * `answer` = amber question hold; `help` = rose error hold.
   */
  needsYou?: 'answer' | 'help'
  heldStepIndex?: number
  /** ISO timestamp when the hold began. */
  waitingSince?: string
  /** Set when a 10-min error hold auto-stops the run. */
  stopReason?: string
}

/** Deep-link payload for opening the workspace on a workflow / run. */
export type WorkspaceFocus = {
  workflowId?: string
  runId?: string
}

export type RecordMode = 'one-app' | 'full-screen'

export type RecordSettings = {
  recordMode: RecordMode
  narrate: boolean
  selectedAppId: string
}

export type PillPosition = {
  x: number
  y: number
}

/** Mocked session shape — real auth lands behind the Phase 4 stub. */
export type Session = {
  email: string
  displayName: string
  /** Mirrors the active team's role once the user has a team. */
  role?: TeamRole
} | null

/** Which onboarding card the app resumes to on relaunch (hard gate). */
export type OnboardingStep = 'welcome' | 'team' | 'permissions' | 'complete'

export type TeamRole = 'owner' | 'member'

/** A person on the team roster (Manage · MEMBERS). */
export type Member = {
  id: string
  name: string
  email?: string
  role: TeamRole
  /** Signed-in user — no remove ✕ on their own row. */
  isSelf?: boolean
}

/** Pending email invite (Manage · INVITED). Expires 14 days after `invitedAt`. */
export type Invite = {
  id: string
  email: string
  invitedAt: string
  code: string
}

/**
 * Team created/joined during onboarding. Phase 5 adds members / invites;
 * `memberCount` mirrors `members.length` for header metrics.
 */
export type Team = {
  id: string
  name: string
  memberCount: number
  role: TeamRole
  members: Member[]
  invites: Invite[]
} | null

/**
 * macOS privacy permissions. Only `screen` is required for recording today.
 * `accessibility` and `microphone` stay in the type so helpers can return them
 * when InteractionProvider / narration ship later.
 */
export type PermissionId = 'screen' | 'accessibility' | 'microphone'

export type PermissionStatus = 'granted' | 'denied' | 'unknown'

export type PermissionsState = {
  screen: PermissionStatus
  accessibility: PermissionStatus
  microphone: PermissionStatus
}

/** Custom-scheme payloads routed from main into the onboarding window. */
export type DeepLink =
  | { kind: 'magic'; email: string; token: string }
  | { kind: 'google' }
  | { kind: 'invite'; code: string }

export type JoinResult = { ok: boolean; team?: Team; error?: string }
export type InvitePreview = { ok: boolean; team?: Team }

export type StoreSnapshot = {
  version: 1
  workflows: Workflow[]
  runs: Run[]
  activity: ActivityEntry[]
  suggestion: Suggestion | null
  discardedSuggestionIds: string[]
  recordSettings: RecordSettings
  pillPosition: PillPosition | null
  onboardingComplete: boolean
  /** Persisted step progress so relaunch mid-setup returns to the same card. */
  onboardingStep: OnboardingStep
  session: Session
  team: Team
  /** True once the user chose "Skip for now" on the mic permission. */
  micSkipped: boolean
  /** Last time the revoked-permission toast was dismissed (shown once/revoke). */
  permissionToastDismissedAt: string | null
  /** Last time a previously-granted permission was observed to flip off. */
  lastPermissionRevokeAt: string | null
}
