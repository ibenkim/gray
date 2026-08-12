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
  type TokenUsage,
  type WorkflowVariable,
  normalizeExtractedWorkflow
} from '../../../shared/telemetry/schema'
import { redactEvent, shouldDropEvent } from '../../../shared/telemetry/sanitize'
import type {
  AppendEventsResult,
  CreateSessionInput,
  SessionMetaPatch,
  StoredNarration,
  TelemetryStore
} from './TelemetryStore'

type Envelope = {
  schemaVersion: typeof SCHEMA_VERSION
  receivedAt: string
  event: TelemetryEvent
}

type Layout = 'session' | 'legacy'

/**
 * Development-only file adapter. Refuses to initialize when the app is packaged.
 * Writes sanitized JSONL under development-data/telemetry/.
 *
 * New sessions use per-session layout under sessions/{sessionId}/.
 * Legacy flat paths (normalized/, meta/, …) remain readable and writable for
 * sessions that already exist in that layout.
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
      mkdirSync(this.safeJoin('sessions'), { recursive: true })
      // Legacy dirs — still created so old tooling / dual-path reads keep working.
      mkdirSync(this.safeJoin('normalized'), { recursive: true })
      mkdirSync(this.safeJoin('polished'), { recursive: true })
      mkdirSync(this.safeJoin('workflows'), { recursive: true })
      mkdirSync(this.safeJoin('meta'), { recursive: true })
      mkdirSync(this.safeJoin('variables'), { recursive: true })
      mkdirSync(this.safeJoin('automation'), { recursive: true })
      mkdirSync(this.safeJoin('keyframes'), { recursive: true })
      mkdirSync(this.safeJoin('narration'), { recursive: true })
      mkdirSync(this.safeJoin('ground_truth'), { recursive: true })
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
    const metaPath = this.pathFor(sessionId, 'meta', 'session')
    this.writeJson(metaPath, meta)
    const eventsPath = this.pathFor(sessionId, 'events', 'session')
    if (!existsSync(eventsPath)) {
      mkdirSync(dirname(eventsPath), { recursive: true })
      writeFileSync(eventsPath, '', 'utf8')
    }
    mkdirSync(this.safeJoin('sessions', sessionId, 'shots'), { recursive: true })
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
      const layout = this.layoutOf(id)
      await this.safeAppend(this.pathFor(id, 'events', layout), lines.join('\n') + '\n')
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
    const path = this.resolveExisting(id, 'events')
    if (!path) return []
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
    const path = this.resolveExisting(id, 'polished')
    if (!path) return null
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
    this.writeJson(this.pathFor(id, 'polished', this.layoutOf(id)), polished)
  }

  async saveWorkflow(
    sessionId: string,
    workflow: ExtractedWorkflow,
    model: string,
    opts?: { usage?: TokenUsage }
  ): Promise<StoredWorkflowResult> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const stored: StoredWorkflowResult = {
      sessionId: id,
      schemaVersion: SCHEMA_VERSION,
      extractedAt: new Date().toISOString(),
      model,
      workflow,
      usage: opts?.usage
    }
    const validated = StoredWorkflowResultSchema.parse(stored)
    this.writeJson(this.pathFor(id, 'workflow', this.layoutOf(id)), validated)
    return validated
  }

  async getWorkflow(sessionId: string): Promise<StoredWorkflowResult | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'workflow')
    if (!path) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      const normalized = normalizeExtractedWorkflow(raw.workflow)
      if (!normalized) return null
      return StoredWorkflowResultSchema.parse({ ...raw, workflow: normalized })
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
    this.writeJson(this.pathFor(id, 'variables', this.layoutOf(id)), validated)
    return validated
  }

  async getVariables(sessionId: string): Promise<StoredVariables | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'variables')
    if (!path) return null
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
    opts: { stale?: boolean; usage?: TokenUsage } = {}
  ): Promise<StoredAutomationScript> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const stored: StoredAutomationScript = {
      sessionId: id,
      schemaVersion: SCHEMA_VERSION,
      compiledAt: new Date().toISOString(),
      model,
      script,
      stale: opts.stale ?? false,
      usage: opts.usage
    }
    const validated = StoredAutomationScriptSchema.parse(stored)
    this.writeJson(this.pathFor(id, 'automation', this.layoutOf(id)), validated)
    return validated
  }

  async getAutomationScript(sessionId: string): Promise<StoredAutomationScript | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'automation')
    if (!path) return null
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
    const id = this.assertSessionId(sessionId)
    this.writeJson(this.pathFor(id, 'automation', this.layoutOf(id)), validated)
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
    const layout = this.layoutOf(id)
    if (layout === 'session') {
      const relativePath = `sessions/${id}/shots/${eventId}.jpg`
      const absolutePath = this.safeJoin('sessions', id, 'shots', `${eventId}.jpg`)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, jpeg)
      return { absolutePath, relativePath }
    }
    const relativePath = `${id}/${eventId}.jpg`
    const absolutePath = this.safeJoin('keyframes', id, `${eventId}.jpg`)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, jpeg)
    return { absolutePath, relativePath }
  }

  keyframesRoot(): string {
    // Legacy keyframes live under keyframes/; session shots use absolute paths from saveKeyframe.
    return this.safeJoin('keyframes')
  }

  async saveNarration(sessionId: string, narration: StoredNarration): Promise<void> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const payload: StoredNarration = { ...narration, sessionId: id }
    this.writeJson(this.pathFor(id, 'narration', this.layoutOf(id)), payload)
  }

  async getNarration(sessionId: string): Promise<StoredNarration | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'narration')
    if (!path) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as StoredNarration
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.spans)) return null
      return { ...raw, sessionId: id }
    } catch {
      return null
    }
  }

  async saveGroundTruth(sessionId: string, groundTruth: string | object): Promise<void> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const text =
      typeof groundTruth === 'string' ? groundTruth : JSON.stringify(groundTruth, null, 2) + '\n'
    const path = this.pathFor(id, 'ground_truth', this.layoutOf(id))
    try {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, text.endsWith('\n') ? text : text + '\n', 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`[telemetry] failed to write ${path}: ${msg}`)
    }
  }

  async getGroundTruth(sessionId: string): Promise<string | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'ground_truth')
    if (!path) return null
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  }

  async getSessionMeta(sessionId: string): Promise<TelemetrySessionMeta | null> {
    await this.ensureReady()
    const id = this.assertSessionId(sessionId)
    const path = this.resolveExisting(id, 'meta')
    if (!path) return null
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
    this.writeJson(this.pathFor(id, 'meta', this.layoutOf(id)), next)
    return next
  }

  /** Prefer session layout when its meta.json exists; else legacy. */
  private layoutOf(sessionId: string): Layout {
    if (existsSync(this.pathFor(sessionId, 'meta', 'session'))) return 'session'
    if (existsSync(this.pathFor(sessionId, 'meta', 'legacy'))) return 'legacy'
    return 'session'
  }

  private pathFor(
    sessionId: string,
    kind:
      | 'meta'
      | 'events'
      | 'polished'
      | 'workflow'
      | 'variables'
      | 'automation'
      | 'narration'
      | 'ground_truth',
    layout: Layout
  ): string {
    if (layout === 'session') {
      const nameByKind: Record<typeof kind, string> = {
        meta: 'meta.json',
        events: 'events.jsonl',
        polished: 'polished.json',
        workflow: 'workflow.json',
        variables: 'variables.json',
        automation: 'automation.json',
        narration: 'narration.json',
        ground_truth: 'ground_truth.md'
      }
      return this.safeJoin('sessions', sessionId, nameByKind[kind])
    }
    switch (kind) {
      case 'meta':
        return this.safeJoin('meta', `${sessionId}.json`)
      case 'events':
        return this.safeJoin('normalized', `${sessionId}.jsonl`)
      case 'polished':
        return this.safeJoin('polished', `${sessionId}.json`)
      case 'workflow':
        return this.safeJoin('workflows', `${sessionId}.json`)
      case 'variables':
        return this.safeJoin('variables', `${sessionId}.json`)
      case 'automation':
        return this.safeJoin('automation', `${sessionId}.json`)
      case 'narration':
        return this.safeJoin('narration', `${sessionId}.json`)
      case 'ground_truth':
        return this.safeJoin('ground_truth', `${sessionId}.md`)
    }
  }

  /** Read: try session layout, then legacy. */
  private resolveExisting(
    sessionId: string,
    kind:
      | 'meta'
      | 'events'
      | 'polished'
      | 'workflow'
      | 'variables'
      | 'automation'
      | 'narration'
      | 'ground_truth'
  ): string | null {
    const sessionPath = this.pathFor(sessionId, kind, 'session')
    if (existsSync(sessionPath)) return sessionPath
    const legacyPath = this.pathFor(sessionId, kind, 'legacy')
    if (existsSync(legacyPath)) return legacyPath
    return null
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
