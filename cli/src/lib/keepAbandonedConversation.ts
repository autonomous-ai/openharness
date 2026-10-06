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
  stoppedAgents: Pick<StoppedAgentStore, 'save' | 'get' | 'list'>
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
  return (left: RegisteredSession): void => {
    if (!left.sessionId) return
    try {
      if (stoppedAgents.list().some((saved) => saved.agentId !== left.agentId && conversation(saved) === conversation(left))) return
      const kept: RegisteredSession = { ...left, agentId: randomUUID(), processIdentity: null }
      stoppedAgents.save(kept)
      const saved = stoppedAgents.get(kept.agentId)
      if (saved) void publishStoppedAgent(saved).catch(() => {})
      console.log(`[agent] ${sid(left.agentId)} kept the conversation it left, ${sid(left.sessionId)}, as stopped harness ${sid(kept.agentId)}`)
    } catch (error) {
      console.warn(`[agent] ${sid(left.agentId)} could not keep the conversation it left, ${sid(left.sessionId)} · ${error instanceof Error ? error.message : error}`)
    }
  }
}

export type KeepAbandonedConversation = ReturnType<typeof createKeepAbandonedConversation>
