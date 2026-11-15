/**
 * What happens to agents, for the services that follow it: one shape (core/api.ts `AgentLife`) where each service that
 * was told had a port member of its own, the viewers' attach and detach, the agent cleanup's `closed`, search's purged
 * conversations and the agent browser's attached, stopped, deleted and moved. The core names no follower here, and keeps
 * for one only which agents it was told run: bounded by the live agents.
 *
 * - **In the core's process** a service follows with `CoreApi.agents.follow`: told at once every live agent it follows,
 *   then each change as it happens. A follower that throws is said in the log; the others and the core go on.
 * - **In its own process** a service asks `follow_agents` each time it connects, with how it follows. It is answered the
 *   live agents it follows, its catch-up (a process that restarted, or a core that did, starts from it), and then told
 *   each change (`service_event` kind `agent`). The subscription goes with its connection.
 * - **What one must not miss while its process is down** (`stopped`, `purged`, `taken`: a harness's children left open,
 *   a deleted conversation left searchable, a browser's logins left with an agent that ended) is held for it until it
 *   hears it, from the core's start, for each service its process says hears that kind (harnessd/services.ts `hears`),
 *   as each was held before this shape (core/serviceLinks.ts `untilDelivered`).
 *
 * `running` is said at every look at an agent: a create, a fork, a resume, a start's restore, every scan. A follower that
 * asks for each (`each`) hears every one, as a harness's viewer was attached: a look may be the first to find an agent's
 * harness, and a viewer follows its harness's update. Any other hears it once each time the agent starts running here, so
 * an idle daemon's scans cost it nothing. `having` narrows it to the agents whose row has those fields set (the viewers:
 * `dsh`). `ended` goes to a follower that was told the agent running.
 */
import { FOLLOW_HAVING_MAX, type AgentLife, type FollowOptions, type HeldAgentLife } from './api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { ServiceFrame } from './serviceLinks.js'

type Payload = Record<string, unknown>

/** The longest field name a follower may ask an agent's row to have. */
const FIELD_MAX = 64
/** The most conversations a purge names: more than any harness has. */
export const PURGED_SESSIONS_MAX = 256
/** Past this many agents told running and not ended, a follower's are pruned to the live ones: an end that never came
 *  (a row gone some way that skipped its forget) costs it nothing for good. */
export const TOLD_PRUNE_AT = 4096

interface Follower {
  options: Readonly<FollowOptions>
  /** The agents it was told running and not since ended. */
  told: Set<string>
  tell(event: AgentLife): void
}

export interface AgentLifeDeps {
  /** The live agents, as the registry holds them now. */
  live(): RegisteredSession[]
  /** Tell a service in its own process (core/serviceLinks.ts `notify`), held until it hears it with `untilDelivered`. */
  notify(service: string, frame: ServiceFrame, opts?: { untilDelivered?: boolean }): boolean
  /** The services in their own processes that hear these kinds even while down (harnessd/services.ts `hears`). */
  hears: Readonly<Record<string, readonly HeldAgentLife[]>>
  log?: (line: string) => void
}

/** A follower's options as a service's process sent them (`follow_agents`), or null when they are not: a filter that
 *  was not understood would tell the process every agent at every look. */
export function followOptions(raw: Payload): FollowOptions | null {
  const { each, having, running } = raw
  if ((each !== undefined && typeof each !== 'boolean') || (running !== undefined && typeof running !== 'boolean')) return null
  if (having !== undefined && (!Array.isArray(having) || having.length > FOLLOW_HAVING_MAX
    || !having.every((field) => typeof field === 'string' && field.length > 0 && field.length <= FIELD_MAX))) return null
  return { ...(each ? { each } : {}), ...(having?.length ? { having: having as string[] } : {}), ...(running === false ? { running } : {}) }
}

/** Whether [session]'s row has every field [options] asks for, set. Said for every follower at every look at every
 *  agent, so it allocates nothing. */
function matches(options: FollowOptions, session: RegisteredSession): boolean {
  if (!options.having) return true
  const row = session as unknown as Payload
  for (const field of options.having) if (!Object.hasOwn(row, field) || !row[field]) return false
  return true
}

const frameOf = (event: AgentLife): ServiceFrame => ({ type: 'service_event', payload: { kind: 'agent', event } })

export function createAgentLife(deps: AgentLifeDeps) {
  const log = deps.log ?? ((line: string) => console.warn(line))
  /** The followers in this process. */
  const listeners = new Set<Follower>()
  /** The services in their own processes that asked to follow, by service: the connection that asked last. */
  const processes = new Map<string, Follower>()

  const tellAll = (event: AgentLife & { kind: HeldAgentLife }): void => {
    for (const follower of listeners) follower.tell(event)
    for (const [service, kinds] of Object.entries(deps.hears)) {
      if (kinds.includes(event.kind)) deps.notify(service, frameOf(event), { untilDelivered: true })
    }
  }
  const told = (follower: Follower, agentId: string): void => {
    follower.told.add(agentId)
    if (follower.told.size <= TOLD_PRUNE_AT) return
    const live = new Set(deps.live().map((session) => session.agentId))
    for (const id of follower.told) if (!live.has(id)) follower.told.delete(id)
  }
  /** The live agents [follower] follows, now told running: what it starts from. */
  const catchUp = (follower: Follower): RegisteredSession[] => {
    if (follower.options.running === false) return []
    const agents = deps.live().filter((session) => matches(follower.options, session))
    for (const session of agents) told(follower, session.agentId)
    return agents
  }

  return {
    /** A look at a live agent: a create, a fork, a resume, a start's restore, a scan (every agent, every 5 s at idle). */
    running(session: RegisteredSession): void {
      const look = (follower: Follower): void => {
        if (follower.options.running === false || !matches(follower.options, session)) return
        if (!follower.options.each && follower.told.has(session.agentId)) return
        told(follower, session.agentId)
        follower.tell({ kind: 'running', session })
      }
      for (const follower of listeners) look(follower)
      for (const follower of processes.values()) look(follower)
    },
    /** It stopped running here: every way an agent stops running passes through this. */
    ended(agentId: string): void {
      for (const follower of [...listeners, ...processes.values()]) if (follower.told.delete(agentId)) follower.tell({ kind: 'ended', agentId })
    },
    /** A person or an agent stopped it, and the stop is done. */
    stopped(agentId: string): void { tellAll({ kind: 'stopped', agentId }) },
    /** Deleted for good, with [sessionIds], every conversation it had. */
    purged(agentId: string, sessionIds: readonly string[]): void {
      tellAll({ kind: 'purged', agentId, sessionIds: sessionIds.slice(0, PURGED_SESSIONS_MAX) })
    },
    /** [to] took the pane [from] ended in. */
    taken(from: string, to: RegisteredSession): void {
      tellAll({ kind: 'taken', from, to: to.agentId, ...(to.guest ? { guest: true as const } : {}) })
    },

    /** `CoreApi.agents.follow`, for a service in the core's process. */
    follow(listener: (event: AgentLife) => void, options: FollowOptions = {}): () => void {
      const follower: Follower = {
        options,
        told: new Set(),
        tell: (event) => {
          try { listener(event) } catch (error) {
            log(`[agents] a follower failed on ${event.kind}: ${error instanceof Error ? error.message : String(error)}`)
          }
        },
      }
      listeners.add(follower)
      for (const session of catchUp(follower)) follower.tell({ kind: 'running', session })
      return () => { listeners.delete(follower) }
    },
    /** A service's process asked to follow (`follow_agents`): its catch-up, or why not. */
    followed(service: string, payload: Payload): Payload {
      const options = followOptions(payload)
      if (!options) return { error: 'INVALID_REQUEST' }
      const follower: Follower = { options, told: new Set(), tell: (event) => { deps.notify(service, frameOf(event)) } }
      processes.set(service, follower)
      return { agents: catchUp(follower) }
    },
    /** A service's process went: what it followed goes with its connection, and its next one asks again. */
    disconnected(service: string): void { processes.delete(service) },
  }
}

export type AgentLifeHub = ReturnType<typeof createAgentLife>
