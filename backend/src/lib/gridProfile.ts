import { isProvisionalUserEmail, userService } from '../services/UserService.js'
import { logger } from '../utils/logger.js'
import { storedAutonomousEnvironment } from './autonomousEnvironment.js'
import { LiveProfileError, readLiveProfile, recordLiveProfile, type LiveProfile } from './googleSubject.js'
import type { AuthUser } from './ssoAuth.js'

/**
 * What `GET /api/grid/profile` answers: who holds this Harness sign-in token, for the Grid control
 * plane (grid-apis `/v1/grid/auth/harness`). ADR 0046 in the autonomous-grid repository is the record.
 *
 * ⚠️ **The success body is Autonomous-shaped on purpose — a contract, not an accident.** It is the
 * subset of the Autonomous account API's `/me/profile` answer that the control plane's
 * `account_api.identity_from_profile` already parses: an INTEGER `status: 1` (not this backend's
 * usual `{success, data}`), and `data.{id, email, full_name, customer_socials[{source, uid}]}`. The
 * account key rules stay in the control plane, which is why the shape is theirs. Do not "tidy" it
 * into `sendSuccess`; `routes/fixtures/gridProfile.contract.json` pins it, and grid-apis holds a
 * hand-duplicated copy that its own tests parse.
 *
 * ⚠️ **409 means exactly one thing here: the account's Google subject is not yet known.** The
 * control plane branches on that status alone, without reading a code, so no other condition on this
 * route may ever produce a 409.
 */

export const GRID_PROFILE_PATH = '/api/grid/profile'

export interface GridProfileBody {
  status: 1
  data: { id: string; email: string; full_name: string; customer_socials: Array<{ source: 'google'; uid: string }> }
}

export type GridProfileAnswer =
  | { status: 200; body: GridProfileBody }
  | { status: 401 | 403 | 409 | 429 | 503; code: string; message: string }

/**
 * Live reads one account may cause through this route per minute, in this process. The control plane
 * asks once per Grid sign-in; anything past this is somebody looping the route with their own
 * Autonomous token to make this backend hammer the storefront from its own address — which every
 * user's token validation shares. A computer sign-in reads nothing upstream and is not counted.
 */
export const GRID_PROFILE_LIVE_READS_PER_MINUTE = 10
const LIVE_READ_WINDOW_MS = 60_000
const LIVE_READ_ENTRIES_MAX = 10_000
const liveReads = new Map<string, number[]>()

/** Count one live read for this account; false when it is over the limit. */
function admitLiveRead(userId: string, now = Date.now()): boolean {
  const recent = (liveReads.get(userId) ?? []).filter((at) => now - at < LIVE_READ_WINDOW_MS)
  if (recent.length >= GRID_PROFILE_LIVE_READS_PER_MINUTE) return false
  if (!liveReads.has(userId) && liveReads.size >= LIVE_READ_ENTRIES_MAX) {
    const oldest = liveReads.keys().next().value
    if (oldest !== undefined) liveReads.delete(oldest)
  }
  liveReads.set(userId, [...recent, now])
  return true
}

/** Forget the per-account live read counts. Tests only. */
export function resetGridProfileLimits(): void {
  liveReads.clear()
}

/** Only these fields, and never a social's `token`, whatever the source held. */
export function gridProfileBody(profile: LiveProfile): GridProfileBody {
  return {
    status: 1,
    data: {
      id: profile.customerId,
      email: profile.email,
      full_name: profile.fullName,
      customer_socials: profile.googleSub ? [{ source: 'google', uid: profile.googleSub }] : [],
    },
  }
}

const refuse = (status: 401 | 403 | 409 | 429 | 503, code: string, message: string): GridProfileAnswer => ({ status, code, message })

const UNAUTHORIZED = refuse(401, 'UNAUTHORIZED', 'Unauthorized')
const STAGING_PLANE = refuse(403, 'STAGING_PLANE', 'This account signs in through the staging Autonomous plane, which Grid does not accept')
const PROVISIONAL = refuse(403, 'PROVISIONAL_ACCOUNT', "This account's Autonomous identity is not known yet; sign in to Harness with Google, Apple or your email first")

/** A customer id this backend minted itself (staging-created or local accounts), or a device's placeholder row. */
function isProvisional(user: { email: string; externalId: string }): boolean {
  return isProvisionalUserEmail(user.email) || user.externalId.startsWith('local-')
}

/** The answer for this caller. `token` is the bearer the authentication middleware already accepted. */
export async function answerGridProfile(caller: AuthUser, token: string): Promise<GridProfileAnswer> {
  if (caller.harnessSessionId) return answerHarnessSession(caller)

  // An Autonomous token: read it live. The middleware's acceptance may have come from the
  // authentication cache, and a token Autonomous revoked a moment ago must not reach Grid from there.
  if (caller.autonomousEnv !== 'prod') return STAGING_PLANE
  const user = await userService.get(caller.sub)
  if (!user) return UNAUTHORIZED
  if (storedAutonomousEnvironment(user.autonomousEnv) !== 'prod') return STAGING_PLANE

  if (!admitLiveRead(user.id)) {
    return refuse(429, 'TOO_MANY_REQUESTS', 'Too many Grid profile reads for this account; try again in a minute')
  }

  let live: LiveProfile
  const readAt = new Date()
  try {
    live = await readLiveProfile(token)
  } catch (err) {
    if (err instanceof LiveProfileError && err.code === 'REJECTED') {
      return refuse(401, 'UNAUTHORIZED', 'Autonomous rejected this sign-in')
    }
    return refuse(503, 'AUTH_SERVICE_UNAVAILABLE', 'The Autonomous account service could not be reached; try again in a moment')
  }
  try {
    await recordLiveProfile(user, live, readAt)
  } catch {
    // The answer is the live read's either way; a failed write only leaves the stored value older.
    logger.warn('grid profile: could not record the live read', { userId: user.id })
  }
  return { status: 200, body: gridProfileBody(live) }
}

/** A sign-in Harness issued itself: only a computer's, answered from what was last read live. */
async function answerHarnessSession(caller: AuthUser): Promise<GridProfileAnswer> {
  // A phone never calls Grid, and a lost phone must not become a long-lived Grid session.
  if (caller.harnessSessionKind !== 'computer') {
    return refuse(403, 'PHONE_SIGN_IN', 'A phone sign-in cannot be used for Grid; sign in on a computer')
  }
  const user = await userService.get(caller.sub)
  if (!user) return UNAUTHORIZED
  if (storedAutonomousEnvironment(user.autonomousEnv) !== 'prod') return STAGING_PLANE
  if (isProvisional(user)) return PROVISIONAL
  const checkedAt = user.googleSubCheckedAt
  if (!(checkedAt instanceof Date) || Number.isNaN(checkedAt.getTime())) {
    return refuse(409, 'GOOGLE_SUBJECT_UNKNOWN',
      "Harness hasn't confirmed this account's Google identity yet; sign in to Harness once with Google, Apple or your email on any device, then try again")
  }
  return {
    status: 200,
    body: gridProfileBody({
      customerId: user.externalId,
      email: user.email,
      fullName: user.name ?? '',
      googleSub: user.googleSub ?? null,
    }),
  }
}
