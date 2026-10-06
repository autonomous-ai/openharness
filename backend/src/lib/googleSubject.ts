import { env } from '../config/env.js'
import { normalizeUserEmail, userService } from '../services/UserService.js'
import { logger } from '../utils/logger.js'
import { autonomousEnvironmentConfig, type AutonomousEnvironment } from './autonomousEnvironment.js'

/**
 * The account's **Google subject**, as this backend last read it live from the Autonomous profile.
 *
 * Why it is kept at all (ADR 0046, in the autonomous-grid repository): the Grid control plane keys a
 * person's Grid account by their Google subject when they have one, and learns it by asking who holds
 * a Harness sign-in token. For an Autonomous token the profile can be read live. A computer signed in
 * by QR holds a token Harness issued itself, which Autonomous cannot read — so the only way to answer
 * for it is from what was read the last time one of the account's Autonomous tokens was seen.
 *
 * Three rules make that stored value safe to key a permanent account on:
 *  - **Every successful live read overwrites it**, including to "none" — a fill below, or the profile
 *    route. A stored value is never kept over a fresher answer.
 *  - **Never checked is not "none".** An account this backend has never read is answered 409 by the
 *    profile route, not keyed by its customer id: an account key is permanent, and guessing for a
 *    Google-linked account would split it from its website sign-in for good.
 *  - **The stored-versus-live check**: when a live read disagrees with what was stored, one log line
 *    names the fields that differ — never a value. It is what gates the Grid cut-over.
 *
 * ⚠️ The profile body is a credential: `customer_socials[].token` is the person's live Google OAuth
 * token. [readLiveProfile] copies four fields out of it and drops the rest; nothing here logs, stores
 * or returns any other part of it.
 */

/** How long a check stands before an Autonomous-token request reads the profile again. */
export const GOOGLE_SUBJECT_RECHECK_MS = 7 * 24 * 60 * 60 * 1000

const GOOGLE_SOURCE = 'google'

/** All a live read keeps of an Autonomous profile. `googleSub` null = the account has no Google identity. */
export interface LiveProfile {
  customerId: string
  email: string
  fullName: string
  googleSub: string | null
}

/** The stored half of the comparison: what a user row says, absent fields included. */
export interface StoredGoogleSubject {
  id: string
  email: string
  externalId: string
  googleSub?: string | null
  googleSubCheckedAt?: Date | null
}

export class LiveProfileError extends Error {
  constructor(message: string, readonly code: 'REJECTED' | 'UNAVAILABLE') {
    super(message)
    this.name = 'LiveProfileError'
  }
}

/**
 * Read the full Autonomous profile for this token, live — never the authentication cache, never the
 * identity endpoint (it answers from the token alone and carries no socials). Production plane only:
 * a Google subject is only ever learned from production.
 *
 * REJECTED = Autonomous said the token is not good (401/403, or its envelope saying so).
 * UNAVAILABLE = no answer we can read (unreachable, 5xx, a malformed body).
 */
export async function readLiveProfile(token: string, fetchImpl: typeof fetch = fetch): Promise<LiveProfile> {
  const { ssoProfileUrl } = autonomousEnvironmentConfig('prod')
  let res: Response
  try {
    res = await fetchImpl(ssoProfileUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // The account API refuses every /api/v1 request without a locale here (see ssoAuth.ts).
        Location: 'en-US',
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(env.SSO_PROFILE_TIMEOUT_MS),
    })
  } catch {
    throw new LiveProfileError('Autonomous profile service unreachable', 'UNAVAILABLE')
  }
  if (res.status === 401 || res.status === 403) {
    throw new LiveProfileError('Autonomous rejected the token', 'REJECTED')
  }
  if (!res.ok) throw new LiveProfileError(`Autonomous profile service returned ${res.status}`, 'UNAVAILABLE')

  let raw: unknown
  try { raw = await res.json() } catch {
    throw new LiveProfileError('Autonomous profile service returned invalid JSON', 'UNAVAILABLE')
  }
  return profileFrom(raw)
}

/** The four fields, out of Autonomous' own envelope. Defensive before every index. */
function profileFrom(raw: unknown): LiveProfile {
  const unreadable = (what: string) => new LiveProfileError(`Autonomous profile unreadable (${what})`, 'UNAVAILABLE')
  if (!raw || typeof raw !== 'object') throw unreadable('body')
  const body = raw as { status?: unknown; message?: unknown; data?: unknown }
  if (body.status !== 1) {
    // Its own envelope saying no under an HTTP 200; the same reading ssoAuth.ts gives it.
    if (typeof body.message === 'string' && /invalid|expired|unauthorized/i.test(body.message)) {
      throw new LiveProfileError('Autonomous rejected the token', 'REJECTED')
    }
    throw unreadable('status')
  }
  if (!body.data || typeof body.data !== 'object') throw unreadable('data')
  const data = body.data as Record<string, unknown>
  const customerId = text(data.id)
  const email = normalizeUserEmail(text(data.email))
  if (!customerId) throw unreadable('id')
  if (!email) throw unreadable('email')

  // Absent or null is an account with no social sign-in (an email-registered account has no key).
  const socials = data.customer_socials ?? []
  if (!Array.isArray(socials)) throw unreadable('customer_socials')
  const google = socials.find((s): s is Record<string, unknown> =>
    !!s && typeof s === 'object' && text((s as Record<string, unknown>).source).toLowerCase() === GOOGLE_SOURCE)
  let googleSub: string | null = null
  if (google) {
    googleSub = text(google.uid)
    // A Google identity we cannot read is not "no Google": recording none would key a Google-linked
    // account by its customer id, a second key for one person.
    if (!googleSub) throw unreadable('google uid')
  }
  const fullName = text(data.full_name) || (google ? text(google.full_name) : '')
  return { customerId, email, fullName, googleSub }
}

/**
 * One trimmed string, or ''. `uid` is a string in every sample but a number in the API's schema — and
 * a 21-digit Google subject parsed as a JSON number has already lost its last digits (JS doubles hold
 * 15–16). So a number counts only when it is exact; anything else reads as missing, which for a
 * Google social is "unreadable", never a rounded subject keyed on for good.
 */
function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return ''
}

/** Never checked, or checked longer ago than the recheck interval. Absent and null are both "never". */
export function needsGoogleSubjectCheck(user: Pick<StoredGoogleSubject, 'googleSubCheckedAt'>, now = Date.now()): boolean {
  const checkedAt = user.googleSubCheckedAt
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) return true
  return now - checkedAt.getTime() > GOOGLE_SUBJECT_RECHECK_MS
}

/**
 * Overwrite the stored Google subject with what a live read said, and run the stored-versus-live check
 * against what was there. `readAt` is when the read BEGAN: a slower read never replaces a fresher one.
 *
 * Two guards, one log line each, field names only — never a value from either side:
 *  - **The read must be of THIS row's customer.** A live profile naming another customer id or email
 *    than the row (two Autonomous accounts reaching one email) is not recorded at all: its Google
 *    subject would then be answered for a computer of the row's account. Together with the upsert
 *    forgetting the Google subject whenever a row's production subject changes
 *    (`UserService.upsertFromSso`), a stored Google subject is always the row's own customer's.
 *  - **The stored-versus-live check** runs only on an account checked before — a first fill has
 *    nothing stored to disagree with — and by the guard above it can only ever name `google_sub`.
 */
export async function recordLiveProfile(stored: StoredGoogleSubject, live: LiveProfile, readAt = new Date()): Promise<void> {
  const otherCustomer = [
    ...(stored.externalId !== live.customerId ? ['customer_id'] : []),
    ...(normalizeUserEmail(stored.email ?? '') !== live.email ? ['email'] : []),
  ]
  if (otherCustomer.length > 0) {
    logger.warn('google subject: live read is of another customer than the row; not recorded', { userId: stored.id, fields: otherCustomer })
    return
  }
  if (stored.googleSubCheckedAt && (stored.googleSub ?? null) !== live.googleSub) {
    logger.warn('google subject: stored and live disagree', { userId: stored.id, fields: ['google_sub'] })
  }
  await userService.recordGoogleSubject(stored.id, live.googleSub, readAt)
}

// One fill per account per process at a time. Across processes (a pm2 cluster) two workers can each
// read an account's profile once in the window before the first write lands; that is the whole cost,
// once per account per recheck interval, and it is what keeps a fill free of any shared lock.
const filling = new Set<string>()

/** How many fills one process runs at once. Past it a fill is DROPPED, not queued: the account stays
 *  unchecked and a later request picks it up. Bounds the burst after a deploy reconnects every daemon. */
export const MAX_CONCURRENT_FILLS = 16

/** After a failed read, how long this process leaves the account alone. A read that keeps failing
 *  (Autonomous degraded, a profile it cannot serve) must not become one storefront read per request. */
export const FILL_RETRY_AFTER_MS = 60_000
const FILL_RETRY_ENTRIES_MAX = 10_000
const retryAfter = new Map<string, number>()

function backOff(userId: string): void {
  if (retryAfter.size >= FILL_RETRY_ENTRIES_MAX) {
    const oldest = retryAfter.keys().next().value
    if (oldest !== undefined) retryAfter.delete(oldest)
  }
  retryAfter.set(userId, Date.now() + FILL_RETRY_AFTER_MS)
}

/** Forget this process' in-flight and back-off state. Tests only. */
export function resetGoogleSubjectFill(): void {
  filling.clear()
  retryAfter.clear()
}

/**
 * After an Autonomous token authenticates: if the account is unchecked or its check is older than
 * [GOOGLE_SUBJECT_RECHECK_MS], read the profile once and record the answer. Fire-and-forget — the
 * request never waits for it, and nothing it does can fail the request. A failed read records
 * nothing, so the account stays unchecked and is retried by a request after [FILL_RETRY_AFTER_MS].
 */
export function scheduleGoogleSubjectFill(
  token: string,
  user: StoredGoogleSubject,
  autonomousEnv: AutonomousEnvironment,
): void {
  try {
    if (autonomousEnv !== 'prod') return
    if (!needsGoogleSubjectCheck(user) || filling.has(user.id)) return
    if ((retryAfter.get(user.id) ?? 0) > Date.now()) return
    if (filling.size >= MAX_CONCURRENT_FILLS) return
    filling.add(user.id)
    const readAt = new Date()
    void (async () => {
      try {
        await recordLiveProfile(user, await readLiveProfile(token), readAt)
        retryAfter.delete(user.id)
      } catch (err) {
        backOff(user.id)
        // A status or a field name, never a value from the body.
        logger.warn('google subject fill failed', {
          userId: user.id,
          reason: err instanceof LiveProfileError ? err.code : 'RECORD_FAILED',
        })
      } finally {
        filling.delete(user.id)
      }
    })()
  } catch {
    // Deciding whether to fill must never cost the caller its sign-in either.
  }
}
