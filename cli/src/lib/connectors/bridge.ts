/**
 * The local MCP bridge: agents call http://127.0.0.1:51793/<key>/<code>/mcp and the bridge forwards to the
 * service's MCP server with the stored credential, renewing it first when it is about to expire, and streams
 * the answer back (event streams included). A service reached by REST (no MCP server the grant can use) is
 * answered here instead, its REST tools served as MCP (rest.ts). Runs in the daemon (services/connectors.ts).
 *
 * MCP clients come through a stdio shim (mcpShimSource.ts) to a second listener on a 0600 socket (serveBridgeSocket), or on Windows
 * a pipe that proves a token both ways (serveBridgePipe), so no tool call goes to a port another account can hold. The port stays
 * for clients still running on it and a folder too long for a socket.
 *
 * Two more addresses serve Harness's own cloud agents (services/cloud.ts), over the socket where one can be, which hold no credential either:
 * - `/<key>/connections`: what is connected, by address and with no secret, so the service finds the
 *   connection that signs in Fo or Devin by where it points rather than by what the person named it;
 * - `/<key>/<code>/api/<path>`: one request to a key-only connection's own API (`api_entry`), with its key.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { listenLocalSocket, type LocalSocketServer } from '../localSocket.js'
import { label } from './catalog.js'
import { bearer, locked, needsRefresh, refreshable, writePrivate, type Store, type Token } from './store.js'
import { refresh } from './renew.js'
import { answer as answerRest, transport } from './rest.js'
import { peerIsThisAccount, type PeerAccount } from '../peerAccount.js'
import { newPipePath } from '../windows/pipeAuth.js'

/** Headers an MCP client sends that the service must see. Authorization never comes from the agent. */
const FORWARD = ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
/** Headers a REST call through `/api/` may carry. */
const FORWARD_API = ['accept', 'content-type', 'last-event-id']
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
  /** Harness's own capability (agents.ts harnessKey), never in an agent's configuration: only it lists the
   *  connections or calls a key-only connection's API. Absent, those two addresses answer nothing. */
  harnessKey?: () => string
  /** Served on the 0600 socket, whose peers have no address: the filesystem has already said who they are. */
  socket?: boolean
  /** Whether a caller runs as this OS account (lib/peerAccount.ts). A test's stand-in for another account. */
  peerAccount?: PeerAccount
}

type Target = { kind: 'mcp'; code: string } | { kind: 'api'; code: string; path: string } | { kind: 'list' }

/** What stands for the capability on the socket, where reaching it is the credential: the filesystem lets only this account. */
export const SOCKET_KEY = 'local'

export function createBridge(vault: Store, options: BridgeOptions): Server {
  return createServer(bridgeHandler(vault, options))
}

/** On the socket or the pipe: for MCP clients, their MCP servers only, as an agent's key reaches; for Harness's own key, what it reaches. */
function localOptions(vault: Store): BridgeOptions {
  return { key: () => SOCKET_KEY,
    // Harness's own calls (cloud/bridge.ts) come here too: its key never crosses the port where this listener can be.
    // An unreadable key refuses Harness's calls only: agents' MCP calls never needed this file.
    harnessKey: () => { try { return String(vault.file('harness-key.json').key ?? '') } catch { return '' } }, socket: true }
}

/** The bridge on its 0600 socket. */
export async function serveBridgeSocket(vault: Store, path: string): Promise<LocalSocketServer> {
  // The socket's privacy rests on this folder too, which may be older than this code.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  chmodSync(dirname(path), 0o700)
  const listening = await listenLocalSocket(bridgeHandler(vault, localOptions(vault)), path)
  listening.server.unref()
  return listening
}

/** The record of the bridge's pipe in the vault's private folder (agents.ts `readBridgePipe`, the shim). */
export const BRIDGE_PIPE_FILE = 'bridge-pipe.json'

/**
 * The bridge on Windows (task #2162): a pipe of a new name, `\\.\pipe\harness-<id>`, whose every request must prove a token new
 * at each start, and whose every answer proves it back (lib/windows/pipeAuth.ts, as the daemon's own pipe does). Node cannot set a
 * pipe's DACL, so reaching it is no credential, and once this process is gone any account can make a pipe of the name. The pipe,
 * this process and the token are recorded in [BRIDGE_PIPE_FILE], private to this account in its profile, once it listens.
 */
export async function serveBridgePipe(vault: Store, path: string = newPipePath()): Promise<LocalSocketServer> {
  const token = randomBytes(32)
  const listening = await listenLocalSocket(bridgeHandler(vault, localOptions(vault)), path, { token })
  listening.server.unref()
  try {
    locked(vault.root, () => { writePrivate(join(vault.root, BRIDGE_PIPE_FILE), { pipe: path, pid: process.pid, token: token.toString('hex') }) })
  } catch (error) {
    // Unrecorded, nothing can reach it: listening on would only hold the name.
    listening.closeSync()
    throw error
  }
  return listening
}

function bridgeHandler(vault: Store, options: BridgeOptions): RequestListener {
  const target = (url: string): Target | null => {
    const parts = new URL(url, 'http://127.0.0.1').pathname.replace(/^\/|\/$/g, '').split('/')
    const given = Buffer.from(parts[0])
    const matches = (key: string): boolean => !!key && given.length === Buffer.byteLength(key) && timingSafeEqual(given, Buffer.from(key))
    const harness = matches(options.harnessKey?.() ?? '')
    if (!harness && !matches(options.key())) return null
    if (parts.length === 3 && parts[2] === 'mcp') return { kind: 'mcp', code: parts[1] }
    // An agent's key reaches MCP servers only: the list and the API keys are Harness's alone.
    if (!harness) return null
    if (parts.length === 2 && parts[1] === 'connections') return { kind: 'list' }
    if (parts.length >= 4 && parts[2] === 'api') return { kind: 'api', code: parts[1], path: `/${parts.slice(3).join('/')}` }
    return null
  }

  /** What is connected, with no secret: an MCP server's address without its query, which can carry a key. */
  const list = (response: ServerResponse): void => {
    const connections = Object.entries(vault.tokens()).map(([code, token]) => {
      const mcp = token.mcp_entry ? new URL(token.mcp_entry.url) : null
      return { code, name: token.label || label(code), mcp: mcp ? `${mcp.origin}${mcp.pathname}` : null, api: token.api_entry?.origin ?? null,
        state: token.needs_reconnect ? 'reconnect' : 'connected' }
    })
    const raw = JSON.stringify({ connections })
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }).end(raw)
  }

  /** One request to a key-only connection's API, pinned to its origin: a path such as `//elsewhere` cannot
   *  carry the key to another host. A key is never renewed, so a 401 means connect it again. */
  const serveApi = async (name: string, token: Token, path: string, request: IncomingMessage, response: ServerResponse, body: Buffer | null): Promise<void> => {
    const origin = token.api_entry?.origin
    if (!origin || !token.access_token) { fail(response, 404, `${name} has no API to call.`); return }
    const upstream = new URL(`${origin}${path}`)
    if (upstream.origin !== origin) { fail(response, 404, 'Unknown connection address.'); return }
    upstream.search = new URL(request.url ?? '/', 'http://127.0.0.1').search
    const headers: Record<string, string> = {}
    for (const header of FORWARD_API) {
      const value = request.headers[header]
      if (typeof value === 'string') headers[header] = value
    }
    Object.assign(headers, { authorization: bearer(token), 'user-agent': 'Harness-Connections' })
    let answer: Response
    try {
      answer = await fetch(upstream, { method: request.method, headers, body: body ?? undefined, redirect: 'manual', signal: AbortSignal.timeout(300_000) })
    } catch { fail(response, 502, `${name} could not be reached. Try again.`); return }
    if (answer.status === 401) {
      await answer.body?.cancel()
      fail(response, 401, `${name} needs to be connected again. Open harness connections.`); return
    }
    const back: Record<string, string> = {}
    for (const header of ['content-type', 'cache-control']) {
      const value = answer.headers.get(header)
      if (value) back[header] = value
    }
    response.writeHead(answer.status, back)
    if (!answer.body) { response.end(); return }
    Readable.fromWeb(answer.body as import('node:stream/web').ReadableStream).on('error', () => response.destroy()).pipe(response)
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
    if (request.headers.origin || (!options.socket && !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? ''))) {
      fail(response, 403, 'Forbidden.'); return
    }
    const address = target(request.url ?? '/')
    // An MCP client can only speak HTTP to the address in its configuration, so it cannot check who holds this port,
    // and another account that took it during a restart hears the key (audit H1). A key heard must open nothing. Answered
    // as an unknown key is, so the answer does not say the key was right.
    // On the 0600 socket the filesystem has already said who the caller is, and a socket's peer has no port to look up.
    if (!address || (!options.socket && !await (options.peerAccount ?? peerIsThisAccount)(request.socket))) {
      fail(response, 404, 'Unknown connection address. Restart this agent, or run harness connections sync.'); return
    }
    if (address.kind === 'list') { list(response); return }
    const code = address.code
    if (request.headers['transfer-encoding'] && !request.headers['content-length']) { fail(response, 411, 'Send the request with a Content-Length.'); return }
    let body: Buffer | null
    try { body = await readBody(request) } catch { fail(response, 413, 'Request is too large.'); return }
    const name = vault.token(code)?.label || label(code)
    let stored: Token | undefined
    try { stored = vault.token(code) } catch (error) { fail(response, 401, `${name}: ${(error as Error).message}`); return }
    if (stored && address.kind === 'api') { await serveApi(name, stored, address.path, request, response, body); return }
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

  return (request, response) => {
    relay(request, response).catch(() => { if (!response.headersSent) fail(response, 500, 'The bridge failed.'); else response.destroy() })
  }
}
