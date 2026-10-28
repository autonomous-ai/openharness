import { randomBytes } from 'node:crypto'
import type { HarnessSession, PrismaClient } from '@prisma/client'
import { pub } from './bus.js'
import { prisma } from './prisma.js'
import { decryptMachineCredential, encryptMachineCredential } from './machineCredential.js'
import { normalizeSsoClientId, refreshAccessToken, SsoTokenError, type SsoClientId } from './sso.js'
import { authenticateAccessToken, SsoAuthError } from './ssoAuth.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from './autonomousEnvironment.js'
import { logger } from '../utils/logger.js'

/**
 * Harness sessions an SSO sign-in backs: the CLI and Desktop sign in through Autonomous SSO once, then hold a session of
 * Harness's own (lib/harnessSession.ts), so an ordinary request never waits on the account service.
 *
 *   CLI → POST /api/auth/exchange  { …, harnessSession: { kind, label } }  → { token: hna_…, refreshToken: hnr_…, harnessSession: true }
 *   CLI → POST /api/auth/refresh   { refreshToken: <SSO>, harnessSession } → the same: today's sign-ins move over on renewal
 *   CLI → POST /api/auth/refresh   { refreshToken: hnr_… }                 → a new access token, re-checked with SSO hourly
 *
 * The person's SSO refresh token stays here, encrypted on the session (lib/machineCredential.ts), and is never handed to
 * a client again. Every renewal of the session re-checks it with SSO at most once an hour ([SSO_RECHECK_MS]):
 *
 *   - SSO renews it: the rotated refresh token is saved, and the session goes on.
 *   - SSO refuses it, and the token held is the one the last renewal saved: the person signed out of Autonomous or the
 *     account was disabled. The session ends, and its stored tokens with it.
 *   - Anything else — SSO slow, down, failing, answering for another account, or refusing a token after a renewal that
 *     never finished — is SSO UNAVAILABLE, never a sign-out: the session goes on for [SSO_OUTAGE_GRACE_MS] from its last
 *     good check, and after that its renewals answer "unavailable", which a client retries and never signs out over.
 *
 * Two renewals of one session never ask SSO at once: a renewal takes the session's lock in Redis, and one that finds it
 * taken goes on without asking. Before asking, a renewal marks the session (`ssoRenewingAt`); only saving SSO's answer
 * clears the mark. A mark left behind means a rotated refresh token may have been lost on the way (a pod died, the save
 * failed, the request timed out after SSO answered), and so a refusal of the stored token proves nothing.
 *
 * A session made here names no computer, even for a computer: naming one is what lets a sign-in turn that computer into a
 * team machine without its machine key (routes/auth.ts `isThisComputer`), and an SSO sign-in has never had that power.
 */

export const SSO_RECHECK_MS = 60 * 60_000
export const SSO_OUTAGE_GRACE_MS = 7 * 24 * 60 * 60_000
/** How long ended and idle-expired sessions are kept before their expiry index deletes them ([ensureHarnessSessionExpiry]). */
export const ENDED_SESSION_KEEP_MS = 30 * 24 * 60 * 60_000
/** Longer than a renewal can take (two SSO calls, each bounded by `SSO_PROFILE_TIMEOUT_MS`). */
const RENEW_LOCK_SEC = 60
/** An access token kept for billing is renewed this long before it runs out. */
const ACCESS_SKEW_MS = 60_000

const lockKey = (sessionId: string): string => `hnauth:ssorenew:${sessionId}`
// Delete the lock only if it is still this renewal's: one that outlived its lock must not release the next one's.
const RELEASE_SCRIPT = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`

export type SsoSessionKind = 'computer' | 'viewer'
export interface SsoSessionRequest { kind: SsoSessionKind; label: string }

/**
 * What a sign-in or renewal asks for in `harnessSession`: undefined when it asks for nothing (an older client, which
 * keeps its SSO tokens), null when it asks for something that is not a computer's or a viewer's session.
 */
export function parseSsoSessionRequest(raw: unknown): SsoSessionRequest | null | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const { kind, label } = raw as { kind?: unknown; label?: unknown }
  if (kind !== 'computer' && kind !== 'viewer') return null
  if (label !== undefined && typeof label !== 'string') return null
  const named = (label ?? '').trim().slice(0, 80)
  return { kind, label: named || (kind === 'computer' ? 'Computer' : 'Desktop') }
}

/** An SSO sign-in's tokens, as the token endpoint gave them. */
export interface SsoGrant { accessToken: string; refreshToken: string; expiresIn?: number }

const accessExpiry = (expiresIn: number | undefined, now: number): Date | null =>
  typeof expiresIn === 'number' && expiresIn > 0 ? new Date(now + expiresIn * 1000) : null

/** The fields a new session keeps for its SSO sign-in. Throws when they cannot be encrypted (no credential key). */
export function ssoSessionData(grant: SsoGrant, autonomousEnv: AutonomousEnvironment, clientId: SsoClientId | undefined, now = Date.now()) {
  return {
    ssoRefresh: encryptMachineCredential(grant.refreshToken),
    ssoAccess: encryptMachineCredential(grant.accessToken),
    ssoAccessExpiresAt: accessExpiry(grant.expiresIn, now),
    ssoEnv: autonomousEnv,
    ...(clientId ? { ssoClientId: clientId } : {}),
    ssoCheckedAt: new Date(now),
  }
}

/** A session ending: it is revoked, the SSO tokens it held are deleted with it, and it expires now — so the expiry
 *  index deletes the row [ENDED_SESSION_KEEP_MS] later ([ensureHarnessSessionExpiry]). */
export function endedSessionData(now = new Date()) {
  return { revokedAt: now, expiresAt: now, ssoRefresh: null, ssoAccess: null, ssoAccessExpiresAt: null }
}

type Renewal =
  | { outcome: 'renewed'; accessToken: string }
  /** Another renewal saved a good answer meanwhile: [row] is the session as it left it. */
  | { outcome: 'fresh'; row: HarnessSession }
  | { outcome: 'ended' }
  | { outcome: 'busy' }
  | { outcome: 'unavailable' }

const unavailable = (): SsoAuthError =>
  new SsoAuthError('The sign-in service is unavailable; retrying', 'AUTH_SERVICE_UNAVAILABLE')

/** Why a renewal could not get an answer, for the log: an error's kind, never its text (which could quote a request). */
const reasonOf = (err: unknown): string =>
  err instanceof SsoTokenError || err instanceof SsoAuthError ? err.code : err instanceof Error ? err.name : 'unknown'

/**
 * Ask SSO to renew session [sessionId]'s sign-in, once, under its lock — unless [fresh] says the session, read again
 * under the lock, no longer needs it.
 */
async function renew(sessionId: string, fresh: (row: HarnessSession, now: number) => boolean): Promise<Renewal> {
  const owner = randomBytes(16).toString('hex')
  if (await pub.set(lockKey(sessionId), owner, 'EX', RENEW_LOCK_SEC, 'NX') !== 'OK') return { outcome: 'busy' }
  try {
    const row = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
    if (!row || row.revokedAt) return { outcome: 'ended' }
    if (!row.ssoRefresh) return { outcome: 'unavailable' }
    const now = Date.now()
    if (fresh(row, now)) return { outcome: 'fresh', row }

    const unfinished = row.ssoRenewingAt instanceof Date
    if (!unfinished) await prisma.harnessSession.update({ where: { id: sessionId }, data: { ssoRenewingAt: new Date(now) } })
    const held = decryptMachineCredential(row.ssoRefresh)
    const autonomousEnv = storedAutonomousEnvironment(row.ssoEnv)
    let tokens: Awaited<ReturnType<typeof refreshAccessToken>>
    try {
      tokens = await refreshAccessToken(held, autonomousEnv, normalizeSsoClientId(row.ssoClientId))
    } catch (err) {
      if (err instanceof SsoTokenError && err.code === 'INVALID_GRANT' && !unfinished) {
        await prisma.harnessSession.update({ where: { id: sessionId }, data: endedSessionData() })
        logger.info('sso sign-in ended a harness session', { sessionId, userId: row.userId })
        return { outcome: 'ended' }
      }
      logger.warn('sso re-check unavailable', { sessionId, userId: row.userId, reason: reasonOf(err), unfinished })
      return { outcome: 'unavailable' }
    }
    const accessToken = tokens.access_token
    const refreshToken = tokens.refresh_token || held
    if (!accessToken) {
      logger.warn('sso re-check unavailable', { sessionId, userId: row.userId, reason: 'NO_ACCESS_TOKEN', unfinished })
      return { outcome: 'unavailable' }
    }
    // The renewed sign-in must still be this session's person. Not reachable is unavailable, and so is someone else:
    // nothing here says this person signed out, and their session is not handed to the other account either.
    let identity: Awaited<ReturnType<typeof authenticateAccessToken>> | null = null
    try { identity = await authenticateAccessToken(accessToken, autonomousEnv, { allowHarnessSession: false }) } catch (err) {
      logger.warn('sso re-check unavailable', { sessionId, userId: row.userId, reason: reasonOf(err), unfinished })
    }
    if (identity && identity.sub !== row.userId) {
      logger.warn('sso re-check answered for another account', { sessionId, userId: row.userId })
      return { outcome: 'unavailable' }
    }
    // Saved in one write, which also clears the mark. Unidentified, the rotated token is still kept, but the session
    // is not counted as checked.
    await prisma.harnessSession.update({ where: { id: sessionId }, data: {
      ssoRefresh: encryptMachineCredential(refreshToken),
      ssoAccess: encryptMachineCredential(accessToken),
      ssoAccessExpiresAt: accessExpiry(tokens.expires_in, now),
      ssoRenewingAt: null,
      ...(identity ? { ssoCheckedAt: new Date(now) } : {}),
    } })
    return identity ? { outcome: 'renewed', accessToken } : { outcome: 'unavailable' }
  } catch (err) {
    // Redis, Mongo or the credential key failing: a mark already written stays.
    logger.warn('sso re-check unavailable', { sessionId, reason: reasonOf(err) })
    return { outcome: 'unavailable' }
  } finally {
    await pub.eval(RELEASE_SCRIPT, 1, lockKey(sessionId), owner).catch(() => { /* it runs out on its own */ })
  }
}

/**
 * Whether session [session] may renew, as far as its SSO sign-in goes: `ok`, `ended` (it was just ended: the caller's
 * 401), or `unavailable` (SSO has not confirmed the sign-in within the grace: the caller's 503, which is retried).
 * A session no SSO sign-in backs is always `ok`.
 */
export async function recheckSsoSession(session: HarnessSession): Promise<'ok' | 'ended' | 'unavailable'> {
  if (!session.ssoRefresh) return 'ok'
  const checkedAt = session.ssoCheckedAt?.getTime() ?? 0
  const recent = (row: HarnessSession, now: number): boolean => now - (row.ssoCheckedAt?.getTime() ?? 0) < SSO_RECHECK_MS
  if (recent(session, Date.now())) return 'ok'
  let renewal: Renewal
  try { renewal = await renew(session.id, recent) } catch (err) {
    logger.warn('sso re-check unavailable', { sessionId: session.id, reason: reasonOf(err) })
    renewal = { outcome: 'unavailable' }
  }
  if (renewal.outcome === 'ended') return 'ended'
  if (renewal.outcome === 'renewed' || renewal.outcome === 'fresh') return 'ok'
  return Date.now() - checkedAt < SSO_OUTAGE_GRACE_MS ? 'ok' : 'unavailable'
}

/** [recheckSsoSession]'s 'unavailable', as the error a renewal answers with. */
export const ssoUnavailableError = unavailable

/**
 * An SSO access token for session [sessionId] of [userId], for the routes that forward one to the account service
 * (billing, lib/autonomousBff.ts). Null when the session is not that person's, has ended, or has no SSO sign-in
 * behind it (a QR or handoff session). Throws `AUTH_SERVICE_UNAVAILABLE` when SSO cannot give one now.
 */
export async function ssoAccessTokenFor(sessionId: string, userId: string): Promise<string | null> {
  const row = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
  if (!row || row.userId !== userId || row.revokedAt || !row.ssoRefresh) return null
  const usable = (r: HarnessSession, now: number): boolean =>
    !!r.ssoAccess && r.ssoAccessExpiresAt instanceof Date && r.ssoAccessExpiresAt.getTime() > now + ACCESS_SKEW_MS
  if (usable(row, Date.now())) return decryptMachineCredential(row.ssoAccess!)
  const renewal = await renew(sessionId, usable)
  if (renewal.outcome === 'renewed') return renewal.accessToken
  if (renewal.outcome === 'fresh') return decryptMachineCredential(renewal.row.ssoAccess!)
  if (renewal.outcome === 'ended') return null
  throw unavailable()
}

/**
 * Sessions are deleted [ENDED_SESSION_KEEP_MS] after they expire: idle past their lifetime, or ended
 * ([endedSessionData] expires them). Nothing else deletes them. Run by the worker at start (worker.ts).
 */
export async function ensureHarnessSessionExpiry(db: Pick<PrismaClient, '$runCommandRaw'>): Promise<void> {
  await db.$runCommandRaw({ createIndexes: 'harness_sessions', indexes: [{ key: { expiresAt: 1 }, name: 'harness_session_expiry',
    expireAfterSeconds: ENDED_SESSION_KEEP_MS / 1000 }] })
}
