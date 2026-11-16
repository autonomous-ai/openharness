/**
 * A tool's watch on the harnesses it named (`agents_watch`): an agent's `harness wait` and `watch`
 * (agentClient/commands.ts) are told when one of them changes, instead of asking for the whole list every 3 s
 * (docs/design/2026-11-12-hachi.md, "push, not poll"). The windows here get every event already; a tool connection
 * gets nothing else of this computer's, and of these only names and states: never what a harness wrote, its
 * question's words included, which a tool reads with `harness show` when it needs them.
 */
type Frame = { type?: unknown; agentId?: unknown; payload?: unknown; subagent?: unknown }

/** The events a watch is told: a harness's activity changing, its turn ending, a question opening or closing, and the
 *  harness going. `turn_heartbeat` is how the daemon says a harness works (core/turns/heartbeats.ts), and is told as
 *  the `agent_activity` it would be for any other state. */
const TOLD = new Set(['agent_activity', 'turn_heartbeat', 'turn_ended', 'commander_question', 'commander_question_close', 'agent_deleted'])

/** As many harnesses as one agent may have running (agentClient/commands.ts `SPAWN_LIMITS.livePerHarness`). */
export const TOOL_WATCH_MAX_AGENTS = 8
/** Watches on this computer, one a connection: above the 40 harnesses it runs (`SPAWN_LIMITS.livePerMachine`), each of
 *  which may be waiting on its own. One more is refused, and its verb looks every 3 s as it did before. */
export const TOOL_WATCHES_MAX = 64
const AGENT_ID_MAX = 128

/** What one watch last told of each harness it names, so a fact sent down several paths is told once. */
interface Told { state?: string; question?: string; deleted?: boolean }

export interface ToolWatchesDeps {
  /** One frame to one connection here; false when it is gone. */
  sendTo(connId: string, frame: Record<string, unknown>): boolean
}

export function createToolWatches(deps: ToolWatchesDeps) {
  const watches = new Map<string, Map<string, Told>>()

  /** The frame [watch] is told of [frame] about [agentId], or null when it is nothing new. */
  const toldOf = (type: string, agentId: string, payload: Record<string, unknown>, told: Told, quiet: boolean): Record<string, unknown> | null => {
    if (type === 'commander_question' || type === 'commander_question_close') {
      // Every question has its id (core/questions.ts, core/agents/cloud.ts).
      const requestId = payload.requestId
      const key = `${type}:${String(requestId)}`
      if (told.question === key) return null
      told.question = key
      return { type, agentId, payload: { agentId, requestId } }
    }
    if (type === 'agent_deleted') {
      if (told.deleted) return null
      told.deleted = true
      return { type, agentId, payload: { agentId } }
    }
    const activity = payload.activity as { state?: unknown } | undefined
    const state = typeof activity?.state === 'string' ? activity.state : type === 'turn_ended' ? 'idle' : null
    // Every turn's end is told, though the state is idle as before: the turn after a short one may not have beaten once.
    // A turn end no one asked for (core/turns/funnel.ts `subagent`: a specialist's, or one Hachi's wake started) says so:
    // Hachi counts its person's turns apart from its wakes' (docs/design/2026-11-12-hachi.md, Measures).
    if (type === 'turn_ended') { told.state = state!; return { type, agentId, payload: { agentId, state, ...(quiet ? { subagent: true } : {}) } } }
    if (!state || told.state === state) return null
    told.state = state
    return { type: 'agent_activity', agentId, payload: { agentId, state } }
  }

  return {
    /** [connId] watches [agentIds] from now on, in place of what it watched; none ends its watch. */
    watch(connId: string, tool: boolean, agentIds: unknown): Record<string, unknown> {
      if (!tool) return { error: 'UNSUPPORTED', message: 'A window is sent every event already.' }
      if (!Array.isArray(agentIds) || agentIds.some((id) => typeof id !== 'string' || !id || id.length > AGENT_ID_MAX)) {
        return { error: 'BAD_REQUEST', message: 'agentIds is a list of harness ids.' }
      }
      const named = new Set(agentIds as string[])
      if (named.size > TOOL_WATCH_MAX_AGENTS) return { error: 'TOO_MANY', message: `A watch names at most ${TOOL_WATCH_MAX_AGENTS} harnesses.` }
      if (!named.size) { watches.delete(connId); return { ok: true } }
      if (!watches.has(connId) && watches.size >= TOOL_WATCHES_MAX) return { error: 'TOO_MANY', message: `At most ${TOOL_WATCHES_MAX} watches at once.` }
      watches.set(connId, new Map([...named].map((id) => [id, {}])))
      return { ok: true }
    },
    /** Whether a tool follows [agentId]: the daemon then looks for its question as for a window's (core/questions.ts). */
    follows(agentId: string): boolean {
      for (const named of watches.values()) if (named.has(agentId)) return true
      return false
    },
    /** The connection went: its watch with it. */
    closed(connId: string): void { watches.delete(connId) },
    /** A frame the daemon sends its windows or devices: told to each watch naming its harness. */
    tell(frame: Frame): void {
      if (!watches.size || typeof frame.type !== 'string' || !TOLD.has(frame.type)) return
      const payload = (frame.payload ?? {}) as Record<string, unknown>
      const agentId = typeof frame.agentId === 'string' ? frame.agentId : typeof payload.agentId === 'string' ? payload.agentId : ''
      if (!agentId) return
      for (const [connId, named] of watches) {
        const told = named.get(agentId)
        const sent = told && toldOf(frame.type, agentId, payload, told, frame.subagent === true)
        if (sent && !deps.sendTo(connId, sent)) watches.delete(connId)
      }
    },
  }
}

export type ToolWatches = ReturnType<typeof createToolWatches>
