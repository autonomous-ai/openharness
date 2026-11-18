import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentCreationReceipts, creationFingerprint } from '../lib/agentCreationReceipt.js'
import { createPendingCreationIndex } from './pendingCreations.js'
import { directorySyncSupported } from '../lib/secureState.js'

const faults = vi.hoisted(() => ({ afterClose: undefined as ((fd: number) => void) | undefined,
  afterRead: undefined as ((path: string, entry: import('node:fs').Dirent | null) => void) | undefined,
  closed: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), closeSync: (fd: number) => { actual.closeSync(fd); faults.afterClose?.(fd) } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, opendir: async (...args: Parameters<typeof actual.opendir>) => {
    const dir = await actual.opendir(...args), read = dir.read.bind(dir), close = dir.close.bind(dir), closeSync = dir.closeSync.bind(dir)
    dir.read = (async () => { const entry = await read(); faults.afterRead?.(dir.path, entry); return entry }) as typeof dir.read
    dir.close = (async () => { await close(); faults.closed.push(dir.path) }) as typeof dir.close
    dir.closeSync = () => { closeSync(); faults.closed.push(dir.path) }
    return dir
  } }
})
vi.mock('../lib/secureState.js', async original => {
  const actual = await original<typeof import('../lib/secureState.js')>()
  return { ...actual, directorySyncSupported: vi.fn(actual.directorySyncSupported) }
})

let root: string, directory: string, markers: string
const id = 'pending-worker-fixture-1', request = { kind: 'fixture', privateText: 'never sent in a discovery page' }
const fingerprint = creationFingerprint(request), held = { service: 'models', detail: 'Waiting for the model.' }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'creation-index-worker-')); directory = join(root, 'agent-creations'); markers = join(directory, '.pending-v1')
  faults.afterClose = undefined; faults.afterRead = undefined; faults.closed = []; vi.mocked(fs.fsyncSync).mockReset()
  vi.mocked(directorySyncSupported).mockReset()
})
afterEach(() => { faults.afterClose = undefined; faults.afterRead = undefined; vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) })
const deadline = () => performance.now() + 5_000
const key = (n: number) => `pending-worker-${String(n).padStart(6, '0')}`
function seed(id: string, pending = true) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const value = pending ? { version: 2, fingerprint, request, held, checksum: creationFingerprint({ fingerprint, request, held }) }
    : { version: 1, fingerprint, outcome: { state: 'created', agentId: 'fixture' } }
  writeFileSync(join(directory, `${id}.json`), JSON.stringify(value), { mode: 0o600 })
}
async function collect(index: ReturnType<typeof createPendingCreationIndex>) {
  const ids = new Set<string>(); let cursor: string | null = null, damaged = 0
  for (let n = 0; n < 100; n++) {
    const page = await index.page(cursor, deadline())
    expect(page.ids.length).toBeLessThanOrEqual(64); expect(page.damaged).toBeLessThanOrEqual(64)
    expect(JSON.stringify(page)).not.toContain(request.privateText)
    page.ids.forEach(id => ids.add(id)); damaged += page.damaged
    if (page.done) return { ids: [...ids].sort(), damaged }
    cursor = page.cursor
  }
  throw new Error('fixture scan did not finish')
}

it('flushes an uncached existing marker file before accepting its directory durability', () => {
  createPendingCreationIndex(directory).ensure(id)
  const files: boolean[] = []
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { files.push(fs.fstatSync(fd).isFile()) })
  createPendingCreationIndex(directory).ensure(id)
  expect(files[0]).toBe(true)
})

it('refuses a marker replaced after its flushed descriptor closes', () => {
  let flushed: number | undefined
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { if (fs.fstatSync(fd).isFile()) flushed = fd })
  faults.afterClose = fd => {
    if (fd !== flushed) return
    faults.afterClose = undefined
    const replacement = join(root, 'replacement')
    writeFileSync(replacement, '', { mode: 0o600 }); renameSync(replacement, join(markers, id))
  }
  expect(() => createPendingCreationIndex(directory).ensure(id)).toThrow()
})

it('rechecks its original directory after a read before touching a replacement marker and closes its scan', async () => {
  const receipts = new AgentCreationReceipts(directory)
  await receipts.run(id, fingerprint, async () => ({ state: 'created', agentId: 'fixture-agent' }))
  const primary = readFileSync(join(directory, `${id}.json`))
  const index = createPendingCreationIndex(directory); index.ensure(id)
  faults.afterRead = (path, entry) => {
    if (path !== markers || entry?.name !== id) return
    faults.afterRead = undefined
    renameSync(directory, `${directory}-prior`); mkdirSync(markers, { recursive: true, mode: 0o700 })
    writeFileSync(join(directory, `${id}.json`), primary, { mode: 0o600 }); writeFileSync(join(markers, id), '', { mode: 0o600 })
  }
  await expect(index.page(null, deadline())).rejects.toMatchObject({ code: 'changed' })
  expect(existsSync(join(markers, id))).toBe(true)
  expect(faults.closed).toEqual(expect.arrayContaining([directory, markers]))
})

it('reads an absent archive without creating a directory or flushing anything', async () => {
  expect(await createPendingCreationIndex(directory).page(null, deadline())).toMatchObject({ ids: [], done: true, damaged: 0 })
  expect(existsSync(directory)).toBe(false); expect(fs.fsyncSync).not.toHaveBeenCalled()
})

it('discovers bounded pending IDs across legacy history and preserves missing or damaged primary markers', async () => {
  const index = createPendingCreationIndex(directory)
  for (let n = 0; n < 140; n++) seed(key(n), n === 0 || n === 139)
  index.ensure(key(0)); index.ensure(key(1)); index.ensure(key(200)); index.ensure(key(201))
  writeFileSync(join(directory, `${key(201)}.json`), '{damaged', { mode: 0o600 })
  writeFileSync(join(directory, 'not-a-receipt.tmp'), 'ignored', { mode: 0o600 })
  const found = await collect(index)
  expect(found).toEqual({ ids: [key(0), key(139)], damaged: 2 })
  expect(existsSync(join(markers, key(1)))).toBe(false)
  expect(existsSync(join(markers, key(200)))).toBe(true)
  expect(existsSync(join(markers, key(201)))).toBe(true)
  expect(existsSync(join(markers, key(139)))).toBe(true)
})

it('rediscovers older writers after startup even with the original directory timestamps', async () => {
  const index = createPendingCreationIndex(directory); index.ensure(key(0))
  expect((await collect(index)).ids).toEqual([])
  const original = statSync(directory)
  seed(key(1)); utimesSync(directory, original.atime, original.mtime)
  expect((await collect(index)).ids).toEqual([key(1)])
  rmSync(join(markers, key(1)))
  expect((await collect(index)).ids).toEqual([key(1)])
})

it('retires cancelled and unconfirmed markers only through authoritative receipt evidence', async () => {
  const index = createPendingCreationIndex(directory), receipts = new AgentCreationReceipts(directory)
  receipts.cancelIntent(key(0)); seed(key(1))
  writeFileSync(join(directory, `${key(1)}.json.claim`), JSON.stringify({ fingerprint, token: 'fixture-claim', kind: 'dispatch' }), { mode: 0o600 })
  index.ensure(key(0)); index.ensure(key(1))
  expect((await collect(index)).ids).toEqual([])
  expect(existsSync(join(markers, key(0)))).toBe(false); expect(existsSync(join(markers, key(1)))).toBe(false)
})

it('cannot close a replacement scan with a stale page or close cursor', async () => {
  const index = createPendingCreationIndex(directory)
  for (let n = 0; n < 130; n++) seed(key(n), false)
  const first = await index.page(null, deadline()), second = await index.page(null, deadline())
  expect(first.done).toBe(false); expect(second.done).toBe(false)
  await expect(index.page(first.cursor, deadline())).rejects.toMatchObject({ code: 'changed' })
  const closed = faults.closed.length
  await index.close(first.cursor)
  expect(faults.closed).toHaveLength(closed)
  await index.close(second.cursor)
  expect(faults.closed).toHaveLength(closed + 1)
})

it('does not mutate a terminal marker after an asynchronous read exhausts its deadline', async () => {
  const index = createPendingCreationIndex(directory); seed(id, false); index.ensure(id)
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  faults.afterRead = () => { now = 6_000 }
  await expect(index.page(null, 5_000)).rejects.toMatchObject({ code: 'expired' })
  expect(existsSync(join(markers, id))).toBe(true)
  expect(faults.closed).toEqual(expect.arrayContaining([directory, markers]))
})

it('yields a page after its cooperative budget and closes both iterators on an I/O failure', async () => {
  const index = createPendingCreationIndex(directory); seed(id); index.ensure(id)
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  faults.afterRead = () => { now += 21 }
  const page = await index.page(null, 5_000)
  expect(page.ids).toEqual([id]); expect(page.done).toBe(false)
  faults.afterRead = () => { throw new Error('fixture read failed') }
  await expect(index.page(page.cursor, 5_000)).rejects.toThrow('fixture read failed')
  expect(faults.closed).toEqual(expect.arrayContaining([directory, markers]))
})

it('bounds durable proofs to 128 entries and retries an evicted file flush', () => {
  const index = createPendingCreationIndex(directory)
  vi.mocked(fs.fsyncSync).mockImplementation(() => {})
  for (let n = 0; n < 129; n++) index.ensure(key(n))
  const flushed: boolean[] = []
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { flushed.push(fs.fstatSync(fd).isFile()) })
  index.ensure(key(128)); expect(flushed).toEqual([])
  index.ensure(key(0)); expect(flushed[0]).toBe(true)
})

it.each(['file', 'directory'] as const)('does not cache failed %s durability', kind => {
  const index = createPendingCreationIndex(directory)
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile() === (kind === 'file')) throw new Error('fixture flush failed')
  })
  expect(() => index.ensure(id)).toThrow('fixture flush failed')
  const files: boolean[] = []
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { files.push(fs.fstatSync(fd).isFile()) })
  index.ensure(id); expect(files[0]).toBe(true)
})

it.each(['link', 'hardlink', 'directory', 'contents', 'writable'] as const)('refuses an unsafe %s marker and leaves it untouched while scanning', async kind => {
  const index = createPendingCreationIndex(directory); seed(id); mkdirSync(markers, { mode: 0o700 })
  const marker = join(markers, id), other = join(root, 'other')
  writeFileSync(other, '', { mode: 0o600 })
  if (kind === 'link') symlinkSync(other, marker)
  else if (kind === 'hardlink') linkSync(other, marker)
  else if (kind === 'directory') mkdirSync(marker, { mode: 0o700 })
  else { writeFileSync(marker, kind === 'contents' ? 'private' : '', { mode: 0o600 }); if (kind === 'writable') chmodSync(marker, 0o666) }
  expect(() => index.ensure(id)).toThrow()
  expect((await collect(index)).ids).toEqual([])
  expect(existsSync(marker)).toBe(true)
})

it('accepts the configured root alias while refusing aliases below it and invalid IDs/cursors', async () => {
  const actual = join(root, 'actual'), alias = join(root, 'alias')
  mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, alias)
  createPendingCreationIndex(join(alias, 'agent-creations')).ensure(id)
  expect(existsSync(join(actual, 'agent-creations', '.pending-v1', id))).toBe(true)
  symlinkSync(join(actual, 'agent-creations'), directory)
  const index = createPendingCreationIndex(directory)
  expect(() => index.ensure(id)).toThrow()
  await expect(index.page(null, deadline())).rejects.toThrow()
  expect(() => index.ensure('../escape')).toThrow('invalid')
  await expect(index.page('bad-cursor', deadline())).rejects.toMatchObject({ code: 'invalid' })
})

it('uses file durability when the platform cannot sync directories', () => {
  vi.mocked(directorySyncSupported).mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(false)
  const files: boolean[] = []
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { files.push(fs.fstatSync(fd).isFile()) })
  createPendingCreationIndex(directory).ensure(id)
  expect(files).toEqual([true])
})

it('refuses unsafe index directories and closes an original iterator when its parent changes during open', async () => {
  seed(id); symlinkSync(directory, markers)
  await expect(createPendingCreationIndex(directory).page(null, deadline())).rejects.toMatchObject({ code: 'unsafe' })
  rmSync(markers); mkdirSync(markers, { mode: 0o700 })
  // A real directory descriptor is already open when this next asynchronous open completes.
  const promises = await import('node:fs/promises'), actual = promises.opendir
  vi.spyOn(promises, 'opendir').mockImplementation(async (...args) => {
    const dir = await actual(...args)
    if (String(args[0]) === directory) {
      renameSync(directory, `${directory}-prior`); mkdirSync(directory, { mode: 0o700 })
    }
    return dir
  })
  await expect(createPendingCreationIndex(directory).page(null, deadline())).rejects.toMatchObject({ code: 'changed' })
  expect(faults.closed).toEqual(expect.arrayContaining([directory, markers]))
})

it('refuses a parent or flushed descriptor changed during marker publication', () => {
  const index = createPendingCreationIndex(directory)
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (fs.fstatSync(fd).isFile()) chmodSync(join(markers, id), 0o400)
  })
  expect(() => index.ensure(id)).toThrow('changed')
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (!fs.fstatSync(fd).isFile()) return
    faults.afterClose = closed => {
      if (closed !== fd) return
      faults.afterClose = undefined
      renameSync(markers, `${markers}-prior`); mkdirSync(markers, { mode: 0o700 }); writeFileSync(join(markers, id), '', { mode: 0o600 })
    }
  })
  expect(() => index.ensure(id)).toThrow('changed')
})

it('refuses a marker creation error without caching or hiding it as an existing file', () => {
  const actual = fs.openSync
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (String(path) === join(markers, id)) throw Object.assign(new Error('fixture access refused'), { code: 'EACCES' })
    return actual(path, flags, mode)
  })
  expect(() => createPendingCreationIndex(directory).ensure(id)).toThrow('fixture access refused')
})

it.each(['markers', 'receipts', 'root'] as const)('refuses flushing substituted %s even when the original path returns before final verification', kind => {
  const index = createPendingCreationIndex(directory), actual = fs.openSync
  const target = kind === 'markers' ? markers : kind === 'receipts' ? directory : fs.realpathSync.native(root)
  let substitute = false
  vi.mocked(fs.fsyncSync).mockImplementation(fd => { if (fs.fstatSync(fd).isFile()) substitute = true })
  vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
    if (!substitute || String(path) !== target) return actual(path, flags, mode)
    substitute = false
    renameSync(target, `${target}-original`); mkdirSync(target, { mode: 0o700 })
    const fd = actual(path, flags, mode)
    rmSync(target, { recursive: true }); renameSync(`${target}-original`, target)
    return fd
  })
  expect(() => index.ensure(id)).toThrow('changed')
})

it('rechecks its exact directory descriptor after flushing it', () => {
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory() && fs.fstatSync(fd).ino === statSync(markers).ino) chmodSync(markers, 0o500)
  })
  try { expect(() => createPendingCreationIndex(directory).ensure(id)).toThrow('changed') }
  finally { chmodSync(markers, 0o700) }
})

it('refuses paths replaced after all original directory descriptors were flushed', () => {
  const rootInode = statSync(root).ino
  vi.mocked(fs.fsyncSync).mockImplementation(fd => {
    if (fs.fstatSync(fd).ino !== rootInode) return
    faults.afterClose = closed => {
      if (closed !== fd) return
      faults.afterClose = undefined
      renameSync(markers, `${markers}-prior`); mkdirSync(markers, { mode: 0o700 })
      writeFileSync(join(markers, id), '', { mode: 0o600 })
    }
  })
  expect(() => createPendingCreationIndex(directory).ensure(id)).toThrow('changed')
})

it('does not retire a replacement marker installed while reading terminal evidence', async () => {
  seed(id, false)
  const index = createPendingCreationIndex(directory); index.ensure(id)
  const status = AgentCreationReceipts.prototype.status
  vi.spyOn(AgentCreationReceipts.prototype, 'status').mockImplementation(function (this: AgentCreationReceipts, key) {
    const value = status.call(this, key), replacement = join(root, 'replacement')
    writeFileSync(replacement, '', { mode: 0o600 }); renameSync(replacement, join(markers, id))
    return value
  })
  expect((await collect(index)).damaged).toBeGreaterThan(0)
  expect(existsSync(join(markers, id))).toBe(true)
})

it('closes only the failed original page when another generation has already taken its place', async () => {
  const index = createPendingCreationIndex(directory); seed(id); index.ensure(id)
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  faults.afterRead = () => { now += 21 }
  const first = await index.page(null, 5_000)
  let replacement!: ReturnType<typeof index.page>
  faults.afterRead = () => {
    faults.afterRead = () => { now += 21 }
    void index.close(first.cursor)
    replacement = index.page(null, 5_000)
    throw new Error('fixture old read failed')
  }
  await expect(index.page(first.cursor, 5_000)).rejects.toThrow('fixture old read failed')
  const current = await replacement
  expect(current.cursor).not.toBe(first.cursor)
  await index.close(first.cursor)
  await expect(index.page(current.cursor, 5_000)).resolves.toHaveProperty('cursor', current.cursor)
  await index.close(current.cursor)
})
