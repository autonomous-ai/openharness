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
import { redeemHandoff, refreshHarnessSession, revokeHarnessSession, startHandoff } from '../lib/harnessSession.js'
import { normalizeSignInAttribution, type SignInAttribution } from '../lib/signInAttribution.js'

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
  app.post<{ Body: { code?: string; state?: string; tx?: string; attribution?: unknown } }>(
    '/api/auth/exchange',
    async (req, reply) => {
      const { code, state, tx: txRaw } = req.body ?? {}
      const attribution = normalizeSignInAttribution(req.body?.attribution)
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

  app.post<{ Body: { refreshToken?: string; autonomousEnv?: AutonomousEnvironment; clientId?: string } }>(
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
          logger.error('harness session refresh failed', e)
          return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
        }
      }

      let autonomousEnv: AutonomousEnvironment
      try { autonomousEnv = parseAutonomousEnvironment(req.body?.autonomousEnv) } catch {
        return sendError(reply, 'invalid Autonomous environment', 'INVALID_AUTONOMOUS_ENV', 400)
      }

      try {
        // The client the session was issued to: a refresh under any other is refused upstream.
        const tokens = await refreshAccessToken(refreshToken, autonomousEnv, normalizeSsoClientId(req.body?.clientId))
        const token = tokens.access_token
        if (!token) throw new SsoTokenError('SSO refresh returned no access token', 'TOKEN_SERVICE_UNAVAILABLE')
        const user = await authenticateAccessToken(token, autonomousEnv)
        logger.info('sso token refreshed', {
          userId: user.sub,
          autonomousEnv,
          rotatedRefreshToken: !!tokens.refresh_token,
          expiresIn: tokens.expires_in,
        })
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
  app.post('/api/auth/handoff', async (req, reply) => {
    if (req.user!.harnessSessionId && req.user!.harnessSessionKind !== 'computer') {
      return sendError(reply, 'Add a phone from a computer signed in to Harness', 'HANDOFF_NOT_ALLOWED', 403)
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
    const label = (typeof req.body?.label === 'string' ? req.body.label.trim() : '').slice(0, 80) || 'phone'
    try {
      const tokens = await redeemHandoff(code, label)
      // Expired, spent, or never ours — one answer, so a caller learns nothing from which.
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
}
