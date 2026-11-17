/**
 * What happens to agents, as a service in its own process hears it (the core's side is core/agentLife.ts): the core
 * API's `agents.follow` there. It is fed by what the core tells the service (`service_event` kind `agent`) and, for a
 * service that follows agents as they run, by the catch-up it asks for each time it connects (`follow_agents`).
 *
 * The catch-up and what the core says meanwhile cross: an agent heard of since the question is newer than its answer,
 * so the answer leaves it be. One the followers were told runs that the answer does not list ended while this process
 * was not hearing (the core restarted, or the link dropped): they are told it ended.
 */
import type { AgentLife, AgentView, FollowOptions } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { agentsIn, isSession } from './processCoreApi.js'

type Payload = Record<string, unknown>
type Query = (query: string, payload?: Payload) => Promise<Payload>

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** What the core told of an agent, or null when [payload] is not one of those. */
export function agentLifeIn(payload: Payload): AgentLife | null {
  if (payload.kind !== 'agent' || !payload.event || typeof payload.event !== 'object') return null
  const event = payload.event as Payload
  if (event.kind === 'running') return isSession(event.session) ? { kind: 'running', session: event.session } : null
  if (event.kind === 'ended' || event.kind === 'stopped') return isId(event.agentId) ? { kind: event.kind, agentId: event.agentId } : null
  if (event.kind === 'purged') {
    return isId(event.agentId) && Array.isArray(event.sessionIds) ? { kind: 'purged', agentId: event.agentId, sessionIds: event.sessionIds.filter(isId) } : null
  }
  if (event.kind === 'taken') {
    return isId(event.from) && isId(event.to) ? { kind: 'taken', from: event.from, to: event.to, ...(event.guest === true ? { guest: true as const } : {}) } : null
  }
  return null
}

/** [options]: how this service follows agents as they run, as it asks the core each time it connects; `running: false`
 *  asks for none, and hears only what the core holds for it (harnessd/services.ts `hears`). */
export function followLink(options: FollowOptions, log: (line: string) => void = (line) => console.warn(line)) {
  const listeners = new Set<(event: AgentLife) => void>()
  /** The agents the followers were told run, and not since that they ended. */
  const told = new Map<string, AgentView>()
  /** Heard of while a catch-up is pending: newer than its answer. Released when it ends, so a long connection
   *  retains no ids of agents that have ended. */
  let heard: Set<string> | null = null
  /** Bumped by each connection and its end, so an answer that comes after either is not used. */
  let generation = 0
  let caughtUp = false
  let waiters: Array<(up: boolean) => void> = []

  const tell = (event: AgentLife): void => {
    for (const listener of listeners) {
      try { listener(event) } catch (error) {
        log(`[agents] a follower failed on ${event.kind}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const settle = (up: boolean): void => {
    caughtUp = up
    if (!up) return
    for (const waiter of waiters) waiter(true)
    waiters = []
  }

  return {
    /** `CoreApi.agents.follow`, for the service in this process: told at once what it was told runs, then each change. */
    follow(listener: (event: AgentLife) => void): () => void {
      listeners.add(listener)
      for (const session of told.values()) {
        try { listener({ kind: 'running', session }) } catch (error) {
          log(`[agents] a follower failed on running: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return () => { listeners.delete(listener) }
    },
    /** What the core told this service: true when it was what happens to an agent, now told the followers. */
    heard(payload: Payload): boolean {
      if (payload.kind !== 'agent') return false
      const event = agentLifeIn(payload)
      if (!event) return true
      if (event.kind === 'running') {
        heard?.add(event.session.agentId)
        told.set(event.session.agentId, event.session)
      } else if (event.kind === 'ended') {
        heard?.add(event.agentId)
        told.delete(event.agentId)
      }
      tell(event)
      return true
    },
    /** Connected to a core: asks to follow its agents, and catches up from its answer. A core that gives none (one from
     *  before this) tells this service nothing as agents run, said once a connection. */
    async connected(query: Query): Promise<void> {
      if (options.running === false) return
      const mine = ++generation
      const changed = heard = new Set<string>()
      const answer = await query('follow_agents', { ...options }).catch(() => null)
      if (mine !== generation) return
      const listed = agentsIn(answer)
      if (!listed) {
        heard = null
        log(`[agents] the core did not answer what agents to follow (${typeof answer?.error === 'string' ? answer.error : 'no answer'}): none is heard of as it runs`)
        return
      }
      const ids = new Set(listed.map((session) => session.agentId))
      for (const agentId of [...told.keys()]) {
        if (ids.has(agentId) || changed.has(agentId)) continue
        told.delete(agentId)
        tell({ kind: 'ended', agentId })
      }
      for (const session of listed) {
        if (changed.has(session.agentId) || (!options.each && !options.frames && told.has(session.agentId))) continue
        told.set(session.agentId, session)
        tell({ kind: 'running', session })
      }
      heard = null
      settle(true)
    },
    /** The connection went: an answer still on its way is not used, and the next connection catches up again. */
    disconnected(): void {
      generation++
      heard = null
      settle(false)
    },
    /** Whether this connection's catch-up is in, waiting [ms] at most for it. */
    ready(ms: number): Promise<boolean> {
      if (caughtUp) return Promise.resolve(true)
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((waiter) => waiter !== done)
          resolve(false)
        }, ms)
        timer.unref?.()
        const done = (up: boolean): void => { clearTimeout(timer); resolve(up) }
        waiters.push(done)
      })
    },
  }
}

export type FollowLink = ReturnType<typeof followLink>
