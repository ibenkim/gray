import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'fs'
import { dirname, resolve, sep } from 'path'
import {
  SCHEMA_VERSION,
  SessionIdSchema,
  StoredAutomationScriptSchema,
  StoredVariablesSchema,
  StoredWorkflowResultSchema,
  TelemetryEventSchema,
  PolishedSessionSchema,
  normalizeSessionMeta,
  type AutomationScript,
  type ExtractedWorkflow,
  type PolishedSession,
  type StoredAutomationScript,
  type StoredVariables,
  type StoredWorkflowResult,
  type TelemetryEvent,
  type TelemetrySessionMeta,
  type WorkflowVariable
} from '../../../shared/telemetry/schema'
import { redactEvent, shouldDropEvent } from '../../../shared/telemetry/sanitize'
import type {
  AppendEventsResult,
  CreateSessionInput,
  SessionMetaPatch,
  TelemetryStore
} from './TelemetryStore'

type Envelope = {
  schemaVersion: typeof SCHEMA_VERSION
  receivedAt: string
  event: TelemetryEvent
}

/**
 * Development-only file adapter. Refuses to initialize when the app is packaged.
 * Writes sanitized JSONL under development-data/telemetry/.
 */
export class FileTelemetryStore implements TelemetryStore {
  private readonly root: string
  private readonly appendLocks = new Map<string, Promise<void>>()
  private ready = false

  constructor(
    rootDir: string,
    private readonly opts: { isPackaged: boolean; isDev: boolean }
  ) {
    this.root = resolve(rootDir)
  }

  async ensureReady(): Promise<void> {
    if (this.opts.isPackaged || !this.opts.isDev) {
      throw new Error(
        '[telemetry] FileTelemetryStore cannot run in production. ' +
          'Set TELEMETRY_STORAGE=none and use a production adapter.'
      )
    }
    if (this.ready) return
    try {
      mkdirSync(this.subdir('normalized'), { recursive: true })
      mkdirSync(this.subdir('polished'), { recursive: true })
      mkdirSync(this.subdir('workflows'), { recursive: true })
      mkdirSync(this.subdir('meta'), { recursive: true })
      mkdirSync(this.subdir('variables'), { recursive: true })
      mkdirSync(this.subdir('automation'), { recursive: true })
      mkdirSync(this.subdir('keyframes'), { recursive: true })
      this.ready = true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[telemetry] cannot create development telemetry dirs: ${msg}`)
    }
  }

  async createSession(input: CreateSessionInput): Promise<TelemetrySessionMeta> {
    await this.ensureReady()
    const sessionId = this.assertSessionId(input.sessionId)
    const existing = await this.getSessionMeta(sessionId)
    if (existing) {
      return existing
    }
    const meta: TelemetrySessionMeta = {
      sessionId,
      ownerEmail: input.ownerEmail,
      startedAt: new Date().toISOString(),
      captureStatus: 'recording',
      processingStatus: 'not_started',
      schemaVersion: SCHEMA_VERSION,
      recordMode: input.recordMode,
      selectedAppId: input.selectedAppId
    }
    this.writeJson(this.metaPath(sessionId), meta)
    const nPath = this.normalizedPath(sessionId)
    if (!existsSync(nPath)) {
      writeFileSync(nPath, '', 'utf8')
    }
    return meta
  }

  async appendEvents(sessionId: string, events: TelemetryEvent[]): Promise<AppendEventsResult> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const meta = await this.getSessionMeta(id)
    if (!meta) {
      throw new Error(`[telemetry] unknown session ${id}`)
    }

    const seen = await this.loadEventIds(id)
    let accepted = 0
    let duplicates = 0
    let rejected = 0
    const lines: string[] = []
    const receivedAt = new Date().toISOString()

    for (const raw of events) {
      const parsed = TelemetryEventSchema.safeParse(raw)
      if (!parsed.success) {
        rejected += 1
        continue
      }
      if (parsed.data.sessionId !== id) {
        rejected += 1
        continue
      }
      const event = redactEvent(parsed.data)
      if (shouldDropEvent(event)) {
        rejected += 1
        continue
      }
      if (seen.has(event.eventId)) {
        duplicates += 1
        continue
      }
      seen.add(event.eventId)
      const envelope: Envelope = {
        schemaVersion: SCHEMA_VERSION,
        receivedAt,
        event
      }
      lines.push(JSON.stringify(envelope))
      accepted += 1
    }

    if (lines.length > 0) {
      await this.safeAppend(this.normalizedPath(id), lines.join('\n') + '\n')
    }

    return { accepted, duplicates, rejected }
  }

  async stopSession(sessionId: string): Promise<TelemetrySessionMeta> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const meta = await this.getSessionMeta(id)
    if (!meta) throw new Error(`[telemetry] unknown session ${id}`)
    if (meta.captureStatus !== 'recording' && meta.stoppedAt) {
      return meta
    }
    return this.updateSessionMeta(id, {
      captureStatus: 'stopped',
      stoppedAt: new Date().toISOString()
    })
  }

  async readSessionEvents(sessionId: string): Promise<TelemetryEvent[]> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.normalizedPath(id)
    if (!existsSync(path)) return []
    const text = readFileSync(path, 'utf8')
    const events: TelemetryEvent[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const envelope = JSON.parse(line) as Envelope
        const parsed = TelemetryEventSchema.safeParse(envelope.event)
        if (parsed.success) events.push(redactEvent(parsed.data))
      } catch {
        // skip corrupt lines
      }
    }
    return events
  }

  async readPolishedSession(sessionId: string): Promise<PolishedSession | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.polishedPath(id)
    if (!existsSync(path)) return null
    try {
      return PolishedSessionSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return null
    }
  }

  async savePolishedSession(sessionId: string, polished: PolishedSession): Promise<void> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    if (polished.sessionId !== id) {
      throw new Error('[telemetry] polished sessionId mismatch')
    }
    this.writeJson(this.polishedPath(id), polished)
  }

  async saveWorkflow(
    sessionId: string,
    workflow: ExtractedWorkflow,
    model: string
  ): Promise<StoredWorkflowResult> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const stored: StoredWorkflowResult = {
      sessionId: id,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      model,
      workflow
    }
    const validated = StoredWorkflowResultSchema.parse(stored)
    this.writeJson(this.workflowPath(id), validated)
    return validated
  }

  async getWorkflow(sessionId: string): Promise<StoredWorkflowResult | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.workflowPath(id)
    if (!existsSync(path)) return null
    try {
      return StoredWorkflowResultSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      console.error('[telemetry] failed to read workflow')
      return null
    }
  }

  async saveVariables(sessionId: string, variables: WorkflowVariable[]): Promise<StoredVariables> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const stored: StoredVariables = {
      sessionId: id,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      variables
    }
    const validated = StoredVariablesSchema.parse(stored)
    this.writeJson(this.variablesPath(id), validated)
    return validated
  }

  async getVariables(sessionId: string): Promise<StoredVariables | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.variablesPath(id)
    if (!existsSync(path)) return null
    try {
      return StoredVariablesSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return null
    }
  }

  async saveAutomationScript(
    sessionId: string,
    script: AutomationScript,
    model: string,
    opts: { stale?: boolean } = {}
  ): Promise<StoredAutomationScript> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const stored: StoredAutomationScript = {
      sessionId: id,
      schemaVersion: SCHEMA_VERSION,
      compiledAt: new Date().toISOString(),
      model,
      script,
      stale: opts.stale ?? false
    }
    const validated = StoredAutomationScriptSchema.parse(stored)
    this.writeJson(this.automationPath(id), validated)
    return validated
  }

  async getAutomationScript(sessionId: string): Promise<StoredAutomationScript | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.automationPath(id)
    if (!existsSync(path)) return null
    try {
      return StoredAutomationScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      console.error('[telemetry] failed to read automation script')
      return null
    }
  }

  async markAutomationStale(
    sessionId: string,
    stale: boolean
  ): Promise<StoredAutomationScript | null> {
    const existing = await this.getAutomationScript(sessionId)
    if (!existing) return null
    const next: StoredAutomationScript = { ...existing, stale }
    const validated = StoredAutomationScriptSchema.parse(next)
    this.writeJson(this.automationPath(this.assertSessionId(sessionId)), validated)
    return validated
  }

  async saveKeyframe(
    sessionId: string,
    eventId: string,
    jpeg: Buffer
  ): Promise<{ absolutePath: string; relativePath: string }> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    if (!/^[A-Za-z0-9_-]+$/.test(eventId) || eventId.includes('..')) {
      throw new Error('[telemetry] invalid eventId for keyframe')
    }
    const relativePath = `${id}/${eventId}.jpg`
    const absolutePath = this.safeJoin('keyframes', id, `${eventId}.jpg`)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, jpeg)
    return { absolutePath, relativePath }
  }

  keyframesRoot(): string {
    return this.safeJoin('keyframes')
  }

  async getSessionMeta(sessionId: string): Promise<TelemetrySessionMeta | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.metaPath(id)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      return normalizeSessionMeta(raw)
    } catch {
      return null
    }
  }

  async updateSessionMeta(sessionId: string, patch: SessionMetaPatch): Promise<TelemetrySessionMeta> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const meta = await this.getSessionMeta(id)
    if (!meta) throw new Error(`[telemetry] unknown session ${id}`)
    const next: TelemetrySessionMeta = {
      ...meta,
      captureStatus: patch.captureStatus ?? meta.captureStatus,
      processingStatus: patch.processingStatus ?? meta.processingStatus,
      stoppedAt: patch.stoppedAt ?? meta.stoppedAt,
      processingErrorCode:
        patch.processingErrorCode === null
          ? undefined
          : (patch.processingErrorCode ?? meta.processingErrorCode)
    }
    delete (next as { error?: string }).error
    delete (next as { status?: string }).status
    this.writeJson(this.metaPath(id), next)
    return next
  }

  private subdir(
    name:
      | 'normalized'
      | 'polished'
      | 'workflows'
      | 'meta'
      | 'variables'
      | 'automation'
      | 'keyframes'
  ): string {
    return this.safeJoin(name)
  }

  private normalizedPath(sessionId: string): string {
    return this.safeJoin('normalized', `${sessionId}.jsonl`)
  }

  private polishedPath(sessionId: string): string {
    return this.safeJoin('polished', `${sessionId}.json`)
  }

  private workflowPath(sessionId: string): string {
    return this.safeJoin('workflows', `${sessionId}.json`)
  }

  private variablesPath(sessionId: string): string {
    return this.safeJoin('variables', `${sessionId}.json`)
  }

  private automationPath(sessionId: string): string {
    return this.safeJoin('automation', `${sessionId}.json`)
  }

  private metaPath(sessionId: string): string {
    return this.safeJoin('meta', `${sessionId}.json`)
  }

  private assertSessionId(sessionId: string): string {
    return SessionIdSchema.parse(sessionId)
  }

  private safeJoin(...parts: string[]): string {
    for (const p of parts) {
      if (!p || p.includes('..') || p.includes('\0') || p.includes('/') || p.includes('\\')) {
        throw new Error(`[telemetry] path traversal blocked: ${p}`)
      }
    }
    const resolved = resolve(this.root, ...parts)
    const rootWithSep = this.root.endsWith(sep) ? this.root : this.root + sep
    if (resolved !== this.root && !resolved.startsWith(rootWithSep)) {
      throw new Error(`[telemetry] resolved path escaped telemetry directory: ${resolved}`)
    }
    return resolved
  }

  private writeJson(path: string, data: unknown): void {
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[telemetry] failed to write ${path}: ${msg}`)
    }
  }

  private async safeAppend(path: string, chunk: string): Promise<void> {
    const prev = this.appendLocks.get(path) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    this.appendLocks.set(
      path,
      prev.then(() => gate)
    )
    await prev
    try {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, chunk, 'utf8')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[telemetry] failed to append ${path}: ${msg}`)
    } finally {
      release()
      if (this.appendLocks.get(path) === gate) this.appendLocks.delete(path)
    }
  }

  private async loadEventIds(sessionId: string): Promise<Set<string>> {
    const events = await this.readSessionEvents(sessionId)
    return new Set(events.map((e) => e.eventId))
  }
}
