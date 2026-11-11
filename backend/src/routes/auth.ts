import type { FastifyInstance } from 'fastify'
import { userService } from '../services/index.js'
import { sendSuccess, sendError } from '../utils/response.js'
import { logger } from '../utils/logger.js'
import { authenticateAccessToken, SsoAuthError } from '../lib/ssoAuth.js'
import {
  pkcePair,
  randomState,
  createTx,
  consumeTx,
  authorizeUrl,
  logoutUrl,
  exchangeCode,
  refreshAccessToken,
  SsoTokenError,
  webCallbackUri,
  isLoopbackRedirectUri,
  normalizeEntryPoint,
  normalizeSignInProvider,
  normalizeSsoClientId,
  resolveWebOrigin,
  requestedWebOrigin,
  type SsoTx,
} from '../lib/sso.js'
import { parseAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { isHarnessRefreshToken } from '../lib/harnessTokenFormat.js'
import { createSsoSession, redeemHandoff, refreshHarnessSession, revokeHarnessSession, startHandoff, type HarnessTokens } from '../lib/harnessSession.js'
import { parseSsoSessionRequest, type SsoGrant, type SsoSessionRequest } from '../lib/ssoSession.js'
import { normalizeSignInAttribution, type SignInAttribution } from '../lib/signInAttribution.js'
import { parseAccountName } from '../lib/accountName.js'

/**
 * The Harness session a sign-in or renewal asked for (lib/ssoSession.ts), made from its SSO tokens. Null when it cannot
 * be made — no SSO refresh token to keep, the account gone, the store or credential key failing: the caller then answers
 * with the SSO tokens as before, so the person stays signed in either way, and a rotated SSO refresh token is never lost.
 */
async function harnessSessionFor(
  userId: string,
  asked: SsoSessionRequest,
  grant: Partial<SsoGrant>,
  autonomousEnv: AutonomousEnvironment,
  clientId: ReturnType<typeof normalizeSsoClientId>,
): Promise<HarnessTokens | null> {
  if (!grant.accessToken || !grant.refreshToken) {
    logger.warn('harness session not made; signed in with SSO tokens', { userId, reason: 'NO_SSO_REFRESH_TOKEN' })
    return null
  }
  try {
    const tokens = await createSsoSession(userId, asked, grant as SsoGrant, autonomousEnv, clientId)
    if (!tokens) logger.warn('harness session not made; signed in with SSO tokens', { userId, reason: 'NO_ACCOUNT' })
    return tokens
  } catch (e) {
    // The error's kind only: a store's message can quote what it was asked to write.
    logger.warn('harness session not made; signed in with SSO tokens', { userId, reason: e instanceof Error ? e.name : 'unknown' })
    return null
  }
}

/** A Harness session's tokens, as a sign-in or renewal hands them back in place of the SSO ones. */
const harnessSessionBody = (tokens: HarnessTokens) => ({
  token: tokens.token,
  refreshToken: tokens.refreshToken,
  expiresIn: tokens.expiresIn,
  kind: tokens.kind,
  autonomousEnv: tokens.autonomousEnv,
  harnessSession: true,
})

/** Reporting only: a sign-in whose attribution cannot be stored still signs in. */
async function recordAttribution(userId: string, attribution: SignInAttribution): Promise<void> {
  try {
    await userService.recordSignInAttribution(userId, attribution)
  } catch (e) {
    logger.error('sign-in attribution not recorded', e, { userId })
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // 1) Start login (web-driven). The web fetches this (XHR, so the API URL never hits the address
  //    bar), stashes the returned opaque `tx` id in sessionStorage, and navigates the browser to
  //    `authorizeUrl` (the SSO provider). redirect_uri is the WEB callback page, not the API.
  app.post<{ Body: { next?: string; origin?: string; autonomousEnv?: AutonomousEnvironment; provider?: string; clientId?: string } }>('/api/auth/authorize', async (req, reply) => {
    const { verifier, challenge } = pkcePair()
    const state = randomState()
    const next = typeof req.body?.next === 'string' && req.body.next ? req.body.next : '/'
    const webOrigin = resolveWebOrigin(requestedWebOrigin(req.body ?? {}, req.headers))
    const redirectUri = webCallbackUri(webOrigin)
    let autonomousEnv: AutonomousEnvironment
    try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
      return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
    }
    // Which button the person pressed (Google, Apple); absent is the sign-in page's own chooser.
    const provider = normalizeSignInProvider(req.body?.provider)
    // Which surface is signing in (lib/sso.ts `SSO_CLIENT_IDS`), kept for the exchange.
    const clientId = normalizeSsoClientId(req.body?.clientId)
    try {
      const tx = await createTx({ verifier, state, next, redirectUri, webOrigin, autonomousEnv, ...(clientId ? { clientId } : {}) })
      return sendSuccess(reply, { authorizeUrl: authorizeUrl(challenge, state, redirectUri, autonomousEnv, { provider, clientId }), tx })
    } catch {
      return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // 2) Exchange the SSO code for its access token (web-driven). The web `/auth/callback` page reads
  //    ?code&state + the `tx` it stashed, and POSTs them here (XHR). The BACKEND exchanges the code
  //    then validates the access token through the profile service, mirrors the user and returns that
  //    SAME access token in the body. No backend-owned session JWT is minted.
  //    `attribution` is the `utm_*` + `rid` auth-service carried back onto the callback URL (lib/signInAttribution.ts).
  //    `harnessSession: { kind, label }` asks for a Harness session in place of the SSO tokens (lib/ssoSession.ts).
  app.post<{ Body: { code?: string; state?: string; tx?: string; attribution?: unknown; harnessSession?: unknown } }>(
    '/api/auth/exchange',
    async (req, reply) => {
      const { code, state, tx: txRaw } = req.body ?? {}
      const attribution = normalizeSignInAttribution(req.body?.attribution)
      const asked = parseSsoSessionRequest(req.body?.harnessSession)
      if (asked === null) return sendError(reply, 'Ask for a computer or a viewer session', 'INVALID_HARNESS_SESSION', 400)
      let tx: SsoTx | null = null
      try {
        tx = txRaw ? await consumeTx(txRaw) : null
      } catch {
        return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
      if (!code || !state || !tx || tx.state !== state) {
        return sendError(reply, 'invalid_state', 'INVALID_STATE', 400)
      }
      try {
        const tokens = await exchangeCode(code, tx.verifier, tx.redirectUri, tx.autonomousEnv, tx.clientId)
        const token = tokens.access_token
        if (!token) throw new Error('sso response had no access_token')
        // A sign-in that creates the account keeps its tags as the acquisition (`signUpAttribution`).
        const user = await authenticateAccessToken(
          token,
          tx.autonomousEnv,
          attribution ? { signUpAttribution: attribution } : {},
        )
        logger.info('sso login', {
          userId: user.sub,
          email: user.email || '(empty)',
          autonomousEnv: user.autonomousEnv,
          hasRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
          ...(attribution ? { attribution } : {}),
        })
        if (attribution) await recordAttribution(user.sub, attribution)
        const session = asked && await harnessSessionFor(user.sub, asked,
          { accessToken: token, refreshToken: tokens.refresh_token, expiresIn: tokens.expires_in }, tx.autonomousEnv, tx.clientId)
        if (session) return sendSuccess(reply, { ...harnessSessionBody(session), next: tx.next })
        return sendSuccess(reply, {
          token,
          next: tx.next,
          autonomousEnv: tx.autonomousEnv,
          // The client these tokens were issued to, for the caller to keep and name on every
          // refresh. Absent is the configured client — and what a backend from before the
          // clients were split answers, so a caller never assumes the client it asked for.
          ...(tx.clientId ? { clientId: tx.clientId } : {}),
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(typeof tokens.expires_in === 'number' ? { expiresIn: tokens.expires_in } : {}),
        })
      } catch (e) {
        if (e instanceof SsoAuthError && e.code === 'AUTH_SERVICE_UNAVAILABLE') {
          return sendError(reply, e.message, e.code, 503)
        }
        if (e instanceof SsoAuthError &&
          (e.code === 'AUTONOMOUS_ENV_MISMATCH' || e.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
          return reply.code(403).send({
            success: false,
            error: {
              code: e.code,
              message: e.message,
              ...(e.requiredEnv ? { requiredEnv: e.requiredEnv } : {}),
            },
          })
        }
        return sendError(reply, e instanceof Error ? e.message : 'sso_failed', 'SSO_FAILED', 502)
      }
    },
  )

  //    An SSO renewal that asks for `harnessSession` is moved over to one (lib/ssoSession.ts): today's signed-in CLIs and
  //    Desktops switch silently on their next renewal. A Harness refresh token ignores it.
  app.post<{ Body: { refreshToken?: string; autonomousEnv?: AutonomousEnvironment; clientId?: string; harnessSession?: unknown } }>(
    '/api/auth/refresh',
    async (req, reply) => {
      const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : ''
      if (!refreshToken) return sendError(reply, 'refresh token is required', 'INVALID_REFRESH_REQUEST', 400)

      // A session Harness issued itself (a phone signed in by a QR) renews here, not at the SSO.
      if (isHarnessRefreshToken(refreshToken)) {
        try {
          const tokens = await refreshHarnessSession(refreshToken)
          if (!tokens) return sendError(reply, 'Refresh token is invalid or expired', 'REFRESH_TOKEN_INVALID', 401)
          return sendSuccess(reply, tokens)
        } catch (e) {
          // SSO not confirming the sign-in within its grace (lib/ssoSession.ts): its own answer, which clients show as
          // "Sign in again" and neither sign out over nor retry silently. Not a 401: the session is not over.
          if (e instanceof SsoAuthError && e.code === 'SIGN_IN_AGAIN') return sendError(reply, e.message, e.code, 403)
          logger.error('harness session refresh failed', e)
          return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
        }
      }

      const asked = parseSsoSessionRequest(req.body?.harnessSession)
      if (asked === null) return sendError(reply, 'Ask for a computer or a viewer session', 'INVALID_HARNESS_SESSION', 400)

      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
        return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
      }

      try {
        // The client the session was issued to: a refresh under any other is refused upstream.
        const clientId = normalizeSsoClientId(req.body?.clientId)
        const tokens = await refreshAccessToken(refreshToken, autonomousEnv, clientId)
        const token = tokens.access_token
        if (!token) throw new SsoTokenError('SSO refresh returned no access token', 'TOKEN_SERVICE_UNAVAILABLE')
        const user = await authenticateAccessToken(token, autonomousEnv)
        logger.info('sso token refreshed', {
          userId: user.sub,
          autonomousEnv,
          rotatedRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
        })
        // Whatever this answers, SSO may already have rotated the refresh token: the new one is handed back either way.
        const session = asked && await harnessSessionFor(user.sub, asked,
          { accessToken: token, refreshToken: tokens.refresh_token || refreshToken, expiresIn: tokens.expires_in }, autonomousEnv, clientId)
        if (session) {
          logger.info('sso sign-in moved to a harness session', { userId: user.sub, kind: session.kind })
          return sendSuccess(reply, harnessSessionBody(session))
        }
        return sendSuccess(reply, {
          token,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          ...(typeof tokens.expires_in === 'number' ? { expiresIn: tokens.expires_in } : {}),
        })
      } catch (e) {
        if (e instanceof SsoTokenError) {
          return sendError(
            reply,
            e.code === 'INVALID_GRANT' ? 'Refresh token is invalid or expired' : 'Authentication service unavailable',
            e.code === 'INVALID_GRANT' ? 'REFRESH_TOKEN_INVALID' : 'AUTH_SERVICE_UNAVAILABLE',
            e.code === 'INVALID_GRANT' ? 401 : 503,
          )
        }
        if (e instanceof SsoAuthError && e.code === 'AUTH_SERVICE_UNAVAILABLE') {
          return sendError(reply, e.message, e.code, 503)
        }
        if (e instanceof SsoAuthError &&
          (e.code === 'AUTONOMOUS_ENV_MISMATCH' || e.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
          return reply.code(403).send({
            success: false,
            error: {
              code: e.code,
              message: e.message,
              ...(e.requiredEnv ? { requiredEnv: e.requiredEnv } : {}),
            },
          })
        }
        return sendError(reply, 'Unable to refresh SSO session', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
    },
  )

  // 1b) Native/desktop-driven login (loopback OAuth). Accepts an explicit loopback redirect_uri so a
  //     desktop client can run a local HTTP listener to capture the SSO callback; unlike the web
  //     authorize, it never derives redirect_uri from a web origin. /exchange reuses tx.redirectUri.
  app.post<{ Body: { redirectUri?: string; autonomousEnv?: AutonomousEnvironment; entryPoint?: string; provider?: string; clientId?: string } }>(
    '/api/auth/authorize-native',
    async (req, reply) => {
      const redirectUri = typeof req.body?.redirectUri === 'string' ? req.body.redirectUri.trim() : ''
      if (!redirectUri || !isLoopbackRedirectUri(redirectUri)) {
        return sendError(reply, 'redirectUri must be a loopback address (http://127.0.0.1:<port> or http://localhost:<port>)', 'INVALID_REDIRECT_URI', 400)
      }
      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
        return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
      }
      try {
        const { verifier, challenge } = pkcePair()
        const state = randomState()
        const webOrigin = new URL(redirectUri).origin
        const clientId = normalizeSsoClientId(req.body?.clientId)
        const tx = await createTx({ verifier, state, next: '/', redirectUri, webOrigin, autonomousEnv, ...(clientId ? { clientId } : {}) })
        // Which surface started this sign-in (`cli`, `desktop`) — analytics only, and dropped
        // unless it is a plain key, because this route needs no token.
        const entryPoint = normalizeEntryPoint(req.body?.entryPoint)
        const provider = normalizeSignInProvider(req.body?.provider)
        return sendSuccess(reply, { authorizeUrl: authorizeUrl(challenge, state, redirectUri, autonomousEnv, { entryPoint, provider, clientId }), tx })
      } catch {
        return sendError(reply, 'login transaction service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
      }
    },
  )

  // 3) SSO end-session URL (web-driven). The web fetches this (XHR), then navigates the browser to the
  //    returned issuer logout URL — without this the issuer's session cookie survives and the next
  //    login silently auto-completes with the same account. The API URL never hits the address bar.
  app.get<{ Querystring: { origin?: string; autonomousEnv?: AutonomousEnvironment } }>('/api/auth/logout-url', async (req, reply) => {
    let autonomousEnv: AutonomousEnvironment
    try { autonomousEnv = parseAutonomousEnvironment(req.query.autonomousEnv) } catch {
      return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
    }
    return sendSuccess(reply, {
      logoutUrl: logoutUrl(resolveWebOrigin(requestedWebOrigin(req.query, req.headers)), autonomousEnv),
    })
  })

  // 4) Scan to sign in (lib/harnessSession.ts). A signed-in computer asks for a one-time code for
  //    its Add Phone QR; the phone that scans it redeems the code for a session of its own. An
  //    Autonomous sign-in can hand one off, and so can a computer a phone signed in by QR
  //    (routes/qrSignIn.ts) — a phone's own session cannot mint more of itself.
  //    A Harness Team account's code (`{ kind: 'team' }`, with or without a computer or its Mac) is no longer minted: Team
  //    accounts are gone (anh Dee, 2026-11-10), and the answer says so to an older CLI's `harness team`.
  app.post<{ Body: { kind?: unknown; computerId?: unknown; hostMachineId?: unknown } | undefined }>('/api/auth/handoff', async (req, reply) => {
    if (req.user!.harnessSessionId && req.user!.harnessSessionKind !== 'computer') {
      return sendError(reply, 'Add a phone from a computer signed in to Harness', 'HANDOFF_NOT_ALLOWED', 403)
    }
    const body = req.body && typeof req.body === 'object' ? req.body as { kind?: unknown; computerId?: unknown; hostMachineId?: unknown } : {}
    if (body.kind === 'team') return sendError(reply, 'Harness Team accounts are gone.', 'TEAM_ACCOUNTS_RETIRED', 410)
    if ((body.kind !== undefined && body.kind !== 'viewer') || body.computerId !== undefined || body.hostMachineId !== undefined) {
      return sendError(reply, 'Ask for a phone sign-in code', 'INVALID_HANDOFF_KIND', 400)
    }
    try {
      return sendSuccess(reply, await startHandoff(req.user!.sub))
    } catch (e) {
      logger.error('handoff start failed', e)
      return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // Unauthenticated BY DESIGN, like /refresh: the code is the credential. It is 32 random bytes,
  // good for one redeem within 90 seconds, so there is nothing to guess and nothing to replay.
  app.post<{ Body: { code?: string; label?: string } }>('/api/auth/handoff/redeem', async (req, reply) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
    const label = (typeof req.body?.label === 'string' ? req.body.label.trim() : '').slice(0, 80)
    try {
      const tokens = await redeemHandoff(code, label)
      // Expired, spent, never ours, or a Team account's — one answer, so a caller learns nothing from which.
      if (!tokens) return sendError(reply, 'That code has expired. Scan the new one.', 'HANDOFF_INVALID', 401)
      logger.info('handoff redeemed', { label })
      return sendSuccess(reply, tokens)
    } catch (e) {
      logger.error('handoff redeem failed', e)
      return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // Sign a Harness-issued session out. Knowing the refresh token is the authority, as for /refresh;
  // an Autonomous refresh token is not ours to revoke and is ignored.
  app.post<{ Body: { refreshToken?: string } }>('/api/auth/revoke', async (req, reply) => {
    const refreshToken = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : ''
    try {
      await revokeHarnessSession(refreshToken)
      return sendSuccess(reply, { revoked: true })
    } catch (e) {
      logger.error('harness session revoke failed', e)
      return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // Current session's mirrored user, SSO-access-token gated by the auth middleware.
  app.get('/api/auth/me', async (req, reply) => {
    const user = await userService.get(req.user!.sub)
    if (!user) return sendError(reply, 'user not found', 'NOT_FOUND', 404)
    return sendSuccess(reply, { user: userService.toPublic(user), avatarUrl: null, description: null })
  })

  // The signed-in person's own account name (task #2654), the one /api/auth/me answers: the session names the row, never
  // the body.
  // Answers as GET /api/auth/me does, so the app shows the saved name at once.
  app.patch<{ Body: { name?: unknown } }>('/api/auth/me', async (req, reply) => {
    const parsed = parseAccountName(req.body?.name)
    if (!parsed.ok) return sendError(reply, parsed.message, parsed.code, 400)
    // A row gone since sign-in answers 404 (UserService.update's NotFoundError).
    // The person's name in each of their Swarms follows it (UserService.update, superTabs/personNames.ts).
    const user = await userService.update(req.user!.sub, { name: parsed.name })
    return sendSuccess(reply, { user: userService.toPublic(user), avatarUrl: null, description: null })
  })
}
