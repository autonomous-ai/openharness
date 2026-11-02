import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgePort, saveBridgePort } from '../lib/connectors/agents.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore } from '../testing/fakeCore.js'
import type { BackendNotice } from '../core/api.js'
import { CONNECTORS_REQUESTS, startConnectors } from './connectors.js'
import { Store } from '../lib/connectors/store.js'
import * as gateway from '../lib/connectors/gateway.js'
import { FakeGateway } from '../testing/connectorServers.js'

const OWNER = { local: true, owner: true }

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
  afterEach(() => { gateway.backend.signedIn = signedIn; rmSync(home, { recursive: true, force: true }) })

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
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
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
      expect(await fetch(`http://127.0.0.1:${moved}/x/linear/mcp`, { method: 'POST', body: '{}' }).then(answer => answer.status)).toBe(404)
      // Once the holder lets go, agents still on the old address recover: the bridge answers there too.
      await new Promise<void>(resolve => holder.close(() => resolve()))
      let status = 0
      for (let n = 0; n < 200 && !status; n++) {
        await new Promise(resolve => setTimeout(resolve, 10))
        status = await fetch(`http://127.0.0.1:${taken}/x/linear/mcp`, { method: 'POST', body: '{}' }).then(answer => answer.status, () => 0)
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
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
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
        status = await fetch(`http://127.0.0.1:${taken}/x/linear/mcp`, { method: 'POST', body: '{}' }).then(answer => answer.status, () => 0)
      }
      expect(status).toBe(404)
    } finally {
      said.mockRestore()
      holder.close()
    }
  // Its waits add up past the default 5 s on a loaded machine: it timed out once in a full coverage run.
  }, 30_000)

  it('does not move on one answer: a handover ending just then reads as another account, so it tries the port again first', async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
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

  it('says so when the port it moved to cannot be saved', async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
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

  it('waits for its port while another process holds it', async () => {
    const holder = createServer()
    await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve))
    const port = (holder.address() as { port: number }).port
    startConnectors(fakeCore(), { vault: new Store(join(home, 'store'), env), env, port, offered: async () => ({}), retryMs: 20 })
    await new Promise(resolve => setTimeout(resolve, 60))
    await new Promise<void>(resolve => holder.close(() => resolve()))
    // Once the holder lets go, the bridge takes the port: a request is answered (refused, with no key).
    let status = 0
    for (let n = 0; n < 40 && !status; n++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      status = await fetch(`http://127.0.0.1:${port}/x/linear/mcp`, { method: 'POST', body: '{}' }).then(answer => answer.status, () => 0)
    }
    expect(status).toBe(404)
  })
})
