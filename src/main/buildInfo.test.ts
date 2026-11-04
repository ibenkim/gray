import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => void>(), packaged: false }))
vi.mock('electron', () => ({
  app: { get isPackaged() { return h.packaged }, getPath: () => '/synthetic/userData', getAppPath: () => '/synthetic/app' },
  ipcMain: { on: (c: string, fn: (...a: unknown[]) => void) => h.handlers.set(c, fn) }
}))

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env['ELECTRON_RENDERER_URL']
})

describe('M4 build identity', () => {
  it('never logs renderer URL credentials, query, fragment or malformed input (M4-R3)', async () => {
    const { safeUrl, runtimeIdentity } = await import('./buildInfo')
    expect(safeUrl('http://synthetic-user:synthetic-pass@localhost:5173/path?token=synthetic-token#frag')).toBe('http://localhost:5173/path')
    expect(safeUrl('not a url synthetic-secret')).toBe('<invalid URL>')
    process.env['ELECTRON_RENDERER_URL'] = 'http://synthetic-user:synthetic-pass@localhost:5173/?token=synthetic-token'
    const line = runtimeIdentity()
    expect(line).toContain('renderer=http://localhost:5173/')
    expect(line).not.toMatch(/synthetic-(user|pass|token)/)
    expect(line).toMatch(/exec=.+ appPath=\/synthetic\/app cwd=.+ userData=\/synthetic\/userData pid=\d+/)
  })

  it('logs once per preload/renderer stamp whether it matches main (M4-R2)', async () => {
    const { BUILD, registerBuildReports } = await import('./buildInfo')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    registerBuildReports()
    const report = h.handlers.get('build:report')!
    report({}, 'preload', BUILD)
    report({}, 'preload', BUILD) // same stamp again: logged once
    report({}, 'renderer', { ...BUILD, builtAt: '2000-01-01T00:00:00.000Z' })
    report({}, 'renderer', 'garbage')
    report({}, 'other', BUILD)
    expect(log.mock.calls.map((c) => String(c[0]).replace(/: .*/, ''))).toEqual([
      '[gray] preload matches main',
      '[gray] renderer DIFFERS from main',
      '[gray] renderer is unstamped'
    ])
  })
})

describe('M4 isolated profile storage (M4-R1)', () => {
  afterEach(() => {
    delete process.env['GRAY_USER_DATA_DIR']
  })
  it('keeps recordings inside GRAY_USER_DATA_DIR, never the shared telemetry folder', async () => {
    process.env['GRAY_USER_DATA_DIR'] = '/tmp/synthetic-profile'
    process.env['TELEMETRY_DEV_DIR'] = '/tmp/synthetic-shared-telemetry'
    const { loadTelemetryConfig } = await import('./telemetry/config')
    expect(loadTelemetryConfig().devDir).toBe('/tmp/synthetic-profile/telemetry')
    delete process.env['GRAY_USER_DATA_DIR']
    expect(loadTelemetryConfig().devDir).toBe('/tmp/synthetic-shared-telemetry')
    delete process.env['TELEMETRY_DEV_DIR']
  })
})
