import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'

const io = vi.hoisted(() => ({ failWrite: undefined as string | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    // Only a write to a descriptor: the writer's temporary file.
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (io.failWrite && typeof args[0] === 'number') throw Object.assign(new Error(`${io.failWrite}: fixture`), { code: io.failWrite })
      return actual.writeFileSync(...args)
    },
  }
})

let dataDir = ''

async function daemonState() {
  vi.resetModules()
  process.env.ADAPTER_DATA_DIR = dataDir
  return import('./daemonState.js')
}

beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'adapter-launch-')) })
afterEach(() => {
  io.failWrite = undefined
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ADAPTER_DATA_DIR
})

describe('removePidFileIf', () => {
  it('removes the file only when it names the given pid', async () => {
    const { PID_FILE, removePidFileIf } = await daemonState()
    writeFileSync(PID_FILE, '777\n')
    expect(removePidFileIf(778)).toBe(false)
    expect(existsSync(PID_FILE)).toBe(true) // another daemon's record survives our failed child
    expect(removePidFileIf(undefined)).toBe(false)
    expect(removePidFileIf(777)).toBe(true)
    expect(existsSync(PID_FILE)).toBe(false)
  })
})

describe('the pid file', () => {
  it('an empty or torn pid file is unreadable, not missing', async () => {
    const { PID_FILE, readPidFile } = await daemonState()
    expect(readPidFile()).toEqual({ state: 'missing' })
    for (const text of ['', '12x']) {
      writeFileSync(PID_FILE, text)
      expect(readPidFile(), JSON.stringify(text)).toEqual({ state: 'unreadable' })
    }
    rmSync(PID_FILE)
    mkdirSync(PID_FILE)
    expect(readPidFile()).toEqual({ state: 'unreadable' })
    rmSync(PID_FILE, { recursive: true })
    writeFileSync(PID_FILE, '4242\n')
    expect(readPidFile()).toEqual({ state: 'pid', pid: 4242 })
  })

  it('readPid answers the daemon\'s own pid for a file that cannot be read', async () => {
    const { PID_FILE, readPid, setAnsweredPid } = await daemonState()
    writeFileSync(PID_FILE, 'x')
    expect(readPid()).toBeNull()
    setAnsweredPid(77)
    expect(readPid()).toBe(77)
    writeFileSync(PID_FILE, '4242\n')
    expect(readPid()).toBe(4242)
    rmSync(PID_FILE)
    expect(readPid()).toBeNull()
  })

  it('writePidFile leaves the old pid when the write fails', async () => {
    const { PID_FILE, writePidFile } = await daemonState()
    writePidFile(4242)
    expect(readFileSync(PID_FILE, 'utf8')).toBe('4242\n')
    if (process.platform !== 'win32') expect(statSync(PID_FILE).mode & 0o777).toBe(0o600)
    io.failWrite = 'ENOSPC'
    expect(() => writePidFile(5151)).toThrow('ENOSPC')
    expect(readFileSync(PID_FILE, 'utf8')).toBe('4242\n')
    expect(readdirSync(dataDir)).toEqual(['adapter.pid'])
  })

  it('pidFileWrittenMs is null for an answered pid', async () => {
    const { PID_FILE, pidFileWrittenMs, readPid, setAnsweredPid, writePidFile } = await daemonState()
    expect(pidFileWrittenMs()).toBeNull()
    writePidFile(4242)
    expect(pidFileWrittenMs()).toBe(statSync(PID_FILE).mtimeMs)
    writeFileSync(PID_FILE, 'x')
    setAnsweredPid(77)
    expect(readPid()).toBe(77)
    expect(pidFileWrittenMs()).toBeNull()
  })
})

describe('the pid file\'s place', () => {
  // `harness status` reads it in the shell's folder, the core writes it from the home: one data folder for both.
  it('the pid file is under the home\'s data folder when ADAPTER_DATA_DIR is relative, from any folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'pid-home-')), elsewhere = mkdtempSync(join(tmpdir(), 'pid-cwd-'))
    try {
      const tsx = fileURLToPath(new URL('../../node_modules/tsx/dist/cli.mjs', import.meta.url))
      const script = `import { PID_FILE } from ${JSON.stringify(fileURLToPath(new URL('./daemonState.ts', import.meta.url)))}; console.log(PID_FILE)`
      const run = spawnSync(process.execPath, [tsx, '--eval', script], {
        cwd: elsewhere, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ADAPTER_DATA_DIR: 'data' }, encoding: 'utf8', timeout: 20_000,
      })
      expect(run.status, run.stderr).toBe(0)
      expect(run.stdout.trim()).toBe(join(home, 'data', 'adapter.pid'))
    } finally {
      for (const root of [home, elsewhere]) rmSync(root, { recursive: true, force: true })
    }
  })
})
