import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeCore } from '../testing/fakeCore.js'
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
    expect(await requests.connectors!({ action: 'list' }, OWNER)).toMatchObject({ signed_in: false })
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
    expect(await requests.connectors!({ action: 'nope' }, OWNER)).toEqual({ error: 'CONNECTORS_FAILED', detail: 'Unknown action.' })
    expect(await requests.connectors!({ action: 'custom', name: 'Mine', url: 'https://mine.example/mcp', headers: { Authorization: 'Bearer pat' } }, OWNER))
      .toEqual({ connector: 'mine', state: 'connected' })
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
