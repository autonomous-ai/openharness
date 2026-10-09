/**
 * The Autonomous connector gateway, for services that let no computer register itself (Grid's `app`
 * path). The gateway holds the service's OAuth app: this computer starts a sign-in, polls for its one-time
 * result and stores the token like any other. It needs the Grid session `harness login` keeps in
 * ~/.grid/credentials.toml, read as lib/localModels.ts reads it for the model catalog.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bearer, cleanUrl, ConnectorError, type Token } from './store.js'
import type { GatewayRow } from './catalog.js'
import type { SignIn } from './oauth.js'

const TIMEOUT_MS = 20_000
const DEFAULT_API = 'https://api-grid.autonomous.ai'

export class GatewayError extends ConnectorError {}

/** [api url, session token] from credentials.toml's top table, or null when signed out. */
export function session(env: NodeJS.ProcessEnv = process.env): [string, string] | null {
  const home = env.GRID_HOME ? env.GRID_HOME.replace(/^~(?=$|\/)/, env.HOME || homedir()) : join(env.HOME || homedir(), '.grid')
  let top: string
  try { top = readFileSync(join(home, 'credentials.toml'), 'utf8').split(/^\s*\[/m)[0] } catch { return null }
  const value = (name: string): string => {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*')\\s*$`, 'm').exec(top)
    if (!match) return ''
    try { return match[1][0] === '"' ? JSON.parse(match[1]) : match[1].slice(1, -1) } catch { return '' }
  }
  const token = value('session_token')
  if (!token) return null
  const base = value('api_url') || env.GRID_CONTROL_PLANE_URL || DEFAULT_API
  try { cleanUrl(base) } catch { return null }
  return [base.replace(/\/$/, ''), token]
}

export async function call(path: string, body?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const found = session(env)
  if (!found) throw new GatewayError('Sign in to Harness first (harness login) to connect this service.')
  const [base, token] = found
  let response: Response
  try {
    response = await fetch(`${base}/v1/grid/${path}`, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Harness-Connections' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch { throw new GatewayError('Could not reach the connector service. Check the connection and try again.') }
  if (response.status === 401 || response.status === 403) throw new GatewayError('Your Harness sign-in has expired. Run harness login, then try again.')
  if (!response.ok) throw new GatewayError(`The connector service answered ${response.status}. Try again shortly.`)
  let data: unknown
  try { data = await response.json() } catch { data = null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new GatewayError('The connector service sent an unexpected answer.')
  return data as Record<string, unknown>
}

/** {code: row} the gateway offers this account; empty when signed out or offline. */
export async function available(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, GatewayRow>> {
  try {
    const rows = (await call('connectors', undefined, env)).connectors
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
  return token
}

export class GatewaySignIn implements SignIn {
  private pickup = ''
  private interval = 2
  private expires = 600
  constructor(private readonly code: string, private readonly env: NodeJS.ProcessEnv = process.env) {}

  async prepare(): Promise<string> {
    const started = await call('connectors/start', { connector: this.code }, this.env)
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
      const result = await call('connectors/poll', { pickup_code: this.pickup }, this.env)
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
export async function refresh(code: string, token: Token, env: NodeJS.ProcessEnv = process.env): Promise<Token> {
  return tokenFrom(await call('connectors/refresh', { connector: code }, env), token)
}

export async function disconnect(code: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Forgetting it here is what was asked; the gateway's copy expires on its own.
  await call('connectors/disconnect', { connector: code }, env).catch(() => undefined)
}
