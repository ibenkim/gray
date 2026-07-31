import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { mergeComingUp } from '../shared/activity'
import { createSeedSnapshot } from '../shared/seed'
import type {
  ActivityEntry,
  OnboardingStep,
  PillPosition,
  RecordSettings,
  Run,
  Session,
  StoreSnapshot,
  Suggestion,
  Team,
  Workflow
} from '../shared/types'
import { normalizeTeam } from './team'

const ONBOARDING_STEPS: OnboardingStep[] = ['welcome', 'team', 'permissions', 'complete']

function normalizeStep(raw: unknown): OnboardingStep {
  return ONBOARDING_STEPS.includes(raw as OnboardingStep) ? (raw as OnboardingStep) : 'welcome'
}

const STORE_VERSION = 1 as const

let snapshot: StoreSnapshot = createSeedSnapshot()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'ghost-data.json')
}

function normalizeWorkflow(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== 'object') return null
  const w = raw as Workflow
  if (typeof w.id !== 'string' || typeof w.name !== 'string') return null
  const scope = w.scope === 'team' ? 'team' : 'personal'
  return {
    ...w,
    scope,
    sharedBy: typeof w.sharedBy === 'string' ? w.sharedBy : undefined,
    sharedByName: typeof w.sharedByName === 'string' ? w.sharedByName : undefined,
    sessionId: typeof w.sessionId === 'string' ? w.sessionId : undefined,
    automationStale: Boolean(w.automationStale)
  }
}

function normalizeSnapshot(raw: unknown): StoreSnapshot {
  const seed = createSeedSnapshot()
  if (!raw || typeof raw !== 'object') return seed
  const data = raw as Partial<StoreSnapshot>
  const workflows = Array.isArray(data.workflows)
    ? data.workflows.map(normalizeWorkflow).filter((w): w is Workflow => w != null)
    : seed.workflows
  return {
    version: STORE_VERSION,
    workflows,
    runs: Array.isArray(data.runs) ? data.runs : [],
    activity: Array.isArray(data.activity) ? data.activity : seed.activity,
    suggestion: data.suggestion === undefined ? seed.suggestion : data.suggestion,
    discardedSuggestionIds: Array.isArray(data.discardedSuggestionIds)
      ? data.discardedSuggestionIds
      : [],
    recordSettings: data.recordSettings ?? seed.recordSettings,
    pillPosition: data.pillPosition ?? null,
    onboardingComplete: Boolean(data.onboardingComplete),
    onboardingStep: normalizeStep(data.onboardingStep),
    session: data.session ?? null,
    team: normalizeTeam(data.team ?? null, data.session ?? null),
    micSkipped: Boolean(data.micSkipped),
    permissionToastDismissedAt: data.permissionToastDismissedAt ?? null,
    lastPermissionRevokeAt: data.lastPermissionRevokeAt ?? null
  }
}

function persistNow(): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(snapshot, null, 2), 'utf8')
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      persistNow()
    } catch (err) {
      console.error('[store] persist failed', err)
    }
  }, 80)
}

function broadcast(): void {
  const payload = getSnapshot()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('store:changed', payload)
  }
}

function commit(mutator: (draft: StoreSnapshot) => void): StoreSnapshot {
  mutator(snapshot)
  schedulePersist()
  broadcast()
  return getSnapshot()
}

function refreshComingUp(draft: StoreSnapshot): void {
  draft.activity = mergeComingUp(draft.activity, draft.workflows)
}

export function getSnapshot(): StoreSnapshot {
  return structuredClone(snapshot)
}

export function getWorkflow(id: string): Workflow | null {
  const wf = snapshot.workflows.find((w) => w.id === id)
  return wf ? structuredClone(wf) : null
}

export function loadStore(): StoreSnapshot {
  const path = storePath()
  if (!existsSync(path)) {
    snapshot = createSeedSnapshot()
    persistNow()
    return getSnapshot()
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
    snapshot = normalizeSnapshot(raw)
    refreshComingUp(snapshot)
  } catch (err) {
    console.error('[store] load failed — reseeding', err)
    snapshot = createSeedSnapshot()
    persistNow()
  }
  return getSnapshot()
}

export function upsertWorkflow(workflow: Workflow): StoreSnapshot {
  return commit((draft) => {
    const i = draft.workflows.findIndex((w) => w.id === workflow.id)
    if (i >= 0) draft.workflows[i] = workflow
    else draft.workflows.unshift(workflow)
    refreshComingUp(draft)
  })
}

/** Remove a workflow; Run records stay for History. */
export function deleteWorkflow(id: string): StoreSnapshot {
  return commit((draft) => {
    draft.workflows = draft.workflows.filter((w) => w.id !== id)
    draft.activity = draft.activity.filter(
      (a) => !(a.workflowId === id && a.kind === 'scheduled')
    )
    refreshComingUp(draft)
  })
}

export function saveRun(run: Run): StoreSnapshot {
  return commit((draft) => {
    const i = draft.runs.findIndex((r) => r.id === run.id)
    if (i >= 0) draft.runs[i] = run
    else draft.runs.unshift(run)

    const wf = draft.workflows.find((w) => w.id === run.workflowId)
    if (wf && run.outcome === 'done') {
      wf.runCount += 1
    }

    // Drop the ephemeral hold row — the completed run row replaces it.
    draft.activity = draft.activity.filter((a) => a.id !== `act_hold_${run.id}`)

    // Mirror a lightweight Activity row so outcomes exist even if the
    // workspace was never opened (Phase 3 owns richer Activity UI).
    const held = run.steps.find((s) => s.status === 'held')
    const activity: ActivityEntry = {
      id: `act_${run.id}`,
      workflowId: run.workflowId,
      runId: run.id,
      name: wf?.name ?? 'Workflow',
      timeLabel: formatActivityTime(new Date(run.endedAt ?? run.startedAt)),
      group: 'today',
      kind: 'run',
      outcome: run.outcome === 'paused' ? 'paused' : run.outcome,
      stopReason: run.stopReason,
      heldStepIndex: held?.index
    }
    const ai = draft.activity.findIndex((a) => a.id === activity.id)
    if (ai >= 0) draft.activity[ai] = activity
    else draft.activity.unshift(activity)
  })
}

function formatActivityTime(d: Date): string {
  const h24 = d.getHours()
  const suffix = h24 >= 12 ? 'P.M.' : 'A.M.'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h12}:${m} ${suffix}`
}

export function setSuggestion(suggestion: Suggestion | null): StoreSnapshot {
  return commit((draft) => {
    draft.suggestion = suggestion
  })
}

export function discardSuggestion(id: string): StoreSnapshot {
  return commit((draft) => {
    if (!draft.discardedSuggestionIds.includes(id)) {
      draft.discardedSuggestionIds.push(id)
    }
    if (draft.suggestion?.id === id) draft.suggestion = null
  })
}

export function setRecordSettings(settings: RecordSettings): StoreSnapshot {
  return commit((draft) => {
    draft.recordSettings = settings
  })
}

export function setPillPosition(position: PillPosition | null): StoreSnapshot {
  return commit((draft) => {
    draft.pillPosition = position
  })
}

export function setOnboardingComplete(complete: boolean): StoreSnapshot {
  return commit((draft) => {
    draft.onboardingComplete = complete
    if (complete) draft.onboardingStep = 'complete'
  })
}

export function setOnboardingStep(step: OnboardingStep): StoreSnapshot {
  return commit((draft) => {
    draft.onboardingStep = step
  })
}

export function setSession(session: Session): StoreSnapshot {
  return commit((draft) => {
    draft.session = session
  })
}

export function setTeam(team: Team): StoreSnapshot {
  return commit((draft) => {
    draft.team = team
  })
}

export function setMicSkipped(skipped: boolean): StoreSnapshot {
  return commit((draft) => {
    draft.micSkipped = skipped
  })
}

export function setPermissionToastDismissedAt(iso: string | null): StoreSnapshot {
  return commit((draft) => {
    draft.permissionToastDismissedAt = iso
  })
}

export function setLastPermissionRevokeAt(iso: string | null): StoreSnapshot {
  return commit((draft) => {
    draft.lastPermissionRevokeAt = iso
  })
}

export function skipActivity(entryId: string): StoreSnapshot {
  return commit((draft) => {
    const entry = draft.activity.find((a) => a.id === entryId)
    if (entry) entry.skipped = true
  })
}

export function getRun(id: string): Run | null {
  const run = snapshot.runs.find((r) => r.id === id)
  return run ? structuredClone(run) : null
}

export type ActivityHoldPayload = {
  runId: string
  workflowId: string
  name: string
  needsYou: 'answer' | 'help'
  heldStepIndex: number
  waitingSince: string
  /** When set, converts the hold into a stopped row (10-min auto-stop). */
  stopReason?: string
}

/** Mirror a mid-run question/error hold into Activity (Phase 3 renders 2.5). */
export function upsertActivityHold(payload: ActivityHoldPayload): StoreSnapshot {
  return commit((draft) => {
    const id = `act_hold_${payload.runId}`
    const entry: ActivityEntry = {
      id,
      workflowId: payload.workflowId,
      runId: payload.runId,
      name: payload.name,
      timeLabel: formatActivityTime(new Date(payload.waitingSince)),
      group: 'today',
      kind: 'run',
      outcome: payload.stopReason ? 'stopped' : 'paused',
      needsYou: payload.stopReason ? undefined : payload.needsYou,
      heldStepIndex: payload.heldStepIndex,
      waitingSince: payload.waitingSince,
      stopReason: payload.stopReason
    }
    const i = draft.activity.findIndex((a) => a.id === id)
    if (i >= 0) draft.activity[i] = entry
    else draft.activity.unshift(entry)
  })
}

/** Clear a resolved hold before the run finishes (answer / retry / skip / take-over). */
export function clearActivityHold(runId: string): StoreSnapshot {
  return commit((draft) => {
    draft.activity = draft.activity.filter((a) => a.id !== `act_hold_${runId}`)
  })
}

/** Register store IPC handlers (call once from main). */
export function registerStoreIpc(): void {
  ipcMain.handle('store:getSnapshot', () => getSnapshot())
  ipcMain.handle('store:getWorkflow', (_e, id: string) => getWorkflow(id))
  ipcMain.handle('store:getRun', (_e, id: string) => getRun(id))
  ipcMain.handle('store:upsertWorkflow', (_e, workflow: Workflow) => upsertWorkflow(workflow))
  ipcMain.handle('store:deleteWorkflow', (_e, id: string) => deleteWorkflow(id))
  ipcMain.handle('store:saveRun', (_e, run: Run) => saveRun(run))
  ipcMain.handle('store:setSuggestion', (_e, suggestion: Suggestion | null) =>
    setSuggestion(suggestion)
  )
  ipcMain.handle('store:discardSuggestion', (_e, id: string) => discardSuggestion(id))
  ipcMain.handle('store:setRecordSettings', (_e, settings: RecordSettings) =>
    setRecordSettings(settings)
  )
  ipcMain.handle('store:setPillPosition', (_e, position: PillPosition | null) =>
    setPillPosition(position)
  )
  ipcMain.handle('store:setOnboardingComplete', (_e, complete: boolean) =>
    setOnboardingComplete(complete)
  )
  ipcMain.handle('store:setOnboardingStep', (_e, step: OnboardingStep) => setOnboardingStep(step))
  ipcMain.handle('store:setSession', (_e, session: Session) => setSession(session))
  ipcMain.handle('store:setTeam', (_e, team: Team) => setTeam(team))
  ipcMain.handle('store:setMicSkipped', (_e, skipped: boolean) => setMicSkipped(skipped))
  ipcMain.handle('store:setPermissionToastDismissedAt', (_e, iso: string | null) =>
    setPermissionToastDismissedAt(iso)
  )
  ipcMain.handle('store:skipActivity', (_e, entryId: string) => skipActivity(entryId))
  ipcMain.handle('store:upsertActivityHold', (_e, payload: ActivityHoldPayload) =>
    upsertActivityHold(payload)
  )
  ipcMain.handle('store:clearActivityHold', (_e, runId: string) => clearActivityHold(runId))
}
