/**
 * Fake services for the connectors specs, never a real provider: an MCP server with its own OAuth server
 * (MCP auth metadata, RFC 7591 registration, PKCE, rotating refresh tokens, an event stream) and the
 * Autonomous connector gateway.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function send(response: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}): void {
  const raw = data === undefined ? '' : JSON.stringify(data)
  response.writeHead(status, { ...headers, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }).end(raw)
}

export class FakeService {
  base = ''
  access = ''
  refresh = ''
  revoked = false
  registered: Record<string, unknown>[] = []
  seen: { auth?: string, session?: string, body: string }[] = []
  private challenge = new Map<string, string>()
  readonly server = createServer((request, response) => { this.handle(request, response).catch(() => response.destroy()) })

  async start(): Promise<this> { this.base = `http://127.0.0.1:${await listen(this.server)}`; return this }
  close(): void { this.server.close(); this.server.closeAllConnections() }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.base)
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      send(response, 200, { resource: this.base + '/mcp', authorization_servers: [this.base], scopes_supported: ['read'] }); return
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      send(response, 200, { issuer: this.base, authorization_endpoint: this.base + '/authorize', token_endpoint: this.base + '/token',
        registration_endpoint: this.base + '/register', code_challenge_methods_supported: ['S256'] }); return
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      const query = Object.fromEntries(url.searchParams)
      if (query.code_challenge_method !== 'S256' || query.resource !== this.base + '/mcp') { send(response, 400, { error: 'bad' }); return }
      this.challenge.set('code-1', query.code_challenge)
      response.writeHead(302, { Location: `${query.redirect_uri}?${new URLSearchParams({ code: 'code-1', state: query.state })}` }).end()
      return
    }
    const text = await body(request)
    if (url.pathname === '/register') {
      const data = JSON.parse(text)
      this.registered.push(data)
      send(response, 201, { client_id: 'client-1', redirect_uris: data.redirect_uris }); return
    }
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(text))
      if (form.grant_type === 'authorization_code') {
        const verifier = createHash('sha256').update(form.code_verifier ?? '').digest('base64url')
        if (this.challenge.get(form.code) !== verifier || form.client_id !== 'client-1') { send(response, 400, { error: 'invalid_grant' }); return }
        this.access = 'access-1'; this.refresh = 'refresh-1'
      } else if (form.refresh_token !== this.refresh || this.revoked) { send(response, 400, { error: 'invalid_grant' }); return } else {
        const n = Number(this.access.split('-')[1]) + 1
        this.access = `access-${n}`; this.refresh = `refresh-${n}`
      }
      send(response, 200, { access_token: this.access, token_type: 'bearer', expires_in: 3600, refresh_token: this.refresh, scope: 'read' }); return
    }
    if (url.pathname === '/mcp') {
      this.seen.push({ auth: request.headers.authorization, session: request.headers['mcp-session-id'] as string | undefined, body: text })
      if (request.headers.authorization !== `Bearer ${this.access}`) {
        send(response, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${this.base}/.well-known/oauth-protected-resource/mcp"` }); return
      }
      if (url.searchParams.get('stream') === '1') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session-1' })
        for (let n = 0; n < 3; n++) response.write(`data: {"n": ${n}}\n\n`)
        response.end(); return
      }
      send(response, 200, { jsonrpc: '2.0', id: 1, result: { ok: true } }, { 'Mcp-Session-Id': 'session-1' }); return
    }
    send(response, 404, {})
  }
}

export class FakeGateway {
  base = ''
  polls = 0
  calls: [string, unknown][] = []
  readonly server = createServer((request, response) => { this.handle(request, response).catch(() => response.destroy()) })

  async start(): Promise<this> { this.base = `http://127.0.0.1:${await listen(this.server)}`; return this }
  close(): void { this.server.close(); this.server.closeAllConnections() }

  /** An answer in the Harness backend's envelope; `fail` makes the next one a refusal with that code. */
  fail: { status: number, code: string, message: string } | null = null

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const ok = (data: unknown) => send(response, 200, { success: true, data })
    if (request.headers.authorization !== 'Bearer harness-session') { send(response, 401, { success: false, error: { code: 'UNAUTHORIZED', message: 'Sign in.' } }); return }
    if (this.fail) {
      const { status, code, message } = this.fail
      this.fail = null
      send(response, status, { success: false, error: { code, message } }); return
    }
    if (request.method === 'GET') {
      ok({ connectors: [
        { code: 'github', label: 'GitHub', auth_type: 'app', mcp_url: 'https://api.githubcopilot.com/mcp/' },
        { code: 'linear', label: 'Linear', auth_type: 'app', mcp_url: 'https://mcp.linear.app/mcp' },
        { code: 'newsvc', label: 'New Service', auth_type: 'dcr', mcp_url: 'https://mcp.newsvc.example/mcp', description: 'Added to Grid after this build.' },
        { code: 'manual-only', label: 'Manual', auth_type: 'pat' },
      ] }); return
    }
    const path = (request.url ?? '').replace('/api/', '')
    const data = JSON.parse(await body(request))
    this.calls.push([path, data])
    const token = { access_token: 'gho-fixture', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh: true, account_name: 'octo', transport: 'mcp', rest_entry: null,
      mcp_entry: { url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer gho-fixture' } } }
    if (path === 'connectors/start') ok({ authorize_url: 'https://github.com/login/oauth/authorize?state=harness_x', pickup_code: 'pickup-1', poll_interval: 1, expires_in: 60 })
    else if (path === 'connectors/poll') { this.polls += 1; ok(this.polls < 2 ? { status: 'pending' } : { ...token, status: 'ready', connector: 'github' }) }
    else if (path === 'connectors/refresh') ok({ ...token, access_token: 'gho-renewed' })
    else ok({ disconnected: true })
  }
}
