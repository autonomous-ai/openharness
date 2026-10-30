/** User Close is a disk-backed lifecycle operation. Hiding/switching a tab never calls this. */
import { randomUUID } from 'node:crypto'
import type { ScreenReading } from '../engines/facets/screen.js'
import type { RegisteredSession, registry as liveRegistry } from './registry.js'
import { terminalRouteKey } from './terminalRuntime.js'
import type { StopAgentOptions } from './stopAgentService.js'
import { resumeMode } from './resumeCapability.js'
import { sid } from './log.js'

export type CloseActivity = 'idle' | 'working' | 'needs_input' | 'draft' | 'unknown'
export type CloseMode = 'inspect' | 'idle' | 'now' | 'after_task' | 'cancel'
export type AgentClosePlan = {
  id: string
  requestedAt: number
  identity: string
  state: 'waiting' | 'failed'
  detail?: string
}
/** Why the Lead of an active Swarm project is not closed (owner, 2026-10-23: it is never stopped, in any case). */
export const LEAD_PROTECTED_DETAIL = 'This harness is the Product Manager of a Swarm project. Delete its project first to stop it.'
/** Why a Swarm Buddy is not closed (Diego, 10-30: closing the tab that showed his Buddy stopped it, and two proposals
 *  waited 30 minutes). A window closes only its view; the machine's owner still stops it with Stop Harness. */
export const BUDDY_PROTECTED_DETAIL = 'This is a Swarm Buddy. Its person removes it from the Swarm, or Stop Harness stops it.'
export type AgentCloseRequest = { agentId: string; sessionId: string; createdAt: string; mode: CloseMode; onlyIfHidden?: boolean; onlyIfOriginalLaunch?: boolean; expiresAt?: number }
/** `withoutConversation`: closed while still starting, before Harness could read its conversation, so none is kept. */
/** `keptRunning`: a close refused for a session that keeps running on purpose (a Swarm Buddy): a window closes its view and
 *  stops nothing, as it does for a Swarm pane (desktop app_state.dart `canStop`). */
export type AgentCloseResult = { closed?: true; withoutConversation?: true; deferred?: true; cancelled?: true; error?: string; detail?: string; activity?: CloseActivity; keptRunning?: true }

/**
 * How long a close waits for a harness still starting to bind its first conversation, trying again meanwhile.
 * Codex 0.162.1 in a clean macOS VM (2026-10-12): for its first seconds every read of its process was refused ("the
 * native control descriptor type is unavailable"), so `harness close --now` a second after `harness new` was refused
 * with that phrase and the harness kept working; four seconds in, the same close worked.
 */
export const CLOSE_BIND_WAIT_MS = 8_000
const CLOSE_BIND_RETRY_MS = 1_000
/**
 * A harness Harness launched less than this long ago, with no conversation bound yet, is still starting: one that never
 * binds within the wait is stopped without a conversation. Past it, a close whose conversation cannot be read is refused
 * as before: a harness that has run longer may have work that only its conversation holds.
 */
export const CLOSE_STARTING_MS = 60_000

type CloseSession = Pick<RegisteredSession, 'engine' | 'sessionId' | 'transcriptPath' | 'boundAt' | 'launch' | 'resumeOnly'>

export function unusedChat(session: CloseSession): boolean {
  return (session.engine === 'claude' || session.engine === 'codex')
    && !session.sessionId && !session.transcriptPath && session.boundAt == null && !session.resumeOnly
    && (session.launch == null || session.launch.state === 'ready')
}

/** An empty new chat has no turn state yet. Existing chats still require that state,
 * and neither kind is idle without a recognized empty composer. */
export function inspectCloseActivity(session: CloseSession, screen: ScreenReading | null,
  turnOpen: boolean | undefined, needsInput: boolean): CloseActivity {
  const { engine } = session
  if (needsInput) return 'needs_input'
  if (turnOpen === true) return 'working'
  if (!screen) return 'unknown'
  if (screen.busy) return 'working'
  const hold = screen.teamHold
  if (hold === 'team_waiting_draft') return 'draft'
  if (hold === 'team_waiting_user') return 'needs_input'
  if (hold || (turnOpen === undefined && !unusedChat(session))) return 'unknown'
  return 'idle'
}

function identity(s: RegisteredSession): string {
  return JSON.stringify([s.agentId, s.sessionId, s.engine, s.registeredAt, s.processIdentity?.pid,
    s.processIdentity?.startMarker, s.processIdentity?.executable, s.runtimes.map(terminalRouteKey).sort()])
}
/** The harness, whichever conversation it has bound: its process and panes. */
function harnessIdentity(s: RegisteredSession): string {
  return JSON.stringify([s.agentId, s.engine, s.registeredAt, s.processIdentity?.pid,
    s.processIdentity?.startMarker, s.processIdentity?.executable, s.runtimes.map(terminalRouteKey).sort()])
}
/** How long before [at] the harness started: its engine's own start when that is later than the row's (an engine
 *  installed in its pane first starts minutes after the pane opened), its row's otherwise. A clock that went back
 *  says nothing: never young. */
function age(s: RegisteredSession, at: number): number {
  const born = Date.parse(s.processIdentity?.startMarker ?? '')
  const since = Number.isFinite(born) && born > s.registeredAt ? Math.min(born, at) : s.registeredAt
  return at - s.registeredAt < 0 ? -1 : at - since
}
/** Started less than CLOSE_STARTING_MS before [at], and not a terminal an engine was typed into, a resume or an adoption. */
function young(s: RegisteredSession, at: number): boolean {
  const old = age(s, at)
  return !s.terminalHost && !s.resumeOnly && !s.externalResume && old >= 0 && old < CLOSE_STARTING_MS
}
/** Launched by Harness, young, and with no conversation bound yet. A fork is not: it starts on a copy of another's
 *  conversation. Nor is a row a hook has bound, which loses its `launch` then (registry.register): once bound, never
 *  starting again. */
function stillStarting(s: RegisteredSession, at: number): boolean {
  return !!s.launch && !s.forkedFrom && young(s, at) && !s.sessionId && !s.transcriptPath && s.boundAt == null
}
/** What makes two requests the same one: the agent, the mode, and whether it holds only while no tab
 *  shows the agent. A cleanup that finds the agent on screen again must not answer the person's own close. */
function jobKey(request: AgentCloseRequest): string {
  return JSON.stringify([request.agentId, request.mode, request.onlyIfHidden === true, request.onlyIfOriginalLaunch === true, request.expiresAt])
}
function matches(s: RegisteredSession | undefined, request: AgentCloseRequest, at: number): s is RegisteredSession {
  if (!s || (request.expiresAt !== undefined && request.expiresAt <= at) || (request.onlyIfOriginalLaunch && s.startedBy !== 'agent') || new Date(s.registeredAt).toISOString() !== request.createdAt) return false
  // Asked of a harness still starting, which has bound its first conversation since the list the request was made
  // from: the same harness, and the close keeps that conversation. Refused as changed, a close sent in the seconds a
  // Codex binds was answered "changed while closing".
  return s.sessionId === request.sessionId || (request.sessionId === '' && young(s, at))
}

export interface CloseAgentServiceDeps {
  registry: Pick<typeof liveRegistry, 'byAgent' | 'list' | 'setClosePlan' | 'afterTransaction'>
  activity(s: RegisteredSession): Promise<CloseActivity>
  /** Cheap revocation after the final activity read, at each physical Stop boundary. */
  idleCurrent?(s: RegisteredSession): boolean
  checkpoint(s: RegisteredSession, phase: 'before' | 'after'): Promise<void>
  stop(agentId: string, options: StopAgentOptions): Promise<void>
  changed(s: RegisteredSession): void
  openTabs?: { assertHidden(s: RegisteredSession): Promise<void>; isHidden(s: RegisteredSession): boolean }
  /** Whether the conversation [request] names is closed already: no longer live, and kept as stopped. */
  closedAlready?(request: AgentCloseRequest): boolean
  /** Whether the agent may be the Lead of an active Swarm project (superTabs/retention.ts `mayBeLead`): never closed. */
  leadProtected?(agentId: string): boolean
  /** Whether the agent may be a Swarm Buddy (superTabs/retention.ts `mayBeBuddy`): a close never stops it. Stop Harness does. */
  buddyProtected?(agentId: string): boolean
  /** Whether its pane shows a question the engine asks before any conversation: the folder's trust, or an MCP server the
   *  folder brings (`trust_open`). */
  atStartupQuestion?(s: RegisteredSession): Promise<boolean>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** An inspect of a Buddy, read as any other, says it will keep running, so a window does not ask to stop it. */
const keptRunning = (result: AgentCloseResult): AgentCloseResult => result.activity ? { ...result, keptRunning: true } : result

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
  private readonly sleep: (ms: number) => Promise<void>
  constructor(private readonly deps: CloseAgentServiceDeps) {
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? (ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }))
  }

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
    if (!matches(current, request, this.now())) return Promise.resolve(this.changed(request))
    if (request.mode === 'cancel') { this.cancel(request.agentId); return Promise.resolve({ cancelled: true }) }
    // Refused before anything is read or saved: a Close after task once answered a Lead "deferred" (the review of #1635).
    if (request.mode !== 'inspect' && this.deps.leadProtected?.(request.agentId)) {
      return Promise.resolve({ error: 'LEAD_PROTECTED', detail: LEAD_PROTECTED_DETAIL })
    }
    const buddy = this.deps.buddyProtected?.(request.agentId) === true
    if (buddy && request.mode !== 'inspect') {
      return Promise.resolve({ error: 'BUDDY_PROTECTED', detail: BUDDY_PROTECTED_DETAIL, keptRunning: true })
    }
    // A job answers only a request of its own kind. When any job running for the agent answered every
    // request, a close asked for while another window (or the cleanup preview) was inspecting the agent
    // was answered with that inspect's `{ activity }` and never carried out, and an inspect beside a
    // close was answered `{ closed: true }` (e2e/windows.e2e.ts). A request of another kind waits for
    // the job ahead of it, then runs for itself against the agent as it was when it was asked.
    const key = jobKey(request)
    const pending = this.jobs.get(key)
    if (pending) return buddy ? pending.then(keptRunning) : pending
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
    return buddy ? job.then(keptRunning) : job
  }

  /**
   * The answer to a close of an agent that is not the one asked about. One already closed, the same conversation, is
   * closed: a window closing a tab after a pane in it, its starter, was closed takes the harnesses that starter started
   * with it (services/agentCleanup.ts), and the window's own close of them, asked a moment later, was answered
   * AGENT_CHANGED and shown as "Could not confirm that it stopped". An inspect of one is closed too: the terminal client
   * inspects before every close, and its close again of one it had closed was answered "Stop not confirmed:
   * AGENT_CHANGED". Anything else is AGENT_CHANGED.
   */
  private changed(request: AgentCloseRequest): AgentCloseResult {
    return (request.mode === 'idle' || request.mode === 'now' || request.mode === 'inspect') && this.deps.closedAlready?.(request)
      ? { closed: true } : { error: 'AGENT_CHANGED' }
  }

  private async execute(request: AgentCloseRequest, target: string, revision: number): Promise<AgentCloseResult> {
    const askedAt = this.now()
    // Read before the try: a row can be changed in place while it runs.
    const asked = this.deps.registry.byAgent(request.agentId)
    const starting = !!asked && identity(asked) === target && stillStarting(asked, askedAt) ? harnessIdentity(asked) : null
    const result = await this.attempt(request, target, revision)
    // Closed now at a question its engine asks before any conversation, never answered: it has none to keep, and none can
    // be read, so every close was refused "cannot tell which conversation it is in", for good, once it was past starting
    // (a Claude Code harness at "New MCP server found in this project", 18 minutes on, 2026-10-26). Deleting one took
    // this exception already (purgeAgentService.ts `unstartedChat`).
    if (!result.closed && request.mode === 'now' && result.error === 'IDENTITY_UNAVAILABLE' && asked && identity(asked) === target
      && unusedChat(asked) && await this.deps.atStartupQuestion?.(asked) === true) {
      const latest = this.deps.registry.byAgent(request.agentId)
      if (latest && identity(latest) === target && unusedChat(latest)) return this.attempt(request, target, revision, true)
    }
    if (result.closed || (request.mode !== 'now' && request.mode !== 'idle') || !starting) return result
    return this.whileStarting(request, starting, target, revision, askedAt + CLOSE_BIND_WAIT_MS, result)
  }

  /**
   * A harness still starting whose close did not go through: tried again while its conversation cannot be read yet, and
   * at once when it bound its first conversation while a try ran (which a try reads as the harness having changed).
   * Bound, it is closed with that conversation. One that has not bound by [deadline] is stopped without one, as asked:
   * Harness has no conversation of it to keep. Every caller gets this: the CLI and MCP, the windows, closes of many.
   */
  private async whileStarting(request: AgentCloseRequest, harness: string, target: string, revision: number, deadline: number,
    first: AgentCloseResult): Promise<AgentCloseResult> {
    const same = () => {
      const s = this.deps.registry.byAgent(request.agentId)
      return !this.disposed && (this.revisions.get(request.agentId) ?? 0) === revision && s && harnessIdentity(s) === harness
        && (request.expiresAt === undefined || request.expiresAt > this.now())
        && (!request.onlyIfOriginalLaunch || s.startedBy === 'agent') ? s : undefined
    }
    let tried = target, result = first, waiting = false
    for (;;) {
      const s = same()
      if (!s) return this.changed(request)
      const bound = identity(s) !== tried
      // Neither unreadable nor newly bound: a refusal of its own (working, a failed save), answered as it is.
      if (!bound && result.error !== 'IDENTITY_UNAVAILABLE') return result
      if (this.now() >= deadline) {
        if (bound) return this.attempt(request, identity(s), revision)
        // Bound, and still unreadable: a conversation is never let go this way.
        if (s.sessionId || s.transcriptPath || s.boundAt != null) return result
        console.log(`[close] ${sid(request.agentId)} bound no conversation within ${CLOSE_BIND_WAIT_MS / 1000}s; closing it without one`)
        return this.attempt(request, identity(s), revision, true)
      }
      if (!waiting) console.log(`[close] ${sid(request.agentId)} is still starting (${result.detail ?? result.error}); waiting for its conversation`)
      waiting = true
      if (!bound) await this.sleep(Math.min(CLOSE_BIND_RETRY_MS, deadline - this.now()))
      const latest = same()
      if (!latest) return this.changed(request)
      tried = identity(latest)
      result = await this.attempt(request, tried, revision)
      if (result.closed) return result
    }
  }

  private async attempt(request: AgentCloseRequest, target: string, revision: number, withoutConversation = false): Promise<AgentCloseResult> {
    let unkept = false
    let idleRevoked = false
    const current = () => {
      const s = this.deps.registry.byAgent(request.agentId)
      return !this.disposed && (this.revisions.get(request.agentId) ?? 0) === revision
        && s && identity(s) === target
        && (request.expiresAt === undefined || request.expiresAt > this.now())
        && (!request.onlyIfOriginalLaunch || s.startedBy === 'agent')
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
      // Closed by the job ahead of this one (another window's close, or the cleanup's): closed all the same.
      if (!s) return this.changed(request)
      const observed = await this.deps.activity(s)
      // Close belongs to the global workspace. Other viewers do not change
      // whether the session has unfinished work.
      const activity = observed === 'idle' && resumeMode(s.engine) !== 'conversation' ? 'unknown' : observed
      if (!current()) return { error: 'AGENT_CHANGED' }
      if (request.mode === 'inspect') return { activity }
      if (request.mode === 'after_task') {
        if (s.closePlan?.identity === target && s.closePlan.state === 'waiting') return { deferred: true }
        let created = false
        const updated = await this.deps.registry.afterTransaction(() => {
          const latest = current()
          if (!latest) return null
          if (latest.closePlan?.identity === target && latest.closePlan.state === 'waiting') return latest
          const saved = this.deps.registry.setClosePlan(latest.agentId, { id: randomUUID(), identity: target, requestedAt: this.now(), state: 'waiting' })
          created = !!saved
          return saved
        })
        if (!updated) return { error: 'AGENT_CHANGED' }
        this.idleSince.delete(s.agentId)
        if (created) this.deps.changed(updated)
        this.schedule()
        return { deferred: true }
      }
      if (request.mode === 'idle' && activity !== 'idle') return { error: 'SESSION_NOT_IDLE', activity }
      await this.deps.stop(s.agentId, {
        ...(withoutConversation ? { withoutConversation: () => { unkept = true } } : {}),
        current: () => {
          const latest = current()
          if (!latest) return false
          if (request.mode === 'now') return true
          // A hold after beforeStop also revokes this attempt. Remember it so
          // clearing the hold cannot revive an old command waiting in a queue.
          if (this.deps.idleCurrent?.(latest) === false) idleRevoked = true
          return !idleRevoked
        },
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
      return unkept ? { closed: true, withoutConversation: true } : { closed: true }
    } catch (error) {
      if (error instanceof CloseRefused) return { error: 'SESSION_NOT_IDLE', activity: error.activity }
      const code = (error as { code?: unknown })?.code
      // Stop keeps an uncertain physical outcome as STOP_UNCONFIRMED. When its
      // own guard specifically refused an idle close, retain the queued intent
      // exactly as beforeStop does; a service hold must never make it failed.
      if (code === 'STOP_UNCONFIRMED' && idleRevoked && current()) return { error: 'SESSION_NOT_IDLE', activity: 'unknown' }
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
            // Native identity can be between writes. Preserve the queued intent and reason
            // so the next idle tick retries before any checkpoint or process mutation.
            const changed = this.deps.registry.setClosePlan(s.agentId, { ...plan,
              state: result.error === 'IDENTITY_UNAVAILABLE' ? 'waiting' : 'failed',
              detail: result.detail ?? 'Could not save and close this session. Open it to try again.' })
            if (changed) this.deps.changed(changed)
          }
        }
      } catch (error) {
        // A missing reader is unknown activity. Keep the durable intent and expose
        // its reason while retrying, without changing a cancelled or replaced plan.
        this.idleSince.delete(s.agentId)
        const latest = this.deps.registry.byAgent(s.agentId)
        if (!this.disposed && latest?.closePlan?.id === plan.id) {
          try {
            const changed = this.deps.registry.setClosePlan(s.agentId, { ...plan, state: 'waiting',
              detail: error instanceof Error ? error.message : 'The conversation activity could not be confirmed.' })
            if (changed) this.deps.changed(changed)
          } catch { /* The preceding durable intent survives a failed reason update. Retry next tick. */ }
        }
      }
    }
  }
}
