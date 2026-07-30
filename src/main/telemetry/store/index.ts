import type { TelemetryConfig } from '../config'
import { FileTelemetryStore } from './FileTelemetryStore'
import type { TelemetryStore } from './TelemetryStore'

export type {
  TelemetryStore,
  CreateSessionInput,
  AppendEventsResult,
  SessionMetaPatch
} from './TelemetryStore'
export { FileTelemetryStore } from './FileTelemetryStore'

/**
 * Create a telemetry store from config.
 * Never silently falls back to local files in production.
 */
export function createTelemetryStore(config: TelemetryConfig): TelemetryStore | null {
  if (config.storage === 'none') return null

  if (config.storage === 'file') {
    if (config.isPackaged || !config.isDev) {
      throw new Error(
        '[telemetry] TELEMETRY_STORAGE=file is not allowed in production. ' +
          'Use a production TelemetryStore adapter instead.'
      )
    }
    return new FileTelemetryStore(config.devDir, {
      isPackaged: config.isPackaged,
      isDev: config.isDev
    })
  }

  throw new Error(`[telemetry] unsupported TELEMETRY_STORAGE`)
}
