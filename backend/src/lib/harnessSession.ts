import { pub } from './bus.js'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { userService } from '../services/UserService.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from './autonomousEnvironment.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
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
  /** Only on redeem: a refresh keeps the refresh token it was given. */
  refreshToken?: string
  expiresIn: number
  autonomousEnv: AutonomousEnvironment
}

/** A one-time code a signed-in computer puts in its Add Phone QR. */
export async function startHandoff(userId: string): Promise<{ code: string; expiresIn: number }> {
  const code = newHarnessToken(HARNESS_HANDOFF_PREFIX)
  await pub.set(handoffKey(harnessTokenHash(code)), userId, 'EX', HANDOFF_TTL_SEC)
  return { code, expiresIn: HANDOFF_TTL_SEC }
}

/**
 * Spend [code] and sign [label]'s device in as the account that minted it. Null for a code that is
 * malformed, expired or already spent — one answer for all three, so a caller learns nothing.
 */
export async function redeemHandoff(code: string, label: string): Promise<HarnessTokens | null> {
  if (!isHarnessHandoffCode(code)) return null
  // Read and spend in ONE step: two phones racing the same QR must not both get in. MULTI rather
  // than GETDEL, which a Redis older than 6.2 does not have.
  const key = handoffKey(harnessTokenHash(code))
  const [read] = (await pub.multi().get(key).del(key).exec()) ?? []
  if (!read || read[0]) throw read?.[0] ?? new Error('handoff redeem: no reply from Redis')
  const userId = read[1]
  if (typeof userId !== 'string' || !userId) return null
  return createSession(userId, label, 'viewer')
}

export type HarnessSessionKind = 'viewer' | 'computer'

/** A new session for [userId]: a refresh token (stored hashed) and its first access token. */
async function createSession(userId: string, label: string, kind: HarnessSessionKind): Promise<HarnessTokens | null> {
  const user = await userService.get(userId)
  if (!user) return null
  const refreshToken = newHarnessToken(HARNESS_REFRESH_PREFIX)
  const session = await prisma.harnessSession.create({
    data: {
      userId,
      refreshHash: harnessTokenHash(refreshToken),
      label,
      kind,
      expiresAt: sessionExpiry(),
    },
  })
  return {
    token: await issueAccess(session.id, userId),
    refreshToken,
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

/**
 * A new access token for the session [refreshToken] belongs to, or null when that session is gone
 * (unknown, revoked, idle past its lifetime, or its user deleted) — the caller's 401.
 *
 * The refresh token is not rotated. Rotation is only as good as its reuse detection, and a phone
 * that loses the response to a refresh would then present the old token and be signed out for a
 * dropped packet. The token is 256 bits, stored hashed, and revocable; that is the protection.
 */
export async function refreshHarnessSession(refreshToken: string): Promise<HarnessTokens | null> {
  if (!isHarnessRefreshToken(refreshToken)) return null
  const session = await prisma.harnessSession.findUnique({
    where: { refreshHash: harnessTokenHash(refreshToken) },
  })
  if (!session || session.revokedAt || session.expiresAt <= new Date()) return null
  const user = await userService.get(session.userId)
  if (!user) return null
  await prisma.harnessSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date(), expiresAt: sessionExpiry() },
  })
  return {
    token: await issueAccess(session.id, session.userId),
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

// Not yet revoked. A session is created without `revokedAt`, and on MongoDB `revokedAt: null` alone
// does not match a field that is absent — so a revoke filtered on it alone never revoked anything.
const notRevoked: Prisma.HarnessSessionWhereInput = { OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }

/** Sign out: the session's refresh token stops working, and so, at once, does its access token. */
export async function revokeHarnessSession(refreshToken: string): Promise<void> {
  if (!isHarnessRefreshToken(refreshToken)) return
  await prisma.harnessSession.updateMany({
    where: { refreshHash: harnessTokenHash(refreshToken), ...notRevoked },
    data: { revokedAt: new Date() },
  })
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

/**
 * The account a Harness access token speaks for. The session is read on every call, so a revoked
 * one stops at once rather than when its access token runs out.
 *
 * Only a token that is not good is `INVALID_TOKEN`. Redis or Mongo failing is
 * `AUTH_SERVICE_UNAVAILABLE` — the caller's 503, not its 401 — because a 401 sends the phone to
 * refresh and, failing that, to sign in again, over what is only an outage.
 */
export async function authenticateHarnessAccessToken(token: string): Promise<AuthUser> {
  const invalid = (): SsoAuthError => new SsoAuthError('Invalid or expired access token', 'INVALID_TOKEN')
  let user: Awaited<ReturnType<typeof userService.get>>
  let sessionId: string
  let kind: string | null | undefined
  try {
    const raw = await pub.get(accessKey(harnessTokenHash(token)))
    if (!raw) throw invalid()
    const held = JSON.parse(raw) as { sessionId?: unknown; userId?: unknown }
    if (typeof held.sessionId !== 'string' || typeof held.userId !== 'string') throw invalid()
    sessionId = held.sessionId
    const session = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
    if (!session || session.revokedAt || session.userId !== held.userId) throw invalid()
    kind = session.kind
    user = await userService.get(held.userId)
  } catch (err) {
    if (err instanceof SsoAuthError) throw err
    throw new SsoAuthError('Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE')
  }
  if (!user) throw invalid()
  return {
    sub: user.id,
    email: user.email,
    role: user.role,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
    harnessSessionId: sessionId,
    harnessSessionKind: kind === 'computer' ? 'computer' : 'viewer',
  }
}

/** Revoke the session with this id (a device removed from the account's device key log). */
export async function revokeHarnessSessionById(sessionId: string, userId: string): Promise<void> {
  await prisma.harnessSession.updateMany({ where: { id: sessionId, userId, ...notRevoked }, data: { revokedAt: new Date() } })
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
  kind: HarnessSessionKind
  computerId?: string
  ip?: string
  country?: string
  createdAt: number
  status: 'pending' | 'approved' | 'denied'
  userId?: string
  email?: string
}

const qrKey = (hash: string): string => `hnauth:qr:${hash}`
const qrPollKey = (hash: string): string => `hnauth:qrpoll:${hash}`
const qrLockKey = (hash: string): string => `hnauth:qrlock:${hash}`

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
  req: { label: string; kind: HarnessSessionKind; computerId?: string },
  origin: QrSignInOrigin,
): Promise<{ code: string; pollToken: string; expiresIn: number }> {
  const code = newHarnessToken(HARNESS_QR_PREFIX)
  const pollToken = newHarnessToken(HARNESS_QR_POLL_PREFIX)
  const codeHash = harnessTokenHash(code)
  const record: QrRecord = {
    pollHash: harnessTokenHash(pollToken),
    label: req.label,
    kind: req.kind,
    ...(req.computerId ? { computerId: req.computerId } : {}),
    ...(origin.ip ? { ip: origin.ip } : {}),
    ...(origin.country ? { country: origin.country } : {}),
    createdAt: Date.now(),
    status: 'pending',
  }
  await pub.multi()
    .set(qrKey(codeHash), JSON.stringify(record), 'EX', QR_SIGN_IN_TTL_SEC)
    .set(qrPollKey(record.pollHash), codeHash, 'EX', QR_SIGN_IN_TTL_SEC)
    .exec()
  return { code, pollToken, expiresIn: QR_SIGN_IN_TTL_SEC }
}

export interface QrSignInLookup {
  label: string
  kind: HarnessSessionKind
  country?: string
  ipHint?: string
  sameNetwork: boolean
  status: QrRecord['status']
}

/** What is asking to sign in, for the phone about to approve it. Null for a code that is gone. */
export async function lookupQrSignIn(code: string, phone: QrSignInOrigin): Promise<QrSignInLookup | null> {
  if (!isHarnessQrCode(code)) return null
  const r = await readQr(harnessTokenHash(code))
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
  if (!isHarnessQrCode(code)) return 'gone'
  const codeHash = harnessTokenHash(code)
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
  await pub.multi()
    .set(qrKey(codeHash), JSON.stringify(next), 'EX', left, 'XX')
    .expire(qrPollKey(r.pollHash), left)
    .exec()
  return 'ok'
}

/** The computer cancelling its own QR (it closed, or the person said "not my account"). */
export async function cancelQrSignIn(pollToken: string): Promise<void> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return
  const r = await readQr(codeHash)
  if (!r || r.pollHash !== harnessTokenHash(pollToken)) return
  await pub.multi().del(qrKey(codeHash)).del(qrPollKey(r.pollHash)).set(qrLockKey(codeHash), '1', 'EX', QR_SIGN_IN_MAX_LIFE_SEC).exec()
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
  await pub.multi().expire(qrKey(codeHash), ttl).expire(qrPollKey(r.pollHash), ttl).exec()
  return ttl
}

/**
 * The computer, having shown the person whose account approved it and been told to go on, takes its
 * session. Created only now, of the kind the QR asked for, and handed over once: the record is read
 * and removed in one step.
 */
export async function claimQrSignIn(pollToken: string): Promise<(HarnessTokens & { email: string; kind: HarnessSessionKind }) | null> {
  const codeHash = await codeHashForPoll(pollToken)
  if (!codeHash) return null
  const [read] = (await pub.multi().get(qrKey(codeHash)).del(qrKey(codeHash)).exec()) ?? []
  if (!read || read[0]) throw read?.[0] ?? new Error('qr claim: no reply from Redis')
  if (typeof read[1] !== 'string') return null
  let r: QrRecord
  try { r = JSON.parse(read[1]) as QrRecord } catch { return null }
  await pub.del(qrPollKey(r.pollHash))
  if (r.pollHash !== harnessTokenHash(pollToken) || r.status !== 'approved' || !r.userId || !r.email) return null
  const tokens = await createSession(r.userId, r.label, r.kind)
  return tokens ? { ...tokens, email: r.email, kind: r.kind } : null
}
