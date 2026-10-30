/**
 * `harness __harnessd`: the master process `harness start` launches (see ./supervisor.ts for what it
 * does). This file is only its wiring to the operating system: the core child, the pid file, the status
 * file, the log's size, signals, and re-executing on a new bundle (./reexec.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { ignoreLogWriteErrors, trimLogFile, ts } from '../lib/log.js'
import { folderFingerprint } from './leanBundle.js'
import { CORE, leanServices } from './leanServices.js'
import { platformFromEnv, type PlatformName } from './platform.js'
import { baseNode, namedNode } from './processName.js'
import { LEAN_CORE_SCRIPT_ENV, type MasterMessage } from './protocol.js'
import {
  PROBE_ANSWER, PROBE_HANDOVER, RESUME_ENV, createReexec, decodeResume, fingerprint, mayClaimPidFile, readHandoverClaimant, readMarker, recoverFailedReexec,
  removeMarker, runProbe, sweepHandovers, takeBackHandover, takeHandover, writeMarker, type HandOverDeps, type ReexecMarker,
} from './reexec.js'
import { SERVICE_HOSTS, ServiceSupervisor, UPDATER_HOST, UPDATER_PROCESS, serviceOptions, serviceProcessesEnv, serviceSpecs } from './services.js'
import {
  DEFAULT_SUPERVISOR_OPTIONS, Supervisor, type CoreHandle, type SupervisorDeps, type SupervisorOptions, type SupervisorStatus,
} from './supervisor.js'

/** How often the master keeps the daemon's log under its cap. */
export const LOG_TRIM_INTERVAL_MS = 60_000

export interface MasterConfig {
  /** The node binary and flags the core runs with. */
  nodePath: string
  execArgv: string[]
  /** The managed runtime's folder: a node inside it runs each process under its own name
   *  (./processName.ts); any other node runs as `node`. */
  runtimeDir?: string
  /** The CLI entry (`cli.js`, or `src/cli.ts` under tsx): what the core and the services fall back on,
   *  and what an update replaces on disk. */
  scriptPath: string
  /** What the services and the core run instead, when it is not the CLI entry: the lean bundle the entry
   *  carries (./leanBundle.ts), so each parses its own code and not the whole CLI's. Only ever an
   *  optimisation: each starts from `scriptPath` whenever it cannot be used (./leanServices.ts). */
  serviceScriptPath?: string
  /** What the lean bundle's folder fingerprints to as this master starts (./leanBundle.ts
   *  `leanFingerprint`): checked before every service and every core is started from it. */
  leanFingerprint?: string
  /** The sha256 of the bundle this master's code came from, when the master was not started on
   *  `scriptPath` itself but on the lean bundle read from it: the bundle it runs is the one it was read
   *  from, whatever is on disk by the time this master starts. */
  bundleFingerprint?: string
  pidFile: string
  /** Where the master records its status for `harness status` (see `writeStatusFile`). */
  statusFile?: string
  /** The log the master and its core write, kept under its cap by the master. */
  logFile?: string
  restoreUpdate(): void
  confirmUpdate(): void
  env?: NodeJS.ProcessEnv
  /** Defaults to `process.exit`. */
  exit?: (code: number) => void
  /** Where SIGTERM, SIGINT and SIGHUP are listened for; defaults to this process. */
  onSignal?: (signal: NodeJS.Signals, listener: () => void) => void
  /** This bundle's version, for the status (`harness status`, `/api/status`). */
  version?: string
  /** Where a master about to re-execute on the bundle on disk leaves its marker (./reexec.ts). Left
   *  out, the master never re-executes, as before. */
  reexecMarkerFile?: string
  /** Replace this process (`process.execve`); defaults to this Node's, null where it has none. */
  execve?: Execve | null
  /** The version of the update the bundle with this fingerprint is, when it is one no master kept or
   *  rolled back (`selfUpdate.unjudgedUpdate`); null otherwise. Left out, never. */
  unjudgedUpdate?: (bundle: string | null) => string | null
  /** Run the updater (`UPDATER_HOST`): the installed copy, with updates on (masterProcess.ts). */
  updater?: boolean
  /** The file the core, the services and a replacement start from, when it is not `scriptPath`: on Windows the build
   *  `cli\current` names (lib/windows/installLayout.ts `currentCli`), read before every start. An update is judged on
   *  it. Null falls back on `scriptPath`. The lean bundle is not used with it (../masterProcess.ts). */
  currentScript?: () => string | null
  /** Windows: how this master hands over to its replacement (./reexec.ts `HandOverDeps`). */
  handOver?: MasterHandOver
  /** Windows: stop the core and the services with `harnessd:shutdown` (./supervisor.ts `stopByMessage`). */
  stopByMessage?: boolean
  /** Where the core's and the services' output goes, a file descriptor: on Windows the launcher gives a master
   *  none, so it opens the daemon's log itself (../masterProcess.ts). Their own output otherwise. */
  output?: number
}

/**
 * What a master that hands over is given (../masterProcess.ts). The rest is this file's: the pid file is written as
 * every claim of it is, the handover is decided in the marker's folder (./reexec.ts `readHandoverClaimant`,
 * `takeBackHandover`), and leaving is this process's end. The lock waits a bounded while (../masterProcess.ts
 * `HANDOVER_LOCK_WAIT_MS`) for a start or a stop under way: null when it is still busy, or on any throw. The launch is bounded well inside the 45 s a `harness stop` waits on the lock. Each token is fresh. `readPid`
 * throws when the pid file cannot be read: null says it names no pid, and on that this master stays at the bound
 * (./reexec.ts `taken`), where a file it could not read is a new master it must leave to. This file's own pid-file
 * read, which takes a failure for null, is never given to it.
 */
export type MasterHandOver = Omit<HandOverDeps, 'claim' | 'claimant' | 'takeBack' | 'leave'>

export type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => void

/** The defaults `runMaster` acts on this process with. */
export const processExit = (code: number): void => { process.exit(code) }
export const onProcessSignal = (signal: NodeJS.Signals, listener: () => void): void => { process.on(signal, listener) }
/** `process.execve` (Node 22.15 and 23.11 on, and not yet in the typings this builds with); null without it. */
export function processExecve(proc: object = process): Execve | null {
  const execve = (proc as { execve?: unknown }).execve
  return typeof execve === 'function' ? (file, args, env) => { execve.call(proc, file, args, env) } : null
}

/** What a config leaves out, taken from this process. Pure: choosing a default does not act on one. */
export function masterDefaults(config: MasterConfig): Required<Pick<MasterConfig, 'env' | 'exit' | 'onSignal'>> & { execve: Execve | null } {
  return {
    env: config.env ?? process.env, exit: config.exit ?? processExit, onSignal: config.onSignal ?? onProcessSignal,
    execve: config.execve === undefined ? processExecve() : config.execve,
  }
}

/** The heap limit `--max-old-space-size` sets in these flags, MiB; null when none does. */
export function heapLimitInArgv(execArgv: readonly string[]): number | null {
  for (let i = execArgv.length - 1; i >= 0; i--) {
    const match = /^--max[-_]old[-_]space[-_]size=(\d+)$/.exec(execArgv[i])
    if (match) return Number(match[1])
  }
  return null
}

/**
 * Supervisor timings and budgets from the environment (for tests and support), and the flags the core
 * runs with. Anything unset or invalid keeps its default. The heap limit is one number in both places:
 * `HARNESSD_HEAP_LIMIT_MIB` when set, else a `--max-old-space-size` the master itself was given, else
 * the default — and the core is given exactly the limit its budget is a share of.
 */
export function supervisorOptions(env: NodeJS.ProcessEnv, execArgv: readonly string[] = []): SupervisorOptions {
  const read = (name: string, fallback: number, min: number, max = Infinity): number => {
    const value = Number(env[name])
    return env[name] !== undefined && Number.isFinite(value) && value >= min && value <= max ? value : fallback
  }
  const d = DEFAULT_SUPERVISOR_OPTIONS
  return {
    bindTimeoutMs: read('HARNESSD_BIND_TIMEOUT_MS', d.bindTimeoutMs, 1),
    readyTimeoutMs: read('HARNESSD_READY_TIMEOUT_MS', d.readyTimeoutMs, 1),
    // A second at least: below that a GC pause reads as a hang.
    heartbeatTimeoutMs: read('HARNESSD_HEARTBEAT_TIMEOUT_MS', d.heartbeatTimeoutMs, 1_000),
    stopGraceMs: read('HARNESSD_STOP_GRACE_MS', d.stopGraceMs, 1),
    initialBackoffMs: read('HARNESSD_INITIAL_BACKOFF_MS', d.initialBackoffMs, 0),
    maxBackoffMs: read('HARNESSD_MAX_BACKOFF_MS', d.maxBackoffMs, 0),
    backoffResetMs: read('HARNESSD_BACKOFF_RESET_MS', d.backoffResetMs, 0),
    heapLimitMiB: read('HARNESSD_HEAP_LIMIT_MIB', heapLimitInArgv(execArgv) ?? d.heapLimitMiB, 0),
    heapRestartPercent: read('HARNESSD_HEAP_RESTART_PERCENT', d.heapRestartPercent, 1, 100),
    rssLimitMiB: read('HARNESSD_RSS_LIMIT_MIB', d.rssLimitMiB, 0),
    updateProbationMs: read('HARNESSD_UPDATE_PROBATION_MS', d.updateProbationMs, 0),
    crashLoopCrashes: read('HARNESSD_CRASH_LOOP_CRASHES', d.crashLoopCrashes, 1),
    crashLoopWindowMs: read('HARNESSD_CRASH_LOOP_WINDOW_MS', d.crashLoopWindowMs, 0),
  }
}

/** The flags the core runs with: the master's own, with the heap limit its budget is a share of. */
export function coreExecArgv(execArgv: readonly string[], heapLimitMiB: number): string[] {
  const rest = execArgv.filter((flag) => !/^--max[-_]old[-_]space[-_]size=/.test(flag))
  // Node lets the young generation grow to 16 MiB per semi-space and keeps it: the core sat at 32 MB
  // of new space holding 2.6 MB, 13 hours in (measured 2026-10-07). 4 MiB returns ~24 MB a process;
  // scavenges run more often, each as cheap, since what survives one is that same small set.
  if (!rest.some((flag) => /^--max[-_]semi[-_]space[-_]size=/.test(flag))) rest.push('--max-semi-space-size=4')
  return heapLimitMiB > 0 ? [...rest, `--max-old-space-size=${heapLimitMiB}`] : rest
}

/**
 * Record the master's status for `harness status`, which reads it when no core can answer — one that
 * is crash-looping, restarting, or in safe mode. Written whole and renamed into place, so a reader
 * never sees half of it.
 */
export function writeStatusFile(file: string, status: MasterStatusFile): void {
  const temp = `${file}.${status.masterPid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(status)}\n`)
    renameSync(temp, file)
  } catch {
    // Best effort: a full disk must not stop the master from supervising.
    try { rmSync(temp, { force: true }) } catch { /* nothing more to do */ }
  }
}

/** `platform`: launchd or systemd runs this master (`harness service install`); absent when
 *  `harness start` or the desktop app started it. How `harness stop` knows to ask the platform. */
export type MasterStatusFile = SupervisorStatus & { masterPid: number; platform?: PlatformName }

/** Keep `file` under its cap from now on; returns what stops it. Nothing to trim, nothing to stop. */
export function trimLogEvery(file: string | undefined, ms = LOG_TRIM_INTERVAL_MS, trim: (file: string) => boolean = trimLogFile): () => void {
  if (!file) return () => {}
  const timer = setInterval(() => trim(file), ms)
  return () => clearInterval(timer)
}

/** The master's status file, if it is there and was written by `masterPid`; null otherwise. */
export function readStatusFile(file: string, masterPid: number | null): MasterStatusFile | null {
  try {
    const status = JSON.parse(readFileSync(file, 'utf8')) as Partial<MasterStatusFile>
    if (typeof status.state !== 'string' || status.masterPid !== masterPid) return null
    return status as MasterStatusFile
  } catch {
    return null
  }
}

const REASONS: Record<string, string> = {
  crashed: 'it crashed', hung: 'it hung', 'did-not-bind': 'it did not start listening',
  'not-ready': 'it did not finish starting', memory: 'it outgrew its memory budget', update: 'an update',
  stopped: 'it was stopped',
}

/** What `harness status` says when the core cannot answer for itself; null when the master has nothing
 *  to add (a core is up, or nothing is known). */
export function describeMasterStatus(status: MasterStatusFile | null): string | null {
  if (!status) return null
  const last = status.lastExitReason ? ` · last core ended because ${REASONS[status.lastExitReason] ?? status.lastExitReason} (${status.lastExit})` : ''
  if (status.safeMode) return `◍ safe mode · the core ${status.safeMode === 'crash-loop' ? 'kept crashing' : `could not start (${status.safeMode})`} — waiting for a fixed build${last}`
  if (status.state === 'restarting') return `◍ restarting its core · restart ${status.restarts}${last}`
  if (status.state === 'starting' || status.state === 'listening') return `● starting${status.restarts ? ` · restart ${status.restarts}` : ''}${last}`
  return null
}

/** A child process as the supervisor sees it. A spawn that fails reports as an exit. */
export function coreHandle(child: ChildProcess): CoreHandle {
  let exited = false
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exited) return
    exited = true
    for (const listener of exits) listener(code, signal)
  }
  child.on('exit', exit)
  child.on('error', () => exit(1, null))
  return {
    pid: child.pid,
    // Found by QA after a quiet-machine run: CI lost an update exit 75 to a failed status send.
    // A callback keeps IPC send errors out of the child's spawn-error/exit path.
    send: (message: MasterMessage) => { try { child.send(message, () => {}) } catch { /* the core is going */ } },
    kill: (signal) => { try { child.kill(signal) } catch { /* already gone */ } },
    onMessage: (listener) => { child.on('message', listener) },
    onExit: (listener) => { exits.push(listener) },
  }
}

/**
 * `harness __harnessd-probe`: what a master about to re-execute on this bundle asks it first
 * (./reexec.ts). Everything a master does before it starts its children, with the state it would be
 * handed, and nothing after: the whole bundle loads, the state reads, a master is built. Exit 0 and
 * the answer, or 1 and why.
 */
export function probeMaster(config: { env: NodeJS.ProcessEnv; execArgv: string[]; version: string }, say: (line: string) => void = console.log): number {
  try {
    const handed = config.env[RESUME_ENV]
    const resume = decodeResume(handed)
    if (handed !== undefined && !resume) throw new Error('the state it would be handed is not one this master can read')
    serviceSpecs(config.env, SERVICE_HOSTS)
    const inert = { wallClock: () => Date.now() } as unknown as SupervisorDeps
    const status = new Supervisor(inert, supervisorOptions(config.env, config.execArgv), { version: config.version, resume }).status()
    say(`${PROBE_ANSWER} · protocol ${status.protocol} · v${status.masterVersion} · ${PROBE_HANDOVER}`)
    return 0
  } catch (error) {
    say(`harnessd-probe failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}


export function runMaster(config: MasterConfig): Supervisor {
  ignoreLogWriteErrors()
  const { env: given, exit, onSignal, execve } = masterDefaults(config)
  process.title = 'harnessd'
  // What the master this process was a moment ago handed on, if it was one (./reexec.ts). Taken out of
  // the environment every child is given: a core or service has no use for it, and a later re-exec
  // writes its own.
  const resume = decodeResume(given[RESUME_ENV])
  const env: NodeJS.ProcessEnv = { ...given }
  delete env[RESUME_ENV]
  const writePidFile = (pid = process.pid): void => { writeFileSync(config.pidFile, `${pid}\n`) }
  const readPid = (): number | null => {
    try { return Number.parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10) || null } catch { return null }
  }
  const options = supervisorOptions(env, config.execArgv)
  const execArgv = coreExecArgv(config.execArgv, options.heapLimitMiB)
  // The core's stamp, local time (lib/log.ts): in UTC, the master's lines sat hours away from the core's
  // lines around them in the one log they share.
  const log = (line: string) => console.log(`${ts()} ${line}`)
  // Each process exec'd through a link named after it, so Activity Monitor and `top` tell them apart.
  const node = baseNode(config.nodePath)
  const named = (name: string): string => namedNode(node, name, config.runtimeDir, { log })
  // Set by the launchd agent or systemd unit `harness service install` writes (./platform.ts).
  const platform = platformFromEnv(env)
  if (platform) log(`[harnessd] run by ${platform}, which starts this master again if it dies`)
  // Started by a master handing over (Windows, ./reexec.ts): not a re-execution, which keeps its pid.
  const handover = resume?.handover
  if (resume && !handover) log(`[harnessd] master re-executed (pid ${process.pid})${config.version ? ` · now v${config.version}` : ''}`)
  if (config.serviceScriptPath && config.serviceScriptPath !== config.scriptPath) {
    log(`[harnessd] services run from ${config.serviceScriptPath}${config.bundleFingerprint ? ', as this master does' : ''}`)
  }
  // The bundle this master's code came from, read once, as it starts; the bundle on disk is read
  // again before every core starts.
  const own = config.bundleFingerprint ?? fingerprint(config.scriptPath)
  // What the next core, service or replacement starts from: the current build (Windows), else this master's bundle.
  const script = (): string => config.currentScript?.() ?? config.scriptPath
  const bundle = () => fingerprint(script())
  const output = config.output ?? 'inherit'
  const markerFile = config.reexecMarkerFile
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  /**
   * Started by a master handing over (Windows, ./reexec.ts): this process is the master only once it took the handover
   * and, while it still may, wrote the pid file, as an exec would have kept it. Otherwise that master stayed, or is
   * about to (it gave up waiting, took the handover back, or is past the cutoff), and this one leaves at once, having
   * started nothing, rolled nothing back, and taken no spawn lock: that master holds it, and releases it as it leaves.
   * The marker stays as it is, naming that master, which reads it until it leaves; this one's core coming up ends it.
   * Refused once the pid file is written, this one leaves too: a pid file naming a process that ended is the master
   * that handed over staying, and no master at all is what `harness start --if-down` recovers; two would go unnoticed.
   */
  const takeOver = ({ from, token }: { from: number; token: string }): boolean => {
    const leaving = (why: string): false => { log(`[harnessd] ${why} — leaving`); return false }
    const stopped = `the master that started this one (pid ${from}) stopped waiting for it`
    const write = (pid: number): string | null => { try { writePidFile(pid); return null } catch (error) { return (error as Error).message } }
    if (!markerFile || !takeHandover(markerFile, token, process.pid) || !mayClaimPidFile(markerFile, token)) return leaving(stopped)
    const failed = write(process.pid)
    if (failed !== null) return leaving(`could not take over from pid ${from} (${failed})`)
    if (!mayClaimPidFile(markerFile, token)) {
      // That master may have settled on the pid file naming it before this write: still running, it is the master, and
      // a pid file naming this process, about to end, would have `harness start --if-down` start a second one.
      if (readPid() === process.pid && alive(from)) write(from)
      return leaving(`${stopped} as this one took over`)
    }
    log(`[harnessd] took over from the master before it (pid ${from})`)
    return true
  }
  const tookOver = handover ? takeOver(handover) : true
  // Trimmed here rather than by the core: the master outlives every core, and two trimmers rewriting
  // one file in place would race. Not by a master handed over to until it took over: the one before
  // trims the log until then.
  const stopTrimming = tookOver ? trimLogEvery(config.logFile) : () => {}
  // The marker is this master's: its own re-execution's, or the handover it took, which names the master before it.
  const ownMarker = (marker: ReexecMarker | null): boolean => !!marker && (marker.pid === process.pid || (!!handover && marker.handover === handover.token))
  if (markerFile && !handover) {
    // A re-execution before this start that never brought a core up: back to the previous bundle,
    // which the supervisor then re-executes this master on before it starts anything.
    recoverFailedReexec({
      marker: readMarker(markerFile), pid: process.pid, alive, current: bundle,
      restoreUpdate: config.restoreUpdate, removeMarker: () => removeMarker(markerFile), log,
    })
  }
  // Windows: the decisions of handovers over and done, all but this one's and the one a marker still names.
  if (markerFile && tookOver && (handover || config.handOver)) sweepHandovers(markerFile, [handover?.token, readMarker(markerFile)?.handover])
  // Started fresh on an update the master judging it never finished with (it died: a crash, a kill, a
  // power cut): this master judges it. A re-executed master was handed its own. Asked of the bundle on
  // disk now, which the first core runs, not of this master's own: a recovery just above may have put
  // the build before back, and when its rollback could not write the rejected list the pending note
  // still names this master's bundle. Asked of that, the restored build's first core was put on trial,
  // and keeping it would have dropped the note that remembers the failed one (selfUpdate.settleRolledBack).
  const unjudged = resume ? null : config.unjudgedUpdate?.(bundle()) ?? null
  if (unjudged) log(`[harnessd] the bundle on disk is ${unjudged}, an update no master kept or rolled back — its first core is on probation`)
  let stopping = false
  // A new one every boot, given to the core and to each service: how the core knows a service
  // connection is one this master started, and no other local process.
  const token = randomBytes(24).toString('hex')
  const lean = leanServices({
    scriptPath: config.scriptPath, leanPath: config.serviceScriptPath, leanFingerprint: config.leanFingerprint,
    folderFingerprint, exists: existsSync, sameBundle: () => bundle() === own, log,
  })
  const specs = serviceSpecs(env, SERVICE_HOSTS)
  // The updater beside them, whatever HARNESSD_SERVICES says: the core neither routes to it nor runs it.
  const processes = config.updater ? [...specs, { name: UPDATER_PROCESS, ...UPDATER_HOST }] : specs
  let supervisor: Supervisor | null = null
  const services = new ServiceSupervisor(processes, {
    spawnService: (spec, extra) => {
      // From the lean bundle when it can be (./leanServices.ts); with a current build (Windows), from that.
      const file = config.currentScript ? script() : lean.scriptFor(spec.name)
      // One process for every service it hosts, each on its own link to the core (services/process.ts).
      const handle = coreHandle(spawn(named(`harnessd-${spec.name}`), [...coreExecArgv(config.execArgv, spec.heapLimitMiB), file, '__service', spec.services.join(',')], {
        env: { ...env, ...extra },
        stdio: ['ignore', output, output, 'ipc'],
      }))
      if (!config.currentScript) lean.started(spec.name, file, handle)
      return handle
    },
    stopByMessage: config.stopByMessage,
    now: () => performance.now(),
    wallClock: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log,
    // The updater staged a build, a terminal host or both: the core is asked to hand over, and the new core judged.
    staged: (staged) => supervisor?.updateStaged(staged),
    // HARNESSD_JUDGES_PTY: this master takes a terminal host's staging and judges it on its probation (Windows,
    // services/updaterProcess.ts). An updater under a master from before stages no host: no one would roll it back.
  }, serviceOptions(env), { HARNESSD_SERVICE_TOKEN: token, HARNESSD_JUDGES_PTY: '1' })
  // The pid file is this master's to remove as it ends: the supervisor says so once it claimed it, and so does a claim
  // as this master hands over (Windows), which the supervisor does not know of.
  let releaseOnExit = false
  const reexec = markerFile ? createReexec({
    own, current: bundle, nodePath: named('harnessd'), execArgv: config.execArgv, get scriptPath() { return script() }, env, pid: process.pid,
    execve, exists: existsSync,
    probe: (args, probeEnv) => runProbe(node, args, probeEnv),
    stopChildren: (done) => services.stop(done),
    startChildren: () => services.start(),
    writeMarker: (marker) => writeMarker(markerFile, marker),
    removeMarker: () => removeMarker(markerFile),
    stopping: () => stopping,
    now: () => Date.now(),
    log,
    // Windows, which has no exec: a replacement started beside this master, the handover decided in the marker's folder.
    ...(config.handOver ? {
      handOver: {
        ...config.handOver,
        claim: () => { writePidFile(); releaseOnExit = true },
        claimant: (handed: string) => readHandoverClaimant(markerFile, handed),
        takeBack: (handed: string) => takeBackHandover(markerFile, handed, process.pid),
        // This master's end once its replacement holds the pid file: nothing of the daemon's left to stop.
        leave: () => { stopTrimming(); exit(0) },
      },
    } : {}),
  }) : null
  // A stop, from a signal or from the core (`harnessd:stop`, `harness stop` on Windows): the services go beside the
  // core, inside the same grace `harness stop` gives the whole daemon.
  const stopAll = (why: string): void => {
    stopping = true
    reexec?.cancel()
    services.stop(() => {})
    supervisor!.stop(why)
  }
  supervisor = new Supervisor({
    spawnCore: (extra) => {
      // From the lean bundle on the core's own code when it can be, as a service is, by the same rules
      // (./leanServices.ts), and from cli.js otherwise. The supervisor judges the core it is given the
      // same either way: an update's first core, lean or not, is on probation as before.
      // With a current build (Windows), from that, and never from the lean bundle.
      const leanCore = config.currentScript ? null : lean.scriptFor(CORE)
      const file = leanCore ?? script()
      const handle = coreHandle(spawn(named('harnessd-core'), [...execArgv, file, '__run'], {
        // Told which services this master runs, so it routes to exactly those and runs the rest itself;
        // and, from the lean bundle, which cli.js is its CLI (leanCoreEntry.ts).
        env: {
          ...env, ...extra, HARNESSD_SERVICE_TOKEN: token, ...serviceProcessesEnv(specs, process.pid),
          ...(leanCore !== null && leanCore !== config.scriptPath ? { [LEAN_CORE_SCRIPT_ENV]: config.scriptPath } : {}),
        },
        stdio: ['ignore', output, output, 'ipc'],
      }))
      if (leanCore !== null) lean.started(CORE, leanCore, handle)
      return handle
    },
    now: () => performance.now(),
    wallClock: () => Date.now(),
    writeStatus: (status) => { if (config.statusFile) writeStatusFile(config.statusFile, { ...status, masterPid: process.pid, ...(platform ? { platform } : {}) }) },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    // On a full disk the claim fails, and the master carries on without it: it was thrown out of the
    // core's `bound` message, and took the master down.
    claimPidFile: () => {
      try { writePidFile() } catch (error) { log(`[harnessd] could not write the pid file: ${(error as Error).message}`) }
    },
    // Removed as this master exits, below: once a handover under way (Windows) is decided.
    releasePidFile: () => { releaseOnExit = true },
    restoreUpdate: config.restoreUpdate,
    confirmUpdate: config.confirmUpdate,
    bundle,
    log,
    // A process on demand, started once the core asks (./services.ts `onDemand`), or as a core too old to ask binds.
    want: (service) => services.want(service),
    unasked: (protocol) => services.unasked(protocol),
    stopByMessage: config.stopByMessage,
    stopRequested: stopAll,
    // The services go with the master, after the core: none is left holding the core's socket.
    exit: (code) => {
      stopping = true
      reexec?.cancel()
      // Stopped as it handed over (Windows), and the new master took over: the pid file and the marker are its.
      const end = (handedOver: boolean): void => {
        if (!handedOver) {
          if (releaseOnExit && readPid() === process.pid) rmSync(config.pidFile, { force: true })
          // A master stopped before its first core came up has not failed to come up: its own marker goes
          // with it. Left behind by a stop, a sign-out or a shutdown in the seconds after a re-execution, it
          // made the next start roll a good update back and reject its version (recoverFailedReexec).
          if (markerFile && ownMarker(readMarker(markerFile))) removeMarker(markerFile)
        }
        services.stop(() => {
          stopTrimming()
          exit(code)
        })
      }
      if (reexec) reexec.settled(end)
      else end(false)
    },
    ...(reexec && markerFile ? {
      reexec: reexec.reexec,
      // The re-executed master has brought a core up: its marker has served.
      coreUp: () => removeMarker(markerFile),
    } : {}),
  }, options, { version: config.version, resume, unjudgedUpdate: unjudged })
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) onSignal(signal, () => stopAll(signal))
  if (!tookOver) {
    stopTrimming()
    exit(0)
    return supervisor
  }
  supervisor.start()
  // Not waiting on the core: a service reaches it through its socket, and retries until it answers.
  // Nor while this master is replacing itself before its first core, as it does when a re-execution
  // before it never came up and the previous bundle was put back (recoverFailedReexec): started here,
  // the services ran through the probe and were cut off by the exec, children no one reaps, or ran
  // twice once a refused probe started them again. Whoever goes on starts them: this master if it
  // carries on as itself, the new one if it does not.
  if (!reexec?.replacing()) services.start()
  return supervisor
}
