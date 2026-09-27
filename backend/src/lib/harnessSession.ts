import { pub } from './bus.js'
import { prisma } from './prisma.js'
import { userService } from '../services/UserService.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from './autonomousEnvironment.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
import {
  HARNESS_ACCESS_PREFIX,
  HARNESS_HANDOFF_PREFIX,
  HARNESS_REFRESH_PREFIX,
  harnessTokenHash,
  isHarnessHandoffCode,
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
  const user = await userService.get(userId)
  if (!user) return null
  const refreshToken = newHarnessToken(HARNESS_REFRESH_PREFIX)
  const session = await prisma.harnessSession.create({
    data: {
      userId,
      refreshHash: harnessTokenHash(refreshToken),
      label,
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

/** Sign out: the session's refresh token stops working, and so, at once, does its access token. */
export async function revokeHarnessSession(refreshToken: string): Promise<void> {
  if (!isHarnessRefreshToken(refreshToken)) return
  await prisma.harnessSession.updateMany({
    where: { refreshHash: harnessTokenHash(refreshToken), revokedAt: null },
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
  try {
    const raw = await pub.get(accessKey(harnessTokenHash(token)))
    if (!raw) throw invalid()
    const held = JSON.parse(raw) as { sessionId?: unknown; userId?: unknown }
    if (typeof held.sessionId !== 'string' || typeof held.userId !== 'string') throw invalid()
    sessionId = held.sessionId
    const session = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
    if (!session || session.revokedAt || session.userId !== held.userId) throw invalid()
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
  }
}
