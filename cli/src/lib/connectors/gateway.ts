/**
 * The Harness connector gateway (backend `routes/connectors.ts`), for services that let no computer
 * register itself (the `app` path, the same requests as Grid's gateway). The gateway holds the service's OAuth app: this
 * computer starts a sign-in, polls for its one-time result and stores the token like any other. It asks
 * with the Harness sign-in `harness login` keeps (~/.harness/auth/session.json), as every other
 * control-plane call does (lib/controlPlane.ts).
 */
import { hasAuthSession } from '../authSession.js'
import { bearer, ConnectorError, type Token } from './store.js'
import type { GatewayRow } from './catalog.js'
import { cleanRestEntry } from './rest.js'
import type { SignIn } from './oauth.js'

const TIMEOUT_MS = 20_000
/** The gateway's answers that mean the service's own grant is gone: connect it again. */
const GRANT_GONE = ['INVALID_GRANT', 'NOT_CONNECTED']

export class GatewayError extends ConnectorError {}

/**
 * How this computer reaches the Harness backend. Loaded when first asked: the control plane's module
 * reads the CLI's whole settings, which the page and the bridge never otherwise need. Tests replace it.
 */
export const backend = {
  signedIn: (): boolean => hasAuthSession(),
  base: async (): Promise<string> => (await import('../controlPlane.js')).backendHttpBase(),
  /** Bearer + environment headers, the sign-in renewed first when it is about to expire. */
  headers: async (): Promise<Record<string, string>> => (await (await import('../controlPlane.js')).controlPlaneAuth()).headers,
}

export async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!backend.signedIn()) throw new GatewayError('Sign in to Harness first (harness login) to connect this service.')
  let response: Response
  try {
    const [base, headers] = await Promise.all([backend.base(), backend.headers()])
    response = await fetch(`${base}/api/${path}`, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      headers: { ...headers, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), 'User-Agent': 'Harness-Connections' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch { throw new GatewayError('Could not reach Harness. Check the connection and try again.') }
  let envelope: { success?: boolean, data?: unknown, error?: { code?: string, message?: string } } | null
  try { envelope = await response.json() as typeof envelope } catch { envelope = null }
  const code = envelope?.error?.code ?? ''
  // Told apart from the account's sign-in by the gateway's code: renew.ts marks the connection for reconnecting.
  if (GRANT_GONE.includes(code)) throw new GatewayError('invalid_grant')
  if (response.status === 401 || response.status === 403) throw new GatewayError('Your Harness sign-in has expired. Run harness login, then try again.')
  if (!response.ok || envelope?.success === false) {
    throw new GatewayError(envelope?.error?.message || `Harness answered ${response.status}. Try again shortly.`)
  }
  const data = envelope?.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GatewayError('Harness sent an unexpected answer.')
  return data as Record<string, unknown>
}

/** {code: row} the gateway offers this account; empty when signed out or offline. */
export async function available(): Promise<Record<string, GatewayRow>> {
  try {
    const rows = (await call('connectors')).connectors
    if (!Array.isArray(rows)) return {}
    return Object.fromEntries(rows.filter((row): row is GatewayRow => row && typeof row === 'object' && typeof row.code === 'string').map(row => [row.code, row]))
  } catch { return {} }
}

export function tokenFrom(payload: Record<string, unknown>, previous?: Token): Token {
  const access = payload.access_token
  if (typeof access !== 'string' || !access) throw new GatewayError('The connector service did not return a token.')
  const expires = payload.expires_at
  const token: Token = {
    access_token: access, token_type: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    refresh_token: typeof payload.refresh_token === 'string' ? payload.refresh_token : '',
    expires_at: typeof expires === 'number' && Number.isInteger(expires) && expires > 0 ? expires : 0,
    scope: typeof payload.scope === 'string' ? payload.scope : '',
    account_name: (typeof payload.account_name === 'string' && payload.account_name) || previous?.account_name || '',
    source: 'gateway', obtained_at: Math.floor(Date.now() / 1000),
  }
  if (payload.refresh === true || (payload.refresh === undefined && token.refresh_token)) token.refresh = true
  const mcp = payload.mcp_entry as Record<string, unknown> | undefined
  if (mcp && typeof mcp === 'object' && typeof mcp.url === 'string') {
    const headers = mcp.headers && typeof mcp.headers === 'object' ? mcp.headers as Record<string, string> : { Authorization: bearer(token) }
    token.mcp_entry = { url: mcp.url, headers }
  }
  // Sent verbatim, the token not filled in: the bridge fills it per call, so a renewal never goes stale.
  const rest = cleanRestEntry(payload.rest_entry)
  if (rest) token.rest_entry = rest
  if (payload.transport === 'mcp' || payload.transport === 'rest' || payload.transport === 'none') token.transport = payload.transport
  return token
}

export class GatewaySignIn implements SignIn {
  private pickup = ''
  private interval = 2
  private expires = 600
  constructor(private readonly code: string) {}

  async prepare(): Promise<string> {
    const started = await call('connectors/start', { connector: this.code })
    const url = started.authorize_url
    if (typeof started.pickup_code !== 'string' || typeof url !== 'string' || !url.startsWith('https://')) {
      throw new GatewayError('The connector service could not start this sign-in.')
    }
    this.pickup = started.pickup_code
    this.interval = Math.min(Math.max(Number(started.poll_interval) || 2, 1), 60)
    this.expires = Math.min(Math.max(Number(started.expires_in) || 600, 30), 3600)
    return url
  }

  async wait(cancelled: () => boolean = () => false): Promise<Token> {
    const deadline = Date.now() + this.expires * 1000
    while (Date.now() < deadline && !cancelled()) {
      const result = await call('connectors/poll', { pickup_code: this.pickup })
      if (result.status === 'ready') return tokenFrom(result)
      if (result.status === 'failed' || result.status === 'expired' || result.status === 'consumed') {
        throw new GatewayError(typeof result.error === 'string' && result.error ? result.error : 'The sign-in did not finish. Try again.')
      }
      if (result.status !== 'pending') throw new GatewayError('The connector service sent an unexpected answer.')
      await new Promise(resolve => setTimeout(resolve, this.interval * 1000))
    }
    throw new GatewayError('The sign-in was not finished in time.')
  }
}

/** The gateway holds the refresh token and the app's secret. A refused session keeps the stored token. */
export async function refresh(code: string, token: Token): Promise<Token> {
  return tokenFrom(await call('connectors/refresh', { connector: code }), token)
}

export async function disconnect(code: string): Promise<void> {
  // Forgetting it here is what was asked; a gateway that cannot be reached forgets its copy on the next sign-in.
  await call('connectors/disconnect', { connector: code }).catch(() => undefined)
}
