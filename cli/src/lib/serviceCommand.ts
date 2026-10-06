/**
 * `harness service install | uninstall | status`: harnessd under launchd (macOS) or systemd (Linux).
 *
 * The platform runs the master in the foreground from login on, and starts it again if it dies: before,
 * nothing restarted a master that died but the desktop app running `harness start` again, and on a
 * computer without the app nothing did. Agents keep running in tmux whenever the daemon stops, as now.
 *
 * Opt-in. Without it nothing changes, and the desktop app does not use it yet. Once installed,
 * `harness start` and `harness stop` act through the platform (./platformDaemon.ts), so there is one
 * supervisor per machine. The definitions themselves are ../harnessd/platform.ts.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PlatformState, ServiceDefinition } from '../harnessd/platform.js'
import { describeSpawnLockOwner, withSpawnLock, type SpawnLockPurpose } from './daemonSpawnLock.js'
import { stopDaemonProcess } from './daemonStop.js'
import {
  PLATFORM_START_WAIT_MS, PLATFORM_STOP_WAIT_MS, describeState, platformDaemonDeps, serviceDefinition, waitForMaster, waitGone,
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
}

export const SERVICE_USAGE = [
  'Usage: harness service <install | uninstall | status> [--json]',
  '',
  '  install    run harnessd under launchd (macOS) or systemd (Linux): it starts at login and comes back',
  '             if it dies. `harness start` and `harness stop` then go through the platform. Agents keep',
  '             running in tmux whenever the daemon stops, as they do now',
  '  uninstall  stop that, and start the daemon the usual way again',
  '  status     what launchd or systemd has registered, and whether it runs (--json for machines)',
  '',
  'Opt-in: without it, `harness start` (or the desktop app) runs the daemon, as it always has.',
].join('\n')

export async function serviceCommand(argv: string[], deps: ServiceCommandDeps): Promise<number> {
  const words = argv.filter((arg) => !arg.startsWith('-'))
  const json = argv.includes('--json')
  const verb = words[0]
  if (verb === undefined || verb === 'help' || argv.includes('-h') || argv.includes('--help')) {
    deps.out(SERVICE_USAGE)
    return 0
  }
  if (!['install', 'uninstall', 'status'].includes(verb)) {
    deps.err(`Unknown command: harness service ${verb}\n\n${SERVICE_USAGE}`)
    return 2
  }
  if (!deps.service) {
    if (json && verb === 'status') deps.out(JSON.stringify({ supported: false }))
    else deps.err('harness service runs harnessd under launchd (macOS) or systemd (Linux); this computer has neither.')
    return verb === 'status' ? 0 : 1
  }
  if (verb === 'install') return installService(deps)
  if (verb === 'uninstall') return uninstallService(deps)
  return serviceStatus(deps, json)
}

async function installService(deps: ServiceCommandDeps): Promise<number> {
  const service = deps.service!
  const name = service.platform
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
    deps.out(`  ${service.platform === 'launchd' ? 'agent' : 'unit '}  ${deps.tildify(service.file)}`)
    deps.out('  `harness start` and `harness stop` now go through it; agents keep running in tmux when the daemon stops.')
    deps.out('  undo: harness service uninstall')
    lingerNote(service.inspect(), deps)
    return 0
  })
}

async function uninstallService(deps: ServiceCommandDeps): Promise<number> {
  const service = deps.service!
  const name = service.platform
  const before = service.inspect()
  if (!before.installed && !before.registered) {
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
    deps.err(`✗ ${removed.detail}`)
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
  const name = service.platform
  const state = service.inspect()
  const current = state.installed && service.current(deps.definition())
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
    deps.out(`  ${service.platform === 'launchd' ? 'agent ' : 'unit  '}      ${deps.tildify(state.file)}`)
    deps.out(`  target      ${state.target}`)
  }
  if (state.installed && !current) deps.out('  ! the definition is not the one this install would write (another Node, bundle or setting): `harness service install` rewrites it')
  if (state.failed) deps.out(`  ! systemd gave up after repeated failures${state.lastExit ? ` (${state.lastExit})` : ''}: \`harness start\` tries again · logs ${deps.tildify(deps.logFile)}`)
  lingerNote(state, deps)
  return 0
}

function statusLine(state: PlatformState, name: string): string {
  if (state.unreachable) return `? could not ask ${name}: ${state.unreachable}`
  if (!state.installed && !state.registered) return `○ not installed · \`harness start\` runs the daemon; \`harness service install\` hands it to ${name}`
  if (state.registered && !state.installed) return `◍ registered without its file · \`harness service uninstall\` clears it`
  if (!state.registered) {
    return state.platform === 'launchd'
      ? '◍ installed, not loaded · it starts at your next login, or now with `harness start`'
      : '◍ installed, not enabled · `harness service install` enables it'
  }
  if (state.pid !== null) return `● running (pid ${state.pid}) · starts at login, comes back if it dies`
  return `◍ registered, not running (${describeState(state)}) · \`harness start\` starts it`
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
  }
}
