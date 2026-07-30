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
