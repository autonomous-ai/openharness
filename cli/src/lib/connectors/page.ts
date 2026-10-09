/**
 * The Connectors page, on demand and on 127.0.0.1 only (`harness connections`). Every API request needs a
 * per-process capability delivered in the URL fragment; Host and Origin are checked; no CORS, no request
 * logs, nothing loaded from the network. It exits after 15 quiet minutes with no sign-in in progress.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { addCustom, cards, disconnect, Flows, signInFor } from './connect.js'
import { services, type GatewayRow } from './catalog.js'
import { ICONS } from './generated/icons.js'
import { PAGE_FILES } from './generated/page.js'
import { ConnectorError, locked, readPrivate, validateCode, writePrivate, type Store } from './store.js'
import * as gateway from './gateway.js'

const IDLE_MS = 15 * 60_000
const GATEWAY_CACHE_MS = 60_000
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
const FILES: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/page.js': ['page.js', 'text/javascript; charset=utf-8'],
}

export function identityProof(key: string, nonce: string): string {
  return createHmac('sha256', key).update('harness-connections-v1:' + nonce).digest('hex')
}

export class PageServer {
  readonly key = randomBytes(32).toString('base64url')
  readonly flows: Flows
  readonly server: Server
  lastRequest = Date.now()
  private offered: Record<string, GatewayRow> = {}
  private offeredAt = 0
  origin = ''

  constructor(readonly vault: Store, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.flows = new Flows(vault, env)
    this.server = createServer((request, response) => {
      this.handle(request, response).catch(() => { if (!response.headersSent) this.reply(response, 500, { error: 'Connections failed.' }) })
    })
  }

  listen(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        const bound = (this.server.address() as { port: number }).port
        this.origin = `http://127.0.0.1:${bound}`
        resolve(bound)
      })
    })
  }

  close(): void { this.server.close(); this.server.closeAllConnections?.() }

  async gatewayOffers(): Promise<Record<string, GatewayRow>> {
    if (Date.now() - this.offeredAt > GATEWAY_CACHE_MS) {
      this.offered = await gateway.available()
      this.offeredAt = Date.now()
    }
    return this.offered
  }

  private reply(response: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
    const raw = type === 'application/json' ? Buffer.from(JSON.stringify(body)) : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    response.writeHead(status, {
      'Content-Type': type, 'Content-Length': raw.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP,
    }).end(raw)
  }

  private local(request: IncomingMessage): boolean {
    const site = request.headers['sec-fetch-site'] ?? 'none'
    return request.headers.host === this.origin.replace('http://', '') && (site === 'none' || site === 'same-origin')
  }

  private authenticated(request: IncomingMessage): boolean {
    const given = Buffer.from(String(request.headers['x-harness-connections'] ?? ''))
    return this.local(request) && given.length === Buffer.byteLength(this.key) && timingSafeEqual(given, Buffer.from(this.key))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url ?? '/'
    if (request.method === 'POST') { await this.post(request, response, path); return }
    if (!this.local(request)) { this.reply(response, 403, { error: 'Open Connections from this computer.' }); return }
    if (path === '/api/identity') {
      const nonce = String(request.headers['x-harness-probe'] ?? '')
      if (!/^[0-9a-f]{64}$/.test(nonce)) { this.reply(response, 400, { error: 'Invalid identity challenge.' }); return }
      this.reply(response, 200, { proof: identityProof(this.key, nonce) }); return
    }
    if (path === '/api/connections' || path.startsWith('/api/flows/')) {
      if (!this.authenticated(request)) { this.reply(response, 403, { error: 'Open harness connections again to continue.' }); return }
      this.lastRequest = Date.now()
      try {
        if (path === '/api/connections') {
          const page = cards(this.vault, await this.gatewayOffers())
          const connections = page.connections.map(card => ({ ...card, icon: ICONS[card.connector] ? `/icons/${card.connector}` : '' }))
          this.reply(response, 200, { ...page, connections })
        } else this.reply(response, 200, this.flows.get(path.slice('/api/flows/'.length)))
      } catch (error) { this.reply(response, 400, { error: (error as Error).message }) }
      return
    }
    // Only the icons bundled at build time: never a path from the request.
    const icon = path.startsWith('/icons/') ? ICONS[path.slice('/icons/'.length)] : undefined
    if (icon) {
      const [head, data] = icon.split(',')
      this.reply(response, 200, Buffer.from(data, 'base64'), head.slice('data:'.length, head.indexOf(';')))
      return
    }
    const file = FILES[path]
    if (!file) { this.reply(response, 404, { error: 'Not found.' }); return }
    this.reply(response, 200, PAGE_FILES[file[0]], file[1])
  }

  private async post(request: IncomingMessage, response: ServerResponse, path: string): Promise<void> {
    if (!this.authenticated(request) || request.headers.origin !== this.origin || request.headers['content-type'] !== 'application/json' || request.headers['transfer-encoding']) {
      request.resume(); this.reply(response, 403, { error: 'Open Connections from this computer.' }); return
    }
    const length = Number(request.headers['content-length'] ?? 0)
    if (!(length > 0 && length <= 16_384)) { request.resume(); this.reply(response, 413, { error: 'Request is too large.' }); return }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    let data: Record<string, unknown>
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error()
    } catch { this.reply(response, 400, { error: 'Invalid request.' }); return }
    this.lastRequest = Date.now()
    try {
      if (path === '/api/connect') {
        const code = validateCode(data.connector)
        this.reply(response, 200, await this.flows.start(code, signInFor(this.vault, code, services(await this.gatewayOffers()))))
      } else if (path === '/api/custom') {
        this.reply(response, 200, await addCustom(this.vault, this.flows, data, this.env))
      } else if (path === '/api/disconnect') {
        const code = validateCode(data.connector)
        await disconnect(this.vault, code, this.env)
        this.reply(response, 200, { connector: code, state: 'not_connected' })
      } else this.reply(response, 404, { error: 'Not found.' })
    } catch (error) {
      this.reply(response, error instanceof ConnectorError ? 400 : 503, { error: error instanceof ConnectorError ? error.message : 'Connection unavailable. Try again.' })
    }
  }

  /** Serve until 15 quiet minutes have passed with no sign-in in progress. */
  async serveUntilIdle(): Promise<void> {
    while (this.flows.pending || Date.now() - this.lastRequest < IDLE_MS) await new Promise(resolve => setTimeout(resolve, 1000))
    this.close()
  }
}

/** The running page's address, when page.json names a live one that proves it is ours. */
export async function runningPage(vault: Store): Promise<string | null> {
  let data: Record<string, unknown> | null
  try { data = readPrivate(join(vault.root, 'page.json')) } catch { return null }
  const port = data?.port
  if (typeof port !== 'number' || port < 1024 || port > 65535 || typeof data!.key !== 'string') return null
  const origin = `http://127.0.0.1:${port}`
  // An unrelated process can reclaim an expired page's port: never send it the capability.
  const nonce = randomBytes(32).toString('hex')
  try {
    const answer = await fetch(origin + '/api/identity', { headers: { 'X-Harness-Probe': nonce }, redirect: 'manual', signal: AbortSignal.timeout(1000) })
    const proof = ((await answer.json()) as { proof?: unknown }).proof
    const expected = identityProof(data!.key as string, nonce)
    if (answer.status === 200 && typeof proof === 'string' && proof.length === expected.length && timingSafeEqual(Buffer.from(proof), Buffer.from(expected))) {
      return `${origin}/#${data!.key}`
    }
  } catch { /* Not ours, or not there. */ }
  return null
}

export function rememberPage(vault: Store, port: number, key: string): void {
  writePrivate(join(vault.root, 'page.json'), { port, key })
}

/** A newer launcher may already own page.json: remove only this instance's. */
export function forgetPage(vault: Store, port: number, key: string): void {
  locked(vault.root, () => {
    const data = readPrivate(join(vault.root, 'page.json'))
    if (data?.port === port && data?.key === key) writePrivate(join(vault.root, 'page.json'), {})
  })
}
