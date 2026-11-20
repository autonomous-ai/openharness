import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCK_LOOK_MS, moveLockPath, withMoveLock, type LockDeps, type LockWait } from './lock.js'

const folder = (): string => mkdtempSync(join(tmpdir(), 'move-lock-'))

/** A ~/.harness, in a home that is there. */
const legacyHome = (): string => join(folder(), '.harness')

// The processes that run, by pid, with the clock tick each started at: a pid not here runs nothing.
const STARTED = new Map([[1001, 7], [1002, 8]])
const as = (pid: number, started = STARTED): LockDeps => ({ pid, startTime: (other) => started.get(other) ?? null, watch: (path, onChange) => watch(path, onChange) })

/** A wait for a move that never commits, saying nothing. */
const UNCOMMITTED: LockWait = { committed: () => false, long: () => {} }

/** A lock left by [pid], which started at [start]. */
function heldBy(legacy: string, pid: number, start: number): void {
  mkdirSync(moveLockPath(legacy), { mode: 0o700 })
  writeFileSync(join(moveLockPath(legacy), 'owner'), JSON.stringify({ pid, start }), { mode: 0o600 })
}

const ownerOf = (legacy: string): unknown => JSON.parse(readFileSync(join(moveLockPath(legacy), 'owner'), 'utf8'))
const mode = (path: string): number => statSync(path).mode & 0o777

afterEach(() => { vi.useRealTimers() })

describe('the move lock', () => {
  it('the first start holds it', async () => {
    const legacy = legacyHome()
    const seen = await withMoveLock(legacy, async () => ({
      owner: ownerOf(legacy), folder: mode(moveLockPath(legacy)), file: mode(join(moveLockPath(legacy), 'owner')),
    }), UNCOMMITTED, as(1001))
    expect(seen).toEqual({ held: true, value: { owner: { pid: 1001, start: 7 }, folder: 0o700, file: 0o600 } })
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  it('it lets go when the run throws', async () => {
    const legacy = legacyHome()
    await expect(withMoveLock(legacy, async () => { throw new Error('stage failed') }, UNCOMMITTED, as(1001))).rejects.toThrow('stage failed')
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  // Where the move runs: inotify tells every change made once fs.watch returns. macOS's FSEvents starts telling some
  // time after it returns, and may never tell this release.
  it.runIf(process.platform === 'linux')('a second start waits, then sees the lock gone', async () => {
    // The limit never comes: only the watch can wake the second start.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome(), order: string[] = []
    let moved!: () => void
    const first = withMoveLock(legacy, () => new Promise<void>((done) => {
      order.push('first')
      moved = () => {
        mkdirSync(legacy)
        order.push('first done')
        done()
      }
    }), UNCOMMITTED, as(1001))
    const second = withMoveLock(legacy, async () => {
      order.push('second')
      return existsSync(legacy)
    }, UNCOMMITTED, as(1002))
    await new Promise(setImmediate)
    expect(order).toEqual(['first'])
    moved()
    await first
    expect(await second).toEqual({ held: true, value: true })
    expect(order).toEqual(['first', 'first done', 'second'])
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  it('a lock whose owner is gone is taken over', async () => {
    const legacy = legacyHome()
    heldBy(legacy, 4242, 1)
    expect(await withMoveLock(legacy, async () => ownerOf(legacy), UNCOMMITTED, as(1001))).toEqual({ held: true, value: { pid: 1001, start: 7 } })
  })

  it('a pid reused by another process is gone too', async () => {
    const legacy = legacyHome()
    // 1002 runs, but it started at 8: the owner that started at 3 is gone.
    heldBy(legacy, 1002, 3)
    expect(await withMoveLock(legacy, async () => ownerOf(legacy), UNCOMMITTED, as(1001))).toEqual({ held: true, value: { pid: 1001, start: 7 } })
  })

  it('while its owner lives it waits with no limit, says so once LOCK_LOOK_MS in, and takes the lock once the owner is killed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome(), started = new Map(STARTED)
    heldBy(legacy, 1002, 8)
    const run = vi.fn(async () => 'moved')
    const long = vi.fn()
    let settled = false
    const waiting = withMoveLock(legacy, run, { committed: () => false, long }, as(1001, started)).finally(() => { settled = true })
    expect(LOCK_LOOK_MS).toBe(30_000)
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS - 1)
    expect(long).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(long).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20 * LOCK_LOOK_MS)
    expect([settled, long.mock.calls.length, run.mock.calls.length]).toEqual([false, 1, 0])
    // A kill changes nothing beside the lock: the next look finds the owner gone.
    started.delete(1002)
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
    expect(await waiting).toEqual({ held: true, value: 'moved' })
  })

  it('a watch that cannot start (ENOSPC) still waits, and takes the lock at the next look', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome()
    heldBy(legacy, 1002, 8)
    const log = vi.fn()
    // Linux's fs.watch throws as it starts once inotify's watches are used up.
    const unwatched: LockDeps = { ...as(1001), watch: () => { throw Object.assign(new Error('watch failed'), { code: 'ENOSPC' }) } }
    const told = { committed: () => false, long: () => {}, log }
    const waiting = withMoveLock(legacy, async () => 'moved', told, unwatched)
    await vi.advanceTimersByTimeAsync(0)
    // The owner lets go, which no watch tells: the next look sees it.
    rmSync(moveLockPath(legacy), { recursive: true })
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
    expect(await waiting).toEqual({ held: true, value: 'moved' })
    expect(log.mock.calls).toEqual([['home move: lock watch ENOSPC · looking every 30 s']])
  })

  it('a move the lock is held for that is committed ends the wait, the lock left to its owner', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome()
    heldBy(legacy, 1002, 8)
    let committed = false
    const run = vi.fn(async () => 'moved')
    const waiting = withMoveLock(legacy, run, { committed: () => committed, long: () => {} }, as(1001))
    committed = true
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
    expect(await waiting).toEqual({ held: false })
    expect(run).not.toHaveBeenCalled()
    expect(ownerOf(legacy)).toEqual({ pid: 1002, start: 8 })
  })

  it('a process with no start time does not take it: every other start would read its owner as gone', async () => {
    const legacy = legacyHome()
    await expect(withMoveLock(legacy, async () => 'moved', UNCOMMITTED, as(1003))).rejects.toThrow('no start time')
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  it('the lock is beside ~/.harness, never in a tree', async () => {
    const legacy = legacyHome()
    expect(moveLockPath(legacy)).toBe(`${legacy}.move-lock`)
    expect(await withMoveLock(legacy, async () => readdirSync(dirname(legacy)), UNCOMMITTED, as(1001))).toEqual({ held: true, value: ['.harness.move-lock'] })
  })

  it.runIf(process.platform === 'linux')('on Linux a live owner is known by its start time in /proc', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome()
    // This process holds it: a second call from it, reading /proc, finds the owner live and waits, until told the move is committed.
    let looked = false
    const seen = await withMoveLock(legacy, async () => {
      const inner = withMoveLock(legacy, async () => 'taken', { committed: () => looked, long: () => { looked = true } })
      await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
      return inner
    }, UNCOMMITTED)
    expect(seen).toEqual({ held: true, value: { held: false } })
  })
})
