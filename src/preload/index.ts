import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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
} from '../shared/types'
import type { ExtractedWorkflow, TelemetryEvent } from '../shared/telemetry/schema'

type TelemetryRecordingStatus = {
  recording: boolean
  sessionId: string | null
  sequence: number
  startedAt: string | null
  processing: boolean
}

type TelemetryStartOpts = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  ownerEmail?: string
}

type ActivityHoldPayload = {
  runId: string
  workflowId: string
  name: string
  needsYou: 'answer' | 'help'
  heldStepIndex: number
  waitingSince: string
  stopReason?: string
}

export type AutomationRunEvent =
  | {
      type: 'stepStarted'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      op: string
    }
  | {
      type: 'stepDone'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
    }
  | {
      type: 'stepFailed'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      message: string
      manual?: boolean
    }
  | {
      type: 'question'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      prompt: string
      variableKey: string | null
    }
  | {
      type: 'finished'
      runId: string
      outcome: 'done' | 'stopped'
    }

const ghostBridge = {
  /** Resize the pill window; returns the panel placement ('above' | 'below'). */
  setBounds: (
    w: number,
    h: number,
    mode: 'pill' | 'glass' | 'panel',
    opts?: { durationMs?: number; pillDrive?: boolean; center?: boolean }
  ) =>
    ipcRenderer.invoke('window:setBounds', {
      w,
      h,
      mode,
      durationMs: opts?.durationMs,
      pillDrive: opts?.pillDrive,
      center: opts?.center
    }),
  /** Open (or focus) the workspace window; optional deep-link to a workflow / run. */
  openWorkspace: (focus?: string | WorkspaceFocus) =>
    ipcRenderer.invoke('workspace:open', focus),
  /** Close the calling window. */
  closeWindow: () => ipcRenderer.invoke('window:close'),
  /** Minimize the calling window. */
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  /** Show the native right-click context menu for the pill. */
  showContextMenu: () => ipcRenderer.invoke('pill:contextMenu'),
  /** Keep main's context-menu variant in sync with AppState. */
  setPillAppState: (state: string) => ipcRenderer.invoke('pill:setAppState', state),
  /** Ink-20 fullscreen dim behind the expanded editor. */
  setEditorScrim: (visible: boolean) => ipcRenderer.invoke('editor:setScrim', visible),
  /** Begin dragging; collapseToPill=false keeps the glass panel open while dragging. */
  dragStart: (x: number, y: number, opts?: { collapseToPill?: boolean }) =>
    ipcRenderer.invoke('pill:dragStart', { x, y, collapseToPill: opts?.collapseToPill }),
  dragEnd: () => ipcRenderer.invoke('pill:dragEnd'),
  /** Workspace → pill: run a workflow now (looked up by id in the shared store). */
  runWorkflow: (workflowId: string) => ipcRenderer.invoke('pill:runWorkflow', workflowId),
  /** Workspace → pill: open the record panel. */
  openRecordPanel: () => ipcRenderer.invoke('pill:openRecordPanel'),
  /** Workspace → pill: open the editor pre-filled (Suggested "Set it up for me"). */
  openEditor: () => ipcRenderer.invoke('pill:openEditor'),
  /** Activity Answer / paused hold — show pill + expand running panel. */
  revealRunning: () => ipcRenderer.invoke('pill:revealRunning'),
  /** Pill-side subscriptions for commands sent from the workspace / hotkey. */
  onRunWorkflow: (cb: (workflowId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('pill:runWorkflow', listener)
    return () => ipcRenderer.removeListener('pill:runWorkflow', listener)
  },
  onOpenRecordPanel: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pill:openRecordPanel', listener)
    return () => ipcRenderer.removeListener('pill:openRecordPanel', listener)
  },
  onOpenEditor: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pill:openEditor', listener)
    return () => ipcRenderer.removeListener('pill:openEditor', listener)
  },
  onRevealRunning: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('pill:revealRunning', listener)
    return () => ipcRenderer.removeListener('pill:revealRunning', listener)
  },
  /** Workspace: deep-link to a workflow detail (legacy). */
  onFocusWorkflow: (cb: (workflowId: string) => void) => {
    const listener = (_e: unknown, id: string) => cb(id)
    ipcRenderer.on('workspace:focusWorkflow', listener)
    return () => ipcRenderer.removeListener('workspace:focusWorkflow', listener)
  },
  /** Workspace: deep-link to workflow and/or run detail. */
  onFocusWorkspace: (cb: (focus: WorkspaceFocus) => void) => {
    const listener = (_e: unknown, focus: WorkspaceFocus) => cb(focus)
    ipcRenderer.on('workspace:focus', listener)
    return () => ipcRenderer.removeListener('workspace:focus', listener)
  },

  // ── Shared data store ──
  getSnapshot: (): Promise<StoreSnapshot> => ipcRenderer.invoke('store:getSnapshot'),
  getWorkflow: (id: string): Promise<Workflow | null> =>
    ipcRenderer.invoke('store:getWorkflow', id),
  getRun: (id: string): Promise<Run | null> => ipcRenderer.invoke('store:getRun', id),
  upsertWorkflow: (workflow: Workflow): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:upsertWorkflow', workflow),
  deleteWorkflow: (id: string): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:deleteWorkflow', id),
  saveRun: (run: Run): Promise<StoreSnapshot> => ipcRenderer.invoke('store:saveRun', run),
  upsertActivityHold: (payload: ActivityHoldPayload): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:upsertActivityHold', payload),
  clearActivityHold: (runId: string): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:clearActivityHold', runId),
  setSuggestion: (suggestion: Suggestion | null): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setSuggestion', suggestion),
  discardSuggestion: (id: string): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:discardSuggestion', id),
  setRecordSettings: (settings: RecordSettings): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setRecordSettings', settings),
  setPillPosition: (position: PillPosition | null): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setPillPosition', position),
  setOnboardingComplete: (complete: boolean): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setOnboardingComplete', complete),
  setOnboardingStep: (step: OnboardingStep): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setOnboardingStep', step),
  setSession: (session: Session): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setSession', session),
  setTeam: (team: Team): Promise<StoreSnapshot> => ipcRenderer.invoke('store:setTeam', team),
  setMicSkipped: (skipped: boolean): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setMicSkipped', skipped),
  setPermissionToastDismissedAt: (iso: string | null): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:setPermissionToastDismissedAt', iso),
  skipActivity: (entryId: string): Promise<StoreSnapshot> =>
    ipcRenderer.invoke('store:skipActivity', entryId),
  onStoreChanged: (cb: (snapshot: StoreSnapshot) => void) => {
    const listener = (_e: unknown, snapshot: StoreSnapshot) => cb(snapshot)
    ipcRenderer.on('store:changed', listener)
    return () => ipcRenderer.removeListener('store:changed', listener)
  },

  // ── Onboarding gate + deep links ──
  /** Finish onboarding: promote to the pill/workspace (optionally open record). */
  completeOnboarding: (opts?: { openRecordPanel?: boolean }): Promise<void> =>
    ipcRenderer.invoke('onboarding:complete', opts ?? {}),
  /** Resize the onboarding window to hug the current card. */
  setOnboardingSize: (w: number, h: number): Promise<void> =>
    ipcRenderer.invoke('onboarding:setSize', { w, h }),
  /** Open a URL in the system browser (Terms, Privacy, OAuth). */
  openExternalUrl: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),
  onDeepLink: (cb: (link: DeepLink) => void) => {
    const listener = (_e: unknown, link: DeepLink) => cb(link)
    ipcRenderer.on('onboarding:deepLink', listener)
    return () => ipcRenderer.removeListener('onboarding:deepLink', listener)
  },

  // ── Mocked auth service (stub behind an interface) ──
  authGoogle: (): Promise<Session> => ipcRenderer.invoke('auth:google'),
  authSendMagicLink: (email: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('auth:sendMagicLink', email),
  /** Clear session and reopen the onboarding gate at welcome. */
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),

  // ── Mocked team service ──
  teamCreate: (): Promise<Team> => ipcRenderer.invoke('team:create'),
  teamJoin: (code: string): Promise<JoinResult> => ipcRenderer.invoke('team:join', code),
  teamPreview: (code: string): Promise<InvitePreview> => ipcRenderer.invoke('team:preview', code),
  teamRename: (name: string): Promise<Team> => ipcRenderer.invoke('team:rename', name),
  teamInvite: (email: string): Promise<{ team: Team; error?: string }> =>
    ipcRenderer.invoke('team:invite', email),
  teamResendInvite: (inviteId: string): Promise<Team> =>
    ipcRenderer.invoke('team:resendInvite', inviteId),
  teamRevokeInvite: (inviteId: string): Promise<Team> =>
    ipcRenderer.invoke('team:revokeInvite', inviteId),
  teamRemoveMember: (memberId: string): Promise<Team> =>
    ipcRenderer.invoke('team:removeMember', memberId),

  // ── Permissions service (main process) ──
  getPermissions: (): Promise<PermissionsState> => ipcRenderer.invoke('permissions:get'),
  requestPermission: (id: PermissionId): Promise<PermissionsState> =>
    ipcRenderer.invoke('permissions:request', id),
  openPermissionSettings: (id: PermissionId): Promise<void> =>
    ipcRenderer.invoke('permissions:openSettings', id),
  restartApp: (): Promise<void> => ipcRenderer.invoke('permissions:restart'),
  onPermissionsChanged: (cb: (state: PermissionsState) => void) => {
    const listener = (_e: unknown, state: PermissionsState) => cb(state)
    ipcRenderer.on('permissions:changed', listener)
    return () => ipcRenderer.removeListener('permissions:changed', listener)
  },

  // ── Telemetry / workflow recording ──
  telemetryStart: (
    opts?: TelemetryStartOpts
  ): Promise<{ ok: boolean; status?: TelemetryRecordingStatus; error?: string }> =>
    ipcRenderer.invoke('telemetry:sessionStart', opts ?? {}),
  telemetryStop: (
    sessionIdOrOpts?: string | { sessionId?: string; discard?: boolean }
  ): Promise<{
    ok: boolean
    sessionId?: string | null
    error?: string
    errorCode?: string
    workflow?: Workflow
    extracted?: ExtractedWorkflow
    discarded?: boolean
  }> => ipcRenderer.invoke('telemetry:sessionStop', sessionIdOrOpts),
  /** Retry polish + OpenAI summarization without recording again. */
  telemetryProcessWorkflow: (
    sessionId: string
  ): Promise<{
    ok: boolean
    sessionId?: string
    error?: string
    errorCode?: string
    workflow?: Workflow
    extracted?: ExtractedWorkflow
  }> => ipcRenderer.invoke('telemetry:processWorkflow', sessionId),
  getTelemetryStatus: (): Promise<TelemetryRecordingStatus> =>
    ipcRenderer.invoke('telemetry:getStatus'),
  getTelemetryWorkflow: (
    sessionId: string
  ): Promise<{ ok: boolean; result?: unknown; error?: string }> =>
    ipcRenderer.invoke('telemetry:getWorkflow', sessionId),
  onTelemetryEvent: (cb: (event: TelemetryEvent) => void) => {
    const listener = (_e: unknown, event: TelemetryEvent) => cb(event)
    ipcRenderer.on('telemetry:event', listener)
    return () => ipcRenderer.removeListener('telemetry:event', listener)
  },
  onTelemetryStatus: (cb: (status: TelemetryRecordingStatus) => void) => {
    const listener = (_e: unknown, status: TelemetryRecordingStatus) => cb(status)
    ipcRenderer.on('telemetry:status', listener)
    return () => ipcRenderer.removeListener('telemetry:status', listener)
  },
  onTelemetryWorkflowReady: (
    cb: (payload: {
      sessionId: string
      workflow: Workflow
      extracted: ExtractedWorkflow
    }) => void
  ) => {
    const listener = (
      _e: unknown,
      payload: { sessionId: string; workflow: Workflow; extracted: ExtractedWorkflow }
    ) => cb(payload)
    ipcRenderer.on('telemetry:workflowReady', listener)
    return () => ipcRenderer.removeListener('telemetry:workflowReady', listener)
  },

  // ── Automation compile + run ──
  automationCompile: (
    sessionId: string
  ): Promise<{
    ok: boolean
    sessionId?: string
    opCount?: number
    stale?: boolean
    error?: string
    errorCode?: string
  }> => ipcRenderer.invoke('automation:compile', sessionId),
  automationGetScript: (
    sessionId: string
  ): Promise<{ ok: boolean; script?: unknown; error?: string }> =>
    ipcRenderer.invoke('automation:getScript', sessionId),
  automationMarkStale: (
    sessionId: string,
    stale?: boolean
  ): Promise<{ ok: boolean; stale?: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:markStale', sessionId, stale ?? true),
  automationRunStart: (payload: {
    sessionId: string
    variables?: Record<string, string>
    recompileIfNeeded?: boolean
  }): Promise<{
    ok: boolean
    runId?: string
    opCount?: number
    sessionId?: string
    error?: string
    errorCode?: string
  }> => ipcRenderer.invoke('automation:runStart', payload),
  automationRunPause: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runPause'),
  automationRunResume: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runResume'),
  automationRunStop: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runStop'),
  automationRunRetryStep: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runRetryStep'),
  automationRunSkipStep: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runSkipStep'),
  automationRunTakeOver: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runTakeOver'),
  automationRunAnswer: (payload: {
    value: string
    variableKey?: string | null
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:runAnswer', payload),
  automationRunStatus: (): Promise<{ running: boolean; runId: string | null }> =>
    ipcRenderer.invoke('automation:runStatus'),
  onAutomationRunEvent: (cb: (event: AutomationRunEvent) => void) => {
    const listener = (_e: unknown, event: AutomationRunEvent) => cb(event)
    ipcRenderer.on('run:event', listener)
    return () => ipcRenderer.removeListener('run:event', listener)
  },
  onAutomationCompiled: (
    cb: (payload: { sessionId: string; opCount: number; stale: boolean }) => void
  ) => {
    const listener = (
      _e: unknown,
      payload: { sessionId: string; opCount: number; stale: boolean }
    ) => cb(payload)
    ipcRenderer.on('automation:compiled', listener)
    return () => ipcRenderer.removeListener('automation:compiled', listener)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('ghostBridge', ghostBridge)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (non-isolated fallback for dev)
  window.electron = electronAPI
  // @ts-ignore
  window.ghostBridge = ghostBridge
}
