import React, { useCallback, useEffect, useState, type ReactNode } from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '../styles/globals.css'
import '../styles/components.css'
import '../styles/workspace.css'
import '../styles/onboarding.css'
import './gallery.css'
import { emitBridge, installMockBridge, OWNER_TEAM, type MockOptions } from './mockBridge'
import PillPreview, { type PillSeed } from './PillPreview'
import { BRIEFING, BRIEFING_STEPS, briefingRunSteps, LEDGER } from './sampleData'
import RecordPanel from '../components/panels/RecordPanel'
import DropdownFrame, { installDropdownMock, useGalleryAppIcons } from './DropdownFrame'
import WorkspaceApp from '../workspace/WorkspaceApp'
import OnboardingApp from '../onboarding/OnboardingApp'
import App from '../App'
import type { RunStep } from '../../../shared/types'

type Scenario = {
  id: string
  group: 'Pill' | 'Panels' | 'Dropdown' | 'Workspace' | 'Onboarding' | 'Live'
  label: string
  /** First-frame size of the window until the scenario reports its own. */
  size: [number, number]
  mock?: MockOptions
  render: (report: (w: number, h: number) => void) => ReactNode
  after?: () => void
  /** Not listed on the index (opened by another scenario, like a child window). */
  hidden?: boolean
}

function runAt(activeIndex: number, extra?: (steps: RunStep[]) => RunStep[]): RunStep[] {
  const steps = briefingRunSteps().map((s, i) => ({
    ...s,
    status: (i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending') as RunStep['status']
  }))
  return extra ? extra(steps) : steps
}

const pill = (id: string, label: string, seed: PillSeed, group: Scenario['group'] = 'Pill'): Scenario => ({
  id,
  group,
  label,
  size: [170, 36],
  render: (report) => <PillPreview seed={seed} onBounds={report} />
})

const resolvedBriefing = {
  ...BRIEFING,
  steps: BRIEFING_STEPS.map((s) => (s.fix ? { ...s, fix: { ...s.fix, selectedOptionId: 'last-week', collapsed: true } } : s))
}

const SCENARIOS: Scenario[] = [
  pill('pill-idle', 'Idle', { state: 'idle' }),
  pill('pill-recording', 'Recording · Reading…', { state: 'recording' }),
  pill('pill-paused', 'Recording paused', { state: 'recording', recordPaused: true }),
  pill('pill-thinking', 'Thinking… (organizing)', { state: 'organizing' }),
  pill('pill-running', 'Running', { state: 'running', runCollapsed: true, runSteps: runAt(2) }),
  pill('pill-needs', 'Needs you (question)', {
    state: 'running',
    runCollapsed: true,
    runSteps: runAt(1, (s) =>
      s.map((x, i) =>
        i === 1
          ? { ...x, status: 'question', question: { prompt: 'Which dates?', answerId: null, options: [] } }
          : x
      )
    )
  }),
  pill('pill-error', 'Needs you (failed)', {
    state: 'running',
    runCollapsed: true,
    runElapsedLabel: '1:09',
    runSteps: runAt(4, (s) => s.map((x, i) => (i === 4 ? { ...x, status: 'error', error: { message: 'x' } } : x)))
  }),
  pill('pill-saved', 'Workflow saved', { state: 'idle', savedConfirm: { workflowId: 'p1' } }),
  pill('pill-editing', 'Editor folded', { state: 'editor', editorCollapsed: true }),
  pill('ledger', 'Recording ledger', { state: 'recording', watchExpanded: true, watchLog: LEDGER.slice(0, 3) }, 'Panels'),
  pill('ledger-full', 'Ledger · full + voice', { state: 'recording', watchExpanded: true, watchLog: LEDGER }, 'Panels'),
  pill('editor', 'Here’s what I learned (needs input)', { state: 'editor', workflow: BRIEFING }, 'Panels'),
  pill('editor-resolved', 'Editor · resolved', { state: 'editor', workflow: resolvedBriefing }, 'Panels'),
  pill('running', 'Running 3/5', { state: 'running', runSteps: runAt(2) }, 'Panels'),
  pill(
    'running-question',
    'Running · question',
    {
      state: 'running',
      runSteps: runAt(2, (s) =>
        s.map((x, i) =>
          i === 2
            ? {
                ...x,
                status: 'question',
                label: 'Choose a destination',
                question: {
                  prompt: 'I found two pages named “Crit.” Which should I use?',
                  answerId: null,
                  options: [
                    { id: 'crit', label: 'Crit', kind: 'default' },
                    { id: 'arch', label: 'Crit archive', kind: 'default' },
                    { id: 'other', label: 'Other…', kind: 'other' }
                  ]
                }
              }
            : x
        )
      )
    },
    'Panels'
  ),
  pill(
    'running-error',
    'Run paused · couldn’t continue',
    {
      state: 'running',
      runSteps: runAt(4, (s) =>
        s.map((x, i) => (i === 4 ? { ...x, status: 'error', error: { message: 'Couldn’t find #team-updates in Slack.' } } : x))
      )
    },
    'Panels'
  ),
  pill(
    'summary-done',
    'Summary · done',
    { state: 'summary', runSteps: runAt(5), summaryOutcome: 'done', summaryMeta: 'Done · 5 of 5 · 1:12' },
    'Panels'
  ),
  pill(
    'summary-stopped',
    'Summary · stopped',
    { state: 'summary', runSteps: runAt(2), summaryOutcome: 'stopped', summaryMeta: 'Stopped · 2 of 5 · 0:44' },
    'Panels'
  ),
  pill(
    'toast',
    'Permission revoked toast',
    {
      state: 'idle',
      permToastVisible: true,
      permStakeTitle: 'Screen recording was turned off',
      permStake: 'Weekly project briefing is scheduled for tomorrow, 9:00 A.M. Gray can’t run it until this is back on.'
    },
    'Panels'
  ),
  {
    id: 'dropdown-apps',
    group: 'Dropdown',
    label: 'Record a workflow · Select apps',
    size: [342, 365],
    render: () => <DropdownPreview mode="one-app" />
  },
  {
    id: 'dropdown-screen',
    group: 'Dropdown',
    label: 'Record a workflow · Full screen',
    size: [342, 365],
    render: () => <DropdownPreview mode="full-screen" />
  },
  pill('live-ledger', 'Ledger · live', { state: 'recording', watchExpanded: true, liveLedger: true, watchLog: LEDGER.slice(0, 1) }, 'Live'),
  pill('live-run', 'Run · live', { state: 'running', liveRun: true, runSteps: runAt(0) }, 'Live'),
  {
    id: 'dropdown-window',
    group: 'Dropdown',
    label: 'Record dropdown window (opened from an idle pill)',
    size: [342, 365],
    hidden: true,
    render: () => <DropdownFrame />
  },
  {
    id: 'live-app',
    group: 'Live',
    label: 'Real provider · run Weekly project briefing',
    size: [560, 420],
    mock: {},
    render: () => <App />,
    after: () => setTimeout(() => emitBridge('onRunWorkflow', 'p1'), 600)
  },
  ws('ws-home', 'Workflows', {}),
  ws('ws-detail', 'Workflow · overview', {}, () => emitBridge('onFocusWorkspace', { workflowId: 'p1' })),
  ws('ws-run', 'Workflow · run detail', {}, () =>
    emitBridge('onFocusWorkspace', { workflowId: 'p1', runId: 'run_seed_jun24' })
  ),
  ws('ws-activity', 'Activity', { initialNav: 'activity' }),
  ws('ws-owner', 'Owner · workflows', { team: true }),
  ws('ws-manage', 'Owner · manage team', { team: true, initialNav: 'teams' }),
  ws('ws-empty', 'First run · empty library', { empty: true }),
  onb('onb-welcome', 'Welcome', { onboardingStep: 'welcome', session: null }),
  onb('onb-team', 'Team', { onboardingStep: 'team' }),
  onb('onb-perms', 'Permissions 1 of 3', { onboardingStep: 'permissions' }, { screen: 'unknown', accessibility: 'unknown', microphone: 'unknown' }),
  onb('onb-perms-2', 'Permissions 2 of 3', { onboardingStep: 'permissions' }, { screen: 'granted', accessibility: 'unknown', microphone: 'unknown' }),
  onb('onb-perms-3', 'Permissions 3 of 3 · optional mic', { onboardingStep: 'permissions' }, { screen: 'granted', accessibility: 'granted', microphone: 'unknown' }),
  onb('onb-complete', 'You’re all set', { onboardingStep: 'permissions' }, { screen: 'granted', accessibility: 'granted', microphone: 'granted' })
]

function ws(
  id: string,
  label: string,
  o: { team?: boolean; initialNav?: 'activity' | 'teams'; empty?: boolean },
  after?: () => void
): Scenario {
  return {
    id,
    group: 'Workspace',
    label,
    size: [980, 688],
    mock: {
      snapshot: {
        ...(o.team ? { team: OWNER_TEAM } : {}),
        ...(o.empty ? { workflows: [], runs: [], suggestion: null, activity: [] } : {})
      }
    },
    render: () => <WorkspaceApp initialNav={o.initialNav} initialTeamSpace={o.initialNav === 'teams'} />,
    after: after ? () => setTimeout(after, 300) : undefined
  }
}

function onb(
  id: string,
  label: string,
  snapshot: MockOptions['snapshot'],
  permissions?: MockOptions['permissions']
): Scenario {
  return {
    id,
    group: 'Onboarding',
    label,
    size: [520, 420],
    mock: { snapshot: { onboardingComplete: false, ...snapshot }, permissions },
    render: () => <OnboardingApp />
  }
}

const PREVIEW_APPS = [
  { id: 'notion', name: 'Notion', detail: 'Today’s notes' },
  { id: 'chrome', name: 'Chrome', detail: 'chatgpt.com' },
  { id: 'figma', name: 'Figma', detail: 'Gray' }
]

function DropdownPreview({ mode }: { mode: 'one-app' | 'full-screen' }) {
  const [recordMode, setRecordMode] = useState(mode)
  const [selected, setSelected] = useState(['notion', 'chrome'])
  const [narrate, setNarrate] = useState(true)
  const icons = useGalleryAppIcons(PREVIEW_APPS.map((a) => a.id))
  return (
    <div className="record-dropdown">
      <div className="record-dropdown-panel">
        <div className="record-dropdown-open">
          <RecordPanel
            recordMode={recordMode}
            onRecordMode={setRecordMode}
            apps={PREVIEW_APPS}
            icons={icons}
            selectedAppIds={selected}
            onToggleApp={(id) =>
              setSelected((ids) =>
                ids.includes(id) ? (ids.length > 1 ? ids.filter((x) => x !== id) : ids) : [...ids, id]
              )
            }
            narrate={narrate}
            onNarrate={setNarrate}
            screenGranted
            micGranted
            onRecord={() => {}}
            onScreenRecovery={() => {}}
            onMicSettings={() => {}}
          />
        </div>
      </div>
    </div>
  )
}

/* ── Scenario page (inside an iframe: the iframe is the native window) ── */
function ScenarioPage({ scenario }: { scenario: Scenario }) {
  const report = useCallback(
    (w: number, h: number) => window.parent?.postMessage({ gallery: 'bounds', id: scenario.id, w, h }, '*'),
    [scenario.id]
  )
  useEffect(() => {
    scenario.after?.()
  }, [scenario])
  return <>{scenario.render(report)}</>
}

/* ── Index: every scenario framed at its window size on a desktop backdrop ── */
function Index() {
  const params = new URLSearchParams(location.search)
  const only = new URLSearchParams(location.search).get('only')
  const groupFilter = new URLSearchParams(location.search).get('group')
  const [sizes, setSizes] = useState<Record<string, [number, number]>>({})
  /** Which pill scenario has its Record dropdown window open (one at a time, as in the app). */
  const [dropdownFor, setDropdownFor] = useState<string | null>(null)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (d?.gallery === 'bounds') setSizes((s) => ({ ...s, [d.id]: [d.w, d.h] }))
      if (d?.gallery === 'dropdown') {
        if (d.toggle) setDropdownFor((cur) => (cur === d.id ? null : d.id))
        else setDropdownFor(d.open ? d.id : null)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])
  // Tell the pill frames which one owns the open dropdown (its pill shows the hover state).
  useEffect(() => {
    document.querySelectorAll('iframe').forEach((f) =>
      f.contentWindow?.postMessage({ gallery: 'dropdown-state', id: dropdownFor }, '*')
    )
  }, [dropdownFor])
  const list = SCENARIOS.filter(
    (s) => !s.hidden && (!only || s.id === only) && (!groupFilter || s.group === groupFilter)
  )
  const [ddW, ddH] = sizes['dropdown-window'] ?? [342, 365]
  const groups = [...new Set(list.map((s) => s.group))]
  return (
    <div className="gallery">
      {!only && <h1 className="gallery-title">Gray · interface gallery</h1>}
      {groups.map((g) => (
        <section key={g} className="gallery-group">
          {!only && <h2>{g}</h2>}
          <div className="gallery-grid">
            {list
              .filter((s) => s.group === g)
              .map((s) => {
                const [w, h] = sizes[s.id] ?? s.size
                return (
                  <figure key={s.id} className="gallery-item" id={s.id}>
                    <div className="gallery-desk">
                      {dropdownFor === s.id && (
                        <iframe
                          key="dropdown"
                          title="Record a workflow"
                          className="gallery-child-window"
                          src={`?s=dropdown-window${params.get('still') ? '&still=1' : ''}`}
                          style={{ width: ddW, height: ddH }}
                        />
                      )}
                      <iframe
                        title={s.label}
                        src={`?s=${s.id}${params.get('still') ? '&still=1' : ''}`}
                        style={{ width: w, height: h }}
                      />
                    </div>
                    {!only && (
                      <figcaption>
                        <a href={`?only=${s.id}`}>{s.label}</a>
                        <span>
                          {w}×{h}
                        </span>
                      </figcaption>
                    )}
                  </figure>
                )
              })}
          </div>
        </section>
      ))}
    </div>
  )
}

const params = new URLSearchParams(location.search)
const sid = params.get('s')
const scenario = sid ? SCENARIOS.find((s) => s.id === sid) : null
if (params.get('still') || window.parent?.location.search.includes('still')) {
  document.documentElement.classList.add('gallery-still')
}
if (scenario?.id === 'dropdown-window') installDropdownMock(scenario.id)
if (scenario) {
  document.documentElement.classList.add('gallery-frame')
  installMockBridge({
    ...scenario.mock,
    onBounds: (w, h) => window.parent?.postMessage({ gallery: 'bounds', id: scenario.id, w, h }, '*')
  })
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{scenario ? <ScenarioPage scenario={scenario} /> : <Index />}</React.StrictMode>
)
