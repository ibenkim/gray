import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, type AutomationScript } from '../../../shared/telemetry/schema'
import { FileTelemetryStore } from './FileTelemetryStore'
import { InMemoryTelemetryStore } from './InMemoryTelemetryStore'

const script: AutomationScript = {
  ops: [
    {
      op: 'open_app',
      stepOrder: 1,
      evidenceEventIds: ['tevt_1'],
      confidence: 0.9,
      timeoutMs: 10000,
      label: 'Open Terminal',
      appName: 'Terminal',
      appBundleId: null,
      url: null,
      urlVariableKey: null,
      elementRole: null,
      elementLabel: null,
      elementPath: null,
      chord: null,
      variableKey: null,
      literalText: null,
      waitCondition: null,
      waitValue: null,
      prompt: null,
      clickX: null,
      clickY: null,
    }
  ],
  warnings: []
}

describe('InMemoryTelemetryStore automation', () => {
  it('saves, reads, and marks stale', async () => {
    const store = new InMemoryTelemetryStore()
    const saved = await store.saveAutomationScript('tsess_a', script, 'gpt-test')
    expect(saved.schemaVersion).toBe(SCHEMA_VERSION)
    expect(saved.stale).toBe(false)

    const got = await store.getAutomationScript('tsess_a')
    expect(got?.script.ops[0].appName).toBe('Terminal')

    const stale = await store.markAutomationStale('tsess_a', true)
    expect(stale?.stale).toBe(true)
  })
})

describe('FileTelemetryStore automation', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('persists automation/<sessionId>.json', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghost-auto-'))
    const store = new FileTelemetryStore(dir, { isPackaged: false, isDev: true })
    await store.ensureReady()
    await store.createSession({ sessionId: 'tsess_file' })

    await store.saveAutomationScript('tsess_file', script, 'gpt-test')
    const got = await store.getAutomationScript('tsess_file')
    expect(got?.sessionId).toBe('tsess_file')
    expect(got?.script.ops).toHaveLength(1)

    await store.markAutomationStale('tsess_file', true)
    const again = await store.getAutomationScript('tsess_file')
    expect(again?.stale).toBe(true)
  })
})
