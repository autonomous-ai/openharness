/**
 * The account's connections kept the same on every computer (vaultSync.ts): the merge, and two computers
 * against one backend that keeps an envelope under a revision, as routes/connectorVault.ts does.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Client, type Token } from './store.js'
import { merge, parseSnapshot, snapshotOf, VaultSync, vaultPortOf, type Snapshot, type VaultPort } from './vaultSync.js'

const token = (access: string, obtained: number, extra: Partial<Token> = {}): Token => ({
  access_token: access, refresh_token: `r-${access}`, source: 'dcr', issuer: 'https://mcp.linear.app', obtained_at: obtained,
  mcp_entry: { url: 'https://mcp.linear.app/mcp', headers: { Authorization: `Bearer ${access}` } }, ...extra,
})
const client = (id: string): Client => ({ client_id: id, client_secret: '', token_endpoint_auth_method: 'none', authorization_endpoint: 'https://linear.app/authorize',
  token_endpoint: 'https://linear.app/token', redirect_uri: 'http://127.0.0.1:51789/callback', registered_at: 1 })
const snap = (connections: Snapshot['connections'], removed: Snapshot['removed'] = {}): Snapshot => ({ v: 1, connections, removed })

describe('merging two computers\' connections', () => {
  const now = 2_000_000_000

  it('keeps the token issued last, and a disconnect over every older one', () => {
    const a = snap({ linear: { token: token('a1', now - 300) }, notion: { token: token('n1', now - 300) } })
    const b = snap({ linear: { token: token('b2', now - 100) } }, { notion: now - 200 })
    const merged = merge(a, b, now)
    expect(merged.connections.linear.token.access_token).toBe('b2')
    expect(merged.connections.notion).toBeUndefined()
    expect(merged.removed).toEqual({ notion: now - 200 })
    // Connected again after the disconnect: the newer connection stays.
    expect(merge(snap({ notion: { token: token('n2', now - 100) } }), b, now).connections.notion.token.access_token).toBe('n2')
  })

  it('lets a renewal made in time beat the stale copy another computer could not renew', () => {
    // A renewed (rotating the refresh token) while B, too late, tried the old one and marked it.
    const a = snap({ linear: { token: token('fresh', 300) } })
    const b = snap({ linear: { token: token('old', 200, { needs_reconnect: true }) } })
    expect(merge(a, b, now).connections.linear.token).toMatchObject({ access_token: 'fresh' })
    expect(merge(b, a, now).connections.linear.token.needs_reconnect).toBeUndefined()
    // The same token, dead on one computer: dead on all.
    const same = merge(snap({ linear: { token: token('t', 200) } }), b, now)
    expect(same.connections.linear.token.needs_reconnect).toBe(true)
  })

  it('carries the OAuth client a token was issued to, and forgets old disconnects', () => {
    const merged = merge(snap({ linear: { token: token('a', 1), client: client('c1') } }), snap({}, { old: now - 400 * 24 * 3600 }), now)
    expect(merged.connections.linear.client?.client_id).toBe('c1')
    expect(merged.removed).toEqual({})
  })

  it('takes from another computer only what this one would write itself', () => {
    expect(parseSnapshot('not json')).toBeNull()
    expect(parseSnapshot('{"v":2}')).toBeNull()
    const parsed = parseSnapshot(JSON.stringify({ v: 1, removed: { x: 'soon', y: 5 }, connections: {
      linear: { token: token('a', 1), client: { ...client('c'), token_endpoint: 'http://evil.example/token' } },
      bad: { token: { mcp_entry: { url: 'ftp://x', headers: {} } } },
    } }))!
    expect(Object.keys(parsed.connections)).toEqual(['linear'])
    expect(parsed.connections.linear.client).toBeUndefined()
    expect(parsed.removed).toEqual({ y: 5 })
  })
})

/** The backend: one envelope under a revision, written only over the revision it was read at. Sealing is
 *  plain JSON here, sealed "for" a set of machines; the real envelope is lib/e2ee/connectorVault.ts. */
class FakeBackend {
  revision = 0
  envelope: { plaintext: string, for: string[] } | null = null
  writes = 0
  machines = ['A', 'B']
  port(machine: string): VaultPort {
    return {
      read: async () => ({ revision: this.revision, envelope: this.envelope }),
      write: async (base, envelope) => {
        if (base !== this.revision) return { written: false, revision: this.revision, envelope: this.envelope }
        this.revision++; this.writes++
        this.envelope = envelope as unknown as FakeBackend['envelope']
        return { written: true, revision: this.revision, envelope: this.envelope }
      },
      seal: async (plaintext) => ({ plaintext, for: [...this.machines] }),
      open: async (envelope) => {
        const e = envelope as FakeBackend['envelope']
        // Sealed for none of the account's machines: nobody will open it (the gateway says so, gateway/start.ts).
        if (e && !e.for.some(m => this.machines.includes(m))) return { stranded: true }
        return e && e.for.includes(machine) ? { plaintext: e.plaintext, complete: this.machines.every(m => e.for.includes(m)) } : null
      },
    }
  }
}

describe('two computers and the backend', () => {
  let home: string
  const env = () => ({ HOME: home, PATH: '', XDG_CONFIG_HOME: join(home, '.config') })
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'vault-sync-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })
  const computer = (name: string, backend: FakeBackend) => {
    const vault = new Store(join(home, name), env())
    return { vault, sync: new VaultSync({ vault, port: backend.port(name), env: env() }) }
  }

  it('hands a connection made on one computer to the other, and its renewal and disconnect too', async () => {
    const backend = new FakeBackend()
    const a = computer('A', backend), b = computer('B', backend)
    a.vault.save('linear', token('a1', 100))
    a.vault.saveClient('https://mcp.linear.app', client('c-a'))
    await a.sync.run()
    expect(backend.revision).toBe(1)
    await b.sync.run()
    expect(b.vault.token('linear')?.access_token).toBe('a1')
    expect(b.vault.client('https://mcp.linear.app')?.client_id).toBe('c-a')

    // B renews it; A hears `connectors_changed` and takes the renewal.
    b.vault.save('linear', token('b2', 200))
    await b.sync.run()
    await a.sync.run()
    expect(a.vault.token('linear')?.access_token).toBe('b2')

    // A disconnects it; B drops it without recording a disconnect of its own.
    a.vault.disconnect('linear')
    await a.sync.run()
    await b.sync.run()
    expect(b.vault.token('linear')).toBeUndefined()
    expect(b.vault.removed()).toHaveProperty('linear')
    const writes = backend.writes
    await a.sync.run(); await b.sync.run()
    expect(backend.writes).toBe(writes)
  })

  it('merges into a newer envelope when another computer wrote first', async () => {
    const backend = new FakeBackend()
    const a = computer('A', backend), b = computer('B', backend)
    a.vault.save('linear', token('a1', 100))
    b.vault.save('notion', token('n1', 100, { mcp_entry: { url: 'https://mcp.notion.com/mcp', headers: {} } }))
    await a.sync.run()
    await b.sync.run()
    await a.sync.run()
    for (const side of [a, b]) expect(Object.keys(snapshotOf(side.vault).connections).sort()).toEqual(['linear', 'notion'])
  })

  it('writes nothing over an envelope not sealed for this computer, and seals again for one added since', async () => {
    const backend = new FakeBackend()
    backend.machines = ['A']
    const a = computer('A', backend), c = computer('C', backend)
    a.vault.save('linear', token('a1', 100))
    await a.sync.run()
    c.vault.save('notion', token('n1', 100))
    await c.sync.run()
    // C could not open it: nothing of C's replaced what A keeps there.
    expect(JSON.parse(backend.envelope!.plaintext).connections).toHaveProperty('linear')
    expect(backend.envelope!.for).toEqual(['A'])
    // C is a machine of the account now (`device_keys_changed`): A, which can open it, seals it for C.
    backend.machines = ['A', 'C']
    a.sync.changed(null)
    await a.sync.run()
    expect(backend.envelope!.for).toEqual(['A', 'C'])
    await c.sync.run()
    expect(Object.keys(snapshotOf(c.vault).connections).sort()).toEqual(['linear', 'notion'])
  })

  it('replaces an envelope sealed only for computers the account no longer has, so the ones it has share again', async () => {
    const backend = new FakeBackend()
    // Written by a computer since signed out (its key gone from the log), sealed for it and one other gone.
    backend.envelope = { plaintext: JSON.stringify({ v: 1, connections: { old: { token: token('o1', 50) } }, removed: {} }), for: ['X', 'Y'] }
    backend.revision = 3
    const logged: string[] = []
    const vault = new Store(join(home, 'A'), env())
    const a = { vault, sync: new VaultSync({ vault, port: backend.port('A'), env: env(), log: (line) => logged.push(line) }) }
    const b = computer('B', backend)
    a.vault.save('exa', token('e1', 100))
    await a.sync.run()
    expect(logged).toEqual([expect.stringContaining('sealed for computers no longer in the account')])
    expect(backend.envelope!.for).toEqual(['A', 'B'])
    expect(Object.keys(JSON.parse(backend.envelope!.plaintext).connections)).toEqual(['exa'])
    await b.sync.run()
    expect(Object.keys(snapshotOf(b.vault).connections)).toEqual(['exa'])
  })

  it('reads a backend it cannot reach as nothing to do', async () => {
    const port = vaultPortOf(async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }))
    const a = new VaultSync({ vault: new Store(join(home, 'A'), env()), port, env: env() })
    await a.run()
    expect(await port.read()).toBeNull()
    expect(await port.open({})).toBeNull()
    await expect(port.seal('x')).rejects.toThrow('could not seal')
  })

  it('reads the core\'s answers as the backend and the gateway give them', async () => {
    const calls: Array<[string, unknown]> = []
    const port = vaultPortOf(async (op, payload) => {
      calls.push([op, payload])
      if (op === 'read') return { status: 200, body: { success: true, data: { revision: 3, envelope: { e: 1 } } } }
      if (op === 'write') return { status: 200, body: { success: true, data: { written: false, revision: 4, envelope: { e: 2 } } } }
      if (op === 'seal') return { envelope: { sealed: true } }
      return { plaintext: '{}', complete: true }
    })
    expect(await port.read()).toEqual({ revision: 3, envelope: { e: 1 } })
    expect(await port.write(3, { x: 1 })).toEqual({ written: false, revision: 4, envelope: { e: 2 } })
    expect(await port.seal('p')).toEqual({ sealed: true })
    expect(await port.open({ e: 1 })).toEqual({ plaintext: '{}', complete: true })
    expect(await vaultPortOf(async () => ({ stranded: true })).open({ e: 1 })).toEqual({ stranded: true })
    expect(calls.map(([op]) => op)).toEqual(['read', 'write', 'seal', 'open'])
  })
})
