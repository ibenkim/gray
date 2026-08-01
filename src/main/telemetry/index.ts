import { BrowserWindow, ipcMain, systemPreferences } from 'electron'
import type { TelemetryEvent } from '../../shared/telemetry/schema'
import { getSnapshot } from '../store'
import { JxaAccessibilityProvider } from './ax/JxaAccessibilityProvider'
import { TelemetryRecorder, type CaptureOptions, type RecordingStatus } from './capture'
import { ClipboardWatcher } from './clipboard'
import { loadTelemetryConfig, type TelemetryConfig } from './config'
import { userMessageForCode } from './errors'
import { SparseKeyframeProvider } from './keyframes'
import { compileSessionAutomation } from './automation/compileSession'
import { processSessionWorkflow } from './processSession'
import { createTelemetryStore, type TelemetryStore } from './store'

const MAX_EVENTS_BODY = 200
const MAX_BODY_BYTES = 512_000

let config: TelemetryConfig
let store: TelemetryStore | null = null
let recorder: TelemetryRecorder | null = null

export function getTelemetryRecorder(): TelemetryRecorder | null {
  return recorder
}

export function getTelemetryStore(): TelemetryStore | null {
  return store
}

export function getTelemetryConfig(): TelemetryConfig {
  return config
}

function isAccessibilityTrusted(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    return systemPreferences.isTrustedAccessibilityClient(false)
  } catch {
    return false
  }
}

export async function initTelemetry(): Promise<void> {
  config = loadTelemetryConfig()
  try {
    store = createTelemetryStore(config)
    if (store) {
      await store.ensureReady()
      console.log(
        `[telemetry] ready — storage=${config.storage} dir=${config.devDir}` +
          (config.openaiApiKey ? ' openai=configured' : ' openai=missing')
      )
      if (!config.openaiApiKey) {
        console.warn(
          '[telemetry] OPENAI_API_KEY missing or invalid. Capture/polish work; summarization will fail until you set a real key in .env and restart the app.'
        )
      }
    } else {
      console.warn(
        '[telemetry] storage disabled (TELEMETRY_STORAGE not file). Recording will not persist.'
      )
    }
  } catch (err) {
    console.error('[telemetry] init failed', err instanceof Error ? err.message : err)
    store = null
  }

  const interaction =
    process.platform === 'darwin'
      ? new JxaAccessibilityProvider({ isAccessibilityTrusted })
      : undefined

  if (interaction) {
    // Clicks, typing and element labels all come from the Accessibility API, so
    // say so loudly at startup rather than recording a hollow session.
    console.log(
      `[telemetry] interaction capture — accessibility=${
        isAccessibilityTrusted() ? 'granted' : 'DENIED'
      }`
    )
    if (!isAccessibilityTrusted()) {
      console.warn(
        '[telemetry] Accessibility permission missing: recordings will only contain ' +
          'app switches, clipboard changes and a few shortcuts. Grant it in System ' +
          'Settings › Privacy & Security › Accessibility.'
      )
    }
  }
  const screenshot =
    store && typeof store.saveKeyframe === 'function' && typeof store.keyframesRoot === 'function'
      ? new SparseKeyframeProvider({
          rootDir: store.keyframesRoot(),
          saveKeyframe: (sessionId, eventId, jpeg) =>
            store!.saveKeyframe!(sessionId, eventId, jpeg)
        })
      : undefined

  recorder = new TelemetryRecorder(store, {
    interaction,
    screenshot,
    clipboard: new ClipboardWatcher()
  })

  recorder.onEvent((event) => {
    broadcast('telemetry:event', event)
  })
  recorder.onStatus((status) => {
    broadcast('telemetry:status', status)
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function requireSessionOwner(
  ownerEmail?: string
): { ok: true; email?: string } | { ok: false; error: string } {
  const session = getSnapshot().session
  if (!session) {
    if (ownerEmail) return { ok: false, error: 'Not authenticated' }
    return { ok: true }
  }
  if (ownerEmail && ownerEmail !== session.email) {
    return { ok: false, error: 'Session ownership mismatch' }
  }
  return { ok: true, email: session.email }
}

function estimateBytes(payload: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(payload), 'utf8')
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

function safeProcessResult(result: Awaited<ReturnType<typeof processSessionWorkflow>>) {
  if (result.ok) {
    return {
      ok: true as const,
      sessionId: result.sessionId,
      workflow: result.workflow,
      extracted: result.extracted,
      hasAutomation: !!result.automation,
      meta: {
        captureStatus: result.meta.captureStatus,
        processingStatus: result.meta.processingStatus
      }
    }
  }
  return {
    ok: false as const,
    sessionId: result.sessionId,
    error: result.error,
    errorCode: result.errorCode,
    meta: result.meta
      ? {
          captureStatus: result.meta.captureStatus,
          processingStatus: result.meta.processingStatus,
          processingErrorCode: result.meta.processingErrorCode
        }
      : undefined
  }
}

export function registerTelemetryIpc(): void {
  ipcMain.handle(
    'telemetry:sessionStart',
    async (_e, opts: CaptureOptions = {}) => {
      if (!recorder) return { ok: false, error: 'Telemetry not initialized' }
      const auth = requireSessionOwner(opts.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
      if (!store) {
        return { ok: false, error: 'Telemetry storage is not configured (TELEMETRY_STORAGE)' }
      }
      try {
        const status = await recorder.startRecording({
          ...opts,
          ownerEmail: auth.email ?? opts.ownerEmail,
          ignoreAppNames: opts.ignoreAppNames ?? ['ghost', 'Electron', 'yuh']
        })
        return { ok: true, status }
      } catch (err) {
        console.error('[telemetry] sessionStart failed')
        return { ok: false, error: 'Could not start recording' }
      }
    }
  )

  ipcMain.handle(
    'telemetry:events',
    async (_e, payload: { sessionId: string; events: TelemetryEvent[] }) => {
      if (!store || !recorder) return { ok: false, error: 'Telemetry not initialized' }
      if (!payload?.sessionId || !Array.isArray(payload.events)) {
        return { ok: false, error: 'Invalid body' }
      }
      if (payload.events.length > MAX_EVENTS_BODY || estimateBytes(payload) > MAX_BODY_BYTES) {
        return { ok: false, error: 'Body too large' }
      }
      const meta = await store.getSessionMeta(payload.sessionId)
      if (!meta) return { ok: false, error: 'Unknown session' }
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }

      try {
        const result = await store.appendEvents(payload.sessionId, payload.events)
        return { ok: true, result }
      } catch {
        return { ok: false, error: 'Failed to append events' }
      }
    }
  )

  // Stop capture, then polish + summarize (or discard).
  ipcMain.handle(
    'telemetry:sessionStop',
    async (_e, sessionIdOrOpts?: string | { sessionId?: string; discard?: boolean }) => {
      if (!recorder || !store) return { ok: false, error: 'Telemetry not initialized' }
      const opts =
        typeof sessionIdOrOpts === 'string'
          ? { sessionId: sessionIdOrOpts }
          : sessionIdOrOpts ?? {}
      const status = recorder.getRecordingStatus()
      const id = opts.sessionId || status.sessionId
      if (!id) return { ok: false, error: 'No active session' }

      const meta = await store.getSessionMeta(id)
      if (meta) {
        const auth = requireSessionOwner(meta.ownerEmail)
        if (!auth.ok) return { ok: false, error: auth.error }
      }

      try {
        if (opts.discard) {
          const { sessionId: stoppedId } = await recorder.stopRecording()
          if (stoppedId) {
            await store.updateSessionMeta(stoppedId, {
              captureStatus: 'stopped',
              processingStatus: 'not_started',
              processingErrorCode: null,
              stoppedAt: new Date().toISOString()
            })
          }
          return { ok: true, sessionId: stoppedId, discarded: true }
        }

        recorder.setProcessing(true)
        broadcast('telemetry:status', recorder.getRecordingStatus())

        const { sessionId: stoppedId } = await recorder.stopRecording()
        if (!stoppedId) {
          recorder.setProcessing(false)
          return { ok: false, error: 'Stop failed' }
        }

        await store.updateSessionMeta(stoppedId, {
          captureStatus: 'stopped',
          stoppedAt: new Date().toISOString()
        })

        const clipboardByHash = recorder.getClipboardSessionValues()
        const result = await processSessionWorkflow(store, config, stoppedId, {
          compileDeps: { clipboardByHash }
        })
        recorder.setProcessing(false)
        broadcast('telemetry:status', {
          ...recorder.getRecordingStatus(),
          processing: false,
          sessionId: stoppedId
        })

        if (result.ok) {
          broadcast('telemetry:workflowReady', {
            sessionId: stoppedId,
            workflow: result.workflow,
            extracted: result.extracted
          })
        }

        return safeProcessResult(result)
      } catch {
        recorder.setProcessing(false)
        if (id) {
          try {
            await store.updateSessionMeta(id, {
              captureStatus: 'stopped',
              processingStatus: 'failed',
              processingErrorCode: 'OPENAI_REQUEST_FAILED'
            })
          } catch {
            /* ignore */
          }
        }
        return {
          ok: false,
          sessionId: id,
          error: userMessageForCode('OPENAI_REQUEST_FAILED'),
          errorCode: 'OPENAI_REQUEST_FAILED'
        }
      }
    }
  )

  /** Retry polish/summarize without re-recording. */
  ipcMain.handle('telemetry:processWorkflow', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    // Reload config so a restarted process picks up env; in-process .env edits still need restart.
    config = loadTelemetryConfig()
    const meta = await store.getSessionMeta(sessionId)
    if (!meta) return { ok: false, error: 'Unknown session' }
    const auth = requireSessionOwner(meta.ownerEmail)
    if (!auth.ok) return { ok: false, error: auth.error }

    const result = await processSessionWorkflow(store, config, sessionId, {
      skipPolishIfPresent: true
    })
    if (result.ok) {
      broadcast('telemetry:workflowReady', {
        sessionId,
        workflow: result.workflow,
        extracted: result.extracted
      })
    }
    return safeProcessResult(result)
  })

  ipcMain.handle('telemetry:getWorkflow', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    const meta = await store.getSessionMeta(sessionId)
    if (meta) {
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
    }
    const result = await store.getWorkflow(sessionId)
    if (!result) return { ok: false, error: 'Workflow not found' }
    return { ok: true, result }
  })

  ipcMain.handle('telemetry:getStatus', () => {
    return (
      recorder?.getRecordingStatus() ??
      ({
        recording: false,
        sessionId: null,
        sequence: 0,
        startedAt: null,
        processing: false
      } satisfies RecordingStatus)
    )
  })

  /** Retry automation compile without re-extracting the workflow. */
  ipcMain.handle('automation:compile', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    config = loadTelemetryConfig()
    const meta = await store.getSessionMeta(sessionId)
    if (!meta) return { ok: false, error: 'Unknown session' }
    const auth = requireSessionOwner(meta.ownerEmail)
    if (!auth.ok) return { ok: false, error: auth.error }

    const result = await compileSessionAutomation(store, config, sessionId)
    if (result.ok) {
      broadcast('automation:compiled', {
        sessionId,
        opCount: result.automation.script.ops.length,
        stale: result.automation.stale ?? false
      })
    }
    return result.ok
      ? {
          ok: true as const,
          sessionId,
          opCount: result.automation.script.ops.length,
          stale: result.automation.stale ?? false
        }
      : {
          ok: false as const,
          sessionId,
          error: result.error,
          errorCode: result.errorCode
        }
  })

  ipcMain.handle('automation:getScript', async (_e, sessionId: string) => {
    if (!store) return { ok: false, error: 'Telemetry not initialized' }
    if (!sessionId) return { ok: false, error: 'sessionId required' }
    if (!store.getAutomationScript) return { ok: false, error: 'Automation store unavailable' }
    const meta = await store.getSessionMeta(sessionId)
    if (meta) {
      const auth = requireSessionOwner(meta.ownerEmail)
      if (!auth.ok) return { ok: false, error: auth.error }
    }
    const script = await store.getAutomationScript(sessionId)
    if (!script) return { ok: false, error: 'Script not found' }
    return { ok: true, script }
  })

  ipcMain.handle(
    'automation:markStale',
    async (
      _e,
      sessionId: string,
      stale = true,
      editorSteps?: Array<{ index: number; title: string }>
    ) => {
      if (!store) return { ok: false, error: 'Telemetry not initialized' }
      if (!sessionId) return { ok: false, error: 'sessionId required' }
      // Persist edited step titles immediately so the next compile cannot
      // still see the pre-edit ExtractedWorkflow.
      if (editorSteps?.length) {
        const { syncEditorStepsToStoredWorkflow } = await import(
          './automation/syncEditorSteps'
        )
        await syncEditorStepsToStoredWorkflow(store, sessionId, editorSteps)
      }
      if (!store.markAutomationStale) return { ok: false, error: 'Automation store unavailable' }
      const updated = await store.markAutomationStale(sessionId, stale)
      return updated
        ? { ok: true, stale: updated.stale ?? false }
        : { ok: false, error: 'Script not found' }
    }
  )
}

export async function flushTelemetryOnQuit(): Promise<void> {
  if (!recorder) return
  try {
    if (recorder.getRecordingStatus().recording) {
      await recorder.stopRecording()
    } else {
      await recorder.flush()
    }
  } catch (err) {
    console.error('[telemetry] quit flush failed')
  }
}
