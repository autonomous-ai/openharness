import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'node:crypto'

export interface AuthSession {
  version: 1
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  autonomousEnv: 'prod' | 'stag'
  computerId: string
  machineId?: string
  /** How this computer signed in: `qr` — a phone scanned its QR (a Harness-issued sign-in, which
   *  billing's Autonomous service does not take; grid does, through the Harness backend —
   *  autonomous-grid ADR 0046); absent or `sso` — the browser. */
  method?: 'sso' | 'qr'
  /** The auth-service client these tokens were issued to, as the backend's exchange reported it.
   *  A refresh has to name the same one. Absent is the backend's configured client. */
  clientId?: SsoClientId
  updatedAt: number
  /** Which sign-in by hand this session is: minted here when the person signs in, never anything the
   *  backend sends — the device key log keeps its marks per sign-in (deviceLogSyncer `signIn`). */
  signInEpoch?: string
  /** The account that sign-in by hand was made to (`/api/auth/me`'s user id, the device key log's `acct`),
   *  asked right after it: the log may then start over for that account any time, not only in 10 minutes. */
  signInAcct?: string
}

/**
 * auth-service's clients a computer signs in as (backend `SSO_CLIENT_IDS`): a person at a terminal,
 * or the desktop app running this CLI on their behalf.
 */
const SSO_CLIENT_IDS = { cli: 'harness-cli', desktop: 'harness-desktop' } as const
export type SsoClientId = (typeof SSO_CLIENT_IDS)[keyof typeof SSO_CLIENT_IDS]

/** The client for the surface that asked to sign in (`--entry-point`). */
export const ssoClientIdFor = (entryPoint: string): SsoClientId =>
  entryPoint === 'desktop' ? SSO_CLIENT_IDS.desktop : SSO_CLIENT_IDS.cli

/** A client id read back from the backend or the session file: one of ours, or nothing. */
export const knownSsoClientId = (raw: unknown): SsoClientId | undefined =>
  Object.values(SSO_CLIENT_IDS).find((id) => id === raw)

export class AuthSessionError extends Error {
  /** `SIGN_IN_AGAIN`: a Harness session SSO has not confirmed for longer than its grace (backend lib/ssoSession.ts). The
   *  person is asked to sign in again; the session is kept, unmarked, so SSO coming back renews it. */
  constructor(message: string, readonly code: 'MISSING' | 'INVALID_REFRESH' | 'UNAVAILABLE' | 'SIGN_IN_AGAIN') {
    super(message)
    this.name = 'AuthSessionError'
  }
}

const SESSION_CODES: ReadonlySet<string> = new Set(['MISSING', 'INVALID_REFRESH', 'UNAVAILABLE', 'SIGN_IN_AGAIN'])

/** A token handed to another process, or the session's own refusal: the asker can tell a sign-in that is over from one
 *  that could not be renewed just now (core/accountQueries.ts, and the gateway's process for the core). */
export async function tokenAnswer(token: () => Promise<string>): Promise<Record<string, unknown>> {
  try {
    return { token: await token() }
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return { code: typeof code === 'string' && code ? code : 'UNAVAILABLE', message: error instanceof Error ? error.message : String(error) }
  }
}

/** The token in a [tokenAnswer], or its refusal thrown as the session's own error. An answer that is neither (the process
 *  asked was not there) is `UNAVAILABLE`, in [unreachable]'s words. */
export function tokenOf(answer: Record<string, unknown>, unreachable: string): string {
  if (typeof answer.token === 'string') return answer.token
  const code = typeof answer.code === 'string' && SESSION_CODES.has(answer.code) ? answer.code as AuthSessionError['code'] : 'UNAVAILABLE'
  throw new AuthSessionError(typeof answer.message === 'string' && answer.message ? answer.message : unreachable, code)
}

// HARNESS_AUTH_DIR exists for isolated test processes. Product installs always use ~/.harness/auth.
export const AUTH_DIR = process.env.HARNESS_AUTH_DIR?.trim() || join(homedir(), '.harness', 'auth')
export const AUTH_SESSION_FILE = join(AUTH_DIR, 'session.json')
const LOCK_FILE = join(AUTH_DIR, 'session.lock')
const LOCK_STALE_MS = 30_000
const REFRESH_SKEW_MS = 60_000
// A refresh that never answers must fail, not hang: the daemon's backend reconnect waits on it, and
// the desktop app never restarts a daemon that is alive — so an unbounded fetch here was a machine
// that stayed "connected" in status and disconnected in fact until someone ran `harness stop`.
export const REFRESH_TIMEOUT_MS = 15_000
/** The longest a renewal can take: the refresh lock held by another process for its stale time, taken back and found
 *  held again for as long, then the refresh's own bound, with a few seconds over. The core waits this long on the
 *  gateway's (core/gatewayLink.ts): less, and it gave up on a renewal still under way. */
export const RENEWAL_WAIT_MS = 2 * LOCK_STALE_MS + REFRESH_TIMEOUT_MS + 5_000

/** How a token is asked for: renewed now (`force`), or because the last one was refused (`failedToken`). */
export interface TokenOptions { force?: boolean; failedToken?: string }

/** A [TokenOptions] as it crosses processes, read back: nothing else from the payload. */
export const tokenOptionsOf = (payload: Record<string, unknown>): TokenOptions =>
  ({ force: payload.force === true, ...(typeof payload.failedToken === 'string' ? { failedToken: payload.failedToken } : {}) })

/**
 * The token on disk when [opts] need no renewal of it; null when they do: it has expired or is about to, or a renewal
 * is asked (`force`, which a caller whose token was refused sends with that token). One that is no longer the token
 * refused is the answer: someone renewed it since. Signed out is `MISSING`. Read from the session file, so it needs no
 * other process: the core reads a token so and asks the gateway only to renew one (core/gatewayLink.ts), and a renewal
 * starts so (lib/authRefresh.ts).
 */
export function currentToken(opts: TokenOptions = {}): string | null {
  const current = readAuthSession()
  if (!current) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
  if (opts.failedToken && current.accessToken !== opts.failedToken) return current.accessToken
  const due = opts.force === true || (current.expiresAt != null && current.expiresAt <= Date.now() + REFRESH_SKEW_MS)
  return due ? null : current.accessToken
}

function parse(raw: string): AuthSession | null {
  try {
    const value = JSON.parse(raw) as Partial<AuthSession>
    if (value.version !== 1 || typeof value.accessToken !== 'string' || !value.accessToken ||
      typeof value.computerId !== 'string' || !value.computerId ||
      (value.autonomousEnv !== 'prod' && value.autonomousEnv !== 'stag')) return null
    return {
      version: 1,
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === 'string' && value.refreshToken ? { refreshToken: value.refreshToken } : {}),
      ...(typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? { expiresAt: value.expiresAt } : {}),
      autonomousEnv: value.autonomousEnv,
      computerId: value.computerId,
      ...(typeof value.machineId === 'string' && value.machineId ? { machineId: value.machineId } : {}),
      ...(value.method === 'qr' || value.method === 'sso' ? { method: value.method } : {}),
      ...(knownSsoClientId(value.clientId) ? { clientId: knownSsoClientId(value.clientId) } : {}),
      updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
      ...(typeof value.signInEpoch === 'string' && value.signInEpoch ? { signInEpoch: value.signInEpoch } : {}),
      ...(typeof value.signInAcct === 'string' && value.signInAcct ? { signInAcct: value.signInAcct } : {}),
    }
  } catch { return null }
}

/** A new `signInEpoch`, for a session a sign-in by hand just made: random, then `@` and when it was
 *  made (ms) — the device key log lets a sign-in start its file over only shortly after it was made. */
export const newSignInEpoch = (now = Date.now()): string => `${randomBytes(16).toString('hex')}@${now}`

/** How a `signInEpoch` given to a session from before epochs existed starts: nobody saw that sign-in made by hand here, so
 *  the device key log may take its file over for it but never starts one over. */
export const ADOPTED_SIGN_IN = 'adopted:'

/** Give a session from before epochs existed one (`ADOPTED_SIGN_IN`), under the refresh lock so a
 *  rotated refresh token is never written back over. The session's epoch; null when signed out. */
export async function ensureSignInEpoch(): Promise<string | null> {
  if (!readAuthSession()) return null
  return withLock(async () => {
    const latest = readAuthSession()
    if (!latest) return null
    if (latest.signInEpoch) return latest.signInEpoch
    const signInEpoch = ADOPTED_SIGN_IN + newSignInEpoch()
    writeAuthSession({ ...latest, signInEpoch })
    return signInEpoch
  })
}

/** A `signInEpoch` as the device key log reads it (deviceLogSyncer `signIn`): whether it was adopted,
 *  when it was made — null when it does not say (one from before the time was recorded) — and the
 *  account it was made to (`signInAcct`), never for an adopted one: nobody saw that sign-in made. */
export function signInOf(epoch: string | undefined | null, acct?: string | null): { epoch: string; adopted: boolean; at: number | null; acct?: string } | null {
  if (!epoch) return null
  const at = /@(\d{1,15})$/.exec(epoch)
  const adopted = epoch.startsWith(ADOPTED_SIGN_IN)
  return { epoch, adopted, at: at ? Number(at[1]) : null, ...(acct && !adopted ? { acct } : {}) }
}

/** A sign-in's signed-out mark ([markSignedOut]): why and since when, and for a refused refresh, when it
 *  may be tried again and how long the last wait was ([AuthSessionManager.retrySignedOut]). */
export interface SignedOutMark { at: number; reason: SignedOutReason; retryAt?: number; retryWait?: number }

/** The session on disk, and its signed-out mark when it has one ([markSignedOut]): what a refresh renews
 *  (lib/authRefresh.ts). */
export function readStored(): { session: AuthSession; signedOut: SignedOutMark | null } | null {
  let raw: string
  try { raw = readFileSync(AUTH_SESSION_FILE, 'utf8') } catch { return null }
  const session = parse(raw)
  if (!session) return null
  let mark: unknown
  try { mark = (JSON.parse(raw) as { signedOut?: unknown }).signedOut } catch { mark = undefined }
  const signedOut = typeof mark === 'object' && mark !== null
    && ((mark as { reason?: unknown }).reason === 'refresh-refused' || (mark as { reason?: unknown }).reason === 'revoked')
    ? {
        at: Number((mark as { at?: unknown }).at) || 0,
        reason: (mark as { reason: SignedOutReason }).reason,
        ...(typeof (mark as { retryAt?: unknown }).retryAt === 'number' ? { retryAt: (mark as { retryAt: number }).retryAt } : {}),
        ...(typeof (mark as { retryWait?: unknown }).retryWait === 'number' ? { retryWait: (mark as { retryWait: number }).retryWait } : {}),
      }
    : null
  return { session, signedOut }
}

/** This computer's sign-in, or null when it has none, or has one marked signed out ([markSignedOut]): nothing
 *  acts on that one again until a new sign-in replaces it. */
export function readAuthSession(): AuthSession | null {
  const stored = readStored()
  return stored && !stored.signedOut ? stored.session : null
}

export function hasAuthSession(): boolean { return readAuthSession() !== null }

function ensureDir(): void {
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 })
  try { chmodSync(AUTH_DIR, 0o700) } catch { /* best effort on non-POSIX */ }
}

export function writeAuthSession(session: AuthSession): void {
  ensureDir()
  const temp = join(AUTH_DIR, `.session.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temp, JSON.stringify(session) + '\n', { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* best effort on non-POSIX */ }
    renameSync(temp, AUTH_SESSION_FILE)
    try { chmodSync(AUTH_SESSION_FILE, 0o600) } catch { /* best effort on non-POSIX */ }
  } finally {
    try { rmSync(temp, { force: true }) } catch { /* ignore */ }
  }
}

/** Why a sign-in kept on disk is signed out: its refresh was refused, or it was revoked. */
export type SignedOutReason = 'refresh-refused' | 'revoked'

/**
 * Marks this computer's sign-in signed out, and keeps it. 10-27: a sign-out nobody asked for stalled a whole
 * Mac for hours. Nothing automatic deletes the sign-in any more (a refused refresh, a 401 or 403, a revoke):
 * it is marked instead, [readAuthSession] reads it as none, and a new sign-in's [writeAuthSession] replaces
 * it. Only a person deletes it (lib/signOut.ts `removeSignIn`). A refused refresh is tried again
 * ([AuthSessionManager.retrySignedOut]); a revoked one is not.
 */
export function markSignedOut(reason: SignedOutReason, at = Date.now(), lock: Lock = withLock): Promise<void> {
  // Under the refresh lock: a refresh another process has under way saves its session when it is done, and a
  // mark written before that save was written over by it, and the revoked sign-in used again (review of #1866).
  // A lock that cannot be had (another process holding it past its stale time) still marks: a revoke left
  // unmarked stopped the daemon, and the core that came back used the revoked sign-in until it was refused
  // again (follow-up to the review of #1866).
  return lock(async () => markSignedOutHeld(reason, at)).catch((error: unknown) => {
    if (!(error instanceof AuthSessionError) || error.code !== 'UNAVAILABLE') throw error
    markSignedOutHeld(reason, at)
  })
}

/** How [markSignedOut] and [updateAuthSession] take the refresh lock; a spec's own in place of [withLock]. */
export type Lock = <T>(action: () => Promise<T>) => Promise<T>

/**
 * Rewrites this computer's sign-in from the newest one on disk: [change] gives the new one, or null (or the
 * same one) to leave it. Under the refresh lock, so a refresh's rotated tokens and a signed-out mark are never
 * written over, and it is read again just before the write: a sign-in marked meanwhile is left marked (follow-up
 * to the review of #1866). The sign-in written; null when there was none, or it is marked signed out.
 */
export function updateAuthSession(change: (latest: AuthSession) => AuthSession | null): Promise<AuthSession | null> {
  if (!readAuthSession()) return Promise.resolve(null)
  return withLock(async () => {
    const latest = readAuthSession()
    if (!latest) return null
    const next = change(latest)
    if (!next || next === latest) return latest
    if (readStored()?.signedOut) return null
    writeAuthSession(next)
    return next
  })
}

/**
 * A machine id the backend named for the sign-in [startedUnder] (its `signInEpoch` when the lookup began), merged into the
 * newest session only if that is still the same sign-in. A lookup can outlive a sign-out and a new sign-in, and its answer is
 * the old account's machine: dropped, as a later lookup finds the new one. A refresh keeps the epoch, so it keeps the answer. A
 * session from before epochs may only have been given one meanwhile (adopted): still that sign-in. The newest session; null
 * when there is none, or it is marked signed out.
 */
export function recordMachineId(machineId: string, startedUnder: string | undefined): Promise<AuthSession | null> {
  return updateAuthSession((latest) => !sameSignIn(latest, startedUnder) || latest.machineId === machineId
    ? null : { ...latest, machineId, updatedAt: Date.now() })
}

/** Whether [latest] is still the sign-in a lookup started under ([recordMachineId]). */
export function sameSignIn(latest: AuthSession, startedUnder: string | undefined): boolean {
  if (latest.signInEpoch === startedUnder) return true
  return startedUnder === undefined && signInOf(latest.signInEpoch)?.adopted === true
}

/** The first wait before a refused refresh is tried again, and the longest. The app asks `auth status` often,
 *  and each ask must not be a refresh request. */
export const RETRY_FIRST_MS = 60_000
export const RETRY_LONGEST_MS = 60 * 60_000

/** [markSignedOut], by a caller that holds the refresh lock already: the refresh that was refused (lib/authRefresh.ts). */
export function markSignedOutHeld(reason: SignedOutReason, at: number): void {
  const stored = readStored()
  if (!stored || stored.signedOut) return
  const mark: SignedOutMark = reason === 'refresh-refused'
    ? { at, reason, retryAt: at + RETRY_FIRST_MS, retryWait: RETRY_FIRST_MS }
    : { at, reason }
  writeAuthSession({ ...stored.session, signedOut: mark } as AuthSession)
}

/** Why and since when this computer's sign-in is signed out, kept on disk; null when it is not. */
export function readSignedOut(): SignedOutMark | null {
  return readStored()?.signedOut ?? null
}

export function clearAuthSession(): void {
  try { rmSync(AUTH_SESSION_FILE, { force: true }) } catch { /* ignore */ }
}

// Whether THIS process holds the refresh lock right now. `process.exit` skips the `finally` below, and
// a daemon that exits mid-refresh (safe mode's own deadline, a revoke) used to leave the lock behind:
// the next `harness auth status` — the one the desktop app runs before respawning that daemon — then
// sat out the whole LOCK_STALE_MS before it could answer, and the app gave up on it at exactly 30s.
let holdingLock = false
let releaseOnExitArmed = false

/** Drop the refresh lock if this process holds it. Run on `exit`; exported for the spec. */
export function releaseHeldAuthLock(): void {
  if (!holdingLock) return
  holdingLock = false
  try { rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }
}

/** The refresh lock: one process at a time renews or marks the sign-in, so a rotated refresh token is never written
 *  back over (lib/authRefresh.ts, and every writer here). */
export async function withLock<T>(action: () => Promise<T>): Promise<T> {
  ensureDir()
  let deadline = Date.now() + LOCK_STALE_MS
  let reclaimedStaleLock = false
  while (true) {
    let fd: number
    try {
      fd = openSync(LOCK_FILE, 'wx', 0o600)
    } catch {
      if (Date.now() >= deadline) {
        let removed = false
        try {
          const age = Date.now() - statSync(LOCK_FILE).mtimeMs
          if (age >= LOCK_STALE_MS) {
            rmSync(LOCK_FILE, { force: true })
            removed = true
          }
        } catch { /* lock disappeared or is unreadable */ }
        if (removed && !reclaimedStaleLock) {
          reclaimedStaleLock = true
          deadline = Date.now() + LOCK_STALE_MS
          continue
        }
        throw new AuthSessionError('Another Harness process is refreshing SSO credentials. Please retry.', 'UNAVAILABLE')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      continue
    }
    holdingLock = true
    if (!releaseOnExitArmed) {
      releaseOnExitArmed = true
      process.once('exit', releaseHeldAuthLock)
    }
    try {
      return await action()
    } finally {
      holdingLock = false
      closeSync(fd)
      try { rmSync(LOCK_FILE, { force: true }) } catch { /* ignore */ }
    }
  }
}
