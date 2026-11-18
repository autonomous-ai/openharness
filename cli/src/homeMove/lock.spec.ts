import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCK_WAIT_MS, moveLockPath, withMoveLock, type LockDeps } from './lock.js'

const folder = (): string => mkdtempSync(join(tmpdir(), 'move-lock-'))

/** A ~/.harness, in a home that is there. */
const legacyHome = (): string => join(folder(), '.harness')

// The processes that run, by pid, with the clock tick each started at: a pid not here runs nothing.
const STARTED = new Map([[1001, 7], [1002, 8]])
const as = (pid: number): LockDeps => ({ pid, startTime: (other) => STARTED.get(other) ?? null, watch: (path, onChange) => watch(path, onChange) })

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
    }), as(1001))
    expect(seen).toEqual({ held: true, value: { owner: { pid: 1001, start: 7 }, folder: 0o700, file: 0o600 } })
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  it('it lets go when the run throws', async () => {
    const legacy = legacyHome()
    await expect(withMoveLock(legacy, async () => { throw new Error('stage failed') }, as(1001))).rejects.toThrow('stage failed')
    expect(existsSync(moveLockPath(legacy))).toBe(false)
  })

  it('a second start waits, then sees the lock gone', async () => {
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
    }), as(1001))
    const second = withMoveLock(legacy, async () => {
      order.push('second')
      return existsSync(legacy)
    }, as(1002))
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
    expect(await withMoveLock(legacy, async () => ownerOf(legacy), as(1001))).toEqual({ held: true, value: { pid: 1001, start: 7 } })
  })

  it('a pid reused by another process is gone too', async () => {
    const legacy = legacyHome()
    // 1002 runs, but it started at 8: the owner that started at 3 is gone.
    heldBy(legacy, 1002, 3)
    expect(await withMoveLock(legacy, async () => ownerOf(legacy), as(1001))).toEqual({ held: true, value: { pid: 1001, start: 7 } })
  })

  it('after 30 s it gives up and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome()
    heldBy(legacy, 1002, 8)
    const run = vi.fn(async () => 'moved')
    let settled = false
    const waiting = withMoveLock(legacy, run, as(1001)).finally(() => { settled = true })
    expect(LOCK_WAIT_MS).toBe(30_000)
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await waiting).toEqual({ held: false })
    expect(run).not.toHaveBeenCalled()
    expect(ownerOf(legacy)).toEqual({ pid: 1002, start: 8 })
  })

  it('the lock is beside ~/.harness, never in a tree', async () => {
    const legacy = legacyHome()
    expect(moveLockPath(legacy)).toBe(`${legacy}.move-lock`)
    expect(await withMoveLock(legacy, async () => readdirSync(dirname(legacy)), as(1001))).toEqual({ held: true, value: ['.harness.move-lock'] })
  })

  it.runIf(process.platform === 'linux')('on Linux a live owner is known by its start time in /proc', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const legacy = legacyHome()
    // This process holds it: a second call from it, reading /proc, finds the owner live and waits it out.
    const seen = await withMoveLock(legacy, async () => {
      const inner = withMoveLock(legacy, async () => 'taken')
      await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS)
      return inner
    })
    expect(seen).toEqual({ held: true, value: { held: false } })
  })
})
