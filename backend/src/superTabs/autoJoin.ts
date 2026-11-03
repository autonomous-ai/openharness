/**
 * People at the owner's email domain join a Swarm by themselves (docs/specs/2026-11-03-swarm-domain-auto-join.md). The join is
 * a pull on the person's own list read: no invitation, link or click. It acts as the joining person alone, never the owner.
 */
import type { AuthUser } from '../lib/ssoAuth.js'
import { emailDomain, isPublicEmailDomain } from '../lib/publicEmailDomains.js'
import { isTeamSession } from '../lib/teamSession.js'
import { logger } from '../utils/logger.js'

/** How often one person is tried: list reads are polled every few seconds, so a join can take up to this long (spec, my call). */
export const AUTO_JOIN_EVERY_MS = 120_000
/** Swarms joined per try; more are joined on later tries. */
export const AUTO_JOIN_LIMIT = 10

/** What one Swarm's try came to (SuperTabStore.autoJoinSwarm): joined now; nothing to do (off, full, a member, declined
 *  already, or gone); or declined now because the Workspace removed the person. */
export type AutoJoinOutcome = 'joined' | 'skipped' | 'declined'

/** When each person was last tried, shared by every server. `claim` is true when the person may be tried now, and marks them
 *  tried for AUTO_JOIN_EVERY_MS before any read. It may throw: the person is then tried anyway, as other poll memories do. */
export interface AutoJoinMemory { claim(key: string): Promise<boolean> }

export interface AutoJoinDeps {
  memory: AutoJoinMemory
  /** Up to `limit` Swarms of `domain` with auto-join on that the person is not in and never declined: one indexed read. */
  find(user: AuthUser, domain: string, limit: number): Promise<string[]>
  /** Joins the person to one Swarm in its own transaction, rechecking everything there. */
  join(user: AuthUser, tabId: string): Promise<AutoJoinOutcome>
}

/** Joins `user` to the Swarms of their own email domain whose owners turned auto-join on. Never throws: a list read answers
 *  anyway. Returns the Swarms joined now. */
export async function autoJoin(deps: AutoJoinDeps, user: AuthUser): Promise<string[]> {
  const domain = emailDomain(user.email)
  if (!domain || isPublicEmailDomain(domain) || isTeamSession(user)) return []
  const due = await deps.memory.claim(`${user.autonomousEnv}:${user.sub}`).catch(error => {
    logger.warn('[super-tab] auto-join memory unavailable', { error: error instanceof Error ? error.message : String(error) })
    return true
  })
  if (!due) return []
  let tabIds: string[]
  try {
    tabIds = await deps.find(user, domain, AUTO_JOIN_LIMIT)
  } catch (error) {
    logger.warn('[super-tab] auto-join read failed', { userId: user.sub, error: error instanceof Error ? error.message : String(error) })
    return []
  }
  const joined: string[] = []
  for (const tabId of tabIds) {
    try {
      if (await deps.join(user, tabId) === 'joined') joined.push(tabId)
    } catch (error) {
      // Tried again once the person's 2-minute mark expires.
      logger.warn('[super-tab] auto-join failed', { tabId, userId: user.sub, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return joined
}

/** One server's own memory. */
export function localAutoJoinMemory(now: () => number): AutoJoinMemory {
  const tried = new Map<string, number>()
  return {
    async claim(key) {
      const at = now()
      if ((tried.get(key) ?? -Infinity) > at - AUTO_JOIN_EVERY_MS) return false
      tried.set(key, at)
      if (tried.size > 10_000) for (const [k, when] of tried) if (when <= at - AUTO_JOIN_EVERY_MS) tried.delete(k)
      return true
    },
  }
}

/** The Redis command the memory needs: the bus' fail-fast connection (lib/bus.ts `pub`) in production. */
export interface AutoJoinRedis { set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<string | null> }

/** Every server's memory: one `SET NX PX`, which claims and marks the person in one step. */
export function redisAutoJoinMemory(redis: AutoJoinRedis): AutoJoinMemory {
  return { claim: async key => await redis.set(`swarm:auto-join:${key}`, '1', 'PX', AUTO_JOIN_EVERY_MS, 'NX') === 'OK' }
}
