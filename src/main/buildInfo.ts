import { app, ipcMain } from 'electron'
import { BUILD, stampLabel, type BuildStamp } from '../shared/build'

export { BUILD }

/** Short identity for the tray, e.g. `Gray 0.1.0 · bb6969e+dirty · dev`. */
export function buildLabel(): string {
  return `Gray ${BUILD.version} · ${BUILD.sha.slice(0, 7)}${BUILD.dirty ? '+dirty' : ''} · ${app.isPackaged ? 'packaged' : 'dev'}`
}

/** A URL without credentials, query or fragment; never echoes malformed input. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return '<invalid URL>'
  }
}

/** Local developer diagnostics only: what this process actually loaded. No env values. */
export function runtimeIdentity(): string {
  const renderer = process.env['ELECTRON_RENDERER_URL']
  return [
    `[gray] ${buildLabel()} built ${BUILD.builtAt || 'unknown'}`,
    `main=${__filename}`,
    `renderer=${renderer ? safeUrl(renderer) : 'out/renderer/index.html'}`,
    `exec=${process.execPath}`,
    `appPath=${app.getAppPath()}`,
    `cwd=${process.cwd()}`,
    `userData=${app.getPath('userData')}`,
    `pid=${process.pid}`
  ].join(' ')
}

function isStamp(v: unknown): v is BuildStamp {
  const s = v as BuildStamp
  return !!s && typeof s.sha === 'string' && typeof s.dirty === 'boolean' && typeof s.builtAt === 'string'
}

/** Preload and renderer report their own build stamp; main logs each once and whether it matches. */
export function registerBuildReports(): void {
  const seen = new Set<string>()
  ipcMain.on('build:report', (_e, entry: unknown, stamp: unknown) => {
    if (entry !== 'preload' && entry !== 'renderer') return
    const key = `${entry}:${JSON.stringify(stamp)}`
    if (seen.has(key)) return
    seen.add(key)
    if (!isStamp(stamp)) {
      console.log(`[gray] ${entry} is unstamped`)
      return
    }
    const same = stamp.sha === BUILD.sha && stamp.dirty === BUILD.dirty && stamp.builtAt === BUILD.builtAt
    console.log(`[gray] ${entry} ${same ? 'matches main' : 'DIFFERS from main'}: ${stampLabel(stamp)}`)
  })
}
