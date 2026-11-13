/**
 * Renewing this computer's sign-in: the one request to the backend's auth that a token's expiry needs, and the manager
 * that shares one renewal between everyone in a process who asks for a token. The session file itself, its lock and
 * its marks are lib/authSession.ts.
 *
 * Its own file so the daemon's core loads none of it: the gateway's process renews the sign-in, and the core, which
 * asks it for a token (core/gatewayLink.ts), calls no other host (the core audit of 2026-11-12, decision 4). The CLI's
 * commands renew in their own process, under the same lock.
 */
import { hostname } from 'os'
import {
  AuthSessionError, currentToken, markSignedOutHeld, readAuthSession, readStored, REFRESH_TIMEOUT_MS, RETRY_FIRST_MS,
  RETRY_LONGEST_MS, withLock, writeAuthSession, type AuthSession, type SignedOutMark, type TokenOptions,
} from './authSession.js'

type RefreshResult = { token: string; refreshToken?: string; expiresIn?: number }

/**
 * What this computer asks the backend for in place of SSO tokens, when it signs in and when it renews an SSO sign-in:
 * a Harness session of its own (backend lib/ssoSession.ts), so an ordinary request never waits on the account
 * service. A backend from before it answers with the SSO tokens as ever, and those are kept.
 */
export const harnessSessionRequest = (): { kind: 'computer'; label: string } => ({ kind: 'computer', label: hostname().slice(0, 80) })

/** Whether renewing [session] asks to move it to a Harness session: an SSO sign-in's does. One that is a Harness
 *  session already (`hnr_`) renews as one, and a QR sign-in is a session of its own kind. */
function asksForHarnessSession(session: AuthSession): boolean {
  return session.method !== 'qr' && !session.refreshToken?.startsWith('hnr_')
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

  async accessToken(opts: TokenOptions = {}): Promise<string> {
    const ready = currentToken(opts)
    if (ready !== null) return ready
    if (this.refreshInFlight) return this.refreshInFlight
    const running = withLock(async () => {
      // Again under the lock: another process may have renewed it meanwhile, or the person signed out.
      const settled = currentToken(opts)
      if (settled !== null) return settled
      const latest = readAuthSession()
      if (!latest) throw new AuthSessionError('Not signed in. Run `harness login`.', 'MISSING')
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
}
