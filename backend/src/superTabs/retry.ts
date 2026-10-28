import { fail } from './model.js'

const TRANSACTION_ATTEMPTS = 8
const EXPIRED_TRANSACTION_ATTEMPTS = 2
const TRANSACTION_BACKOFF_MS = 50
const TRANSACTION_BACKOFF_CAP_MS = 1_500
const errorCode = (error: unknown): unknown => error && typeof error === 'object' && 'code' in error ? error.code : null
function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return ['P2034', 'P2002', 'P2028'].includes(errorCode(error) as string) || (error instanceof Error && error.message.includes('TransientTransactionError'))
}

/**
 * Runs one transaction `attempt` again while it fails transiently, the Swarm's one rule for it: a write conflict, a taken
 * unique key or Mongo's own transient errors, up to 8 attempts after a growing, jittered wait, then the Swarm is busy (a 503
 * every client retries). A Mongo transaction waits at most 5 ms for a lock, so a read that meets an index build's exclusive
 * lock fails at once and is tried again here (the 10-28 release). Used by the store's writes and the cache's reads alike.
 * `alsoRetry` names a caller's own failure to try again under the same limit (the store's read of a removed index).
 */
export async function retryTransient<T>(attempt: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  alsoRetry: (error: unknown) => boolean = () => false): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await attempt()
    } catch (error) {
      if (!retryable(error) && !alsoRetry(error)) throw error
      // An expired or unstartable transaction (P2028) is load: one more try, then the client retries after Retry-After.
      if (tries >= (errorCode(error) === 'P2028' ? EXPIRED_TRANSACTION_ATTEMPTS : TRANSACTION_ATTEMPTS)) {
        // A unique key still taken after every retry is a real duplicate, not contention.
        if (errorCode(error) === 'P2002') throw error
        fail('SWARM_BUSY', 'This Swarm is busy. Try again in a moment.', 503)
      }
      await sleep(Math.random() * Math.min(TRANSACTION_BACKOFF_CAP_MS, TRANSACTION_BACKOFF_MS * 2 ** (tries - 1)))
    }
  }
}
