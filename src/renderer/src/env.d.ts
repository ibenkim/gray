/// <reference types="vite/client" />

import type {
  DeepLink,
  InvitePreview,
  JoinResult,
  OnboardingStep,
  PermissionId,
  PermissionsState,
  PillPosition,
  RecordSettings,
  Run,
  Session,
  StoreSnapshot,
  Suggestion,
  Team,
  Workflow,
  WorkspaceFocus
} from '../../shared/types'

type ActivityHoldPayload = {
  runId: string
  workflowId: string
  name: string
  needsYou: 'answer' | 'help'
  heldStepIndex: number
  waitingSince: string
  stopReason?: string
}

declare global {
  interface Window {
    ghostBridge: {
      setBounds: (
        w: number,
        h: number,
        mode: 'pill' | 'glass' | 'panel',
        opts?: { durationMs?: number; pillDrive?: boolean; center?: boolean }
      ) => Promise<'above' | 'below'>
      openWorkspace: (focus?: string | WorkspaceFocus) => Promise<void>
      closeWindow: () => Promise<void>
      minimizeWindow: () => Promise<void>
      showContextMenu: () => Promise<void>
      setPillAppState: (state: string) => Promise<void>
      setEditorScrim: (visible: boolean) => Promise<void>
      dragStart: (
        x: number,
        y: number,
        opts?: { collapseToPill?: boolean }
      ) => Promise<void>
      dragEnd: () => Promise<void>
      runWorkflow: (workflowId: string) => Promise<boolean>
      openRecordPanel: () => Promise<void>
      openEditor: () => Promise<void>
      revealRunning: () => Promise<void>
      onRunWorkflow: (cb: (workflowId: string) => void) => () => void
      onOpenRecordPanel: (cb: () => void) => () => void
      onOpenEditor: (cb: () => void) => () => void
      onRevealRunning: (cb: () => void) => () => void
      onFocusWorkflow: (cb: (workflowId: string) => void) => () => void
      onFocusWorkspace: (cb: (focus: WorkspaceFocus) => void) => () => void
      getSnapshot: () => Promise<StoreSnapshot>
      getWorkflow: (id: string) => Promise<Workflow | null>
      getRun: (id: string) => Promise<Run | null>
      upsertWorkflow: (workflow: Workflow) => Promise<StoreSnapshot>
      deleteWorkflow: (id: string) => Promise<StoreSnapshot>
      saveRun: (run: Run) => Promise<StoreSnapshot>
      upsertActivityHold: (payload: ActivityHoldPayload) => Promise<StoreSnapshot>
      clearActivityHold: (runId: string) => Promise<StoreSnapshot>
      setSuggestion: (suggestion: Suggestion | null) => Promise<StoreSnapshot>
      discardSuggestion: (id: string) => Promise<StoreSnapshot>
      setRecordSettings: (settings: RecordSettings) => Promise<StoreSnapshot>
      setPillPosition: (position: PillPosition | null) => Promise<StoreSnapshot>
      setOnboardingComplete: (complete: boolean) => Promise<StoreSnapshot>
      setOnboardingStep: (step: OnboardingStep) => Promise<StoreSnapshot>
      setSession: (session: Session) => Promise<StoreSnapshot>
      setTeam: (team: Team) => Promise<StoreSnapshot>
      setMicSkipped: (skipped: boolean) => Promise<StoreSnapshot>
      setPermissionToastDismissedAt: (iso: string | null) => Promise<StoreSnapshot>
      skipActivity: (entryId: string) => Promise<StoreSnapshot>
      onStoreChanged: (cb: (snapshot: StoreSnapshot) => void) => () => void
      completeOnboarding: (opts?: { openRecordPanel?: boolean }) => Promise<void>
      setOnboardingSize: (w: number, h: number) => Promise<void>
      openExternalUrl: (url: string) => Promise<void>
      onDeepLink: (cb: (link: DeepLink) => void) => () => void
      authGoogle: () => Promise<Session>
      authSendMagicLink: (email: string) => Promise<{ ok: boolean }>
      logout: () => Promise<void>
      teamCreate: () => Promise<Team>
      teamJoin: (code: string) => Promise<JoinResult>
      teamPreview: (code: string) => Promise<InvitePreview>
      teamRename: (name: string) => Promise<Team>
      teamInvite: (email: string) => Promise<{ team: Team; error?: string }>
      teamResendInvite: (inviteId: string) => Promise<Team>
      teamRevokeInvite: (inviteId: string) => Promise<Team>
      teamRemoveMember: (memberId: string) => Promise<Team>
      getPermissions: () => Promise<PermissionsState>
      requestPermission: (id: PermissionId) => Promise<PermissionsState>
      openPermissionSettings: (id: PermissionId) => Promise<void>
      restartApp: () => Promise<void>
      onPermissionsChanged: (cb: (state: PermissionsState) => void) => () => void
    }
  }
}

export {}
