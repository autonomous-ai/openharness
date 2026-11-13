import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SpawnLockOwner } from './daemonSpawnLock.js'
import type { ProcessRow } from './processTable.js'
import {
  flashHolds, freshMarker, processIfDownDeps, releaseAbandonedLock, runningDaemon, startIfDown, type IfDownDeps, type IfDownIo,
} from './startIfDown.js'

const owner: SpawnLockOwner = { pid: 77, startMarker: '', token: 't', purpose: 'update', since: Date.now() - 4_000 }
const deps = (over: Partial<IfDownDeps> = {}): IfDownDeps => ({
  readPid: () => null, masterRuns: async () => false, lockOwner: () => null, ownerRuns: async () => true, stoppedThisBoot: () => false, forgetStop: () => {},
  flashing: () => false, uninstalling: () => false, ...over,
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

// A supervisor (the Windows scheduled task, the Harness Device app) that starts the daemon while `harness flash`
// writes the dial takes its serial port mid-write; one that starts it during `harness uninstall` holds the files
// being removed.
describe('harness start --if-down while a flash or an uninstall is at work', () => {
  it('does nothing, after the logon start forgot a stop and before the pid file is read', async () => {
    await expect(startIfDown(deps({ flashing: () => true }))).resolves.toEqual({ start: false, why: "`harness flash` holds the dial's port" })
    await expect(startIfDown(deps({ uninstalling: () => true }))).resolves.toEqual({ start: false, why: '`harness uninstall` is at work' })
    const forgetStop = vi.fn(), readPid = vi.fn(() => null)
    await startIfDown(deps({ flashing: () => true, forgetStop, readPid }), { atLogon: true })
    expect(forgetStop).toHaveBeenCalledOnce()
    expect(readPid).not.toHaveBeenCalled()
    // A `harness stop` still answers first.
    await expect(startIfDown(deps({ stoppedThisBoot: () => true, flashing: () => true }))).resolves.toMatchObject({ why: expect.stringMatching(/^`harness stop`/) })
  })

  const NOW = 1_800_000_000_000
  const folder = () => mkdtempSync(join(tmpdir(), 'if-down-markers-'))

  it('a marker is fresh for ten minutes, and never from the future', () => {
    const dir = folder()
    const marker = (text: string) => { const file = join(dir, 'marker'); writeFileSync(file, text); return file }
    expect(freshMarker(marker('1799999401\n'), NOW)).toBe(true)
    for (const text of ['1799999400', '1800000001', 'soon', '', '12.5']) expect(freshMarker(marker(text), NOW)).toBe(false)
    expect(freshMarker(join(dir, 'missing'), NOW)).toBe(false)
    mkdirSync(join(dir, 'a-folder'))
    expect(freshMarker(join(dir, 'a-folder'), NOW)).toBe(false)
  })

  it('a flash holds the port by either of its files', () => {
    const holds = (name: string, text = '1799999700') => { const dir = folder(); writeFileSync(join(dir, name), text); return flashHolds(dir, NOW) }
    const hex = '0123456789abcdef0123456789abcdef'
    expect(holds('flashing')).toBe(true)
    expect(holds(`flashing.${hex}`)).toBe(true)
    expect(holds(`flashing.${hex.slice(1)}`)).toBe(false)
    expect(holds(`flashing.${hex.toUpperCase()}`)).toBe(false)
    expect(holds('flashing.bak')).toBe(false)
    expect(holds('flashing', '1799999400')).toBe(false)
    expect(holds(`flashing.${hex}`, '1799999400')).toBe(false)
    expect(flashHolds(join(folder(), 'missing'), NOW)).toBe(false)
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
    readLockOwner: () => null, lockOwnerAlive: () => true, releaseAbandoned: vi.fn(() => true), stoppedThisBoot: () => true, forgetStop: vi.fn(),
    flashing: () => false, uninstalling: () => false, ...over,
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

  it('every supervisor asks, on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(processIfDownDeps(platform, io({ flashing: () => true })).flashing()).toBe(true)
      expect(processIfDownDeps(platform, io({ uninstalling: () => true })).uninstalling()).toBe(true)
    }
  })

  it('the scheduled task decides as before when neither is at work', async () => {
    await expect(startIfDown(processIfDownDeps('win32', io({ stoppedThisBoot: () => false })))).resolves.toEqual({ start: false, why: 'it runs (pid 500)' })
    await expect(startIfDown(processIfDownDeps('win32', io({ stoppedThisBoot: () => false, readPid: () => null })))).resolves.toEqual({ start: true })
    await expect(startIfDown(processIfDownDeps('win32', io()))).resolves.toEqual({ start: false, why: '`harness stop` stopped it since this computer started; `harness start` starts it again' })
  })

  it("this computer's own markers are read by default", async () => {
    // FLASHER_DIR is read as its module loads: load it again without an override from the shell that ran the suite.
    const cache = process.env.HARNESS_FLASHER_CACHE
    delete process.env.HARNESS_FLASHER_CACHE
    vi.resetModules()
    try {
      const { FLASHER_DIR } = await import('./flasherDir.js')
      const { processIfDownDeps: own } = await import('./startIfDown.js')
      expect(FLASHER_DIR).toBe(join(homedir(), '.harness', 'flasher'))
      expect(own('darwin').flashing()).toBe(false)
      expect(own('darwin').uninstalling()).toBe(false)
      const now = `${Math.floor(Date.now() / 1000)}\n`
      mkdirSync(FLASHER_DIR, { recursive: true })
      writeFileSync(join(FLASHER_DIR, 'flashing'), now)
      writeFileSync(join(homedir(), '.harness', 'uninstalling'), now)
      expect(own('darwin').flashing()).toBe(true)
      expect(own('darwin').uninstalling()).toBe(true)
      rmSync(join(FLASHER_DIR, 'flashing'))
      rmSync(join(homedir(), '.harness', 'uninstalling'))
    } finally {
      if (cache !== undefined) process.env.HARNESS_FLASHER_CACHE = cache
    }
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
