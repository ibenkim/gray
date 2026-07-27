import { useEffect, useState } from 'react'
import { newId } from '../../../shared/id'
import { hoursReturnedThisMonth } from '../../../shared/runFormat'
import type {
  ActivityEntry,
  Run,
  Session,
  StoreSnapshot,
  Suggestion,
  Team,
  Workflow,
  WorkspaceFocus
} from '../state/types'
import { useWorkspaceDrag } from '../hooks/useWorkspaceDrag'
import Sidebar from './Sidebar'
import WorkflowsHome from './WorkflowsHome'
import WorkflowDetail from './WorkflowDetail'
import ActivityView from './ActivityView'
import ManageView from './ManageView'

export type WorkspaceNav = 'workflows' | 'activity' | 'shared' | 'teams'

export type Space = string

/**
 * Shared Workspace shell — employee + owner use the same surfaces.
 * Teams/Shared are role-gated where needed; pill mutations sync via store.
 */
export default function WorkspaceApp() {
  const [nav, setNav] = useState<WorkspaceNav>('workflows')
  const [space, setSpace] = useState<Space>('Personal')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [focusRunId, setFocusRunId] = useState<string | null>(null)
  const [editStepId, setEditStepId] = useState<string | null>(null)

  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [team, setTeam] = useState<Team>(null)
  const [session, setSession] = useState<Session>(null)
  const [ready, setReady] = useState(false)
  const { onMouseDown: onDragMouseDown } = useWorkspaceDrag()

  function applySnapshot(snap: StoreSnapshot) {
    setWorkflows(snap.workflows)
    setRuns(snap.runs)
    setSuggestion(snap.suggestion)
    setActivity(snap.activity)
    setTeam(snap.team)
    setSession(snap.session)
    setReady(true)
  }

  useEffect(() => {
    let cancelled = false
    window.ghostBridge?.getSnapshot?.().then((snap) => {
      if (!cancelled && snap) applySnapshot(snap)
    })
    const off = window.ghostBridge?.onStoreChanged?.(applySnapshot)
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  // Deep-link from saved pill / View log / Activity Done.
  useEffect(() => {
    async function applyFocus(focus: WorkspaceFocus) {
      setNav('workflows')
      setSpace('Personal')
      if (focus.runId) {
        let workflowId = focus.workflowId
        if (!workflowId) {
          const run = await window.ghostBridge?.getRun?.(focus.runId)
          workflowId = run?.workflowId
        }
        if (workflowId) setDetailId(workflowId)
        setFocusRunId(focus.runId)
        return
      }
      if (focus.workflowId) {
        setDetailId(focus.workflowId)
        setFocusRunId(null)
      }
    }

    const offFocus = window.ghostBridge?.onFocusWorkspace?.(applyFocus)
    const offLegacy = window.ghostBridge?.onFocusWorkflow?.((workflowId) => {
      void applyFocus({ workflowId })
    })
    return () => {
      offFocus?.()
      offLegacy?.()
    }
  }, [])

  // Teams / Shared require a team — bounce home if the team drops away.
  useEffect(() => {
    if ((nav === 'teams' || nav === 'shared') && !team) {
      setNav('workflows')
    }
  }, [nav, team])

  const isOwner = team?.role === 'owner'
  const teamSpaceName = team?.name ?? "Harry's team"

  // Keep the team-space selection pointed at the live team name after rename.
  useEffect(() => {
    if (space !== 'Personal' && space !== teamSpaceName) {
      setSpace(teamSpaceName)
    }
  }, [space, teamSpaceName])

  const inPersonal = space === 'Personal'
  const spaceWorkflows = inPersonal ? workflows : []
  const spaceActivity = inPersonal ? activity : []
  const spaceRuns = inPersonal ? runs : []
  const sharedWorkflows = workflows.filter((w) => w.scope === 'team')

  const detail = detailId ? workflows.find((w) => w.id === detailId) ?? null : null

  async function persistWorkflow(next: Workflow) {
    await window.ghostBridge?.upsertWorkflow?.(next)
  }

  async function updateWorkflow(id: string, updater: (w: Workflow) => Workflow) {
    const current = workflows.find((w) => w.id === id)
    if (!current) return
    await persistWorkflow(updater(current))
  }

  async function shareWorkflowToTeam(id: string) {
    if (!team) return
    const self = team.members.find((m) => m.isSelf)
    const sharedBy = self?.id ?? session?.email ?? 'self'
    const sharedByName = session?.displayName ?? self?.name ?? 'You'
    await updateWorkflow(id, (w) => ({
      ...w,
      scope: 'team',
      sharedBy,
      sharedByName
    }))
  }

  async function skipOccurrence(entryId: string) {
    await window.ghostBridge?.skipActivity?.(entryId)
  }

  async function discardSuggestion() {
    if (!suggestion) return
    await window.ghostBridge?.discardSuggestion?.(suggestion.id)
  }

  async function duplicateWorkflow(id: string) {
    const source = workflows.find((w) => w.id === id)
    if (!source) return
    const copy: Workflow = {
      ...source,
      id: newId('wf'),
      name: `Copy of ${source.name}`,
      status: 'off',
      runCount: 0,
      hoursReturned: '≈ 0 h returned total',
      scope: 'personal',
      sharedBy: undefined,
      sharedByName: undefined,
      steps: source.steps.map((s) => ({
        ...s,
        id: newId('s'),
        fix: s.fix ? { ...s.fix, options: [...s.fix.options] } : undefined
      })),
      trigger: {
        ...source.trigger,
        cadence: source.trigger.cadence ? { ...source.trigger.cadence } : undefined
      }
    }
    await persistWorkflow(copy)
    setDetailId(copy.id)
    setFocusRunId(null)
  }

  async function deleteWorkflow(id: string) {
    await window.ghostBridge?.deleteWorkflow?.(id)
    setDetailId(null)
    setFocusRunId(null)
  }

  if (!ready) {
    return (
      <div className="workspace-shell">
        <div className="workspace-window" />
      </div>
    )
  }

  return (
    <div className="workspace-shell">
      <div className="workspace-window">
        <div
          className="ws-drag-strip"
          aria-hidden="true"
          onMouseDown={onDragMouseDown}
        />
        <Sidebar
          nav={nav}
          onNav={(n) => {
            setNav(n)
            setDetailId(null)
            setFocusRunId(null)
            setEditStepId(null)
          }}
          space={space}
          onSpace={setSpace}
          team={team}
          isOwner={isOwner}
        />
        <div className="workspace-content">
          {detail ? (
            <WorkflowDetail
              workflow={detail}
              runs={spaceRuns.filter((r) => r.workflowId === detail.id)}
              initialRunId={focusRunId}
              initialEditStepId={editStepId}
              onBack={() => {
                setDetailId(null)
                setFocusRunId(null)
                setEditStepId(null)
              }}
              onUpdate={(updater) => updateWorkflow(detail.id, updater)}
              onDuplicate={() => duplicateWorkflow(detail.id)}
              onDelete={() => deleteWorkflow(detail.id)}
              onOpenActivity={() => {
                setDetailId(null)
                setFocusRunId(null)
                setNav('activity')
              }}
              onFixStep={(stepId) => {
                setFocusRunId(null)
                setEditStepId(stepId)
              }}
              onShareToTeam={
                team ? () => void shareWorkflowToTeam(detail.id) : undefined
              }
            />
          ) : nav === 'teams' && team ? (
            <ManageView team={team} canManage={isOwner} />
          ) : nav === 'shared' ? (
            <WorkflowsHome
              workflows={sharedWorkflows}
              hoursLine={hoursReturnedThisMonth(runs)}
              suggestion={null}
              variant="shared"
              onOpen={(id) => {
                setDetailId(id)
                setFocusRunId(null)
              }}
              onToggleStatus={(id) =>
                updateWorkflow(id, (w) => ({ ...w, status: w.status === 'on' ? 'off' : 'on' }))
              }
              onDiscardSuggestion={discardSuggestion}
              onRename={(id, name) => updateWorkflow(id, (w) => ({ ...w, name }))}
              onDuplicate={(id) => void duplicateWorkflow(id)}
              onDelete={(id) => void deleteWorkflow(id)}
            />
          ) : nav === 'workflows' ? (
            <WorkflowsHome
              workflows={spaceWorkflows}
              hoursLine={hoursReturnedThisMonth(spaceRuns)}
              suggestion={inPersonal ? suggestion : null}
              ownerTeamSize={isOwner ? team?.memberCount : undefined}
              onOpen={(id) => {
                setDetailId(id)
                setFocusRunId(null)
              }}
              onToggleStatus={(id) =>
                updateWorkflow(id, (w) => ({ ...w, status: w.status === 'on' ? 'off' : 'on' }))
              }
              onDiscardSuggestion={discardSuggestion}
              onRename={(id, name) => updateWorkflow(id, (w) => ({ ...w, name }))}
              onDuplicate={(id) => void duplicateWorkflow(id)}
              onDelete={(id) => void deleteWorkflow(id)}
            />
          ) : (
            <ActivityView
              entries={spaceActivity}
              onOpenWorkflow={(id) => {
                setNav('workflows')
                setDetailId(id)
                setFocusRunId(null)
              }}
              onOpenRun={(workflowId, runId) => {
                setNav('workflows')
                setDetailId(workflowId)
                setFocusRunId(runId)
              }}
              onSkip={skipOccurrence}
              onAnswerHold={() => window.ghostBridge?.revealRunning?.()}
            />
          )}
        </div>
      </div>
    </div>
  )
}
