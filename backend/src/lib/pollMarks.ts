import type { Redis } from 'ioredis'
import { pub } from './bus.js'
import { logger } from '../utils/logger.js'
import { SWEEP_EVERY_MS } from '../superTabs/liveness.js'
import type { PollMarks } from '../superTabs/store.js'

/**
 * The quiet delivery poll's memory of full polls (superTabs/store.ts `deliveries`), in Redis so every server shares it.
 *
 * Each pod kept its own until Stability 2.4 (2026-10-28): behind 5 pods a host's poll every second landed on a pod that had
 * not seen its last full poll, so each pod ran the full poll (the Swarm load and a write) for every host. Older CLIs still
 * poll each second, so this matters as much as the push. A key lives SWEEP_EVERY_MS, so nothing needs deleting.
 *
 * Redis down costs CPU, never authority: nothing is remembered and every poll runs the full checks. Said once per outage.
 */
export function redisPollMarks(redis: Pick<Redis, 'exists' | 'set'> = pub,
  warn: (message: string, meta: Record<string, unknown>) => void = (message, meta) => logger.warn(message, meta)): PollMarks {
  let failing = false
  const failed = (error: unknown) => {
    if (!failing) warn('[super-tab] delivery poll memory unavailable; every poll runs in full', { error: error instanceof Error ? error.message : String(error) })
    failing = true
  }
  const keyOf = (key: string) => `superTabs:polled:${key}`
  return {
    recent: async key => {
      try { const found = await redis.exists(keyOf(key)) === 1; failing = false; return found } catch (error) { failed(error); return false }
    },
    mark: async key => {
      try { await redis.set(keyOf(key), '1', 'PX', SWEEP_EVERY_MS); failing = false } catch (error) { failed(error) }
    },
  }
}
