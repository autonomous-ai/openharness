/**
 * Autonomous SSO — OAuth2 Authorization Code + PKCE.
 *
 * The backend builds the authorize URL, keeps PKCE verifier + CSRF state in a one-time Redis
 * transaction, and exchanges the code itself. The resulting SSO access token is returned to the web
 * and validated on subsequent control-plane requests through the Autonomous profile API.
 */
import { createHash, randomBytes } from 'crypto'
import { env } from '../config/env.js'
import { pub } from './bus.js'
import {
  autonomousEnvironmentConfig,
  isAutonomousEnvironment,
  type AutonomousEnvironment,
} from './autonomousEnvironment.js'

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A PKCE verifier (kept secret in the Redis transaction) + its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export const randomState = (): string => b64url(randomBytes(16))

const SSO_TX_TTL_SEC = 10 * 60
const ssoTxKey = (id: string): string => `sso:tx:${id}`

/** Per-login transaction stored server-side for 10 minutes. The browser only receives an opaque id. */
export interface SsoTx {
  verifier: string
  state: string
  next: string
  redirectUri: string
  webOrigin: string
  autonomousEnv: AutonomousEnvironment
  /** The auth-service client the authorize URL named, which the code exchange has to name again.
   *  Absent is the configured one (`SSO_CLIENT_ID`), as every sign-in was before clients were split. */
  clientId?: SsoClientId
}

function validTx(raw: unknown): raw is SsoTx {
  const tx = raw as Partial<SsoTx> | null
  return !!tx && typeof tx.verifier === 'string' && typeof tx.state === 'string' &&
    typeof tx.next === 'string' && typeof tx.redirectUri === 'string' && typeof tx.webOrigin === 'string' &&
    (tx.autonomousEnv === undefined || isAutonomousEnvironment(tx.autonomousEnv)) &&
    (tx.clientId === undefined || normalizeSsoClientId(tx.clientId) === tx.clientId)
}

export async function createTx(tx: SsoTx): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = b64url(randomBytes(32))
    const stored = await pub.set(ssoTxKey(id), JSON.stringify(tx), 'EX', SSO_TX_TTL_SEC, 'NX')
    if (stored === 'OK') return id
  }
  throw new Error('could not allocate sso transaction')
}

/** Atomically read + delete so an authorization code transaction cannot be replayed. */
export async function consumeTx(id: string): Promise<SsoTx | null> {
  const raw = await pub.eval(
    "local v = redis.call('get', KEYS[1]); if v then redis.call('del', KEYS[1]) end; return v",
    1,
    ssoTxKey(id),
  )
  if (typeof raw !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return validTx(parsed)
      ? { ...parsed, autonomousEnv: parsed.autonomousEnv ?? 'prod' }
      : null
  } catch {
    return null
  }
}

// --- Origin derivation (so live→live, local→local without hardcoding) ------------------------------
const firstHeader = (v: string | string[] | undefined): string | undefined =>
  (Array.isArray(v) ? v[0] : v)?.split(',')[0].trim()

/** The SPA origin that initiated the login, from an explicit ?origin, else the Origin/Referer header. */
export function requestedWebOrigin(
  query: { origin?: string },
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  if (query.origin) return query.origin
  const origin = firstHeader(headers['origin'])
  if (origin) return origin
  const ref = firstHeader(headers['referer'])
  if (ref) {
    try {
      const u = new URL(ref)
      return `${u.protocol}//${u.host}`
    } catch {
      /* ignore */
    }
  }
  return undefined
}

/** Allowlist of SPA origins the post-login token may be redirected to (WEB_URL + WEB_ORIGINS). */
export function allowedWebOrigins(): string[] {
  return [env.WEB_URL, ...env.WEB_ORIGINS.split(',')]
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

/** Resolve the (trusted) SPA origin: the requested one IF allowlisted, else the primary WEB_URL. */
export function resolveWebOrigin(requested: string | undefined): string {
  const allow = allowedWebOrigins()
  const norm = requested?.trim().replace(/\/$/, '')
  return norm && allow.includes(norm) ? norm : allow[0] || env.WEB_URL
}

/** The WEB callback URL (the new SSO redirect_uri) — a page on the web origin, so the browser never
 *  lands on the API. An explicit SSO_REDIRECT_URI pins it; else it's the (allowlisted) web origin. */
/** Loopback-only redirect URIs for native/desktop OAuth. Accepts 127.0.0.1, localhost, [::1]. */
export function isLoopbackRedirectUri(redirectUri: string): boolean {
  let u: URL
  try { u = new URL(redirectUri) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

export function webCallbackUri(webOrigin: string): string {
  return env.SSO_REDIRECT_URI || `${webOrigin.replace(/\/$/, '')}/auth/callback`
}

/**
 * Where a sign-in started, as auth-service's login tracking records it (`entry_point` on
 * `login_events`, and from there BigQuery). Ours are `cli` and `desktop`; the storefront sends
 * keys like `sign-modal--orders_and_returns`.
 *
 * Narrowed to a plain key on purpose: `/api/auth/authorize-native` needs no token, this value goes
 * into the authorize URL's query and then into a reporting column, and auth-service only truncates
 * at 255. Anything else is dropped rather than passed on — a missing entry point reports as "none",
 * which is honest, while a junk one is a row nobody can read.
 */
export function normalizeEntryPoint(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) ? value : undefined
}

/**
 * auth-service's client for each Harness surface: the terminal, the desktop app, the web app and
 * the phone sign in as themselves, so a sign-in is attributed to — and can be configured for — the
 * surface it came from.
 *
 * ⚠️ A token belongs to the client it was issued to: the code exchange and every later refresh
 * must name the SAME client, or auth-service refuses them. So a client that names one here keeps
 * it with its session and sends it again on `/api/auth/refresh`; one that names none (every build
 * from before this) stays on the configured `SSO_CLIENT_ID` end to end.
 */
export const SSO_CLIENT_IDS = ['harness-cli', 'harness-desktop', 'harness-web', 'harness-mobile'] as const
export type SsoClientId = (typeof SSO_CLIENT_IDS)[number]

/** An allowlist, like [normalizeSignInProvider]: the routes that take it need no token. */
export function normalizeSsoClientId(raw: unknown): SsoClientId | undefined {
  return typeof raw === 'string' ? SSO_CLIENT_IDS.find((id) => id === raw.trim()) : undefined
}

/** The client a request signs in as, and its secret — which is the configured client's alone. */
function ssoClient(autonomousEnv: AutonomousEnvironment, clientId?: SsoClientId): { id: string; secret?: string } {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const id = clientId ?? config.ssoClientId
  return { id, ...(id === config.ssoClientId && config.ssoClientSecret ? { secret: config.ssoClientSecret } : {}) }
}

/** The accounts a sign-in can go straight to: the two buttons every Harness client shows. */
export const SIGN_IN_PROVIDERS = ['google', 'apple'] as const
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number]

/**
 * Which of [SIGN_IN_PROVIDERS] the person pressed, or nothing — and nothing is the sign-in page's
 * own chooser, which is what every client sent before the buttons moved into the app.
 *
 * An allowlist for the reason [normalizeEntryPoint] is a pattern: both authorize routes need no
 * token and this value goes into the authorize URL's query.
 */
export function normalizeSignInProvider(raw: unknown): SignInProvider | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase()
  return SIGN_IN_PROVIDERS.find((provider) => provider === value)
}

/** What an authorize URL carries beyond the OAuth request itself. All optional, all plain keys. */
export interface AuthorizeHints {
  entryPoint?: string
  provider?: SignInProvider
  clientId?: SsoClientId
}

/** Where to send the browser to log in. `prompt=select_account` (env) forces the account picker so
 *  a user can switch accounts even when an SSO session already exists. */
export function authorizeUrl(
  challenge: string,
  state: string,
  redirectUri: string,
  autonomousEnv: AutonomousEnvironment,
  { entryPoint, provider, clientId }: AuthorizeHints = {},
): string {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const u = new URL('/oauth2/authorize', config.ssoIssuer)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', ssoClient(autonomousEnv, clientId).id)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', env.SSO_SCOPE)
  u.searchParams.set('code_challenge', challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', state)
  if (env.SSO_PROMPT) u.searchParams.set('prompt', env.SSO_PROMPT)
  if (entryPoint) u.searchParams.set('entry_point', entryPoint)
  // auth-service opens that account's own sign-in instead of its chooser.
  if (provider) u.searchParams.set('provider', provider)
  return u.toString()
}

/** End-session URL — clears the SSO session so the next login isn't silently auto-completed. */
export function logoutUrl(webOrigin: string, autonomousEnv: AutonomousEnvironment): string {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const u = new URL('/oauth2/logout', config.ssoIssuer)
  u.searchParams.set('client_id', config.ssoClientId)
  u.searchParams.set('post_logout_redirect_uri', webOrigin)
  return u.toString()
}

export interface SsoTokens {
  access_token?: string
  id_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
}

export class SsoTokenError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_GRANT' | 'TOKEN_SERVICE_UNAVAILABLE',
  ) {
    super(message)
    this.name = 'SsoTokenError'
  }
}

async function requestTokens(
  grant: Record<string, string>,
  autonomousEnv: AutonomousEnvironment,
  clientId?: SsoClientId,
): Promise<SsoTokens> {
  const config = autonomousEnvironmentConfig(autonomousEnv)
  const client = ssoClient(autonomousEnv, clientId)
  const body = new URLSearchParams({ ...grant, client_id: client.id })
  if (client.secret) body.set('client_secret', client.secret)

  let res: Response
  try {
    res = await fetch(new URL('/oauth2/token', config.ssoIssuer).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(env.SSO_PROFILE_TIMEOUT_MS),
    })
  } catch {
    throw new SsoTokenError('SSO token service unavailable', 'TOKEN_SERVICE_UNAVAILABLE')
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const invalidGrant = res.status === 400 && /invalid[_ -]?grant|invalid.*refresh|expired.*refresh/i.test(detail)
    throw new SsoTokenError(
      `SSO token endpoint returned ${res.status}`,
      invalidGrant ? 'INVALID_GRANT' : 'TOKEN_SERVICE_UNAVAILABLE',
    )
  }

  try {
    return (await res.json()) as SsoTokens
  } catch {
    throw new SsoTokenError('SSO token service returned invalid JSON', 'TOKEN_SERVICE_UNAVAILABLE')
  }
}

/** Exchange the authorization code for tokens (public client + PKCE; no secret unless configured). */
export async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  autonomousEnv: AutonomousEnvironment,
  clientId?: SsoClientId,
): Promise<SsoTokens> {
  return requestTokens({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri, // MUST match the one sent to /authorize — as must the client
    code_verifier: verifier,
  }, autonomousEnv, clientId)
}

/** Exchange a browser-held refresh token for a fresh SSO access token. */
export async function refreshAccessToken(
  refreshToken: string,
  autonomousEnv: AutonomousEnvironment,
  clientId?: SsoClientId,
): Promise<SsoTokens> {
  return requestTokens({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, autonomousEnv, clientId)
}
