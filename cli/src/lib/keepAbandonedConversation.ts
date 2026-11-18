/**
 * A conversation the daemon itself left for a new one, kept as a stopped harness of its own.
 *
 * Three relaunches fall back to a new conversation when the engine cannot reopen the one the agent was
 * in, so that the agent goes on working: a restart and a retarget (restartAgent.ts) and the restore after
 * a reboot (restoreAgents.ts). The agent then follows the new conversation, and the bind that points it
 * there also rewrites the agent's own stopped record, so the one it left was no longer listed,
 * `session_get` could not find it, and nothing could resume it (round 24). It is kept under an identity
 * of its own, without the process, which stays the live agent's.
 *
 * Only what the daemon abandoned. A /clear or /new is the person's own choice and keeps nothing: people
 * who clear often would pile up stopped rows.
 */
import { randomUUID } from 'node:crypto'
import { sid } from './log.js'
import type { RegisteredSession } from './registry.js'
import type { StoppedAgentStore } from './stoppedAgents.js'

export interface KeepAbandonedConversationDeps {
  stoppedAgents: Pick<StoppedAgentStore, 'save' | 'get' | 'query' | 'prepareSave'>
  /** Tells the windows of a stopped harness (BackendSocket.publishStoppedAgent). */
  publishStoppedAgent: (saved: RegisteredSession) => Promise<void>
}

/** One conversation: the same id under another Codex profile is another one. */
const conversation = (row: RegisteredSession) => `${row.engine}\u0000${row.codexHome ?? ''}\u0000${row.sessionId}`

export function createKeepAbandonedConversation({ stoppedAgents, publishStoppedAgent }: KeepAbandonedConversationDeps) {
  /**
   * Keeps `left`, the agent's row as it was in the conversation it left. Saved once: a conversation
   * already kept is not kept again, though the agent's own record does not count, since it follows the
   * agent into its new conversation (bind.ts). Never in the way of the relaunch: a failure is only said.
   */
  const running = new Map<string, Promise<void>>()
  const keep = async (left: RegisteredSession): Promise<void> => {
    if (!left.sessionId) return
    try {
      stoppedAgents.prepareSave()
      const archive = await stoppedAgents.query({ kind: 'conversations', ids: [left.sessionId], exceptAgentId: left.agentId, reservations: false,
        scope: { engine: left.engine, codexHome: left.codexHome ?? null } })
      if (archive.matches[0]) return
      if (!archive.current()) throw new Error('The saved conversation catalog changed.')
      const kept: RegisteredSession = { ...left, agentId: randomUUID(), processIdentity: null }
      await stoppedAgents.save(kept, undefined, archive.current)
      const saved = await stoppedAgents.get(kept.agentId)
      if (saved) void publishStoppedAgent(saved).catch(() => {})
      console.log(`[agent] ${sid(left.agentId)} kept the conversation it left, ${sid(left.sessionId)}, as stopped harness ${sid(kept.agentId)}`)
    } catch (error) {
      console.warn(`[agent] ${sid(left.agentId)} could not keep the conversation it left, ${sid(left.sessionId)} · ${error instanceof Error ? error.message : error}`)
    }
  }
  return (left: RegisteredSession): Promise<void> => {
    left = structuredClone(left)
    const key = conversation(left), pending = running.get(key)
    if (pending) return pending
    if (running.size >= 64) { console.warn('[agent] saved conversation queue is full'); return Promise.resolve() }
    const task = keep(left).finally(() => { if (running.get(key) === task) running.delete(key) })
    running.set(key, task)
    return task
  }
}

export type KeepAbandonedConversation = ReturnType<typeof createKeepAbandonedConversation>
