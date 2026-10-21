/**
 * Where the rest of the CLI meets launchd, systemd or Task Scheduler, once someone has opted in with
 * `harness service install` (./serviceCommand.ts; the definitions are ../harnessd/platform.ts).
 *
 * One supervisor per machine. When the platform runs the master, `harness start` asks the platform to
 * start it rather than spawning a second master beside it, and every stop (`harness stop`, and the
 * stops inside logout, reset, update and a forced login) asks the platform to stop it: a signal from
 * here would read to launchd or systemd as a crash, and bring the master back. For anyone who has not
 * opted in, both find no definition and change nothing.
 *
 * The CLI never decides this from its own environment. HARNESSD_PLATFORM is set for the master by its
 * definition, and a shell in a tmux pane the daemon started inherits it; it would otherwise believe it
 * was the platform. What counts is the definition on disk, and what the running master wrote in its
 * status file.
 *
 * Harness OS is the one computer where nobody opts in: its package ships the unit (OS_UNIT_FILE), so
 * there every start and stop of its daemon goes through that unit (osDaemonUnit).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { env } from '../config/env.js'
import { readStatusFile } from '../harnessd/master.js'
import {
  OS_UNIT_FILE, PlatformService, TASK_STOPPED_FILE, bootTimeMs, defaultPlatformDeps, platformFor, stoppedThisBoot, type PlatformName,
  type PlatformState, type ServiceDefinition,
} from '../harnessd/platform.js'
import { DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, isAlive, readPid } from './daemonState.js'
import { withoutHarnessdEnv } from './harnessdEnv.js'
import { managedNodePath } from './nodeRuntime.js'
import { currentCli, harnessLaunchPath } from './windows/installLayout.js'
import { launchDetached, type LaunchOutcome } from './windows/launcher.js'

/**
 * The CLI's own settings that decide which daemon this is, carried into the definition when they are
 * set, so the platform runs the daemon `harness start` from this shell would: where its state, bundle
 * and sign-in live, its port, its environment file, and a local build's update pin. Without them a
 * definition written from a shell with ADAPTER_DATA_DIR set would run a master on the default folder,
 * whose pid file that shell's `harness start` would wait on in vain. Anything else belongs in the file
 * HARNESS_ENV_FILE names.
 */
export const CARRIED_ENV = ['ADAPTER_DATA_DIR', 'ADAPTER_CLI_DIR', 'HARNESS_AUTH_DIR', 'PORT', 'HARNESS_ENV_FILE', 'ADAPTER_UPDATE_DISABLE'] as const

/** How long a start through the platform waits for the master to claim the pid file, which it does once
 *  its core has bound: as long as `harness start` waits for one it spawned (daemonLaunch BIND_WAIT_MS). */
export const PLATFORM_START_WAIT_MS = 60_000
/** How long a stop waits for the platform's master to go: past the platform's own deadline to stop it
 *  (STOP_TIMEOUT_S), after which `harness stop`'s own signals take over. */
export const PLATFORM_STOP_WAIT_MS = 12_000

export interface PlatformDaemonDeps {
  /** harnessd's registration with this computer's platform; null where there is none (not macOS or Linux). */
  service: PlatformService | null
  /** The daemon's log, which is also how a definition is known to be this data folder's. */
  logFile: string
  readPid(): number | null
  isAlive(pid: number): boolean
  /** What runs the master `pid`, as its status file says. */
  masterPlatform(pid: number): PlatformName | null
  now(): number
  sleep(ms: number): Promise<void>
}

/**
 * The platform that would supervise harnessd here: this operating system's, or the one
 * HARNESSD_TEST_PLATFORM names, for the end-to-end suite only, which runs both definitions on any
 * computer against fake launchctl and systemctl (e2e/cli.e2e.ts). Unset, it changes nothing.
 */
export function supervisingPlatform(os: NodeJS.Platform, env: NodeJS.ProcessEnv): PlatformName | null {
  const forced = env.HARNESSD_TEST_PLATFORM
  return forced === 'launchd' || forced === 'systemd' ? forced : platformFor(os)
}

/** The port Harness OS's unit runs the daemon on: the default, as it sets none. */
const OS_DAEMON_PORT = '18473'

/**
 * Whether this CLI's daemon is the one Harness OS runs under its own unit: the unit is on disk, and this
 * CLI is on the data folder and port the unit runs, the defaults, as it sets neither. A shell with its
 * own ADAPTER_DATA_DIR or PORT (a test, a second daemon) has a daemon of its own, which the unit is not.
 * Never under the end-to-end suite's forced platform, whose fakes stand in for this computer's.
 */
export function osDaemonUnit(os: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): boolean {
  if (os !== 'linux' || env.HARNESSD_TEST_PLATFORM) return false
  if (env.ADAPTER_DATA_DIR || (env.PORT && env.PORT !== OS_DAEMON_PORT)) return false
  return exists(OS_UNIT_FILE)
}

/** This computer's: its platform, its pid file, the status file its master writes. */
export function platformDaemonDeps(overrides: Partial<PlatformDaemonDeps> = {}): PlatformDaemonDeps {
  const platform = supervisingPlatform(process.platform, process.env)
  const os = platform === 'systemd' && osDaemonUnit(process.platform, process.env)
  return {
    // The data folder: on Windows the task's definition and a stop are written there (harnessd/platform.ts).
    service: platform ? new PlatformService(platform, defaultPlatformDeps({ dataDir: env.ADAPTER_DATA_DIR }), os) : null,
    logFile: DAEMON_LOG_FILE,
    readPid,
    isAlive,
    masterPlatform: (pid) => readStatusFile(HARNESSD_STATUS_FILE, pid)?.platform ?? null,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...overrides,
  }
}

/** What the platform runs for this install: the managed Node (as the desktop app runs the CLI) and the
 *  installed bundle, the daemon's log, and the settings to carry from `source`. On Windows, the launcher
 *  the scheduled task runs too. */
export function serviceDefinition(options: {
  logFile: string; source?: NodeJS.ProcessEnv; nodePath?: string; scriptPath?: string; home?: string
  platform?: NodeJS.Platform; launcherPath?: string
}): ServiceDefinition {
  const source = options.source ?? process.env
  const carried: Record<string, string> = {}
  for (const name of CARRIED_ENV) {
    const value = source[name]
    if (value) carried[name] = value
  }
  // Windows: the build `cli\current` names (there is no cli\cli.js), started by the launcher in bin\. Without the
  // launcher the task could not be written at all (B3.12's review: `harness service install` threw).
  const windows = (options.platform ?? process.platform) === 'win32'
  const root = dirname(env.ADAPTER_CLI_DIR)
  return {
    nodePath: options.nodePath ?? managedNodePath(),
    scriptPath: options.scriptPath ?? (windows ? currentCli(root)?.cliJs : undefined) ?? join(env.ADAPTER_CLI_DIR, 'cli.js'),
    logFile: options.logFile,
    home: options.home ?? homedir(),
    env: carried,
    ...(windows ? { launcherPath: options.launcherPath ?? harnessLaunchPath(root) } : {}),
  }
}

/** The platform that runs harnessd here: its definition is on disk, written for this data folder. */
export function installedPlatform(deps: PlatformDaemonDeps = platformDaemonDeps()): PlatformName | null {
  return deps.service?.ownedBy(deps.logFile) ? deps.service.platform : null
}

/** What the platform did with a stop: `stopped` is the master it was running, for the caller to wait
 *  on, or null when it ran none. */
export type PlatformStop = { ok: true; stopped: number | null } | { ok: false; detail: string }

/**
 * Ask the platform to stop the master when it runs it: the definition is installed for this data
 * folder, or the running master says the platform started it (a definition removed by hand leaves the
 * job loaded). Null when no platform runs it, and nothing was asked.
 */
export function stopUnderPlatform(deps: PlatformDaemonDeps = platformDaemonDeps()): PlatformStop | null {
  const service = deps.service
  if (!service) return null
  const pid = deps.readPid()
  const runsIt = pid !== null && deps.isAlive(pid) && deps.masterPlatform(pid) === service.platform
  if (!runsIt && !service.ownedBy(deps.logFile)) return null
  // Its own pid for its master: a daemon `harness start` spawned beside it is not the platform's to stop.
  const master = service.inspect().pid
  const outcome = service.stop()
  return outcome.ok ? { ok: true, stopped: master } : outcome
}

export type StartOutcome = { ok: true; pid: number; refreshed: boolean } | { ok: false; detail: string }

/**
 * Start the master through the platform and wait for it to come up. The definition is rewritten first
 * when this install's would differ, a Node runtime that moved or a bundle elsewhere, so that a stale one
 * cannot go on failing at every login. Called under the spawn lock, with no daemon running.
 */
export async function startUnderPlatform(definition: ServiceDefinition, deps: PlatformDaemonDeps = platformDaemonDeps(), waitMs = PLATFORM_START_WAIT_MS): Promise<StartOutcome> {
  const service = deps.service
  if (!service) return { ok: false, detail: 'this computer has no launchd, systemd or Task Scheduler to run harnessd' }
  const refreshed = service.write(definition)
  const started = service.start(refreshed)
  if (!started.ok) return started
  const pid = await waitForMaster(deps, waitMs)
  if (pid !== null) return { ok: true, pid, refreshed }
  return { ok: false, detail: `${service.platform} did not bring harnessd up within ${Math.round(waitMs / 1000)}s (${describeState(service.inspect())})` }
}

/** How long `harness start` gives the scheduled task to start the master, or begin to, before it starts it itself. */
export const TASK_RUN_WAIT_MS = 10_000

export type TaskStart = { ok: true; pid: number } | { ok: false; direct: boolean; detail: string }

/**
 * Windows, the task registered: `harness start` runs it (`schtasks /Run`), so the master starts as the task starts it,
 * and waits. Not under the spawn lock: the task's `harness start --if-down` takes it, and would find it held and do
 * nothing. `direct`: the task did not start anything (Task Scheduler runs an InteractiveToken task only in a signed-in
 * Windows session, not in an SSH one), or it could not even be written, and the caller starts the master itself, as
 * without the task.
 */
export async function startThroughTask(
  definition: ServiceDefinition, deps: PlatformDaemonDeps & { lockHeld(): boolean }, waitMs = PLATFORM_START_WAIT_MS,
): Promise<TaskStart> {
  const service = deps.service!
  let refreshed: boolean
  try {
    refreshed = service.write(definition)
  } catch (error) {
    // The task's XML could not be made (whoami could not say who this is, a path it cannot hold): nothing was run.
    return { ok: false, direct: true, detail: (error as Error).message }
  }
  const ran = service.start(refreshed)
  if (!ran.ok) return { ok: false, direct: true, detail: ran.detail }
  const quick = await waitForMaster(deps, TASK_RUN_WAIT_MS)
  if (quick !== null) return { ok: true, pid: quick }
  if (!deps.lockHeld()) return { ok: false, direct: true, detail: 'Task Scheduler did not start harnessd (it runs the task only in a session at the Windows desktop, not over SSH)' }
  const pid = await waitForMaster(deps, waitMs)
  return pid !== null ? { ok: true, pid } : { ok: false, direct: false, detail: `harnessd did not come up within ${Math.round((TASK_RUN_WAIT_MS + waitMs) / 1000)}s` }
}

/**
 * Windows, the installed copy: `harness start` starts the master through harness-launch.exe (./windows/launcher.ts),
 * outside this terminal's job, so closing it or an SSH session does not end it. With none of `HARNESSD_*`
 * (../harnessd/AGENTS.md rule 11): a shell in an agent's pane may have them, and only a master handing over gives its
 * replacement one (../harnessd/reexec.ts). The rest of this shell's environment is the master's.
 */
export function launchMaster(
  cliDir: string = env.ADAPTER_CLI_DIR, given: NodeJS.ProcessEnv = process.env, launch: typeof launchDetached = launchDetached,
): Promise<LaunchOutcome> {
  const root = dirname(cliDir)
  return launch(harnessLaunchPath(root), root, ['__harnessd'], withoutHarnessdEnv(given))
}

export { AT_LOGON_FLAG } from '../harnessd/platform.js'

/** Whether `harness stop` stopped the daemon since this computer started, which the task's starts honour. */
export function taskStoppedThisBoot(dataDir: string = env.ADAPTER_DATA_DIR): boolean {
  let text: string | null = null
  try { text = readFileSync(join(dataDir, TASK_STOPPED_FILE), 'utf8') } catch { /* none */ }
  return stoppedThisBoot(text, bootTimeMs())
}

/** Any start but the task's own forgets a stop. */
export function clearTaskStopped(dataDir: string = env.ADAPTER_DATA_DIR): void {
  // A start never fails over this: a file held open for a moment (an antivirus scan) is forgotten at the next start.
  try { rmSync(join(dataDir, TASK_STOPPED_FILE), { force: true }) } catch { /* nothing to forget */ }
}

/** The master's pid once it has claimed the pid file, which it does when its core has bound; null if
 *  none has by the deadline. */
export async function waitForMaster(deps: Pick<PlatformDaemonDeps, 'readPid' | 'isAlive' | 'now' | 'sleep'>, timeoutMs: number): Promise<number | null> {
  const deadline = deps.now() + timeoutMs
  for (;;) {
    const pid = deps.readPid()
    if (pid !== null && deps.isAlive(pid)) return pid
    if (deps.now() >= deadline) return null
    await deps.sleep(250)
  }
}

/** Whether `pid` is gone by the deadline. */
export async function waitGone(deps: Pick<PlatformDaemonDeps, 'isAlive' | 'now' | 'sleep'>, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = deps.now() + timeoutMs
  while (deps.isAlive(pid)) {
    if (deps.now() >= deadline) return false
    await deps.sleep(150)
  }
  return true
}

/** One line on what the platform says: for `harness service status`, and a start that failed. */
export function describeState(state: PlatformState): string {
  if (state.unreachable) return `could not ask ${state.platform}: ${state.unreachable}`
  const parts: string[] = []
  if (!state.registered) parts.push(state.platform === 'launchd' ? 'not loaded' : state.platform === 'taskscheduler' ? 'not registered' : 'not enabled')
  if (state.state) parts.push(state.state)
  if (state.pid !== null) parts.push(`pid ${state.pid}`)
  else if (state.lastExit) parts.push(`last exit ${state.lastExit}`)
  return parts.join(' · ') || 'registered'
}
