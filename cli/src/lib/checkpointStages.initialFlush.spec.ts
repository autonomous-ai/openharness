import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const disk = vi.hoisted(() => ({
  directory: '', holding: false, paths: new Map<number, string>(),
  held: new Map<string, { fd: number; release(error?: Error): Promise<void> }>(),
  sync: [] as string[], started: [] as string[], historyClosed: [] as Promise<void>[],
  closed: [] as Promise<void>[], closing: new Map<number, () => void>(),
  truncated: false, ready: [] as boolean[], failOpen: '', failStart: '',
  ownerStarted: undefined as (() => void) | undefined,
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (disk.truncated && String(args[0]) === disk.failOpen) throw new Error('injected open failure')
      const fd = fs.openSync(...args); disk.paths.set(fd, String(args[0]))
      disk.closed.push(new Promise<void>(resolve => { disk.closing.set(fd, resolve) }))
      return fd
    },
    closeSync: (fd: number) => {
      if ([...disk.held.values()].some(held => held.fd === fd)) throw new Error('closed a pending flush')
      try { fs.closeSync(fd) } finally { disk.paths.delete(fd); disk.closing.get(fd)?.(); disk.closing.delete(fd) }
    },
    fsyncSync: (fd: number) => { disk.sync.push(disk.paths.get(fd)!); fs.fsyncSync(fd) },
    ftruncateSync: (fd: number, length: number) => { fs.ftruncateSync(fd, length); disk.truncated = true },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      const path = disk.paths.get(fd)!
      disk.started.push(path)
      if (!disk.holding || !path.startsWith(disk.directory)) { fs.fsync(fd, done); return }
      const slot = join(disk.directory, '0')
      disk.ready.push(disk.truncated && fs.existsSync(join(slot, 'history.tmp'))
        && JSON.parse(fs.readFileSync(join(slot, 'owner.json'), 'utf8')).settled === false
        && [...disk.paths.values()].includes(slot) && [...disk.paths.values()].includes(disk.directory))
      if (path.endsWith('owner.json')) disk.ownerStarted?.()
      if (path === disk.failStart) throw new Error('injected synchronous flush failure')
      let finish!: (error: NodeJS.ErrnoException | null) => void
      const completed = new Promise<NodeJS.ErrnoException | null>(resolve => { finish = resolve })
      disk.held.set(path, { fd, release: async failure => {
        const error = await completed; disk.held.delete(path); done(failure ?? error)
      } })
      fs.fsync(fd, finish)
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args)
    if (String(args[0]).endsWith('history.tmp')) {
      const close = handle.close.bind(handle)
      let closed!: () => void
      disk.historyClosed.push(new Promise<void>(resolve => { closed = resolve }))
      handle.close = async () => { await close(); closed() }
    }
    return handle
  } }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string, slot: string, owner: string
const leases: CheckpointStage[] = [], work: Promise<unknown>[] = []
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-initial-flush-'))
  disk.directory = join(root, '.stages'); slot = join(disk.directory, '0'); owner = join(slot, 'owner.json')
  await mkdir(disk.directory, { mode: 0o700 })
  disk.holding = true; disk.sync.length = 0; disk.started.length = 0; disk.historyClosed.length = 0; disk.closed.length = 0
  disk.truncated = false; disk.ready.length = 0; disk.failOpen = ''; disk.failStart = ''
  vi.stubEnv('ADAPTER_DATA_DIR', root)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
async function releaseAll() {
  disk.holding = false
  await Promise.all([...disk.held.values()].map(held => held.release()))
}
afterEach(async () => {
  await releaseAll(); await Promise.all(work.splice(0))
  for (const lease of leases.splice(0)) await lease.close()
  await Promise.all(disk.historyClosed); await turn(); await Promise.all(disk.closed)
  disk.ownerStarted = undefined
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
function start() {
  const waiting = new Promise<void>(resolve => { disk.ownerStarted = resolve })
  const state = { answered: false }
  const acquiring = new CheckpointStages(disk.directory).acquire(join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`), process.pid)
    .then(lease => { leases.push(lease); return lease })
  work.push(acquiring.then(() => { state.answered = true }, () => { state.answered = true }))
  return { acquiring, state, waiting: Promise.race([waiting, acquiring.then(() => { throw new Error('lease escaped before its flush') })]) }
}

describe.skipIf(process.platform === 'win32')('initial allocation barrier', () => {
  it('starts all three asynchronous flushes before waiting and exposes no early lease', async () => {
    const { acquiring, state, waiting } = start()
    await waiting; await turn()
    expect(disk.started.slice().sort()).toEqual([owner, slot, disk.directory].sort())
    expect(disk.sync).not.toContain(disk.directory)
    expect(disk.ready).toEqual([true, true, true])
    expect(state.answered).toBe(false)
    for (const held of disk.held.values()) expect(fs.fstatSync(held.fd)).toBeTruthy()
    await releaseAll()
    expect((await acquiring).handoff().stage.path).toBe(join(slot, 'history.tmp'))
  })

  it.each(['owner', 'slot', 'pool'] as const)('keeps other callbacks and handles after a failed %s flush', async kind => {
    const { acquiring, state, waiting } = start(), refused = acquiring.catch(error => error)
    await waiting; await turn()
    expect(disk.held.size).toBe(3)
    const path = kind === 'owner' ? owner : kind === 'slot' ? slot : disk.directory
    await disk.held.get(path)!.release(new Error('injected flush failure'))
    await turn(); expect(state.answered).toBe(false)
    for (const held of disk.held.values()) expect(fs.fstatSync(held.fd)).toBeTruthy()
    await releaseAll()
    expect(await refused).toMatchObject({ message: 'injected flush failure' })
    expect(disk.paths.size).toBe(0)
    expect(fs.readdirSync(disk.directory)).toEqual([])
  })

  it.each(['owner', 'slot', 'pool'] as const)('refuses a replaced %s after every flush has started', async kind => {
    const { acquiring, waiting } = start(), refused = acquiring.catch(error => error)
    await waiting; await turn()
    expect(disk.held.size).toBe(3)
    const path = kind === 'owner' ? owner : kind === 'slot' ? slot : disk.directory
    fs.renameSync(path, path + '.previous')
    if (kind === 'owner') fs.writeFileSync(path, 'foreign owner', { mode: 0o600 })
    else {
      fs.mkdirSync(path, { mode: 0o700 })
      // Move the original children back so only the containing directory changed.
      for (const name of fs.readdirSync(path + '.previous')) fs.renameSync(join(path + '.previous', name), join(path, name))
    }
    await releaseAll()
    expect(await refused).toBeInstanceOf(Error)
    expect(fs.existsSync(path)).toBe(true)
    expect(disk.paths.size).toBe(0)
  })

  it.each(['owner', 'slot', 'pool'] as const)('retains a last %s callback after timeout and cleans up only after actual completion', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const { acquiring, waiting } = start(), refused = acquiring.catch(error => error)
    await waiting; await turn()
    expect(disk.held.size).toBe(3)
    const path = kind === 'owner' ? owner : kind === 'slot' ? slot : disk.directory
    for (const [name, held] of [...disk.held]) if (name !== path) await held.release()
    expect(disk.held.size).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await refused).toMatchObject({ code: 'CHECKPOINT_STAGE_TIMEOUT' })
    for (const held of disk.held.values()) expect(fs.fstatSync(held.fd)).toBeTruthy()
    await releaseAll(); await Promise.all(disk.historyClosed); await turn()
    // The late allocation now owns a separate asynchronous cleanup flush.
    await Promise.all(disk.closed)
    expect(disk.paths.size).toBe(0)
    expect(fs.readdirSync(disk.directory)).toEqual([])
  })

  it.each(['slot', 'pool'] as const)('starts no flush when the %s descriptor cannot be opened', async kind => {
    disk.failOpen = kind === 'slot' ? slot : disk.directory
    const { acquiring, waiting } = start()
    await expect(waiting).rejects.toThrow('injected open failure')
    await expect(acquiring).rejects.toThrow('injected open failure')
    expect(disk.started).toEqual([])
    expect(disk.paths.size).toBe(0)
    expect(fs.readdirSync(disk.directory)).toEqual([])
  })

  it.each(['owner', 'slot', 'pool'] as const)('retains other callbacks when starting the %s flush throws synchronously', async kind => {
    disk.failStart = kind === 'owner' ? owner : kind === 'slot' ? slot : disk.directory
    const { acquiring, state, waiting } = start(), refused = acquiring.catch(error => error)
    await waiting; await turn()
    expect(disk.started.slice().sort()).toEqual([owner, slot, disk.directory].sort())
    expect(disk.held.size).toBe(2)
    expect(state.answered).toBe(false)
    for (const held of disk.held.values()) expect(fs.fstatSync(held.fd)).toBeTruthy()
    await releaseAll()
    expect(await refused).toMatchObject({ message: 'injected synchronous flush failure' })
    expect(disk.paths.size).toBe(0)
    expect(fs.readdirSync(disk.directory)).toEqual([])
  })
})
