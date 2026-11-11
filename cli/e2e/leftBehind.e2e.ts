/**
 * A daemon under test takes nothing of the developer's and outlives nothing of the run's.
 *
 * On 2026-11-11 two daemons from an end-to-end run 1.5 days earlier were still running on a developer's Mac. The run's Vitest
 * had been killed, so no afterEach closed them, and their masters, parented to launchd, ran on. One held 51793, the real
 * daemon's bridge port, which no daemon under test asked a port of its own for; the other ran `lsof` every 5.5 s asking who
 * held it, about 7% of a core around the clock.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ownProcessGroup } from '../src/lib/windows/noWindow.js'
import { alive, processTable } from '../src/testing/spawnedRuns.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'

interface Started { root: string; master: number; core: number; socket: string }

/** The master [pid] and the service processes it runs (`harnessd-<process>`): the short-lived probes they start
 *  (`lsof`, `ps`) are left out, as their pids can go to strangers while the test waits. */
const daemonProcesses = (pid: number): number[] => [pid, ...processTable()
  .filter((row) => row.ppid === pid && /^harnessd-/.test(row.command)).map((row) => row.pid)]

const tmuxServer = (socket: string): number | null => {
  try { return Number(execFileSync('tmux', ['-S', socket, 'display-message', '-p', '#{pid}'], { encoding: 'utf8', timeout: 5_000 }).trim()) || null } catch { return null }
}

describe('a daemon under test', () => {
  let daemon: IsolatedDaemon | undefined
  let worker: ChildProcess | undefined
  let started: Started | undefined
  let watched: number[] = []
  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
    // What a failing run left: this test's own processes, ended here so the run leaves nothing either.
    if (worker?.pid && alive(worker.pid)) { try { process.kill(-worker.pid, 'SIGKILL') } catch { /* gone */ } }
    for (const pid of watched) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
    if (started) {
      try { execFileSync('tmux', ['-S', started.socket, 'kill-server'], { stdio: 'ignore', timeout: 5_000 }) } catch { /* gone */ }
      rmSync(started.root, { recursive: true, force: true })
    }
    worker = undefined
    started = undefined
    watched = []
  })

  it('gives its bridge a port of its own, never the developer\'s daemon\'s 51793', async () => {
    daemon = await IsolatedDaemon.create()
    expect(daemon.env.HARNESS_CONNECTIONS_PORT).toBe('0')
    // A test's own port still stands.
    expect((await IsolatedDaemon.create({ env: { HARNESS_CONNECTIONS_PORT: '4321' } }).then(async (other) => {
      await other.close()
      return other.env.HARNESS_CONNECTIONS_PORT
    }))).toBe('4321')
  })

  it.each<[string, 'exits' | 'waits', (child: ChildProcess) => void]>([
    ['exits without closing it', 'exits', (child) => { child.stdin!.write('go\n') }],
    ['is killed, as a run\'s timeout kills it', 'waits', (child) => { child.kill('SIGKILL') }],
    ['is interrupted with Ctrl-C, which reaches its terminal\'s process group', 'waits', (child) => { process.kill(-child.pid!, 'SIGINT') }],
  ])('is gone, tmux server and all, once the worker that started it %s', async (_, mode, end) => {
    // Not a Vitest run: it keeps no artifacts, which only a test can file.
    const { E2E_ARTIFACTS_DIR: _artifacts, ...env } = process.env
    // A process group of its own, as a terminal gives the run it starts.
    const child = worker = spawn(process.execPath, ['--import', 'tsx', 'e2e/harness/abandonedWorker.ts', mode], {
      cwd: CLI_ROOT, env, stdio: ['pipe', 'pipe', 'inherit'], ...ownProcessGroup(),
    })
    let out = ''
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString() })
    started = await until('the worker\'s daemon', () => out.includes('\n') ? JSON.parse(out.split('\n')[0]) as Started : null, 120_000, 100)
    const tmux = tmuxServer(started.socket)
    expect(tmux, 'the daemon\'s tmux server').not.toBeNull()
    watched = [...new Set([...daemonProcesses(started.master), started.core, tmux!])]
    expect(watched.length, 'master, core, edge and tmux at the least').toBeGreaterThanOrEqual(4)
    end(child)
    await until('every process of the daemon to be gone', () => watched.every((pid) => !alive(pid)) || null, 40_000, 100)
    // And its throwaway root.
    await until('the daemon\'s root to be removed', () => !existsSync(started!.root) || null, 10_000, 100)
  }, 240_000)
})
