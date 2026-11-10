import { randomInt } from 'node:crypto'
import { pub } from './bus.js'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { userService } from '../services/UserService.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from './autonomousEnvironment.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
import { authEpochKey, harnessAuthCache, signInsChanged } from './harnessAuthCache.js'
import type { SsoClientId } from './sso.js'
import {
  endedSessionData,
  recheckSsoSession,
  ssoSessionData,
  ssoSignInAgainError,
  type SsoGrant,
  type SsoSessionRequest,
} from './ssoSession.js'
import {
  HARNESS_ACCESS_PREFIX,
  HARNESS_HANDOFF_PREFIX,
  HARNESS_QR_POLL_PREFIX,
  HARNESS_QR_PREFIX,
  HARNESS_REFRESH_PREFIX,
  harnessTokenHash,
  isHarnessHandoffCode,
  isHarnessQrCode,
  isHarnessQrPollToken,
  isHarnessRefreshToken,
  isTeamAccessToken,
  isTeamRefreshToken,
  newHarnessToken,
} from './harnessTokenFormat.js'

/**
 * Sign-ins Harness issues itself — so a phone that scans a signed-in computer's Add Phone QR is
 * signed in by the scan, with no emailed code.
 *
 * The Autonomous account service is the only thing that signs a person in, and it has no way for
 * one signed-in device to sign in another (its grants are password, otp, refresh_token and
 * social_token). So the computer, already signed in through it, asks here for a one-time HANDOFF
 * code; the QR carries it; the phone trades it for a session of Harness's own. Everything that
 * authenticates goes through `authenticateAccessToken` (lib/ssoAuth.ts), which sends a Harness
 * token here and every other token to the account service as before.
 *
 *   computer → POST /api/auth/handoff          (signed in)  → { code, expiresIn }   → into the QR
 *   phone    → POST /api/auth/handoff/redeem   (no auth)    → { token, refreshToken, expiresIn }
 *   phone    → POST /api/auth/refresh          (no auth)    → { token, expiresIn }
 *
 * The handoff code is the whole credential, so it is 32 random bytes, lives [HANDOFF_TTL_SEC], and
 * is spent by the first redeem. It rides in the QR link's fragment, which a browser never
 * sends, so it reaches this server only in the redeem's body.
 *
 * Nothing here is the person's Autonomous credential, and nothing here reaches the account service:
 * a route that forwards the caller's token there (billing, via lib/autonomousBff.ts) cannot be used
 * from a Harness session. The phone uses none of them.
 *
 * Harness Team accounts are gone (anh Dee, 2026-11-10): no Team code is minted or redeemed, and a Team account's session
 * made before (its tokens `hta_`/`htr_`, harnessTokenFormat.ts) is refused, so an old Team daemon stops.
 */

/** How long a code in a QR stays good. The Add Phone dialog asks for a new one every minute. */
export const HANDOFF_TTL_SEC = 90
export const HARNESS_ACCESS_TTL_SEC = 60 * 60
/** Idle lifetime: every refresh moves it on, so only a phone left unused this long is signed out. */
const SESSION_IDLE_DAYS = 90

const handoffKey = (hash: string): string => `hnauth:handoff:${hash}`
const accessKey = (hash: string): string => `hnauth:access:${hash}`

const sessionExpiry = (): Date => new Date(Date.now() + SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000)

export interface HarnessTokens {
  token: string
  /** On a new session: the kind it is, so a caller stores what it was given and not what it asked for. */
  kind?: HarnessSessionKind
  /** Only on redeem: a refresh keeps the refresh token it was given. */
  refreshToken?: string
  expiresIn: number
  autonomousEnv: AutonomousEnvironment
}

export type HarnessSessionKind = 'viewer' | 'computer'
/** What a QR sign-in can ask to become. */
export type QrSignInKind = 'viewer' | 'computer'

/** A one-time code a signed-in computer puts in its Add Phone QR. It holds the bare user id. */
export async function startHandoff(userId: string): Promise<{ code: string; expiresIn: number }> {
  const code = newHarnessToken(HARNESS_HANDOFF_PREFIX)
  await pub.set(handoffKey(harnessTokenHash(code)), userId, 'EX', HANDOFF_TTL_SEC)
  return { code, expiresIn: HANDOFF_TTL_SEC }
}

/**
 * Spend [code] and sign [label]'s phone in as the account that minted it. Null for a code that is malformed, expired or
 * already spent, and for a Team account's code minted before Team accounts went (it held JSON, never a bare user id): one
 * answer for all of them, so a caller learns nothing.
 */
export async function redeemHandoff(code: string, label: string): Promise<HarnessTokens | null> {
  if (!isHarnessHandoffCode(code)) return null
  // Read and spend in ONE step: two phones racing the same QR must not both get in. MULTI rather
  // than GETDEL, which a Redis older than 6.2 does not have.
  const key = handoffKey(harnessTokenHash(code))
  const [read] = (await pub.multi().get(key).del(key).exec()) ?? []
  if (!read || read[0]) throw read?.[0] ?? new Error('handoff redeem: no reply from Redis')
  const userId = read[1]
  if (typeof userId !== 'string' || !userId || userId.startsWith('{')) return null
  return createSession(userId, label || 'phone', 'viewer')
}

// Not yet revoked. A session is created without `revokedAt`, and on MongoDB `revokedAt: null` alone
// does not match a field that is absent — so a revoke filtered on it alone never revoked anything.
const notRevoked: Prisma.HarnessSessionWhereInput = { OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }

/**
 * A session for [userId] that their SSO sign-in [grant] backs (lib/ssoSession.ts): what the CLI and Desktop trade an SSO
 * sign-in for. It names no computer, whatever its kind. Null when the account is gone; throws when it cannot be stored.
 */
export async function createSsoSession(
  userId: string,
  { kind, label }: SsoSessionRequest,
  grant: SsoGrant,
  autonomousEnv: AutonomousEnvironment,
  clientId?: SsoClientId,
): Promise<HarnessTokens | null> {
  return createSession(userId, label, kind, ssoSessionData(grant, autonomousEnv, clientId))
}

/** A new session for [userId]: a refresh token (stored hashed) and its first access token. */
async function createSession(
  userId: string, label: string, kind: HarnessSessionKind, sso?: ReturnType<typeof ssoSessionData>,
): Promise<HarnessTokens | null> {
  const user = await userService.get(userId)
  if (!user) return null
  const refreshToken = newHarnessToken(HARNESS_REFRESH_PREFIX)
  const session = await prisma.harnessSession.create({
    data: {
      userId,
      refreshHash: harnessTokenHash(refreshToken),
      label,
      kind,
      ...(sso ?? {}),
      expiresAt: sessionExpiry(),
    },
  })
  return {
    token: await issueAccess(session.id, userId),
    refreshToken,
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    kind,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

/**
 * A new access token for the session [refreshToken] belongs to, or null when that session is gone
 * (unknown, revoked, idle past its lifetime, its user deleted, or its SSO sign-in ended) — the caller's 401.
 * A session an SSO sign-in backs is re-checked with SSO first (lib/ssoSession.ts); one SSO has not confirmed
 * within its grace throws `SIGN_IN_AGAIN` — shown as "Sign in again", the session itself kept.
 *
 * The refresh token is not rotated. Rotation is only as good as its reuse detection, and a phone
 * that loses the response to a refresh would then present the old token and be signed out for a
 * dropped packet. The token is 256 bits, stored hashed, and revocable; that is the protection.
 */
export async function refreshHarnessSession(refreshToken: string): Promise<HarnessTokens | null> {
  if (!isHarnessRefreshToken(refreshToken)) return null
  if (isTeamRefreshToken(refreshToken)) return endTeamSession(refreshToken)
  const session = await prisma.harnessSession.findUnique({
    where: { refreshHash: harnessTokenHash(refreshToken) },
  })
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null
  if (session.kind === 'team') return null
  const user = await userService.get(session.userId)
  if (!user) return null
  const sso = await recheckSsoSession(session)
  if (sso === 'ended') return null
  if (sso === 'sign-in-again') throw ssoSignInAgainError()
  // Only a session still live moves on: one signed out meanwhile stays ended, and gets no new access token.
  const { count } = await prisma.harnessSession.updateMany({
    where: { id: session.id, ...notRevoked },
    data: { lastUsedAt: new Date(), expiresAt: sessionExpiry() },
  })
  if (count === 0) return null
  return {
    token: await issueAccess(session.id, session.userId),
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

/**
 * A Harness Team account's daemon renewing its sign-in, after Team accounts went: its session ends, and the answer is an
 * invalid refresh token, on which an old Team daemon stops for good. Until 2026-12-10 (the daemons of the last 30 days);
 * then `htr_` goes with its prefix (harnessTokenFormat.ts), and such a token is simply not ours.
 */
async function endTeamSession(refreshToken: string): Promise<null> {
  const refreshHash = harnessTokenHash(refreshToken)
  const { count } = await prisma.harnessSession.updateMany({ where: { refreshHash, kind: 'team', ...notRevoked }, data: endedSessionData() })
  if (count > 0) {
    const session = await prisma.harnessSession.findUnique({ where: { refreshHash }, select: { userId: true } })
    if (session) await signInsChanged(session.userId)
  }
  return null
}

/** Sign out: the session's refresh token stops working, and so, at once, does its access token. Any SSO
 *  tokens it held are deleted. */
export async function revokeHarnessSession(refreshToken: string): Promise<void> {
  if (!isHarnessRefreshToken(refreshToken)) return
  const refreshHash = harnessTokenHash(refreshToken)
  const session = await prisma.harnessSession.findUnique({ where: { refreshHash }, select: { userId: true } })
  if (!session) return
  await prisma.harnessSession.updateMany({ where: { refreshHash, ...notRevoked }, data: endedSessionData() })
  // Even when it was already revoked: a retry after a failed epoch write must still reach every pod.
  await signInsChanged(session.userId)
}

async function issueAccess(sessionId: string, userId: string): Promise<string> {
  const token = newHarnessToken(HARNESS_ACCESS_PREFIX)
  await pub.set(
    accessKey(harnessTokenHash(token)),
    JSON.stringify({ sessionId, userId }),
    'EX',
    HARNESS_ACCESS_TTL_SEC,
  )
  return token
}

const invalid = (): SsoAuthError => new SsoAuthError('Invalid or expired access token', 'INVALID_TOKEN')

/**
 * The account a Harness access token speaks for. The session is read on every call, so a revoked
 * one stops at once rather than when its access token runs out — or, within [AUTH_CACHE_TTL_MS] of the
 * last read, remembered by this pod and checked against the person's sign-in epoch instead
 * (lib/harnessAuthCache.ts), which every sign-out moves. The access token is read from Redis either way.
 *
 * Only a token that is not good is `INVALID_TOKEN`. Redis or Mongo failing is
 * `AUTH_SERVICE_UNAVAILABLE` — the caller's 503, not its 401 — because a 401 sends the phone to
 * refresh and, failing that, to sign in again, over what is only an outage.
 */
export async function authenticateHarnessAccessToken(token: string): Promise<AuthUser> {
  // A Harness Team account's, made before Team accounts went: a bad token, so an old Team daemon's socket and requests
  // answer 401 and it stops. Read nowhere. Until 2026-12-10, then `hta_` goes with its prefix (harnessTokenFormat.ts).
  if (isTeamAccessToken(token)) throw invalid()
  const hash = harnessTokenHash(token)
  const remembered = harnessAuthCache.get(hash)
  let user: Awaited<ReturnType<typeof userService.get>>
  let sessionId: string
  let userId: string
  let epoch: string | null
  let kind: string | null | undefined
  try {
    let raw: string | null
    if (remembered) {
      [raw, epoch] = await pub.mget(accessKey(hash), authEpochKey(remembered.userId))
    } else {
      raw = await pub.get(accessKey(hash))
      epoch = null
    }
    if (!raw) {
      harnessAuthCache.delete(hash)
      throw invalid()
    }
    const held = JSON.parse(raw) as { sessionId?: unknown; userId?: unknown }
    if (typeof held.sessionId !== 'string' || typeof held.userId !== 'string') throw invalid()
    sessionId = held.sessionId
    userId = held.userId
    if (remembered && remembered.sessionId === sessionId && remembered.userId === userId && remembered.epoch === epoch) {
      return { ...remembered.user }
    }
    // The epoch before the session and the user: a sign-out landing between these reads leaves it stale.
    if (!remembered || remembered.userId !== userId) epoch = await pub.get(authEpochKey(userId))
    const session = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
    if (!session || session.revokedAt || session.userId !== userId) throw invalid()
    kind = session.kind
    user = await userService.get(userId)
  } catch (err) {
    if (err instanceof SsoAuthError) throw err
    throw new SsoAuthError('Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE')
  }
  if (!user) throw invalid()
  const answer = identityOf(user, sessionId, kind)
  harnessAuthCache.set(hash, { sessionId, userId, epoch, user: answer })
  return { ...answer }
}

/** What a live session answers; throws INVALID_TOKEN for a Team account's (made before they went). */
function identityOf(
  user: NonNullable<Awaited<ReturnType<typeof userService.get>>>,
  sessionId: string,
  kind: string | null | undefined,
): AuthUser {
  const identity = {
    sub: user.id,
    email: user.email,
    role: user.role,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
    harnessSessionId: sessionId,
  }
  if (kind === 'team') throw invalid()
  if (kind === 'computer') return { ...identity, harnessSessionKind: 'computer' }
  return { ...identity, harnessSessionKind: 'viewer' }
}

/** Revoke the session with this id (a device removed from the account's device key log). */
export async function revokeHarnessSessionById(sessionId: string, userId: string): Promise<void> {
  await prisma.harnessSession.updateMany({ where: { id: sessionId, userId, ...notRevoked }, data: endedSessionData() })
  await signInsChanged(userId)
}

// ── Sign in a computer by scanning its QR with a signed-in phone ──────────────────────────────────
//
//   computer → POST /api/auth/qr/start   (no auth)  → { code, pollToken }  code → the QR, pollToken kept
//   phone    → POST /api/auth/qr/lookup  (signed in) → what is asking: its name, kind, where it is
//   phone    → POST /api/auth/qr/approve (signed in) → approved for the phone's account
//   computer → POST /api/auth/qr/poll    (no auth)  → pending | denied | expired | approved {email}
//   computer   asks the person "Sign in as <email>?" — someone else's phone may have approved it
//   computer → POST /api/auth/qr/claim   (no auth)  → the session, created now, handed over once
//
// A device with no screen (a lamp, #1410) asks for a spoken code at start: eight digits it says aloud
// and the person types on the phone, which stand in for the QR's code at lookup and answer. The device
// still asks "Sign in as <email>?" (aloud), so a stranger who heard the digits gains nothing by them.
//
// Signing in is what makes the account's devices trust a computer (the device key log), so approving
// is handing over the account's terminals, and both ends get a say: the phone sees what is asking and
// from where, and the computer sees whose account it would join before any session exists.

export const QR_SIGN_IN_TTL_SEC = 120
/** How long one code may be kept alive by extending it, all told. */
export const QR_SIGN_IN_MAX_LIFE_SEC = 600

export interface QrSignInOrigin { ip?: string; country?: string }

interface QrRecord {
  pollHash: string
  label: string
  kind: QrSignInKind
  ip?: string
  country?: string
  createdAt: number
  status: 'pending' | 'approved' | 'denied'
  userId?: string
  email?: string
  /** Its spoken code, when the device asked for one; it lives and dies with the record. */
  spokenCode?: string
}

const qrKey = (hash: string): string => `hnauth:qr:${hash}`
const qrPollKey = (hash: string): string => `hnauth:qrpoll:${hash}`
const qrLockKey = (hash: string): string => `hnauth:qrlock:${hash}`
const qrSpokenKey = (digits: string): string => `hnauth:qrspoken:${digits}`

/** A spoken code: eight digits, easy to say and to type on a phone's number pad. */
const SPOKEN_CODE = /^\d{8}$/

/** Whether [code] is a spoken code (eight digits, typed with any spacing) rather than a QR's. */
export function isSpokenCode(code: string): boolean {
  return SPOKEN_CODE.test(code.replace(/[\s-]/g, ''))
}

// Eight digits are a small space, so the wrong ones an account types are counted, per hour and per
// day, in Redis so every replica shares them (the per-process 20/min alone let one account try
// ~28,800 a day per replica, review of #1427). Misses only: a person who mistypes once is unaffected.
export const SPOKEN_CODE_MISSES_PER_HOUR = 10
export const SPOKEN_CODE_MISSES_PER_DAY = 30
const SPOKEN_MISS_WINDOWS = [
  { suffix: 'h', ms: 60 * 60_000, max: SPOKEN_CODE_MISSES_PER_HOUR },
  { suffix: 'd', ms: 24 * 60 * 60_000, max: SPOKEN_CODE_MISSES_PER_DAY },
] as const
const spokenMissKey = (userId: string, suffix: string): string => `hnauth:spokenmiss:${userId}:${suffix}`
// INCR every window, arming its expiry on first use, in one atomic round trip (as bus.ts's new-id quota).
const SPOKEN_MISS_SCRIPT = `
for i, key in ipairs(KEYS) do
  if redis.call('incr', key) == 1 then redis.call('pexpire', key, ARGV[i]) end
end
return 1`

/** False once [userId] has missed too many spoken codes: even the right one then waits for the window. */
export async function spokenCodeGuessesLeft(userId: string): Promise<boolean> {
  const counts = await Promise.all(SPOKEN_MISS_WINDOWS.map((w) => pub.get(spokenMissKey(userId, w.suffix))))
  return counts.every((count, i) => Number(count ?? 0) < SPOKEN_MISS_WINDOWS[i]!.max)
}

export async function recordSpokenCodeMiss(userId: string): Promise<void> {
  const keys = SPOKEN_MISS_WINDOWS.map((w) => spokenMissKey(userId, w.suffix))
  await pub.eval(SPOKEN_MISS_SCRIPT, keys.length, ...keys, ...SPOKEN_MISS_WINDOWS.map((w) => w.ms))
}

/** The record a phone's code names: the QR's own code, or a spoken one typed with any spacing. */
async function codeHashFor(code: string): Promise<string | null> {
  const digits = code.replace(/[\s-]/g, '')
  if (SPOKEN_CODE.test(digits)) return pub.get(qrSpokenKey(digits))
  return isHarnessQrCode(code) ? harnessTokenHash(code) : null
}

async function readQr(codeHash: string): Promise<QrRecord | null> {
  const raw = await pub.get(qrKey(codeHash))
  if (!raw) return null
  try { return JSON.parse(raw) as QrRecord } catch { return null }
}

/** Seconds left of a code's whole life ([QR_SIGN_IN_MAX_LIFE_SEC] from its start). */
function qrLifeLeft(r: QrRecord): number {
  return QR_SIGN_IN_MAX_LIFE_SEC - Math.floor((Date.now() - r.createdAt) / 1000)
}

async function codeHashForPoll(pollToken: string): Promise<string | null> {
  if (!isHarnessQrPollToken(pollToken)) return null
  return pub.get(qrPollKey(harnessTokenHash(pollToken)))
}

/** Two addresses on one network: the same IPv4 address, or the same IPv6 /64. */
export function sameNetwork(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  if (a.includes(':') && b.includes(':')) {
    const prefix = (ip: string): string => ip.toLowerCase().split(':').slice(0, 4).join(':')
    return prefix(a) === prefix(b)
  }
  return a === b
}

/** An address shown to the person, with its last part hidden: `1.2.3.x`, `2001:db8:1:2::x`. */
function ipHint(ip: string | undefined): string | undefined {
  if (!ip) return undefined
  if (ip.includes(':')) return `${ip.toLowerCase().split(':').slice(0, 4).join(':')}::x`
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.x` : undefined
}

export async function startQrSignIn(
  req: { label: string; kind: QrSignInKind; spokenCode?: boolean },
  origin: QrSignInOrigin,
): Promise<{ code: string; pollToken: string; expiresIn: number; spokenCode?: string }> {
  const code = newHarnessToken(HARNESS_QR_PREFIX)
  const pollToken = newHarnessToken(HARNESS_QR_POLL_PREFIX)
  const codeHash = harnessTokenHash(code)
  // Only on request: a spoken code is a far smaller space than the QR's, so a QR sign-in never has one.
  const spokenCode = req.spokenCode ? await claimSpokenCode(codeHash) : undefined
  const record: QrRecord = {
    pollHash: harnessTokenHash(pollToken),
    label: req.label,
    kind: req.kind,
    ...(origin.ip ? { ip: origin.ip } : {}),
    ...(origin.country ? { country: origin.country } : {}),
    createdAt: Date.now(),
    status: 'pending',
    ...(spokenCode ? { spokenCode } : {}),
  }
  await pub.multi()
    .set(qrKey(codeHash), JSON.stringify(record), 'EX', QR_SIGN_IN_TTL_SEC)
    .set(qrPollKey(record.pollHash), codeHash, 'EX', QR_SIGN_IN_TTL_SEC)
    .exec()
  return { code, pollToken, expiresIn: QR_SIGN_IN_TTL_SEC, ...(spokenCode ? { spokenCode } : {}) }
}

/** Eight digits no live sign-in holds, taken for [codeHash]. Live codes are few, so a clash is rare. */
async function claimSpokenCode(codeHash: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const digits = String(randomInt(0, 100_000_000)).padStart(8, '0')
    if (await pub.set(qrSpokenKey(digits), codeHash, 'EX', QR_SIGN_IN_TTL_SEC, 'NX') === 'OK') return digits
  }
  throw new Error('qr start: no free spoken code')
}

/** How long a box ticket waits for its box: the phone hands it over on the box's own hotspot, and the
 *  box only spends it once it is on the person's Wi-Fi. */
export const BOX_TICKET_TTL_SEC = 30 * 60

/**
 * A QR sign-in already approved by the signed-in phone, for a headless box that has no screen to show
 * a QR on. The phone passes the poll token (the ticket) to the box over its setup hotspot; the box
 * spends it with the ordinary `/api/auth/qr/claim`. The code itself is never handed out, and the
 * answer lock is taken now, so nobody can look the record up or answer it again.
 */
export async function issueBoxTicket(userId: string, email: string): Promise<{ ticket: string; expiresIn: number }> {
  const codeHash = harnessTokenHash(newHarnessToken(HARNESS_QR_PREFIX))
  const ticket = newHarnessToken(HARNESS_QR_POLL_PREFIX)
  const record: QrRecord = {
    pollHash: harnessTokenHash(ticket),
    label: 'Harness',
    kind: 'computer',
    createdAt: Date.now(),
    status: 'approved',
    userId,
    email,
  }
  await pub.multi()
    .set(qrKey(codeHash), JSON.stringify(record), 'EX', BOX_TICKET_TTL_SEC)
    .set(qrPollKey(record.pollHash), codeHash, 'EX', BOX_TICKET_TTL_SEC)
    .set(qrLockKey(codeHash), '1', 'EX', BOX_TICKET_TTL_SEC)
    .exec()
  return { ticket, expiresIn: BOX_TICKET_TTL_SEC }
}

export interface QrSignInLookup {
  label: string
  kind: QrSignInKind
  country?: string
  ipHint?: string
  sameNetwork: boolean
  status: QrRecord['status']
}

/** What is asking to sign in, for the phone about to approve it. Null for a code that is gone. */
export async function lookupQrSignIn(code: string, phone: QrSignInOrigin): Promise<QrSignInLookup | null> {
  const codeHash = await codeHashFor(code)
  if (!codeHash) return null
  const r = await readQr(codeHash)
  if (!r) return null
  return {
    label: r.label,
    kind: r.kind,
    ...(r.country ? { country: r.country } : {}),
    ...(ipHint(r.ip) ? { ipHint: ipHint(r.ip) } : {}),
    sameNetwork: sameNetwork(r.ip, phone.ip),
    status: r.status,
  }
}

/** Approve (for the phone's account) or deny. One answer per code: the first one given stands. */
export async function answerQrSignIn(
  code: string,
  answer: { approve: true; userId: string; email: string } | { approve: false },
): Promise<'ok' | 'gone' | 'answered'> {
  const codeHash = await codeHashFor(code)
  if (!codeHash) return 'gone'
  const r = await readQr(codeHash)
  if (!r) return 'gone'
  const locked = await pub.set(qrLockKey(codeHash), '1', 'EX', QR_SIGN_IN_MAX_LIFE_SEC, 'NX')
  if (locked !== 'OK' || r.status !== 'pending') return 'answered'
  // XX throughout: a code that ran out between the read and here stays gone, never comes back
  // without an expiry.
  if (!answer.approve) {
    await pub.set(qrKey(codeHash), JSON.stringify({ ...r, status: 'denied' }), 'KEEPTTL', 'XX')
    return 'ok'
  }
  // Approved, the code waits on the person at the computer, who still has to say yes and may be
  // slower than the code's two minutes: it lives out its whole life instead, with nothing to extend.
  const next: QrRecord = { ...r, status: 'approved', userId: answer.userId, email: answer.email }
  const left = Math.max(1, qrLifeLeft(r))
  const tx = pub.multi()
    .set(qrKey(codeHash), JSON.stringify(next), 'EX', left, 'XX')
    .expire(qrPollKey(r.pollHash), left)
  if (r.spokenCode) tx.expire(qrSpokenKey(r.spokenCode), left)
  await tx.exec()
  return 'ok'
}

/** The computer cancelling its own QR (it closed, or the person said "not my account"). */
export async function cancelQrSignIn(pollToken: string): Promise<void> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return
  const r = await readQr(codeHash)
  if (!r || r.pollHash !== harnessTokenHash(pollToken)) return
  const tx = pub.multi().del(qrKey(codeHash)).del(qrPollKey(r.pollHash)).set(qrLockKey(codeHash), '1', 'EX', QR_SIGN_IN_MAX_LIFE_SEC)
  if (r.spokenCode) tx.del(qrSpokenKey(r.spokenCode))
  await tx.exec()
}

export type QrSignInPoll =
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'approved'; email: string }

/** Where the computer's QR stands. `approved` names the account — no session exists yet. */
export async function pollQrSignIn(pollToken: string): Promise<QrSignInPoll> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return { status: 'expired' }
  const r = await readQr(codeHash)
  if (!r || r.pollHash !== harnessTokenHash(pollToken)) return { status: 'expired' }
  if (r.status === 'approved' && r.email) return { status: 'approved', email: r.email }
  if (r.status === 'denied') return { status: 'denied' }
  return { status: 'pending' }
}

/** Keep the same code alive a while longer (so an approval given at the last second still counts),
 *  up to [QR_SIGN_IN_MAX_LIFE_SEC] in all. Null when it is gone or too old. */
export async function extendQrSignIn(pollToken: string): Promise<number | null> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return null
  const r = await readQr(codeHash)
  if (!r || r.pollHash !== harnessTokenHash(pollToken)) return null
  const left = qrLifeLeft(r)
  if (left <= 0) return null
  // An approved code already lives out its whole life (answerQrSignIn); extending would shorten it.
  if (r.status === 'approved') return left
  const ttl = Math.min(QR_SIGN_IN_TTL_SEC, left)
  const tx = pub.multi().expire(qrKey(codeHash), ttl).expire(qrPollKey(r.pollHash), ttl)
  if (r.spokenCode) tx.expire(qrSpokenKey(r.spokenCode), ttl)
  await tx.exec()
  return ttl
}

/**
 * The computer, having shown the person whose account approved it and been told to go on, takes its
 * session. Created only now, of the kind the QR asked for, and handed over once: the record is read
 * and removed in one step.
 */
export async function claimQrSignIn(pollToken: string): Promise<(HarnessTokens & { email: string; kind: QrSignInKind }) | null> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return null
  const [read] = (await pub.multi().get(qrKey(codeHash)).del(qrKey(codeHash)).exec()) ?? []
  if (!read || read[0]) throw read?.[0] ?? new Error('qr claim: no reply from Redis')
  if (typeof read[1] !== 'string') return null
  let r: QrRecord
  try { r = JSON.parse(read[1]) as QrRecord } catch { return null }
  await pub.del(qrPollKey(r.pollHash))
  if (r.spokenCode) await pub.del(qrSpokenKey(r.spokenCode))
  if (r.pollHash !== harnessTokenHash(pollToken) || r.status !== 'approved' || !r.userId || !r.email) return null
  const tokens = await createSession(r.userId, r.label, r.kind)
  return tokens ? { ...tokens, email: r.email, kind: r.kind } : null
}
