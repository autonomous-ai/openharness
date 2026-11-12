/**
 * Another of the owner's machines following harnesses here, by push (docs/design/2026-11-12-hachi.md, "Across machines").
 *
 * Without it a harness's changes do not leave this machine while no app views it: the gateway holds `agent_activity` and
 * `turn_ended` off the relay (`UI_GATED_EVENTS`), so a daemon elsewhere waiting on one asked for the whole agent list
 * every 3 s. Now it asks once, `harness_watch { agentIds }`, over its own relay connection (a background relay the
 * backend counts as no app, `relayIsolation`), and is answered with what each harness is doing; from then on each change
 * is sealed to that one connection as `harness_event { agentId, state }`, whatever the viewer gate says. It is told names
 * and states only, never what a harness wrote: a question's words could read as instructions to the agent that waits.
 *
 * The gateway keeps it because it sees every state frame the core sends its remote clients before the gate holds any,
 * hears each connection go (`__client_disconnected`), and seals to one connection. It reads the frames; it adds none.
 *
 * A watch is a lease: 5 minutes, renewed by asking again (the answer says when, at 4), gone with its connection or an
 * empty list. At most 8 harnesses a watch (what one agent may run, agentClient/commands.ts `SPAWN_LIMITS`) and 4 watches
 * on this machine: a fifth is refused, and its asker looks every 3 s as it did before.
 */
type Frame = Record<string, unknown>

export const HARNESS_WATCH_LEASE_MS = 5 * 60_000
export const HARNESS_WATCH_RENEW_MS = 4 * 60_000
export const HARNESS_WATCH_MAX_AGENTS = 8
export const HARNESS_WATCHES_MAX = 4
/** The harnesses whose last state is kept for an answer: past it the oldest heard of is forgotten and reads `unknown`. */
const KNOWN_MAX = 512
const AGENT_ID_MAX = 128

/** A closed list: what an asker can act on, never what a harness said. */
export type HarnessState = 'working' | 'idle' | 'needs_person' | 'stopped' | 'gone' | 'unknown'

interface Known {
  /** What it is doing, as the core's activity says: working or idle, or stopped. */
  doing: 'working' | 'idle' | 'stopped' | 'unknown'
  /** The questions it waits on the person for, by request id. */
  asking: Set<string>
}

interface Lease { until: number; told: Map<string, HarnessState> }

export interface HarnessWatchDeps {
  /** A `harness_event` sealed to [connId] alone; false when that connection has no session any more. */
  send(connId: string, payload: { agentId: string; state: HarnessState }): boolean
  now?(): number
}

const stateOf = (known: Known | undefined): HarnessState =>
  !known ? 'unknown' : known.doing === 'stopped' ? 'stopped' : known.asking.size ? 'needs_person' : known.doing

export function createHarnessWatches(deps: HarnessWatchDeps) {
  const now = deps.now ?? Date.now
  const known = new Map<string, Known>()
  const leases = new Map<string, Lease>()

  const live = (connId: string, lease: Lease): boolean => {
    if (lease.until > now()) return true
    leases.delete(connId)
    return false
  }

  const learn = (agentId: string): Known => {
    let entry = known.get(agentId)
    if (!entry) {
      entry = { doing: 'unknown', asking: new Set() }
      known.set(agentId, entry)
      if (known.size > KNOWN_MAX) known.delete(known.keys().next().value!)
    }
    return entry
  }

  const tell = (agentId: string, state: HarnessState): void => {
    for (const [connId, lease] of leases) {
      if (!live(connId, lease) || !lease.told.has(agentId) || lease.told.get(agentId) === state) continue
      lease.told.set(agentId, state)
      if (!deps.send(connId, { agentId, state })) leases.delete(connId)
    }
  }

  const doingOf = (activity: unknown): Known['doing'] | null => {
    const state = (activity as { state?: unknown } | undefined)?.state
    return state === 'working' || state === 'idle' ? state : null
  }

  return {
    /** [connId] asks to follow [payload.agentIds], or to stop with none: the answer, or a refusal by name. */
    watch(connId: string, payload: Frame): Frame {
      const ids = payload.agentIds
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id || id.length > AGENT_ID_MAX)) {
        return { error: 'BAD_REQUEST', message: 'agentIds is a list of harness ids.' }
      }
      const named = [...new Set(ids as string[])]
      if (!named.length) { leases.delete(connId); return { ok: true } }
      if (named.length > HARNESS_WATCH_MAX_AGENTS) return { error: 'TOO_MANY', message: `A watch names at most ${HARNESS_WATCH_MAX_AGENTS} harnesses.` }
      const others = [...leases].filter(([id, lease]) => id !== connId && live(id, lease)).length
      if (others >= HARNESS_WATCHES_MAX) return { error: 'TOO_MANY', message: `At most ${HARNESS_WATCHES_MAX} machines watch harnesses here at once.` }
      const agents = named.map((agentId) => ({ agentId, state: stateOf(known.get(agentId)) }))
      leases.set(connId, { until: now() + HARNESS_WATCH_LEASE_MS, told: new Map(agents.map((a) => [a.agentId, a.state])) })
      return { leaseMs: HARNESS_WATCH_LEASE_MS, renewMs: HARNESS_WATCH_RENEW_MS, agents }
    },

    /** A frame the core sends its remote clients: what it changes of a harness, told to every watch naming it. */
    observe(frame: Frame): void {
      const type = frame.type
      const payload = (frame.payload ?? {}) as Frame
      if (type === 'agent_synced') {
        const agent = payload.agent as { id?: unknown; status?: unknown; activity?: unknown } | undefined
        if (typeof agent?.id !== 'string') return
        const entry = learn(agent.id)
        entry.doing = agent.status === 'stopped' ? 'stopped' : doingOf(agent.activity) ?? entry.doing
        tell(agent.id, stateOf(entry))
        return
      }
      const agentId = typeof frame.agentId === 'string' ? frame.agentId : typeof payload.agentId === 'string' ? payload.agentId : ''
      if (!agentId) return
      if (type === 'agent_deleted') {
        known.delete(agentId)
        tell(agentId, 'gone')
        return
      }
      const entry = learn(agentId)
      if (type === 'agent_activity' || type === 'turn_heartbeat') entry.doing = doingOf(payload.activity) ?? entry.doing
      // A turn shorter than a heartbeat (core/turns/heartbeats.ts) says it worked only by starting.
      else if (type === 'turn_started') entry.doing = 'working'
      else if (type === 'turn_ended') entry.doing = 'idle'
      else if (type === 'commander_question' && typeof payload.requestId === 'string') entry.asking.add(payload.requestId)
      else if (type === 'commander_question_close' && typeof payload.requestId === 'string') entry.asking.delete(payload.requestId)
      else return
      tell(agentId, stateOf(entry))
    },

    /** The connection went: its lease with it. */
    closed(connId: string): void { leases.delete(connId) },
    /** The link went: every remote connection with it. */
    clear(): void { leases.clear() },
  }
}

export type HarnessWatches = ReturnType<typeof createHarnessWatches>
