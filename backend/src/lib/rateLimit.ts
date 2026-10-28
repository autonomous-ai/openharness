import { logger } from '../utils/logger.js'
import { createWindowLimiter } from './windowLimiter.js'

/**
 * Rate limits every pod counts together (Stability 3.2).
 *
 * A process-local limit is multiplied by the number of processes and pods, and resets on every deploy: "60 a minute"
 * was 300 a minute on five pods. Here each limiter counts in a fixed window shared through Redis, keyed by its name,
 * the caller's key and the window. The server attaches that counter at startup (`useSharedRateCounter`); without it
 * (tests, scripts), and while it fails, each limiter counts in this process as before, which is the right way to fail:
 * a Redis outage must neither refuse everyone nor lift every limit.
 */

/** Counts one hit on each key in a window of `windowMs`, all at once, and returns each key's count after it. */
export type WindowCounter = (keys: string[], windowMs: number) => Promise<number[]>

let sharedCounter: WindowCounter | null = null
let sharedFailing = false

export function useSharedRateCounter(counter: WindowCounter | null): void {
  sharedCounter = counter
  sharedFailing = false
}

/** The counts after this hit on each key from the shared counter, or null when there is none or it failed. */
export async function countShared(keys: string[], windowMs: number): Promise<number[] | null> {
  const counter = sharedCounter
  if (!counter) return null
  try {
    const counts = await counter(keys, windowMs)
    if (sharedFailing) {
      sharedFailing = false
      logger.info('[rate-limit] shared rate limits are back')
    }
    return counts
  } catch (err) {
    if (!sharedFailing) {
      sharedFailing = true
      logger.warn('[rate-limit] shared rate limits unavailable; counting per process', { error: err instanceof Error ? err.message : String(err) })
    }
    return null
  }
}

/** The shared key of one caller's window. */
export const windowKey = (name: string, key: string, windowMs: number, now: number): string =>
  `rl:${name}:${key}:${Math.floor(now / windowMs)}`

export interface RateLimiter {
  /** Counts one request for [key] and says whether it is within the allowance. */
  allows(key: string, now?: number): Promise<boolean>
  /** Forget this process' counts. Test seam. */
  reset(): void
}

export function createRateLimiter(name: string, windowMs: number, max: number): RateLimiter {
  const local = createWindowLimiter(windowMs, max)
  return {
    async allows(key, now = Date.now()) {
      const counts = await countShared([windowKey(name, key, windowMs, now)], windowMs)
      return counts ? counts[0] <= max : local.allows(key, now)
    },
    reset: () => local.reset(),
  }
}
