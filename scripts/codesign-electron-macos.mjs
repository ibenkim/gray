#!/usr/bin/env node
/**
 * macOS AMFI rejects some Electron downloads with "Unrecoverable CT signature
 * issue" / ASP "Security policy would not allow process". Ad-hoc re-sign after
 * install restores a launchable binary for local `npm run dev`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const appPath = join(root, 'node_modules/electron/dist/Electron.app')
if (!existsSync(appPath)) {
  console.warn('[codesign-electron] Electron.app missing — skip')
  process.exit(0)
}

try {
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit'
  })
  console.log('[codesign-electron] ad-hoc signed', appPath)
} catch (err) {
  console.warn(
    '[codesign-electron] failed:',
    err instanceof Error ? err.message : err
  )
}
