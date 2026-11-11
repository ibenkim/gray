import { ipcMain } from 'electron'
import { runContractRequired } from '../telemetry/errors'

export function registerAutomationIpc(): void {
  // M5 hold: a live run needs a main-owned reviewed run contract (M12/M13). None exists in
  // this build, so every start is refused before any side effect (sync, recovery, compile,
  // accessibility prompt, actuator), whatever the payload claims.
  ipcMain.handle('automation:runStart', (_e, payload?: { sessionId?: string }) =>
    runContractRequired(payload?.sessionId)
  )

  const noRun = () => ({ ok: false, error: 'No active run' })
  for (const channel of [
    'automation:runPause',
    'automation:runResume',
    'automation:runStop',
    'automation:runRetryStep',
    'automation:runSkipStep',
    'automation:runTakeOver',
    'automation:runAnswer'
  ]) {
    ipcMain.handle(channel, noRun)
  }
  ipcMain.handle('automation:runStatus', () => ({ running: false, runId: null }))
}
