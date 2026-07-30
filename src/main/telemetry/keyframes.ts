import { createHash } from 'crypto'
import { desktopCapturer, nativeImage, screen } from 'electron'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import type { KeyframeReason, ScreenshotProvider } from './providers'

const MAX_EDGE = 1440
const JPEG_QUALITY = 70
const MIN_INTERVAL_MS = 1000
const DEDUPE_SIZE = 64

export type KeyframeBounds = { x: number; y: number; width: number; height: number }

export type KeyframeCaptureOpts = {
  reason?: KeyframeReason
  bounds?: KeyframeBounds
  sessionId?: string
  eventId?: string
}

export type KeyframeStore = {
  /** Absolute root for keyframes, e.g. development-data/telemetry/keyframes */
  rootDir: string
  saveKeyframe?(
    sessionId: string,
    eventId: string,
    jpeg: Buffer
  ): Promise<{ absolutePath: string; relativePath: string }>
}

/**
 * Sparse active-window keyframe capturer.
 * Rate-limited to 1/s, dedupes visually identical frames, never embeds base64.
 * Vision upload is deferred — frames are local audit artifacts only.
 */
export class SparseKeyframeProvider implements ScreenshotProvider {
  readonly enabled = true
  private lastCaptureAt = 0
  private lastDedupeHash: string | null = null
  private capturing = false

  constructor(private readonly store: KeyframeStore) {}

  async captureKeyframe(
    _screenStateId: string,
    opts: KeyframeCaptureOpts = {}
  ): Promise<{ path?: string; relativePath?: string } | null> {
    if (this.capturing) return null
    const now = Date.now()
    if (now - this.lastCaptureAt < MIN_INTERVAL_MS) return null
    if (!opts.sessionId || !opts.eventId) return null

    this.capturing = true
    this.lastCaptureAt = now
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: fullDisplaySize()
      })
      if (!sources.length) return null
      const source = sources[0]
      let image = source.thumbnail
      if (image.isEmpty()) return null

      if (opts.bounds && opts.bounds.width > 0 && opts.bounds.height > 0) {
        const display = screen.getPrimaryDisplay()
        const scale = display.scaleFactor || 1
        const crop = {
          x: Math.max(0, Math.round(opts.bounds.x * scale)),
          y: Math.max(0, Math.round(opts.bounds.y * scale)),
          width: Math.round(opts.bounds.width * scale),
          height: Math.round(opts.bounds.height * scale)
        }
        const size = image.getSize()
        if (
          crop.x + crop.width <= size.width &&
          crop.y + crop.height <= size.height &&
          crop.width > 8 &&
          crop.height > 8
        ) {
          image = image.crop(crop)
        }
      }

      image = resizeLongestEdge(image, MAX_EDGE)

      const dedupe = createHash('sha256')
        .update(image.resize({ width: DEDUPE_SIZE, height: DEDUPE_SIZE }).toJPEG(40))
        .digest('hex')
        .slice(0, 16)
      if (dedupe === this.lastDedupeHash) return null
      this.lastDedupeHash = dedupe

      const jpeg = image.toJPEG(JPEG_QUALITY)
      if (this.store.saveKeyframe) {
        const saved = await this.store.saveKeyframe(opts.sessionId, opts.eventId, Buffer.from(jpeg))
        return { path: saved.absolutePath, relativePath: saved.relativePath }
      }

      const relativePath = join(opts.sessionId, `${opts.eventId}.jpg`)
      const absolutePath = resolve(this.store.rootDir, relativePath)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, jpeg)
      return { path: absolutePath, relativePath: relativePath.replace(/\\/g, '/') }
    } catch (err) {
      console.error(
        '[telemetry/keyframes] capture failed',
        err instanceof Error ? err.name : 'error'
      )
      return null
    } finally {
      this.capturing = false
    }
  }

  reset(): void {
    this.lastCaptureAt = 0
    this.lastDedupeHash = null
  }
}

function fullDisplaySize(): { width: number; height: number } {
  try {
    const d = screen.getPrimaryDisplay()
    const scale = d.scaleFactor || 1
    return {
      width: Math.round(d.size.width * scale),
      height: Math.round(d.size.height * scale)
    }
  } catch {
    return { width: 1920, height: 1080 }
  }
}

function resizeLongestEdge(
  image: Electron.NativeImage,
  maxEdge: number
): Electron.NativeImage {
  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return image
  const scale = maxEdge / longest
  return image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale)
  })
}

/** Pure helper for tests — relative path under keyframes root. */
export function keyframeRelativePath(sessionId: string, eventId: string): string {
  return `${sessionId}/${eventId}.jpg`
}

export function assertRelativeKeyframePath(path: string, rootDir: string): string {
  if (path.includes('..') || path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) {
    throw new Error('[telemetry/keyframes] absolute or traversal path rejected')
  }
  const abs = resolve(rootDir, path)
  const root = resolve(rootDir)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || rel.includes('..')) {
    throw new Error('[telemetry/keyframes] path escaped root')
  }
  return abs
}

// Keep nativeImage import used for type narrowing in older Electron typings.
void nativeImage
