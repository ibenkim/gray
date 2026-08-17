import { BrowserWindow, ipcMain } from 'electron'
import { newId } from '../../shared/id'
import type { ExtractedWorkflow } from '../../shared/telemetry/schema'
import {
  applyEditorIntentToOps,
  collapseRedundantBrowserNav,
  ensureCreateRenameFromEvidence,
  injectClickOpsFromEvidence,
  injectKeystrokeOpsFromEvidence,
  injectScrollOpsFromEvidence,
  injectTypeTextOpsFromEvidence,
  preferClickAtWhenGrounded,
  recoverInferredActions,
  rewriteCreateSheetClicks
} from '../telemetry/automation/compile'
import { compileSessionAutomation } from '../telemetry/automation/compileSession'
import { syncEditorStepsToStoredWorkflow } from '../telemetry/automation/syncEditorSteps'
import { getTelemetryConfig, getTelemetryRecorder, getTelemetryStore } from '../telemetry'
import { JxaActuator } from './JxaActuator'
import { AutomationRunner } from './runner'
import type { RunEvent, RunnerControl } from './types'

let activeRunner: AutomationRunner | null = null
let activeRunId: string | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function emitRunEvent(event: RunEvent): void {
  broadcast('run:event', event)
}

export function registerAutomationIpc(): void {
  ipcMain.handle(
    'automation:runStart',
    async (
      _e,
      payload: {
        sessionId: string
        variables?: Record<string, string>
        /** Recompile if script is stale or missing. */
        recompileIfNeeded?: boolean
        /** Pill/workspace step titles — synced into ExtractedWorkflow before compile. */
        editorSteps?: Array<{ index: number; title: string }>
      }
    ) => {
      const store = getTelemetryStore()
      if (!store || !store.getAutomationScript) {
        return { ok: false, error: 'Telemetry not initialized', errorCode: 'SESSION_NOT_READY' }
      }
      const sessionId = payload?.sessionId
      if (!sessionId) {
        return { ok: false, error: 'sessionId required', errorCode: 'SESSION_NOT_READY' }
      }
      if (activeRunner?.isRunning()) {
        return {
          ok: false,
          error: 'A workflow is already running',
          errorCode: 'WORKFLOW_ALREADY_RUNNING'
        }
      }

      if (!JxaActuator.isAccessibilityTrusted(false)) {
        // Prompt once so the user can grant access.
        JxaActuator.isAccessibilityTrusted(true)
        return {
          ok: false,
          error: 'Accessibility permission is required to run automated workflows.',
          errorCode: 'AUTOMATION_ACCESSIBILITY_DENIED'
        }
      }

      const synced = await syncEditorStepsToStoredWorkflow(store, sessionId, payload.editorSteps)
      let script = await store.getAutomationScript(sessionId)
      const needsCompile =
        !script || !!script.stale || !!payload.recompileIfNeeded || synced.changed
      let storedWorkflow: ExtractedWorkflow | null =
        synced.workflow ?? (await store.getWorkflow(sessionId))?.workflow ?? null

      if (needsCompile) {
        const config = getTelemetryConfig()
        const clipboardByHash = getTelemetryRecorder()?.getClipboardSessionValues()
        const compiled = await compileSessionAutomation(store, config, sessionId, {
          clipboardByHash
        })
        if (!compiled.ok) {
          return {
            ok: false,
            error: compiled.error,
            errorCode: compiled.errorCode || 'AUTOMATION_COMPILE_FAILED'
          }
        }
        script = compiled.automation
        storedWorkflow =
          (await store.getWorkflow(sessionId))?.workflow ?? storedWorkflow
      } else if (script && storedWorkflow && store.saveAutomationScript) {
        // Deterministic recovery: replace leftover manuals with inferred open_url / Cmd+L
        // without paying for another LLM compile.
        const polished = await store.readPolishedSession(sessionId)
        if (polished) {
          const warnings: string[] = [...script.script.warnings]
          const byEvent = new Map<string, (typeof polished.actions)[number]>()
          for (const a of polished.actions) {
            for (const id of a.sourceEventIds) byEvent.set(id, a)
          }
          const recovered = collapseRedundantBrowserNav(
            ensureCreateRenameFromEvidence(
              rewriteCreateSheetClicks(
                injectKeystrokeOpsFromEvidence(
                  injectTypeTextOpsFromEvidence(
                    injectScrollOpsFromEvidence(
                      injectClickOpsFromEvidence(
                        preferClickAtWhenGrounded(
                          applyEditorIntentToOps(
                            recoverInferredActions(
                              script.script.ops,
                              storedWorkflow,
                              polished,
                              warnings
                            ),
                            storedWorkflow,
                            polished,
                            warnings
                          ),
                          polished,
                          byEvent,
                          warnings
                        ),
                        storedWorkflow,
                        polished,
                        warnings
                      ),
                      storedWorkflow,
                      polished,
                      warnings
                    ),
                    storedWorkflow,
                    polished,
                    warnings
                  ),
                  storedWorkflow,
                  polished,
                  warnings
                ),
                storedWorkflow,
                polished,
                warnings
              ),
              storedWorkflow,
              polished,
              warnings
            ),
            warnings
          )
          const changed =
            recovered.length !== script.script.ops.length ||
            recovered.some((op, i) => op.op !== script!.script.ops[i]?.op)
          if (changed) {
            script = await store.saveAutomationScript(
              sessionId,
              { ops: recovered, warnings: warnings.slice(0, 20) },
              script.model,
              { stale: false }
            )
          }
        }
      }

      if (!script) {
        return {
          ok: false,
          error: 'No automation script is available for this workflow yet.',
          errorCode: 'AUTOMATION_SCRIPT_MISSING'
        }
      }

      const runId = newId('run')
      activeRunId = runId
      const runner = new AutomationRunner({
        runId,
        sessionId,
        script: script.script,
        variables: payload.variables ?? {},
        onEvent: emitRunEvent
      })
      activeRunner = runner

      // Fire-and-forget — progress streams via run:event
      void runner.start().finally(() => {
        if (activeRunner === runner) {
          activeRunner = null
          activeRunId = null
        }
      })

      return {
        ok: true,
        runId,
        opCount: script.script.ops.length,
        sessionId
      }
    }
  )

  const control =
    (kind: RunnerControl['kind']) =>
    async (_e: unknown, extra?: { value?: string; variableKey?: string | null }) => {
      if (!activeRunner) return { ok: false, error: 'No active run' }
      if (kind === 'answer') {
        activeRunner.control({
          kind: 'answer',
          value: extra?.value ?? '',
          variableKey: extra?.variableKey
        })
      } else {
        activeRunner.control({ kind } as RunnerControl)
      }
      return { ok: true, runId: activeRunId }
    }

  ipcMain.handle('automation:runPause', control('pause'))
  ipcMain.handle('automation:runResume', control('resume'))
  ipcMain.handle('automation:runStop', control('stop'))
  ipcMain.handle('automation:runRetryStep', control('retry'))
  ipcMain.handle('automation:runSkipStep', control('skip'))
  ipcMain.handle('automation:runTakeOver', control('takeOver'))
  ipcMain.handle(
    'automation:runAnswer',
    async (_e, payload: { value: string; variableKey?: string | null }) =>
      control('answer')(_e, payload)
  )

  ipcMain.handle('automation:runStatus', () => ({
    running: !!activeRunner?.isRunning(),
    runId: activeRunId
  }))
}

export function stopActiveAutomationRun(): void {
  if (activeRunner) {
    activeRunner.control({ kind: 'stop' })
  }
}
