/**
 * Connected services, against fake services (testing/connectorServers.ts) in a throwaway home: never a
 * real provider, ~/.claude or ~/.codex.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeGateway, FakeService } from '../../testing/connectorServers.js'
import { bridgeKey, sync } from './agents.js'
import { createBridge } from './bridge.js'
import { CATALOG, services } from './catalog.js'
import { addCustom, cards, customCode, disconnect, finish, Flows, signInFor } from './connect.js'
import * as gateway from './gateway.js'
import { LocalSignIn } from './oauth.js'
import { forgetPage, PageServer, rememberPage, runningPage } from './page.js'
import { refresh } from './renew.js'
import { call, OFFICIAL_HOSTS } from './call.js'
import { connectionsCommand } from './command.js'
import { readPrivate, Store, writePrivate, type Token } from './store.js'
import { ICONS } from './generated/icons.js'

let home: string
let env: NodeJS.ProcessEnv
let vault: Store
const closers: (() => void)[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'connectors-'))
  env = { HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'), HARNESS_CONNECTIONS_PORT: '51793' }
  vault = new Store(join(home, '.harness', 'connections'), env)
  // Signed out of Harness whatever this computer is, unless a test signs in to a fake gateway.
  gateway.backend.signedIn = () => false
})
const signedInHere = gateway.backend.signedIn
afterEach(() => { gateway.backend.signedIn = signedInHere; while (closers.length) closers.pop()!(); rmSync(home, { recursive: true, force: true }) })

async function service(): Promise<FakeService> {
  const fake = await new FakeService().start()
  closers.push(() => fake.close())
  return fake
}

/** The browser: the service redirects it to this computer's 127.0.0.1 callback. */
async function signIn(fake: FakeService, forge = false): Promise<Token> {
  const flow = new LocalSignIn(vault, fake.base + '/mcp')
  let url = (await flow.prepare())!
  if (forge) url = url.replace('state=', 'state=forged')
  void fetch(url).then(answer => answer.text()).catch(() => undefined)
  return flow.wait()
}

describe('signing in from this computer (MCP OAuth)', () => {
  it('registers this computer once, uses PKCE and saves a renewable token', async () => {
    const fake = await service()
    finish(vault, 'linear', await signIn(fake), undefined, env)
    const saved = vault.token('linear')!
    expect(saved).toMatchObject({ source: 'dcr', refresh_token: 'refresh-1', mcp_entry: { url: fake.base + '/mcp', headers: { Authorization: 'Bearer access-1' } } })
    expect(fake.registered[0]).toMatchObject({ token_endpoint_auth_method: 'none' })
    expect(String((fake.registered[0].redirect_uris as string[])[0])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    for (const name of ['tokens.json', 'clients.json']) expect(statSync(join(vault.root, name)).mode & 0o777).toBe(0o600)
    await signIn(fake)
    expect(fake.registered).toHaveLength(1)
  })

  it('refuses a callback for another sign-in', async () => {
    const fake = await service()
    await expect(signIn(fake, true)).rejects.toThrow('could not be confirmed')
    expect(vault.tokens()).toEqual({})
  })
})

describe('the bridge', () => {
  let fake: FakeService
  let port: number
  let key: string

  beforeEach(async () => {
    fake = await service()
    finish(vault, 'linear', await signIn(fake), undefined, env)
    key = bridgeKey(vault)
    const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key) })
    await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
    port = (bridge.address() as { port: number }).port
    closers.push(() => { bridge.close(); bridge.closeAllConnections() })
  })

  function post(path: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: Record<string, unknown>, body: string }> {
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer agent-supplied', 'Content-Length': Buffer.byteLength(body), ...headers } }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(chunk)).on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString() }))
      })
      request.on('error', reject).end(body)
    })
  }

  it('gives the agent the service without the agent ever holding its token', async () => {
    const answer = await post(`/${key}/linear/mcp`)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body).result).toEqual({ ok: true })
    expect(answer.headers['mcp-session-id']).toBe('session-1')
    expect(fake.seen.at(-1)!.auth).toBe('Bearer access-1')
    const stream = await post(`/${key}/linear/mcp?stream=1`)
    expect(stream.body.match(/data:/g)).toHaveLength(3)
  })

  it('refuses strangers and web pages', async () => {
    const before = fake.seen.length
    expect((await post('/wrong-key/linear/mcp')).status).toBe(404)
    expect((await post(`/${key}/linear/mcp`, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(`/${key}/notion/mcp`)).status).toBe(404)
    expect(fake.seen).toHaveLength(before)
  })

  it('renews a token about to expire before the request, and once after an early revocation', async () => {
    vault.save('linear', { ...vault.token('linear')!, expires_at: Math.floor(Date.now() / 1000) + 60 })
    expect((await post(`/${key}/linear/mcp`)).status).toBe(200)
    expect(fake.seen.at(-1)!.auth).toBe('Bearer access-2')
    expect(vault.token('linear')).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2' })
    fake.access = 'access-7'
    fake.refresh = 'refresh-2'
    expect((await post(`/${key}/linear/mcp`)).status).toBe(200)
    expect(vault.token('linear')!.access_token).toBe('access-8')
  })

  it('turns a revoked grant into Reconnect, never the service\'s own sign-in challenge', async () => {
    vault.save('linear', { ...vault.token('linear')!, expires_at: Math.floor(Date.now() / 1000) + 60 })
    fake.revoked = true
    const answer = await post(`/${key}/linear/mcp`)
    expect(answer.status).toBe(401)
    expect(answer.headers['www-authenticate']).toBeUndefined()
    expect(JSON.parse(answer.body).error.message).toContain('connected again')
    expect(vault.status('linear', 'Linear', vault.token('linear')).state).toBe('reconnect')
  })
})

describe('agent configs', () => {
  it('gives each agent bridge addresses and keeps its own servers', () => {
    const claude = join(home, '.claude.json')
    writeFileSync(claude, JSON.stringify({ numStartups: 3, mcpServers: { notion: { command: 'my-notion' } } }))
    const codex = join(home, '.codex', 'config.toml')
    mkdirSync(join(home, '.codex'))
    writeFileSync(codex, 'model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')
    const opencode = join(home, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(opencode, JSON.stringify({ model: 'opencode/muse' }))
    for (const code of ['linear', 'notion']) vault.save(code, { access_token: 'secret-' + code, source: 'dcr', mcp_entry: { url: `https://mcp.${code}.example/mcp`, headers: { Authorization: 'Bearer secret-' + code } } })
    vault.save('github', { access_token: 'secret-github', source: 'gateway' })
    expect(sync(vault, env)).toEqual({ claude: ['linear'], codex: ['linear', 'notion'], opencode: ['linear', 'notion'] })
    const key = bridgeKey(vault)
    const data = JSON.parse(readFileSync(claude, 'utf8'))
    expect(data.numStartups).toBe(3)
    expect(data.mcpServers.notion).toEqual({ command: 'my-notion' })
    expect(data.mcpServers.linear).toEqual({ type: 'http', url: `http://127.0.0.1:51793/${key}/linear/mcp` })
    const toml = readFileSync(codex, 'utf8')
    expect(toml.startsWith('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')).toBe(true)
    expect(toml).toContain(`[mcp_servers.notion]\nurl = "http://127.0.0.1:51793/${key}/notion/mcp"`)
    expect(JSON.parse(readFileSync(opencode, 'utf8')).mcp.linear.type).toBe('remote')
    for (const path of [claude, codex, opencode]) expect(readFileSync(path, 'utf8')).not.toContain('secret-')
    vault.disconnect('linear')
    vault.disconnect('notion')
    sync(vault, env)
    expect(JSON.parse(readFileSync(claude, 'utf8')).mcpServers).toEqual({ notion: { command: 'my-notion' } })
    expect(readFileSync(codex, 'utf8')).toBe('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')
    expect(JSON.parse(readFileSync(opencode, 'utf8'))).toEqual({ model: 'opencode/muse' })
  })

  it('leaves a config it cannot read safely as it is', () => {
    const opencode = join(home, '.config', 'opencode', 'opencode.json')
    mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
    writeFileSync(opencode, '{ // a comment\n "model": "x" }')
    vault.save('linear', { access_token: 'a', mcp_entry: { url: 'https://mcp.example/mcp', headers: {} } })
    sync(vault, env)
    expect(readFileSync(opencode, 'utf8')).toBe('{ // a comment\n "model": "x" }')
  })
})

describe('the connector gateway', () => {
  const original = { ...gateway.backend }
  afterEach(() => { Object.assign(gateway.backend, original) })

  /** Signed in to Harness, the backend being a fake gateway. */
  async function signedIn(session = 'harness-session'): Promise<FakeGateway> {
    const fake = await new FakeGateway().start()
    closers.push(() => fake.close())
    Object.assign(gateway.backend, { signedIn: () => true, base: async () => fake.base, headers: async () => ({ authorization: `Bearer ${session}`, 'x-autonomous-env': 'prod' }) })
    return fake
  }

  it('signs in a service with no self-registration through the gateway, renews and disconnects it', async () => {
    const fake = await signedIn()
    expect(Object.keys(await gateway.available())).toContain('github')
    const flow = signInFor(vault, 'github', services(await gateway.available()))
    expect(await flow.prepare()).toMatch(/^https:\/\/github\.com\//)
    finish(vault, 'github', await flow.wait(), undefined, env)
    expect(vault.token('github')).toMatchObject({ source: 'gateway', account_name: 'octo', access_token: 'gho-fixture', transport: 'mcp' })
    expect((await refresh(vault, 'github', true)).access_token).toBe('gho-renewed')
    await disconnect(vault, 'github', env)
    expect(fake.calls.map(([path]) => path)).toEqual(['connectors/start', 'connectors/poll', 'connectors/poll', 'connectors/refresh', 'connectors/disconnect'])
    expect(vault.token('github')).toBeUndefined()
  }, 15_000)

  it('a grant the gateway no longer holds asks for connecting again; a lapsed Harness sign-in says so', async () => {
    const fake = await signedIn()
    const due = { access_token: 'gho-old', refresh: true, source: 'gateway' as const, expires_at: Math.floor(Date.now() / 1000) + 60 }
    vault.save('github', due)
    fake.fail = { status: 404, code: 'NOT_CONNECTED', message: 'This service is not connected. Connect it again.' }
    await expect(refresh(vault, 'github')).rejects.toThrow('connected again')
    expect(vault.token('github')).toMatchObject({ needs_reconnect: true })
    vault.save('github', due)
    fake.fail = { status: 503, code: 'CONNECTORS_FAILED', message: 'Connections are unavailable. Try again.' }
    await expect(refresh(vault, 'github')).rejects.toThrow('Connections are unavailable. Try again.')
    expect(vault.token('github')!.needs_reconnect).toBeUndefined()
    fake.fail = { status: 502, code: '', message: '' }
    await expect(gateway.call('connectors/refresh', {})).rejects.toThrow('Harness answered 502. Try again shortly.')
    await signedIn('expired')
    await expect(refresh(vault, 'github')).rejects.toThrow('Your Harness sign-in has expired')
    expect(await gateway.available()).toEqual({})
    Object.assign(gateway.backend, { headers: async () => { throw new Error('Not signed in. Run `harness login`.') } })
    await expect(gateway.call('connectors')).rejects.toThrow('Could not reach Harness')
    Object.assign(gateway.backend, { signedIn: () => false })
    await expect(new gateway.GatewaySignIn('github').prepare()).rejects.toThrow('Sign in to Harness first')
  })

  it('refuses an answer that is not the gateway\'s', async () => {
    const odd = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(request.url === '/api/list' ? '{"success":true,"data":[]}' : 'not json'))
    await new Promise<void>(resolve => odd.listen(0, '127.0.0.1', resolve))
    closers.push(() => odd.close())
    Object.assign(gateway.backend, { signedIn: () => true, base: async () => `http://127.0.0.1:${(odd.address() as { port: number }).port}`, headers: async () => ({}) })
    await expect(gateway.call('connectors')).rejects.toThrow('Harness sent an unexpected answer.')
    await expect(gateway.call('list')).rejects.toThrow('Harness sent an unexpected answer.')
  })

  it('signed out, lists the gateway services waiting for harness login; signed in, follows the gateway', async () => {
    Object.assign(gateway.backend, { signedIn: () => false })
    let page = cards(vault, {})
    const byCode = (list: typeof page.connections) => Object.fromEntries(list.map(card => [card.connector, card]))
    expect(page.signed_in).toBe(false)
    for (const code of ['github', 'gmail', 'google_calendar', 'google_drive']) expect(byCode(page.connections)[code].reason).toBe('Needs harness login')
    expect(byCode(page.connections).linear).toMatchObject({ auth: 'dcr', reason: '' })
    await signedIn()
    const offered = await gateway.available()
    page = cards(vault, offered)
    expect(page.signed_in).toBe(true)
    const cardsNow = byCode(page.connections)
    expect(cardsNow.github.auth).toBe('app')
    expect(cardsNow.linear.auth).toBe('dcr')
    expect(cardsNow.newsvc).toMatchObject({ name: 'New Service', auth: 'dcr' })
    expect(cardsNow.slack).toBeUndefined()
    expect(cardsNow['manual-only']).toBeUndefined()
    expect(signInFor(vault, 'newsvc', services(offered))).toBeInstanceOf(LocalSignIn)
    expect(signInFor(vault, 'github', services(offered))).toBeInstanceOf(gateway.GatewaySignIn)
  })
})

describe('storage', () => {
  it('reads a connection saved under an older code under Grid\'s', () => {
    vault.save('apollo', { access_token: 'a', mcp_entry: { url: 'https://mcp.apollo.io/mcp', headers: {} } })
    expect(vault.token('apollo_io')!.access_token).toBe('a')
    vault.save('apollo_io', { access_token: 'b', mcp_entry: { url: 'https://mcp.apollo.io/mcp', headers: {} } })
    expect(Object.keys(readPrivate(join(vault.root, 'tokens.json'))!)).toEqual(['apollo_io'])
    vault.disconnect('apollo_io')
    expect(vault.tokens()).toEqual({})
  })

  it('refuses broad permissions, a symlinked store and bad codes', () => {
    vault.save('linear', { access_token: 'a', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    chmodSync(join(vault.root, 'tokens.json'), 0o644)
    expect(() => vault.tokens()).toThrow()
    chmodSync(join(vault.root, 'tokens.json'), 0o600)
    const link = join(home, 'link')
    symlinkSync(vault.root, link)
    expect(() => new Store(link, env).tokens()).toThrow()
    for (const code of ['../outside', 'UPPER', '']) expect(() => vault.save(code, { access_token: 'a' })).toThrow()
  })

  it('moves Harness OS 0.1.2\'s connections into the CLI\'s store once', () => {
    const legacy = join(home, '.local', 'share', 'harness-os', 'connections')
    writePrivate(join(legacy, 'tokens.json'), { notion: { access_token: 'old', mcp_entry: { url: 'https://mcp.notion.com/mcp', headers: {} } } })
    const moved = new Store(undefined, { ...env, HARNESS_CONNECTIONS_DIR: join(home, 'cli-store') })
    expect(moved.token('notion')!.access_token).toBe('old')
  })
})

describe('the page', () => {
  let page: PageServer
  beforeEach(async () => { page = new PageServer(vault, env); await page.listen(); closers.push(() => page.close()) })
  const auth = () => ({ 'X-Harness-Connections': page.key, Origin: page.origin, 'Content-Type': 'application/json' })
  const ask = (path: string, init: RequestInit = {}) => fetch(page.origin + path, init)

  it('serves nothing to a stranger or another site, even on loopback', async () => {
    expect((await ask('/api/connections')).status).toBe(403)
    expect((await ask('/api/connections', { headers: { ...auth(), 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    expect((await ask('/api/connect', { method: 'POST', headers: { ...auth(), Origin: 'https://evil.example' }, body: '{"connector":"linear"}' })).status).toBe(403)
    expect((await ask('/icons/../store.ts')).status).toBe(404)
    expect((await ask('/')).headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('connects in the browser, then lists and disconnects with no token in any answer', async () => {
    const fake = await service()
    const original = CATALOG.linear.mcp_url
    CATALOG.linear.mcp_url = fake.base + '/mcp'
    try {
      const started = await (await ask('/api/connect', { method: 'POST', headers: auth(), body: '{"connector":"linear"}' })).json() as { flow: string, authorize_url: string }
      await (await fetch(started.authorize_url)).text()
      let state = 'pending'
      for (let n = 0; n < 100 && state === 'pending'; n++) {
        await new Promise(resolve => setTimeout(resolve, 50))
        state = (await (await ask('/api/flows/' + started.flow, { headers: auth() })).json() as { state: string }).state
      }
      expect(state).toBe('connected')
    } finally { CATALOG.linear.mcp_url = original }
    const listed = await (await ask('/api/connections', { headers: auth() })).text()
    expect(listed).not.toContain('access-1')
    expect(JSON.parse(listed).connections.find((card: { connector: string }) => card.connector === 'linear')).toMatchObject({ state: 'connected', tools: true, icon: '/icons/linear' })
    expect((await ask('/icons/linear')).headers.get('content-type')).toMatch(/^image\//)
    await ask('/api/disconnect', { method: 'POST', headers: auth(), body: '{"connector":"linear"}' })
    expect(vault.token('linear')).toBeUndefined()
  })

  it('adds a custom server with its own headers, and refuses bad ones', async () => {
    const added = await (await ask('/api/custom', { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'My Tools', url: 'https://tools.example/mcp', headers: { Authorization: 'Bearer pat' } }) })).json()
    expect(added).toEqual({ connector: 'my-tools', state: 'connected' })
    for (const bad of [{ name: 'x', url: 'http://tools.example/mcp' }, { name: '', url: 'https://t.example' }, { name: 'x', url: 'https://t.example', headers: { 'Bad Header': 'v' } }]) {
      expect((await ask('/api/custom', { method: 'POST', headers: auth(), body: JSON.stringify(bad) })).status).toBe(400)
    }
  })

  it('is reused only when it proves it is ours, and forgotten only by itself', async () => {
    rememberPage(vault, Number(new URL(page.origin).port), page.key)
    expect(await runningPage(vault)).toBe(`${page.origin}/#${page.key}`)
    writePrivate(join(vault.root, 'page.json'), { port: Number(new URL(page.origin).port), key: 'not-this-servers' })
    expect(await runningPage(vault)).toBeNull()
    forgetPage(vault, Number(new URL(page.origin).port), 'not-this-servers')
    expect(await runningPage(vault)).toBeNull()
  })
})

describe('REST calls and the command', () => {
  it('only sends a gateway token to its official https host', async () => {
    const io = { out: () => undefined, err: () => undefined }
    vault.save('github', { access_token: 'gho', source: 'gateway' })
    await expect(call(vault, 'github', 'GET', 'https://evil.example/x', [], io, env)).rejects.toMatchObject({ code: 4 })
    await expect(call(vault, 'github', 'GET', 'http://api.github.com/user', [], io, env)).rejects.toMatchObject({ code: 4 })
    await expect(call(vault, 'github', 'GET', 'https://api.github.com:8443/user', [], io, env)).rejects.toMatchObject({ code: 4 })
    await expect(call(vault, 'linear', 'GET', 'https://api.linear.app/x', [], io, env)).rejects.toMatchObject({ code: 4 })
    vault.save('gmail', { access_token: 'x', source: 'dcr', mcp_entry: { url: 'https://mcp.example/mcp', headers: {} } })
    await expect(call(vault, 'gmail', 'GET', 'https://gmail.googleapis.com/x', [], io, env)).rejects.toMatchObject({ code: 3 })
    expect(Object.keys(OFFICIAL_HOSTS)).not.toContain('microsoft_365')
  })

  it('lists connections without secrets', async () => {
    vault.save('linear', { access_token: 'secret', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} }, account_name: 'me' })
    let out = ''
    expect(await connectionsCommand(['list', '--json'], { out: text => { out += text }, err: () => undefined }, vault)).toBe(0)
    expect(JSON.parse(out)[0]).toMatchObject({ connector: 'linear', state: 'connected', account: 'me' })
    expect(out).not.toContain('secret')
  })

  it('names a custom server by what it is called, never over another', () => {
    expect(customCode('My Tools', new Set())).toBe('my-tools')
    expect(customCode('Linear', new Set(['linear']))).toBe('custom-linear')
  })

  it('bundles an icon and a real description for every service', () => {
    expect(Object.keys(CATALOG).filter(code => !ICONS[code])).toEqual([])
    expect(Object.values(CATALOG).filter(item => item.description.length < 20 || /abcd|lorem|placeholder|\bdescription\b/i.test(item.description))).toEqual([])
  })

  it('keeps a known service\'s own description over the gateway\'s', () => {
    const items = services({ notion: { code: 'notion', auth_type: 'app', label: 'Notion', description: 'Notion description abcd', mcp_url: 'https://mcp.notion.com/mcp' },
      fresh: { code: 'fresh', auth_type: 'dcr', label: 'Fresh', description: 'A service Harness does not know yet.', mcp_url: 'https://mcp.fresh.example/mcp' } })
    expect(items.notion.description).toBe(CATALOG.notion.description)
    expect(items.fresh.description).toBe('A service Harness does not know yet.')
  })

  it('adds a custom server that asks for sign-in through the same flow', async () => {
    const fake = await service()
    const flows = new Flows(vault, env)
    const started = await addCustom(vault, flows, { name: 'Fixture', url: fake.base + '/mcp' }, env) as { flow: string, authorize_url: string }
    await (await fetch(started.authorize_url)).text()
    for (let n = 0; n < 100 && flows.get(started.flow).state === 'pending'; n++) await new Promise(resolve => setTimeout(resolve, 50))
    expect(vault.token('fixture')).toMatchObject({ source: 'custom', label: 'Fixture' })
    await disconnect(vault, 'fixture', env)
    expect(vault.token('fixture')).toBeUndefined()
  })
})
