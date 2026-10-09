/**
 * Sign in to an MCP server from this computer: MCP OAuth with dynamic client registration (RFC 7591),
 * PKCE S256 and a 127.0.0.1 redirect (Grid's `dcr` path). No client secret ships with Harness: each
 * computer registers its own public client with the service and keeps it in clients.json.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { bearer, cleanUrl, ConnectorError, MAX_BYTES, type Client, type Store, type Token } from './store.js'

const TIMEOUT_MS = 15_000
export const SIGN_IN_MS = 300_000
/** Grid's preferred loopback ports, then any free one. */
const PORTS = [51789, 51790, 51791, 51792, 0]

export class SignInError extends ConnectorError {}

interface Answer { status: number, headers: Headers, body: string }

export async function http(url: string, init: { body?: string, headers?: Record<string, string>, method?: string } = {}): Promise<Answer> {
  try {
    const response = await fetch(url, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'), body: init.body, redirect: 'manual',
      headers: { 'User-Agent': 'Harness-Connections', Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const body = await response.text()
    return { status: response.status, headers: response.headers, body: body.slice(0, MAX_BYTES) }
  } catch { throw new SignInError('Could not reach the service. Check the connection and try again.') }
}

function jsonOf(body: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(body)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null
  } catch { return null }
}

function wellKnown(base: string, name: string, path = ''): string {
  const url = new URL(base)
  return `${url.protocol}//${url.host}/.well-known/${name}${path.replace(/\/$/, '')}`
}

export interface OAuthMeta {
  kind: 'oauth'
  issuer: string
  resource: string
  scopes: string[]
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  s256: boolean
}
export type Probe = { kind: 'open' } | OAuthMeta

/** What signing in to this MCP server takes: nothing (`open`) or its OAuth metadata. */
export async function probe(server: string): Promise<Probe> {
  const url = cleanUrl(server)
  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Harness', version: '1' } } })
  const first = await http(url, { body: initialize, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } })
  if (first.status >= 200 && first.status < 300) return { kind: 'open' }
  if (first.status !== 401 && first.status !== 403) throw new SignInError(`The server answered ${first.status}. Check the address.`)
  const challenge = first.headers.get('www-authenticate') ?? ''
  const pointed = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  const path = new URL(url).pathname
  let issuer: string | undefined
  let resource = url
  let scopes: string[] = []
  for (const candidate of [pointed, wellKnown(url, 'oauth-protected-resource', path), wellKnown(url, 'oauth-protected-resource')]) {
    if (!candidate) continue
    const answer = await http(candidate)
    const meta = answer.status === 200 ? jsonOf(answer.body) : null
    const servers = meta?.authorization_servers
    if (Array.isArray(servers) && typeof servers[0] === 'string') {
      issuer = servers[0]
      resource = typeof meta!.resource === 'string' ? meta!.resource : url
      scopes = Array.isArray(meta!.scopes_supported) ? meta!.scopes_supported.filter((s): s is string => typeof s === 'string') : []
      break
    }
  }
  const base = new URL(url)
  issuer ??= `${base.protocol}//${base.host}`
  const issuerPath = new URL(issuer).pathname
  for (const candidate of [wellKnown(issuer, 'oauth-authorization-server', issuerPath), wellKnown(issuer, 'openid-configuration', issuerPath),
    issuer.replace(/\/$/, '') + '/.well-known/openid-configuration']) {
    const answer = await http(candidate)
    const meta = answer.status === 200 ? jsonOf(answer.body) : null
    if (meta && typeof meta.authorization_endpoint === 'string' && typeof meta.token_endpoint === 'string') {
      for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) if (meta[key]) cleanUrl(meta[key])
      const methods = Array.isArray(meta.code_challenge_methods_supported) ? meta.code_challenge_methods_supported : ['S256']
      return {
        kind: 'oauth', issuer, resource, scopes,
        authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint,
        registration_endpoint: typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined,
        s256: methods.includes('S256'),
      }
    }
  }
  throw new SignInError('This server does not say how to sign in.')
}

/** One sign-in's redirect target on 127.0.0.1. */
class Callback {
  result: Record<string, string> | null = null
  private done!: () => void
  readonly finished = new Promise<void>(resolve => { this.done = resolve })
  constructor(readonly server: Server, readonly port: number) {
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/callback') { response.writeHead(404).end(); return }
      this.result = Object.fromEntries(url.searchParams)
      const ok = 'code' in this.result
      const page = '<!doctype html><meta charset=utf-8><title>Harness</title>'
        + "<body style='font:16px ui-monospace,monospace;background:#11140f;color:#e7e8de;padding:48px'>"
        + (ok ? '<h1>Connected.</h1><p>You can close this tab and return to Harness.</p><script>setTimeout(()=>window.close(),800)</script>'
          : '<h1>Not connected.</h1><p>Return to Harness and try again.</p>')
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page)
      this.done()
    })
  }
  get redirectUri(): string { return `http://127.0.0.1:${this.port}/callback` }
  close(): void { this.server.close(); this.server.closeAllConnections?.() }
}

async function listen(): Promise<Callback> {
  for (const port of PORTS) {
    const server = createServer()
    const bound = await new Promise<number | null>(resolve => {
      server.once('error', () => resolve(null))
      server.listen(port, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
    })
    if (bound !== null) return new Callback(server, bound)
  }
  throw new SignInError('Could not open a local sign-in address.')
}

export function pkce(): { verifier: string, challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** This computer's OAuth client for the issuer, registered once and reused. */
async function register(vault: Store, meta: OAuthMeta, redirectUri: string): Promise<Client> {
  const known = vault.client(meta.issuer)
  if (known?.client_id && known.redirect_uri === redirectUri) return known
  if (!meta.registration_endpoint) throw new SignInError('This service does not let a computer register itself.')
  const answer = await http(meta.registration_endpoint, { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'Harness', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
  }) })
  const data = jsonOf(answer.body)
  if ((answer.status !== 200 && answer.status !== 201) || typeof data?.client_id !== 'string') {
    throw new SignInError('The service refused to register Harness on this computer.')
  }
  const secret = typeof data.client_secret === 'string' ? data.client_secret : ''
  const client: Client = {
    client_id: data.client_id, client_secret: secret,
    token_endpoint_auth_method: typeof data.token_endpoint_auth_method === 'string' ? data.token_endpoint_auth_method : (secret ? 'client_secret_basic' : 'none'),
    authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint,
    redirect_uri: redirectUri, registered_at: Math.floor(Date.now() / 1000),
  }
  vault.saveClient(meta.issuer, client)
  return client
}

async function tokenRequest(client: Client, form: Record<string, string>): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  const fields: Record<string, string> = { ...form, client_id: client.client_id }
  if (client.client_secret) {
    if (client.token_endpoint_auth_method === 'client_secret_post') fields.client_secret = client.client_secret
    else headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')
  }
  const answer = await http(client.token_endpoint, { headers, body: new URLSearchParams(fields).toString() })
  const data = jsonOf(answer.body) ?? {}
  if (answer.status !== 200 || typeof data.access_token !== 'string') {
    throw new SignInError(data.error === 'invalid_grant' ? 'invalid_grant' : 'The service did not issue a token.')
  }
  return data
}

function tokenFrom(data: Record<string, unknown>, mcpUrl: string, issuer: string, previous?: Token): Token {
  const now = Math.floor(Date.now() / 1000)
  const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? Math.floor(data.expires_in) : 0
  const token: Token = {
    access_token: data.access_token as string, token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    refresh_token: (typeof data.refresh_token === 'string' && data.refresh_token) || previous?.refresh_token || '',
    expires_at: expiresIn ? now + expiresIn : 0,
    scope: typeof data.scope === 'string' ? data.scope : previous?.scope ?? '',
    source: 'dcr', issuer, obtained_at: now, account_name: previous?.account_name ?? '',
  }
  token.mcp_entry = { url: mcpUrl, headers: { Authorization: bearer(token) } }
  if (token.refresh_token) token.refresh = true
  return token
}

export interface SignIn {
  /** The address to open in a browser, or null when the server needs no sign-in. */
  prepare(): Promise<string | null>
  wait(cancelled?: () => boolean): Promise<Token>
}

/** One browser sign-in to an MCP server: prepare() gives the address to open, wait() the token. */
export class LocalSignIn implements SignIn {
  private meta?: Probe
  private callback?: Callback
  private client?: Client
  private verifier = ''
  private state = ''
  constructor(private readonly vault: Store, private readonly mcpUrl: string) { cleanUrl(mcpUrl) }

  async prepare(): Promise<string | null> {
    this.meta = await probe(this.mcpUrl)
    if (this.meta.kind === 'open') return null
    if (!this.meta.s256) throw new SignInError('This service does not support a secure sign-in from a computer.')
    this.callback = await listen()
    try { this.client = await register(this.vault, this.meta, this.callback.redirectUri) } catch (error) { this.callback.close(); throw error }
    const { verifier, challenge } = pkce()
    this.verifier = verifier
    this.state = randomBytes(24).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id: this.client.client_id, redirect_uri: this.callback.redirectUri,
      state: this.state, code_challenge: challenge, code_challenge_method: 'S256' })
    if (this.meta.resource) query.set('resource', this.meta.resource)
    if (this.meta.scopes.length) query.set('scope', this.meta.scopes.join(' '))
    const endpoint = this.client.authorization_endpoint
    return endpoint + (endpoint.includes('?') ? '&' : '?') + query.toString()
  }

  async wait(cancelled: () => boolean = () => false): Promise<Token> {
    if (!this.callback || this.meta?.kind !== 'oauth') {
      return { mcp_entry: { url: this.mcpUrl, headers: {} }, source: 'dcr', obtained_at: Math.floor(Date.now() / 1000) }
    }
    const callback = this.callback
    try {
      const deadline = Date.now() + SIGN_IN_MS
      while (!callback.result) {
        if (Date.now() > deadline || cancelled()) throw new SignInError('The sign-in was not finished in time.')
        await Promise.race([callback.finished, new Promise(resolve => setTimeout(resolve, 250))])
      }
    } finally { callback.close() }
    const result = callback.result
    const state = Buffer.from(result.state ?? '')
    if (state.length !== Buffer.byteLength(this.state) || !timingSafeEqual(state, Buffer.from(this.state))) {
      throw new SignInError('The sign-in could not be confirmed. Try again.')
    }
    if (!result.code) throw new SignInError(result.error === 'access_denied' ? 'The sign-in was cancelled.' : 'The service did not complete the sign-in.')
    const form: Record<string, string> = { grant_type: 'authorization_code', code: result.code, redirect_uri: callback.redirectUri, code_verifier: this.verifier }
    if (this.meta.resource) form.resource = this.meta.resource
    return tokenFrom(await tokenRequest(this.client!, form), this.mcpUrl, this.meta.issuer)
  }
}

/** A renewed `dcr` token, through this computer's registered client. */
export async function refresh(vault: Store, token: Token): Promise<Token> {
  const client = vault.client(token.issuer ?? '')
  if (!client || !token.refresh_token || !token.mcp_entry) throw new SignInError('invalid_grant')
  const mcpUrl = token.mcp_entry.url
  const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: token.refresh_token, resource: mcpUrl }
  let data: Record<string, unknown>
  try { data = await tokenRequest(client, form) } catch (error) {
    if ((error as Error).message === 'invalid_grant') throw error
    // A service may reject the resource parameter on refresh; ask once more without it.
    delete form.resource
    data = await tokenRequest(client, form)
  }
  return tokenFrom(data, mcpUrl, token.issuer!, token)
}
