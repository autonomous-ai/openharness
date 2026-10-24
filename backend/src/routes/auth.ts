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
import { createHash } from 'node:crypto'
import { ed25519 } from '@noble/curves/ed25519.js'
import { normalizeComputerId } from '../lib/deviceAuth.js'
import { activeMachineKeys } from '../lib/deviceKeyLog.js'
import { machineAlive, prisma } from '../lib/prisma.js'
import { pub } from '../lib/bus.js'
import { TEAM_CONVERSION_PROOF_MS, teamConversionMessage } from '../lib/teamSession.js'
import type { AuthUser } from '../lib/ssoAuth.js'

/**
 * Whether [user] is the computer [computerId] itself, which alone may turn itself into a team machine
 * (lib/teamSession.ts). Its own Harness computer session says so; any other sign-in of the account must carry
 * that computer's machine key's signature over `teamConversionMessage`, fresh, and used once.
 */
async function isThisComputer(user: AuthUser, computerId: string, proof: unknown): Promise<boolean> {
  if (user.harnessSessionKind === 'computer' && user.harnessComputerId === computerId) return true
  if (!proof || typeof proof !== 'object') return false
  const { machineId, at, sig } = proof as { machineId?: unknown; at?: unknown; sig?: unknown }
  if (typeof machineId !== 'string' || !machineId || machineId.length > 128 || typeof sig !== 'string' || sig.length > 128
    || typeof at !== 'number' || !Number.isSafeInteger(at) || Math.abs(Date.now() - at) > TEAM_CONVERSION_PROOF_MS) return false
  const machine = await prisma.machine.findFirst({ where: { machineId, userId: user.sub, computerId, autonomousEnv: user.autonomousEnv, ...machineAlive } })
  if (!machine) return false
  const key = (await activeMachineKeys(user.sub)).find((k) => k.kind === 'machine' && k.machineId === machineId)
  if (!key) return false
  let signed = false
  try {
    signed = ed25519.verify(Buffer.from(sig, 'base64'), new TextEncoder().encode(teamConversionMessage(user.sub, computerId, machineId, at)),
      Buffer.from(key.pub, 'base64'))
  } catch { signed = false }
  if (!signed) return false
  // Once: a proof seen on the way cannot be shown again.
  const once = await pub.set(`hnauth:teamproof:${createHash('sha256').update(sig).digest('hex')}`, '1', 'EX', Math.ceil(2 * TEAM_CONVERSION_PROOF_MS / 1000), 'NX')
  return once === 'OK'
}

/**
 * The Mac a team code's account lives on ("One machine", docs/plans/2026-10-24-swarm-team-account.md): its team
 * machine records it, so every list shows that Mac once. A Harness computer session's is its own machine, and it may
 * name no other. Any other sign-in, an Autonomous one above all, names it ([named]): one of the account's ordinary
 * machines in this environment, never a team machine. Null when none is known, false when [named] is not allowed.
 */
async function teamHostMachine(user: AuthUser, named: string | undefined): Promise<string | null | false> {
  const ordinary = (row: { sessionKind: string | null } | null | undefined) => !!row && row.sessionKind !== 'team'
  if (user.harnessSessionKind === 'computer' && user.harnessComputerId) {
    const own = (await prisma.machine.findMany({ where: { userId: user.sub, computerId: user.harnessComputerId, autonomousEnv: user.autonomousEnv,
      ...machineAlive } })).filter(ordinary)
    if (named !== undefined) return own.some(row => row.machineId === named) ? named : false
    return own[0]?.machineId ?? null
  }
  if (named === undefined) return null
  const machine = await prisma.machine.findFirst({ where: { machineId: named, userId: user.sub, autonomousEnv: user.autonomousEnv, ...machineAlive } })
  return ordinary(machine) ? named : false
}

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
  //    `{ kind: 'team' }` asks for a code for this Mac's team account instead (lib/teamSession.ts): same
  //    lifetime, same answer, which names the kind minted. A team session can never mint one of either kind.
  //    `{ kind: 'team', computerId }` is a computer turning ITSELF into a team machine (`harness team on`): only
  //    that computer may ask (isThisComputer), and the code redeems for that computer alone.
  //    `{ kind: 'team', hostMachineId }` names the Mac the team account lives on (teamHostMachine); a computer's own
  //    session need not name it. A team session can never set or change it: it cannot mint.
  app.post<{ Body: { kind?: unknown; computerId?: unknown; proof?: unknown; hostMachineId?: unknown } | undefined }>('/api/auth/handoff', async (req, reply) => {
    if (req.user!.harnessSessionId && req.user!.harnessSessionKind !== 'computer') {
      return sendError(reply, 'Add a phone from a computer signed in to Harness', 'HANDOFF_NOT_ALLOWED', 403)
    }
    const body = req.body && typeof req.body === 'object' ? req.body as { kind?: unknown; computerId?: unknown; proof?: unknown; hostMachineId?: unknown } : {}
    const asked = body.kind
    if ((asked !== undefined && asked !== 'viewer' && asked !== 'team') || (body.computerId !== undefined && asked !== 'team')
      || (body.hostMachineId !== undefined && (asked !== 'team' || body.computerId !== undefined))) {
      return sendError(reply, 'Ask for a phone or a team sign-in code', 'INVALID_HANDOFF_KIND', 400)
    }
    const convert = body.computerId === undefined ? undefined : typeof body.computerId === 'string' ? normalizeComputerId(body.computerId) : null
    if (convert === null) return sendError(reply, 'Name this computer by its id', 'INVALID_COMPUTER_ID', 400)
    const named = body.hostMachineId === undefined ? undefined
      : typeof body.hostMachineId === 'string' && body.hostMachineId && body.hostMachineId.length <= 128 ? body.hostMachineId : null
    if (named === null) return sendError(reply, 'Name the machine by its id', 'INVALID_MACHINE_ID', 400)
    try {
      if (convert && !(await isThisComputer(req.user!, convert, body.proof))) {
        return sendError(reply, 'Only this computer can make itself a team machine', 'HANDOFF_NOT_ALLOWED', 403)
      }
      const host = asked === 'team' && !convert ? await teamHostMachine(req.user!, named) : null
      if (host === false) return sendError(reply, 'That machine is not one of this account\'s computers', 'HANDOFF_NOT_ALLOWED', 403)
      return sendSuccess(reply, await startHandoff(req.user!.sub, asked === 'team' ? 'team' : 'viewer', convert ? { convert } : host ? { host } : {}))
    } catch (e) {
      logger.error('handoff start failed', e)
      return sendError(reply, 'Authentication service unavailable', 'AUTH_SERVICE_UNAVAILABLE', 503)
    }
  })

  // Unauthenticated BY DESIGN, like /refresh: the code is the credential. It is 32 random bytes,
  // good for one redeem within 90 seconds, so there is nothing to guess and nothing to replay.
  // A team code also needs the redeeming daemon's `computerId`: its session is bound to that computer.
  app.post<{ Body: { code?: string; label?: string; computerId?: string } }>('/api/auth/handoff/redeem', async (req, reply) => {
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : ''
    const label = (typeof req.body?.label === 'string' ? req.body.label.trim() : '').slice(0, 80)
    const computerId = typeof req.body?.computerId === 'string' ? req.body.computerId : undefined
    try {
      const tokens = await redeemHandoff(code, label, computerId)
      // Expired, spent, never ours, or a team code without its computer — one answer, so a caller learns nothing from which.
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
