import { createHash } from 'node:crypto'

/**
 * A short memory of "the profile service just said this access token is valid, and whose it is".
 *
 * The backend mints no session of its own: every REST request and every socket upgrade proves its
 * token by asking the Autonomous profile API. That API is a storefront endpoint — one call is a
 * customer read plus a cart read — and a single open desktop app asks several times a minute, so an
 * uncached validation turned a few hundred users into the profile API's largest caller by two orders
 * of magnitude.
 *
 * Two levels, because the backend is many processes (a pm2 cluster, or N pods). A per-process map
 * alone would still let one client's requests, spread across workers, each validate for themselves;
 * the shared store is what makes it "once per token per TTL" for the whole deployment. The
 * per-process map in front of it keeps the hot path off the network entirely.
 *
 * What the TTL costs: a token revoked at the SSO keeps working HERE for at most that long. Only a
 * positive answer is remembered — a rejected token is asked about again every time — and an entry
 * never outlives the token's own `exp`.
 */

export interface CachedSsoProfile {
  id: string
  email: string
}

/** The cross-process half: a string store with a per-key TTL. In production, Redis. */
export interface SharedProfileStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
}

export interface SsoProfileCache {
  /** The profile for this token on this account plane: remembered if it can be, else `load()`. */
  resolve(token: string, autonomousEnv: string, load: () => Promise<CachedSsoProfile>): Promise<CachedSsoProfile>
  /** Forget this process' entries. The shared store expires on its own. */
  clear(): void
}

interface Options {
  /** How long a validation is trusted. 0 turns the cache off. */
  ttlMs: number
  now?: () => number
  /** Read on every miss rather than captured once, so the store can be attached after startup. */
  shared?: () => SharedProfileStore | null
  maxEntries?: number
}

interface Entry {
  profile: CachedSsoProfile
  expiresAt: number
}

/** The token's own expiry in ms, if it is a JWT that states one. Unverified: it can only SHORTEN the TTL. */
function tokenExpiresAt(token: string): number | undefined {
  try {
    const part = token.split('.')[1]
    if (!part) return undefined
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** A shared row carries the expiry its writer chose, so a process that borrows it late cannot extend it. */
function parseEntry(raw: string | null): Entry | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as { id?: unknown; email?: unknown; expiresAt?: unknown }
    if (typeof value.id !== 'string' || !value.id || typeof value.email !== 'string' || !value.email) return undefined
    if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return undefined
    return { profile: { id: value.id, email: value.email }, expiresAt: value.expiresAt }
  } catch {
    return undefined
  }
}

export function createSsoProfileCache({ ttlMs, now = Date.now, shared = () => null, maxEntries = 50_000 }: Options): SsoProfileCache {
  const entries = new Map<string, Entry>()
  const inFlight = new Map<string, Promise<CachedSsoProfile>>()

  // The key is a digest, never the token: it is written to a store other services can read.
  const keyOf = (token: string, autonomousEnv: string): string =>
    `sso:profile:${createHash('sha256').update(`${autonomousEnv}:${token}`).digest('hex')}`

  const remember = (key: string, profile: CachedSsoProfile, expiresAt: number): void => {
    if (entries.size >= maxEntries && !entries.has(key)) {
      const oldest = entries.keys().next().value
      if (oldest !== undefined) entries.delete(oldest)
    }
    entries.set(key, { profile, expiresAt })
  }

  const fill = async (key: string, expiresAt: number, load: () => Promise<CachedSsoProfile>): Promise<CachedSsoProfile> => {
    const store = shared()
    if (store) {
      // A store that is down is a cache miss, not an authentication failure.
      const hit = parseEntry(await store.get(key).catch(() => null))
      if (hit && hit.expiresAt > now()) {
        remember(key, hit.profile, Math.min(hit.expiresAt, expiresAt))
        return hit.profile
      }
    }
    const profile = await load()
    remember(key, profile, expiresAt)
    if (store) await store.set(key, JSON.stringify({ ...profile, expiresAt }), expiresAt - now()).catch(() => { /* best effort */ })
    return profile
  }

  return {
    resolve(token, autonomousEnv, load) {
      const expiresAt = Math.min(now() + ttlMs, tokenExpiresAt(token) ?? Infinity)
      if (expiresAt <= now()) return load()

      const key = keyOf(token, autonomousEnv)
      const entry = entries.get(key)
      if (entry && entry.expiresAt > now()) return Promise.resolve(entry.profile)
      if (entry) entries.delete(key)

      const pending = inFlight.get(key)
      if (pending) return pending
      const filling = fill(key, expiresAt, load).finally(() => { inFlight.delete(key) })
      inFlight.set(key, filling)
      return filling
    },
    clear() {
      entries.clear()
    },
  }
}
