import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const io = vi.hoisted(() => ({
  beforeOpen: undefined as ((path: string) => void) | undefined,
  afterOpen: undefined as ((path: string) => void) | undefined,
  beforeStat: undefined as ((path: string) => void) | undefined,
  afterStat: undefined as ((path: string) => void) | undefined,
  beforeSync: undefined as ((path: string) => void) | undefined,
  afterSync: undefined as ((path: string) => void) | undefined,
  owners: new Set<number>(),
  flushes: [] as { path: string; kind: 'file' | 'directory' }[],
}))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const paths = new Map<number, string>()
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0])
      io.beforeOpen?.(path)
      const fd = fs.openSync(...args)
      paths.set(fd, path)
      if (path.endsWith('owner.json')) io.owners.add(fd)
      io.afterOpen?.(path)
      return fd
    },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const path = paths.get(args[0])!
      io.beforeStat?.(path)
      const value = fs.fstatSync(...args)
      io.afterStat?.(path)
      return value
    },
    closeSync: (fd: number) => { try { fs.closeSync(fd) } finally { paths.delete(fd); io.owners.delete(fd) } },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      const path = paths.get(fd)!
      io.beforeSync?.(path)
      fs.fsync(fd, error => {
        if (error) { done(error); return }
        try {
          io.flushes.push({ path, kind: fs.fstatSync(fd).isDirectory() ? 'directory' : 'file' })
          io.afterSync?.(path)
          done(null)
        } catch (failure) { done(failure as NodeJS.ErrnoException) }
      })
    },
    fsyncSync: (fd: number) => {
      const path = paths.get(fd)!
      io.beforeSync?.(path)
      fs.fsyncSync(fd)
      io.flushes.push({ path, kind: fs.fstatSync(fd).isDirectory() ? 'directory' : 'file' })
      io.afterSync?.(path)
    },
  }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let directory: string
const leases: CheckpointStage[] = []
const clearFaults = () => { io.beforeOpen = io.afterOpen = io.beforeStat = io.afterStat = io.beforeSync = io.afterSync = undefined }
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'checkpoint-owner-'))
  vi.stubEnv('ADAPTER_DATA_DIR', directory)
  io.flushes.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  clearFaults()
  for (const lease of leases.splice(0)) await lease.close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})
const stages = () => new CheckpointStages(join(directory, '.stages'))
async function acquire() { const lease = await stages().acquire(); leases.push(lease); return lease }
const ownerPath = (lease: CheckpointStage) => join(dirname(lease.stage.path), 'owner.json')
const destination = () => join(directory, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
async function verify(lease: CheckpointStage) {
  await writeFile(lease.stage.path, 'history')
  await lease.verify({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
}
function once(point: 'beforeOpen' | 'afterOpen' | 'beforeStat' | 'afterStat' | 'beforeSync' | 'afterSync', target: string, fault: () => void) {
  const injected = vi.fn(fault)
  io[point] = path => { if (path === target) { io[point] = undefined; injected() } }
  return injected
}
// POSIX updates reuse their owner handle, so inject at the fresh descriptor proof instead of a reopen.
const beforeUpdate = process.platform === 'win32' ? 'beforeOpen' : 'beforeStat'
const afterUpdate = process.platform === 'win32' ? 'afterOpen' : 'afterStat'

it('flushes both exports completely while flushing each owner filename only on creation', async () => {
  const slot = join(directory, '.stages', '0'), record = join(slot, 'owner.json')
  for (let i = 0; i < 2; i++) {
    const lease = await acquire()
    expect(ownerPath(lease)).toBe(record)
    await lease.writer(process.pid)
    expect(JSON.parse(await readFile(record, 'utf8')).writer).toBe(process.pid)
    await lease.settled()
    expect(JSON.parse(await readFile(record, 'utf8')).settled).toBe(true)
    await verify(lease)
    await lease.publish(destination(), () => {})
    expect(await readFile(destination(), 'utf8')).toBe('history')
    expect(JSON.parse(await readFile(record, 'utf8')).destination).toBe(basename(destination()))
    await writeFile(join(directory, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(destination()) }), { mode: 0o600 })
    await lease.close()
    await expect(stat(slot)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(destination())
  }
  expect(io.flushes.filter(value => value.path === record && value.kind === 'file')).toHaveLength(8)
  expect(io.flushes.filter(value => value.path === slot && value.kind === 'directory')).toHaveLength(process.platform === 'win32' ? 0 : 2)
  expect(io.flushes.filter(value => value.path === join(directory, '.stages') && value.kind === 'directory')).toHaveLength(process.platform === 'win32' ? 0 : 4)
})

it.each([beforeUpdate, afterUpdate, 'afterSync'] as const)('refuses an owner replacement at %s without adopting or deleting it', async point => {
  const lease = await acquire(), record = ownerPath(lease)
  const injected = once(point, record, () => {
    fs.renameSync(record, `${record}.previous`)
    fs.writeFileSync(record, 'unrelated owner', { mode: 0o600 })
  })
  await expect(lease.writer(process.pid)).rejects.toThrow('checkpoint stage changed')
  expect(injected).toHaveBeenCalledOnce()
  expect(await readFile(record, 'utf8')).toBe('unrelated owner')
  await expect(lease.settled()).rejects.toThrow('checkpoint stage changed')
  await lease.close()
  expect(io.owners.size).toBe(0)
  expect(await readFile(record, 'utf8')).toBe('unrelated owner')
  expect(await stat(lease.stage.path)).toBeTruthy()
})

it.each([beforeUpdate, 'afterSync'] as const)('refuses an owner moved into a replacement slot at %s', async point => {
  const lease = await acquire(), record = ownerPath(lease), slot = dirname(record)
  const injected = once(point, record, () => {
    fs.renameSync(slot, `${slot}.previous`)
    fs.mkdirSync(slot, { mode: 0o700 })
    fs.renameSync(join(`${slot}.previous`, 'owner.json'), record)
  })
  await expect(lease.writer(process.pid)).rejects.toThrow('checkpoint slot changed')
  expect(injected).toHaveBeenCalledOnce()
  const unchanged = await readFile(record, 'utf8')
  await expect(lease.settled()).rejects.toThrow('checkpoint slot changed')
  await lease.close()
  expect(io.owners.size).toBe(0)
  expect(await readFile(record, 'utf8')).toBe(unchanged)
  expect(await stat(join(`${slot}.previous`, 'history.tmp'))).toBeTruthy()
})

it.each([beforeUpdate, 'afterSync'] as const)('refuses an owner acquiring a second link at %s', async point => {
  const lease = await acquire(), record = ownerPath(lease)
  const injected = once(point, record, () => fs.linkSync(record, join(directory, 'other-owner')))
  await expect(lease.writer(process.pid)).rejects.toThrow('unsafe checkpoint stage')
  expect(injected).toHaveBeenCalledOnce()
  await expect(lease.settled()).rejects.toThrow('unsafe checkpoint stage')
  await lease.close()
  expect(io.owners.size).toBe(0)
  expect(await stat(record)).toMatchObject({ nlink: 2 })
})

for (const kind of ['file', 'directory'] as const) it.skipIf(kind === 'directory' && process.platform === 'win32')(
  `keeps an uncertain first owner ${kind} flush reserved without returning a reusable lease`, async () => {
  const slot = join(directory, '.stages', '0'), record = join(slot, 'owner.json')
  once('beforeSync', kind === 'file' ? record : slot, () => { throw new Error('injected owner flush failure') })
  await expect(stages().acquire()).rejects.toThrow('injected owner flush failure')
  expect(io.owners.size).toBe(0)
  await stages().prepare()
  const next = await acquire()
  expect(dirname(next.stage.path)).toBe(join(directory, '.stages', '1'))
  expect(await stat(record)).toBeTruthy()
  expect(await stat(join(slot, 'history.tmp'))).toBeTruthy()
})

it.skipIf(process.platform === 'win32').each(['owner', 'slot'] as const)('refuses a replaced %s during the initial directory flush', async kind => {
  const slot = join(directory, '.stages', '0'), record = join(slot, 'owner.json')
  once('afterSync', slot, () => {
    if (kind === 'owner') {
      fs.renameSync(record, `${record}.previous`)
      fs.writeFileSync(record, 'unrelated owner', { mode: 0o600 })
    } else {
      fs.renameSync(slot, `${slot}.previous`)
      fs.mkdirSync(slot, { mode: 0o700 })
      fs.renameSync(join(`${slot}.previous`, 'owner.json'), record)
    }
  })
  await expect(acquire()).rejects.toThrow(kind === 'owner' ? 'checkpoint stage changed' : 'checkpoint slot changed')
  expect(io.owners.size).toBe(0)
  const next = await acquire()
  expect(dirname(next.stage.path)).toBe(join(directory, '.stages', '1'))
  expect(await stat(record)).toBeTruthy()
})

it('retains a replaced owner during close even without a later owner update', async () => {
  const lease = await acquire(), record = ownerPath(lease)
  fs.renameSync(record, `${record}.previous`)
  fs.writeFileSync(record, 'unrelated owner', { mode: 0o600 })
  await lease.close()
  expect(await readFile(record, 'utf8')).toBe('unrelated owner')
  expect(await stat(lease.stage.path)).toBeTruthy()
})

it('does not publish after a failed owner update and retries the complete file flush before publication', async () => {
  const lease = await acquire(), record = ownerPath(lease)
  await lease.writer(process.pid); await lease.settled(); await verify(lease)
  once('beforeSync', record, () => { throw new Error('injected owner update failure') })
  await expect(lease.publish(destination(), () => {})).rejects.toThrow('injected owner update failure')
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  const before = io.flushes.filter(value => value.path === record).length
  await lease.publish(destination(), () => {})
  expect(io.flushes.filter(value => value.path === record)).toHaveLength(before + 1)
  expect(await readFile(destination(), 'utf8')).toBe('history')
})


it.skipIf(process.platform === 'win32').each(['writer', 'settled', 'destination'] as const)('bounds directory proofs after the %s owner flush', async phase => {
  const lease = await acquire(), record = ownerPath(lease), slot = dirname(record)
  if (phase === 'settled') await lease.writer(process.pid)
  if (phase === 'destination') { await lease.writer(process.pid); await lease.settled(); await verify(lease) }
  let flushed = false, proofs = 0
  io.afterSync = path => { if (path === record) flushed = true }
  io.afterOpen = path => { if (flushed && path === slot) proofs++ }
  if (phase === 'writer') await lease.writer(process.pid)
  else if (phase === 'settled') await lease.settled()
  else await lease.publish(destination(), () => {})
  clearFaults()
  // One proof after the owner flush; publication also checks its slot after closing the history descriptor.
  expect(proofs).toBe(phase === 'destination' ? 2 : 1)
  const owner = JSON.parse(await readFile(record, 'utf8'))
  expect(owner[phase === 'destination' ? 'destination' : phase]).toBe(
    phase === 'writer' ? process.pid : phase === 'settled' ? true : basename(destination()))
})


it.skipIf(process.platform === 'win32')('refuses an initial owner changed by its flush before flushing the slot', async () => {
  const slot = join(directory, '.stages', '0'), record = join(slot, 'owner.json')
  once('afterSync', record, () => {
    fs.renameSync(record, `${record}.previous`)
    fs.writeFileSync(record, 'unrelated owner', { mode: 0o600 })
  })
  await expect(stages().acquire()).rejects.toThrow('checkpoint stage changed')
  expect(io.owners.size).toBe(0)
  expect(io.flushes.filter(value => value.path === slot)).toEqual([])
  expect(await readFile(record, 'utf8')).toBe('unrelated owner')
})

it('refuses a destination owner changed by its flush before publication authority runs', async () => {
  const lease = await acquire(), record = ownerPath(lease), allowed = vi.fn()
  await lease.writer(process.pid); await lease.settled(); await verify(lease)
  once('afterSync', record, () => {
    fs.renameSync(record, `${record}.previous`)
    fs.writeFileSync(record, 'unrelated owner', { mode: 0o600 })
  })
  await expect(lease.publish(destination(), allowed)).rejects.toThrow('checkpoint stage changed')
  expect(allowed).not.toHaveBeenCalled()
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(record, 'utf8')).toBe('unrelated owner')
})
