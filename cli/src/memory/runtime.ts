/** Local host lifecycle. Session authority and coding eligibility must come from the daemon. */
import { join } from 'node:path'
import { redact } from '../pair/learn/guard.js'
import { z } from 'zod'
import { digest } from './admission.js'
import { NativeMemoryCapture, type CaptureOutcome } from './capture.js'
import { MemoryClient } from './client.js'
import { MemoryLearner, type LearningOutcome, type MemoryInference } from './learner.js'
import { locateProject, type ProjectContext } from './project.js'
import type { Arguments, MemoryPort, Operation, Result } from './operations.js'
import type { MemoryPreferences } from './store.js'
import type { LibraryQuery, LibraryProjectQuery, LibraryCommand, LibraryPreview, NotebookQuery } from './library.js'
import { libraryActivityQuerySchema, type LibraryActivityQuery } from './library.js'
import type { PreparedRecall, RecallReceipt } from './receipts.js'
import { conditionsSchema, MemoryError, parse, type RecallPacket, type RecallRequest } from './types.js'

const toolRecallSchema = z.object({ query: z.string().min(1).max(4_000), conditions: conditionsSchema.optional() }).strict()

export interface MemoryHostContext {
  experimental: boolean
  watching: boolean
  /** An authenticated Harness owner or an isolated local guest, never a model account or avatar. */
  profileId: string | null
}
export interface MemoryHostSession {
  agentId: string
  name?: string
  /** Exited sessions can remain briefly for capture, but never appear as open activity. */
  present?: boolean
  engine: 'claude' | 'codex' | 'opencode'
  cliVersion?: string | null
  sessionId: string
  workspace: string
  transcriptPath: string
  busy: boolean
  /** Positive host classification is required; a general-domain DSH is not implicitly coding. */
  coding: boolean
  /** Only the host's verified current collection conversation may use the personal scope. */
  scope?: 'project' | 'profile'
  liveFrom?: number
}
interface Connection extends MemoryPort { close(): Promise<void> }
interface RuntimeDeps {
  directory: string
  context(): MemoryHostContext
  sessions(): MemoryHostSession[]
  inference: MemoryInference
  create?: (profileId: string) => Connection
  locate?: (workspace: string) => Promise<ProjectContext>
  now?: () => number
  quietMs?: number
}
interface ActiveProfile {
  id: string; connection: Connection; port: MemoryPort; capture: NativeMemoryCapture; learner: MemoryLearner
  preferences: MemoryPreferences; projects: Map<string, { projectId: string | null; checkedAt: number }>
  learning: Promise<LearningOutcome> | null; learningStatus: LearningOutcome | null; captureStatus: CaptureOutcome | null
  maintainedAt: number
  ready: boolean
}
export interface MemoryRuntimeStatus {
  state: 'off' | 'waiting_for_identity' | 'ready' | 'unavailable'
  preferences?: MemoryPreferences
  learning?: LearningOutcome | null
  capture?: CaptureOutcome | null
  reason?: string
}

/** Capture continues during work. Learning yields to new requests and the collection companion. */
export class CodingMemoryRuntime {
  private active: ActiveProfile | null = null
  private readonly management = new Map<string, { connection: Connection; leases: number }>()
  private ownerRequests = 0
  private running: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null
  private stopped = false
  private offset = 0
  private lastActivityAt: number
  private failure: string | null = null
  private readonly now: () => number

  constructor(private readonly deps: RuntimeDeps) {
    this.now = deps.now ?? Date.now
    this.lastActivityAt = this.now()
  }

  start(): void {
    if (this.stopped || this.timer) return
    this.timer = setInterval(() => { void this.tick() }, 2_000)
    this.timer.unref()
    void this.tick()
  }

  /** New local user turns interrupt review; streamed output and discovery do not. */
  activity(): void { this.lastActivityAt = this.now(); this.active?.learner.cancel('foreground_activity') }

  tick(): Promise<void> {
    if (this.active && !this.authorized(this.active)) this.active.learner.cancel()
    if (this.running) return this.running
    if (this.stopped) return Promise.resolve()
    this.running = this.update().catch(error => { this.failure = reason(error) }).finally(() => { this.running = null })
    return this.running
  }

  status(): MemoryRuntimeStatus {
    const context = this.deps.context()
    if (this.stopped || !context.experimental || !context.watching) return { state: 'off' }
    if (!context.profileId) return { state: 'waiting_for_identity' }
    if (!this.active?.ready || !this.authorized(this.active)) return { state: 'unavailable', reason: this.failure ?? 'starting' }
    return { state: this.failure ? 'unavailable' : 'ready', ...(this.failure ? { reason: this.failure } : {}),
      preferences: { ...this.active.preferences }, learning: this.active.learningStatus, capture: this.active.captureStatus }
  }

  /** Host identity only. External request bodies never select a memory owner. */
  ownerKey(): string | null {
    const context = this.deps.context()
    return !this.stopped && context.experimental ? context.profileId : null
  }

  /** Learning is a continuing use of the collection's model, even with an empty or deferred queue. */
  needsCompanion(): boolean {
    return !!this.active?.ready && this.authorized(this.active) && this.active.preferences.learn
  }

  /** Explicit owner controls remain usable with watching/learning/recall off. No capture is started. */
  async libraryStatus(owner: string) {
    return this.withOwner(owner, async port => ({ runtime: this.status(),
      preferences: await port.request('preferences', []), queue: await port.request('status', []) }))
  }

  async libraryPage(owner: string, query: LibraryQuery = {}) {
    return this.withOwner(owner, port => port.request('libraryPage', [owner, query]))
  }

  async libraryDetail(owner: string, id: string) {
    return this.withOwner(owner, port => port.request('libraryDetail', [owner, id]))
  }

  async libraryProjects(owner: string, query: LibraryProjectQuery = {}) {
    return this.withOwner(owner, port => port.request('libraryProjects', [owner, query]))
  }

  async libraryActivity(owner: string, input: LibraryActivityQuery = {}) {
    const query = parse(libraryActivityQuerySchema, input)
    return this.withOwner(owner, async port => {
      const sessions = this.deps.sessions().filter(s => s.coding && s.sessionId && s.present !== false)
        .slice(0, 128).map(s => ({ ...s }))
      if (query.agentId && !sessions.some(s => s.agentId === query.agentId)) throw new MemoryError('session_unavailable')
      const result = await port.request('libraryActivity', [owner,
        sessions.map(({ agentId, engine, sessionId }) => ({ agentId, engine, sessionId })), query])
      // A resumed/replaced session must not inherit another native conversation's selections.
      const current = this.deps.sessions()
      if (sessions.some(s => !current.some(c => c.present !== false && c.coding && c.agentId === s.agentId
        && c.engine === s.engine && c.sessionId === s.sessionId && c.workspace === s.workspace
        && c.transcriptPath === s.transcriptPath && c.scope === s.scope && c.liveFrom === s.liveFrom))) {
        throw new MemoryError('session_changed')
      }
      return { ...result, sessions: result.sessions.map(row => ({ ...row,
        name: redact((sessions.find(s => s.agentId === row.agentId)?.name ||
          `${row.engine === 'claude' ? 'Claude' : row.engine === 'opencode' ? 'OpenCode' : 'Codex'} session`).slice(0, 200)) })) }
    })
  }

  async libraryNotebooks(owner: string, query: NotebookQuery = {}) {
    return this.withOwner(owner, port => port.request('libraryNotebooks', [owner, query]))
  }

  async libraryNotebook(owner: string, id: string) {
    return this.withOwner(owner, port => port.request('libraryNotebook', [owner, id]))
  }

  async libraryPreview(owner: string, command: LibraryCommand) {
    return this.withOwner(owner, port => port.request('libraryPreview', [owner, command]))
  }

  async libraryApply(owner: string, preview: LibraryPreview) {
    return this.withOwner(owner, async port => {
      const enabled = !!this.active?.ready && this.authorized(this.active)
      const result = await port.request('libraryApply', [owner, preview.command, preview.version, enabled])
      if (this.active?.id === owner) {
        if (result.preferences) this.active.preferences = result.preferences
        if (['forget', 'correct', 'narrow'].includes(preview.command.kind) || !this.active.preferences.learn) this.active.learner.cancel()
      }
      return result
    })
  }

  private async withOwner<T>(owner: string, work: (port: MemoryPort) => Promise<T>): Promise<T> {
    const valid = () => owner === this.ownerKey() && /^[A-Za-z0-9_.:-]{1,200}$/.test(owner)
    if (!valid()) throw new MemoryError('owner_changed')
    if (this.ownerRequests >= 8) throw new MemoryError('memory_busy')
    const active = this.active
    const borrowed = !!active?.ready && active.id === owner
    let managed = this.management.get(owner)
    if (!borrowed && !managed) {
      if (this.management.size >= 2) throw new MemoryError('memory_busy')
      managed = { connection: this.connect(owner), leases: 0 }
      this.management.set(owner, managed)
    }
    if (!borrowed) managed!.leases++
    const connection = borrowed ? active.connection : managed!.connection
    this.ownerRequests++
    const port: MemoryPort = { request: async (operation, args, timeoutMs) => {
      if (!valid()) throw new MemoryError('owner_changed')
      const result = await connection.request(operation, args, timeoutMs)
      if (!valid()) throw new MemoryError('owner_changed')
      return result
    } }
    try {
      const result = await work(port)
      if (!valid()) throw new MemoryError('owner_changed')
      return result
    } finally {
      this.ownerRequests--
      if (!borrowed && --managed!.leases === 0) {
        if (this.management.get(owner) === managed) this.management.delete(owner)
        await connection.close()
      }
    }
  }

  private connect(profileId: string): Connection {
    return this.deps.create?.(profileId)
      ?? new MemoryClient({ directory: join(this.deps.directory, digest(['profile', profileId])), profileId })
  }

  /** Only the authenticated host's explicit user settings handler calls this method. */
  async configure(value: MemoryPreferences): Promise<void> {
    if (typeof value.learn !== 'boolean' || typeof value.recall !== 'boolean') throw new MemoryError('invalid_input')
    const active = this.requireActive()
    active.preferences = { learn: value.learn, recall: value.recall }
    if (!value.learn) active.learner.cancel()
    await active.port.request('setPreferences', [active.preferences])
  }

  async setSessionIncluded(agentId: string, included: boolean): Promise<void> {
    const active = this.requireActive()
    const session = this.session(agentId)
    if (!session) throw new MemoryError('session_unavailable')
    if (!included) active.learner.cancel()
    await active.port.request('setSessionIncluded', [session.engine, session.sessionId, included])
  }

  async setProjectIncluded(agentId: string, included: boolean): Promise<void> {
    const active = this.requireActive()
    const session = this.session(agentId)
    const project = session && active.projects.get(projectKey(session))
    if (!project?.projectId) throw new MemoryError('project_unavailable')
    if (!included) active.learner.cancel()
    await active.port.request('setProjectIncluded', [project.projectId, included])
  }

  /** Callers identify their process-owned agent; they never supply profile or project authority. */
  async recall(agentId: string, request: RecallRequest): Promise<RecallPacket> {
    return (await this.recallBound(agentId, request, null)).packet
  }

  /** Only the current collection's authenticated launch token reaches this method in the host. */
  async recallCollection(agentId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const request = parse(toolRecallSchema, input)
    if (this.session(agentId)?.scope !== 'profile') throw new MemoryError('scope_denied')
    const result = await this.recallBound(agentId, { ...request, format: 'source_excerpts' }, 'mcp')
    return { ok: true, status: result.packet.status, context: result.packet.text,
      receipt: result.receipt ? { id: result.receipt.id, delivery: result.receipt.delivery } : null }
  }

  async preparePromptRecall(agentId: string, request: RecallRequest,
    adapter?: { engine: string; cliVersion: string }): Promise<PreparedRecall> {
    const session = this.session(agentId)
    // A process-verified plugin can observe its native version without publishing that observation
    // into the registry. It cannot select a different framework, owner, session or project.
    if (adapter && adapter.engine !== session?.engine) return { packet: empty('unavailable'), receipt: null }
    const version = adapter?.cliVersion ?? session?.cliVersion
    // These releases demonstrated additionalContext in an outgoing native model request.
    // An extraction certificate or a successful stdout write does not certify hook delivery.
    // Manual recall remains available; add native releases after the same isolated transport check.
    const tested = session?.engine === 'claude' ? ['2.1.286', '2.1.287'].includes(version ?? '')
      : session?.engine === 'codex' ? ['0.159.0', '0.159.3', '0.160.0'].includes(version ?? '')
      : session?.engine === 'opencode' && version === '1.18.34'
    if (!tested) return { packet: empty('unavailable'), receipt: null }
    return this.recallBound(agentId, { ...request, format: 'source_excerpts' }, 'prompt_hook')
  }

  /** A verified adapter handed context to the native prompt path; not proof of model consumption. */
  async promptRecallEmitted(agentId: string, receiptId: string): Promise<boolean> {
    try {
      const active = this.requireActive()
      const session = this.session(agentId)
      const project = session && active.projects.get(projectKey(session))
      if (!session || !project || this.now() - project.checkedAt > 60_000) return false
      return await active.port.request('recallEmitted', [receiptId,
        { engine: session.engine, sessionId: session.sessionId, projectId: project.projectId, route: 'prompt_hook' },
        { profileId: active.id, projectIds: project.projectId ? [project.projectId] : [], includeProfile: true }], 100)
    } catch { return false }
  }

  async promptRecallReceipts(agentId: string): Promise<RecallReceipt[]> {
    const active = this.requireActive()
    const session = this.session(agentId)
    const project = session && active.projects.get(projectKey(session))
    if (!session || !project || this.now() - project.checkedAt > 60_000) return []
    const receipts = await active.port.request('recallReceipts', [
      { engine: session.engine, sessionId: session.sessionId, projectId: project.projectId, route: 'prompt_hook' },
      { profileId: active.id, projectIds: project.projectId ? [project.projectId] : [], includeProfile: true }])
    return this.sameSession(session) ? receipts : []
  }

  private async recallBound(agentId: string, request: RecallRequest, route: 'prompt_hook' | 'mcp' | null): Promise<PreparedRecall> {
    const deadline = performance.now() + 200
    const remaining = (): number => Math.max(1, deadline - performance.now())
    const unavailable = (status: RecallPacket['status']): PreparedRecall => ({ packet: empty(status), receipt: null })
    try {
      const active = this.requireActive()
      if (!active.preferences.recall) return unavailable('off')
      const session = this.session(agentId)
      if (!session) return unavailable('denied')
      // Recall must not wait for Git or SQLite startup on the user's input path. Background capture
      // primes the identity cache; the first unprimed request safely gets no additional context.
      const project = active.projects.get(projectKey(session))
      if (!project || this.now() - project.checkedAt > 60_000) return unavailable('unavailable')
      const policy = await active.port.request('capturePolicy', [project.projectId, session.engine, session.sessionId], 50)
      if (!policy.included) return unavailable('denied')
      const access = { profileId: active.id, projectIds: project.projectId ? [project.projectId] : [], includeProfile: true }
      const result: PreparedRecall = route
        ? await active.port.request('prepareRecall', [request,
          { engine: session.engine, sessionId: session.sessionId, projectId: project.projectId, route }, access], remaining())
        : { packet: await active.port.request('recall', [request, access], remaining()), receipt: null }
      const current = await active.port.request('capturePolicy', [project.projectId, session.engine, session.sessionId], remaining())
      if (performance.now() >= deadline) return unavailable('timeout')
      if (!current.included || current.generation !== policy.generation || current.knowledgeEpoch !== policy.knowledgeEpoch
        || !active.preferences.recall || !this.sameSession(session)) return unavailable('denied')
      return result
    } catch (error) { return unavailable(error instanceof MemoryError && error.code === 'memory_deadline' ? 'timeout' : 'unavailable') }
  }

  async close(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.active?.learner.cancel()
    await this.running
    await this.detach()
    await Promise.all([...this.management.values()].map(entry => entry.connection.close()))
    this.management.clear()
  }

  /** Stops the host timer while the experiment is off; start() may resume this instance later. */
  async pause(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.active?.learner.cancel()
    await this.running
    await this.detach()
  }

  private authorized(active: ActiveProfile): boolean {
    const context = this.deps.context()
    return !this.stopped && context.experimental && context.watching && context.profileId === active.id
  }

  private requireActive(): ActiveProfile {
    if (!this.active?.ready || !this.authorized(this.active)) throw new MemoryError('memory_unavailable')
    return this.active
  }

  private session(agentId: string): MemoryHostSession | undefined {
    return this.deps.sessions().find(session => session.agentId === agentId && session.coding && session.sessionId)
  }

  private sameSession(session: MemoryHostSession): boolean {
    const current = this.session(session.agentId)
    return !!current && current.engine === session.engine && current.sessionId === session.sessionId
      && current.workspace === session.workspace && current.transcriptPath === session.transcriptPath && current.liveFrom === session.liveFrom
      && (current.scope ?? 'project') === (session.scope ?? 'project')
      && current.cliVersion === session.cliVersion
  }

  private async detach(): Promise<void> {
    const old = this.active
    this.active = null
    if (!old) return
    old.learner.cancel()
    // Set effective controls off without overwriting the owner's requested preferences. Already
    // posted learning results fail their generation check; late calls also fail the bound port.
    await old.connection.request('setControls', [{ learn: false, recall: false }]).catch(() => {})
    await old.connection.close()
  }

  private async update(): Promise<void> {
    if (this.active && !this.authorized(this.active)) await this.detach()
    const context = this.deps.context()
    if (this.stopped || !context.experimental || !context.watching || !context.profileId) return
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(context.profileId)) throw new MemoryError('invalid_profile')
    if (!this.active) {
      const profileId = context.profileId
      const connection = this.connect(profileId)
      const host = this
      const port: MemoryPort = { async request<K extends Operation>(operation: K, args: Arguments<K>, timeoutMs?: number): Promise<Result<K>> {
        if (host.active !== active || !host.authorized(active)) throw new MemoryError('owner_changed')
        const result = await connection.request(operation, args, timeoutMs)
        if (host.active !== active || !host.authorized(active)) throw new MemoryError('owner_changed')
        return result
      } }
      const assertAuthorized = (): void => {
        if (this.active !== active || !this.authorized(active) || !active.preferences.learn) throw new MemoryError('inference_cancelled')
      }
      const inference: MemoryInference = {
        target: async () => {
          assertAuthorized()
          const target = await this.deps.inference.target()
          assertAuthorized()
          return target
        },
        run: (prompt, options) => {
          assertAuthorized()
          return this.deps.inference.run(prompt, { ...options, assertAuthorized: () => {
            assertAuthorized(); options.assertAuthorized?.()
          } })
        },
      }
      const active: ActiveProfile = { id: profileId, connection, port, projects: new Map(), learning: null, learningStatus: null,
        captureStatus: null, maintainedAt: -Infinity, ready: false, preferences: { learn: false, recall: false },
        capture: new NativeMemoryCapture(port, this.now), learner: new MemoryLearner(port, inference) }
      this.active = active
      try {
        // A new daemon lifetime does not backfill conversations from when this host was absent.
        await active.port.request('setControls', [{ learn: false, recall: false }])
        active.preferences = await active.port.request('preferences', [])
        await active.port.request('setControls', [active.preferences])
        active.ready = true
      } catch (error) { await this.detach(); throw error }
    }
    const active = this.requireActive()
    this.failure = null
    if (this.now() - active.maintainedAt >= 60_000) {
      await active.port.request('maintain', [])
      active.maintainedAt = this.now()
    }
    const sessions = this.deps.sessions().filter(session => session.coding && session.sessionId)
    // Long coding jobs may run for hours. Only the current collection's own conversation needs
    // to be idle; fresh user turns anywhere still reset the quiet window through activity().
    const companionBusy = sessions.some(session => session.scope === 'profile' && session.busy)
    if (companionBusy) this.activity()
    // Bound per-tick filesystem work and share turns among concurrent sessions.
    const count = Math.min(8, sessions.length)
    for (let index = 0; index < count; index++) {
      const session = sessions[(this.offset + index) % sessions.length]
      try {
        let project = active.projects.get(projectKey(session))
        if (!project || this.now() - project.checkedAt > 60_000) {
          const located = session.scope === 'profile' ? null : await (this.deps.locate ?? locateProject)(session.workspace)
          if (!this.sameSession(session)) continue
          const projectId = located ? await active.port.request('projectForLocator', [located.locator]) : null
          project = { projectId, checkedAt: this.now() }
          active.projects.set(projectKey(session), project)
          if (active.projects.size > 128) active.projects.delete(active.projects.keys().next().value!)
        }
        if (!this.sameSession(session)) continue
        if (active.preferences.learn) active.captureStatus = await active.capture.poll({ ...session,
          profileId: active.id, projectId: project.projectId })
      } catch (error) { active.captureStatus = { state: 'unavailable', sources: 0, reason: reason(error) } }
    }
    this.offset = sessions.length ? (this.offset + count) % sessions.length : 0
    if (!this.authorized(active) || !active.preferences.learn || active.learning) return
    if (companionBusy) { active.learningStatus = { state: 'foreground_busy' }; return }
    if (this.now() - this.lastActivityAt < (this.deps.quietMs ?? 15_000)) {
      active.learningStatus = { state: 'waiting_for_quiet' }; return
    }
    active.learning = active.learner.tick()
    void active.learning.then(outcome => { if (this.active === active) active.learningStatus = outcome })
      .catch(error => { if (this.active === active) active.learningStatus = { state: 'failed', reason: reason(error) } })
      .finally(() => { active.learning = null })
  }
}

function reason(error: unknown): string { return error instanceof MemoryError ? error.code : 'memory_unavailable' }
function projectKey(session: MemoryHostSession): string { return digest([session.scope ?? 'project', session.workspace]) }
function empty(status: RecallPacket['status']): RecallPacket { return { status, items: [], text: '', estimatedTokens: 0 } }
