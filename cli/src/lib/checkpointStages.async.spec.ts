import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const disk = vi.hoisted(() => ({
  paths: new Map<number, string>(), openings: new Map<number, number>(), nextOpen: 0, held: new Map<number, { release(error?: NodeJS.ErrnoException): Promise<void> }>(),
  history: [] as Promise<void>[],
  beforeHistoryClose: undefined as ((path: string) => Promise<void>) | undefined,
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
      const fd = fs.openSync(...args); disk.paths.set(fd, String(args[0])); disk.openings.set(fd, ++disk.nextOpen); return fd
    },
    closeSync: (fd: number) => {
      if (disk.held.has(fd)) throw new Error('closed before the actual flush callback')
      try {
        fs.closeSync(fd); disk.closed.push({ fd, opened: disk.openings.get(fd)! })
        if (disk.closeFailure === disk.paths.get(fd)) { disk.closeFailure = undefined; throw new Error('injected uncertain close') }
      } finally { disk.paths.delete(fd); disk.openings.delete(fd) }
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
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
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
  disk.trap = false; disk.target = undefined; disk.entered = undefined; disk.closed.length = 0; disk.history.length = 0; disk.closeFailure = undefined; disk.beforeHistoryClose = undefined
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  disk.trap = false; disk.target = undefined; disk.entered = undefined
  for (const held of [...disk.held.values()]) await held.release()
  for (const lease of leases.splice(0)) await lease.close()
  await Promise.all(disk.history); await turn()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
const manager = () => new CheckpointStages(join(root, '.stages'))
const record = (lease: CheckpointStage) => join(dirname(lease.stage.path), 'owner.json')
const destination = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function acquire() { const lease = await manager().acquire(); leases.push(lease); return lease }
async function ready(lease: CheckpointStage) {
  await lease.writer(process.pid); await lease.settled()
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
  const acquiring = manager().acquire().then(lease => { answered = true; leases.push(lease); return lease })
  const fd = await entered(waiting, acquiring), opened = disk.openings.get(fd)!
  try {
    await turn(); expect(answered).toBe(false)
    expect(fs.fstatSync(fd)).toBeTruthy()
    expect(disk.closed.some(value => value.opened === opened)).toBe(false)
  } finally { await release(fd) }
  await acquiring
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
})

it.each(['writer', 'settled', 'destination'] as const)('keeps %s durability pending without blocking the main loop', async phase => {
  const lease = await acquire()
  if (phase === 'settled') await lease.writer(process.pid)
  if (phase === 'destination') await ready(lease)
  disk.closed.length = 0
  const waiting = hold(record(lease)), allowed = vi.fn()
  let answered = false
  const work = (phase === 'writer' ? lease.writer(process.pid) : phase === 'settled' ? Promise.resolve(lease.settled())
    : lease.publish(destination(), allowed)).then(() => { answered = true })
  const fd = await entered(waiting, work), opened = disk.openings.get(fd)!
  try {
    await turn(); expect(answered).toBe(false); expect(allowed).not.toHaveBeenCalled()
    expect(fs.fstatSync(fd).isFile()).toBe(true)
    expect(disk.closed.some(value => value.opened === opened)).toBe(false)
    await expect(lease.writer(process.pid)).rejects.toThrow()
    await expect(lease.settled()).rejects.toThrow(/busy/)
    await expect(lease.verify({ bytes: 7, sha256: 'a'.repeat(64) })).rejects.toThrow(/busy/)
    await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await release(fd) }
  await work
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
  if (phase === 'destination') {
    expect(allowed).toHaveBeenCalledOnce()
    await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(destination()) }), { mode: 0o600 })
  }
})

it.each(['writer', 'settled', 'destination'] as const)('close drains the actual %s callback before cleanup and refuses its late continuation', async phase => {
  const lease = await acquire()
  if (phase === 'settled') await lease.writer(process.pid)
  if (phase === 'destination') await ready(lease)
  const waiting = hold(record(lease)), allowed = vi.fn()
  const work = (phase === 'writer' ? lease.writer(process.pid) : phase === 'settled' ? Promise.resolve(lease.settled())
    : lease.publish(destination(), allowed))
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
  expect(allowed).not.toHaveBeenCalled()
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  if (phase === 'writer') expect(await stat(record(lease))).toBeTruthy()
  else await expect(stat(record(lease))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('keeps all four physical slots and exact journal descriptors owned beyond their reply deadlines', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const active = await Promise.all(Array.from({ length: 4 }, acquire))
  const fds: number[] = [], results: Promise<unknown>[] = []
  for (const lease of active) {
    const waiting = hold(record(lease)), work = lease.writer(process.pid)
    results.push(work.catch(error => error)); fds.push(await entered(waiting, work))
  }
  await vi.advanceTimersByTimeAsync(30_000)
  expect(await Promise.all(results)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ code: 'CHECKPOINT_STAGE_TIMEOUT' })))
  await Promise.all(active.map(lease => lease.close()))
  for (const fd of fds) expect(fs.fstatSync(fd).isFile()).toBe(true)
  await expect(manager().acquire()).rejects.toThrow('busy')
  for (const fd of fds) await release(fd)
  await Promise.all(disk.history); await turn()
  for (const fd of fds) expect(() => fs.fstatSync(fd)).toThrow()
  await expect(manager().acquire()).rejects.toThrow('busy')
})

it.each(['inode', 'bytes', 'mode', 'link', 'slot'] as const)('refuses changed owner %s while an actual journal callback is held', async change => {
  if (change === 'mode' && process.platform === 'win32') return
  const lease = await acquire(), path = record(lease), waiting = hold(path), work = lease.writer(process.pid)
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

it('a failed actual destination flush cannot rename, and an explicit later retry flushes the whole owner again', async () => {
  const lease = await acquire(); await ready(lease)
  const waiting = hold(record(lease)), allowed = vi.fn(), publishing = lease.publish(destination(), allowed)
  const result = publishing.catch(error => error), fd = await entered(waiting, publishing)
  await release(fd, new Error('injected callback failure'))
  expect(await result).toMatchObject({ message: 'injected callback failure' })
  expect(allowed).not.toHaveBeenCalled()
  await expect(stat(destination())).rejects.toMatchObject({ code: 'ENOENT' })
  const retryWaiting = hold(record(lease)), retry = lease.publish(destination(), allowed)
  const retryFd = await entered(retryWaiting, retry)
  await release(retryFd); await retry
  expect(allowed).toHaveBeenCalledOnce()
  expect(await readFile(destination(), 'utf8')).toBe('history')
  await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(destination()) }), { mode: 0o600 })
})

it('keeps the first destination intent exclusive while its actual history descriptor close is held', async () => {
  const lease = await acquire(); await ready(lease)
  let opened!: () => void, releaseClose!: () => void
  const waiting = new Promise<void>(resolve => { opened = resolve })
  const held = new Promise<void>(resolve => { releaseClose = resolve })
  disk.beforeHistoryClose = async () => { disk.beforeHistoryClose = undefined; opened(); await held }
  const firstTarget = destination(), secondTarget = join(root, `${'a'.repeat(64)}-${'c'.repeat(36)}.history`)
  const first = lease.publish(firstTarget, () => {})
  await waiting
  let secondResult: unknown
  const second = lease.publish(secondTarget, () => {}).then(() => { secondResult = 'published' }, error => { secondResult = error })
  try {
    await turn()
    expect(secondResult).toBeInstanceOf(Error)
    expect((secondResult as Error).message).toMatch(/busy/)
    expect(JSON.parse(await readFile(record(lease), 'utf8')).destination).toBe(basename(firstTarget))
  } finally { releaseClose(); await Promise.allSettled([first, second]) }
  await first
  expect(await readFile(firstTarget, 'utf8')).toBe('history')
  await expect(stat(secondTarget)).rejects.toMatchObject({ code: 'ENOENT' })
  await writeFile(join(root, `${'a'.repeat(64)}.json`), JSON.stringify({ version: 1, file: basename(firstTarget) }), { mode: 0o600 })
})

// An uncertain close deliberately poisons this module instance; keep that terminal failure last.
it('never retries an uncertain owner descriptor close or reuses its reserved slot', async () => {
  const lease = await acquire(), path = record(lease), waiting = hold(path), work = lease.writer(process.pid)
  const result = work.catch(error => error), fd = await entered(waiting, work), opened = disk.openings.get(fd)!
  disk.closeFailure = path
  await release(fd)
  expect(await result).toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
  await lease.close(); await lease.close()
  expect(disk.closed.filter(value => value.opened === opened)).toHaveLength(1)
  expect(await stat(path)).toBeTruthy()
  expect(await stat(lease.stage.path)).toBeTruthy()
  await expect(manager().acquire()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
})
