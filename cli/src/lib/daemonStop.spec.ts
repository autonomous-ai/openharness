import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { StopDeps } from './daemonStop.js'

let dataDir = ''

async function load() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonStop.js')
}

function fakeDeps(state: { pid: number | null; alive: Set<number>; killed: string[]; locked: number; released: number }, overrides: Partial<StopDeps> = {}): StopDeps {
  const clock = { now: 0 }
  return {
    readPid: () => state.pid,
    isAlive: (pid) => state.alive.has(pid),
    kill: (pid, signal) => {
      state.killed.push(`${pid}:${signal}`)
      if (signal === 'SIGKILL') state.alive.delete(pid)
    },
    sleep: async (ms) => { clock.now += ms },
    now: () => clock.now,
    lock: async () => { state.locked += 1; return () => { state.released += 1 } },
    warn: () => {},
    ...overrides,
  }
}

describe('stopDaemonProcess', () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-stop-')) })
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); delete process.env.ADAPTER_DATA_DIR })

  it('takes the spawn lock, SIGTERMs, escalates to SIGKILL, and clears the pid file it stopped', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '500\n')
    const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
    const r = await stopDaemonProcess(fakeDeps(state))
    expect(r).toEqual({ pid: 500, stopped: true })
    expect(state.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
    expect(state.locked).toBe(1)
    expect(state.released).toBe(1)
    expect(existsSync(PID_FILE)).toBe(false)
  })

  it('clears the re-execution marker of the master it stopped, and no other', async () => {
    // Stopped in the moment after it re-executed, the master dies of the signal before it can clear its
    // marker; the next start must not take that for an update that never came up.
    const { stopDaemonProcess } = await load()
    const { HARNESSD_REEXEC_FILE, PID_FILE } = await import('./daemonState.js')
    const marker = (pid: number) => JSON.stringify({ pid, from: 'a'.repeat(64), to: 'b'.repeat(64), at: 1 })
    writeFileSync(PID_FILE, '500\n')
    writeFileSync(HARNESSD_REEXEC_FILE, marker(500))
    await stopDaemonProcess(fakeDeps({ pid: 500, alive: new Set([500]), killed: [], locked: 0, released: 0 }))
    expect(existsSync(HARNESSD_REEXEC_FILE)).toBe(false)
    // Another master's marker (one stopped beside it, or a pid file gone stale) is not this stop's.
    writeFileSync(PID_FILE, '501\n')
    writeFileSync(HARNESSD_REEXEC_FILE, marker(777))
    await stopDaemonProcess(fakeDeps({ pid: 501, alive: new Set([501]), killed: [], locked: 0, released: 0 }))
    expect(existsSync(HARNESSD_REEXEC_FILE)).toBe(true)
    // Stopped through launchd or systemd, likewise.
    writeFileSync(HARNESSD_REEXEC_FILE, marker(600))
    await stopDaemonProcess(fakeDeps({ pid: 600, alive: new Set(), killed: [], locked: 0, released: 0 }, {
      stopPlatform: () => ({ ok: true, stopped: 600 }) as never,
    }))
    expect(existsSync(HARNESSD_REEXEC_FILE)).toBe(false)
  })

  it('does not delete a pid file that a different daemon wrote meanwhile', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '500\n')
    const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
    const deps = fakeDeps(state, {
      kill: (pid, signal) => {
        state.killed.push(`${pid}:${signal}`)
        state.alive.delete(pid)
        state.pid = 501 // the file now names someone else
        writeFileSync(PID_FILE, '501\n')
      },
    })
    await stopDaemonProcess(deps)
    expect(state.killed).toEqual(['500:SIGTERM'])
    expect(existsSync(PID_FILE)).toBe(true)
  })

  it('clears a pid file naming a dead process and reports nothing stopped', async () => {
    const { stopDaemonProcess } = await load()
    const { PID_FILE } = await import('./daemonState.js')
    writeFileSync(PID_FILE, '9\n')
    const state = { pid: 9, alive: new Set<number>(), killed: [] as string[], locked: 0, released: 0 }
    await expect(stopDaemonProcess(fakeDeps(state))).resolves.toEqual({ pid: null, stopped: false })
    expect(existsSync(PID_FILE)).toBe(false)
    expect(state.released).toBe(1)
  })

  describe('when launchd or systemd runs the master', () => {
    it('asks the platform, waits for the master to go, and sends no signal of its own', async () => {
      const { stopDaemonProcess } = await load()
      const { PID_FILE } = await import('./daemonState.js')
      writeFileSync(PID_FILE, '500\n')
      const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      let asked = 0
      const deps = fakeDeps(state, {
        stopPlatform: () => { asked++; return { ok: true, stopped: 500 } },
        sleep: async () => { state.alive.delete(500) }, // the master finishes its ordered stop
      })
      await expect(stopDaemonProcess(deps)).resolves.toEqual({ pid: 500, stopped: true })
      expect(asked).toBe(1)
      expect(state.killed).toEqual([])
      expect(existsSync(PID_FILE)).toBe(false)
      expect(state.released).toBe(1)
    })

    it('leaves a pid file that names someone else by the time the master has gone', async () => {
      const { stopDaemonProcess } = await load()
      const { PID_FILE } = await import('./daemonState.js')
      writeFileSync(PID_FILE, '500\n')
      const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      const deps = fakeDeps(state, {
        stopPlatform: () => ({ ok: true, stopped: 500 }),
        sleep: async () => { state.alive.delete(500); state.pid = 501; writeFileSync(PID_FILE, '501\n') },
      })
      await expect(stopDaemonProcess(deps)).resolves.toEqual({ pid: 500, stopped: true })
      expect(existsSync(PID_FILE)).toBe(true)
    })

    it('signals the master itself when the platform cannot stop it, or has not in time', async () => {
      const { stopDaemonProcess, PLATFORM_STOP_WAIT_MS } = { ...(await load()), ...(await import('./platformDaemon.js')) }
      const warnings: string[] = []
      const refused = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      await stopDaemonProcess(fakeDeps(refused, { stopPlatform: () => ({ ok: false, detail: 'launchctl bootout failed' }), warn: (m) => warnings.push(m) }))
      expect(warnings).toEqual(['  ! launchctl bootout failed — stopping it directly'])
      expect(refused.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
      const slow = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      const slept: number[] = []
      const clock = { now: 0 }
      await stopDaemonProcess(fakeDeps(slow, { stopPlatform: () => ({ ok: true, stopped: 500 }), now: () => clock.now, sleep: async (ms) => { slept.push(ms); clock.now += ms } }))
      expect(clock.now).toBeGreaterThanOrEqual(PLATFORM_STOP_WAIT_MS)
      expect(slow.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
    })

    it('changes nothing when no platform runs it, or nothing was running', async () => {
      const { stopDaemonProcess } = await load()
      const none = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      await expect(stopDaemonProcess(fakeDeps(none, { stopPlatform: () => null }))).resolves.toEqual({ pid: 500, stopped: true })
      expect(none.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
      const idle = { pid: null, alive: new Set<number>(), killed: [] as string[], locked: 0, released: 0 }
      let asked = 0
      await expect(stopDaemonProcess(fakeDeps(idle, { stopPlatform: () => { asked++; return { ok: true, stopped: null } } }))).resolves.toEqual({ pid: null, stopped: false })
      expect(asked).toBe(1)
      expect(idle.killed).toEqual([])
    })

    it('stops with signals a daemon `harness start` spawned beside the platform\'s, once the platform\'s has gone', async () => {
      const { stopDaemonProcess } = await load()
      const state = { pid: 500, alive: new Set([500]), killed: [] as string[], locked: 0, released: 0 }
      await expect(stopDaemonProcess(fakeDeps(state, { stopPlatform: () => ({ ok: true, stopped: 600 }) }))).resolves.toEqual({ pid: 500, stopped: true })
      expect(state.killed).toEqual(['500:SIGTERM', '500:SIGKILL'])
    })

    it('asks the platform by default, which for a data folder no platform runs is nobody', async () => {
      const { defaultStopDeps } = await load()
      expect(defaultStopDeps().stopPlatform!()).toBeNull()
    })
  })
})
