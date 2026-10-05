import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { normalizeSessionMeta } from '../../shared/telemetry/schema'

describe('renderer / preload isolation', () => {
  it('does not expose OPENAI_API_KEY through preload bridge source', () => {
    const preload = readFileSync(resolve(__dirname, '../../preload/index.ts'), 'utf8')
    expect(preload).not.toMatch(/OPENAI_API_KEY/)
    expect(preload).not.toMatch(/process\.env/)
  })

  it('does not expose OPENAI_API_KEY through renderer env.d.ts', () => {
    const envDts = readFileSync(resolve(__dirname, '../../renderer/src/env.d.ts'), 'utf8')
    expect(envDts).not.toMatch(/OPENAI_API_KEY/)
    expect(envDts).not.toMatch(/VITE_OPENAI/)
  })
})

describe('normalizeSessionMeta', () => {
  it('maps legacy failed status to stopped capture + failed processing without keeping raw error', () => {
    const meta = normalizeSessionMeta({
      sessionId: 'tsess_x',
      startedAt: '2026-07-29T04:28:43.153Z',
      stoppedAt: '2026-07-29T04:28:48.451Z',
      status: 'failed',
      schemaVersion: 1,
      error: '401 Incorrect API key provided: sk-abcdefghijklmnopqrstuvwxyz'
    })
    expect(meta?.captureStatus).toBe('stopped')
    expect(meta?.processingStatus).toBe('failed')
    expect(meta?.error).toBeUndefined()
    expect(JSON.stringify(meta)).not.toMatch(/sk-/)
  })
})

describe('screenshot availability is never a forged claim (M3-A)', () => {
  it('normalization keeps only the trusted values; absent, malformed and stripped stay unknown', () => {
    const base = { sessionId: 'tsess_s', startedAt: '2026-07-29T04:28:43.153Z', captureStatus: 'stopped', processingStatus: 'not_started', schemaVersion: 1 }
    expect(normalizeSessionMeta({ ...base, screenshotCapture: 'disabled_privacy' })?.screenshotCapture).toBe('disabled_privacy')
    expect(normalizeSessionMeta(base)?.screenshotCapture).toBeUndefined()
    for (const bad of ['available', 'redacted', true, { v: 1 }, 'DISABLED_PRIVACY']) {
      const meta = normalizeSessionMeta({ ...base, screenshotCapture: bad })
      expect(meta).not.toBeNull()
      expect(meta?.screenshotCapture).toBe('unknown')
    }
  })

  it('the recorder stamps disabled_privacy only from the trusted disabled provider, never from a start payload', () => {
    const capture = readFileSync(resolve(__dirname, 'capture.ts'), 'utf8')
    expect(capture).toMatch(/screenshotCapture: this\.screenshotCaptureStatus\(\)/)
    expect(capture).not.toMatch(/screenshotCapture: opts\./)
    const index = readFileSync(resolve(__dirname, 'index.ts'), 'utf8')
    expect(index).toMatch(/screenshot: new DisabledScreenshotProvider\(\)/)
    expect(index).not.toMatch(/SparseKeyframeProvider|desktopCapturer/)
  })
})
