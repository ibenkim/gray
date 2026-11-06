import { execFile } from 'child_process'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { promisify } from 'util'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const run = promisify(execFile)

/**
 * Design gallery (dev only): serves the real renderer components in a plain browser with a
 * mock bridge, one scenario per screen, so every interface can be compared with Figma.
 * Never part of the Electron build (electron-vite only bundles src/renderer/index.html).
 *
 *   npx vite --config vite.gallery.config.ts
 */
function modulesRoot(): string {
  let dir = __dirname
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'node_modules/@fontsource/inter'))) return resolve(dir, 'node_modules')
    dir = dirname(dir)
  }
  return resolve(__dirname, 'node_modules')
}

/**
 * GET /__app-icon/<id> — the installed app's own icon as a 60 px PNG, so the gallery's Record
 * dropdown shows what the Electron build gets from the system (src/main/appIcons.ts). Known ids
 * only; 404 when the app isn't installed. macOS dev machines only.
 */
const APP_BUNDLES: Record<string, string> = {
  chrome: 'Google Chrome.app',
  figma: 'Figma.app',
  slack: 'Slack.app',
  notion: 'Notion.app'
}
function appIconRoute(): Plugin {
  const cache = new Map<string, Buffer | null>()
  let out = ''
  async function iconPng(id: string): Promise<Buffer | null> {
    if (cache.has(id)) return cache.get(id) ?? null
    let png: Buffer | null = null
    const app = join('/Applications', APP_BUNDLES[id])
    try {
      const { stdout } = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', join(app, 'Contents/Info.plist')])
      const name = stdout.trim()
      const icns = join(app, 'Contents/Resources', name.endsWith('.icns') ? name : `${name}.icns`)
      out ||= mkdtempSync(join(tmpdir(), 'gray-gallery-icons-'))
      const file = join(out, `${id}.png`)
      await run('sips', ['-s', 'format', 'png', '-Z', '60', icns, '--out', file])
      png = readFileSync(file)
    } catch {
      png = null
    }
    cache.set(id, png)
    return png
  }
  return {
    name: 'gallery-app-icons',
    configureServer(server) {
      server.middlewares.use('/__app-icon', (req, res) => {
        const id = (req.url ?? '').replace(/^\//, '').replace(/\?.*$/, '')
        if (!(id in APP_BUNDLES)) {
          res.statusCode = 404
          return res.end()
        }
        void iconPng(id).then((png) => {
          if (!png) {
            res.statusCode = 404
            return res.end()
          }
          res.setHeader('Content-Type', 'image/png')
          res.setHeader('Cache-Control', 'max-age=3600')
          res.end(png)
        })
      })
    }
  }
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react(), appIconRoute()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    port: 5199,
    strictPort: true,
    // In a worktree, packages resolve from the main checkout's node_modules: allow it too.
    fs: { allow: [resolve(__dirname), modulesRoot()] }
  },
  build: {
    outDir: resolve(__dirname, 'out/gallery'),
    rollupOptions: { input: resolve(__dirname, 'src/renderer/gallery.html') }
  }
})
