/**
 * harnessd's master as a process: what `harness start` runs (`__harnessd`), and the probe a master about
 * to re-execute on a new bundle asks first (`__harnessd-probe`, harnessd/reexec.ts).
 *
 * The master holds no feature code (harnessd/AGENTS.md), yet weighed what the whole CLI weighs: every
 * process evaluated the whole bundle, and Node parses all of the file a process is started on whatever
 * it runs. Measured from the bundle at idle (2026-10-05): the master 160 MiB resident, each service 115
 * to 160. So a master started on cli.js re-executes itself, same pid, on the lean bundle cli.js carries
 * (harnessd/leanBundle.ts), and starts the services and the core from it too: each then parses its own
 * code and not the whole CLI's 4.4 MB.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, readFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import { env } from './config/env.js'
import { processExecve, probeMaster, runMaster, type Execve, type MasterConfig } from './harnessd/master.js'
import { baseNode, namedNode } from './harnessd/processName.js'
import { PROBE_ANSWER, PROBE_TIMEOUT_MS } from './harnessd/reexec.js'
import { dropAgentSessionEnv } from './lib/agentSessionEnv.js'
import { ensureUtf8Locale } from './lib/childLocale.js'
import { acquireSpawnLock, tryAcquireSpawnLockSync } from './lib/daemonSpawnLock.js'
import { DAEMON_LOG_FILE, HARNESSD_STATUS_FILE, PID_FILE } from './lib/daemonState.js'
import { isInstalledCopy } from './lib/installedCopy.js'
import { unixSocketPath } from './lib/localSocket.js'
import { currentCli, harnessLaunchPath } from './lib/windows/installLayout.js'
import { launchDetached } from './lib/windows/launcher.js'
import { leanFingerprint, readLeanBundle, releaseLeanClaim, writeLeanBundle, type LeanBundle } from './harnessd/leanBundle.js'
import { ts } from './lib/log.js'
import { confirm as confirmUpdate, pendingVersion, restore as restoreUpdate, unjudgedUpdate } from './lib/selfUpdate.js'
import { keepStaged, ptyUnjudged, rollBackStaged } from './lib/windows/ptyUpdate.js'
import { VERSION } from './version.js'
import { isTeamAccount } from './team/config.js'

/** Where a master re-executing on a new bundle leaves word of it, until that master's core is up. */
export const HARNESSD_REEXEC_FILE = join(env.ADAPTER_DATA_DIR, 'harnessd-reexec.json')
/** Where the lean bundle is written out for the master and the services to start from. */
export const LEAN_DIR = join(env.ADAPTER_DATA_DIR, 'lean')
/** Handed by a master started on cli.js to itself re-executed on the lean bundle: the bundle it read the
 *  lean bundle from, and that bundle's sha256. */
export const BUNDLE_ENV = 'HARNESSD_BUNDLE'
export const BUNDLE_SHA256_ENV = 'HARNESSD_BUNDLE_SHA256'
/** And what the lean bundle's folder fingerprints to: checked before every service is started from it. */
export const LEAN_FINGERPRINT_ENV = 'HARNESSD_LEAN_FINGERPRINT'
/** While this file is in the data folder, masters start on cli.js alone, as with `HARNESSD_LEAN=off`: the
 *  way to turn the lean bundle off for a master launchd or systemd starts, whose environment is the
 *  unit's (`touch ~/.harness/cli/data/lean-off`, then `harness restart`). */
export const LEAN_OFF_FILE = join(env.ADAPTER_DATA_DIR, 'lean-off')

export interface MasterStart {
  /** What the core runs and an update replaces: cli.js, or src/cli.ts from the sources. */
  scriptPath: string
  /** What the services run, when not `scriptPath`: the lean bundle. */
  serviceScriptPath?: string
  /** The sha256 of the bundle the lean bundle was read from, for a master running on the lean bundle. */
  bundleFingerprint?: string
  /** What the lean bundle's folder fingerprints to (harnessd/leanBundle.ts `leanFingerprint`). */
  leanFingerprint?: string
}

/**
 * The master's environment, with the services kept in the core's process when the core will have no local
 * socket for them to reach it by: its path in this data folder is too long for one (lib/localSocket.ts, 96
 * bytes) or the platform has none. Every service process reaches the core only through that socket, and one
 * started without it exits at once, again and again until the master parks it: on such a machine search, the
 * viewers, the gateway and every other service answered SERVICE_UNAVAILABLE for good (e2e/noSocket.e2e.ts).
 *
 * Windows has none every time (no service processes there yet), and its log line says only that: the socket's
 * depth, which is the reason elsewhere, read as a fault at every Windows start (task-B3.21 finding F2).
 */
export function masterEnv(
  given: NodeJS.ProcessEnv, socketPath: string | null, log: (line: string) => void = (line) => console.log(line),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (socketPath !== null || given.HARNESSD_SERVICES === 'none') return given
  log(platform === 'win32'
    ? `${ts()} [harnessd] on Windows the services run in the core's process`
    : `${ts()} [harnessd] this data folder is too deep for the daemon's local socket — the services run in the core's process`)
  return { ...given, HARNESSD_SERVICES: 'none' }
}

export interface WindowsMasterDeps {
  cliDir: string
  currentCli(root: string): { cliJs: string } | null
  exists(path: string): boolean
  /** The daemon's log, opened to append. */
  openLog(): number
  /** This process's console, written to [fd] from now on. */
  redirect(fd: number): void
  /** The master runs in a terminal (`harness start -f`), which shows its output. */
  isTTY: boolean
  launch: typeof launchDetached
  lock(): Promise<(() => void) | null>
  /** The pid file: null when it names no pid, a throw when it cannot be read (`readHandoverPid`). */
  readPid(): number | null
  /** Whether a process runs; a throw when that is not known (`handoverAlive`). */
  alive(pid: number): boolean
  /** An error that ends this process, written to [fd] first (`writeFatalTo`). */
  fatal(fd: number): void
}

/** How long a master about to hand over waits for the spawn lock: a start or a stop under way finishes in seconds. */
export const HANDOVER_LOCK_WAIT_MS = 5_000
/**
 * How long a master handing over waits on harness-launch.exe, which resolves two pointers and starts a process. A stop
 * that comes during a handover waits for the launch to be decided, and `harness stop` waits 45 s on the spawn lock the
 * handover holds: launchDetached's own 30 s, with the rest of a handover after it, came too close to that.
 */
export const HANDOVER_LAUNCH_TIMEOUT_MS = 10_000

/**
 * The pid file, as a handover reads it (harnessd/master.ts `MasterHandOver`): null when there is none or it names no
 * pid, a throw when it is there and cannot be read. Not daemonState's `readPid`, which takes a failure for null: at a
 * handover's bound, null keeps this master, and a file it could not read is the new master writing it.
 */
export function readHandoverPid(pidFile: string = PID_FILE, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): number | null {
  let text: string
  try {
    text = read(pidFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  // A torn or half-written file reads as null, which is harmless: the replacement writes the pid file only before the
  // cutoff, and the old master reads it for its decision at cutoff + 20 s (harnessd/reexec.ts HANDOVER_CUTOFF_MARGIN_MS).
  const pid = Number.parseInt(text.trim(), 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/**
 * Whether process [pid] runs, as a handover asks it: ended only on ESRCH, alive on EPERM (another account's), a throw on
 * anything else, which a handover reads as not known and never as ended (harnessd/reexec.ts `HandOverDeps.alive`).
 */
export function handoverAlive(pid: number, kill: (pid: number, signal: 0) => void = (target, signal) => { process.kill(target, signal) }): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

/**
 * Under harness-launch.exe the master has no stderr: an error that ended it left no word of why. So, once it writes
 * the daemon's log itself, such an error is written there, at once (the process is about to end), and it exits 1, as
 * Node does on an uncaught error or an unhandled rejection.
 */
export function writeFatalTo(
  fd: number,
  on: (event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void) => void = (event, listener) => { process.on(event, listener) },
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  const fatal = (what: string) => (error: unknown): void => {
    try {
      writeSync(fd, `${ts()} [harnessd] the master stopped on ${what}: ${error instanceof Error ? error.stack ?? error.message : format(error)}\n`)
    } catch { /* the log cannot be written: the line is lost, never the exit */ }
    exit(1)
  }
  on('uncaughtException', fatal('an uncaught error'))
  on('unhandledRejection', fatal('an unhandled rejection'))
}

export const processWindowsMasterDeps = (): WindowsMasterDeps => ({
  cliDir: env.ADAPTER_CLI_DIR,
  currentCli: (root) => currentCli(root),
  exists: existsSync,
  openLog: () => openSync(DAEMON_LOG_FILE, 'a'),
  redirect: (fd) => {
    for (const name of ['log', 'info', 'warn', 'error'] as const) {
      console[name] = (...args: unknown[]) => { try { writeSync(fd, `${format(...args)}\n`) } catch { /* a full disk costs the line */ } }
    }
  },
  isTTY: !!process.stdout.isTTY,
  launch: launchDetached,
  lock: async () => { try { return await acquireSpawnLock('handoff', { waitMs: HANDOVER_LOCK_WAIT_MS }) } catch { return null } },
  readPid: () => readHandoverPid(),
  alive: (pid) => handoverAlive(pid),
  fatal: (fd) => writeFatalTo(fd),
})

/**
 * The master on Windows (spec section 3). It stops its children by message: there is no SIGTERM there. It writes the
 * daemon's log itself, and gives its children that log for their output: harness-launch.exe starts it with no output
 * at all. The installed copy starts its children, and hands over, on the build `cli\current` names: an update writes a
 * new version folder rather than replacing the master's own cli.js. A build from a checkout keeps its own file, and
 * hands over to nothing (no launcher would start it).
 */
export function windowsMaster(scriptPath: string, deps: WindowsMasterDeps = processWindowsMasterDeps()): Partial<MasterConfig> {
  const installed = isInstalledCopy(scriptPath, deps.cliDir, 'win32')
  const root = dirname(deps.cliDir)
  const launcher = harnessLaunchPath(root)
  let output: number | undefined
  if (!deps.isTTY) {
    try {
      output = deps.openLog()
    } catch (error) {
      // A log it cannot open (a full disk, a file held by a scan) costs the master its lines, never the daemon.
      console.error(`${ts()} [harnessd] could not open the daemon log (${error instanceof Error ? error.message : String(error)}) — running without it`)
    }
    if (output !== undefined) {
      deps.redirect(output)
      deps.fatal(output)
    }
  }
  return {
    stopByMessage: true,
    ...(output !== undefined ? { output } : {}),
    ...(installed ? { currentScript: () => deps.currentCli(root)?.cliJs ?? null } : {}),
    ...(installed && deps.exists(launcher) ? {
      handOver: {
        lock: deps.lock,
        launch: async (handed: NodeJS.ProcessEnv) => {
          const outcome = await deps.launch(launcher, root, ['__harnessd'], handed, undefined, HANDOVER_LAUNCH_TIMEOUT_MS)
          return outcome.ok ? null : outcome.detail
        },
        readPid: deps.readPid,
        alive: deps.alive,
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        token: () => randomBytes(16).toString('hex'),
      },
    } : {}),
  }
}

/** Run the master. */
export function startMaster(
  start: MasterStart, exit: (code: number) => void = (code) => process.exit(code),
  platform: NodeJS.Platform = process.platform, windows: () => Partial<MasterConfig> = () => windowsMaster(start.scriptPath),
): ReturnType<typeof runMaster> {
  // Before it starts anything: on Linux an absent locale makes tmux and ps mangle their output, and the
  // core and the services inherit this environment (lib/childLocale.ts). launchd and systemd start the
  // master with no `harness start` before it to have set it.
  ensureUtf8Locale()
  // And the session of the agent whose shell ran `harness start`, which every pane would otherwise have
  // (lib/agentSessionEnv.ts).
  dropAgentSessionEnv()
  const { serviceScriptPath } = start
  // Windows, before the master says anything: harness-launch.exe gave it no output, and its console is the daemon's log
  // from here on, `masterEnv`'s line among the rest.
  const windowsConfig = platform === 'win32' ? windows() : {}
  // The install root a terminal host payload is installed in (lib/windows/ptyInstall.ts); none elsewhere.
  const ptyRoot = platform === 'win32' ? dirname(env.ADAPTER_CLI_DIR) : null
  // What the master does to the host, it does under the daemon spawn lock: the updater sweeps bin\'s aside files under it,
  // and an aside file may hold the only copy of a path a rollback puts back. Taken only while a host is on probation.
  const lock = () => tryAcquireSpawnLockSync('update')
  const masterLog = (line: string) => console.log(`${ts()} ${line}`)
  return runMaster({
    env: masterEnv(process.env, unixSocketPath(env.ADAPTER_DATA_DIR, env.PORT), undefined, platform),
    nodePath: baseNode(process.execPath),
    execArgv: process.execArgv,
    runtimeDir: env.ADAPTER_RUNTIME_DIR,
    ...windowsConfig,
    ...start,
    pidFile: PID_FILE,
    statusFile: HARNESSD_STATUS_FILE,
    logFile: DAEMON_LOG_FILE,
    // One probation for whatever the updater staged: the CLI build, the terminal host (Windows), or both.
    restoreUpdate: () => rollBackStaged({
      cliPending: () => pendingVersion(env.ADAPTER_CLI_DIR) !== null, restoreCli: () => restoreUpdate(env.ADAPTER_CLI_DIR),
      ptyRoot, log: masterLog, lock,
    }),
    confirmUpdate: () => keepStaged({ confirmCli: () => confirmUpdate(env.ADAPTER_CLI_DIR), ptyRoot, log: masterLog, lock }),
    version: VERSION,
    reexecMarkerFile: HARNESSD_REEXEC_FILE,
    // A host still on probation when the master judging it died (a power cut) is judged by the first core too: left
    // unjudged, its marker would hold every later host update back. One of a protocol this build cannot speak, with no
    // CLI build pending, is a paired host whose build never went in: taken back out instead (`ptyUnjudged`).
    unjudgedUpdate: (bundle) => unjudgedUpdate(env.ADAPTER_CLI_DIR, bundle)
      ?? (ptyRoot === null ? null : ptyUnjudged(ptyRoot, { cliPending: pendingVersion(env.ADAPTER_CLI_DIR) !== null, log: masterLog, lock })),
    // The updater runs for the installed copy alone (lib/installedCopy.ts), beside the core, never in it.
    // The Harness Team account takes releases even when its owner's environment switched updates off and setup carried
    // that in (team/layout.ts): nobody develops in it, and nobody is there to update it by hand.
    updater: (!env.ADAPTER_UPDATE_DISABLE || isTeamAccount()) && isInstalledCopy(start.scriptPath, env.ADAPTER_CLI_DIR),
    // A master that ends cleanly gives up its claim on its lean bundle, so the next one to start can
    // clear the folder; one that dies leaves a claim whose pid is gone, which counts for nothing.
    exit: (code) => {
      if (serviceScriptPath) releaseLeanClaim(serviceScriptPath)
      exit(code)
    },
  })
}

/**
 * `harness start -f`, for a supervisor (launchd, systemd, a terminal): the master in this process, as
 * launchd and systemd run it (`__harnessd`, entry.ts), the core and the services its children, their lines
 * on this process's output. The core used to run here on its own, and a core with no master has to hand
 * each update over itself (docs/design/2026-10-06-core-boundary-next.md, "Updaters"). A bundle
 * re-executes on the lean bundle it carries, same pid, as a master launchd starts does; the sources have
 * none, and run as cli.ts's `__harnessd` runs them.
 */
export function startMasterInForeground(
  scriptPath: string,
  start: { fromBundle: (bundlePath: string) => void; fromSources: (start: MasterStart) => unknown } = { fromBundle: startMasterFromBundle, fromSources: startMaster },
): void {
  if (scriptPath.endsWith('.ts')) start.fromSources({ scriptPath })
  else start.fromBundle(scriptPath)
}

/** Whether this bundle can run a master that takes over from the running one; the exit code. */
export function probeThisMaster(): number {
  return probeMaster({ env: process.env, execArgv: process.execArgv, version: VERSION })
}

export interface BundleMasterDeps {
  env: NodeJS.ProcessEnv
  /** Whether `LEAN_OFF_FILE` is there. */
  leanOff: () => boolean
  exists: (path: string) => boolean
  read: (path: string) => Buffer
  /** Writes the lean bundle out and returns where (harnessd/leanBundle.ts `writeLeanBundle`). */
  write: (lean: LeanBundle) => string
  /** Runs `<lean> __harnessd-probe` as the re-executed master would start: whether it answered. */
  probe: (leanPath: string, env: NodeJS.ProcessEnv) => { ok: boolean; detail: string }
  execve: Execve | null
  /** The node the master re-executes on: the managed one under the name `harnessd`
   *  (harnessd/processName.ts), so Activity Monitor names it. Asked only when it re-executes; defaults
   *  to this process's. */
  node?: () => string
  start: (start: MasterStart) => unknown
  log: (line: string) => void
  /** This operating system (Windows: no lean bundle). */
  platform?: NodeJS.Platform
}

/** Run `<leanPath> __harnessd-probe` with this process's Node and flags, as the master would start on it. */
export function probeLean(leanPath: string, probeEnv: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): { ok: boolean; detail: string } {
  const run = spawnSync(process.execPath, [...process.execArgv, leanPath, '__harnessd-probe'], {
    env: probeEnv, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Judged as the re-execution's own probe judges a bundle (harnessd/reexec.ts `runProbe`).
  const out = String(run.stdout ?? '')
  const lastLine = (text: string): string => text.trim().split('\n').pop()!.trim()
  return {
    ok: run.status === 0 && out.includes(PROBE_ANSWER),
    detail: run.error?.message ?? (lastLine(String(run.stderr ?? '')) || lastLine(out) || (run.signal ? `signal ${run.signal}` : `exit ${run.status}`)),
  }
}

export const processBundleDeps = (): BundleMasterDeps => ({
  env: process.env,
  leanOff: () => existsSync(LEAN_OFF_FILE),
  exists: existsSync,
  read: (path) => readFileSync(path),
  write: (lean) => writeLeanBundle(LEAN_DIR, lean),
  probe: (leanPath, probeEnv) => probeLean(leanPath, probeEnv),
  execve: processExecve(),
  node: () => namedNode(baseNode(process.execPath), 'harnessd', env.ADAPTER_RUNTIME_DIR, { log: (line) => console.log(`${ts()} ${line}`) }),
  start: startMaster,
  log: (line) => console.log(`${ts()} ${line}`),
  platform: process.platform,
})

/**
 * The master, started on [bundlePath] (cli.js): re-executed on the lean bundle cli.js carries when this
 * Node can (22.15 and 23.11 on), with the services started from it; run here, from cli.js, with the
 * services still started from the lean bundle when it cannot; and as before, from cli.js alone, when
 * there is no lean bundle to use, `HARNESSD_LEAN=off` or `LEAN_OFF_FILE`. A lean bundle is used only once
 * it has answered the probe a master about to re-execute asks (harnessd/reexec.ts): one that cannot start
 * a master is never handed the daemon.
 */
export function startMasterFromBundle(bundlePath: string, deps: BundleMasterDeps = processBundleDeps()): void {
  const fromBundle = (reason: string | null, lean?: { path: string; fingerprint: string }): void => {
    if (reason) deps.log(`[harnessd] ${reason}`)
    deps.start({ scriptPath: bundlePath, ...(lean ? { serviceScriptPath: lean.path, leanFingerprint: lean.fingerprint } : {}) })
  }
  // The lean bundle's claims and its services' identity rely on hard links of the managed node (harnessd/AGENTS.md
  // rules 7 and 8), which a Windows install does not make: there the master and everything it starts run from cli.js.
  if (deps.platform === 'win32') { fromBundle(null); return }
  if (deps.env.HARNESSD_LEAN === 'off') { fromBundle(null); return }
  if (deps.leanOff()) { fromBundle(`${LEAN_OFF_FILE} is there: the master, the core and the services run from ${bundlePath}`); return }
  let written: { lean: LeanBundle; path: string } | null
  try {
    const lean = readLeanBundle(deps.read(bundlePath))
    written = lean ? { lean, path: deps.write(lean) } : null
  } catch (error) {
    fromBundle(`the lean bundle could not be written out (${error instanceof Error ? error.message : String(error)}): the master, the core and the services run from ${bundlePath}`)
    return
  }
  if (!written) { fromBundle(`no lean bundle in ${bundlePath}: the master, the core and the services run from it`); return }
  const { lean, path: leanPath } = written
  const fingerprint = leanFingerprint(lean)
  const leanEnv = { ...deps.env, [BUNDLE_ENV]: bundlePath, [BUNDLE_SHA256_ENV]: lean.bundleSha256, [LEAN_FINGERPRINT_ENV]: fingerprint }
  const probed = deps.probe(leanPath, leanEnv)
  if (!probed.ok) {
    fromBundle(`the lean bundle ${leanPath} did not answer its probe (${probed.detail}): the master, the core and the services run from ${bundlePath}`)
    return
  }
  if (!deps.execve) {
    fromBundle(`this Node cannot re-execute the master: it runs from ${bundlePath}, the core and the services from ${leanPath}`, { path: leanPath, fingerprint })
    return
  }
  // An exec that fails cannot be caught once it has begun: on Node 22.23 a node binary that is not there
  // aborts this process (exit 134), and a script that is not there ends it in the new image
  // (MODULE_NOT_FOUND). The probe ran both a moment ago; they are checked again right before.
  const node = deps.node?.() ?? process.execPath
  const missing = [node, leanPath].find((path) => !deps.exists(path))
  if (missing) {
    fromBundle(`${missing} is not there to re-execute on: the master, the core and the services run from ${bundlePath}`)
    return
  }
  try {
    deps.execve(node, [node, ...process.execArgv, leanPath, '__harnessd'], leanEnv)
  } catch (error) {
    // Only what `process.execve` refuses before it begins: arguments it cannot take.
    fromBundle(`the master could not re-execute on ${leanPath} (${error instanceof Error ? error.message : String(error)}): it runs from ${bundlePath}, the core and the services from ${leanPath}`, { path: leanPath, fingerprint })
  }
}
