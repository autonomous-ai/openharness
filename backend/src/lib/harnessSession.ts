import { randomInt } from 'node:crypto'
import { pub, publishDown } from './bus.js'
import type { Prisma } from '@prisma/client'
import { machineAlive, prisma } from './prisma.js'
import { normalizeComputerId } from './deviceAuth.js'
import { TEAM_CONVERTED_FRAME } from './teamSession.js'
import { userService } from '../services/UserService.js'
import { storedAutonomousEnvironment, type AutonomousEnvironment } from './autonomousEnvironment.js'
import { SsoAuthError, type AuthUser } from './ssoAuth.js'
import {
  HARNESS_ACCESS_PREFIX,
  HARNESS_HANDOFF_PREFIX,
  HARNESS_QR_POLL_PREFIX,
  HARNESS_QR_PREFIX,
  HARNESS_REFRESH_PREFIX,
  HARNESS_TEAM_ACCESS_PREFIX,
  HARNESS_TEAM_REFRESH_PREFIX,
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
 * The same code, asked for with `{ kind: 'team' }`, signs in a Mac's team account instead: the second
 * macOS user that runs teammates' Swarm agents (lib/teamSession.ts). Only a computer can ask for one, and
 * the daemon that redeems it names its computer, which the session is bound to for good.
 *
 *   computer → POST /api/auth/handoff          { kind: 'team' }                → { code, expiresIn, kind }
 *   team     → POST /api/auth/handoff/redeem   { code, label, computerId }     → { token, refreshToken, expiresIn, kind }
 *
 * A computer may also turn ITSELF into a team machine, keeping its computer id (`harness team on`): its code
 * names that computer, the redeem must name it too, and redeeming ends the computer's ordinary sign-ins in
 * the same transaction. Who may ask for that is routes/auth.ts's to decide.
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

export type HarnessSessionKind = 'viewer' | 'computer' | 'team'
/** What a handoff code signs in: a phone (the Add Phone QR), or a Mac's team account. */
export type HandoffKind = 'viewer' | 'team'
/** What a QR sign-in can ask to become. Never a team session: that one is only ever a computer's handoff. */
export type QrSignInKind = 'viewer' | 'computer'

/**
 * A one-time code a signed-in computer puts in its Add Phone QR, or hands its team account.
 *
 * A viewer's code holds the bare user id, as every code did before team sessions. A team code holds JSON,
 * so a server that predates team sessions finds no account under it and refuses it: it can never become
 * a viewer's session, which reaches far more than a team session may.
 */
export async function startHandoff(
  userId: string,
  kind: HandoffKind = 'viewer',
  /** `convert`: a team code for this computer turning itself into a team machine, already proven to be that computer.
   *  `host`: the machine of the Mac whose team account redeems this code, already checked to be one of the account's
   *  own (routes/auth.ts); the team machine records it, so lists show that Mac once. */
  { convert, host }: { convert?: string; host?: string } = {},
): Promise<{ code: string; expiresIn: number; kind: HandoffKind }> {
  const code = newHarnessToken(HARNESS_HANDOFF_PREFIX)
  const held = kind === 'team' ? JSON.stringify({ userId, kind, ...(convert ? { convert } : {}), ...(host ? { host } : {}) }) : userId
  await pub.set(handoffKey(harnessTokenHash(code)), held, 'EX', HANDOFF_TTL_SEC)
  return { code, expiresIn: HANDOFF_TTL_SEC, kind }
}

/** Who a spent code was minted for, and as what; null for anything else. */
function handoffOf(held: unknown): { userId: string; kind: HandoffKind; convert?: string; host?: string } | null {
  if (typeof held !== 'string' || !held) return null
  if (!held.startsWith('{')) return { userId: held, kind: 'viewer' }
  try {
    const parsed = JSON.parse(held) as { userId?: unknown; kind?: unknown; convert?: unknown; host?: unknown }
    if (typeof parsed.userId !== 'string' || !parsed.userId || parsed.kind !== 'team') return null
    return { userId: parsed.userId, kind: 'team', ...(typeof parsed.convert === 'string' && parsed.convert ? { convert: parsed.convert } : {}),
      ...(typeof parsed.host === 'string' && parsed.host ? { host: parsed.host } : {}) }
  } catch { return null }
}

/**
 * Spend [code] and sign [label]'s device in as the account that minted it, as the kind it was minted
 * for. A team code also needs the redeeming daemon's [computerId], which its session is bound to. Null
 * for a code that is malformed, expired or already spent, and for a team code without a usable computer
 * — one answer for all of them, so a caller learns nothing.
 */
export async function redeemHandoff(code: string, label: string, computerId?: string): Promise<HarnessTokens | null> {
  if (!isHarnessHandoffCode(code)) return null
  // Read and spend in ONE step: two phones racing the same QR must not both get in. MULTI rather
  // than GETDEL, which a Redis older than 6.2 does not have.
  const key = handoffKey(harnessTokenHash(code))
  const [read] = (await pub.multi().get(key).del(key).exec()) ?? []
  if (!read || read[0]) throw read?.[0] ?? new Error('handoff redeem: no reply from Redis')
  const handoff = handoffOf(read[1])
  if (!handoff) return null
  if (handoff.kind === 'viewer') return createSession(handoff.userId, label || 'phone', 'viewer')
  const computer = computerId ? normalizeComputerId(computerId) : null
  if (!computer) return null
  // The computer that asked to become a team machine, and no other.
  if (handoff.convert) return handoff.convert === computer ? convertComputer(handoff.userId, label || 'Team', computer) : null
  if (await computerHeldByAnotherSignIn(handoff.userId, computer)) return null
  // A repair run signs the same team account in again: its machine already exists and records its Mac now. A new one
  // records it when it registers (MachineService.resolveForTeamComputer), from the session made here.
  if (handoff.host) {
    await prisma.machine.updateMany({ where: { userId: handoff.userId, computerId: computer, sessionKind: 'team', ...machineAlive },
      data: { hostMachineId: handoff.host } })
  }
  return createSession(handoff.userId, label || 'Team', 'team', computer, handoff.host)
}

// Not yet revoked. A session is created without `revokedAt`, and on MongoDB `revokedAt: null` alone
// does not match a field that is absent — so a revoke filtered on it alone never revoked anything.
const notRevoked: Prisma.HarnessSessionWhereInput = { OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }

/**
 * [computerId] becomes a team machine in place: in one transaction its Harness computer sessions end, its machine
 * rows are marked `team`, and its team session is created. A socket still connected for it under the old sign-in is
 * then told to close (lib/adapterWs.ts). An Autonomous sign-in on that computer is not this backend's to end; if it
 * connects again, the machine is an ordinary one again (adapterWs.ts) and the team session acts for nothing.
 */
async function convertComputer(userId: string, label: string, computerId: string): Promise<HarnessTokens | null> {
  const user = await userService.get(userId)
  if (!user) return null
  const refreshToken = newHarnessToken(HARNESS_TEAM_REFRESH_PREFIX)
  const { session, machineIds } = await prisma.$transaction(async (tx) => {
    await tx.harnessSession.updateMany({ where: { userId, kind: 'computer', computerId, ...notRevoked }, data: { revokedAt: new Date() } })
    const machines = await tx.machine.findMany({ where: { userId, computerId, ...machineAlive }, select: { machineId: true } })
    await tx.machine.updateMany({ where: { userId, computerId, ...machineAlive }, data: { sessionKind: 'team' } })
    const created = await tx.harnessSession.create({ data: {
      userId, refreshHash: harnessTokenHash(refreshToken), label, kind: 'team', computerId, expiresAt: sessionExpiry(),
    } })
    return { session: created, machineIds: machines.map((m) => m.machineId) }
  })
  for (const machineId of machineIds) {
    await publishDown(machineId, { connId: '', frame: { type: TEAM_CONVERTED_FRAME } }).catch(() => { /* best effort: the next connect decides */ })
  }
  return {
    token: await issueAccess(session.id, userId, 'team'),
    refreshToken,
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    kind: 'team',
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

/**
 * Whether the account already runs [computerId] as a machine under a sign-in that is not a team one. A
 * team session bound to that computer could connect as that machine; so it is never minted for one.
 * Rows from before `sessionKind` count as such a sign-in: they were all made by one.
 */
async function computerHeldByAnotherSignIn(userId: string, computerId: string): Promise<boolean> {
  const rows = await prisma.machine.findMany({ where: { userId, computerId, ...machineAlive }, select: { sessionKind: true } })
  return rows.some((row) => row.sessionKind !== 'team')
}

/** A new session for [userId]: a refresh token (stored hashed) and its first access token. */
async function createSession(userId: string, label: string, kind: HarnessSessionKind, computerId?: string, hostMachineId?: string): Promise<HarnessTokens | null> {
  const user = await userService.get(userId)
  if (!user) return null
  const refreshToken = newHarnessToken(kind === 'team' ? HARNESS_TEAM_REFRESH_PREFIX : HARNESS_REFRESH_PREFIX)
  const session = await prisma.harnessSession.create({
    data: {
      userId,
      refreshHash: harnessTokenHash(refreshToken),
      label,
      kind,
      // A team session's bound computer; a computer's own, as its QR sign-in declared it (what lets it convert itself).
      ...(kind !== 'viewer' && computerId ? { computerId } : {}),
      // A team session's Mac, which its machine records (MachineService.resolveForTeamComputer).
      ...(kind === 'team' && hostMachineId ? { hostMachineId } : {}),
      expiresAt: sessionExpiry(),
    },
  })
  return {
    token: await issueAccess(session.id, userId, kind),
    refreshToken,
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    kind,
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
  // A team session's tokens carry its own prefixes, and only its (harnessTokenFormat.ts).
  if ((session.kind === 'team') !== isTeamRefreshToken(refreshToken)) return null
  const user = await userService.get(session.userId)
  if (!user) return null
  await prisma.harnessSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date(), expiresAt: sessionExpiry() },
  })
  return {
    token: await issueAccess(session.id, session.userId, session.kind === 'team' ? 'team' : 'viewer'),
    expiresIn: HARNESS_ACCESS_TTL_SEC,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
  }
}

/** Sign out: the session's refresh token stops working, and so, at once, does its access token. */
export async function revokeHarnessSession(refreshToken: string): Promise<void> {
  if (!isHarnessRefreshToken(refreshToken)) return
  await prisma.harnessSession.updateMany({
    where: { refreshHash: harnessTokenHash(refreshToken), ...notRevoked },
    data: { revokedAt: new Date() },
  })
}

async function issueAccess(sessionId: string, userId: string, kind: HarnessSessionKind): Promise<string> {
  const token = newHarnessToken(kind === 'team' ? HARNESS_TEAM_ACCESS_PREFIX : HARNESS_ACCESS_PREFIX)
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
  let computerId: string | null | undefined
  try {
    const raw = await pub.get(accessKey(harnessTokenHash(token)))
    if (!raw) throw invalid()
    const held = JSON.parse(raw) as { sessionId?: unknown; userId?: unknown }
    if (typeof held.sessionId !== 'string' || typeof held.userId !== 'string') throw invalid()
    sessionId = held.sessionId
    const session = await prisma.harnessSession.findUnique({ where: { id: sessionId } })
    if (!session || session.revokedAt || session.userId !== held.userId) throw invalid()
    kind = session.kind
    computerId = session.computerId
    user = await userService.get(held.userId)
  } catch (err) {
    if (err instanceof SsoAuthError) throw err
    throw new SsoAuthError('Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE')
  }
  if (!user) throw invalid()
  const identity = {
    sub: user.id,
    email: user.email,
    role: user.role,
    autonomousEnv: storedAutonomousEnvironment(user.autonomousEnv),
    harnessSessionId: sessionId,
  }
  // A team session's token is never a computer's or a phone's, and the other way round (harnessTokenFormat.ts).
  if ((kind === 'team') !== isTeamAccessToken(token)) throw invalid()
  // A team session is nothing without the computer it is bound to: a row that lost it is no session.
  if (kind === 'team') {
    if (typeof computerId !== 'string' || !computerId) throw invalid()
    return { ...identity, harnessSessionKind: 'team', harnessComputerId: computerId }
  }
  if (kind === 'computer') return { ...identity, harnessSessionKind: 'computer', ...(computerId ? { harnessComputerId: computerId } : {}) }
  return { ...identity, harnessSessionKind: 'viewer' }
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
  computerId?: string
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
  req: { label: string; kind: QrSignInKind; computerId?: string; spokenCode?: boolean },
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
    ...(req.computerId ? { computerId: req.computerId } : {}),
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
  const computer = r.kind === 'computer' && r.computerId ? normalizeComputerId(r.computerId) : null
  const tokens = await createSession(r.userId, r.label, r.kind, computer ?? undefined)
  return tokens ? { ...tokens, email: r.email, kind: r.kind } : null
}
