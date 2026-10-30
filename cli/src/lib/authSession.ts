import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, hostname } from 'os'
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
  /** `team`: a Harness Team sign-in (cli/src/team/), which runs this computer's own daemon and its Swarm agents and
   *  reaches none of the account's other computers. Absent: a computer's ordinary sign-in. */
  kind?: 'team'
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

// HARNESS_AUTH_DIR exists for isolated test processes. Product installs always use ~/.harness/auth.
export const AUTH_DIR = process.env.HARNESS_AUTH_DIR?.trim() || join(homedir(), '.harness', 'auth')
export const AUTH_SESSION_FILE = join(AUTH_DIR, 'session.json')
const LOCK_FILE = join(AUTH_DIR, 'session.lock')
const LOCK_STALE_MS = 30_000
const REFRESH_SKEW_MS = 60_000

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
      ...(value.kind === 'team' ? { kind: 'team' as const } : {}),
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

/** How a `signInEpoch` given to a session from before epochs existed starts: nobody saw that sign-in
 *  being made here, so the device key log may take its file over for it but never starts one over. */
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

/** The session on disk, and its signed-out mark when it has one ([markSignedOut]). */
function readStored(): { session: AuthSession; signedOut: SignedOutMark | null } | null {
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

/** The first wait before a refused refresh is tried again, and the longest. The app asks `auth status` often,
 *  and each ask must not be a refresh request. */
const RETRY_FIRST_MS = 60_000
const RETRY_LONGEST_MS = 60 * 60_000

/** [markSignedOut], by a caller that holds the refresh lock already: the refresh that was refused. */
function markSignedOutHeld(reason: SignedOutReason, at: number): void {
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

async function withLock<T>(action: () => Promise<T>): Promise<T> {
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

type RefreshResult = { token: string; refreshToken?: string; expiresIn?: number }

/**
 * What this computer asks the backend for in place of SSO tokens, when it signs in and when it renews an SSO sign-in:
 * a Harness session of its own (backend lib/ssoSession.ts), so an ordinary request never waits on the account
 * service. A backend from before it answers with the SSO tokens as ever, and those are kept.
 */
export const harnessSessionRequest = (): { kind: 'computer'; label: string } => ({ kind: 'computer', label: hostname().slice(0, 80) })

/** Whether renewing [session] asks to move it to a Harness session: an SSO sign-in's does. One that is a Harness
 *  session already (`hnr_`, `htr_`) renews as one, and a QR or team sign-in is a session of its own kind. */
export function asksForHarnessSession(session: AuthSession): boolean {
  return session.kind !== 'team' && session.method !== 'qr' && !/^(hnr|htr)_/.test(session.refreshToken ?? '')
}

/**
 * The sentence an `UNAVAILABLE` refresh failure carries — and why it names `harness login` even
 * though it is classified as a service problem.
 *
 * Measured 2026-09-06 against the live backend: an unusable refresh token comes back as
 * `503 {"error":{"code":"AUTH_SERVICE_UNAVAILABLE"}}` — **not** 401 and **not**
 * `REFRESH_TOKEN_INVALID`, so it never reaches the branch below whose whole job is to say the
 * sign-in is dead. Passing the upstream's own words through verbatim then tells somebody whose
 * sign-in has lapsed to wait for a service that is perfectly healthy, and that wait never ends.
 *
 * ⚠️ **It cannot simply be reclassified as `INVALID_REFRESH`.** The identical answer is what a
 * genuine outage gives, and that branch DELETES the session — destroying a refresh token nothing
 * can bring back, on a blip. Ambiguous means keep the credential and say both things. So the
 * classification stays `UNAVAILABLE`, nothing is deleted, and only the wording changes: the
 * upstream's reading first because it is the likelier one, the actionable one last because it is
 * the one that ends the loop.
 */
function unavailableMessage(said?: string): string {
  return `Could not renew this computer's sign-in${said ? ` (${said})` : ''}. `
    + 'That is usually the SSO service having a moment, but it is also what a lapsed sign-in looks '
    + 'like here — if it keeps happening, run `harness login` to sign in again.'
}

// A refresh that never answers must fail, not hang: the daemon's backend reconnect waits on it, and
// the desktop app never restarts a daemon that is alive — so an unbounded fetch here was a machine
// that stayed "connected" in status and disconnected in fact until someone ran `harness stop`.
const REFRESH_TIMEOUT_MS = 15_000

async function refreshRequest(baseUrl: string, current: AuthSession, timeoutMs = REFRESH_TIMEOUT_MS): Promise<RefreshResult> {
  if (!current.refreshToken) throw new AuthSessionError('No SSO refresh token. Run `harness login`.', 'MISSING')
  let response: Response
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        refreshToken: current.refreshToken,
        autonomousEnv: current.autonomousEnv,
        ...(current.clientId ? { clientId: current.clientId } : {}),
        ...(asksForHarnessSession(current) ? { harnessSession: harnessSessionRequest() } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new AuthSessionError(unavailableMessage(), 'UNAVAILABLE')
  }
  const body = await response.json().catch(() => ({})) as {
    success?: boolean; data?: { token?: unknown; refreshToken?: unknown; expiresIn?: unknown }; error?: { code?: unknown; message?: unknown }
  }
  if (response.status === 401 || body.error?.code === 'REFRESH_TOKEN_INVALID') {
    throw new AuthSessionError('SSO refresh token is invalid. Run `harness login`.', 'INVALID_REFRESH')
  }
  if (body.error?.code === 'SIGN_IN_AGAIN') {
    throw new AuthSessionError('Sign in again: this computer\'s sign-in could not be confirmed with your Autonomous account '
      + 'for 7 days. Run `harness login`.', 'SIGN_IN_AGAIN')
  }
  if (!response.ok || body.success === false || typeof body.data?.token !== 'string' || !body.data.token) {
    throw new AuthSessionError(
      unavailableMessage(typeof body.error?.message === 'string' && body.error.message ? body.error.message : undefined),
      'UNAVAILABLE',
    )
  }
  return {
    token: body.data.token,
    ...(typeof body.data.refreshToken === 'string' && body.data.refreshToken ? { refreshToken: body.data.refreshToken } : {}),
    ...(typeof body.data.expiresIn === 'number' && body.data.expiresIn > 0 ? { expiresIn: body.data.expiresIn } : {}),
  }
}

/** One in-process refresh plus a file lock for daemon/command races. */
export class AuthSessionManager {
  private refreshInFlight: Promise<string> | null = null
  constructor(
    private readonly backendBaseUrl: string,
    private readonly opts: { refreshTimeoutMs?: number } = {},
  ) {}

  session(): AuthSession | null { return readAuthSession() }

  async accessToken(opts: { force?: boolean; failedToken?: string } = {}): Promise<string> {
    const current = readAuthSession()
    if (!current) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
    if (opts.failedToken && current.accessToken !== opts.failedToken) return current.accessToken
    const needsRefresh = opts.force === true || (current.expiresAt != null && current.expiresAt <= Date.now() + REFRESH_SKEW_MS)
    if (!needsRefresh) return current.accessToken
    if (this.refreshInFlight) return this.refreshInFlight
    const running = withLock(async () => {
      const latest = readAuthSession()
      if (!latest) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
      if (opts.failedToken && latest.accessToken !== opts.failedToken) return latest.accessToken
      const stillNeedsRefresh = opts.force === true || (latest.expiresAt != null && latest.expiresAt <= Date.now() + REFRESH_SKEW_MS)
      if (!stillNeedsRefresh) return latest.accessToken
      try {
        const refreshed = await refreshRequest(this.backendBaseUrl, latest, this.opts.refreshTimeoutMs)
        const next: AuthSession = {
          ...latest,
          accessToken: refreshed.token,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresIn ? { expiresAt: Date.now() + refreshed.expiresIn * 1000 } : {}),
          updatedAt: Date.now(),
        }
        writeAuthSession(next)
        return next.accessToken
      } catch (err) {
        if (err instanceof AuthSessionError && err.code === 'INVALID_REFRESH') markSignedOutHeld('refresh-refused', Date.now())
        throw err
      }
    })
    this.refreshInFlight = running
    try { return await running } finally { if (this.refreshInFlight === running) this.refreshInFlight = null }
  }

  /**
   * Tries a refused refresh again: the refusal may have been the service's, not the sign-in's. One that works
   * signs this computer back in. A revoked sign-in is never tried: it waits for a new one. True when the
   * computer is signed in again.
   */
  async retrySignedOut(now = Date.now()): Promise<boolean> {
    const due = (mark: SignedOutMark | null | undefined): boolean =>
      mark?.reason === 'refresh-refused' && now >= (mark.retryAt ?? 0)
    if (!due(readStored()?.signedOut)) return false
    return withLock(async () => {
      const stored = readStored()
      if (!stored || !stored.signedOut) return stored !== null
      const mark = stored.signedOut
      if (!due(mark)) return false
      try {
        const refreshed = await refreshRequest(this.backendBaseUrl, stored.session, this.opts.refreshTimeoutMs)
        writeAuthSession({
          ...stored.session,
          accessToken: refreshed.token,
          ...(refreshed.refreshToken ? { refreshToken: refreshed.refreshToken } : {}),
          ...(refreshed.expiresIn ? { expiresAt: Date.now() + refreshed.expiresIn * 1000 } : {}),
          updatedAt: Date.now(),
        })
        return true
      } catch {
        // Not yet: tried again after twice the last wait, at most an hour on.
        const wait = Math.min((mark.retryWait ?? RETRY_FIRST_MS) * 2, RETRY_LONGEST_MS)
        writeAuthSession({ ...stored.session, signedOut: { ...mark, retryAt: now + wait, retryWait: wait } } as AuthSession)
        return false
      }
    })
  }

  async updateMachineId(machineId: string): Promise<void> {
    await updateAuthSession((current) => current.machineId === machineId ? null : { ...current, machineId, updatedAt: Date.now() })
  }
}
