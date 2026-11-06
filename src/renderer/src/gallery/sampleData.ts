/** Portfolio sample content (Figma Hero kit: "Weekly project briefing"). Gallery only. */
import type { EditorStep, RunStep, Workflow } from '../../../shared/types'
import type { WatchEntry } from '../state/WorkflowContext'

export const BRIEFING_STEPS: EditorStep[] = [
  { id: 'b1', index: 1, title: 'Open the project board in', app: { id: 'notion', name: 'Notion' } },
  {
    id: 'b2',
    index: 2,
    title: 'Find tasks completed **Oct 5–11**',
    fix: {
      prompt: 'Which dates should I use each time?',
      context: 'You selected October 5–11 while recording.',
      selectedOptionId: 'ask-each-time',
      collapsed: false,
      options: [
        { id: 'last-week', label: 'Last calendar week', kind: 'default' },
        { id: 'past-7', label: 'Past 7 days', kind: 'default' },
        { id: 'ask-each-time', label: 'Ask each time', kind: 'default' }
      ]
    }
  },
  { id: 'b3', index: 3, title: 'Collect current blockers and tasks due this week' },
  {
    id: 'b4',
    index: 4,
    title: 'Summarize what needs the team’s attention',
    voiceNote: { text: '“...keep it short, blockers first”' }
  },
  { id: 'b5', index: 5, title: 'Post the briefing to #team-updates in', app: { id: 'slack', name: 'Slack' } }
]

export const BRIEFING: Workflow = {
  id: 'p1',
  name: 'Weekly project briefing',
  metaLabel: '5 steps · 1:28',
  trigger: { cadence: { kind: 'weekly', days: [1], time: { hour: 9, minute: 0 } } },
  steps: BRIEFING_STEPS,
  status: 'on',
  runCount: 12,
  hoursReturned: '≈ 7.6 h returned total'
}

export const PORTFOLIO_WORKFLOWS: Workflow[] = [
  { ...BRIEFING, steps: BRIEFING_STEPS.map((s) => ({ ...s, fix: undefined })) },
  {
    id: 'p2',
    name: 'Invoice reminders',
    metaLabel: '3 steps · 0:36',
    trigger: { cadence: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: { hour: 16, minute: 30 } } },
    steps: BRIEFING_STEPS.slice(2, 4).map((s) => ({ ...s, fix: undefined })),
    status: 'on',
    runCount: 31,
    hoursReturned: '≈ 12.4 h returned total'
  },
  {
    id: 'p3',
    name: 'Expense sorting',
    metaLabel: '3 steps · 0:30',
    trigger: {},
    steps: BRIEFING_STEPS.slice(0, 2).map((s) => ({ ...s, fix: undefined })),
    status: 'off',
    runCount: 4,
    hoursReturned: '≈ 0.9 h returned total'
  }
]

export function briefingRunSteps(): RunStep[] {
  const done: Record<string, string> = {
    b1: 'Opened the project board in',
    b2: 'Found tasks completed last week',
    b3: 'Collected current blockers and tasks due this week',
    b4: 'Summarized what needs the team’s attention',
    b5: 'Posted the briefing to #team-updates in'
  }
  return BRIEFING_STEPS.map((s) => ({
    id: `run-${s.id}`,
    index: s.index,
    label: s.id === 'b2' ? 'Find tasks completed last week' : s.title,
    doneLabel: done[s.id] ?? s.title,
    app: s.app,
    voiceNote: s.voiceNote,
    status: 'pending' as const
  }))
}

export const LEDGER: WatchEntry[] = [
  { time: '00:03', text: 'Opened the project board in', app: { id: 'notion', name: 'Notion' } },
  { time: '00:11', text: 'Filtered Done by **Oct 5–11**' },
  { time: '00:27', text: 'Filtered status is **Blocked**' },
  { time: '00:36', text: 'Filtered due date is **This week**' },
  { time: '00:52', text: 'Copied 14 tasks' },
  { time: '01:06', text: 'Drafted a briefing', voiceNote: '“...keep it short, blockers first”' },
  { time: '01:21', text: 'Posted to #team-updates in', app: { id: 'slack', name: 'Slack' } }
]
