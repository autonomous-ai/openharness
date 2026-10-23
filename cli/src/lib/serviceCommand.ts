/**
 * `harness service install | uninstall | status`: harnessd under launchd (macOS), systemd (Linux) or Task
 * Scheduler (Windows, which starts the master rather than running it: `installTask`).
 *
 * The platform runs the master in the foreground from login on, and starts it again if it dies: before,
 * nothing restarted a master that died but the desktop app running `harness start` again, and on a
 * computer without the app nothing did. Agents keep running in tmux whenever the daemon stops, as now.
 *
 * Opt-in. Without it nothing changes, and the desktop app does not use it yet. Once installed,
 * `harness start` and `harness stop` act through the platform (./platformDaemon.ts), so there is one
 * supervisor per machine. The definitions themselves are ../harnessd/platform.ts.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLATFORM_LABEL, type PlatformState, type ServiceDefinition } from '../harnessd/platform.js'
import { describeSpawnLockOwner, readSpawnLockOwner, withSpawnLock, type SpawnLockPurpose } from './daemonSpawnLock.js'
import { stopDaemonProcess } from './daemonStop.js'
import {
  CARRIED_ENV, PLATFORM_START_WAIT_MS, PLATFORM_STOP_WAIT_MS, TASK_RUN_WAIT_MS, describeState, platformDaemonDeps, serviceDefinition, waitForMaster, waitGone,
  type PlatformDaemonDeps,
} from './platformDaemon.js'

export interface ServiceCommandDeps extends PlatformDaemonDeps {
  /** What the platform would run for this install. */
  definition(): ServiceDefinition
  /** The installed bundle the definition runs is there. */
  bundleExists(path: string): boolean
  /** Make the log's folder: launchd and systemd open the log, but do not make its folder. */
  ensureDir(path: string): void
  /** `harness stop`'s stop. Re-entrant under the spawn lock this command holds. */
  stopDaemon(): Promise<{ pid: number | null; stopped: boolean }>
  /** Run `fn` holding the daemon spawn lock, so no `harness start` lands in the middle. */
  withLock<T>(purpose: SpawnLockPurpose, fn: () => Promise<T>): Promise<T>
  /** `harness start` the usual way, after an uninstall: it prints the daemon's status and exits. */
  relaunch(): Promise<void>
  out(line: string): void
  err(line: string): void
  tildify(path: string): string
  /** How long to wait for the master to come up. */
  startWaitMs?: number
  /** Windows: [name] as set for the Windows user (`HKCU\Environment`, what `setx` writes), null when it is not or
   *  could not be read (`readUserEnvironment`). */
  userEnvironment?(name: string): Promise<string | null>
  /** Windows: someone holds the daemon spawn lock, as the task's own `harness start --if-down` does once it runs. */
  lockHeld?(): boolean
}

/**
 * `harness service install`'s exit code on Windows when the task is registered and will start harnessd at the next
 * sign-in, but did not start it now (Task Scheduler runs the task only in a signed-in Windows session). install.ps1 told
 * that apart from a failure only by this: with exit 1 it said "Harness could not set itself to start when you sign in"
 * of a task it had just registered (the Windows install job, B5.12). 5: harness.exe already exits 3 for a broken install
 * and 4 for a Node that does not start (pty/src/command.rs), and the CLI exits 1 and 2 (usage).
 */
export const SERVICE_REGISTERED_NOT_RUNNING = 5

/** As long as `reg query` is given: it reads one value. */
export const USER_ENVIRONMENT_TIMEOUT_MS = 3_000

/** `execFile`'s shape, as far as `readUserEnvironment` uses it. */
export type RegRun = (
  file: string, args: string[], options: { timeout: number; windowsHide: boolean }, done: (error: Error | null, stdout: string) => void,
) => unknown

/**
 * [name] from the Windows user's environment (`reg query HKCU\Environment /v <name>`, 3 s): a text value as it is
 * written, or null when there is none, it is not text, or reg failed, timed out or could not run. Never rejects.
 */
export function readUserEnvironment(name: string, run: RegRun = execFile as unknown as RegRun): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      run('reg', ['query', 'HKCU\\Environment', '/v', name], { timeout: USER_ENVIRONMENT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) { resolve(null); return }
        // `    PORT    REG_SZ    18621`: names are case-insensitive on Windows.
        for (const line of String(stdout).split(/\r?\n/)) {
          const match = /^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/.exec(line)
          if (match && match[1]!.toLowerCase() === name.toLowerCase()) { resolve(match[2]!); return }
        }
        resolve(null)
      })
    } catch {
      resolve(null)
    }
  })
}

export const SERVICE_USAGE = [
  'Usage: harness service <install | uninstall | status> [--json]',
  '',
  '  install    run harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows): it starts at login',
  '             and comes back if it dies. `harness start` and `harness stop` then go through the platform. Agents keep',
  '             running in tmux whenever the daemon stops, as they do now',
  '  uninstall  stop that, and start the daemon the usual way again',
  '  status     what launchd, systemd or Task Scheduler has registered, and whether it runs (--json for machines)',
  '',
  'Opt-in: without it, `harness start` (or the desktop app) runs the daemon, as it always has.',
].join('\n')

/** Windows: Task Scheduler starts the daemon, it does not run it, and there is no tmux (harnessd/platform.ts). */
export const WINDOWS_SERVICE_USAGE = [
  'Usage: harness service <install | uninstall | status> [--json]',
  '',
  '  install    have Task Scheduler start the Harness daemon when you sign in to Windows,',
  '             and again within 5 minutes if it stops. `harness start` and `harness stop` then go through it',
  '  uninstall  remove that task: the daemon keeps running, and `harness start` starts it after this',
  '  status     what Task Scheduler has registered, and whether it is turned on (--json for machines)',
  '',
  'Opt-in: without it, `harness start` (or the desktop app) runs the daemon, as it always has.',
].join('\n')

export async function serviceCommand(argv: string[], deps: ServiceCommandDeps): Promise<number> {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const json = argv.includes('--json')
  const verb = words[0]
  const usage = deps.service?.platform === 'taskscheduler' ? WINDOWS_SERVICE_USAGE : SERVICE_USAGE
  if (verb === undefined || verb === 'help' || argv.includes('-h') || argv.includes('--help')) {
    deps.out(usage)
    return 0
  }
  if (!['install', 'uninstall', 'status'].includes(verb)) {
    deps.err(`Unknown command: harness service ${verb}\n\n${usage}`)
    return 2
  }
  if (!deps.service) {
    if (json && verb === 'status') deps.out(JSON.stringify({ supported: false }))
    else deps.err('harness service runs harnessd under launchd (macOS), systemd (Linux) or Task Scheduler (Windows); this computer has none of them.')
    return verb === 'status' ? 0 : 1
  }
  if (deps.service.os && verb !== 'status') {
    deps.err(`Harness OS runs harnessd under ${deps.service.target} already: \`harness start\` and \`harness stop\` go through it, and there is nothing to ${verb}.`)
    return 1
  }
  if (verb === 'install') return installService(deps)
  if (verb === 'uninstall') return uninstallService(deps)
  return serviceStatus(deps, json)
}

async function installService(deps: ServiceCommandDeps): Promise<number> {
  if (deps.service!.platform === 'taskscheduler') return installTask(deps)
  const service = deps.service!
  const name = PLATFORM_LABEL[service.platform]
  const definition = deps.definition()
  if (!deps.bundleExists(definition.scriptPath)) {
    deps.err(`✗ No installed CLI at ${deps.tildify(definition.scriptPath)}. ${name} runs the installed bundle: install it first, then run this again.`)
    return 1
  }
  // Asked before anything is written or stopped: a computer the platform cannot serve keeps its daemon.
  const preflight = service.preflight()
  if (!preflight.ok) {
    deps.err(`✗ ${name} cannot run harnessd here: ${preflight.detail}`)
    return 1
  }
  // Under the spawn lock from here: once the definition is on disk a `harness start` (the desktop app
  // runs one whenever the daemon looks down) goes through the platform too, and must not land between
  // the stop and the registration.
  return deps.withLock('start', async () => {
    const pid = deps.readPid()
    const running = pid !== null && deps.isAlive(pid)
    const before = service.inspect()
    const rewritten = service.write(definition)
    if (!rewritten && before.registered && running && before.pid === pid) {
      deps.out(`harnessd already runs under ${name} (pid ${pid}); nothing to change.`)
      return 0
    }
    deps.ensureDir(dirname(definition.logFile))
    // One supervisor: whatever runs now, a master `harness start` spawned or the platform's own on an
    // older definition, stops first. The agents keep running in tmux.
    if (running || before.registered) await deps.stopDaemon()
    const registered = service.register()
    if (!registered.ok) {
      service.discard()
      deps.err(`✗ ${name} would not take harnessd: ${registered.detail}`)
      if (running) deps.err('  The daemon was stopped to hand it over; `harness start` starts it again, as before.')
      return 1
    }
    const up = await waitForMaster(deps, deps.startWaitMs ?? PLATFORM_START_WAIT_MS)
    if (up === null) {
      deps.err(`✗ ${name} has harnessd, but it did not come up (${describeState(service.inspect())}).`)
      deps.err(`  logs ${deps.tildify(deps.logFile)}   ·   harness service status`)
      return 1
    }
    deps.out(`✓ harnessd runs under ${name} (pid ${up}): it starts at login and comes back if it dies.`)
    deps.out(`  ${service.platform === 'launchd' ? 'agent' : service.platform === 'taskscheduler' ? 'task ' : 'unit '}  ${deps.tildify(service.file)}`)
    deps.out('  `harness start` and `harness stop` now go through it; agents keep running in tmux when the daemon stops.')
    deps.out('  undo: harness service uninstall')
    lingerNote(service.inspect(), deps)
    return 0
  })
}

async function uninstallService(deps: ServiceCommandDeps): Promise<number> {
  const service = deps.service!
  const name = PLATFORM_LABEL[service.platform]
  const task = service.platform === 'taskscheduler'
  const before = service.inspect()
  // Task Scheduler that could not be asked has not said there is no task: unregister says so (harnessd/platform.ts).
  // `registered` means both tasks there, so one task left on its own, its files gone, is found by its log (re-review N9).
  if (!before.installed && !before.registered && !(task && (before.unreachable || service.registeredFor(deps.logFile)))) {
    deps.out(`harnessd is not installed with ${name}; nothing to remove.`)
    return 0
  }
  const pid = deps.readPid()
  // The platform's own master is the daemon: once it goes, the daemon is started the usual way.
  const platformRan = pid !== null && deps.isAlive(pid) && before.pid === pid
  const removed = await deps.withLock('stop', async () => {
    const outcome = service.unregister()
    if (outcome.ok && platformRan && !await waitGone(deps, pid, PLATFORM_STOP_WAIT_MS)) await deps.stopDaemon()
    return outcome
  })
  if (!removed.ok) {
    if (task) {
      // What schtasks said is for whoever looks into it, under a sentence anyone reads.
      deps.err('✗ Harness could not remove the task that starts harnessd: Task Scheduler may still start it when you sign in.')
      deps.err(`  ${removed.detail}`)
    } else deps.err(`✗ ${removed.detail}`)
    return 1
  }
  deps.out(`✓ removed ${deps.tildify(service.file)}: ${name} no longer runs harnessd.`)
  if (!platformRan) return 0
  deps.out('  starting it the usual way…')
  await deps.relaunch()
  return 0
}

function serviceStatus(deps: ServiceCommandDeps, json: boolean): number {
  const service = deps.service!
  const name = PLATFORM_LABEL[service.platform]
  const state = service.inspect()
  let current = false
  let uncompared: string | null = null
  try {
    current = state.installed && service.current(deps.definition())
  } catch (error) {
    // Windows renders the task with the user's SID, which whoami may not give: then it cannot be compared.
    uncompared = (error as Error).message
  }
  if (json) {
    deps.out(JSON.stringify({
      supported: true, platform: state.platform, file: state.file, target: state.target, installed: state.installed, current,
      registered: state.registered, running: state.pid !== null, pid: state.pid, state: state.state, lastExit: state.lastExit,
      failed: state.failed, linger: state.linger, unreachable: state.unreachable,
    }))
    return 0
  }
  deps.out(`harnessd · ${name}`)
  deps.out(`  status      ${statusLine(state, name)}`)
  if (state.installed || state.registered) {
    deps.out(`  ${service.platform === 'launchd' ? 'agent ' : service.platform === 'taskscheduler' ? 'task  ' : 'unit  '}      ${deps.tildify(state.file)}`)
    deps.out(`  target      ${state.target}`)
  }
  if (uncompared !== null) deps.out(`  ! Harness could not check the ${service.platform === 'taskscheduler' ? 'task' : 'definition'} against this install: ${uncompared}`)
  else if (state.installed && !current) deps.out('  ! the definition is not the one this install would write (another Node, bundle or setting): `harness service install` rewrites it')
  if (state.failed) deps.out(`  ! systemd gave up after repeated failures${state.lastExit ? ` (${state.lastExit})` : ''}: \`harness start\` tries again · logs ${deps.tildify(deps.logFile)}`)
  lingerNote(state, deps)
  return 0
}

function statusLine(state: PlatformState, name: string): string {
  if (state.unreachable) return `? could not ask ${name}: ${state.unreachable}`
  if (!state.installed && !state.registered) return `○ not installed · \`harness start\` runs the daemon; \`harness service install\` hands it to ${name}`
  if (state.registered && !state.installed) return `◍ registered without its file · \`harness service uninstall\` clears it`
  if (state.platform === 'taskscheduler') {
    if (!state.registered) return '◍ written, not registered · `harness service install` registers it'
    return state.state === 'disabled'
      ? '◍ registered, but turned off in Task Scheduler · `harness service install` turns it back on'
      : `● registered (${state.state}) · starts the daemon when you sign in to Windows, and again within 5 minutes if it stops`
  }
  if (!state.registered) {
    return state.platform === 'launchd'
      ? '◍ installed, not loaded · it starts at your next login, or now with `harness start`'
      : '◍ installed, not enabled · `harness service install` enables it'
  }
  if (state.pid !== null) return `● running (pid ${state.pid}) · starts at login, comes back if it dies`
  return `◍ registered, not running (${describeState(state)}) · \`harness start\` starts it`
}

/**
 * Windows. Task Scheduler does not run the master, it starts it (harnessd/platform.ts), so nothing that runs is stopped:
 * the task is registered under the spawn lock, and run once outside it, when no daemon runs, because the task's own
 * `harness start --if-down` takes that lock and would find it held. Every failure is one sentence a person reads, and
 * what whoami or schtasks said goes on the line below it.
 */
async function installTask(deps: ServiceCommandDeps): Promise<number> {
  const service = deps.service!
  const definition = deps.definition()
  const launcher = definition.launcherPath ?? ''
  for (const needed of [launcher, definition.scriptPath]) {
    if (!deps.bundleExists(needed)) {
      deps.err(`✗ No installed CLI at ${deps.tildify(needed)}. Task Scheduler runs the installed CLI through bin\\harness-launch.exe: install it with install.ps1, then run this again.`)
      return 1
    }
  }
  const preflight = service.preflight()
  if (!preflight.ok) {
    deps.err('✗ Harness could not reach Task Scheduler, so it cannot start harnessd when you sign in to Windows.')
    deps.err(`  ${preflight.detail}`)
    return 1
  }
  const registered = await deps.withLock('start', async () => {
    const before = service.inspect()
    let written: boolean
    try {
      written = service.write(definition)
    } catch (error) {
      // The XML could not be made: whoami could not say who this is, or a path the task cannot hold. Nothing was written.
      return { ok: false as const, unwritten: true, detail: (error as Error).message }
    }
    // A task someone turned off in Task Scheduler is not installed and fine: registered again from the same file,
    // whose <Enabled>true</Enabled> turns it back on (`/Create /F`).
    if (!written && before.registered && before.state !== 'disabled') return 'already' as const
    const outcome = service.register()
    if (!outcome.ok) service.discard()
    // Gone now though it was there: the five-minute task replaced (/F), then removed again with its refused logon task.
    // `registered` means both tasks, so a five-minute task whose logon task was deleted by hand counts by its files (N8).
    return { ...outcome, unwritten: false, lost: !outcome.ok && (before.registered || before.installed) && !service.inspect().registered }
  })
  if (registered !== 'already' && !registered.ok) {
    deps.err(registered.unwritten
      ? '✗ Harness could not set up the task that starts harnessd when you sign in to Windows; nothing was changed.'
      // A refused logon task removes the five-minute task just made (harnessd/platform.ts register), which with /F had
      // replaced the one there before.
      : 'lost' in registered && registered.lost
        ? '✗ Task Scheduler did not accept the new task that starts harnessd, and no longer has the old one: `harness start` still starts harnessd, and `harness service install` tries again.'
        : '✗ Task Scheduler did not accept the task that starts harnessd; nothing was changed.')
    deps.err(`  ${registered.detail}`)
    return 1
  }
  const running = deps.readPid()
  let up = running !== null && deps.isAlive(running) ? running : null
  if (up === null) {
    const started = service.start(false)
    if (!started.ok) {
      deps.err('✗ Task Scheduler has the task that starts harnessd, but would not run it now: `harness start` starts harnessd.')
      deps.err(`  ${started.detail}`)
      return SERVICE_REGISTERED_NOT_RUNNING
    }
    // As `harness start` waits on the task (platformDaemon.ts startThroughTask): a short while, and longer only once the
    // task's own start holds the spawn lock. Over SSH Task Scheduler runs nothing, and this waited the whole minute,
    // then printed a ✗ for what is not a failure (G4, final review R1b-3).
    const wait = deps.startWaitMs ?? PLATFORM_START_WAIT_MS
    up = await waitForMaster(deps, Math.min(TASK_RUN_WAIT_MS, wait))
    if (up === null && !deps.lockHeld?.()) {
      deps.out('Task Scheduler will start Harness when you sign in to Windows. It did not start it now: it runs the task only in a session at the Windows desktop, not over SSH.')
      deps.out('  start it now: harness start')
      return SERVICE_REGISTERED_NOT_RUNNING
    }
    if (up === null) up = await waitForMaster(deps, wait)
    if (up === null) {
      deps.err('✗ Task Scheduler started harnessd, but it did not come up: `harness start` starts it now.')
      deps.err(`  logs ${deps.tildify(deps.logFile)}   ·   harness service status`)
      return SERVICE_REGISTERED_NOT_RUNNING
    }
  }
  if (registered === 'already') deps.out(`harnessd is registered with Task Scheduler already (${service.target}); nothing to change.`)
  else {
    deps.out(`✓ Task Scheduler starts the Harness daemon when you sign in to Windows, and again within 5 minutes if it stops (pid ${up} runs now).`)
    deps.out(`  task   ${service.target}`)
    deps.out('  undo: harness service uninstall')
  }
  // A task's action has no environment of its own (harnessd/platform.ts): it runs with the user's logon environment,
  // and the task is the user's one, whatever data folder this shell names. Reported rather than refused: a value set
  // for the Windows user as well reaches it. PORT is read back from the user's environment: one set with `setx`
  // reaches the task, and was warned of all the same (task-B3.21 finding F4). A read that fails warns, as before.
  let carried = Object.keys(definition.env).filter((name) => (CARRIED_ENV as readonly string[]).includes(name))
  if (carried.includes('PORT') && deps.userEnvironment && await deps.userEnvironment('PORT') === definition.env.PORT) {
    carried = carried.filter((name) => name !== 'PORT')
  }
  if (carried.length) {
    deps.out(`  ! the task starts harness with your Windows user environment, not this shell's: ${carried.join(', ')} set only here ${carried.length > 1 ? 'do' : 'does'} not reach it`)
    deps.out('    so the daemon it starts uses your user settings. Set these for your Windows user, or run this from a shell without them.')
  }
  return 0
}

/** systemd without lingering ends the user's manager at their last logout, and everything under it. */
function lingerNote(state: PlatformState, deps: Pick<ServiceCommandDeps, 'out'>): void {
  if (state.linger !== false) return
  deps.out('  ! lingering is off: logging out of your last session ends your user manager, and with it the daemon')
  deps.out('    and a tmux server it started. `loginctl enable-linger` keeps them running.')
}

/** This computer's, for cli.ts: `relaunch` and `tildify` are the CLI's own. */
export function serviceCommandDeps(options: { relaunch: () => Promise<void>; tildify: (path: string) => string }): ServiceCommandDeps {
  const base = platformDaemonDeps()
  return {
    ...base,
    definition: () => serviceDefinition({ logFile: base.logFile }),
    bundleExists: (path) => existsSync(path),
    ensureDir: (path) => { mkdirSync(path, { recursive: true, mode: 0o700 }) },
    stopDaemon: () => stopDaemonProcess(),
    withLock: (purpose, fn) => withSpawnLock(purpose, fn, {
      onWaiting: (owner) => console.log(`  the daemon is ${describeSpawnLockOwner(owner)} — waiting for it to finish…`),
    }),
    relaunch: options.relaunch,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    tildify: options.tildify,
    userEnvironment: (name) => readUserEnvironment(name),
    lockHeld: () => readSpawnLockOwner() !== null,
  }
}
