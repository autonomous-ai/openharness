import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { authenticateAccessToken, bearerToken, SsoAuthError } from '../lib/ssoAuth.js'
import type { AuthUser } from '../lib/ssoAuth.js'
import { ForbiddenError } from '../errors/index.js'
import { parseAutonomousEnvironment, type AutonomousEnvironment } from '../lib/autonomousEnvironment.js'
import { countryCodeFromHeaders, stampUserCountry } from '../lib/clientGeo.js'
import { isPublicCommunityRead } from '../lib/communityAccess.js'
import { GRID_PROFILE_PATH } from '../lib/gridProfile.js'
import { isTeamSession, TEAM_SESSION_LIMITED, TEAM_SESSION_MESSAGE, teamBodyAllowed, teamRequestAllowed } from '../lib/teamSession.js'

/** By the matched route, not the raw URL, so an encoded spelling of the path is the same route. */
const isGridProfileRequest = (request: FastifyRequest): boolean =>
  (request.routeOptions?.url ?? request.url.split('?')[0]) === GRID_PROFILE_PATH

/**
 * Public local routes (no user access token). Data-plane requests never reach Fastify — they're
 * intercepted in the serverFactory (see server.ts) — so this gate only sees the control
 * API. Everything except health + login requires a valid SSO access token.
 */
export function shouldSkipAuth(url: string): boolean {
  const path = url.split('?')[0]
  return (
    path === '/api/health' ||
    // Readiness probe: the orchestrator carries no token, and the answer names only dependencies and their state.
    path === '/api/ready' ||
    // Explicitly enabled, credential-free setup totals; its own schema and workload budget apply.
    path === '/api/product-usage/setup' ||
    // Hub totals the website's server forwards with cookies and auth stripped; same rules as setup.
    path === '/api/product-usage/hub' ||
    // Web-driven SSO login (pre-session): /authorize returns the SSO URL, /exchange trades the code
    // for the SSO access token, /logout-url returns the SSO end-session URL. All fetched by web XHR.
    path === '/api/auth/authorize' ||
    path === '/api/auth/authorize-native' ||
    path === '/api/auth/exchange' ||
    path === '/api/auth/refresh' ||
    // Scan to sign in: the phone has no token yet, and the one-time code it carries IS the credential
    // (lib/harnessSession.ts). Revoke takes the refresh token, the same authority /refresh does.
    // `/api/auth/handoff` itself is NOT listed: minting a code needs the computer's sign-in.
    path === '/api/auth/handoff/redeem' ||
    // A computer signing in by QR (routes/qrSignIn.ts) has no token yet: its poll token is the
    // credential for what it may learn and claim. The phone's half (lookup/approve/deny) is NOT here.
    path === '/api/auth/qr/start' ||
    path === '/api/auth/qr/poll' ||
    path === '/api/auth/qr/extend' ||
    path === '/api/auth/qr/claim' ||
    path === '/api/auth/qr/cancel' ||
    path === '/api/auth/revoke' ||
    path === '/api/auth/logout-url' ||
    // Public app-deploy registration — agent-key gated (x-api-key), self-validated in its
    // own preHandler (agentAuth). Called by the agent-node's domain MCP, not the web SSO token.
    path === '/api/apps' ||
    path.startsWith('/api/apps/') ||
    // Public agent-key validation — agent-key gated (x-api-key), self-validated in the handler.
    // Called by the shared CCR gateway to authorize an agent-node's Claude CLI bearer token.
    path === '/api/machines/validate' ||
    // Analytics collector write path — machine-key gated (x-api-key), self-validated in its own
    // preHandler (machineAuth). The READ endpoints under /api/analytics/ are NOT listed here: they
    // are dashboard calls and must carry the owner's SSO token.
    path === '/api/analytics/report' ||
    // The mobile group is production-only by construction and runs its own SSO preHandler, which
    // pins the plane to prod and skips the account-plane gate (see routes/mobile.ts). It is NOT
    // unauthenticated — skipping here only means "not gated by THIS hook".
    path.startsWith('/api/mobile/') ||
    // The Cursor desktop app's two standalone endpoints — both shared-secret gated (`api_key` header),
    // self-validated in their own preHandler (routes/cursor.ts). That client has no SSO token. Listed
    // one by one on purpose: a future /api/cursor/* route must not inherit the skip by accident.
    path === '/api/cursor/stt' ||
    path === '/api/cursor/summarize' ||
    path === '/api/cursor/route' ||
    // Device-authorization grant for the desktop app. These two are unauthenticated BY DESIGN — the app
    // has no credential yet, which is the entire reason the flow exists. Neither reveals anything:
    // `start` returns codes it just minted, and `poll` needs the 32-byte device code and answers once.
    // The approve/deny/lookup half is NOT listed and stays SSO-gated — that is where the user's identity
    // and their machine list are involved. Listed one by one, like the cursor pair above.
    // GitHub sends a person back here after they signed in to the Harness GitHub App (or installed it), with no Harness
    // token: the `state` the backend signed for that person, project and scope, ten minutes long, is what it trusts
    // (routes/superTabs.ts, github/approvals.ts). It only records that someone GitHub says can push to a repository
    // approved it.
    path === '/api/github/callback' ||
    path === '/api/device-auth/start' ||
    path === '/api/device-auth/poll' ||
    // The connector gateway's callback (routes/connectors.ts), posted by the Autonomous web callback
    // page for an anonymous browser: its one-time `harness_` state is the ticket, and it answers no token.
    // The rest of /api/connectors stays SSO-gated.
    path === '/api/connectors/callback'
  )
}

export function registerAuthMiddleware(
  app: FastifyInstance,
  authenticate: typeof authenticateAccessToken = authenticateAccessToken,
): void {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (shouldSkipAuth(request.url)) return
    const token = bearerToken(request.headers['authorization'])
    if (!token && isPublicCommunityRead(request.method, request.url)) return
    // Anonymous public-link discovery only. With a token, authenticate normally so private links
    // and commenting use the real account. Never exempt a mutation or the invitation inventory.
    if (!token && request.method === 'GET' && /^\/api\/shared-agents\/[a-f0-9-]{36}$/.test(request.url.split('?')[0])) return
    if (!token) {
      return reply.code(401).send({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }
    let autonomousEnv: AutonomousEnvironment
    try {
      autonomousEnv = parseAutonomousEnvironment(request.headers['x-autonomous-env'])
    } catch {
      return reply.code(400).send({ success: false, error: { code: 'INVALID_AUTONOMOUS_ENV', message: 'Invalid Autonomous environment' } })
    }
    // The Grid profile route reads the profile live and records it itself; a fill on top of that would
    // be a second storefront read and a second stored-versus-live line for one request.
    // A team session is accepted here only because the gate below holds it to its own machine.
    const auth = await resolveSsoAuth(token, authenticate, autonomousEnv, isGridProfileRequest(request), { allowTeamSession: true })
    if ('user' in auth) {
      // A Mac's team account (lib/teamSession.ts) reaches only what its own machine needs: deny by default.
      if (auth.user.harnessSessionKind === 'team' && !(await teamRequestAllowed(request, auth.user))) {
        return reply.code(403).send({ success: false, error: { code: TEAM_SESSION_LIMITED, message: TEAM_SESSION_MESSAGE } })
      }
      request.user = auth.user
      // Where the person is, per Cloudflare (`CF-IPCountry`, absent off-Cloudflare). Every control-plane
      // call comes from their own computer, which is what makes this — and not the daemon's socket —
      // the "user country" signal. Fire-and-forget and rate-floored inside; never on the request path.
      //
      // Except the Grid profile route: its caller is the Grid control plane asking on the person's
      // behalf, from a datacenter, and stamping that would relabel them (routes/grid.ts).
      const countryCode = countryCodeFromHeaders(request.headers)
      if (countryCode && !isGridProfileRequest(request)
          && !request.url.split('?')[0].startsWith('/api/product-usage/')) void stampUserCountry(auth.user.sub, countryCode)
      return
    }
    return reply.code(auth.status).send({
      success: false,
      error: {
        code: auth.code,
        message: auth.message,
        ...(auth.requiredEnv ? { requiredEnv: auth.requiredEnv } : {}),
      },
    })
  })
  // The rest of the team gate, once the body is read: a machine the body names must be the team session's own.
  // Runs before every route's own preHandlers (its validation), as an instance hook does.
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (isTeamSession(request.user) && !teamBodyAllowed(request)) {
      return reply.code(403).send({ success: false, error: { code: TEAM_SESSION_LIMITED, message: TEAM_SESSION_MESSAGE } })
    }
  })
}

export async function resolveSsoAuth(
  token: string,
  authenticate: typeof authenticateAccessToken = authenticateAccessToken,
  autonomousEnv: AutonomousEnvironment = 'prod',
  readsProfileItself = false,
  /** Accept a team session (lib/teamSession.ts): only for a caller that then holds it to its own machine. */
  { allowTeamSession = false }: { allowTeamSession?: boolean } = {},
): Promise<
  | { user: AuthUser }
  | {
    status: 401 | 403 | 503
    code: 'UNAUTHORIZED' | 'AUTH_SERVICE_UNAVAILABLE' | 'AUTONOMOUS_ENV_MISMATCH' | 'AUTONOMOUS_ENV_NOT_ALLOWED' | 'TEAM_SESSION_LIMITED'
    message: string
    requiredEnv?: AutonomousEnvironment
  }
> {
  const options = { ...(readsProfileItself ? { learnGoogleSubject: false } : {}), ...(allowTeamSession ? { allowTeamSession } : {}) }
  try {
    return {
      user: await (Object.keys(options).length ? authenticate(token, autonomousEnv, options) : authenticate(token, autonomousEnv)),
    }
  } catch (err) {
    if (err instanceof SsoAuthError && err.code === 'AUTH_SERVICE_UNAVAILABLE') {
      return { status: 503, code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' }
    }
    // Refused for good, not an expired sign-in: a 401 would send the caller to refresh and try again.
    if (err instanceof SsoAuthError && err.code === 'TEAM_SESSION_LIMITED') {
      return { status: 403, code: 'TEAM_SESSION_LIMITED', message: err.message }
    }
    if (err instanceof SsoAuthError &&
      (err.code === 'AUTONOMOUS_ENV_MISMATCH' || err.code === 'AUTONOMOUS_ENV_NOT_ALLOWED')) {
      return {
        status: 403,
        code: err.code,
        message: err.message,
        ...(err.requiredEnv ? { requiredEnv: err.requiredEnv } : {}),
      }
    }
    return { status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' }
  }
}

/** Throw 403 unless the authenticated user is an admin. */
export function requireAdmin(request: FastifyRequest): void {
  if (request.user?.role !== 'admin') {
    throw new ForbiddenError('Admin only')
  }
}
