/**
 * A program-owned harness never finds its daemon left down (#4393 part E, lampOS #7275): with a program token,
 * `harness ensure` and `harness reply` start the daemon of their data folder when it is down, within a bound, and say
 * so (`daemonStarted`, `daemonStartMs`). `harness start --if-down` stays for callers that start it themselves.
 *
 * The start is `harness start` itself, run as a child of this CLI: the same spawn lock, the same platform unit when
 * this data folder has one, the same refusals. What this adds is the bound, and one guard on the unit.
 *
 * The guards. On Linux `harness start` asks systemd to start `harnessd.service` when the unit file under this HOME is
 * this data folder's (harnessd/platform.ts `ownedBy`: its log is this folder's). A lamp's user runs a pinned Harness
 * daemon under that unit for its own folder, and two cases would reach it. (1) The unit file read here is not the one
 * the user manager loaded (another HOME or XDG_CONFIG_HOME: a test, a second build): `systemctl --user start
 * harnessd.service` would start the person's unit. (2) The unit is this folder's but runs another port (PORT in its
 * Environment=, 18473 when absent): `harness start` would rewrite it with this caller's port, replacing the person's
 * daemon. In both the unit is never touched, and the start fails saying why. Without a program token nothing here
 * runs, and `harness start` behaves as before.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentClientError } from '../agentClient/daemon.js'
import { processAlive } from './daemonState.js'
import { platformDaemonDeps } from './platformDaemon.js'
import { ownProcessGroup } from './windows/noWindow.js'

/** How long a program's command waits for the daemon it started: well past a cold start on a lamp's board (a few
 *  seconds), well short of `harness start`'s own wait for a platform unit (PLATFORM_START_WAIT_MS, 60 s). */
export const PROGRAM_DAEMON_START_MS = 30_000
/** How often the pid file is read while waiting. */
const POLL_MS = 100
/** The port a daemon runs on when nothing sets PORT (config/env.ts). */
const DEFAULT_PORT = 18473
/** What `harness start` printed, kept for the refusal: one file per data folder, rewritten at each start. */
export const PROGRAM_START_LOG = 'program-start.log'

/** What a program's command reports: `daemonStarted` and `daemonStartMs` in its JSON. */
export interface DaemonEnsured { started: boolean; ms: number }

/** Why the daemon is still down: `TIMEOUT` past the bound, `EXITED` when `harness start` failed, `OTHER_DAEMON` when
 *  the platform unit for this folder runs another port's daemon. */
export type DaemonDownReason = 'TIMEOUT' | 'EXITED' | 'OTHER_DAEMON'

export interface ProgramDaemonDeps {
  /** The daemon of this data folder runs: its pid file names a live process. */
  running(): boolean
  /** The platform unit `harness start` would act on for this data folder (launchd or systemd): its text, and for
   *  systemd the file the user manager loaded `harnessd.service` from, when it says; null for none. */
  unit(): { text: string; file: string; loadedFrom: string | null } | null
  /** Run `harness start`; resolves when it exits, with its code and what it printed. */
  start(): Promise<{ code: number | null; output: string }>
  now(): number
  sleep(ms: number): Promise<void>
}

/** The port a launchd or systemd definition runs its daemon on: the PORT it carries, else the default. */
export function unitPort(text: string): number {
  const systemd = /^Environment="PORT=(\d+)"$/m.exec(text)
  const launchd = /<key>PORT<\/key>\s*<string>(\d+)<\/string>/.exec(text)
  const found = systemd?.[1] ?? launchd?.[1]
  return found ? Number(found) : DEFAULT_PORT
}

/**
 * Start the daemon of [dataDir] on [port] (the configured one, `env.PORT`) when it is down, waiting at most [boundMs].
 * `{started: false, ms: 0}` when it runs already. Throws `AgentClientError('DAEMON_NOT_STARTED')`, with a
 * `DaemonDownReason`, when it is still down; a start past the bound goes on by itself, and the next call finds it up.
 * [dataDir] and [port] are this process's (`env.ADAPTER_DATA_DIR`, `env.PORT`): `harness start` runs with its
 * environment.
 */
export async function ensureDaemonForProgram(dataDir: string, port: number,
  options: { boundMs?: number; deps?: Partial<ProgramDaemonDeps> } = {}): Promise<DaemonEnsured> {
  const deps: ProgramDaemonDeps = { ...defaultDeps(dataDir), ...options.deps }
  const bound = options.boundMs ?? PROGRAM_DAEMON_START_MS
  const began = deps.now()
  if (deps.running()) return { started: false, ms: 0 }
  const down = (reason: DaemonDownReason, detail: string): never => {
    throw new AgentClientError('DAEMON_NOT_STARTED', `Harness is not running here, and ${detail}`, reason)
  }
  const unit = deps.unit()
  if (unit !== null && unit.loadedFrom && resolve(unit.loadedFrom) !== resolve(unit.file)) {
    down('OTHER_DAEMON', `systemd runs harnessd.service from ${unit.loadedFrom}, not ${unit.file}: that daemon was left alone. Run this with the HOME that unit is for, or remove ${unit.file}.`)
  }
  if (unit !== null && unitPort(unit.text) !== port) {
    down('OTHER_DAEMON', `the harnessd unit for this data folder runs it on port ${unitPort(unit.text)}, not ${port}: it was left alone. Start it with harness start, or use that port.`)
  }
  let exited: { code: number | null; output: string } | null = null
  void deps.start().then((result) => { exited = result })
  for (;;) {
    if (deps.running()) return { started: true, ms: deps.now() - began }
    const ended = exited as { code: number | null; output: string } | null
    if (ended && ended.code !== 0) down('EXITED', `harness start failed: ${lastLine(ended.output) || `exit ${ended.code}`}`)
    if (deps.now() - began >= bound) down('TIMEOUT', `it did not start within ${Math.round(bound / 1000)}s. It may still be starting: check harness status.`)
    await deps.sleep(POLL_MS)
  }
}

/** What `harness start` said went wrong: its last `✗` line, else its last line. */
function lastLine(text: string): string {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  const failed = lines.filter((line) => line.startsWith('✗')).pop()
  return (failed ?? lines.pop() ?? '').replace(/^✗\s*/, '')
}

function defaultDeps(dataDir: string): ProgramDaemonDeps {
  return {
    running: () => {
      try {
        const pid = parseInt(readFileSync(join(dataDir, 'adapter.pid'), 'utf8').trim(), 10)
        return Number.isFinite(pid) && pid > 0 && processAlive(pid)
      } catch { return false }
    },
    unit: () => {
      const { service, logFile } = platformDaemonDeps({ logFile: join(dataDir, 'harness.log') })
      // Harness OS's own unit is only ever this CLI's on the default folder and port (platformDaemon.ts osDaemonUnit).
      if (!service || service.os || service.platform === 'taskscheduler' || !service.ownedBy(logFile)) return null
      let text: string
      try { text = readFileSync(service.file, 'utf8') } catch { return null }
      return { text, file: service.file, loadedFrom: service.platform === 'systemd' ? systemdFragment() : null }
    },
    start: () => runHarnessStart(dataDir),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** The file the user manager loaded harnessd.service from; null when it cannot say (no user manager, not loaded). */
export function systemdFragment(run: typeof spawnSync = spawnSync): string | null {
  const shown = run('systemctl', ['--user', 'show', 'harnessd.service', '--property=FragmentPath'], { encoding: 'utf8', timeout: 10_000 })
  if (shown.error || shown.status !== 0) return null
  const fragment = /^FragmentPath=(.*)$/m.exec(String(shown.stdout ?? ''))?.[1]?.trim()
  return fragment || null
}

/** `harness start` with this process's CLI and environment, in its own process group, so a start past the bound goes on. */
function runHarnessStart(dataDir: string): Promise<{ code: number | null; output: string }> {
  const logPath = join(dataDir, PROGRAM_START_LOG)
  let fd: number | 'ignore' = 'ignore'
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fd = openSync(logPath, 'w', 0o600)
  } catch { /* started all the same, without its words */ }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'start'], {
      ...ownProcessGroup(), stdio: ['ignore', fd, fd], env: process.env,
    })
    if (typeof fd === 'number') closeSync(fd)
    const done = (code: number | null) => {
      let output = ''
      try { output = readFileSync(logPath, 'utf8') } catch { /* none */ }
      resolve({ code, output })
    }
    child.on('error', () => done(1))
    child.on('exit', (code) => done(code))
    child.unref()
  })
}
