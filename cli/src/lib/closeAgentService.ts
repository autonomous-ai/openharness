/** User Close is a disk-backed lifecycle operation. Hiding/switching a tab never calls this. */
import { stripVTControlCharacters } from 'node:util'
import { randomUUID } from 'node:crypto'
import { teamWriteHold } from './teamWriteHold.js'
import { terminalActivity } from './terminalActivity.js'
import type { RegisteredSession, registry as liveRegistry } from './registry.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { StopAgentOptions } from './stopAgentService.js'
import { resumeMode } from './resumeCapability.js'

export type CloseActivity = 'idle' | 'working' | 'needs_input' | 'draft' | 'unknown'
export type CloseMode = 'inspect' | 'idle' | 'now' | 'after_task' | 'cancel'
export type AgentClosePlan = {
  id: string
  requestedAt: number
  identity: string
  state: 'waiting' | 'failed'
  detail?: string
}
export type AgentCloseRequest = { agentId: string; sessionId: string; createdAt: string; mode: CloseMode; onlyIfHidden?: boolean }
export type AgentCloseResult = { closed?: true; deferred?: true; cancelled?: true; error?: string; detail?: string; activity?: CloseActivity }

type CloseSession = Pick<RegisteredSession, 'engine' | 'sessionId' | 'transcriptPath' | 'boundAt' | 'launch' | 'resumeOnly'>

function unusedChat(session: CloseSession): boolean {
  return (session.engine === 'claude' || session.engine === 'codex')
    && !session.sessionId && !session.transcriptPath && session.boundAt == null && !session.resumeOnly
    && (session.launch == null || session.launch.state === 'ready')
}

/** An empty new chat has no turn state yet. Existing chats still require that state,
 * and neither kind is idle without a recognized empty composer. */
export function inspectCloseActivity(session: CloseSession, screen: string | null,
  turnOpen: boolean | undefined, needsInput: boolean): CloseActivity {
  const { engine } = session
  if (needsInput) return 'needs_input'
  if (turnOpen === true) return 'working'
  if (!screen) return 'unknown'
  const footer = stripVTControlCharacters(screen).split('\n').slice(-16).join('\n')
  // Codex can be between turns of an active goal, and Claude can have background tasks. Codex has
  // said an active goal two ways: `◎ /goal active (41m)` in its older footers, and `Pursuing goal (41m)`
  // on its status line since (0.160, tui/src/bottom_pane/footer.rs), where only the older wording was
  // known and an agent between the turns of its goal read as idle, for a close to take. Its other goal
  // states (paused, stalled, unmet, abandoned, achieved) are not work in progress.
  if (/\bgoal\s+active\b|\bpursuing goal\b|\b[1-9]\d*\s+background\s+(?:tasks?|agents?)\b/i.test(footer)
    || terminalActivity(engine, screen)) return 'working'
  const hold = teamWriteHold(engine, screen)
  if (hold === 'team_waiting_draft') return 'draft'
  if (hold === 'team_waiting_user') return 'needs_input'
  if (hold || (turnOpen === undefined && !unusedChat(session))) return 'unknown'
  return 'idle'
}

function identity(s: RegisteredSession): string {
  return JSON.stringify([s.agentId, s.sessionId, s.engine, s.registeredAt, s.processIdentity?.pid,
    s.processIdentity?.startMarker, s.processIdentity?.executable, s.runtimes.map(terminalRouteKey).sort()])
}
/** What makes two requests the same one: the agent, the mode, and whether it holds only while no tab
 *  shows the agent. A cleanup that finds the agent on screen again must not answer the person's own close. */
function jobKey(request: AgentCloseRequest): string {
  return JSON.stringify([request.agentId, request.mode, request.onlyIfHidden === true])
}
function matches(s: RegisteredSession | undefined, request: AgentCloseRequest): s is RegisteredSession {
  return !!s && s.sessionId === request.sessionId && new Date(s.registeredAt).toISOString() === request.createdAt
}

export interface CloseAgentServiceDeps {
  registry: Pick<typeof liveRegistry, 'byAgent' | 'list' | 'setClosePlan'>
  activity(s: RegisteredSession): Promise<CloseActivity>
  checkpoint(s: RegisteredSession, phase: 'before' | 'after'): Promise<void>
  stop(agentId: string, options: StopAgentOptions): Promise<void>
  changed(s: RegisteredSession): void
  openTabs?: { assertHidden(s: RegisteredSession): Promise<void>; isHidden(s: RegisteredSession): boolean }
  now?: () => number
}

class CloseRefused extends Error {
  constructor(readonly activity: CloseActivity) { super('The session is not idle.') }
}

/** Only explicitly deferred closes own a timer. Their intent survives an app/daemon restart,
 * but is never transferred to a replacement process or another conversation under the same ID. */
export class CloseAgentService {
  /** The job for each agent and kind of request (`jobKey`): the same request asked again, by a second
   *  click or a second window, is answered by the job already running. */
  private readonly jobs = new Map<string, Promise<AgentCloseResult>>()
  /** The last job asked for each agent: a request of another kind waits behind it, so two never act on
   *  one agent at once. */
  private readonly queues = new Map<string, Promise<AgentCloseResult>>()
  private readonly idleSince = new Map<string, number>()
  private readonly revisions = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly now: () => number
  constructor(private readonly deps: CloseAgentServiceDeps) { this.now = deps.now ?? Date.now }

  start(): void { this.schedule() }
  dispose(): void { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = null }

  /** Opening a queued session means it should stay available. No other queued work is affected. */
  cancel(agentId: string): void {
    this.revisions.set(agentId, (this.revisions.get(agentId) ?? 0) + 1)
    this.idleSince.delete(agentId)
    if (!this.deps.registry.byAgent(agentId)?.closePlan) return
    const updated = this.deps.registry.setClosePlan(agentId, null)
    if (updated) this.deps.changed(updated)
    if (!this.pending().length && this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  request(request: AgentCloseRequest): Promise<AgentCloseResult> {
    const current = this.deps.registry.byAgent(request.agentId)
    if (!matches(current, request)) return Promise.resolve({ error: 'AGENT_CHANGED' })
    if (request.mode === 'cancel') { this.cancel(request.agentId); return Promise.resolve({ cancelled: true }) }
    // A job answers only a request of its own kind. When any job running for the agent answered every
    // request, a close asked for while another window (or the cleanup preview) was inspecting the agent
    // was answered with that inspect's `{ activity }` and never carried out, and an inspect beside a
    // close was answered `{ closed: true }` (e2e/windows.e2e.ts). A request of another kind waits for
    // the job ahead of it, then runs for itself against the agent as it was when it was asked.
    const key = jobKey(request)
    const pending = this.jobs.get(key)
    if (pending) return pending
    const target = identity(current)
    const revision = this.revisions.get(request.agentId) ?? 0
    const ahead = this.queues.get(request.agentId)
    const run = () => this.execute(request, target, revision)
    const job = (ahead ? ahead.then(run) : run()).finally(() => {
      if (this.jobs.get(key) === job) this.jobs.delete(key)
      if (this.queues.get(request.agentId) === job) this.queues.delete(request.agentId)
      this.schedule()
    })
    this.jobs.set(key, job)
    this.queues.set(request.agentId, job)
    return job
  }

  private async execute(request: AgentCloseRequest, target: string, revision: number): Promise<AgentCloseResult> {
    const current = () => {
      const s = this.deps.registry.byAgent(request.agentId)
      return !this.disposed && (this.revisions.get(request.agentId) ?? 0) === revision
        && s && identity(s) === target
        && (!request.onlyIfHidden || this.deps.openTabs?.isHidden(s)) ? s : undefined
    }
    try {
      if (request.onlyIfHidden) {
        if (!this.deps.openTabs || request.mode !== 'now') return { error: 'UNSUPPORTED' }
        const s = this.deps.registry.byAgent(request.agentId)
        if (!s) return { error: 'AGENT_CHANGED' }
        await this.deps.openTabs.assertHidden(s)
      }
      const s = current()
      if (!s) return { error: 'AGENT_CHANGED' }
      const observed = await this.deps.activity(s)
      // Close belongs to the global workspace. Other viewers do not change
      // whether the session has unfinished work.
      const activity = observed === 'idle' && resumeMode(s.engine) !== 'conversation' ? 'unknown' : observed
      if (!current()) return { error: 'AGENT_CHANGED' }
      if (request.mode === 'inspect') return { activity }
      if (request.mode === 'after_task') {
        if (s.closePlan?.identity === target && s.closePlan.state === 'waiting') return { deferred: true }
        const updated = this.deps.registry.setClosePlan(s.agentId, { id: randomUUID(), identity: target, requestedAt: this.now(), state: 'waiting' })
        this.idleSince.delete(s.agentId)
        if (updated) this.deps.changed(updated)
        this.schedule()
        return { deferred: true }
      }
      if (request.mode === 'idle' && activity !== 'idle') return { error: 'SESSION_NOT_IDLE', activity }
      await this.deps.stop(s.agentId, {
        current: () => !!current(),
        checkpoint: (s, phase) => this.deps.checkpoint(s, phase),
        confirmUnusedConversation: async captured => {
          // A missing ID alone could be failed discovery of active work. Only
          // an unused chat with a freshly observed empty composer can skip the
          // shared-server conversation stop, after its screen is checkpointed.
          const latest = current()
          if (!latest || !unusedChat(captured) || !unusedChat(latest)) return false
          const activity = await this.deps.activity(latest)
          const after = current()
          return activity === 'idle' && !!after && unusedChat(after)
        },
        beforeStop: async () => {
          const latest = current()
          if (!latest) throw new Error('The session changed while saving. Please try again.')
          if (request.onlyIfHidden) await this.deps.openTabs!.assertHidden(latest)
          if (request.mode !== 'now') {
            const activity = await this.deps.activity(latest)
            if (activity !== 'idle') throw new CloseRefused(activity)
            if (!current()) throw new Error('The session changed while saving. Please try again.')
          }
        },
      })
      this.idleSince.delete(s.agentId)
      return { closed: true }
    } catch (error) {
      if (error instanceof CloseRefused) return { error: 'SESSION_NOT_IDLE', activity: error.activity }
      const code = (error as { code?: unknown })?.code
      return { error: typeof code === 'string' ? code : 'CLOSE_FAILED',
        detail: error instanceof Error ? error.message : 'Could not close this session safely. Please try again.' }
    }
  }

  private pending(): RegisteredSession[] { return this.deps.registry.list().filter(s => s.closePlan?.state === 'waiting') }
  private schedule(): void {
    if (this.disposed || this.timer || !this.pending().length) return
    this.timer = setTimeout(() => { this.timer = null; void this.tick().finally(() => this.schedule()) }, 5_000)
    this.timer.unref?.()
  }
  async tick(): Promise<void> {
    if (this.disposed) return
    // Serial reads avoid a process/transcript sampling burst when a whole tab was closed.
    for (const s of this.pending()) {
      if (this.disposed) return
      if (this.queues.has(s.agentId)) continue
      const plan = s.closePlan!
      if (identity(s) !== plan.identity) { this.cancel(s.agentId); continue }
      try {
        const activity = await this.deps.activity(s)
        if (this.disposed || this.deps.registry.byAgent(s.agentId)?.closePlan?.id !== plan.id) continue
        if (activity !== 'idle') { this.idleSince.delete(s.agentId); continue }
        const since = this.idleSince.get(s.agentId)
        if (since === undefined) { this.idleSince.set(s.agentId, this.now()); continue }
        // A turn boundary alone is not completion. Give chained turns and delayed questions time to surface.
        if (this.now() - since < 5_000) continue
        const result = await this.request({ agentId: s.agentId, sessionId: s.sessionId,
          createdAt: new Date(s.registeredAt).toISOString(), mode: 'idle' })
        if (result.error && result.error !== 'SESSION_NOT_IDLE') {
          const latest = this.deps.registry.byAgent(s.agentId)
          if (latest?.closePlan?.id === plan.id) {
            const changed = this.deps.registry.setClosePlan(s.agentId, { ...plan, state: 'failed',
              detail: result.detail ?? 'Could not save and close this session. Open it to try again.' })
            if (changed) this.deps.changed(changed)
          }
        }
      } catch {
        // A read failure is unknown activity, never proof that the task finished.
        this.idleSince.delete(s.agentId)
      }
    }
  }
}
