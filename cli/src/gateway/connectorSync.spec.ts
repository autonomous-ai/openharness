import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GatewayAccount } from '../core/api.js'
import { Store } from '../lib/connectors/store.js'
import { b64e, newIdentity } from '../lib/e2ee/core.js'
import { openVault, sealVault } from '../lib/e2ee/connectorVault.js'
import { createGatewayConnectorSync } from './connectorSync.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const account = (id = 'a'): GatewayAccount => ({ machineId: `machine-${id}`, autonomousEnv: 'test', signIn: { epoch: id, adopted: false, at: 1, acct: id } })
const read = (revision = 0, envelope: unknown = null) => ({ status: 200, body: { success: true, data: { revision, envelope } } })

describe('gateway-owned connector synchronization', () => {
  let home: string
  const owners: Array<ReturnType<typeof createGatewayConnectorSync>> = []
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'gateway-vault-')) })
  afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.stop())); rmSync(home, { recursive: true, force: true }) })
  const make = (overrides: Partial<Parameters<typeof createGatewayConnectorSync>[0]> = {}) => {
    const me = newIdentity()
    const owner = createGatewayConnectorSync({
      root: join(home, 'connections'), account: () => account(), ready: () => true,
      backend: async () => read(),
      vault: { seal: async plain => ({ ...sealVault(plain, me, []) }), open: async () => null },
      changed: vi.fn(), log: vi.fn(), ...overrides,
    })
    owners.push(owner)
    return owner
  }

  it('status and signed-out refresh read no vault or backend, and offline refresh is explicit', async () => {
    const backend = vi.fn(async () => read())
    let current = { machineId: null, signIn: null } as GatewayAccount
    const owner = make({ account: () => current, backend })
    expect(await owner.sync(false)).toEqual({ shared: false })
    expect(await owner.sync(true)).toEqual({ shared: false })
    expect(backend).not.toHaveBeenCalled()
    current = account()
    expect(await owner.sync(false)).toEqual({ shared: true })
    expect(backend).not.toHaveBeenCalled()
    backend.mockResolvedValue({ status: 503, body: {} } as never)
    await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
  })

  it('coalesces any number of notices and admits only one Refresh waiter', async () => {
    const entered = deferred(), release = deferred()
    let reads = 0
    const backend = vi.fn(async () => {
      if (++reads === 1) { entered.resolve(); await release.promise }
      return read()
    })
    const owner = make({ backend })
    owner.accountChanged()
    await entered.promise
    const refresh = owner.sync(true)
    try {
      for (let i = 0; i < 1_000; i++) owner.changed(i)
      await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
      expect(await owner.sync(false)).toEqual({ shared: true })
      expect(reads).toBe(1)
    } finally { release.resolve() }
    expect(await refresh).toEqual({ shared: true })
    expect(reads).toBe(2)
  })

  it('does not apply a previous account response or send it under the replacement account', async () => {
    const entered = deferred(), release = deferred(), replaced = deferred()
    let current = account('a')
    const writes: Array<{ account: string | null; body: unknown }> = []
    const late = JSON.stringify({ v: 1, connections: { linear: { token: { access_token: 'synthetic-account-a', source: 'custom', obtained_at: 1 } } }, removed: {} })
    const backend = async (method: string, _path: string, body?: unknown) => {
      const owner = current.machineId
      if (method === 'PUT') { writes.push({ account: owner, body }); return read() }
      if (owner === 'machine-a') { entered.resolve(); await release.promise; return read(1, { late: true }) }
      replaced.resolve(); return read()
    }
    const owner = make({ account: () => current, backend, vault: { seal: async () => ({}), open: async () => ({ plaintext: late, complete: true }) } })
    owner.accountChanged()
    await entered.promise
    current = account('b')
    owner.accountChanged()
    try { await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE') }
    finally { release.resolve() }
    await replaced.promise
    expect(await owner.sync(true)).toEqual({ shared: true })
    expect(new Store(join(home, 'connections')).tokens()).toEqual({})
    expect(writes).toEqual([])
  })

  it('waits for an issued write to settle after stop, without retrying its conflict result', async () => {
    const entered = deferred(), release = deferred()
    const root = join(home, 'connections')
    new Store(root).save('linear', { access_token: 'synthetic-local', source: 'custom', obtained_at: 1 })
    let writes = 0
    const owner = make({ backend: async method => {
      if (method === 'GET') return read()
      writes++; entered.resolve(); await release.promise
      return { status: 200, body: { success: true, data: { written: false, revision: 1, envelope: {} } } }
    } })
    owner.accountChanged()
    await entered.promise
    let stopped = false
    const stopping = owner.stop().then(() => { stopped = true })
    expect(stopped).toBe(false)
    await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
    release.resolve()
    await stopping
    expect(writes).toBe(1)
    expect(new Store(root).token('linear')?.access_token).toBe('synthetic-local')
  })

  it('gates secret work on current verified-log readiness, with no owner-login fallback', async () => {
    let ready = false
    const backend = vi.fn(async () => read())
    const owner = make({ ready: () => ready, backend })
    owner.accountChanged()
    await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
    expect(backend).not.toHaveBeenCalled()
    ready = true
    owner.changed(null)
    expect(await owner.sync(true)).toEqual({ shared: true })
    expect(backend).toHaveBeenCalledWith('GET', '/api/connector-vault', undefined, expect.any(Number))
  })

  it('irreversibly revokes a pending exchange when trust is lost and restored under the same account', async () => {
    const entered = deferred(), release = deferred(), restarted = deferred()
    let ready = true, reads = 0
    const late = JSON.stringify({ v: 1, connections: { linear: { token: { access_token: 'synthetic-old-trust', source: 'custom', obtained_at: 1 } } }, removed: {} })
    const owner = make({ ready: () => ready,
      backend: async () => {
        if (++reads === 1) { entered.resolve(); await release.promise; return read(1, { late: true }) }
        restarted.resolve(); return read()
      },
      vault: { seal: async () => ({}), open: async () => ({ plaintext: late, complete: true }) },
    })
    owner.accountChanged()
    await entered.promise
    ready = false; owner.accountChanged()
    ready = true; owner.accountChanged()
    try {
      await expect(owner.sync(true)).rejects.toThrow('CONNECTORS_SYNC_UNAVAILABLE')
      expect(reads).toBe(1)
    } finally { release.resolve() }
    await restarted.promise
    expect(await owner.sync(true)).toEqual({ shared: true })
    expect(new Store(join(home, 'connections')).tokens()).toEqual({})
  })

  it('shares through real envelope crypto while core-facing results and notices carry no credential', async () => {
    const a = newIdentity(), b = newIdentity()
    const trusted = new Set([b64e(a.pub), b64e(b.pub)])
    let revision = 0, envelope: Record<string, unknown> | null = null
    const backend = async (method: string, _path: string, body?: unknown) => {
      if (method === 'GET') return read(revision, envelope)
      const write = body as { base: number; envelope: Record<string, unknown> }
      const written = write.base === revision
      if (written) { revision++; envelope = write.envelope }
      return { status: 200, body: { success: true, data: { written, revision, envelope } } }
    }
    const outputs: unknown[] = []
    const local = new Store(join(home, 'a'))
    local.save('linear', { access_token: 'synthetic-core-custody-canary', source: 'custom', obtained_at: 1 })
    const ownerFor = (identity: typeof a, root: string) => make({ root, backend, changed: () => outputs.push({ type: 'connectors_changed' }),
      vault: {
        seal: async plain => ({ ...sealVault(plain, identity, trusted) }),
        open: async sealed => { const plaintext = openVault(sealed, identity, trusted); return plaintext === null ? null : { plaintext, complete: true } },
      },
    })
    const first = ownerFor(a, join(home, 'a'))
    outputs.push(await first.sync(true))
    const second = ownerFor(b, join(home, 'b'))
    outputs.push(await second.sync(true))
    expect(new Store(join(home, 'b')).token('linear')?.access_token).toBe('synthetic-core-custody-canary')
    expect(JSON.stringify(outputs)).not.toContain('synthetic-core-custody-canary')
    expect(JSON.stringify(envelope)).not.toContain('synthetic-core-custody-canary')
  })
})
