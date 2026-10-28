import { z } from 'zod'
import { SWEEP_EVERY_MS } from './liveness.js'
import type { PollMemory, Polled } from './store.js'

/** The Redis commands the memory needs: the bus' fail-fast connection (lib/bus.ts `pub`) in production. */
export interface PollRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ms: number): Promise<unknown>
}

const polled = z.object({
  at: z.number().finite(),
  open: z.object({ stamp: z.number().finite(), seen: z.array(z.string()), allowed: z.array(z.string()) }).optional(),
})

/** A remembered poll as stored: JSON, or the bare time an older server wrote. Anything else was never remembered. */
function parse(value: string | null): Polled | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) return { at: Number(value) }
  try {
    const read = polled.safeParse(JSON.parse(value))
    return read.success ? read.data : undefined
  } catch {
    return undefined
  }
}

/**
 * Each caller's last full delivery poll, in Redis so every server answers the quiet poll from any server's full one (stability
 * roadmap 2.4). One key per tab, agent and caller, gone after SWEEP_EVERY_MS: an older one is never read anyway.
 */
export function redisPollMemory(redis: PollRedis): PollMemory {
  const key = (k: string) => `swarm:polled:${k}`
  return {
    get: async k => parse(await redis.get(key(k))),
    async set(k, value) { await redis.set(key(k), JSON.stringify(value), 'PX', SWEEP_EVERY_MS) },
  }
}
