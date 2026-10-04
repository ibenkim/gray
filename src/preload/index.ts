import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DeepLink,
  DropdownAck,
  DropdownClosed,
  RecordDropdownCommand,
  RecordDropdownSnapshot,
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
  RecordingSummary,
  ReviewPreview,
  TransitionAck,
  Workflow,
  WorkspaceFocus
} from '../shared/types'
import type { ExtractedWorkflow, TelemetryEvent } from '../shared/telemetry/schema'

/** Renderer's account of the final narration chunks it sent before Stop. */
type AudioReport = {
  chunksAcknowledged: number
  chunksFailed: number
  timedOut: boolean
  /** Recorder error or stop exception after capture started (sticky). */
  recorderFailed?: boolean
}

type RecordingResult = {
  ok: boolean
  sessionId?: string | null
  error?: string
  errorCode?: string
  recording?: RecordingSummary
}

type TelemetryRecordingStatus = {
  recording: boolean
  paused?: boolean
  sessionId: string | null
  sequence: number
  startedAt: string | null
  processing: boolean
  /** Main-owned lifecycle phase (M2). */
  phase?: 'idle' | 'starting' | 'recording' | 'pausing' | 'paused' | 'resuming' | 'stopping'
  generation?: number
  /** Narration ends at the first pause; resume continues without it. */
  narration?: 'off' | 'active' | 'ended'
  /** Main lifecycle (M2-R2): Start pending / durable save not yet written / source teardown unconfirmed. */
  starting?: boolean
  saving?: boolean
  teardownFailed?: boolean
}

type TelemetryStartOpts = {
  recordMode?: 'one-app' | 'full-screen'
  selectedAppId?: string
  ownerEmail?: string
  narrate?: boolean
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
      simulated?: boolean
    }
  | {
      type: 'stepFailed'
      runId: string
      stepOrder: number
      opIndex: number
      label: string
      message: string
      code?: string
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
      type: 'navigating'
      runId: string
      stepOrder: number
      opIndex: number
      destination: string
    }
  | {
      type: 'finished'
      runId: string
      outcome: 'done' | 'stopped'
      resolution?: { tier1: number; tier2: number }
    }

const ghostBridge = {
  /** Resize the pill window; resolves a generation-stamped acknowledgement. */
  setBounds: (
    w: number,
    h: number,
    mode: 'pill' | 'glass' | 'panel',
    opts?: { durationMs?: number; pillDrive?: boolean; center?: boolean }
  ): Promise<TransitionAck> =>
    ipcRenderer.invoke('window:setBounds', {
      w,
      h,
      mode,
      durationMs: opts?.durationMs,
      pillDrive: opts?.pillDrive,
      center: opts?.center
    }),
  /** Hide + park off-screen before idle CSS — only for the given (current) close. */
  /** Restore the window to the saved pill rect — only for the given (current) close. */
  restorePill: (generation: number) => ipcRenderer.invoke('window:restorePill', generation),
  /** Open (or focus) the workspace window; optional deep-link to a workflow / run. */
  openWorkspace: (focus?: string | WorkspaceFocus) =>
    ipcRenderer.invoke('workspace:open', focus),
  /** Close the calling window. */
  closeWindow: () => ipcRenderer.invoke('window:close'),
  /** Minimize the calling window. */
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  /** Click-through empty glass chrome while idle in an oversized frame. */
  setIgnoreMouseEvents: (ignore: boolean, opts?: { forward?: boolean }) =>
    ipcRenderer.send('window:setIgnoreMouseEvents', ignore, opts),
  /** Show the native right-click context menu for the pill. */
  showContextMenu: () => ipcRenderer.invoke('pill:contextMenu'),
  /** Keep main's context-menu variant in sync with AppState. */
  setPillAppState: (state: string) => ipcRenderer.invoke('pill:setAppState', state),
  /** Ink-20 fullscreen dim behind the expanded editor. */
  setEditorScrim: (visible: boolean) => ipcRenderer.invoke('editor:setScrim', visible),
  /** Begin dragging; resolves the gesture token. collapseToPill=false keeps glass open. */
  dragStart: (x: number, y: number, opts?: { collapseToPill?: boolean }): Promise<number | null> =>
    ipcRenderer.invoke('pill:dragStart', { x, y, collapseToPill: opts?.collapseToPill }),
  /** End the gesture with its token (only the owning window's gesture ends). */
  dragEnd: (token?: number | null): Promise<boolean> => ipcRenderer.invoke('pill:dragEnd', token),
  /** Workspace → pill: run a workflow now (looked up by id in the shared store). */
  runWorkflow: (workflowId: string) => ipcRenderer.invoke('pill:runWorkflow', workflowId),
  /** Workspace → pill: open the record panel. */
  openRecordPanel: () => ipcRenderer.invoke('pill:openRecordPanel'),
  /** Pill: show the anchored Record dropdown (M1-HF3); settles once visible or failed. */
  openDropdown: (): Promise<DropdownAck> => ipcRenderer.invoke('dropdown:open'),
  closeDropdown: (): Promise<DropdownAck | null> => ipcRenderer.invoke('dropdown:close'),
  /** Pill → dropdown: the current form view (the pill stays the owner). */
  sendDropdownSnapshot: (snapshot: RecordDropdownSnapshot) =>
    ipcRenderer.send('dropdown:snapshot', snapshot),
  onDropdownCommand: (cb: (cmd: RecordDropdownCommand) => void) => {
    const listener = (_e: unknown, cmd: RecordDropdownCommand) => cb(cmd)
    ipcRenderer.on('dropdown:command', listener)
    return () => ipcRenderer.removeListener('dropdown:command', listener)
  },
  onDropdownClosed: (cb: (event: DropdownClosed) => void) => {
    const listener = (_e: unknown, event: DropdownClosed) => cb(event)
    ipcRenderer.on('dropdown:closed', listener)
    return () => ipcRenderer.removeListener('dropdown:closed', listener)
  },
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
  telemetryPause: (payload?: {
    sessionId?: string
    audio?: AudioReport
  }): Promise<{ ok: boolean; status?: TelemetryRecordingStatus; error?: string }> =>
    ipcRenderer.invoke('telemetry:sessionPause', payload),
  telemetryResume: (payload?: {
    sessionId?: string
  }): Promise<{ ok: boolean; status?: TelemetryRecordingStatus; error?: string }> =>
    ipcRenderer.invoke('telemetry:sessionResume', payload),
  /** Main's stop barrier (hide/logout/revoke/quit) asks the owner to release its mic and Stop. */
  onTelemetryStopRequested: (cb: (req: { sessionId: string; reason: string }) => void) => {
    const listener = (_e: unknown, req: { sessionId: string; reason: string }) => cb(req)
    ipcRenderer.on('telemetry:stopRequested', listener)
    return () => ipcRenderer.removeListener('telemetry:stopRequested', listener)
  },
  telemetryStop: (
    sessionIdOrOpts?: string | { sessionId?: string; discard?: boolean; audio?: AudioReport }
  ): Promise<{
    ok: boolean
    sessionId?: string | null
    error?: string
    errorCode?: string
    /** Finish saved locally; no interpretation ran (M1 hold). */
    localOnly?: boolean
    recording?: RecordingSummary
    discarded?: boolean
  }> => ipcRenderer.invoke('telemetry:sessionStop', sessionIdOrOpts),
  /** Retry interpretation. Returns UPLOAD_REVIEW_REQUIRED while the M1 hold is active. */
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
  /** Same-session local save retry (never re-records, never sends). */
  telemetryRetrySave: (sessionId: string): Promise<RecordingResult> =>
    ipcRenderer.invoke('telemetry:retrySave', sessionId),
  telemetryListRecordings: (opts?: { limit?: number }): Promise<RecordingSummary[]> =>
    ipcRenderer.invoke('telemetry:listRecordings', opts),
  telemetryGetRecording: (sessionId: string): Promise<RecordingResult> =>
    ipcRenderer.invoke('telemetry:getRecording', sessionId),
  /** Local only: main prepares the exact sanitized payload; nothing is sent. */
  telemetryPrepareReview: (
    sessionId: string
  ): Promise<RecordingResult & { preview?: ReviewPreview }> =>
    ipcRenderer.invoke('telemetry:prepareReview', sessionId),
  telemetryCancelReview: (sessionId: string): Promise<RecordingResult> =>
    ipcRenderer.invoke('telemetry:cancelReview', sessionId),
  /** Approves one prepared revision/digest; main validates and owns the request. */
  telemetryApproveInterpretation: (payload: {
    sessionId: string
    revision: number
    digest: string
    acknowledgeUnknownOutcome?: boolean
  }): Promise<RecordingResult & { alreadyRunning?: boolean }> =>
    ipcRenderer.invoke('telemetry:approveInterpretation', payload),
  telemetryOpenResult: (
    sessionId: string
  ): Promise<{ ok: boolean; workflow?: Workflow; partial?: boolean; error?: string }> =>
    ipcRenderer.invoke('telemetry:openResult', sessionId),
  onRecordingChanged: (cb: (summary: RecordingSummary) => void) => {
    const listener = (_e: unknown, summary: RecordingSummary) => cb(summary)
    ipcRenderer.on('telemetry:recordingChanged', listener)
    return () => ipcRenderer.removeListener('telemetry:recordingChanged', listener)
  },
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

  // ── Narration (renderer MediaRecorder → main) ──
  narrationStart: (
    sessionId: string
  ): Promise<{ ok: boolean; audioPath?: string | null; error?: string }> =>
    ipcRenderer.invoke('narration:start', sessionId),
  narrationAppend: (
    sessionId: string,
    chunk: ArrayBuffer
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('narration:append', sessionId, chunk),
  narrationStop: (
    sessionId: string
  ): Promise<{
    ok: boolean
    sessionId?: string | null
    audioPath?: string | null
    hadChunks?: boolean
    error?: string
  }> => ipcRenderer.invoke('narration:stop', sessionId),

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
    stale?: boolean,
    editorSteps?: Array<{ index: number; title: string }>
  ): Promise<{ ok: boolean; stale?: boolean; error?: string }> =>
    ipcRenderer.invoke('automation:markStale', sessionId, stale ?? true, editorSteps),
  automationRunStart: (payload: {
    sessionId: string
    variables?: Record<string, string>
    recompileIfNeeded?: boolean
    editorSteps?: Array<{ index: number; title: string }>
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

/**
 * The Record dropdown window (main passes this surface argument) gets only its own narrow UI
 * messages: no capture, store, automation or window-control bridge.
 */
const grayDropdown = {
  hello: () => ipcRenderer.send('dropdown:hello'),
  ready: () => ipcRenderer.send('dropdown:ready'),
  measured: (height: number) => ipcRenderer.send('dropdown:measured', height),
  command: (cmd: RecordDropdownCommand) => ipcRenderer.send('dropdown:command', cmd),
  dismiss: () => ipcRenderer.send('dropdown:dismiss'),
  dragStart: (): Promise<number | null> => ipcRenderer.invoke('dropdown:dragStart'),
  dragEnd: (token: number | null): Promise<boolean> => ipcRenderer.invoke('dropdown:dragEnd', token),
  onSnapshot: (cb: (snapshot: RecordDropdownSnapshot) => void) => {
    const listener = (_e: unknown, snapshot: RecordDropdownSnapshot) => cb(snapshot)
    ipcRenderer.on('dropdown:snapshot', listener)
    return () => ipcRenderer.removeListener('dropdown:snapshot', listener)
  }
}
const isRecordDropdown = process.argv.includes('--gray-surface=record-dropdown')

if (isRecordDropdown) {
  contextBridge.exposeInMainWorld('grayDropdown', grayDropdown)
} else if (process.contextIsolated) {
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
