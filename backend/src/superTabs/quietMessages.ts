import { z } from 'zod'
import type { AuthUser } from '../lib/ssoAuth.js'
import { SWEEP_EVERY_MS } from './liveness.js'
import type { PollRedis } from './pollMemory.js'
import type { AgentGrant, SwarmGrant } from './store.js'

/**
 * The quiet messages poll (WebSocket roadmap, Phase 2 item 3): a client polls a conversation for messages after the last it
 * shows, and almost always there is none; each poll still loaded and reassembled the Swarm before it looked (prod,
 * 2026-10-28: messages 7.4% of the backend's busy time). After a caller's full forward read, the next ones within
 * SWEEP_EVERY_MS are answered from one indexed read while the Swarm's main stamp (cache.ts) is the one that read saw: no
 * Swarm write since, so its answer inside the Swarm (who may read the conversation, its reaction count) still holds. What
 * rests outside the Swarm (the row, a team session, the Workspace, an agent's machine and share) is checked every time.
 *
 * Off unless the server's switch (`SWARM_QUIET_MESSAGES`) gives the store a memory.
 */
export interface MessagesPolled {
  at: number
  /** The Swarm's main stamp, read before the full read loaded it. */
  stamp: number
  reactionSeq: number
  swarm: SwarmGrant
  /** The agent the caller read as: its grant, checked again on every quiet answer. A person's read has none. */
  grant?: AgentGrant
}

/** Where `messages` remembers each caller's last full forward read. Either call may throw: the poll then runs in full. */
export interface MessagesPollMemory {
  get(key: string): Promise<MessagesPolled | undefined>
  /** Remembered for SWEEP_EVERY_MS at least; an older entry is never read. */
  set(key: string, polled: MessagesPolled): Promise<void>
}

/** One key per Swarm, conversation, agent read as and caller (a team session apart from its person). */
export const messagesPollKey = (user: AuthUser, tabId: string, conversationId: string, asAgentId?: string) =>
  `${tabId}:${conversationId}:${asAgentId ?? ''}:${user.sub}${user.harnessSessionKind === 'team' ? `:team:${user.harnessComputerId ?? ''}` : ''}`

const polled = z.object({
  at: z.number().finite(),
  stamp: z.number().finite(),
  reactionSeq: z.number().int().nonnegative(),
  swarm: z.object({ workspaceId: z.string().optional(), environment: z.string() }),
  grant: z.object({ contributorId: z.string(), machineId: z.string(), machineOwnerId: z.string(), hostGrant: z.string().nullable() }).optional(),
})

/** A remembered read as stored, or nothing: anything that is not one was never remembered. */
function parse(value: string | null): MessagesPolled | undefined {
  if (value === null) return undefined
  try {
    const read = polled.safeParse(JSON.parse(value))
    return read.success ? read.data : undefined
  } catch {
    return undefined
  }
}

/** In Redis, so every server answers from any server's full read; gone after SWEEP_EVERY_MS. */
export function redisMessagesPollMemory(redis: PollRedis): MessagesPollMemory {
  const key = (k: string) => `swarm:messages-polled:${k}`
  return {
    get: async k => parse(await redis.get(key(k))),
    async set(k, value) { await redis.set(key(k), JSON.stringify(value), 'PX', SWEEP_EVERY_MS) },
  }
}
