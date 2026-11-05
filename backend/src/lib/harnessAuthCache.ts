import { randomBytes } from 'node:crypto'
import { pub } from './bus.js'
import type { AuthUser } from './ssoAuth.js'

/**
 * A Harness sign-in each pod remembers for [AUTH_CACHE_TTL_MS], so a request signed in with a Harness session does
 * not read its session row and its user row from Mongo every time (task #3041: `harness_sessions` 47 reads/s and
 * `users` 53/s on the primary, nearly all of them this check).
 *
 * Revocation still takes effect at once, on every pod: each person has a sign-in EPOCH in Redis, read in the same
 * call that reads the access token (lib/harnessSession.ts). Every write that ends a session or changes what a sign-in
 * answers sets it to a new random value, after the write ([signInsChanged]); a remembered sign-in whose epoch moved is
 * read from Mongo again. The miss path reads the epoch before the session and the user, so a sign-out that lands
 * between those reads leaves the remembered epoch stale rather than being missed.
 */

export const AUTH_CACHE_TTL_MS = 30_000
/** Far past [AUTH_CACHE_TTL_MS]: an epoch that expired only costs a pod one read from Mongo. */
export const AUTH_EPOCH_TTL_SEC = 60 * 60
const AUTH_CACHE_MAX = 20_000

export const authEpochKey = (userId: string): string => `hnauth:epoch:${userId}`

export interface RememberedSignIn {
  sessionId: string
  userId: string
  /** The person's epoch as read before the session and the user were; null when Redis held none. */
  epoch: string | null
  user: AuthUser
}

export interface AuthCache {
  get(tokenHash: string): RememberedSignIn | undefined
  set(tokenHash: string, entry: RememberedSignIn): void
  delete(tokenHash: string): void
  clear(): void
  size(): number
}

/** A map of at most [max] sign-ins, each forgotten [AUTH_CACHE_TTL_MS] after it was remembered, oldest dropped first. */
export function createAuthCache({ max = AUTH_CACHE_MAX, now = () => Date.now() }: { max?: number; now?: () => number } = {}): AuthCache {
  const entries = new Map<string, { at: number; entry: RememberedSignIn }>()
  return {
    get(tokenHash) {
      const held = entries.get(tokenHash)
      if (!held) return undefined
      if (now() - held.at >= AUTH_CACHE_TTL_MS) { entries.delete(tokenHash); return undefined }
      return held.entry
    },
    set(tokenHash, entry) {
      entries.delete(tokenHash)
      entries.set(tokenHash, { at: now(), entry })
      // A Map keeps insertion order, so its first key is the oldest.
      while (entries.size > max) entries.delete(entries.keys().next().value!)
    },
    delete(tokenHash) { entries.delete(tokenHash) },
    clear() { entries.clear() },
    size() { return entries.size },
  }
}

export const harnessAuthCache = createAuthCache()

/**
 * The sign-ins of [userIds] changed: a session ended, or what their user row answers did. Call it AFTER the database
 * write. It throws when an epoch cannot be written, so a caller never reports a sign-out other pods may still serve.
 * A random value, never a counter: a key that expired and was written again cannot equal one a pod remembers.
 */
export async function signInsChanged(...userIds: string[]): Promise<void> {
  await Promise.all([...new Set(userIds)].map((userId) =>
    pub.set(authEpochKey(userId), randomBytes(12).toString('base64url'), 'EX', AUTH_EPOCH_TTL_SEC)))
}
