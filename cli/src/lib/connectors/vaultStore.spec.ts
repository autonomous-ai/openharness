import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, writePrivate, type Client, type Token } from './store.js'
import { snapshotOf, type Snapshot } from './vaultSnapshot.js'
import { VaultStore, vaultStoreIo } from './vaultStore.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const now = Math.floor(Date.now() / 1000)
const token = (key: string, at: number): Token => ({ access_token: key, source: 'dcr', obtained_at: at,
  issuer: 'https://synthetic.example', mcp_entry: { url: 'https://synthetic.example/mcp', headers: {} } })
const client = (id: string): Client => ({ client_id: id, client_secret: 'synthetic', authorization_endpoint: 'https://synthetic.example/auth',
  token_endpoint: 'https://synthetic.example/token', token_endpoint_auth_method: 'client_secret_post', redirect_uri: 'http://127.0.0.1/callback', registered_at: 1 })
const remote = (): Snapshot => ({ v: 1, connections: { linear: { token: token('synthetic-new', now), client: client('new') } }, removed: { notion: now } })
const noGuard = () => {}

describe('gateway connector storage under the legacy lock', () => {
  let home: string, root: string, vault: Store
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'vault-store-'))
    root = join(home, 'connections')
    vault = new Store(root, { HOME: home })
    vault.save('linear', token('synthetic-old', now - 20))
    vault.save('notion', token('synthetic-removed', now - 20))
    vault.saveClient('https://synthetic.example', client('old'))
  })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('merges only after the old writer releases its lock, preserving a concurrent renewal', async () => {
    closeSync(openSync(join(root, '.lock'), 'wx', 0o600))
    const wait = vi.fn(async () => {
      // The supported old Store writer, already holding the same lock, renews before releasing it.
      vault.put('linear', token('synthetic-newest', now + 10))
      rmSync(join(root, '.lock'))
    })
    const writer = new VaultStore(root, { ...vaultStoreIo, wait })
    const result = await writer.merge(remote(), noGuard)
    expect(wait).toHaveBeenCalledTimes(1)
    expect(result.connections.linear.token.access_token).toBe('synthetic-newest')
    expect(vault.token('linear')?.access_token).toBe('synthetic-newest')
    expect(vault.token('notion')).toBeUndefined()
  })

  for (const failAt of [0, 1, 2]) {
    it(`recovers after publication prefix ${failAt}, without acknowledging a partial write`, async () => {
      let writes = 0, fail = true
      const io: typeof vaultStoreIo = { ...vaultStoreIo, rename: (from, to) => {
        if (fail && writes++ === failAt) throw new Error('synthetic-publication-fault')
        vaultStoreIo.rename(from, to)
      } }
      const writer = new VaultStore(root, io)
      await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_WRITE_UNCONFIRMED' })
      expect(existsSync(join(root, '.lock'))).toBe(false)
      fail = false
      const result = await writer.merge(remote(), noGuard)
      expect(result).toEqual(remote())
      expect(snapshotOf(vault)).toEqual(remote())
    })
  }

  for (const stage of ['open', 'writeFile', 'sync', 'close'] as const) {
    it(`invalidation during temporary ${stage} cannot publish and retains ownership until settlement`, async () => {
      const entered = deferred(), release = deferred()
      let valid = true, paused = false
      const opened = new Set<FileHandle>()
      const io: typeof vaultStoreIo = { ...vaultStoreIo, open: async (file, flags, mode) => {
        const handle = await vaultStoreIo.open(file, flags, mode)
        opened.add(handle)
        const temporary = String(file).includes('.incoming-')
        const pause = async () => { if (!paused && temporary) { paused = true; entered.resolve(); await release.promise } }
        if (stage === 'open') await pause()
        return new Proxy(handle, { get(target, property) {
          if (property === 'close') return async () => {
            try { await target.close(); if (stage === 'close') await pause() }
            finally { opened.delete(target) }
          }
          if (property === stage && (stage === 'writeFile' || stage === 'sync')) return async (...args: unknown[]) => {
            const call = (stage === 'writeFile' ? target.writeFile : target.sync) as (...args: unknown[]) => Promise<unknown>
            await call.apply(target, args); await pause()
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      } }
      const writer = new VaultStore(root, io)
      const guard = () => { if (!valid) throw new Error('generation invalid') }
      const running = writer.merge(remote(), guard)
      const outcome = running.then(() => null, error => error)
      await entered.promise
      valid = false
      await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_BUSY' })
      expect(existsSync(join(root, '.lock'))).toBe(true)
      expect(vault.token('linear')?.access_token).toBe('synthetic-old')
      release.resolve()
      expect(await outcome).toMatchObject({ code: 'STORE_UNAVAILABLE' })
      expect(opened.size).toBe(0)
      expect(existsSync(join(root, '.lock'))).toBe(false)
      expect(vault.token('linear')?.access_token).toBe('synthetic-old')
    })
  }

  it.skipIf(process.platform === 'win32')('treats final rename as publication and holds the slot while durability settles after invalidation', async () => {
    const entered = deferred(), release = deferred()
    let valid = true
    const io: typeof vaultStoreIo = { ...vaultStoreIo, open: async (file, flags, mode) => {
      const handle = await vaultStoreIo.open(file, flags, mode)
      if (String(file) !== root) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => { entered.resolve(); await release.promise; await target.sync() }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
    const writer = new VaultStore(root, io), changed = vi.fn()
    const running = writer.merge(remote(), () => { if (!valid) throw new Error('generation invalid') }, changed)
    await entered.promise
    valid = false
    expect(snapshotOf(vault)).toEqual(remote())
    expect(changed).not.toHaveBeenCalled()
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_BUSY' })
    release.resolve()
    expect(await running).toEqual(remote())
    expect(changed).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, '.lock'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('reports failed post-publication durability and confirms it before a later unchanged success', async () => {
    let fail = true, syncs = 0
    const io: typeof vaultStoreIo = { ...vaultStoreIo, open: async (file, flags, mode) => {
      const handle = await vaultStoreIo.open(file, flags, mode)
      if (String(file) !== root) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => { syncs++; if (fail) throw new Error('synthetic-fsync'); await target.sync() }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
    const writer = new VaultStore(root, io)
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_WRITE_UNCONFIRMED' })
    expect(snapshotOf(vault)).toEqual(remote())
    fail = false
    expect(await writer.merge(remote(), noGuard)).toEqual(remote())
    expect(syncs).toBe(2)
  })

  it.skipIf(process.platform === 'win32')('pins the published directory before durability and retains cleanup if its pathname is replaced', async () => {
    const entered = deferred(), release = deferred()
    const previous = join(home, 'previous')
    let held = false, syncedIdentity = ''
    const expected = vaultStoreIo.statNow(root).ino.toString()
    const io: typeof vaultStoreIo = { ...vaultStoreIo, open: async (file, flags, mode) => {
      if (String(file) === root && !held) { held = true; entered.resolve(); await release.promise }
      const handle = await vaultStoreIo.open(file, flags, mode)
      if (String(file) !== root) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => { syncedIdentity = (await target.stat({ bigint: true })).ino.toString(); await target.sync() }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
    const writer = new VaultStore(root, io)
    const outcome = writer.merge(remote(), noGuard).then(() => null, error => error)
    await entered.promise
    const before = vault.token('linear')?.access_token
    renameSync(root, previous); mkdirSync(root, { mode: 0o700 })
    release.resolve()
    expect(await outcome).toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(before).toBe('synthetic-old')
    expect(syncedIdentity).not.toBe(vaultStoreIo.statNow(root).ino.toString())
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(readdirSync(root)).toEqual([])
    rmSync(root, { recursive: true }); renameSync(previous, root)
    expect(await writer.merge(remote(), noGuard)).toEqual(remote())
    expect(syncedIdentity).toBe(expected)
    expect(existsSync(join(root, '.lock'))).toBe(false)
  })

  it('stores a prototype-named issuer as an own data key in the unchanged client document format', async () => {
    vault.saveClient('__proto__', client('local'))
    expect(Object.hasOwn(vault.file('clients.json'), '__proto__')).toBe(true)
    expect(vault.client('__proto__')).toEqual(client('local'))
    const theirs = remote()
    theirs.connections.linear.token.issuer = '__proto__'
    await new VaultStore(root).merge(theirs, noGuard)
    const clients = JSON.parse(readFileSync(join(root, 'clients.json'), 'utf8'))
    expect(Object.hasOwn(clients, '__proto__')).toBe(true)
    expect(clients.__proto__).toEqual(client('new'))
    expect(vault.client('__proto__')).toEqual(client('new'))
  })

  it.skipIf(process.platform === 'win32')('syncs the original descriptor when its published directory is replaced during fsync', async () => {
    const entered = deferred(), release = deferred(), changed = vi.fn()
    const expected = vaultStoreIo.statNow(root).ino.toString()
    let syncedIdentity = '', held = false
    const io: typeof vaultStoreIo = { ...vaultStoreIo, open: async (file, flags, mode) => {
      const handle = await vaultStoreIo.open(file, flags, mode)
      if (String(file) !== root) return handle
      return new Proxy(handle, { get(target, property) {
        if (property === 'sync') return async () => {
          if (!held) { held = true; entered.resolve(); await release.promise }
          syncedIdentity = (await target.stat({ bigint: true })).ino.toString()
          await target.sync()
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } }
    const writer = new VaultStore(root, io)
    const outcome = writer.merge(remote(), noGuard, changed).then(() => null, error => error)
    await entered.promise
    const previous = join(home, 'published')
    renameSync(root, previous); mkdirSync(root, { mode: 0o700 })
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_BUSY' })
    release.resolve()
    expect(await outcome).toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(syncedIdentity).toBe(expected)
    expect(changed).not.toHaveBeenCalled()
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    rmSync(root, { recursive: true }); renameSync(previous, root)
    expect(await writer.merge(remote(), noGuard, changed)).toEqual(remote())
    expect(changed).toHaveBeenCalledTimes(1)
    expect(existsSync(join(root, '.lock'))).toBe(false)
  })

  it('refuses a replaced lock or changed document immediately before publication', async () => {
    for (const change of ['lock', 'document']) {
      let edited = false
      const io = { ...vaultStoreIo, statNow: (file: string) => {
        if (file === join(root, '.lock') && !edited) {
          edited = true
          if (change === 'lock') {
            const previous = openSync(file, 'r')
            try { rmSync(file); closeSync(openSync(file, 'wx', 0o600)) }
            finally { closeSync(previous) }
          }
          else vault.put('linear', token('synthetic-newest', now + 20))
        }
        return vaultStoreIo.statNow(file)
      } }
      await expect(new VaultStore(root, io).merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_CHANGED' })
      if (change === 'lock') { expect(existsSync(join(root, '.lock'))).toBe(true); rmSync(join(root, '.lock')) }
      else expect(vault.token('linear')?.access_token).toBe('synthetic-newest')
    }
  })

  it('does not rewrite profile configuration for a credential-only renewal', async () => {
    const changed = vi.fn()
    const theirs = snapshotOf(vault)
    theirs.connections.linear.token = token('synthetic-renewed', now + 1)
    await new VaultStore(root).merge(theirs, noGuard, changed)
    expect(vault.token('linear')?.access_token).toBe('synthetic-renewed')
    expect(changed).not.toHaveBeenCalled()
  })

  it('retains failed temporary cleanup and refuses fresh preparation until it is reconciled', async () => {
    let failWrite = true, failCleanup = true, prepared = 0
    const io: typeof vaultStoreIo = { ...vaultStoreIo,
      unlink: file => {
        if (String(file).includes('.incoming-') && failCleanup) throw Object.assign(new Error('synthetic-denied'), { code: 'EACCES' })
        vaultStoreIo.unlink(file)
      },
      open: async (file, flags, mode) => {
        const handle = await vaultStoreIo.open(file, flags, mode)
        if (!String(file).includes('.incoming-')) return handle
        prepared++
        return new Proxy(handle, { get(target, property) {
          if (property === 'writeFile') return async (...args: unknown[]) => {
            if (failWrite) throw new Error('synthetic-write-fault')
            await (target.writeFile as (...args: unknown[]) => Promise<void>).apply(target, args)
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
      },
    }
    const writer = new VaultStore(root, io)
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(readdirSync(root).filter(name => name.startsWith('.incoming-'))).toHaveLength(1)
    expect(existsSync(join(root, '.lock'))).toBe(true)
    await expect(writer.merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(prepared).toBe(1)
    failWrite = false; failCleanup = false
    expect(await writer.merge(remote(), noGuard)).toEqual(remote())
    expect(readdirSync(root).filter(name => name.startsWith('.incoming-'))).toEqual([])
    expect(existsSync(join(root, '.lock'))).toBe(false)
  })

  it('does not acknowledge or notify while its published write still owns an unreleased lock', async () => {
    let failCleanup = true
    const io: typeof vaultStoreIo = { ...vaultStoreIo, unlink: file => {
      if (String(file) === join(root, '.lock') && failCleanup) throw Object.assign(new Error('synthetic-denied'), { code: 'EACCES' })
      vaultStoreIo.unlink(file)
    } }
    const changed = vi.fn(() => { expect(existsSync(join(root, '.lock'))).toBe(false) })
    const writer = new VaultStore(root, io)
    await expect(writer.merge(remote(), noGuard, changed)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(snapshotOf(vault)).toEqual(remote())
    expect(changed).not.toHaveBeenCalled()
    await expect(writer.merge(remote(), noGuard, changed)).rejects.toMatchObject({ code: 'STORE_CLEANUP_UNCONFIRMED' })
    expect(changed).not.toHaveBeenCalled()
    failCleanup = false
    expect(await writer.merge(remote(), noGuard, changed)).toEqual(remote())
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it.skipIf(process.platform === 'win32')('refuses oversized and linked input before parsing or changing it', async () => {
    const file = join(root, 'tokens.json')
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1), { mode: 0o600 })
    await expect(new VaultStore(root).merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    rmSync(file)
    const other = join(home, 'private.json')
    writePrivate(other, {})
    symlinkSync(other, file)
    await expect(new VaultStore(root).merge(remote(), noGuard)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' })
    expect(readFileSync(other, 'utf8')).toBe('{}\n')
  })
})
