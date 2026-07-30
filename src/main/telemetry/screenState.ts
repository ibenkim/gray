import { createHash } from 'crypto'
import { sanitizeLabel, sanitizeUrl, sanitizeWindowTitle } from '../../shared/telemetry/sanitize'
import type { ScreenshotProvider } from './providers'

export type ScreenStateSnapshot = {
  screenStateId: string
  appName?: string
  appBundleId?: string
  page?: string
  route?: string
  windowTitle?: string
  urlHost?: string
  urlPath?: string
  headings: string[]
  buttons: string[]
  dialogs: string[]
  loading: boolean
  errorState?: string
  successMessage?: string
}

export type ActiveWindowInfo = {
  title?: string
  owner?: { name?: string; bundleId?: string }
  url?: string
  bounds?: { width?: number; height?: number }
}

/**
 * Build a compact sanitized screen state from the frontmost window.
 * Deduplicates identical states via hash. No continuous screenshots.
 */
export class ScreenStateTracker {
  private lastId: string | null = null
  private screenshot: ScreenshotProvider

  constructor(screenshot: ScreenshotProvider) {
    this.screenshot = screenshot
  }

  fromActiveWindow(win: ActiveWindowInfo | null | undefined): ScreenStateSnapshot | null {
    if (!win) return null
    const windowTitle = sanitizeWindowTitle(win.title)
    const appName = sanitizeLabel(win.owner?.name)
    const appBundleId = sanitizeLabel(win.owner?.bundleId)
    const { urlHost, urlPath } = sanitizeUrl(win.url)
    const page = windowTitle ?? appName
    const route = [appName, windowTitle].filter(Boolean).join(' · ') || undefined

    const payload = {
      appName,
      appBundleId,
      page,
      route,
      windowTitle,
      urlHost,
      urlPath,
      headings: [] as string[],
      buttons: [] as string[],
      dialogs: [] as string[],
      loading: false
    }

    const hash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
      .slice(0, 16)
    const screenStateId = `ss_${hash}`

    if (screenStateId === this.lastId) return null
    this.lastId = screenStateId

    // Screenshot provider is disabled by default — never embeds base64.
    if (this.screenshot.enabled) {
      void this.screenshot.captureKeyframe(screenStateId)
    }

    return { screenStateId, ...payload }
  }

  reset(): void {
    this.lastId = null
  }
}
