/**
 * Where a client is, as Cloudflare saw it. Production DNS is proxied through Cloudflare, which
 * stamps every request AND every WebSocket upgrade with `CF-IPCountry` (ISO 3166-1 alpha-2, plus
 * `XX` for "unknown" and `T1` for Tor). This module is the ONLY reader of that header: the WS
 * upgrade handlers (adapterWs / deviceWs) pass it down into the daily presence rows, and the REST
 * auth hook stamps it on the user.
 *
 * The header is not gated on an env flag on purpose. Off Cloudflare (local dev, a direct hit on the
 * origin) it is simply absent and nothing is written; a spoofed value can only dirty a statistics
 * column, never an authorization decision, so there is nothing to defend here.
 */
import type { IncomingHttpHeaders } from 'http'
import { prisma } from './prisma.js'
import { logger } from '../utils/logger.js'

const COUNTRY_RE = /^[A-Z]{2}$/

/**
 * The client's country code from `CF-IPCountry`, or undefined when the header is missing,
 * malformed, or one of Cloudflare's non-country placeholders (`XX` unknown, `T1` Tor).
 * Takes the headers bag rather than the request so the same function serves an `IncomingMessage`
 * (WS upgrade) and a `FastifyRequest`.
 */
export function countryCodeFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers['cf-ipcountry']
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase()
  if (!v || !COUNTRY_RE.test(v) || v === 'XX' || v === 'T1') return undefined
  return v
}

/** Minimum age of the last stamp before the same country is written again for one user. */
export const USER_COUNTRY_WRITE_MS = 60 * 60 * 1000
/** Cache entries older than this are evicted on the next sweep; sweeps run only past `USER_COUNTRY_CACHE_MAX`. */
const USER_COUNTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const USER_COUNTRY_CACHE_MAX = 50_000

interface LastStamp { countryCode: string; at: number }
// Per-process (pm2 cluster: one map per worker). A handful of redundant writes across workers is
// the accepted price of not adding a Redis round-trip to every control-plane request.
const lastStamps = new Map<string, LastStamp>()

function sweepStale(now: number): void {
  if (lastStamps.size <= USER_COUNTRY_CACHE_MAX) return
  for (const [id, s] of lastStamps) {
    if (now - s.at >= USER_COUNTRY_CACHE_TTL_MS) lastStamps.delete(id)
  }
  // More live users than the cap: forgetting them all costs one extra write each, which beats an
  // unbounded map. Insertion order is oldest-first, so drop from the front down to half the cap.
  if (lastStamps.size > USER_COUNTRY_CACHE_MAX) {
    const excess = lastStamps.size - USER_COUNTRY_CACHE_MAX / 2
    let dropped = 0
    for (const id of lastStamps.keys()) {
      if (dropped++ >= excess) break
      lastStamps.delete(id)
    }
  }
}

/** Test seam only. */
export function resetUserCountryCacheForTests(): void {
  lastStamps.clear()
}

/**
 * Remember `countryCode` as where `userId` last made a control-plane request. Fire-and-forget from
 * the auth hook — never awaited on the request path. Mongo is written only when the country changed
 * or the last write is at least `USER_COUNTRY_WRITE_MS` old, in the spirit of UserService's
 * "SSO auth runs on every request; don't make it a write-per-request hot path".
 *
 * The cache entry is claimed BEFORE the write, not after: the desktop app opens with a burst of
 * parallel requests, and claiming late would let every one of them reach Mongo. A failed write puts
 * the previous entry back so the next request retries instead of waiting out the interval.
 */
export async function stampUserCountry(userId: string, countryCode: string, now: Date = new Date()): Promise<void> {
  const t = now.getTime()
  const last = lastStamps.get(userId)
  if (last && last.countryCode === countryCode && t - last.at < USER_COUNTRY_WRITE_MS) return
  lastStamps.set(userId, { countryCode, at: t })
  sweepStale(t)
  try {
    await prisma.user.update({
      where: { id: userId },
      data: { lastCountryCode: countryCode, lastCountryAt: now },
    })
  } catch (err) {
    // Only undo our own claim: a later, successful stamp must not be rolled back by an older failure.
    if (lastStamps.get(userId)?.at === t) {
      if (last) lastStamps.set(userId, last)
      else lastStamps.delete(userId)
    }
    logger.warn('user country stamp failed', { userId, countryCode, error: String(err) })
  }
}
