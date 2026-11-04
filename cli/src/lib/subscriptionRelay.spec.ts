import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { OwnerCredential, OwnerSubscriptions, SubscriptionProvider } from './ownerSubscriptions.js'
import {
  CLAUDE_OAUTH_BETA,
  claudeRelayEnv,
  codexRelayArgs,
  codexRelayEnv,
  startSubscriptionRelay,
  type SubscriptionRelay,
} from './subscriptionRelay.js'

const OWNER_CLAUDE = 'sk-ant-oat01-OWNER-SECRET'
const OWNER_CLAUDE_FRESH = 'sk-ant-oat01-OWNER-FRESH'
const OWNER_CODEX = 'codex-OWNER-SECRET'

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: string }

/** A vendor on a local port: records every request and answers with [answer]. */
async function vendor(answer: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void | Promise<void>) {
  const seen: Seen[] = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const entry = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() }
    seen.push(entry)
    await answer(req, res, entry)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { seen, url, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()) }) }
}

/** The owner's sign-ins as the relay sees them, and how often it was asked to refresh. */
function owner(initial: Partial<Record<SubscriptionProvider, OwnerCredential | null>>) {
  const current = { claude: null, codex: null, ...initial } as Record<SubscriptionProvider, OwnerCredential | null>
  const refreshed: Array<{ provider: SubscriptionProvider; stale: string | null }> = []
  let next: Partial<Record<SubscriptionProvider, OwnerCredential | null>> = {}
  const subscriptions: OwnerSubscriptions = {
    read: async (provider) => current[provider],
    refresh: async (provider, stale) => {
      refreshed.push({ provider, stale: stale?.accessToken ?? null })
      if (provider in next) current[provider] = next[provider] ?? null
      return current[provider]
    },
  }
  return { subscriptions, refreshed, willRefreshTo: (value: typeof next) => { next = value } }
}

const claude = (accessToken: string, expiresAt: number | null = null): OwnerCredential =>
  ({ provider: 'claude', accessToken, expiresAt, accountId: null })
const codex = (accessToken: string, accountId = 'acct-owner'): OwnerCredential =>
  ({ provider: 'codex', accessToken, expiresAt: null, accountId })

let relay: SubscriptionRelay
let upstream: Awaited<ReturnType<typeof vendor>>
let lines: string[]

beforeEach(() => { lines = [] })
afterEach(async () => {
  await relay?.close()
  await upstream?.close()
})

async function start(answer: Parameters<typeof vendor>[0], subscriptions: OwnerSubscriptions, now = () => 1_000_000) {
  upstream = await vendor(answer)
  relay = await startSubscriptionRelay({
    owner: subscriptions,
    upstream: { claude: upstream.url, codex: `${upstream.url}/backend-api/codex` },
    now,
    log: (line) => lines.push(line),
  })
}

const ok = (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }

describe('the guest token', () => {
  it('is required, must be one minted here, and stops working when the guest is revoked', async () => {
    await start(ok, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const post = (headers: Record<string, string>) => fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers, body: '{}' })
    expect((await post({})).status).toBe(401)
    expect((await post({ authorization: 'Bearer not-a-token' })).status).toBe(401)
    const token = relay.mintToken('Kim@Acme.io')
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(200)
    // Claude Code with an API key sends it as x-api-key; that works too.
    expect((await post({ 'x-api-key': token })).status).toBe(200)
    relay.revoke('kim@acme.io')
    expect((await post({ authorization: `Bearer ${token}` })).status).toBe(401)
    expect((await fetch(`${relay.url}/elsewhere`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404)
    expect(upstream.seen).toHaveLength(2)
    // Each refusal is in the owner's log too.
    expect(lines.filter((line) => line.includes('→ 401 · no guest'))).toHaveLength(3)
  })

  it('listens on loopback only', async () => {
    await start(ok, owner({}).subscriptions)
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })
})

describe('a relay started again on its own port', () => {
  const start = (port?: number) => startSubscriptionRelay({ owner: owner({}).subscriptions, ...(port ? { port } : {}) })
  const answers = async (relay: SubscriptionRelay, token: string) => (await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })).status

  it('listens on the port it is given, and refuses one that is taken', async () => {
    const first = await start()
    const taken = await start(first.port).then(() => null, (error: NodeJS.ErrnoException) => error.code)
    expect(taken).toBe('EADDRINUSE')
    const { port } = first
    await first.close()
    const again = await start(port)
    expect(again.url).toBe(`http://127.0.0.1:${port}`)
    await again.close()
  })

  it('takes a token back as its own, refuses any other, and a revoke cuts it', async () => {
    const relay = await start()
    relay.adoptToken('Team@Example.com', 'kept-token-kept-token-kept-token')
    expect(await answers(relay, 'kept-token-kept-token-kept-token')).not.toBe(401)
    expect(await answers(relay, 'other-token-other-token-other-tok')).toBe(401)
    relay.revoke('team@example.com')
    expect(await answers(relay, 'kept-token-kept-token-kept-token')).toBe(401)
    await relay.close()
  })
})

describe('Claude', () => {
  it('goes upstream with the owner\'s bearer and the OAuth beta, and never the guest\'s token', async () => {
    await start(ok, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const response = await fetch(`${relay.url}/claude/v1/messages?beta=true`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-api-key': token,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
        'content-type': 'application/json',
      },
      body: '{"model":"claude-sonnet-4-5","messages":[]}',
    })
    expect(await response.json()).toEqual({ ok: true })
    const [request] = upstream.seen
    expect(request!.method).toBe('POST')
    expect(request!.url).toBe('/v1/messages?beta=true')
    expect(request!.body).toBe('{"model":"claude-sonnet-4-5","messages":[]}')
    expect(request!.headers.authorization).toBe(`Bearer ${OWNER_CLAUDE}`)
    expect(request!.headers['x-api-key']).toBeUndefined()
    expect(request!.headers['anthropic-version']).toBe('2023-06-01')
    expect(request!.headers['anthropic-beta']).toBe(`claude-code-20250219,interleaved-thinking-2025-05-14,${CLAUDE_OAUTH_BETA}`)
    expect(JSON.stringify(request!.headers)).not.toContain(token)
  })

  it('adds the beta once, even when the guest already sent it', async () => {
    await start(ok, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'anthropic-beta': CLAUDE_OAUTH_BETA }, body: '{}' })
    expect(upstream.seen[0]!.headers['anthropic-beta']).toBe(CLAUDE_OAUTH_BETA)
  })

  it('streams the answer chunk by chunk, as the vendor sends it', async () => {
    let release!: () => void
    const second = new Promise<void>((resolve) => { release = resolve })
    await start(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {"n":1}\n\n')
      await second // the relay must deliver the first event before the vendor sends the second
      res.end('event: message_stop\ndata: {"n":2}\n\n')
    }, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const response = await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain('message_start')
    release()
    let rest = ''
    for (;;) { const { done, value } = await reader.read(); if (done) break; rest += decoder.decode(value) }
    expect(rest).toContain('message_stop')
  })

  it('refreshes an expired token before spending it', async () => {
    const o = owner({ claude: claude(OWNER_CLAUDE, 1_000) })
    o.willRefreshTo({ claude: claude(OWNER_CLAUDE_FRESH, 9_999_999) })
    await start(ok, o.subscriptions, () => 1_000_000)
    const token = relay.mintToken('kim@acme.io')
    await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(o.refreshed).toEqual([{ provider: 'claude', stale: OWNER_CLAUDE }])
    expect(upstream.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${OWNER_CLAUDE_FRESH}`])
  })

  it('refreshes once on a 401 and retries, then passes a second 401 through', async () => {
    const o = owner({ claude: claude(OWNER_CLAUDE) })
    o.willRefreshTo({ claude: claude(OWNER_CLAUDE_FRESH) })
    await start((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"nope"}') }, o.subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const response = await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"x":1}' })
    expect(response.status).toBe(401)
    expect(o.refreshed).toHaveLength(1)
    expect(upstream.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${OWNER_CLAUDE}`, `Bearer ${OWNER_CLAUDE_FRESH}`])
    expect(upstream.seen.map((s) => s.body)).toEqual(['{"x":1}', '{"x":1}'])
  })

  it('says the owner is not signed in rather than forwarding without a token', async () => {
    await start(ok, owner({ claude: null }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const response = await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(response.status).toBe(503)
    expect(JSON.stringify(await response.json())).toContain('not signed in to Claude')
    expect(upstream.seen).toHaveLength(0)
    // The owner reads why a guest's harness keeps retrying: their own sign-in.
    expect(lines).toEqual([expect.stringMatching(/^claude POST \/claude\/v1\/messages → 503 · owner not signed in · guest [0-9a-f]+$/)])
  })
})

describe('Codex', () => {
  it('goes to the Codex backend with the owner\'s token and account, whatever account the guest named', async () => {
    await start(ok, owner({ codex: codex(OWNER_CODEX, 'acct-owner') }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    await fetch(`${relay.url}/codex/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'chatgpt-account-id': 'acct-guest', 'content-type': 'application/json' },
      body: '{"model":"gpt-5-codex","stream":true}',
    })
    const [request] = upstream.seen
    expect(request!.url).toBe('/backend-api/codex/responses')
    expect(request!.headers.authorization).toBe(`Bearer ${OWNER_CODEX}`)
    expect(request!.headers['chatgpt-account-id']).toBe('acct-owner')
    expect(request!.headers['anthropic-beta']).toBeUndefined()
  })
})

/** A request sent with its path exactly as given, which `fetch` would normalize first. */
function raw(method: string, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: relay.port, method, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end(method === 'GET' || method === 'HEAD' ? undefined : '{}')
  })
}

describe('the engine calls, and nothing else', () => {
  const both = () => owner({ claude: claude(OWNER_CLAUDE), codex: codex(OWNER_CODEX) }).subscriptions

  it('forwards each call Claude Code and Codex make', async () => {
    await start(ok, both())
    const token = relay.mintToken('kim@acme.io')
    const calls: Array<[string, string, string]> = [
      ['POST', '/claude/v1/messages?beta=true', '/v1/messages?beta=true'],
      ['POST', '/claude/v1/messages/count_tokens?beta=true', '/v1/messages/count_tokens?beta=true'],
      ['GET', '/claude/v1/models', '/v1/models'],
      ['POST', '/codex/responses', '/backend-api/codex/responses'],
      ['GET', '/codex/models?client_version=0.165.0', '/backend-api/codex/models?client_version=0.165.0'],
    ]
    for (const [method, path] of calls) expect((await raw(method, path, token)).status, `${method} ${path}`).toBe(200)
    expect(upstream.seen.map((s) => `${s.method} ${s.url}`)).toEqual(calls.map(([method, , sent]) => `${method} ${sent}`))
  })

  it('refuses an account endpoint, whatever the method, and never reaches the vendor', async () => {
    await start(ok, both())
    const token = relay.mintToken('kim@acme.io')
    for (const [method, path] of [
      ['POST', '/claude/v1/organizations/api_keys'],
      ['GET', '/claude/api/oauth/profile'],
      ['POST', '/claude/api/oauth/claude_cli/create_api_key'],
      ['GET', '/claude/v1/files'],
      ['POST', '/claude/v1/messages/batches'],
      ['GET', '/codex/accounts/check'],
      ['GET', '/codex/wham/usage'],
      ['POST', '/codex/responses/compact/../../../accounts'],
      ['GET', '/claude/'],
      ['GET', '/codex'],
    ] as const) {
      const answer = await raw(method, path, token)
      expect(answer.status, `${method} ${path}`).toBe(404)
      expect(answer.body).toContain('harness_relay_error')
    }
    expect(upstream.seen).toEqual([])
  })

  it('refuses encoded separators, dot segments and doubled slashes, as sent', async () => {
    await start(ok, both())
    const token = relay.mintToken('kim@acme.io')
    for (const path of [
      '/claude/v1/messages/..%2f..%2fv1%2forganizations',
      '/claude/v1/messages%2fcount_tokens',
      '/claude/v1/%2e%2e/api/oauth/profile',
      '/claude/v1/messages%2F..%2F..%2Fapi',
      '/claude/v1/messages%5c..%5c..%5capi',
      '/claude/v1/messages\\..\\api',
      '/claude/v1/./messages',
      '/claude/v1/x/../messages',
      '/claude//v1/messages',
      '/claude/v1/messages/',
      '/claude/v1/Messages',
      '/codex/responses/..%2f..%2faccounts',
      '/codex/%72esponses',
      'http://chatgpt.com/codex/responses',
    ]) expect((await raw('POST', path, token)).status, path).toBe(404)
    expect(upstream.seen).toEqual([])
  })

  it('refuses another method on an engine path', async () => {
    await start(ok, both())
    const token = relay.mintToken('kim@acme.io')
    for (const [method, path] of [
      ['GET', '/claude/v1/messages'],
      ['DELETE', '/claude/v1/messages'],
      ['PUT', '/claude/v1/messages/count_tokens'],
      ['POST', '/claude/v1/models'],
      ['GET', '/codex/responses'],
      ['DELETE', '/codex/models'],
      ['HEAD', '/codex/models'],
      ['OPTIONS', '/claude/v1/messages'],
    ] as const) expect((await raw(method, path, token)).status, `${method} ${path}`).toBe(405)
    expect(upstream.seen).toEqual([])
  })

  it('tells the owner what was refused, without the guest\'s path or token', async () => {
    await start(ok, both())
    const token = relay.mintToken('kim@acme.io')
    await raw('POST', '/claude/v1/organizations/secret-path', token)
    await raw('GET', '/claude/v1/messages', token)
    await raw('POST', '/claude/v1/organizations/secret-path', 'not-a-token')
    expect(lines).toEqual([
      expect.stringMatching(/^claude POST → 404 · not an engine call · guest [0-9a-f]{8}$/),
      expect.stringMatching(/^claude GET \/claude\/v1\/messages → 405 · not an engine call · guest [0-9a-f]{8}$/),
      'claude POST → 401 · no guest',
    ])
    for (const line of lines) expect(line).not.toContain('secret-path')
  })
})

describe('a revoked guest', () => {
  it('loses the answer it is streaming', async () => {
    let started!: () => void
    const streaming = new Promise<void>((resolve) => { started = resolve })
    await start(async (req, res) => {
      if (req.method === 'GET') return ok(req, res)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: message_start\ndata: {}\n\n')
      started()
      // The vendor keeps the stream open; only the revoke can end it.
      await new Promise<void>((resolve) => res.on('close', () => resolve()))
    }, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const other = relay.mintToken('lee@acme.io')
    const response = await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('message_start')
    await streaming
    relay.revoke('KIM@acme.io')
    const rest = await (async () => { try { for (;;) if ((await reader.read()).done) return 'ended' } catch { return 'cut' } })()
    // Cut, not a clean end: the guest cannot mistake a revoked answer for a whole one.
    expect(rest).toBe('cut')
    // Another guest is untouched.
    expect((await raw('GET', '/claude/v1/models', other)).status).toBe(200)
  })

  it('gets 401, and nothing is sent, when revoked while its request waits on the owner\'s sign-in', async () => {
    let signIn!: (credential: OwnerCredential) => void
    let asked!: () => void
    const reading = new Promise<void>((resolve) => { asked = resolve })
    const subscriptions: OwnerSubscriptions = {
      read: () => { asked(); return new Promise((resolve) => { signIn = resolve }) },
      refresh: async () => null,
    }
    await start(ok, subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const pending = fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    await reading
    relay.revoke('kim@acme.io')
    signIn(claude(OWNER_CLAUDE))
    const answer = await pending
    expect(answer.status).toBe(401)
    expect(upstream.seen).toEqual([])
  })
  it('gets 401, not a vendor error, when revoked while the vendor has not answered yet', async () => {
    let asked!: () => void
    const waiting = new Promise<void>((resolve) => { asked = resolve })
    await start(async (_req, res) => {
      asked()
      await new Promise<void>((resolve) => res.on('close', () => resolve()))
    }, owner({ claude: claude(OWNER_CLAUDE) }).subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const pending = fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    await waiting
    relay.revoke('kim@acme.io')
    expect((await pending).status).toBe(401)
  })

  it('is not retried with a fresh sign-in when revoked during the refresh after a 401', async () => {
    let refreshed!: (credential: OwnerCredential) => void
    let asked!: () => void
    const refreshing = new Promise<void>((resolve) => { asked = resolve })
    const subscriptions: OwnerSubscriptions = {
      read: async () => claude(OWNER_CLAUDE),
      refresh: () => { asked(); return new Promise((resolve) => { refreshed = resolve }) },
    }
    await start((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }, subscriptions)
    const token = relay.mintToken('kim@acme.io')
    const pending = fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    await refreshing
    relay.revoke('kim@acme.io')
    refreshed(claude(OWNER_CLAUDE_FRESH))
    expect((await pending).status).toBe(401)
    expect(upstream.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${OWNER_CLAUDE}`])
  })
})

describe('secrets', () => {
  it('never put a token in a log line or in an error a guest sees', async () => {
    const o = owner({ claude: claude(OWNER_CLAUDE) })
    upstream = await vendor(ok)
    relay = await startSubscriptionRelay({
      owner: o.subscriptions,
      // A network failure whose message carries everything it was given.
      fetchImpl: (async (url: string, init: RequestInit) => { throw new Error(`failed ${url} ${JSON.stringify(init.headers)}`) }) as unknown as typeof fetch,
      log: (line) => lines.push(line),
    })
    const token = relay.mintToken('kim@acme.io')
    const failed = await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' })
    expect(failed.status).toBe(502)
    const text = await failed.text()
    expect(text).not.toContain(OWNER_CLAUDE)
    expect(text).not.toContain(token)
    await relay.close()

    await start(ok, o.subscriptions)
    const second = relay.mintToken('kim@acme.io')
    await fetch(`${relay.url}/claude/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${second}` }, body: '{}' })
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).not.toContain(OWNER_CLAUDE)
      expect(line).not.toContain(second)
      expect(line).not.toContain('kim@acme.io')
    }
  })
})

describe('the launch contract', () => {
  it('points Claude Code at the relay with the bearer variable', () => {
    expect(claudeRelayEnv('http://127.0.0.1:4242/', 'tok')).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:4242/claude', ANTHROPIC_AUTH_TOKEN: 'tok' })
  })

  it('points Codex at the relay through its own provider, the token in the environment, web search kept', () => {
    const args = codexRelayArgs('http://127.0.0.1:4242')
    expect(args).toEqual([
      '-c', 'model_provider="harness_owner"',
      '-c', 'model_providers.harness_owner.name="Owner subscription"',
      '-c', 'model_providers.harness_owner.base_url="http://127.0.0.1:4242/codex"',
      '-c', 'model_providers.harness_owner.env_key="HARNESS_RELAY_TOKEN"',
      '-c', 'model_providers.harness_owner.wire_api="responses"',
      '-c', 'model_providers.harness_owner.supports_websockets=false',
    ])
    expect(args.join(' ')).not.toContain('web_search')
    expect(codexRelayEnv('tok')).toEqual({ HARNESS_RELAY_TOKEN: 'tok' })
  })
})
