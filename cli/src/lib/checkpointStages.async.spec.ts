import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'
import type { ExportOwnership } from '../engines/worker/storageProtocol.js'
type ExposedStage = CheckpointStage & ExportOwnership

const disk = vi.hoisted(() => ({
  paths: new Map<number, string>(), openings: new Map<number, number>(), nextOpen: 0, held: new Map<number, { release(error?: NodeJS.ErrnoException): Promise<void> }>(),
  history: [] as Promise<void>[],
  descriptorCloses: [] as Promise<void>[], closing: new Map<number, () => void>(),
  beforeHistoryClose: undefined as ((path: string) => Promise<void>) | undefined,
  afterLstat: undefined as ((path: string) => Promise<void>) | undefined,
  closeFailure: undefined as string | undefined,
  target: undefined as ((path: string) => boolean) | undefined,
  entered: undefined as ((fd: number) => void) | undefined,
  trap: false,
  closed: [] as Array<{ fd: number; opened: number }>,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args); disk.paths.set(fd, String(args[0])); disk.openings.set(fd, ++disk.nextOpen)
      disk.descriptorCloses.push(new Promise<void>(resolve => { disk.closing.set(fd, resolve) }))
      return fd
    },
    closeSync: (fd: number) => {
      if (disk.held.has(fd)) throw new Error('closed before the actual flush callback')
      try {
        fs.closeSync(fd); disk.closed.push({ fd, opened: disk.openings.get(fd)! })
        if (disk.closeFailure === disk.paths.get(fd)) { disk.closeFailure = undefined; throw new Error('injected uncertain close') }
      } finally { disk.paths.delete(fd); disk.openings.delete(fd); disk.closing.get(fd)?.(); disk.closing.delete(fd) }
    },
    fsyncSync: (fd: number) => {
      if (disk.trap && disk.target?.(disk.paths.get(fd)!)) throw new Error('journal flush blocked the main thread')
      fs.fsyncSync(fd)
    },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      if (!disk.target?.(disk.paths.get(fd)!)) { fs.fsync(fd, done); return }
      disk.target = undefined
      let actual!: (error: NodeJS.ErrnoException | null) => void
      const completed = new Promise<NodeJS.ErrnoException | null>(resolve => { actual = resolve })
      disk.held.set(fd, { release: async failure => {
        const error = await completed; disk.held.delete(fd); done(failure ?? error)
      } })
      fs.fsync(fd, actual)
      disk.entered?.(fd)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    const found = await fs.lstat(...args); await disk.afterLstat?.(String(args[0])); return found
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (/[\\/]history\.tmp$/.test(String(args[0]))) {
      const close = handle.close.bind(handle)
      let done!: () => void
      disk.history.push(new Promise<void>(resolve => { done = resolve }))
      handle.close = async () => { await disk.beforeHistoryClose?.(String(args[0])); await close(); done() }
    }
    return handle
  } }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
const leases: CheckpointStage[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-journal-'))
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  disk.descriptorCloses.length = 0
  disk.trap = false; disk.target = undefined; disk.entered = undefined; disk.closed.length = 0; disk.history.length = 0; disk.closeFailure = undefined; disk.beforeHistoryClose = undefined; disk.afterLstat = undefined
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  disk.trap = false; disk.target = undefined; disk.entered = undefined; disk.afterLstat = undefined
  for (const held of [...disk.held.values()]) await held.release()
  for (const lease of leases.splice(0)) await lease.close()
  await Promise.all(disk.history); await turn(); await Promise.all(disk.descriptorCloses)
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const manager = () => new CheckpointStages(join(root, '.stages'))
const record = (lease: ExposedStage) => join(dirname(lease.stage.path), 'owner.json')
const destination = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function acquire() { const lease = await manager().acquire(destination(), process.pid); leases.push(lease); return { ...lease, ...lease.handoff() } }
async function ready(lease: ExposedStage) {
  await lease.settled()
  await writeFile(lease.stage.path, 'history')
  await lease.verify({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
}
function hold(path: string) {
  disk.target = value => value === path; disk.trap = true
  return new Promise<number>(resolve => { disk.entered = resolve })
}
async function entered(waiting: Promise<number>, work: Promise<unknown>): Promise<number> {
  return await Promise.race([waiting, work.then(() => { throw new Error('journal returned before its held callback') })])
}
async function release(fd: number, error?: NodeJS.ErrnoException) { const held = disk.held.get(fd); expect(held).toBeDefined(); await held!.release(error) }

it.each(['owner file', 'owner directory'] as const)('keeps the main loop available during initial %s durability', async kind => {
  if (kind === 'owner directory' && process.platform === 'win32') return
  const slot = join(root, '.stages', '0'), target = kind === 'owner file' ? join(slot, 'owner.json') : slot
  const waiting = hold(target)
  let answered = false
  const acquiring = manager().acquire(destination(), process.pid).then(lease => { answered = true; leases.push(lease); return { ...lease, ...lease.handoff() } })
  const fd = await entered(waiting, acquiring), opened = disk.openings.get(fd)!
  try {
    await turn(); expect(answered).toBe(false)
    expect(JSON.parse(await readFile(join(slot, 'owner.json'), 'utf8'))).toMatchObject({ writer: process.pid, settled: false })
    expect(fs.fstatSync(fd)).toBeTruthy()
    expect(disk.closed.some(value => value.opened === opened)).toBe(false)
  } finally { await release(fd) }
  const lease = await acquiring
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(kind === 'owner file' && process.platform !== 'win32' ? 0 : 1)
  await lease.close()
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
})

it('keeps settlement durability pending without blocking the main loop', async () => {
  const lease = await acquire()
  disk.closed.length = 0
  const waiting = hold(record(lease))
  let answered = false
  const work = lease.settled().then(() => { answered = true })
  const fd = await entered(waiting, work), opened = disk.openings.get(fd)!
  try {
    await turn(); expect(answered).toBe(false)
    expect(fs.fstatSync(fd).isFile()).toBe(true)
    expect(disk.closed.some(value => value.opened === opened)).toBe(false)
    expect(() => lease.handoff()).toThrow()
    await expect(lease.settled()).rejects.toThrow(/busy/)
    await expect(lease.verify({ bytes: 7, sha256: 'a'.repeat(64) })).rejects.toThrow(/busy/)
    await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await release(fd) }
  await work
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(process.platform === 'win32' ? 1 : 0)
  await lease.close()
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
})

it('close drains the actual settlement callback before cleanup and refuses its late continuation', async () => {
  const lease = await acquire()
  const waiting = hold(record(lease))
  const work = lease.settled()
  const refused = work.catch(error => error), fd = await entered(waiting, work)
  let closed = false
  const closing = lease.close().then(() => { closed = true })
  try {
    await turn(); expect(closed).toBe(false)
    expect(fs.fstatSync(fd).isFile()).toBe(true)
    expect(await stat(record(lease))).toBeTruthy()
    expect(await stat(lease.stage.path)).toBeTruthy()
  } finally { await release(fd) }
  expect(await refused).toMatchObject({ code: 'CHECKPOINT_STAGE_TIMEOUT' })
  await closing
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(record(lease))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('closes a late acquired owner exactly once after its initial flush outlives the reply deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const path = join(root, '.stages', '0', 'owner.json'), waiting = hold(path), work = manager().acquire(destination(), process.pid)
  const refused = work.catch(error => error), fd = await entered(waiting, work), opened = disk.openings.get(fd)!
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await refused).toMatchObject({ code: 'CHECKPOINT_STAGE_TIMEOUT' })
  expect(disk.closed.some(value => value.opened === opened)).toBe(false)
  expect(fs.fstatSync(fd).isFile()).toBe(true)
  await release(fd)
  await Promise.all(disk.history); await turn()
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
  expect(disk.openings.get(fd)).not.toBe(opened)
  expect(fs.readdirSync(join(root, '.stages'))).toEqual([])
})

it('keeps all four unexposed slots and exact journal descriptors owned beyond their reply deadlines', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fds: number[] = [], openings: number[] = [], results: Promise<unknown>[] = []
  for (let index = 0; index < 4; index++) {
    const path = join(root, '.stages', String(index), 'owner.json'), waiting = hold(path)
    const work = manager().acquire(destination(), process.pid)
    results.push(work.catch(error => error)); fds.push(await entered(waiting, work))
    openings.push(disk.openings.get(fds.at(-1)!)!)
  }
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await Promise.all(results)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ code: 'CHECKPOINT_STAGE_TIMEOUT' })))
  for (const fd of fds) expect(fs.fstatSync(fd).isFile()).toBe(true)
  await expect(manager().acquire(destination(), process.pid)).rejects.toThrow('busy')
  for (const fd of fds) await release(fd)
  await Promise.all(disk.history); await turn()
  // A new cleanup descriptor may reuse a journal's number. Prove the exact
  // opening closed once, rather than assuming its number is still unused.
  for (let i = 0; i < fds.length; i++) {
    expect(disk.closed.filter(value => value.opened === openings[i])).toHaveLength(1)
    expect(disk.openings.get(fds[i])).not.toBe(openings[i])
  }
  const next = await manager().acquire(destination(), process.pid); leases.push(next)
  await next.close()
  expect(fs.readdirSync(join(root, '.stages'))).toEqual([])
})

it.each(['inode', 'bytes', 'mode', 'link', 'slot'] as const)('refuses changed owner %s while an actual journal callback is held', async change => {
  if (change === 'mode' && process.platform === 'win32') return
  const lease = await acquire(), path = record(lease), waiting = hold(path), work = lease.settled()
  const result = work.catch(error => error), fd = await entered(waiting, work)
  if (change === 'inode') { fs.renameSync(path, `${path}.before`); fs.writeFileSync(path, 'unrelated', { mode: 0o600 }) }
  else if (change === 'bytes') fs.writeFileSync(path, 'unrelated', { mode: 0o600 })
  else if (change === 'mode') fs.chmodSync(path, 0o640)
  else if (change === 'link') fs.linkSync(path, join(root, 'other-owner'))
  else { fs.renameSync(dirname(path), `${dirname(path)}.before`); fs.mkdirSync(dirname(path), { mode: 0o700 }); fs.renameSync(join(`${dirname(path)}.before`, 'owner.json'), path) }
  await release(fd)
  expect(await result).toBeInstanceOf(Error)
  const kept = await readFile(path, 'utf8')
  await lease.close()
  expect(await readFile(path, 'utf8')).toBe(kept)
})

it('a failed actual settlement flush revokes publication even when the exact bytes are visible', async () => {
  const lease = await acquire(); await ready(lease)
  const waiting = hold(record(lease)), allowed = vi.fn(), settling = lease.settled()
  const result = settling.catch(error => error), fd = await entered(waiting, settling)
  await release(fd, new Error('injected callback failure'))
  expect(await result).toMatchObject({ message: 'injected callback failure' })
  expect(JSON.parse(await readFile(record(lease), 'utf8'))).toMatchObject({ settled: true, destination: basename(destination()) })
  await expect(lease.publish(allowed)).rejects.toThrow('checkpoint stage unconfirmed')
  expect(allowed).not.toHaveBeenCalled()
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  const retryWaiting = hold(record(lease)), retry = lease.settled()
  const retryFd = await entered(retryWaiting, retry)
  await release(retryFd); await retry
  await lease.publish(allowed)
  expect(allowed).toHaveBeenCalledOnce()
  expect(await readFile(destination(), 'utf8')).toBe('history')
  await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(destination()) }), { mode: 0o600 })
})

it('close drains publication history close and refuses its late continuation', async () => {
  const lease = await acquire(); await ready(lease)
  let opened!: () => void, releaseClose!: () => void
  const waiting = new Promise<void>(resolve => { opened = resolve })
  const held = new Promise<void>(resolve => { releaseClose = resolve })
  disk.beforeHistoryClose = async () => { disk.beforeHistoryClose = undefined; opened(); await held }
  const allowed = vi.fn(), publication = lease.publish(allowed).catch(error => error)
  await waiting
  let closed = false
  const closing = lease.close().then(() => { closed = true })
  try {
    await turn(); expect(closed).toBe(false)
    expect(await stat(record(lease))).toBeTruthy()
    expect(await stat(lease.stage.path)).toBeTruthy()
  } finally { releaseClose() }
  expect(await publication).toMatchObject({ code: 'CHECKPOINT_STAGE_TIMEOUT' })
  await closing
  expect(allowed).not.toHaveBeenCalled()
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(dirname(lease.stage.path))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps the first destination intent exclusive while its actual history descriptor close is held', async () => {
  const lease = await acquire(); await ready(lease)
  let opened!: () => void, releaseClose!: () => void
  const waiting = new Promise<void>(resolve => { opened = resolve })
  const held = new Promise<void>(resolve => { releaseClose = resolve })
  disk.beforeHistoryClose = async () => { disk.beforeHistoryClose = undefined; opened(); await held }
  const firstTarget = destination()
  const first = lease.publish(() => {})
  await waiting
  let secondResult: unknown
  const second = lease.publish(() => {}).then(() => { secondResult = 'published' }, error => { secondResult = error })
  try {
    await turn()
    expect(secondResult).toBeInstanceOf(Error)
    expect((secondResult as Error).message).toMatch(/busy/)
    expect(JSON.parse(await readFile(record(lease), 'utf8')).destination).toBe(basename(firstTarget))
  } finally { releaseClose(); await Promise.allSettled([first, second]) }
  await first
  expect(await readFile(firstTarget, 'utf8')).toBe('history')
  await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(firstTarget) }), { mode: 0o600 })
})

it('refuses a later publication without rewriting a successful publication intent', async () => {
  const lease = await acquire(); await ready(lease)
  const firstTarget = destination()
  await lease.publish(() => {})
  const ownerBefore = await readFile(record(lease), 'utf8'), openingsBefore = disk.nextOpen
  const allowed = vi.fn()
  const outcome = await lease.publish(allowed).then(() => null, error => error)
  expect(outcome).toBeInstanceOf(Error)
  expect(await readFile(record(lease), 'utf8')).toBe(ownerBefore)
  expect(disk.nextOpen).toBe(openingsBefore)
  expect((outcome as Error).message).toBe('checkpoint stage unconfirmed')
  expect(allowed).not.toHaveBeenCalled()
  expect(await readFile(firstTarget, 'utf8')).toBe('history')
  await lease.close()
  await expect(stat(firstTarget)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses publication while a second actual verification still holds an earlier completed proof', async () => {
  const lease = await acquire(); await ready(lease)
  let entered!: () => void, releaseCheck!: () => void
  const held = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { releaseCheck = resolve })
  disk.afterLstat = async path => {
    if (path !== lease.stage.path) return
    disk.afterLstat = undefined; entered(); await gate
  }
  const checking = lease.verify({ bytes: 7, sha256: createHash('sha256').update('history').digest('hex') })
  const settled = checking.then(() => null, error => error)
  await held
  const ownerBefore = await readFile(record(lease), 'utf8'), openingsBefore = disk.nextOpen
  const allowed = vi.fn()
  try {
    const outcome = await lease.publish(allowed).then(() => null, error => error)
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('checkpoint stage unconfirmed')
    expect(await readFile(record(lease), 'utf8')).toBe(ownerBefore)
    expect(disk.nextOpen).toBe(openingsBefore)
    expect(allowed).not.toHaveBeenCalled()
    await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { releaseCheck(); await settled }
  await checking
  await lease.publish(allowed)
  expect(allowed).toHaveBeenCalledOnce()
  expect(await readFile(destination(), 'utf8')).toBe('history')
})

// An uncertain close deliberately poisons this module instance; keep that terminal failure last.
it('never retries an uncertain owner descriptor close or reuses its reserved slot', async () => {
  const lease = await acquire(), path = record(lease), waiting = hold(path), work = lease.settled()
  const result = work.catch(error => error), fd = await entered(waiting, work), opened = disk.openings.get(fd)!
  disk.closeFailure = path
  await release(fd)
  if (process.platform === 'win32') expect(await result).toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  else { expect(await result).toBeUndefined(); expect(disk.closed.some(value => value.opened === opened)).toBe(false) }
  await lease.close(); await lease.close()
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
  expect(await stat(path)).toBeTruthy()
  expect(await stat(lease.stage.path)).toBeTruthy()
  await expect(manager().acquire(destination(), process.pid)).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
})
