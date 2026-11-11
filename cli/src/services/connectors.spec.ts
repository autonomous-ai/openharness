import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeKey, bridgePort, bridgeSocketPath, harnessKey, readBridgePipe, saveBridgePort } from '../lib/connectors/agents.js'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore } from '../testing/fakeCore.js'
import type { BackendNotice } from '../core/api.js'
import { CONNECTORS_REQUESTS, startConnectors } from './connectors.js'
import { Store } from '../lib/connectors/store.js'
import * as gateway from '../lib/connectors/gateway.js'
import { FakeGateway } from '../testing/connectorServers.js'
import { serveBridgeSocket } from '../lib/connectors/bridge.js'
import { LSOF_MS } from '../lib/peerAccount.js'

// The real socket, but for a failure with no Error to say why, which nothing here can provoke.
vi.mock('../lib/connectors/bridge.js', async (original) => {
  const real = await original<typeof import('../lib/connectors/bridge.js')>()
  return { ...real, serveBridgeSocket: vi.fn(real.serveBridgeSocket) }
})

const OWNER = { local: true, owner: true }
/**
 * How long the bridge may take to answer: a known key is answered only once it has asked who is calling, which on a Mac is
 * lsof, about a second at load 28 and allowed LSOF_MS. A second cut that lookup off on a loaded Mac (cli-core gate, load 30).
 */
const ANSWER_MS = LSOF_MS + 1_000

describe('the connectors service', () => {
  let home: string
  let env: NodeJS.ProcessEnv
  const signedIn = gateway.backend.signedIn
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'connectors-service-'))
    env = { HOME: home, PATH: '', HARNESS_CONNECTIONS_PORT: '0', XDG_CONFIG_HOME: join(home, '.config') }
    // Signed out of Harness whatever this computer is: nothing here reaches the backend.
    gateway.backend.signedIn = () => false
  })
  afterEach(() => {
    gateway.backend.signedIn = signedIn
    vi.mocked(serveBridgeSocket).mockClear()
    rmSync(home, { recursive: true, force: true })
    for (const made of shortHomes.splice(0)) rmSync(made, { recursive: true, force: true })
  })
  /** A port held as another account holds it: it only holds, and hangs up on whoever dials it. */
  const holdPort = async () => {
    const holder = createServer(socket => socket.destroy())
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    return holder
  }
  /** A loopback port free a moment ago. */
  const freePort = async (): Promise<number> => {
    const free = await holdPort()
    const { port } = free.address() as { port: number }
    await new Promise(done => free.close(done))
    return port
  }
  /** What a request answered, or 0 when it was not answered in ANSWER_MS. */
  const answered = (url: string) => fetch(url, { method: 'POST', body: '{}', signal: AbortSignal.timeout(ANSWER_MS) }).then(reply => reply.status, () => 0)

  // Any process can dial a port a test listens on: under load another run's request reached a held port just released and taken
  // again (one node process held connections to the holders of two parallel runs), and a holder that kept the connection waited
  // for it in close() until the test timed out at 30 s (Q3, 2026-11-10).
  it('lets go of a held port at once, whatever an outsider left connected to it', async () => {
    const holder = await holdPort()
    const accepted = new Promise(resolve => holder.once('connection', resolve))
    const outsider = connect((holder.address() as { port: number }).port, '127.0.0.1')
    // Hung up on, as a held port does.
    outsider.on('error', () => {})
    try {
      await accepted
      const closing = Date.now()
      await new Promise<void>(resolve => holder.close(() => resolve()))
      expect(Date.now() - closing).toBeLessThan(5_000)
    } finally { outsider.destroy() }
  }, 10_000)

  // A socket's path has a limit, and an agent's temporary folder can be past it on its own. These tests need the socket.
  const shortHomes: string[] = []
  const shortHome = () => { const made = mkdtempSync('/tmp/hc-'); shortHomes.push(made); return made }

  it('answers exactly the request it declares, and only for the owner', async () => {
    const requests = startConnectors(fakeCore(), { env })
    expect(Object.keys(requests)).toEqual([...CONNECTORS_REQUESTS])
    expect(await requests.connectors!({ action: 'list' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
    // Signed out, the gateway's list is empty and nothing reaches the network.
    // The core is signed in to the account, so a connection made here is shared with its computers.
    expect(await requests.connectors!({ action: 'list' }, OWNER)).toMatchObject({ signed_in: false, shared: true })
    expect(await startConnectors(fakeCore(), { env, vaultPort: null }).connectors!({ action: 'list' }, OWNER))
      .toMatchObject({ shared: false })
  })

  it('keeps the connections the account\'s when signed in: reads them now and again at each notice that may change them', async () => {
    const backend = vi.fn(async (_method: string, _path: string) => ({ status: 200, body: { success: true, data: { revision: 0, envelope: null } } }))
    let hear: (notice: BackendNotice) => void = () => {}
    const core = fakeCore({ account: { backend, onNotice: vi.fn((listener: (notice: BackendNotice) => void) => { hear = listener; return () => {} }) } as never })
    startConnectors(core, { env, port: 0 })
    await vi.waitFor(() => expect(backend).toHaveBeenCalledWith('GET', '/api/connector-vault'))
    const reads = () => backend.mock.calls.filter(([, path]) => path === '/api/connector-vault').length
    const before = reads()
    hear({ type: 'connectors_changed', revision: 4 })
    await vi.waitFor(() => expect(reads()).toBe(before + 1))
    hear({ type: 'device_keys_changed' })
    await vi.waitFor(() => expect(reads()).toBe(before + 2))
    hear({ type: 'desk_changed', revision: 1 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reads()).toBe(before + 2)
  })

  it('keeps them on this computer alone while signed out', async () => {
    const backend = vi.fn(async () => ({ status: 200, body: {} }))
    startConnectors(fakeCore({ account: { backend, signedIn: () => false } as never }), { env, port: 0 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend).not.toHaveBeenCalled()
  })

  it('reads this process\'s environment when given none', () => {
    vi.stubEnv('HOME', home)
    vi.stubEnv('HARNESS_CONNECTIONS_PORT', '0')
    vi.stubEnv('PATH', '')
    try { expect(Object.keys(startConnectors(fakeCore()))).toEqual(['connectors']) } finally { vi.unstubAllEnvs() }
  })

  it('lists, refuses what it cannot do, and disconnects, never answering with a token', async () => {
    const vault = new Store(join(home, 'store'), env)
    vault.save('linear', { access_token: 'secret', source: 'dcr', mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: {} } })
    const offered = vi.fn(async () => ({}))
    const requests = startConnectors(fakeCore(), { vault, env, port: 0, offered })
    const listed = await requests.connectors!({ action: 'list' }, OWNER) as { connections: { connector: string, state: string }[] }
    expect(listed.connections.find(card => card.connector === 'linear')!.state).toBe('connected')
    expect(JSON.stringify(listed)).not.toContain('secret')
    await requests.connectors!({ action: 'list' }, OWNER)
    expect(offered).toHaveBeenCalledOnce()
    expect(await requests.connectors!({ action: 'connect', connector: 'github' }, OWNER)).toMatchObject({ error: 'CONNECTORS_FAILED', detail: expect.stringContaining('harness login') })
    expect(await requests.connectors!({ action: 'flow', flow: 'gone' }, OWNER)).toMatchObject({ error: 'CONNECTORS_FAILED', detail: expect.stringContaining('ended') })
    expect(await requests.connectors!({ action: 'flow' }, OWNER)).toMatchObject({ error: 'CONNECTORS_FAILED' })
    // A phone's caught redirect for a sign-in this computer no longer holds is refused, never followed.
    expect(await requests.connectors!({ action: 'callback', flow: 'gone', url: 'http://127.0.0.1:51789/callback?code=x' }, OWNER))
      .toMatchObject({ error: 'CONNECTORS_FAILED', detail: expect.stringContaining('ended') })
    expect(await requests.connectors!({ action: 'callback' }, OWNER)).toMatchObject({ error: 'CONNECTORS_FAILED' })
    expect(await requests.connectors!({ action: 'nope' }, OWNER)).toEqual({ error: 'CONNECTORS_FAILED', detail: 'Unknown action.' })
    expect(await requests.connectors!({ action: 'custom', name: 'Mine', url: 'https://mine.example/mcp', headers: { Authorization: 'Bearer pat' } }, OWNER))
      .toEqual({ connector: 'mine', state: 'connected' })
    // An API key for a cloud agent, never an agent's MCP server.
    expect(await requests.connectors!({ action: 'custom', kind: 'api', name: 'Devin', url: 'https://api.devin.ai', key: 'cog_x' }, OWNER))
      .toEqual({ connector: 'devin', state: 'connected' })
    expect(vault.token('devin')).toMatchObject({ api_entry: { origin: 'https://api.devin.ai' }, transport: 'none' })
    expect(await requests.connectors!({ action: 'disconnect', connector: 'linear' }, OWNER)).toEqual({ connector: 'linear', state: 'not_connected' })
    expect(vault.token('linear')).toBeUndefined()
  })

  it('starts a sign-in and says how it goes', async () => {
    const vault = new Store(join(home, 'store'), env)
    const requests = startConnectors(fakeCore(), { vault, env, port: 0, offered: async () => ({ newsvc: { code: 'newsvc', auth_type: 'dcr', mcp_url: 'http://127.0.0.1:9/mcp' } }) })
    const started = await requests.connectors!({ action: 'connect', connector: 'newsvc' }, OWNER)
    expect(started).toMatchObject({ error: 'CONNECTORS_FAILED', detail: expect.stringContaining('reach') })
  })

  it('says how a gateway sign-in goes without ever an `error` key, which the desktop reads as the request failing', async () => {
    const fake = await new FakeGateway().start()
    const original = { ...gateway.backend }
    Object.assign(gateway.backend, { signedIn: () => true, base: async () => fake.base, headers: async () => ({ authorization: 'Bearer harness-session' }) })
    try {
      const vault = new Store(join(home, 'store'), env)
      const requests = startConnectors(fakeCore(), { vault, env, port: 0 })
      const ask = (flow: string) => requests.connectors!({ action: 'flow', flow }, OWNER) as Promise<Record<string, unknown>>
      const started = await requests.connectors!({ action: 'connect', connector: 'github' }, OWNER) as { flow: string }
      const seen: Record<string, unknown>[] = [await ask(started.flow)]
      while (seen.at(-1)!.state === 'pending') { await new Promise(resolve => setTimeout(resolve, 100)); seen.push(await ask(started.flow)) }
      expect(seen[0]).toEqual({ connector: 'github', state: 'pending' })
      expect(seen.at(-1)).toEqual({ connector: 'github', state: 'connected' })
      expect(vault.token('github')).toMatchObject({ source: 'gateway' })
      fake.polls = 0
      const again = await requests.connectors!({ action: 'connect', connector: 'github' }, OWNER) as { flow: string }
      fake.fail = { status: 400, code: 'BAD', message: 'The service said no.' }
      let failed = await ask(again.flow)
      while (failed.state === 'pending') { await new Promise(resolve => setTimeout(resolve, 100)); failed = await ask(again.flow) }
      expect(failed).toEqual({ connector: 'github', state: 'failed', reason: 'The service said no.' })
    } finally { Object.assign(gateway.backend, original); fake.close() }
  }, 15_000)

  it('a failure that is not a connection\'s own says only that connections are unavailable', async () => {
    const vault = new Store(join(home, 'store'), env)
    const requests = startConnectors(fakeCore(), { vault, env, port: 0, offered: async () => { throw new Error('boom') } })
    expect(await requests.connectors!({ action: 'list' }, OWNER)).toEqual({ error: 'CONNECTORS_FAILED', detail: 'Connections are unavailable. Try again.' })
  })

  it('moves off a port another account holds, tells agents, and comes back to the saved port next time', async () => {
    const holder = await holdPort()
    const taken = (holder.address() as { port: number }).port
    // No port named: the bridge's own choice, which is the one that may move.
    const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
    const vault = new Store(join(home, 'store'), free)
    // Stands for 51793, which the bridge asks for by default: a Team daemon has held it since boot.
    saveBridgePort(vault, taken)
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), retryMs: 5, holderIsMine: async () => false })
      let moved = taken
      for (let n = 0; n < 200 && moved === taken; n++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        moved = bridgePort(free, new Store(join(home, 'store'), free))
      }
      expect(moved).not.toBe(taken)
      expect(said.mock.calls.flat().join(' ')).toContain(`bridge port ${taken} is not available`)
      expect(said.mock.calls.flat().join(' ')).toContain(`the bridge moved to port ${moved}`)
      expect(await answered(`http://127.0.0.1:${moved}/x/linear/mcp`)).toBe(404)
      // Once the holder lets go, agents still on the old address recover: the bridge answers there too.
      await new Promise<void>(resolve => holder.close(() => resolve()))
      let status = 0
      for (let n = 0; n < 200 && !status; n++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        status = await answered(`http://127.0.0.1:${taken}/x/linear/mcp`)
      }
      expect(status).toBe(404)
    } finally {
      said.mockRestore()
      holder.close()
    }
  }, 30_000)

  it.each([
    ['its own account holds the port, by the real lookup', undefined],
    ['nobody can say who holds it', async () => null],
  ])('never moves when %s', async (_name, holderIsMine) => {
    const holder = await holdPort()
    const taken = (holder.address() as { port: number }).port
    const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
    const vault = new Store(join(home, 'store'), free)
    saveBridgePort(vault, taken)
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), retryMs: 5, ...(holderIsMine ? { holderIsMine } : {}) })
      // Well past the tries before it asks, with time for the lookup.
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(bridgePort(free, new Store(join(home, 'store'), free))).toBe(taken)
      expect(said.mock.calls.flat().join(' ')).not.toContain('moved')
      await new Promise<void>(resolve => holder.close(() => resolve()))
      let status = 0
      for (let n = 0; n < 200 && !status; n++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        status = await answered(`http://127.0.0.1:${taken}/x/linear/mcp`)
      }
      expect(status).toBe(404)
    } finally {
      said.mockRestore()
      holder.close()
    }
  // Its waits add up past the default 5 s on a loaded machine: it timed out once in a full coverage run.
  }, 30_000)

  it('does not move on one answer: a handover ending just then reads as another account, so it tries the port again first', async () => {
    const holder = await holdPort()
    const taken = (holder.address() as { port: number }).port
    const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
    const vault = new Store(join(home, 'store'), free)
    saveBridgePort(vault, taken)
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let asked = 0
    try {
      // Another account's by one answer, then this account's every time after, as a port another listener took over.
      startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), retryMs: 5, holderIsMine: async () => { asked++; return asked % 2 === 0 } })
      for (let n = 0; n < 200 && asked < 6; n++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(asked).toBeGreaterThanOrEqual(6)
      expect(bridgePort(free, new Store(join(home, 'store'), free))).toBe(taken)
      expect(said.mock.calls.flat().join(' ')).not.toContain('moved')
    } finally {
      said.mockRestore()
      await new Promise<void>(resolve => holder.close(() => resolve()))
    }
  }, 30_000)

  // A second Harness home, a dev build or a leftover core of this account can hold the port for hours. Asking lsof whose it was
  // at every try, every 5 s, cost about 1% of a core at rest, the daemon's whole budget (2026-11-11).
  describe('while a process of this account holds the port', () => {
    afterEach(() => { vi.useRealTimers() })

    const held = async (holderIsMine: () => Promise<boolean | null>) => {
      const holder = await holdPort()
      const taken = (holder.address() as { port: number }).port
      const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
      const vault = new Store(join(home, 'store'), free)
      saveBridgePort(vault, taken)
      const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // The default try every 5 s, as the daemon runs it.
      startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), vaultPort: null, holderIsMine })
      const told = (text: string) => said.mock.calls.flat().join('\n').split(text).length - 1
      const savedPort = () => bridgePort(free, new Store(join(home, 'store'), free))
      return { holder, taken, said, told, savedPort }
    }

    it('asks whose it is less and less often, says so once, and takes the port at the next try once it is let go', async () => {
      let asked = 0
      const { holder, taken, said, told } = await held(async () => { asked++; return true })
      try {
        // An hour: 720 tries of the port, which asked 718 times before.
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(asked).toBeGreaterThan(0)
        expect(asked).toBeLessThanOrEqual(20)
        expect(told(`bridge port ${taken} is not available`)).toBe(1)
        expect(told(`a process of this account holds bridge port ${taken}`)).toBe(1)
        await new Promise<void>(resolve => holder.close(() => resolve()))
        // The port itself is still tried every 5 s: one try takes it.
        await vi.advanceTimersByTimeAsync(5_000)
        vi.useRealTimers()
        let status = 0
        for (let n = 0; n < 100 && !status; n++) {
          status = await answered(`http://127.0.0.1:${taken}/x/linear/mcp`)
          if (!status) await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(status).toBe(404)
        expect(told('moved')).toBe(0)
      } finally {
        said.mockRestore()
        holder.close()
      }
    }, 30_000)

    it('says once that no one can tell whose the port is, when the lookup cannot answer', async () => {
      const { holder, taken, said, told } = await held(async () => null)
      try {
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(told(`cannot tell which account holds bridge port ${taken}`)).toBe(1)
        expect(told(`a process of this account holds bridge port ${taken}`)).toBe(0)
      } finally {
        said.mockRestore()
        holder.close()
      }
    }, 30_000)

    it('still moves off it when another account takes it over, within five minutes of asking less', async () => {
      let mine = true
      const { holder, taken, said, told, savedPort } = await held(async () => mine)
      try {
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(savedPort()).toBe(taken)
        // The holder let go and another account took the port between two tries.
        mine = false
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 15_000)
        expect(savedPort()).not.toBe(taken)
        expect(told(`the bridge moved to port ${savedPort()}`)).toBe(1)
      } finally {
        said.mockRestore()
        holder.close()
      }
    }, 30_000)
  })

  it('says so when the port it moved to cannot be saved', async () => {
    const holder = await holdPort()
    const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
    const vault = new Store(join(home, 'store'), free)
    saveBridgePort(vault, (holder.address() as { port: number }).port)
    const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), retryMs: 5, holderIsMine: async () => false })
      vi.spyOn(vault, 'file').mockImplementation(() => { throw new Error('disk full') })
      for (let n = 0; n < 200 && !said.mock.calls.flat().join(' ').includes('could not save'); n++) await new Promise(resolve => setTimeout(resolve, 10))
      expect(said.mock.calls.flat().join(' ')).toContain("could not save the bridge's new port: disk full")
    } finally {
      said.mockRestore()
      await new Promise<void>(resolve => holder.close(() => resolve()))
    }
  })

  // A vault folder and a home both too long for a socket, the one case left on TCP on a Mac or Linux, as every case is on Windows: the
  // port is the only way in, so its keys stay as they are and neither is replaced or retired.
  describe('where neither the vault\'s folder nor the home can hold a socket', () => {
    beforeEach(() => { vi.stubEnv('HOME', `/${'h'.repeat(120)}`) })
    afterEach(() => { vi.unstubAllEnvs() })

    const status = async (port: number, path: string) => {
      for (let n = 0; n < 40; n++) {
        const answer = await answered(`http://127.0.0.1:${port}${path}`)
        if (answer) return answer
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      return 0
    }
    const body = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(ANSWER_MS) }).then(reply => reply.text())
    const rawStatus = (port: number, path: string) => new Promise<number>((resolve, reject) => {
      const sent = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', timeout: 1_000 }, (reply) => { reply.resume(); resolve(reply.statusCode ?? 0) })
      sent.once('timeout', () => sent.destroy(new Error('no answer within a second')))
      sent.once('error', reject)
      sent.end('{}')
    })
    const longVault = () => {
      const vault = new Store(join(home, 'v'.repeat(120)), env)
      expect(bridgeSocketPath(vault)).toBeNull()
      return vault
    }

    it('answers both keys on the port, leaves them unchanged, and makes no socket', async () => {
      const vault = longVault(), port = await freePort()
      mkdirSync(vault.root, { recursive: true, mode: 0o700 })
      writeFileSync(join(vault.root, 'harness-key.json'), JSON.stringify({ key: 'harness-key-placeholder' }), { mode: 0o600 })
      const agentKey = bridgeKey(vault)
      startConnectors(fakeCore(), { vault, env, port, offered: async () => ({}), retryMs: 20, vaultPort: null })
      expect(vault.file('bridge.json').key).toBe(agentKey)
      expect(vault.file('bridge.json').keyRetiresAt).toBeUndefined()
      expect(vault.file('harness-key.json').key).toBe('harness-key-placeholder')
      expect(existsSync(join(vault.root, 'bridge.sock'))).toBe(false)
      expect(vi.mocked(serveBridgeSocket)).not.toHaveBeenCalled()
      expect(await status(port, '/not-a-key/connections')).toBe(404)
      expect(await status(port, '/harness-key-placeholder/connections')).toBe(200)
      // The agents' key reaches a connection's MCP address, and the list stays Harness's alone.
      expect(await status(port, `/${agentKey}/connections`)).toBe(404)
      expect(await body(port, `/${agentKey}/linear/mcp`)).toContain('is not connected')
      expect(await body(port, '/not-a-key/linear/mcp')).toContain('Unknown connection address')
    })

    it('with neither key on file, refuses everyone, an empty key included', async () => {
      const vault = longVault(), port = await freePort()
      const agentKey = bridgeKey(vault)
      startConnectors(fakeCore(), { vault, env, port, offered: async () => ({}), retryMs: 20, vaultPort: null })
      rmSync(join(vault.root, 'bridge.json'), { force: true })
      rmSync(join(vault.root, 'harness-key.json'), { force: true })
      expect(await status(port, '/x/connections')).toBe(404)
      // A raw request, as fetch would normalize this path: the first segment is empty, and an empty key never matches a missing one.
      expect(await rawStatus(port, '/.//connections')).toBe(404)
      expect(await body(port, `/${agentKey}/linear/mcp`)).toContain('Unknown connection address')
    })

    // Agents' entries are the port's address here, with its key: another account taking it over must be seen at once (audit H1).
    it('asks whose the port is at every try while this account holds it, as before', async () => {
      const holder = await holdPort()
      const vault = longVault()
      const { HARNESS_CONNECTIONS_PORT: _named, ...free } = env
      saveBridgePort(vault, (holder.address() as { port: number }).port)
      const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      let asked = 0
      try {
        startConnectors(fakeCore(), { vault, env: free, offered: async () => ({}), vaultPort: null, holderIsMine: async () => { asked++; return true } })
        await vi.advanceTimersByTimeAsync(3_600_000)
        expect(asked).toBeGreaterThanOrEqual(700)
      } finally {
        vi.useRealTimers()
        said.mockRestore()
        holder.close()
      }
    }, 30_000)
  })

  // The store refuses a vault folder that has become a link: its keys cannot be read or replaced, and nobody gets in by that.
  it('starts anyway when its folder cannot be trusted, says so, and refuses everyone on the port', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const short = shortHome()
    const elsewhere = join(short, 'elsewhere'), root = join(short, 'link')
    mkdirSync(elsewhere, { mode: 0o700 })
    const behindLink = JSON.stringify({ key: 'k'.repeat(40) })
    writeFileSync(join(elsewhere, 'bridge.json'), behindLink, { mode: 0o600 })
    symlinkSync(elsewhere, root)
    const port = await freePort()
    startConnectors(fakeCore(), { vault: new Store(root, env), env, port, offered: async () => ({}), retryMs: 20, vaultPort: null })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not replace Harness\'s key'))
    let answer = ''
    for (let n = 0; n < 40 && !answer; n++) {
      answer = await fetch(`http://127.0.0.1:${port}/${'k'.repeat(40)}/linear/mcp`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(1_000) }).then(reply => reply.text(), () => '')
      if (!answer) await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(answer).toContain('Unknown connection address')
    expect(readFileSync(join(elsewhere, 'bridge.json'), 'utf8')).toBe(behindLink)
    warn.mockRestore()
  })

  describe('while another listener holds the bridge\'s socket', () => {
    it('says so once, keeps trying, and takes the socket when it is free', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const vault = new Store(join(shortHome(), 's'), env), path = join(vault.root, 'bridge.sock')
      mkdirSync(vault.root, { recursive: true, mode: 0o700 })
      // It hangs up on each probe of the service's (localSocket.ts refuseLiveSocket), so close() waits on none.
      const holder = createServer(socket => socket.destroy())
      await new Promise<void>(resolve => holder.listen(path, resolve))
      startConnectors(fakeCore(), { vault, env, port: 0, offered: async () => ({}), retryMs: 10, vaultPort: null })
      const said = () => warn.mock.calls.filter(([line]) => String(line).includes('socket is not listening'))
      await vi.waitFor(() => expect(vi.mocked(serveBridgeSocket).mock.calls.length).toBeGreaterThanOrEqual(3))
      expect(said()).toHaveLength(1)
      expect(String(said()[0][0])).toContain(path)
      const calls = vi.mocked(serveBridgeSocket).mock.calls.length
      await new Promise<void>(resolve => holder.close(() => resolve()))
      await vi.waitFor(async () => {
        expect(vi.mocked(serveBridgeSocket).mock.calls.length).toBeGreaterThan(calls)
        await new Promise<void>((resolve, reject) => { const client = connect(path, () => { client.destroy(); resolve() }); client.once('error', reject) })
      })
      warn.mockRestore()
    })

    it('says what went wrong when the failure is not an Error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.mocked(serveBridgeSocket).mockRejectedValueOnce('a plain reason')
      const vault = new Store(join(shortHome(), 'p'), env), path = join(vault.root, 'bridge.sock')
      startConnectors(fakeCore(), { vault, env, port: 0, offered: async () => ({}), retryMs: 10, vaultPort: null })
      await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('a plain reason')))
      // Its retry goes on and listens: waited for, or it would make the folder again after this test's cleanup.
      await vi.waitFor(() => new Promise<void>((resolve, reject) => { const client = connect(path, () => { client.destroy(); resolve() }); client.once('error', reject) }))
      warn.mockRestore()
    })
  })

  it('waits for its port while another process holds it', async () => {
    const holder = await holdPort()
    const port = (holder.address() as { port: number }).port
    startConnectors(fakeCore(), { vault: new Store(join(home, 'store'), env), env, port, offered: async () => ({}), retryMs: 20 })
    await new Promise(resolve => setTimeout(resolve, 60))
    await new Promise<void>(resolve => holder.close(() => resolve()))
    // Once the holder lets go, the bridge takes the port: a request is answered (refused, with no key).
    let status = 0
    for (let n = 0; n < 40 && !status; n++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      status = await answered(`http://127.0.0.1:${port}/x/linear/mcp`)
    }
    expect(status).toBe(404)
  })

  // Task #2162 (Reed's review of #2605): on Windows the bridge had only its port, which the Team account can hold from boot.
  describe('on Windows', () => {
    // A Unix socket named as a pipe stands for it; short, as a socket has to fit.
    const shortPipe = (): { folder: string; pipe: string } => {
      const folder = mkdtempSync(join('/tmp', 'cw-'))
      return { folder, pipe: join(folder, 'p', `harness-${randomBytes(16).toString('hex')}`) }
    }

    it('serves the bridge on a proven pipe, records it, and takes Harness\'s key off the port', async () => {
      const { folder, pipe } = shortPipe()
      mkdirSync(join(folder, 'p'))
      const vault = new Store(join(home, 'store'), env)
      const stale = harnessKey(vault)
      bridgeKey(vault)
      const port = await freePort()
      try {
        startConnectors(fakeCore(), { vault, env, port, offered: async () => ({}), retryMs: 5, platform: 'win32', pipePath: () => pipe })
        await vi.waitFor(() => expect(readBridgePipe(vault)?.pipe).toBe(pipe))
        expect(vault.file('harness-key.json')).toMatchObject({ socketOnly: true })
        expect(harnessKey(vault)).not.toBe(stale)
        expect(typeof vault.file('bridge.json').keyRetiresAt).toBe('number')
        await vi.waitFor(async () => expect((await fetch(`http://127.0.0.1:${port}/${harnessKey(vault)}/connections`, { signal: AbortSignal.timeout(1_000) })).status).toBe(404))
      } finally { rmSync(folder, { recursive: true, force: true }) }
    })

    it('tries the pipe again, saying so once, when it cannot listen yet', async () => {
      const { folder, pipe } = shortPipe()
      const vault = new Store(join(home, 'store'), env)
      const said = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        // Its folder is not there yet: the first listens fail.
        startConnectors(fakeCore(), { vault, env, port: await freePort(), offered: async () => ({}), retryMs: 5, platform: 'win32', pipePath: () => pipe })
        await vi.waitFor(() => expect(said.mock.calls.flat().join(' ')).toContain('the bridge\'s pipe is not listening'))
        mkdirSync(join(folder, 'p'))
        await vi.waitFor(() => expect(readBridgePipe(vault)?.pipe).toBe(pipe))
        expect(said.mock.calls.flat().filter(line => String(line).includes('pipe is not listening'))).toHaveLength(1)
      } finally { said.mockRestore(); rmSync(folder, { recursive: true, force: true }) }
    })
  })
})
