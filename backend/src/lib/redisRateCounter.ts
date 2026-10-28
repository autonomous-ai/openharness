import type { Redis } from 'ioredis'
import type { WindowCounter } from './rateLimit.js'

// One INCR per key, and its expiry set with the window's first hit: the window is in the key, so the expiry only
// cleans up. A single EVAL, not a MULTI, so it rides the command circuit breaker (lib/redisGuard.ts) and a stuck Redis
// costs a request nothing once the breaker is open.
const COUNT_SCRIPT = `
local counts = {}
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  if n == 1 then redis.call('PEXPIRE', key, ARGV[1]) end
  counts[i] = n
end
return counts`

/** The shared counter for lib/rateLimit.ts over a Redis connection. */
export function redisWindowCounter(redis: Pick<Redis, 'eval'>): WindowCounter {
  return async (keys, windowMs) => {
    const counts = await redis.eval(COUNT_SCRIPT, keys.length, ...keys, Math.max(1, Math.floor(windowMs))) as number[]
    return counts.map(Number)
  }
}
