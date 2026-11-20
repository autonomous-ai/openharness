import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CheckpointStages, type CheckpointStage } from './checkpointStages.js'

const disk = vi.hoisted(() => ({ pool: '', holding: false, paths: new Map<number, string>(),
  removed: [] as number[], syncCleanup: 0, uncertain: false, entered: undefined as (() => void) | undefined,
  held: new Map<number, { fd: number; release(error?: Error): Promise<void> }>(),
}))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args); disk.paths.set(fd, String(args[0])); return fd
    },
    closeSync: (fd: number) => {
      if ([...disk.held.values()].some(item => item.fd === fd)) throw new Error('closed pending cleanup flush')
      try {
        fs.closeSync(fd)
        if (disk.uncertain && disk.paths.get(fd) === disk.pool) {
          disk.uncertain = false; throw new Error('injected uncertain cleanup close')
        }
      } finally { disk.paths.delete(fd) }
    },
    rmdirSync: (...args: Parameters<typeof fs.rmdirSync>) => {
      fs.rmdirSync(...args)
      const path = String(args[0])
      for (let slot = 0; slot < 4; slot++) if (path === join(disk.pool, String(slot))) disk.removed.push(slot)
    },
    fsyncSync: (fd: number) => {
      if (disk.holding && disk.paths.get(fd) === disk.pool && disk.removed.length) {
        disk.removed.shift(); disk.syncCleanup++; throw new Error('cleanup blocked the main thread')
      }
      fs.fsyncSync(fd)
    },
    fsync: (fd: number, done: (error: NodeJS.ErrnoException | null) => void) => {
      if (!disk.holding || disk.paths.get(fd) !== disk.pool || !disk.removed.length) { fs.fsync(fd, done); return }
      const slot = disk.removed.shift()!
      let finish!: (error: NodeJS.ErrnoException | null) => void
      const actual = new Promise<NodeJS.ErrnoException | null>(resolve => { finish = resolve })
      disk.held.set(slot, { fd, release: async failure => {
        const error = await actual; disk.held.delete(slot); done(failure ?? error)
      } })
      fs.fsync(fd, finish); disk.entered?.()
    },
  }
})
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string, manager: CheckpointStages
const leases: CheckpointStage[] = [], work: Promise<unknown>[] = []
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const target = () => join(root, `${'a'.repeat(64)}-${'b'.repeat(36)}.history`)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'checkpoint-cleanup-'))
  disk.pool = join(root, '.stages'); await mkdir(disk.pool, { mode: 0o700 })
  disk.holding = false; disk.removed.length = 0; disk.syncCleanup = 0; disk.uncertain = false; disk.entered = undefined
  manager = new CheckpointStages(disk.pool)
  vi.stubEnv('ADAPTER_DATA_DIR', root); vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  disk.holding = false
  await Promise.all([...disk.held.values()].map(held => held.release()))
  await Promise.all(work.splice(0))
  for (const lease of leases.splice(0)) await lease.close()
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})
async function acquire(deadline?: number) {
  const lease = await manager.acquire(target(), process.pid, deadline); leases.push(lease); return lease
}
function closing(lease: CheckpointStage) {
  const state = { answered: false }
  const started = new Promise<void>(resolve => { disk.entered = resolve })
  const closed = lease.close().then(() => { state.answered = true })
  work.push(closed)
  return { closed, state, started: Promise.race([started, closed.then(() => { throw new Error('cleanup did not start an asynchronous flush') })]) }
}

describe.skipIf(process.platform === 'win32')('bounded asynchronous checkpoint cleanup', () => {
  it('keeps the loop available and close pending until the actual cleanup callback', async () => {
    const lease = await acquire(); disk.holding = true
    const { closed, state, started } = closing(lease)
    await started; await turn()
    expect(disk.syncCleanup).toBe(0); expect(state.answered).toBe(false)
    expect(fs.readdirSync(disk.pool)).toEqual([])
    const held = disk.held.get(0)!
    expect(fs.fstatSync(held.fd).isDirectory()).toBe(true)
    await held.release(); await closed
    expect(state.answered).toBe(true); expect(disk.paths.size).toBe(0)
    expect((await acquire()).handoff().stage.path).toBe(join(disk.pool, '0', 'history.tmp'))
  })

  it('retains its slot after the bounded close deadline until actual callback completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const lease = await acquire(); disk.holding = true
    const { closed, started } = closing(lease); await started
    await vi.advanceTimersByTimeAsync(30_000); await closed
    expect(disk.held.size).toBe(1)
    expect(fs.fstatSync(disk.held.get(0)!.fd).isDirectory()).toBe(true)
    const next = await acquire(); expect(next.handoff().stage.path).toBe(join(disk.pool, '1', 'history.tmp'))
    await disk.held.get(0)!.release(); await turn()
    expect((await acquire()).handoff().stage.path).toBe(join(disk.pool, '0', 'history.tmp'))
  })

  it('closes the cleanup descriptor and makes capacity available after a callback failure', async () => {
    const lease = await acquire(); disk.holding = true
    const { closed, started } = closing(lease); await started
    await disk.held.get(0)!.release(new Error('injected cleanup flush')); await closed
    expect(disk.paths.size).toBe(0)
    expect(console.error).toHaveBeenCalledWith('[checkpoint] STAGE_CLEANUP_UNAVAILABLE')
    expect((await acquire()).handoff().stage.path).toBe(join(disk.pool, '0', 'history.tmp'))
  })

  it('admits one of two waiters after one actual completion and times out the other without allocating', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const batch = await Promise.all(Array.from({ length: 4 }, () => acquire()))
    disk.holding = true
    for (const lease of batch) await closing(lease).started
    expect(disk.held.size).toBe(4); expect(fs.readdirSync(disk.pool)).toEqual([])
    const accepted: CheckpointStage[] = []
    const waiting = Array.from({ length: 2 }, () => acquire(performance.now() + 20_000).then(lease => { accepted.push(lease); return lease }))
    const results = Promise.allSettled(waiting); work.push(results)
    await turn(); expect(accepted).toHaveLength(0)
    await disk.held.get(0)!.release(); await Promise.race(waiting)
    expect(accepted).toHaveLength(1); expect(disk.held.size).toBe(3)
    await vi.advanceTimersByTimeAsync(20_000)
    const settled = await results
    expect(settled.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    expect(settled.filter(row => row.status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'CHECKPOINT_STAGE_TIMEOUT' }) },
    ])
    expect(fs.readdirSync(disk.pool)).toEqual(['0'])
  })

  it('retains custody after an uncertain cleanup close without an unhandled rejection', async () => {
    const lease = await acquire(); disk.holding = true
    const { closed, started } = closing(lease); await started
    disk.uncertain = true
    await disk.held.get(0)!.release(); await closed; await turn()
    expect(console.error).toHaveBeenCalledWith('[checkpoint] STAGE_CLEANUP_UNAVAILABLE')
    await expect(acquire()).rejects.toMatchObject({ code: 'STATE_FILE_CLEANUP_UNCONFIRMED' })
    expect(disk.paths.size).toBe(0)
  })
})
