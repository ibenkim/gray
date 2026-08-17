import { describe, expect, it } from 'vitest'
import { withWorkflowStepDefaults, type ExtractedWorkflow } from '../../../shared/telemetry/schema'
import { InMemoryTelemetryStore } from '../store/InMemoryTelemetryStore'
import { syncEditorStepsToStoredWorkflow } from './syncEditorSteps'

describe('syncEditorStepsToStoredWorkflow', () => {
  it('clears needsClarification when the step title changes', async () => {
    const store = new InMemoryTelemetryStore()
    await store.createSession({ sessionId: 'tsess_sync' })
    const workflow: ExtractedWorkflow = {
      title: 't',
      goal: null,
      summary: 's',
      outcome: 'unknown',
      steps: [
        withWorkflowStepDefaults({
          order: 1,
          action: 'Clicked something',
          category: 'interaction',
          appName: 'Figma',
          evidenceEventIds: ['tevt_1'],
          confidence: 0.4,
          needsClarification: true,
          alternatives: [{ interpretation: 'Maybe the canvas', confidence: 0.3 }]
        })
      ],
      warnings: [],
      variables: null,
      addresses: null,
      commits: null,
      writes: null,
      inputs: null,
      authorizationScope: null,
      branches: null,
      questions: null
    }
    await store.saveWorkflow('tsess_sync', workflow, 'test')

    const result = await syncEditorStepsToStoredWorkflow(store, 'tsess_sync', [
      { index: 1, title: 'Click the Export button in Figma' }
    ])
    expect(result.changed).toBe(true)
    expect(result.workflow?.steps[0].action).toBe('Click the Export button in Figma')
    expect(result.workflow?.steps[0].needsClarification).toBe(false)
    expect(result.workflow?.steps[0].alternatives).toBeNull()
  })
})
