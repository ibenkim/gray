import { config as loadDotenv } from 'dotenv'
import { app } from 'electron'
import { isAbsolute, resolve } from 'path'
import { normalizeOpenAiApiKey } from './openaiKey'

export type TelemetryStorageKind = 'file' | 'none'

export type TelemetryConfig = {
  storage: TelemetryStorageKind
  devDir: string
  openaiApiKey: string | null
  openaiModel: string
  isDev: boolean
  isPackaged: boolean
}

export { normalizeOpenAiApiKey } from './openaiKey'

function parseStorage(raw: string | undefined, isDev: boolean): TelemetryStorageKind {
  if (raw === 'file') return 'file'
  if (raw === 'none') return 'none'
  if (!raw) {
    // Dev defaults to file so a fresh clone records without requiring .env.
    // Packaged apps must never fall through to file storage.
    return isDev ? 'file' : 'none'
  }
  console.warn(`[telemetry] unknown TELEMETRY_STORAGE=${raw}; using none`)
  return 'none'
}

let dotenvLoaded = false

/** Idempotent — safe if main/index already loaded .env. */
export function ensureDotenv(): void {
  if (dotenvLoaded) return
  loadDotenv({ path: resolve(process.cwd(), '.env') })
  dotenvLoaded = true
}

/**
 * Validate and load telemetry-related env. File storage is refused unless
 * the app is unpackaged (development). Production must use a real adapter.
 *
 * After changing OPENAI_* or TELEMETRY_* in `.env`, restart the Electron main process.
 */
export function loadTelemetryConfig(): TelemetryConfig {
  ensureDotenv()
  const isPackaged = app.isPackaged
  const isDev = !isPackaged
  const storage = parseStorage(process.env.TELEMETRY_STORAGE, isDev)
  const rawDir = process.env.TELEMETRY_DEV_DIR || './development-data/telemetry'
  const devDir = isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir)

  return {
    storage,
    devDir,
    openaiApiKey: normalizeOpenAiApiKey(process.env.OPENAI_API_KEY),
    openaiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-5.6-luna',
    isDev,
    isPackaged
  }
}
