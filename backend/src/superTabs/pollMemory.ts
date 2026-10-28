import { SWEEP_EVERY_MS } from './liveness.js'
import type { PollMemory } from './store.js'

/** The Redis commands the memory needs: the bus' fail-fast connection (lib/bus.ts `pub`) in production. */
export interface PollRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
}

/**
 * Each caller's last full delivery poll, in Redis so every server answers the quiet poll from any server's full one (stability
 * roadmap 2.4). One key per tab, agent and caller, gone after SWEEP_EVERY_MS: an older one is never read anyway.
 */
export function redisPollMemory(redis: PollRedis): PollMemory {
  const key = (k: string) => `swarm:polled:${k}`
  return {
    async get(k) {
      const value = Number(await redis.get(key(k)) ?? NaN)
      return Number.isFinite(value) ? value : undefined
    },
    async set(k, at) { await redis.set(key(k), String(at), 'PX', SWEEP_EVERY_MS) },
  }
}
