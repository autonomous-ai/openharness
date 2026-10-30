import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
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
