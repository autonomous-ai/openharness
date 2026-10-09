/**
 * The local MCP bridge: agents call http://127.0.0.1:51793/<key>/<code>/mcp and the bridge forwards to the
 * service's MCP server with the stored credential, renewing it first when it is about to expire, and streams
 * the answer back (event streams included). A service reached by REST (no MCP server the grant can use) is
 * answered here instead, its REST tools served as MCP (rest.ts). Runs in the daemon (services/connectors.ts).
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { label } from './catalog.js'
import { needsRefresh, refreshable, type Store, type Token } from './store.js'
import { refresh } from './renew.js'
import { answer as answerRest, transport } from './rest.js'

/** Headers an MCP client sends that the service must see. Authorization never comes from the agent. */
const FORWARD = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const RETURN = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'cache-control']
const MAX_BODY = 16 * 1024 * 1024

function fail(response: ServerResponse, status: number, message: string): void {
  // A JSON-RPC shaped error, so the agent shows the reason. The connection closes: a refused request's
  // body may be unread, and must never be parsed as the next request.
  const raw = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } })
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), Connection: 'close' }).end(raw)
}

function readBody(request: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { request.destroy(); reject(new Error('too large')) } else chunks.push(chunk)
    })
    request.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : null))
    request.on('error', reject)
  })
}

export interface BridgeOptions {
  /** The capability agents' addresses carry (agents.ts bridgeKey), read per request. */
  key: () => string
}

export function createBridge(vault: Store, options: BridgeOptions): Server {
  const target = (url: string): string | null => {
    const parts = new URL(url, 'http://127.0.0.1').pathname.replace(/^\/|\/$/g, '').split('/')
    if (parts.length !== 3 || parts[2] !== 'mcp') return null
    const key = options.key()
    const given = Buffer.from(parts[0])
    if (!key || given.length !== Buffer.byteLength(key) || !timingSafeEqual(given, Buffer.from(key))) return null
    return parts[1]
  }

  const forward = (token: Token, request: IncomingMessage, body: Buffer | null): Promise<Response> => {
    const entry = token.mcp_entry!
    const upstream = new URL(entry.url)
    const query = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
    for (const [name, value] of query) upstream.searchParams.append(name, value)
    const headers: Record<string, string> = {}
    for (const name of FORWARD) {
      const value = request.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    Object.assign(headers, entry.headers, { 'user-agent': 'Harness-Connections' })
    return fetch(upstream, { method: request.method, headers, body: body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(300_000) })
  }

  /** A REST-backed connection: this bridge is its MCP server (rest.ts), reading the store per call. */
  const serveRest = async (code: string, request: IncomingMessage, response: ServerResponse, body: Buffer | null): Promise<void> => {
    // No event stream to offer: 405 is how an MCP server says so (MCP streamable HTTP).
    if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST', 'Content-Length': 0 }).end(); return }
    let message: unknown
    try { message = JSON.parse(body?.toString('utf8') ?? '') } catch { message = undefined }
    const reply = message === undefined
      ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }
      : await answerRest(message, () => vault.token(code)?.rest_entry ?? null, async () => {
        const token = vault.token(code)
        if (!token) throw new Error('That connection is no longer connected. Reconnect it in harness connections and try again.')
        return needsRefresh(token) ? refresh(vault, code) : token
      })
    if (!reply) { response.writeHead(202, { 'Content-Length': 0 }).end(); return }
    const raw = JSON.stringify(reply)
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }).end(raw)
  }

  const relay = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    // Only a process on this computer that knows this user's key gets through; never a web page.
    if (request.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {
      fail(response, 403, 'Forbidden.'); return
    }
    const code = target(request.url ?? '/')
    if (!code) { fail(response, 404, 'Unknown connection address. Run harness connections sync.'); return }
    if (request.headers['transfer-encoding'] && !request.headers['content-length']) { fail(response, 411, 'Send the request with a Content-Length.'); return }
    let body: Buffer | null
    try { body = await readBody(request) } catch { fail(response, 413, 'Request is too large.'); return }
    const name = vault.token(code)?.label || label(code)
    let stored: Token | undefined
    try { stored = vault.token(code) } catch (error) { fail(response, 401, `${name}: ${(error as Error).message}`); return }
    const via = stored ? transport(stored) : 'none'
    if (!stored || via === 'none') { fail(response, 404, `${name} is not connected. Open harness connections to connect it.`); return }
    if (via === 'rest') { await serveRest(code, request, response, body); return }
    let token = stored
    try {
      if (needsRefresh(token)) token = await refresh(vault, code)
    } catch (error) { fail(response, 401, `${name}: ${(error as Error).message}`); return }
    let answer: Response
    try {
      answer = await forward(token, request, body)
      if (answer.status === 401 && refreshable(token)) {
        // A token the service revoked early: renew once and try again.
        await answer.body?.cancel()
        try { token = await refresh(vault, code, true) } catch (error) { fail(response, 401, `${name}: ${(error as Error).message}`); return }
        answer = await forward(token, request, body)
      }
    } catch { fail(response, 502, `${name} could not be reached. Try again.`); return }
    if (answer.status === 401) {
      // Never pass the service's own sign-in challenge on: signing in happens in Harness, not in each agent.
      await answer.body?.cancel()
      fail(response, 401, `${name} needs to be connected again. Open harness connections.`); return
    }
    const headers: Record<string, string> = {}
    for (const name of RETURN) {
      const value = answer.headers.get(name)
      if (value) headers[name] = value
    }
    response.writeHead(answer.status, headers)
    if (!answer.body) { response.end(); return }
    // The answer as it arrives: MCP replies may be an event stream.
    Readable.fromWeb(answer.body as import('node:stream/web').ReadableStream).on('error', () => response.destroy()).pipe(response)
  }

  return createServer((request, response) => {
    relay(request, response).catch(() => { if (!response.headersSent) fail(response, 500, 'The bridge failed.'); else response.destroy() })
  })
}
