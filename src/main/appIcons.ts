import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, nativeImage } from 'electron'

/**
 * The installed apps' own icons for the Record dropdown's app rows (Figma Workflow Container:
 * a 30 × 30 slot per app). Only known ids map to bundle names, so the renderer can never name a
 * path. Results are cached for the session; an app that isn't installed has no entry, and the row
 * falls back to its bundled logo.
 */
const BUNDLES: Record<string, string[]> = {
  chrome: ['Google Chrome.app'],
  figma: ['Figma.app'],
  slack: ['Slack.app'],
  notion: ['Notion.app']
}

/** Twice the 30 px slot, so the icon stays crisp on Retina. */
const ICON_PX = 60
const MAX_IDS = 12

const cache = new Map<string, string | null>()

function bundlePath(id: string): string | null {
  const names = BUNDLES[id]
  if (!names) return null
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of names) {
      const p = join(dir, name)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function iconFor(id: string): Promise<string | null> {
  if (cache.has(id)) return cache.get(id) ?? null
  const path = bundlePath(id)
  let url: string | null = null
  if (path) {
    try {
      // Quick Look renders an .app bundle as its icon at any size (macOS).
      const thumb = await nativeImage.createThumbnailFromPath(path, { width: ICON_PX, height: ICON_PX })
      if (!thumb.isEmpty()) url = thumb.toDataURL()
    } catch {
      // Fall through to the file icon.
    }
    if (!url) {
      try {
        const icon = await app.getFileIcon(path, { size: 'normal' })
        if (!icon.isEmpty()) url = icon.toDataURL()
      } catch {
        url = null
      }
    }
  }
  cache.set(id, url)
  return url
}

/** Data URLs keyed by app id, for the ids that are installed. Unknown ids are ignored. */
export async function appIconDataUrls(raw: unknown): Promise<Record<string, string>> {
  if (!Array.isArray(raw)) return {}
  const ids = [...new Set(raw.filter((v): v is string => typeof v === 'string' && v in BUNDLES))].slice(0, MAX_IDS)
  const out: Record<string, string> = {}
  for (const id of ids) {
    const url = await iconFor(id)
    if (url) out[id] = url
  }
  return out
}
