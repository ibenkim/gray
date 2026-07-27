import { makeDraftWorkflow, SEED_ACTIVITY, SEED_SUGGESTION, SEED_WORKFLOWS } from '../../../shared/seed'
import type { RecordableApp, RunStep, StepApp, Workflow } from './types'

export const MOCK_APPS: RecordableApp[] = [
  { id: 'chrome', name: 'Chrome', detail: 'youtube.com' },
  { id: 'figma', name: 'Figma', detail: 'Q3 Onboarding' },
  { id: 'slack', name: 'Slack', detail: '#design-crit' }
]

/** Steps that stream into the "Learning" ledger while recording. */
export const MOCK_WATCH_LOG: {
  time: string
  text: string
  voiceNote?: string
  app?: StepApp
}[] = [
  { time: '00:04', text: 'Opened youtube.com', app: { id: 'chrome', name: 'Chrome' } },
  {
    time: '00:11',
    text: 'Make exception for Youtube',
    voiceNote: '“...always skip the ads on this”'
  },
  { time: '00:19', text: 'Send link to Minhyeok', app: { id: 'slack', name: 'Slack' } },
  { time: '00:26', text: 'Copied the share link' },
  { time: '00:31', text: 'Switched to Slack', app: { id: 'slack', name: 'Slack' } }
]

/**
 * Draft template for the pill editor (new id assigned at organize-time).
 * Kept as a function so each organize pass gets a fresh entity.
 */
export function createMockDraft(id: string): Workflow {
  return makeDraftWorkflow(id)
}

/** Flat run ledger mirroring the editor's steps. Ephemeral — a `Run` is written on completion/stop. */
export function makeRunSteps(workflow: Workflow): RunStep[] {
  const past: Record<string, string> = {
    s1: 'Opened Q3 Onboarding in',
    s2: "Duplicated this week's updated frames",
    s3: 'Pasted them into Crit page',
    s4: 'Titled the new section',
    s5: 'Opened Q3 Onboarding in Figma',
    s6: 'Sent to #design-crit'
  }
  return workflow.steps.map((s) => ({
    id: `run-${s.id}`,
    index: s.index,
    label: s.title,
    doneLabel: past[s.id] ?? s.title,
    app: s.app,
    voiceNote: s.voiceNote,
    status: 'pending' as const,
    // Mock 6.4 failure on the Crit-page paste step (real execution is later AI work).
    mockFailOnce: s.id === 's3',
    question:
      s.fix && s.fix.selectedOptionId === 'ask-each-time'
        ? {
            prompt: s.fix.prompt || 'Which title should I use here?',
            answerId: null,
            options: [
              { id: 'todays-date', label: "Today's date", kind: 'suggested' as const },
              { id: 'keep-jul-6', label: 'Keep “Jul 6”', kind: 'default' as const },
              { id: 'other', label: 'Other…', kind: 'other' as const }
            ]
          }
        : undefined
  }))
}

// ── Workspace local seed (Phase 3 wires the shared store) ──

export const MOCK_WORKFLOW_RECORDS = SEED_WORKFLOWS
export const MOCK_SUGGESTION = SEED_SUGGESTION
export const MOCK_ACTIVITY = SEED_ACTIVITY
