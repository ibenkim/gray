import {
  withWorkflowStepDefaults,
  type ExtractedWorkflow
} from '../../../shared/telemetry/schema'
import type { TelemetryStore } from '../store/TelemetryStore'

export type EditorStepTitle = {
  index: number
  title: string
}

/**
 * Write UI editor steps back into the stored ExtractedWorkflow so recompile /
 * run honor user edits — including add/delete/reorder, not only title tweaks.
 */
export async function syncEditorStepsToStoredWorkflow(
  store: TelemetryStore,
  sessionId: string,
  editorSteps: EditorStepTitle[] | undefined
): Promise<{ changed: boolean; workflow: ExtractedWorkflow | null }> {
  const stored = await store.getWorkflow(sessionId)
  if (!stored) return { changed: false, workflow: null }
  if (!editorSteps?.length) {
    return { changed: false, workflow: stored.workflow }
  }

  const prev = stored.workflow.steps
  const fallbackEvidence =
    prev.find((s) => s.evidenceEventIds.length > 0)?.evidenceEventIds ?? ['tevt_editor']

  const steps: ExtractedWorkflow['steps'] = editorSteps.map((edit, i) => {
    const title = edit.title.trim().slice(0, 400) || `Step ${i + 1}`
    const matched =
      prev.find((s) => s.order === edit.index) ?? prev[i] ?? prev[prev.length - 1] ?? null
    return withWorkflowStepDefaults({
      order: i + 1,
      action: title,
      category: matched?.category ?? 'other',
      appName: matched?.appName ?? null,
      evidenceEventIds:
        matched?.evidenceEventIds?.length && matched.evidenceEventIds.length > 0
          ? matched.evidenceEventIds
          : fallbackEvidence,
      confidence: matched?.confidence ?? 0.5,
      objective: matched?.objective ?? null,
      actionType: matched?.actionType ?? null,
      targetRole: matched?.targetRole ?? null,
      targetLabel: matched?.targetLabel ?? null,
      inputKind: matched?.inputKind ?? null,
      inputVariableKey: matched?.inputVariableKey ?? null,
      inputLiteral: matched?.inputLiteral ?? null,
      preconditions: matched?.preconditions ?? null,
      expectedChange: matched?.expectedChange ?? null,
      completionCheck: matched?.completionCheck ?? null,
      dependsOnSteps: matched?.dependsOnSteps ?? null,
      retryHint: matched?.retryHint ?? null,
      alternatives: matched?.alternatives ?? null,
      needsClarification: matched?.needsClarification ?? null
    })
  })

  const changed =
    steps.length !== prev.length ||
    steps.some(
      (s, i) =>
        s.action !== prev[i]?.action ||
        s.order !== prev[i]?.order ||
        s.evidenceEventIds.join() !== (prev[i]?.evidenceEventIds ?? []).join()
    )

  const workflow: ExtractedWorkflow = { ...stored.workflow, steps }
  if (changed) {
    await store.saveWorkflow(sessionId, workflow, stored.model)
  }
  return { changed, workflow }
}
