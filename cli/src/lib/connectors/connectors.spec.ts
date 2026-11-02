/**
 * Connected services, against fake services (testing/connectorServers.ts) in a throwaway home: never a
 * real provider, ~/.claude or ~/.codex.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedNodePath } from '../nodeRuntime.js'
import { FakeGateway, FakeService } from '../../testing/connectorServers.js'
import { bridgeKey, harnessKey, resetProfileCache, sync, syncProfileHome } from './agents.js'
import { createBridge } from './bridge.js'
import { CATALOG, services } from './catalog.js'
import { addApiKey, addCustom, cards, customCode, disconnect, finish, Flows, signInFor } from './connect.js'
import * as gateway from './gateway.js'
import { LocalSignIn, probe } from './oauth.js'
import { forgetPage, PAGE_BUILD, PageServer, rememberPage, runningPage } from './page.js'
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

  it('signs in to a server that answers its handshake to anyone but says it is protected', async () => {
    const fake = await service()
    fake.openHandshake = true
    expect(await probe(fake.base + '/mcp')).toMatchObject({ kind: 'oauth' })
    finish(vault, 'fo', await signIn(fake), undefined, env)
    expect(vault.token('fo')).toMatchObject({ source: 'dcr', mcp_entry: { headers: { Authorization: 'Bearer access-1' } } })
  })

  it('refuses a callback for another sign-in', async () => {
    const fake = await service()
    await expect(signIn(fake, true)).rejects.toThrow('could not be confirmed')
    expect(vault.tokens()).toEqual({})
  })

  it('finishes with the redirect a phone caught in its own browser, and only that address', async () => {
    const fake = await service()
    const flows = new Flows(vault, env)
    const { flow, authorize_url } = await flows.start('linear', new LocalSignIn(vault, fake.base + '/mcp'))
    // The phone's browser follows the service to this computer's 127.0.0.1 address, which it cannot reach.
    const caught = (await fetch(authorize_url!, { redirect: 'manual' })).headers.get('location')!
    const port = Number(new URL(caught).port)
    expect(() => flows.deliver(flow, caught.replace(`:${port}/`, `:${port + 1}/`))).toThrow('not the sign-in address')
    expect(() => flows.deliver(flow, caught.replace('/callback', '/elsewhere'))).toThrow('not the sign-in address')
    expect(() => flows.deliver('gone', caught)).toThrow('ended')
    expect(flows.deliver(flow, caught)).toEqual({ connector: 'linear', state: 'pending' })
    await vi.waitFor(() => expect(flows.get(flow).state).toBe('connected'))
    expect(vault.token('linear')).toMatchObject({ source: 'dcr', mcp_entry: { headers: { Authorization: 'Bearer access-1' } } })
    expect(() => flows.deliver(flow, caught)).toThrow('ended')
  })
})

describe('a bridge key another account heard', () => {
  it('opens nothing: the same answer as an unknown key, and the service is never called', async () => {
    const vault = new Store(mkdtempSync(join(tmpdir(), 'bridge-peer-')), {})
    const key = bridgeKey(vault)
    const asked: unknown[] = []
    const bridge = createBridge(vault, { key: () => key, peerAccount: async (socket) => { asked.push(socket); return false } })
    await new Promise<void>(resolve => { bridge.listen(0, '127.0.0.1', resolve) })
    try {
      const port = (bridge.address() as AddressInfo).port
      const heard = await fetch(`http://127.0.0.1:${port}/${key}/linear/mcp`, { method: 'POST', body: '{}' })
      const unknown = await fetch(`http://127.0.0.1:${port}/wrong/linear/mcp`, { method: 'POST', body: '{}' })
      expect(heard.status).toBe(404)
      expect(await heard.text()).toBe(await unknown.text())
      // Only a request with the right key asks who is calling: a stranger cannot make the bridge run lsof.
      expect(asked).toHaveLength(1)
    } finally { bridge.closeAllConnections(); bridge.close(); rmSync(vault.root, { recursive: true, force: true }) }
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

describe('key-only connections for the cloud agents', () => {
  let port: number
  let key: string
  let agentKey: string
  const seen: { method: string, url: string, auth: string, body: string }[] = []
  let status = 200
  let api: string

  beforeEach(async () => {
    seen.length = 0
    status = 200
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk)).on('end', () => {
        seen.push({ method: request.method!, url: request.url!, auth: String(request.headers.authorization), body: Buffer.concat(chunks).toString() })
        response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    api = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    closers.push(() => { upstream.close(); upstream.closeAllConnections() })
    key = harnessKey(vault)
    agentKey = bridgeKey(vault)
    const bridge = createBridge(vault, { key: () => String(vault.file('bridge.json').key), harnessKey: () => String(vault.file('harness-key.json').key) })
    await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
    port = (bridge.address() as { port: number }).port
    closers.push(() => { bridge.close(); bridge.closeAllConnections() })
  })

  const send = (method: string, path: string, body?: string) => fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: body ? { 'Content-Type': 'application/json' } : {} })

  it('saves a key only for Harness, never in an agent\'s MCP configuration', async () => {
    expect(addApiKey(vault, { name: 'Devin', url: `${api}/ignored/path?q=1`, key: 'cog_secret' }, env)).toEqual({ connector: 'devin', state: 'connected' })
    expect(vault.token('devin')).toMatchObject({ access_token: 'cog_secret', api_entry: { origin: api }, transport: 'none', source: 'custom', label: 'Devin' })
    expect(JSON.stringify(sync(vault, env))).not.toContain('devin')
    expect(() => addApiKey(vault, { name: 'Devin', url: api, key: ' ' }, env)).toThrow('Paste the API key.')
    expect(() => addApiKey(vault, { name: '', url: api, key: 'k' }, env)).toThrow('Give the service a name.')
    expect(() => addApiKey(vault, { name: 'Bad', url: 'http://example.com', key: 'k' }, env)).toThrow('https://')
  })

  it('calls the API with the key, pinned to its origin, and lists connections without a secret', async () => {
    addApiKey(vault, { name: 'Devin', url: api, key: 'cog_secret' }, env)
    finish(vault, 'fo', { mcp_entry: { url: 'https://mcp.example.com/fo?key=hidden', headers: { 'X-API-Key': 'wak_secret' } } }, 'Fo', env)
    const answer = await send('POST', `/${key}/devin/api/v3/self?x=1`, '{"a":1}')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ ok: true })
    expect(seen.at(-1)).toEqual({ method: 'POST', url: '/v3/self?x=1', auth: 'Bearer cog_secret', body: '{"a":1}' })
    const listed = await (await send('GET', `/${key}/connections`)).text()
    expect(listed).not.toContain('secret')
    expect(listed).not.toContain('hidden')
    expect(JSON.parse(listed).connections).toEqual(expect.arrayContaining([
      { code: 'devin', name: 'Devin', mcp: null, api, state: 'connected' },
      { code: 'fo', name: 'Fo', mcp: 'https://mcp.example.com/fo', api: null, state: 'connected' },
    ]))
    // Its MCP address is not served: nothing an agent could use.
    expect((await send('POST', `/${key}/devin/mcp`, '{}')).status).toBe(404)
    expect((await send('GET', `/${key}/fo/api/v1/x`)).status).toBe(404)
    expect((await send('GET', `/wrong/devin/api/v3/self`)).status).toBe(404)
    expect((await send('GET', `/${key}/devin/other/v3/self`)).status).toBe(404)
    // The key in every agent's MCP entry reaches no API key and lists nothing.
    expect(JSON.stringify(sync(vault, env))).not.toContain(key)
    expect((await send('GET', `/${agentKey}/connections`)).status).toBe(404)
    expect((await send('GET', `/${agentKey}/devin/api/v3/self`)).status).toBe(404)
    expect(seen.filter((call) => call.url.startsWith('/v3/self'))).toHaveLength(1)
  })

  it('adds a key from the command, read from stdin rather than the command line', async () => {
    const out: string[] = []
    const io = { out: (text: string) => { out.push(text) }, err: (text: string) => { out.push(text) } }
    expect(await connectionsCommand(['add-key', 'Cursor', api], io, vault, async () => 'key_secret')).toBe(0)
    expect(out.join('')).toContain('Connected Cursor as cursor.')
    expect(out.join('')).not.toContain('key_secret')
    expect(vault.token('cursor')).toMatchObject({ access_token: 'key_secret', api_entry: { origin: api } })
    expect(await connectionsCommand(['add-key', 'Cursor'], io, vault, async () => 'k')).toBe(2)
  })

  it('turns a refused key into Reconnect and an unreachable API into a retry', async () => {
    addApiKey(vault, { name: 'Devin', url: api, key: 'cog_secret' }, env)
    status = 401
    const refused = await send('GET', `/${key}/devin/api/v3/self`)
    expect(refused.status).toBe(401)
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain('connected again')
    vault.save('devin', { ...vault.token('devin')!, api_entry: { origin: 'http://127.0.0.1:1' } })
    expect((await send('GET', `/${key}/devin/api/v3/self`)).status).toBe(502)
  })
})

describe('agent configs', () => {
  it('gives each agent the shim and keeps its own servers', () => {
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
    const socket = join(vault.root, 'bridge.sock')
    const shim = (code: string) => [join(vault.root, 'mcp-shim.mjs'), '--socket', socket, code]
    const data = JSON.parse(readFileSync(claude, 'utf8'))
    expect(data.numStartups).toBe(3)
    expect(data.mcpServers.notion).toEqual({ command: 'my-notion' })
    expect(data.mcpServers.linear).toEqual({ type: 'stdio', command: managedNodePath(), args: shim('linear') })
    const toml = readFileSync(codex, 'utf8')
    expect(toml.startsWith('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')).toBe(true)
    expect(toml).toContain(`[mcp_servers.notion]\ncommand = ${JSON.stringify(managedNodePath())}\nargs = ${JSON.stringify(shim('notion'))}`)
    expect(JSON.parse(readFileSync(opencode, 'utf8')).mcp.linear).toEqual({ type: 'local', command: [managedNodePath(), ...shim('linear')], enabled: true })
    for (const path of [claude, codex, opencode]) expect(readFileSync(path, 'utf8')).not.toContain('secret-')
    vault.disconnect('linear')
    vault.disconnect('notion')
    sync(vault, env)
    expect(JSON.parse(readFileSync(claude, 'utf8')).mcpServers).toEqual({ notion: { command: 'my-notion' } })
    expect(readFileSync(codex, 'utf8')).toBe('model = "gpt-5"\n\n[mcp_servers.mine]\ncommand = "mine"\n')
    expect(JSON.parse(readFileSync(opencode, 'utf8'))).toEqual({ model: 'opencode/muse' })
  })

  describe('under a profile home', () => {
    const shim = (code: string) => [join(vault.root, 'mcp-shim.mjs'), '--socket', join(vault.root, 'bridge.sock'), code]
    beforeEach(() => resetProfileCache())
    const connect = (...codes: string[]) => { for (const code of codes) vault.save(code, { access_token: 'secret-' + code, source: 'dcr', mcp_entry: { url: `https://mcp.${code}.example/mcp`, headers: {} } }) }

    it('gives an agent on a Claude profile the shim in the profile\'s .claude.json, and the default home as it was', () => {
      const profile = join(home, '.claude-work')
      mkdirSync(profile)
      writeFileSync(join(profile, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' }, mcpServers: { mine: { command: 'mine' } } }))
      connect('linear')
      expect(syncProfileHome(vault, 'claude', profile, env)).toEqual(['linear'])
      const data = JSON.parse(readFileSync(join(profile, '.claude.json'), 'utf8'))
      expect(data.oauthAccount).toEqual({ emailAddress: 'a@b.c' })
      expect(data.mcpServers).toEqual({ mine: { command: 'mine' }, linear: { type: 'stdio', command: managedNodePath(), args: shim('linear') } })
      expect(existsSync(join(home, '.claude.json'))).toBe(false)
    })

    it('gives an agent on a Codex profile the shim in the profile\'s config.toml, and the default home as it was', () => {
      const profile = join(home, 'codex-work')
      mkdirSync(profile)
      writeFileSync(join(profile, 'config.toml'), 'model = "gpt-5"\n')
      connect('linear')
      expect(syncProfileHome(vault, 'codex', profile, env)).toEqual(['linear'])
      expect(readFileSync(join(profile, 'config.toml'), 'utf8'))
        .toBe(`model = "gpt-5"\n\n[mcp_servers.linear]\ncommand = ${JSON.stringify(managedNodePath())}\nargs = ${JSON.stringify(shim('linear'))}\n`)
      expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false)
    })

    it('keeps the profile current: a later connection arrives, a disconnected one leaves, and a gone folder is forgotten', () => {
      const claude = join(home, '.claude-work'), codex = join(home, 'codex-work'), gone = join(home, '.claude-gone')
      for (const folder of [claude, codex, gone]) mkdirSync(folder)
      for (const folder of [claude, gone]) writeFileSync(join(folder, '.claude.json'), '{}')
      writeFileSync(join(codex, 'config.toml'), '')
      expect(syncProfileHome(vault, 'claude', claude, env)).toEqual([]) // Nothing connected yet: the home is only recorded.
      syncProfileHome(vault, 'codex', codex, env)
      syncProfileHome(vault, 'claude', gone, env)
      connect('linear', 'notion')
      expect(sync(vault, env)).toMatchObject({ [`claude:${claude}`]: ['linear', 'notion'], [`codex:${codex}`]: ['linear', 'notion'] })
      expect(Object.keys(JSON.parse(readFileSync(join(claude, '.claude.json'), 'utf8')).mcpServers)).toEqual(['linear', 'notion'])
      vault.disconnect('notion')
      rmSync(gone, { recursive: true })
      sync(vault, env)
      expect(Object.keys(JSON.parse(readFileSync(join(claude, '.claude.json'), 'utf8')).mcpServers)).toEqual(['linear'])
      expect(readFileSync(join(codex, 'config.toml'), 'utf8')).not.toContain('notion')
      expect(Object.keys(vault.file('projections.json'))).not.toContain(`claude:${gone}`)
      vault.disconnect('linear')
      sync(vault, env)
      expect(JSON.parse(readFileSync(join(claude, '.claude.json'), 'utf8')).mcpServers).toBeUndefined()
      expect(readFileSync(join(codex, 'config.toml'), 'utf8')).toBe('')
    })

    it('writes into a Codex folder only when this machine lists it as a profile', () => {
      const unlisted = join(home, 'elsewhere')
      mkdirSync(unlisted)
      connect('linear')
      expect(syncProfileHome(vault, 'codex', unlisted, env)).toEqual([])
      expect(existsSync(join(unlisted, 'config.toml'))).toBe(false)
      expect(Object.keys(vault.file('projections.json'))).toEqual([])
      // The folder a native launch picked is not a profile either.
      expect(syncProfileHome(vault, 'codex', join(home, 'not-yet-made'), env)).toEqual([])
      expect(existsSync(join(home, 'not-yet-made'))).toBe(false)
    })

    it('never writes through a link that leaves the profile, nor treats a link to the default home as a profile', () => {
      const profile = join(home, '.claude-work'), outside = join(home, 'dotfiles', 'claude.json')
      mkdirSync(profile)
      mkdirSync(join(home, 'dotfiles'))
      writeFileSync(outside, '{"mine":true}')
      symlinkSync(outside, join(profile, '.claude.json'))
      connect('linear')
      expect(syncProfileHome(vault, 'claude', profile, env)).toEqual([])
      expect(readFileSync(outside, 'utf8')).toBe('{"mine":true}')
      const codex = join(home, 'codex-work')
      mkdirSync(codex)
      writeFileSync(join(home, 'dotfiles', 'config.toml'), 'model = "x"\n')
      symlinkSync(join(home, 'dotfiles', 'config.toml'), join(codex, 'config.toml'))
      expect(syncProfileHome(vault, 'codex', codex, env)).toEqual([])
      expect(readFileSync(join(home, 'dotfiles', 'config.toml'), 'utf8')).toBe('model = "x"\n')
      const alias = join(home, 'alias')
      symlinkSync(home, alias)
      expect(syncProfileHome(vault, 'claude', alias, env)).toEqual([])
      expect(existsSync(join(home, '.claude.json'))).toBe(false)
    })

    it('keeps one home that cannot be written from stopping the others, and records what was written', () => {
      if (process.getuid?.() === 0) return // root writes anywhere
      const locked = join(home, '.claude-locked'), open = join(home, '.claude-open')
      for (const folder of [locked, open]) { mkdirSync(folder); writeFileSync(join(folder, '.claude.json'), '{}') }
      syncProfileHome(vault, 'claude', locked, env)
      syncProfileHome(vault, 'claude', open, env)
      chmodSync(locked, 0o500)
      closers.push(() => chmodSync(locked, 0o700))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      connect('linear')
      const changed = sync(vault, env)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`claude:${locked}`))
      warn.mockRestore()
      expect(changed[`claude:${open}`]).toEqual(['linear'])
      expect(vault.file('projections.json')[`claude:${open}`]).toEqual(['linear'])
      expect(JSON.parse(readFileSync(join(open, '.claude.json'), 'utf8')).mcpServers.linear).toBeDefined()
      chmodSync(locked, 0o700)
    })

    it('takes its entries out of a Codex folder this machine no longer lists, and forgets it', () => {
      const folder = join(home, 'once-a-profile')
      mkdirSync(folder)
      writeFileSync(join(folder, 'config.toml'), 'model = "x"\n\n[mcp_servers.linear]\ncommand = "node"\nargs = []\n')
      writePrivate(join(vault.root, 'projections.json'), { [`codex:${folder}`]: ['linear'] })
      sync(vault, env)
      expect(readFileSync(join(folder, 'config.toml'), 'utf8')).toBe('model = "x"\n')
      expect(Object.keys(vault.file('projections.json'))).not.toContain(`codex:${folder}`)
    })

    it('leaves the default home\'s own file and a path that is not absolute to the default agent', () => {
      connect('linear')
      expect(syncProfileHome(vault, 'claude', home, env)).toEqual([])
      expect(syncProfileHome(vault, 'codex', join(home, '.codex'), env)).toEqual([])
      expect(syncProfileHome(vault, 'claude', 'relative/profile', env)).toEqual([])
      expect(existsSync(join(home, '.claude.json'))).toBe(false)
      expect(Object.keys(vault.file('projections.json'))).toEqual([])
    })
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

  it('takes no caught redirect for a gateway sign-in, which the gateway finishes', async () => {
    await signedIn()
    const flows = new Flows(vault, env)
    const { flow } = await flows.start('github', signInFor(vault, 'github', services(await gateway.available())))
    expect(() => flows.deliver(flow, 'http://127.0.0.1:51789/callback?code=x&state=y')).toThrow('on its own')
  })

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
    writePrivate(join(vault.root, 'page.json'), { port: Number(new URL(page.origin).port), key: 'not-this-servers', version: PAGE_BUILD, pid: 1 })
    expect(await runningPage(vault)).toBeNull()
    forgetPage(vault, Number(new URL(page.origin).port), 'not-this-servers')
    expect(await runningPage(vault)).toBeNull()
  })

  it('is not reused when an earlier release runs it: that one is stopped, and a new page starts', async () => {
    const port = Number(new URL(page.origin).port)
    const stopped: number[] = []
    rememberPage(vault, port, page.key, 'an-earlier-release', 4242)
    expect(readPrivate(join(vault.root, 'page.json'))).toEqual({ port, key: page.key, version: 'an-earlier-release', pid: 4242 })
    expect(await runningPage(vault, PAGE_BUILD, pid => stopped.push(pid))).toBeNull()
    expect(stopped).toEqual([4242])
    // One from before the release was written down: not reused, and with no pid, left to stop by itself.
    writePrivate(join(vault.root, 'page.json'), { port, key: page.key })
    expect(await runningPage(vault, PAGE_BUILD, pid => stopped.push(pid))).toBeNull()
    expect(stopped).toEqual([4242])
    rememberPage(vault, port, page.key)
    expect(await runningPage(vault, PAGE_BUILD, pid => stopped.push(pid))).toBe(`${page.origin}/#${page.key}`)
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
