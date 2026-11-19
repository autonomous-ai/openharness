import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PidFileRead } from './daemonState.js'
import { isDaemonRunning, settlePidFile, type SettleDeps } from './pidFileSettle.js'
import type { ProcessRow } from './processTable.js'

const unreadable: PidFileRead = { state: 'unreadable' }

/** Reads answer [reads] in turn, the last one again after that; no daemon answers, no status file names a master, and
 *  the lock is free. */
function fake(reads: PidFileRead[], over: Partial<SettleDeps> = {}) {
  const calls: string[] = []
  const deps: SettleDeps = {
    read: () => { calls.push('read'); return reads.length > 1 ? reads.shift()! : reads[0]! },
    status: async () => { calls.push('status'); return null },
    statusMaster: () => { calls.push('statusMaster'); return null },
    masterRuns: async (pid) => { calls.push(`masterRuns ${pid}`); return false },
    lockFree: () => { calls.push('lockFree'); return true },
    setAside: () => { calls.push('setAside') },
    answer: (pid) => { calls.push(`answer ${pid}`) },
    ...over,
  }
  return { deps, calls }
}

describe('settlePidFile', () => {
  it('an unreadable pid file with a daemon running is that daemon', async () => {
    const t = fake([unreadable], { status: async () => ({ pid: 4242, version: '1.0.0' }) })
    await expect(settlePidFile(t.deps)).resolves.toEqual({ state: 'pid', pid: 4242, from: 'daemon' })
    expect(t.calls).toContain('answer 4242')
    expect(t.calls).not.toContain('setAside')
    // An answer that names no pid is no answer.
    for (const pid of [0, -1, 1.5, '4242', null]) {
      const none = fake([unreadable], { status: async () => ({ pid }) })
      await expect(settlePidFile(none.deps), JSON.stringify(pid)).resolves.toEqual({ state: 'missing' })
      expect(none.calls).toContain('answer null')
    }
  })

  it('with no daemon and a free lock it is set aside', async () => {
    const t = fake([unreadable])
    await expect(settlePidFile(t.deps)).resolves.toEqual({ state: 'missing' })
    expect(t.calls.filter((call) => call === 'setAside')).toHaveLength(1)
    expect(t.calls).toContain('answer null')
  })

  it('with no daemon and the lock held elsewhere it is left', async () => {
    const t = fake([unreadable], { lockFree: () => false })
    await expect(settlePidFile(t.deps)).resolves.toEqual({ state: 'busy' })
    expect(t.calls).not.toContain('setAside')
    expect(t.calls).toContain('answer null')
  })

  // A master between cores (a restart's backoff, safe mode after a crash loop) answers nothing: setting its file aside
  // let a second `harness start` start a second master.
  it('with no daemon answering, the master its status file names is that daemon while it runs', async () => {
    const t = fake([unreadable], { statusMaster: () => 4242, masterRuns: async (pid) => { t.calls.push(`masterRuns ${pid}`); return pid === 4242 } })
    await expect(settlePidFile(t.deps)).resolves.toEqual({ state: 'pid', pid: 4242, from: 'daemon' })
    expect(t.calls).toContain('masterRuns 4242')
    expect(t.calls).toContain('answer 4242')
    expect(t.calls).not.toContain('setAside')
    // Whoever holds the lock: the master runs all the same.
    const held = fake([unreadable], { statusMaster: () => 4242, masterRuns: async () => true, lockFree: () => false })
    await expect(settlePidFile(held.deps)).resolves.toEqual({ state: 'pid', pid: 4242, from: 'daemon' })
    expect(held.calls).not.toContain('setAside')
  })

  it('a master the status file names that does not run is no daemon, and the file is set aside as before', async () => {
    const gone = fake([unreadable], { statusMaster: () => 4242 })
    await expect(settlePidFile(gone.deps)).resolves.toEqual({ state: 'missing' })
    expect(gone.calls).toContain('masterRuns 4242')
    expect(gone.calls.filter((call) => call === 'setAside')).toHaveLength(1)
    expect(gone.calls).toContain('answer null')
    // No master named: none is asked about.
    const none = fake([unreadable])
    await expect(settlePidFile(none.deps)).resolves.toEqual({ state: 'missing' })
    expect(none.calls.some((call) => call.startsWith('masterRuns'))).toBe(false)
  })

  it('a pid file that became good is not set aside', async () => {
    // launchd starts the master with no spawn lock held: its claim can land between the two reads.
    const t = fake([unreadable, { state: 'pid', pid: 5151 }])
    await expect(settlePidFile(t.deps)).resolves.toEqual({ state: 'pid', pid: 5151, from: 'file' })
    expect(t.calls).not.toContain('setAside')
  })

  it('a good file never asks the daemon', async () => {
    const good = fake([{ state: 'pid', pid: 4242 }])
    await expect(settlePidFile(good.deps)).resolves.toEqual({ state: 'pid', pid: 4242, from: 'file' })
    expect(good.calls).toEqual(['read', 'answer null'])
    const missing = fake([{ state: 'missing' }])
    await expect(settlePidFile(missing.deps)).resolves.toEqual({ state: 'missing' })
    expect(missing.calls).toEqual(['read', 'answer null'])
  })
})

describe('isDaemonRunning', () => {
  it('an unreadable pid file whose daemon answers is a daemon that runs', async () => {
    // `harness new`, `ensure`, `remote` and `grid setup` refused with "not running" on such a file.
    const t = fake([unreadable], { status: async () => ({ pid: process.pid }) })
    await expect(isDaemonRunning(t.deps)).resolves.toBe(true)
    expect(t.calls).toContain(`answer ${process.pid}`)
    await expect(isDaemonRunning(fake([unreadable]).deps)).resolves.toBe(false)
  })
})

describe("this computer's pid file and its master's status file", () => {
  const CLAIMED = Date.parse('2026-11-19T08:00:00Z')
  /** A FILETIME start marker for [ms]. */
  const at = (ms: number) => `w:${(BigInt(ms) + 11_644_473_600_000n) * 10_000n}`
  const row = (pid: number, startedMs: number, argv: string[]): ProcessRow => ({
    pid, parentPid: 1, executable: 'C:\\node.exe', startMarker: at(startedMs), args: argv.join(' '), nativeArgv: argv,
  })
  const master = (startedMs: number) => row(500, startedMs, ['C:\\node.exe', 'C:\\cli.js', '__harnessd'])

  type Own = { settle: typeof settlePidFile; deps: typeof import('./pidFileSettle.js').processSettleDeps; readPid: () => number | null; pidFile: string }

  /** No daemon answering and no lock, and a status file that master 500 wrote at CLAIMED, in a data folder of its own;
   *  [check] gets this computer's modules, loaded on it. */
  async function computer(check: (own: Own) => Promise<void>) {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-settle-status-'))
    vi.stubEnv('ADAPTER_DATA_DIR', dataDir)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.resetModules()
      const { HARNESSD_STATUS_FILE, PID_FILE, readPid } = await import('./daemonState.js')
      const { processSettleDeps, settlePidFile: settle } = await import('./pidFileSettle.js')
      writeFileSync(HARNESSD_STATUS_FILE, `${JSON.stringify({
        state: 'restarting', corePid: null, restarts: 3, lastExit: 'code 1', lastExitReason: 'crashed', safeMode: null, protocol: 2,
        since: CLAIMED, masterVersion: '1.0.0', reexecs: 0, masterPid: 500,
      })}\n`)
      utimesSync(HARNESSD_STATUS_FILE, CLAIMED / 1000, CLAIMED / 1000)
      await check({ settle, deps: processSettleDeps, readPid, pidFile: PID_FILE })
    } finally {
      warn.mockRestore()
      vi.unstubAllEnvs()
      vi.resetModules()
      rmSync(dataDir, { recursive: true, force: true })
    }
  }

  it.each(['darwin', 'linux'] as const)('on %s, an unreadable pid file is kept while the master the status file names is alive', async (platform) => {
    await computer(async ({ settle, deps, readPid, pidFile }) => {
      writeFileSync(pidFile, 'x')
      await expect(settle(deps(platform, { isAlive: (pid) => pid === 500 }))).resolves.toEqual({ state: 'pid', pid: 500, from: 'daemon' })
      expect(readFileSync(pidFile, 'utf8')).toBe('x')
      expect(readPid()).toBe(500)
      await expect(settle(deps(platform, { isAlive: () => false }))).resolves.toEqual({ state: 'missing' })
      expect(existsSync(pidFile)).toBe(false)
      expect(readFileSync(`${pidFile}.unreadable`, 'utf8')).toBe('x')
    })
  })

  it('on Windows, the master counts only when the process table shows it, started before it wrote the status file', async () => {
    await computer(async ({ settle, deps, pidFile }) => {
      writeFileSync(pidFile, 'x')
      await expect(settle(deps('win32', { isAlive: () => true, rows: async () => [master(CLAIMED - 5_000)] }))).resolves.toEqual({ state: 'pid', pid: 500, from: 'daemon' })
      expect(readFileSync(pidFile, 'utf8')).toBe('x')
      // Started after it, or another program: Windows gave the master's pid to another process since.
      for (const rows of [[master(CLAIMED + 60_000)], [row(500, CLAIMED - 5_000, ['C:\\Windows\\notepad.exe', 'a.txt'])]]) {
        writeFileSync(pidFile, 'x')
        await expect(settle(deps('win32', { isAlive: () => true, rows: async () => rows }))).resolves.toEqual({ state: 'missing' })
        expect(existsSync(pidFile)).toBe(false)
      }
    })
  })
})

describe("this computer's pid file", () => {
  it('a stray one is kept as adapter.pid.unreadable while no daemon answers and no other process holds the lock', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'pid-settle-'))
    vi.stubEnv('ADAPTER_DATA_DIR', dataDir)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.resetModules()
      const { PID_FILE, readPid } = await import('./daemonState.js')
      const { SPAWN_LOCK_DIR, acquireSpawnLock } = await import('./daemonSpawnLock.js')
      const { settlePidFile: settle } = await import('./pidFileSettle.js')
      writeFileSync(PID_FILE, 'x')
      // Another process holds the spawn lock: it may be writing the file this moment.
      mkdirSync(SPAWN_LOCK_DIR, { mode: 0o700 })
      await expect(settle()).resolves.toEqual({ state: 'busy' })
      expect(readFileSync(PID_FILE, 'utf8')).toBe('x')
      expect(readPid()).toBeNull()
      rmSync(SPAWN_LOCK_DIR, { recursive: true })
      // This process holds it.
      const release = await acquireSpawnLock('start', { waitMs: 0 })
      try {
        await expect(settle()).resolves.toEqual({ state: 'missing' })
      } finally { release() }
      expect(existsSync(PID_FILE)).toBe(false)
      expect(readFileSync(`${PID_FILE}.unreadable`, 'utf8')).toBe('x')
      expect(warn).toHaveBeenCalledWith('[state] adapter.pid could not be read (unexpected content); kept as adapter.pid.unreadable, starting empty.')
    } finally {
      warn.mockRestore()
      vi.unstubAllEnvs()
      vi.resetModules()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
