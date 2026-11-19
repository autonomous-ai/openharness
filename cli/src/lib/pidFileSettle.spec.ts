import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PidFileRead } from './daemonState.js'
import { settlePidFile, type SettleDeps } from './pidFileSettle.js'

const unreadable: PidFileRead = { state: 'unreadable' }

/** Reads answer [reads] in turn, the last one again after that; no daemon answers and the lock is free. */
function fake(reads: PidFileRead[], over: Partial<SettleDeps> = {}) {
  const calls: string[] = []
  const deps: SettleDeps = {
    read: () => { calls.push('read'); return reads.length > 1 ? reads.shift()! : reads[0]! },
    status: async () => { calls.push('status'); return null },
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
