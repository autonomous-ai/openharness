/**
 * One owner per conversation, stopped harnesses included.
 *
 * The registry already gives a running conversation one owner: "the newest bind wins", and an agent left with
 * neither a session nor a process is removed, because it can only sit in the list as a second row for the
 * same work (lib/registry.ts `register`, its `orphaned`). Stopped records were never held to that rule. A
 * conversation another harness picked up (`/resume`, `claude --resume` in a terminal, a compaction) stayed
 * claimed by the stopped harness it came from. One Mac had 18 conversations listed two or three times in Cmd-P
 * (2026-10-10, docs/research/2026-10-10-harness-data-audit.md): opening one's history read whichever record the
 * folder listed first (transcripts/history.ts), and its history could not be deleted, since another harness
 * "used" it (lib/purgeAgentService.ts).
 *
 * The same rule, applied to them: a running owner wins, else the newest binding. Every other stopped record
 * holding the conversation is set aside (moved, never deleted: `StoppedAgentStore.supersede`) and the apps
 * are told, with the owner as its successor. The transcript is untouched, and the name follows the
 * conversation (names are kept by session id, `registry.rename`). A harness that is running is never set
 * aside (its record follows it), nor one whose resume is in flight.
 */
import { isTerminalEngine } from '../../engines/types.js'
import { sid } from '../../lib/log.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'

type Frame = { type: string; payload: Record<string, unknown> }

export interface ConversationOwnersDeps {
  stoppedAgents: Pick<StoppedAgentStore, 'list' | 'get' | 'supersede' | 'resumeReservedAt'>
  /** The running harnesses (`registry.list()`). */
  live: () => readonly RegisteredSession[]
  /** The app (`send`) and the dial (`sendCommander`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void }
  /** How long a resume may hold its reservation (lib/resumeStoppedAgent.ts): an older one protects nothing. */
  reservationMs: number
  now?: () => number
}

type Owned = Pick<RegisteredSession, 'engine' | 'sessionId' | 'codexHome' | 'hermesHome'>

/**
 * A conversation, or null for a record that holds none. The same id under another Codex profile or Hermes
 * home is another conversation; a terminal holds none of its own.
 */
export function conversationKey(row: Owned): string | null {
  if (!row.sessionId || isTerminalEngine(row.engine)) return null
  return [row.engine, row.codexHome ?? '', row.hermesHome ?? '', row.sessionId].join('\u0000')
}

/** Newest binding first; then the newest record, then the id, so every daemon picks the same one. */
const newestFirst = (a: RegisteredSession, b: RegisteredSession): number =>
  (b.boundAt ?? b.registeredAt) - (a.boundAt ?? a.registeredAt)
  || b.touchedAt - a.touchedAt
  || a.agentId.localeCompare(b.agentId)

export function createConversationOwners(deps: ConversationOwnersDeps) {
  const now = deps.now ?? Date.now

  /**
   * Gives each named conversation (or every one) a single owner, and returns the ids set aside. Called as the
   * core starts, after a harness binds a conversation new to it, and after a stopped harness's last record is
   * saved: a stop can keep a conversation another harness has since taken (lib/stoppedAgents.ts `save`).
   */
  const settle = (keys?: ReadonlyArray<string | null>): string[] => {
    const wanted = keys ? new Set(keys.filter((key): key is string => !!key)) : null
    if (wanted?.size === 0) return []
    const live = deps.live()
    const running = new Set(live.map((row) => row.agentId))
    const groups = new Map<string, { live: RegisteredSession[]; stopped: RegisteredSession[] }>()
    const add = (row: RegisteredSession, side: 'live' | 'stopped'): void => {
      const key = conversationKey(row)
      if (!key || (wanted && !wanted.has(key))) return
      const group = groups.get(key) ?? { live: [], stopped: [] }
      group[side].push(row)
      groups.set(key, group)
    }
    for (const row of live) add(row, 'live')
    // A running harness's own record follows it and is never a second owner.
    for (const row of deps.stoppedAgents.list()) if (!running.has(row.agentId)) add(row, 'stopped')
    const setAside: string[] = []
    for (const group of groups.values()) {
      if (!group.stopped.length || group.live.length + group.stopped.length < 2) continue
      // The registry keeps one running owner per conversation; a stopped record never outranks it.
      const owner = group.live[0] ?? [...group.stopped].sort(newestFirst)[0]
      for (const row of group.stopped) {
        if (row.agentId === owner.agentId) continue
        const reserved = deps.stoppedAgents.resumeReservedAt(row.agentId)
        if (reserved !== null && now() - reserved <= deps.reservationMs) continue
        try {
          if (!deps.stoppedAgents.supersede(row.agentId)) continue
        } catch (error) {
          console.warn(`[agent] ${sid(row.agentId)} could not be set aside for ${sid(owner.agentId)} · ${error instanceof Error ? error.message : error}`)
          continue
        }
        setAside.push(row.agentId)
        console.log(`[agent] ${sid(row.agentId)} set aside: ${sid(owner.agentId)} owns conversation ${sid(row.sessionId)} now`)
        deps.clients.send({ type: 'agent_deleted', payload: { agentId: row.agentId, retained: false, successor: owner.agentId } })
        deps.clients.sendCommander({ type: 'agent_deleted', payload: { agentId: row.agentId } })
      }
    }
    return setAside
  }

  /**
   * Settles the conversation a stopped harness's record holds as saved, which can be one the row given to the
   * save no longer named (`StoppedAgentStore.save` keeps a known conversation through an unbound observation).
   */
  const settleSaved = (agentId: string): string[] => {
    const saved = deps.stoppedAgents.get(agentId)
    return saved ? settle([conversationKey(saved)]) : []
  }

  return { settle, settleSaved }
}

export type ConversationOwners = ReturnType<typeof createConversationOwners>
