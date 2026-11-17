import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentClientError } from '../agentClient/daemon.js'
import { PROGRAM_DAEMON_START_MS, ensureDaemonForProgram, systemdFragment, unitPort, type ProgramDaemonDeps } from './programDaemon.js'

/** A clock that moves only when the code sleeps, and a daemon that comes up [upAfterMs] after `harness start` runs. */
function world(options: { up?: boolean; upAfterMs?: number; unit?: { text: string; file: string; loadedFrom: string | null } | null; exit?: { code: number | null; output: string } } = {}) {
  let t = 1_000, startedAt: number | null = null
  const starts: number[] = []
  const deps: ProgramDaemonDeps = {
    running: () => options.up === true || (startedAt !== null && options.upAfterMs !== undefined && t - startedAt >= options.upAfterMs),
    unit: () => options.unit ?? null,
    start: () => {
      startedAt = t
      starts.push(t)
      return options.exit ? Promise.resolve(options.exit) : new Promise(() => {})
    },
    now: () => t,
    sleep: async (ms) => { t += ms },
  }
  return { deps, starts }
}

const refusal = async (promise: Promise<unknown>): Promise<AgentClientError> => {
  try { await promise } catch (error) { if (error instanceof AgentClientError) return error; throw error }
  throw new Error('it did not refuse')
}

describe('ensureDaemonForProgram', () => {
  it('leaves a running daemon alone and says it started nothing', async () => {
    const w = world({ up: true })
    await expect(ensureDaemonForProgram('/data', 18473, { deps: w.deps })).resolves.toEqual({ started: false, ms: 0 })
    expect(w.starts).toEqual([])
  })

  it('starts a daemon that is down and reports how long it took', async () => {
    const w = world({ upAfterMs: 2_300 })
    await expect(ensureDaemonForProgram('/data', 18473, { deps: w.deps })).resolves.toEqual({ started: true, ms: 2_300 })
    expect(w.starts).toHaveLength(1)
  })

  it('starts through this data folder\'s own unit on its port', async () => {
    const w = world({ upAfterMs: 500, unit: { text: '[Service]\nEnvironment="PORT=18600"\n', file: '/h/u', loadedFrom: '/h/u' } })
    await expect(ensureDaemonForProgram('/data', 18600, { deps: w.deps })).resolves.toEqual({ started: true, ms: 500 })
  })

  it('gives up at the bound, which it names, and says the start may go on', async () => {
    const w = world({ upAfterMs: 60_000 })
    const error = await refusal(ensureDaemonForProgram('/data', 18473, { deps: w.deps, boundMs: 5_000 }))
    expect(error.code).toBe('DAEMON_NOT_STARTED')
    expect(error.reason).toBe('TIMEOUT')
    expect(error.message).toContain('within 5s')
    const late = await refusal(ensureDaemonForProgram('/data', 18473, { deps: world({}).deps }))
    expect(late.message).toContain(`within ${PROGRAM_DAEMON_START_MS / 1000}s`)
  })

  it('says why harness start failed, in its last words', async () => {
    const w = world({ exit: { code: 1, output: 'starting…\n\n✗ the daemon exited during startup\n  logs   ~/x\n' } })
    const error = await refusal(ensureDaemonForProgram('/data', 18473, { deps: w.deps }))
    expect(error.reason).toBe('EXITED')
    expect(error.message).toContain('harness start failed: the daemon exited during startup')
    const plain = await refusal(ensureDaemonForProgram('/data', 18473, { deps: world({ exit: { code: 1, output: 'no lock\n' } }).deps }))
    expect(plain.message).toContain('harness start failed: no lock')
    const silent = await refusal(ensureDaemonForProgram('/data', 18473, { deps: world({ exit: { code: null, output: '' } }).deps }))
    expect(silent.message).toContain('harness start failed: exit null')
  })

  it('keeps waiting when harness start exits 0 before the pid file is there', async () => {
    const w = world({ upAfterMs: 400, exit: { code: 0, output: 'machine already running' } })
    await expect(ensureDaemonForProgram('/data', 18473, { deps: w.deps })).resolves.toEqual({ started: true, ms: 400 })
  })

  it('never touches a unit for this data folder that runs another port\'s daemon', async () => {
    const w = world({ upAfterMs: 0, unit: { text: '[Service]\nEnvironment="ADAPTER_DATA_DIR=/data"\n', file: '/h/u', loadedFrom: null } })
    const error = await refusal(ensureDaemonForProgram('/data', 18999, { deps: w.deps }))
    expect(error.reason).toBe('OTHER_DAEMON')
    expect(error.message).toContain('port 18473, not 18999')
    expect(w.starts).toEqual([])
  })
})

describe('the person\'s own harnessd.service', () => {
  it('is never started for a unit file the user manager did not load (another HOME)', async () => {
    const w = world({ upAfterMs: 0, unit: { text: '[Service]\n', file: '/tmp/test-home/.config/systemd/user/harnessd.service', loadedFrom: '/home/lampos/.config/systemd/user/harnessd.service' } })
    const error = await refusal(ensureDaemonForProgram('/tmp/test-home/.harness/cli/data', 18473, { deps: w.deps }))
    expect(error.reason).toBe('OTHER_DAEMON')
    expect(error.message).toContain('/home/lampos/.config/systemd/user/harnessd.service')
    expect(w.starts).toEqual([])
  })

  it('reads where systemd loaded it from, and nothing when it cannot say', () => {
    const answer = (status: number | null, stdout: string, error?: Error) => (() => ({ status, stdout, error })) as never
    expect(systemdFragment(answer(0, 'FragmentPath=/home/lampos/.config/systemd/user/harnessd.service\n'))).toBe('/home/lampos/.config/systemd/user/harnessd.service')
    expect(systemdFragment(answer(0, 'FragmentPath=\n'))).toBeNull()
    expect(systemdFragment(answer(0, ''))).toBeNull()
    expect(systemdFragment(answer(1, 'FragmentPath=/x'))).toBeNull()
    expect(systemdFragment(answer(null, '', new Error('ENOENT')))).toBeNull()
  })
})

describe('unitPort', () => {
  it('reads PORT off a systemd unit or a launchd plist, and the default without one', () => {
    expect(unitPort('[Service]\nEnvironment="PORT=18474"\nEnvironment="HARNESSD_PLATFORM=systemd"\n')).toBe(18474)
    expect(unitPort('<dict>\n\t\t<key>PORT</key>\n\t\t<string>18475</string>\n')).toBe(18475)
    expect(unitPort('[Service]\nEnvironment="NOT_PORT=1"\n')).toBe(18473)
  })
})

describe('the real deps', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'program-daemon-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('read this data folder\'s pid file: a live process is a running daemon, a dead one or none is not', async () => {
    writeFileSync(join(dir, 'adapter.pid'), `${process.pid}\n`)
    await expect(ensureDaemonForProgram(dir, 18473)).resolves.toEqual({ started: false, ms: 0 })
  })
})
