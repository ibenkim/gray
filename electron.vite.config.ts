import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = {
  '@shared': resolve('src/shared')
}

/** M4: identity of the checkout this build was made from, stamped into every entry. */
function git(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
const buildIdentity = {
  version: (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version,
  sha: git('git rev-parse HEAD') || 'unknown',
  dirty: git('git status --porcelain') !== '',
  builtAt: new Date().toISOString()
}
const stamp = { __GRAY_BUILD__: JSON.stringify(buildIdentity) }

export default defineConfig({
  main: {
    define: stamp,
    resolve: { alias: sharedAlias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    define: stamp,
    resolve: { alias: sharedAlias },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    define: stamp,
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        ...sharedAlias
      }
    },
    plugins: [react()]
  }
})
