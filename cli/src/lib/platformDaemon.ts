/**
 * Where the rest of the CLI meets launchd or systemd, once someone has opted in with
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
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { readStatusFile } from '../harnessd/master.js'
import { PlatformService, defaultPlatformDeps, platformFor, type PlatformName, type PlatformState, type ServiceDefinition } from '../harnessd/platform.js'
import { DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, isAlive, readPid } from './daemonState.js'
import { managedNodePath } from './nodeRuntime.js'

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

/** This computer's: its platform, its pid file, the status file its master writes. */
export function platformDaemonDeps(overrides: Partial<PlatformDaemonDeps> = {}): PlatformDaemonDeps {
  const platform = supervisingPlatform(process.platform, process.env)
  return {
    service: platform ? new PlatformService(platform, defaultPlatformDeps()) : null,
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
 *  installed bundle, the daemon's log, and the settings to carry from `source`. */
export function serviceDefinition(options: { logFile: string; source?: NodeJS.ProcessEnv; nodePath?: string; scriptPath?: string; home?: string }): ServiceDefinition {
  const source = options.source ?? process.env
  const carried: Record<string, string> = {}
  for (const name of CARRIED_ENV) {
    const value = source[name]
    if (value) carried[name] = value
  }
  return {
    nodePath: options.nodePath ?? managedNodePath(),
    scriptPath: options.scriptPath ?? join(env.ADAPTER_CLI_DIR, 'cli.js'),
    logFile: options.logFile,
    home: options.home ?? homedir(),
    env: carried,
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
  if (!service) return { ok: false, detail: 'neither launchd nor systemd runs harnessd on this computer' }
  const refreshed = service.write(definition)
  const started = service.start(refreshed)
  if (!started.ok) return started
  const pid = await waitForMaster(deps, waitMs)
  if (pid !== null) return { ok: true, pid, refreshed }
  return { ok: false, detail: `${service.platform} did not bring harnessd up within ${Math.round(waitMs / 1000)}s (${describeState(service.inspect())})` }
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
  if (!state.registered) parts.push(state.platform === 'launchd' ? 'not loaded' : 'not enabled')
  if (state.state) parts.push(state.state)
  if (state.pid !== null) parts.push(`pid ${state.pid}`)
  else if (state.lastExit) parts.push(`last exit ${state.lastExit}`)
  return parts.join(' · ') || 'registered'
}
