import { describe, expect, it, vi } from 'vitest'
import type { SpawnLockOwner } from './daemonSpawnLock.js'
import type { ProcessRow } from './processTable.js'
import { processIfDownDeps, releaseAbandonedLock, runningDaemon, startIfDown, type IfDownDeps, type IfDownIo } from './startIfDown.js'

const owner: SpawnLockOwner = { pid: 77, startMarker: '', token: 't', purpose: 'update', since: Date.now() - 4_000 }
const deps = (over: Partial<IfDownDeps> = {}): IfDownDeps => ({
  readPid: () => null, masterRuns: async () => false, lockOwner: () => null, ownerRuns: async () => true, stoppedThisBoot: () => false, forgetStop: () => {}, ...over,
})

describe('harness start --if-down', () => {
  it('starts the daemon when nothing runs it, nobody is starting it and nobody stopped it', async () => {
    await expect(startIfDown(deps())).resolves.toEqual({ start: true })
    await expect(startIfDown(deps({ readPid: () => 500 }))).resolves.toEqual({ start: true })
    await expect(startIfDown(deps({ lockOwner: () => owner, ownerRuns: async () => false }))).resolves.toEqual({ start: true })
  })

  it('does nothing while a master runs, while the spawn lock is held, or after `harness stop`', async () => {
    await expect(startIfDown(deps({ readPid: () => 500, masterRuns: async (pid) => pid === 500 }))).resolves.toEqual({ start: false, why: 'it runs (pid 500)' })
    await expect(startIfDown(deps({ lockOwner: () => owner }))).resolves.toMatchObject({ start: false, why: expect.stringMatching(/^the daemon is being updated by pid 77/) })
    await expect(startIfDown(deps({ stoppedThisBoot: () => true }))).resolves.toEqual({ start: false, why: '`harness stop` stopped it since this computer started; `harness start` starts it again' })
    await expect(startIfDown(deps({ lockOwner: () => { throw new Error('not a lock') } }))).resolves.toEqual({ start: false, why: 'the daemon spawn lock is unusable (not a lock)' })
  })
})

// Final review R1b-2: with Fast Startup a Shut down keeps the uptime, so a stop read against the boot time outlived
// the next power-on. The logon task's start (`--at-logon`) forgets it; the five-minute task's honours it.
describe('harness start --if-down --at-logon', () => {
  it('forgets a `harness stop` and starts the daemon, where the five-minute start leaves it stopped', async () => {
    let stopped = true
    const forgetStop = vi.fn(() => { stopped = false })
    const stoppedThisBoot = () => stopped
    await expect(startIfDown(deps({ stoppedThisBoot, forgetStop }))).resolves.toMatchObject({ start: false })
    expect(forgetStop).not.toHaveBeenCalled()
    await expect(startIfDown(deps({ stoppedThisBoot, forgetStop }), { atLogon: true })).resolves.toEqual({ start: true })
    expect(forgetStop).toHaveBeenCalledOnce()
    // Nothing else changes: a master that runs is still left alone.
    await expect(startIfDown(deps({ readPid: () => 500, masterRuns: async () => true, forgetStop }), { atLogon: true })).resolves.toEqual({ start: false, why: 'it runs (pid 500)' })
  })

  it('forgets the stop on Windows only, where the task runs', () => {
    const forgetStop = vi.fn()
    const base: Partial<IfDownIo> = { stoppedThisBoot: () => true, forgetStop }
    processIfDownDeps('darwin', base).forgetStop()
    expect(forgetStop).not.toHaveBeenCalled()
    processIfDownDeps('win32', base).forgetStop()
    expect(forgetStop).toHaveBeenCalledOnce()
  })
})

describe("--if-down's view of this computer", () => {
  const CLAIMED = Date.parse('2026-10-16T08:00:00Z')
  /** A FILETIME start marker for [ms]. */
  const at = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
  const row = (pid: number, startedMs: number, argv: string[]): ProcessRow => ({
    pid, parentPid: 1, executable: 'C:\\node.exe', startMarker: at(startedMs), args: argv.join(' '), nativeArgv: argv,
  })
  const master = (pid: number, startedMs = CLAIMED - 5_000) => row(pid, startedMs, ['C:\\node.exe', 'C:\\cli.js', '__harnessd'])
  const io = (over: Partial<IfDownIo> = {}): IfDownIo => ({
    readPid: () => 500, isAlive: () => true, pidFileWrittenMs: () => CLAIMED, forgetPid: vi.fn(), rows: async () => [master(500)],
    readLockOwner: () => null, lockOwnerAlive: () => true, releaseAbandoned: vi.fn(() => true), stoppedThisBoot: () => true, forgetStop: vi.fn(), ...over,
  })

  it('on Windows, counts the pid file as a running master only when the table does not prove otherwise', async () => {
    await expect(processIfDownDeps('win32', io()).masterRuns(500)).resolves.toBe(true)
    await expect(processIfDownDeps('win32', io({ isAlive: () => false })).masterRuns(500)).resolves.toBe(false)
    // Could not tell: no table, no time the pid file was written (the claim is what tells, never the command line
    // alone), a row whose command line could not be read, or a core no master runs. The pid's liveness decides.
    await expect(processIfDownDeps('win32', io({ rows: async () => null })).masterRuns(500)).resolves.toBe(true)
    await expect(processIfDownDeps('win32', io({ pidFileWrittenMs: () => null, rows: async () => [row(500, CLAIMED + 60_000, ['C:\\x.exe'])] })).masterRuns(500)).resolves.toBe(true)
    await expect(processIfDownDeps('win32', io({ rows: async () => [row(500, CLAIMED - 5_000, ['C:\\node.exe'])] })).masterRuns(500)).resolves.toBe(true)
    await expect(processIfDownDeps('win32', io({ rows: async () => [row(500, CLAIMED - 5_000, ['C:\\node.exe', 'C:\\cli.js', '__run'])] })).masterRuns(500)).resolves.toBe(true)
  })

  it('on Windows, forgets a pid file whose pid is proven another process now only under the lock, so the start goes ahead', async () => {
    for (const rows of [[master(500, CLAIMED + 60_000)], [row(500, CLAIMED - 5_000, ['C:\\Windows\\notepad.exe', 'a.txt'])], []]) {
      // Outside the spawn lock it only judges: a start holding the lock may write a fresh pid file between a read and
      // a remove here, and that file must not be lost.
      const judged = io({ rows: async () => rows })
      await expect(processIfDownDeps('win32', judged).masterRuns(500)).resolves.toBe(false)
      expect(judged.forgetPid).not.toHaveBeenCalled()
      const locked = io({ rows: async () => rows })
      await expect(processIfDownDeps('win32', locked, { forget: true }).masterRuns(500)).resolves.toBe(false)
      expect(locked.forgetPid).toHaveBeenCalledWith(500)
    }
    const kept = io({ rows: async () => null })
    await processIfDownDeps('win32', kept, { forget: true }).masterRuns(500)
    expect(kept.forgetPid).not.toHaveBeenCalled()
  })

  it('on Windows, releases a lock only once its pid is proven reissued, judged against the lock as it is then', async () => {
    const lock: SpawnLockOwner = { ...owner, since: CLAIMED }
    const reissued = row(77, CLAIMED + 60_000, ['C:\\Windows\\notepad.exe'])
    await expect(processIfDownDeps('win32', io({ lockOwnerAlive: () => false })).ownerRuns(lock)).resolves.toBe(false)
    await expect(processIfDownDeps('win32', io({ rows: async () => [row(77, CLAIMED - 1_000, ['C:\\node.exe'])] })).ownerRuns(lock)).resolves.toBe(true)
    await expect(processIfDownDeps('win32', io({ rows: async () => null })).ownerRuns(lock)).resolves.toBe(true)
    const released = io({ rows: async () => [reissued] })
    await expect(processIfDownDeps('win32', released).ownerRuns(lock)).resolves.toBe(false)
    expect(released.releaseAbandoned).toHaveBeenCalledWith(lock, reissued)
    // The lock changed hands, or could not be removed: someone holds it, and this start waits for the next tick.
    await expect(processIfDownDeps('win32', io({ rows: async () => [reissued], releaseAbandoned: () => false })).ownerRuns(lock)).resolves.toBe(true)
  })

  it('on macOS and Linux, a live pid is the daemon, a live owner holds the lock, and no stop is written down', async () => {
    const mac = io({ rows: async () => { throw new Error('never read') }, readLockOwner: () => owner })
    const there = processIfDownDeps('darwin', mac)
    await expect(there.masterRuns(500)).resolves.toBe(true)
    await expect(there.ownerRuns(owner)).resolves.toBe(true)
    expect(there.stoppedThisBoot()).toBe(false)
    expect(there.lockOwner()).toBe(owner)
    expect(there.readPid()).toBe(500)
    expect(processIfDownDeps('win32', io()).stoppedThisBoot()).toBe(true)
  })
})

describe('the same judge for a plain `harness start`', () => {
  it('names the daemon that runs, and none when the pid file is gone or its pid is proven another process', async () => {
    await expect(runningDaemon(deps({ readPid: () => 500, masterRuns: async (pid) => pid === 500 }))).resolves.toBe(500)
    await expect(runningDaemon(deps({ readPid: () => 500, masterRuns: async () => false }))).resolves.toBeNull()
    await expect(runningDaemon(deps())).resolves.toBeNull()
  })

  it('asks about the lock\'s owner, which releases a lock whose pid was reissued, and leaves an unusable lock to the start', async () => {
    const ownerRuns = vi.fn(async () => false)
    await releaseAbandonedLock(deps({ lockOwner: () => owner, ownerRuns }))
    expect(ownerRuns).toHaveBeenCalledWith(owner)
    const untouched = vi.fn(async () => true)
    await releaseAbandonedLock(deps({ lockOwner: () => null, ownerRuns: untouched }))
    await expect(releaseAbandonedLock(deps({ lockOwner: () => { throw new Error('not a lock') }, ownerRuns: untouched }))).resolves.toBeUndefined()
    expect(untouched).not.toHaveBeenCalled()
  })
})
