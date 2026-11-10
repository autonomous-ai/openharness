import { logger } from '../utils/logger.js'
import type { PhoneNotice } from './sender.js'

/** How long an agent's 1:1 chat stays quiet on its person's phones once it sounded there, read or not (Tony, 2026-11-10:
 *  three or four agents writing at once rang every time their person read a chat). As the app's question notices
 *  (mobile lib/notify/agent_announcer.dart alertCooldown). */
export const CHAT_RING_EVERY_MS = 5 * 60_000

/** Which agent chats sounded lately, on every server: `claim` is true for the first claim of a key in CHAT_RING_EVERY_MS. */
export interface RingMemory { claim(key: string): Promise<boolean> }

/** One process's memory: a test's, or a server without Redis. */
export function localRingMemory(now: () => number = Date.now): RingMemory {
  const rang = new Map<string, number>()
  return {
    async claim(key) {
      const at = now()
      if ((rang.get(key) ?? -Infinity) > at - CHAT_RING_EVERY_MS) return false
      rang.set(key, at)
      if (rang.size > 10_000) for (const [k, when] of rang) if (when <= at - CHAT_RING_EVERY_MS) rang.delete(k)
      return true
    },
  }
}

/** The Redis command the memory needs: the bus' fail-fast connection (lib/bus.ts `pub`) in production. */
export interface RingRedis { set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null> }

/** Every server's memory, in Redis: one key per person and chat, gone by itself when its quiet ends. */
export function redisRingMemory(redis: RingRedis): RingMemory {
  return { claim: async key => await redis.set(`swarm:push-ring:${key}`, '1', 'PX', CHAT_RING_EVERY_MS, 'NX') === 'OK' }
}

/**
 * `notices` with each agent chat's that would sound (push/notices.ts chatNotices, key `chat:`) made quiet when that chat
 * sounded on its person's phones in the last CHAT_RING_EVERY_MS: it still shows, in the chat's one notification, with no
 * sound. Only a notice that would sound claims the chat, so a quiet one never starts its wait. A memory that fails sounds
 * them all, and says so: a notice is never lost to it.
 */
export async function quietRecent(memory: RingMemory, notices: PhoneNotice[]): Promise<PhoneNotice[]> {
  const due = notices.filter(n => !n.quiet && n.key.startsWith('chat:'))
  if (!due.length) return notices
  try {
    const claimed = await Promise.all(due.map(n => memory.claim(`${n.personId}:${n.key}`)))
    const cooling = new Set(due.filter((_, i) => !claimed[i]))
    return cooling.size ? notices.map(n => cooling.has(n) ? { ...n, quiet: true as const } : n) : notices
  } catch (error) {
    logger.warn('phone push rings not read', { chats: due.length, error: error instanceof Error ? error.message : String(error) })
    return notices
  }
}
