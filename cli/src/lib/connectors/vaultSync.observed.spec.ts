/** A completed exchange acknowledges only the exact files it read or published, never a later writer. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store, type Token } from './store.js'
import { VaultStore, vaultStoreIo } from './vaultStore.js'
import { VaultSync, snapshotOf, type Snapshot, type VaultPort } from './vaultSync.js'

vi.mock('node:fs/promises', async original => {
  const io = await original<typeof import('node:fs/promises')>()
  return { ...io, stat: vi.fn(io.stat), lstat: vi.fn(io.lstat) }
})

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const token = (value: string, at: number): Token => ({ access_token: value, source: 'dcr', obtained_at: at,
  issuer: 'https://synthetic.example', mcp_entry: { url: 'https://synthetic.example/mcp', headers: {} } })
let home: string, root: string, vault: Store, writer: VaultStore, sync: VaultSync
let remote: Snapshot, available: boolean, authorized: boolean, reads: number, logs: string[], probeDenied: boolean
let observed: ReturnType<typeof deferred> | null, probes: number
const files = new Set(['tokens.json', 'clients.json', 'removed.json'])

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'vault-observed-')); root = join(home, 'connections')
  vault = new Store(root, { HOME: home }); vault.save('linear', token('synthetic-old', 100))
  writer = new VaultStore(root); remote = snapshotOf(vault)
  available = true; authorized = true; reads = 0; logs = []; probeDenied = false; observed = null; probes = 0
  // Both generations use actual filesystem metadata; the barrier waits for the poll's OS probes, not elapsed time.
  const realIo = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  for (const method of ['stat', 'lstat'] as const) {
    const original = realIo[method]
    vi.spyOn(fs, method).mockImplementation((async (...args: Parameters<typeof original>) => {
      const path = String(args[0])
      try {
        if (probeDenied && path === join(root, 'tokens.json')) throw Object.assign(new Error('synthetic-probe-denied'), { code: 'EACCES' })
        const result = await original(args[0], args[1])
        if (path === root && (!result.isDirectory() || result.isSymbolicLink())) setImmediate(() => observed?.resolve())
        return result
      } finally {
        if ([...files].some(name => path === join(root, name)) && ++probes === 3) setImmediate(() => observed?.resolve())
      }
    }) as typeof original)
  }
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
})

afterEach(async () => {
  sync?.stop(); await sync?.settled()
  vi.useRealTimers(); vi.restoreAllMocks(); rmSync(home, { recursive: true, force: true })
})

const port = (): VaultPort => ({
  read: async () => { reads++; return available ? { revision: 1, envelope: { plaintext: JSON.stringify(remote) } } : null },
  open: async envelope => ({ plaintext: (envelope as { plaintext: string }).plaintext, complete: true }),
  seal: async plaintext => ({ plaintext }),
  write: async (_base, envelope) => {
    remote = JSON.parse(String(envelope.plaintext)) as Snapshot
    return { written: true, revision: 2, envelope }
  },
})
async function start(selectedPort: VaultPort = port()) {
  sync = new VaultSync({ vault, store: writer, port: selectedPort, current: () => authorized, log: line => logs.push(line) })
  sync.start(); await sync.settled()
}
async function poll() {
  probes = 0; observed = deferred()
  await vi.advanceTimersByTimeAsync(5_000)
  await observed.promise
  await sync.settled()
  observed = null
}

it('records successful startup and warm Refresh versions before the first and second poll', async () => {
  await start(); expect(await sync.run()).toBe('synced'); reads = 0
  await poll(); await poll()
  expect(reads).toBe(0)
})

it('does not echo its own changed-envelope publication on the next poll', async () => {
  await start(); await poll()
  remote = { ...remote, connections: { linear: { token: token('synthetic-new', 200) } } }
  expect(await sync.run()).toBe('synced')
  expect(vault.token('linear')?.access_token).toBe('synthetic-new')
  reads = 0; await poll(); await poll()
  expect(reads).toBe(0)
})

it('discards an older metadata probe after a concurrent exchange published newer versions', async () => {
  await start(); reads = 0
  const entered = deferred(), release = deferred(), version = writer.version.bind(writer)
  vi.spyOn(writer, 'version').mockImplementationOnce(async () => {
    const observed = await version()
    entered.resolve(); await release.promise
    return observed
  })
  try {
    await vi.advanceTimersByTimeAsync(5_000); await entered.promise
    remote = { ...remote, connections: { linear: { token: token('synthetic-new', 200) } } }
    expect(await sync.run()).toBe('synced')
    release.resolve(); await new Promise<void>(resolve => setImmediate(resolve)); await sync.settled()
    expect(reads).toBe(1)
    reads = 0; await poll(); expect(reads).toBe(0)
  } finally { release.resolve() }
})

it('includes an external renewal while HTTP is held, without echoing that observed version', async () => {
  const entered = deferred(), release = deferred(), original = port()
  const held = { ...original, read: async () => { entered.resolve(); await release.promise; return original.read() } }
  sync = new VaultSync({ vault, store: writer, port: held, current: () => authorized })
  sync.start(); await entered.promise
  vault.save('linear', token('synthetic-renewed', 300)); release.resolve(); await sync.settled()
  expect(reads).toBe(1)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-renewed')
  reads = 0; await poll()
  expect(reads).toBe(0)
})

it('does not acknowledge an edit after the writer released its lock but before returning', async () => {
  await start(); await poll()
  const merge = writer.merge.bind(writer)
  vi.spyOn(writer, 'merge').mockImplementationOnce(async (...args) => {
    const answer = await merge(...args)
    vault.save('linear', token('synthetic-later', 400))
    return answer
  })
  expect(await sync.run()).toBe('synced')
  expect(remote.connections.linear.token.access_token).toBe('synthetic-old')
  reads = 0; await poll()
  expect(reads).toBe(1)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-later')
})

it.skipIf(process.platform === 'win32')('detects an external renewal after publication while directory durability is still pending', async () => {
  const entered = deferred(), release = deferred()
  let pause = false
  writer = new VaultStore(root, { ...vaultStoreIo, open: async (...args) => {
    const handle = await vaultStoreIo.open(...args)
    if (String(args[0]) !== root) return handle
    return new Proxy(handle, { get(target, property) {
      if (property === 'sync') return async () => {
        if (pause) { pause = false; entered.resolve(); await release.promise }
        await target.sync()
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  await start(); await poll()
  remote = { ...remote, connections: { linear: { token: token('synthetic-published', 200) } } }
  pause = true
  const running = sync.run(); await entered.promise
  // A writer that ignores the shared lock must still not become acknowledged by an unrelated exchange.
  vault.put('linear', token('synthetic-after-publication', 300))
  release.resolve(); expect(await running).toBe('synced')
  expect(remote.connections.linear.token.access_token).toBe('synthetic-published')
  reads = 0; await poll()
  expect(reads).toBe(1)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-after-publication')
})

it('does not acknowledge a different destination substituted during publication', async () => {
  let replace = false
  writer = new VaultStore(root, { ...vaultStoreIo, rename: (from, to) => {
    vaultStoreIo.rename(from, to)
    if (replace && String(to) === join(root, 'tokens.json')) {
      replace = false
      vault.put('linear', token('synthetic-substitute', 400))
    }
  } })
  await start(); await poll(); reads = 0
  remote = { ...remote, connections: { linear: { token: token('synthetic-published', 200) } } }
  replace = true
  expect(await sync.run()).toBe('unconfirmed')
  expect(logs).toContain('[connectors] synchronization STORE_WRITE_UNCONFIRMED')
  await poll()
  expect(reads).toBe(2)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-substitute')
})

it.each(['replacement', 'removed', 'appeared'] as const)('detects a document that was %s after successful synchronization', async change => {
  await start(); await poll(); reads = 0
  const path = join(root, change === 'appeared' ? 'clients.json' : 'tokens.json')
  if (change === 'replacement') {
    const before = lstatSync(path), temporary = join(root, 'external-replacement')
    writeFileSync(temporary, readFileSync(path), { mode: 0o600 }); utimesSync(temporary, before.atime, before.mtime)
    renameSync(temporary, path)
  } else if (change === 'removed') rmSync(path)
  else writeFileSync(path, '{}\n', { mode: 0o600, flag: 'wx' })
  await poll()
  expect(reads).toBe(1)
  reads = 0; await poll()
  expect(reads).toBe(0)
})

it('does not acknowledge changed files when the backend exchange failed', async () => {
  await start(); await poll(); reads = 0
  vault.save('linear', token('synthetic-retry', 500)); available = false
  await poll(); expect(reads).toBe(1)
  available = true; await poll()
  expect(reads).toBe(2)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-retry')
})

it('does not acknowledge changed files when account authority is revoked after merge', async () => {
  await start(); await poll(); reads = 0
  vault.save('linear', token('synthetic-current', 600))
  const merge = writer.merge.bind(writer)
  vi.spyOn(writer, 'merge').mockImplementationOnce(async (...args) => { const answer = await merge(...args); authorized = false; return answer })
  await poll(); expect(reads).toBe(1)
  authorized = true; await poll()
  expect(reads).toBe(2)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-current')
})

it('keeps denied metadata unknown and reports a fixed error without exchanging', async () => {
  await start(); await poll(); reads = 0; probeDenied = true
  await poll()
  expect(reads).toBe(0)
  expect(logs).toContain('[connectors] synchronization STORE_UNAVAILABLE')
  expect(logs.join('\n')).not.toContain(root)
  probeDenied = false; vault.save('linear', token('synthetic-after-denial', 700)); await poll()
  expect(reads).toBe(1)
})

it('keeps the metadata check charged until every probe settles after a sibling failure', async () => {
  await start()
  const entered = deferred(), release = deferred(), settled = deferred()
  const lstat = vi.mocked(fs.lstat).getMockImplementation()!
  let calls = 0
  vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    calls++
    if (String(args[0]) === join(root, 'clients.json')) {
      entered.resolve(); await release.promise
      try { return await lstat(args[0], args[1]) } finally { settled.resolve() }
    }
    return lstat(args[0], args[1])
  }) as typeof fs.lstat)
  probeDenied = true
  try {
    await vi.advanceTimersByTimeAsync(5_000); await entered.promise
    await new Promise<void>(resolve => setImmediate(resolve))
    const outstanding = calls
    await vi.advanceTimersByTimeAsync(5_000)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(calls).toBe(outstanding)
  } finally {
    release.resolve(); await settled.promise
    await new Promise<void>(resolve => setImmediate(resolve))
  }
})

it.skipIf(process.platform === 'win32')('refuses a directory alias even when it reaches the same document versions', async () => {
  await start(); await poll(); reads = 0
  const moved = join(home, 'moved'); renameSync(root, moved); symlinkSync(moved, root, 'dir')
  await poll()
  expect(reads).toBe(0)
  expect(logs).toContain('[connectors] synchronization STORE_UNAVAILABLE')
  rmSync(root); mkdirSync(root, { mode: 0o700 }); await poll()
  expect(reads).toBe(1)
})


it.each(['unavailable', 'failed'] as const)('rechecks local versions after a backend write is %s', async failure => {
  const selected = port(), write = selected.write
  let fail = false
  selected.write = async (...args) => {
    if (fail) {
      if (failure === 'failed') throw new Error('synthetic-backend-unavailable')
      return null
    }
    return write(...args)
  }
  await start(selected); await poll()
  vault.save('linear', token('synthetic-local', 300))
  fail = true; reads = 0
  await poll(); expect(reads).toBe(1)
  fail = false
  await poll(); expect(reads).toBe(2)
  expect(remote.connections.linear.token.access_token).toBe('synthetic-local')
  await poll(); expect(reads).toBe(2)
})

it('does not acknowledge file versions when authority is revoked during a held backend write', async () => {
  const selected = port(), write = selected.write
  const writing = deferred(), release = deferred()
  let hold = false
  selected.write = async (...args) => {
    if (hold) { writing.resolve(); await release.promise }
    return write(...args)
  }
  await start(selected); await poll()
  vault.save('linear', token('synthetic-local', 300))
  hold = true
  const pending = poll()
  await writing.promise
  authorized = false; release.resolve(); await pending
  authorized = true; hold = false; reads = 0
  await poll(); expect(reads).toBe(1)
  await poll(); expect(reads).toBe(1)
})
