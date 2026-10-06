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
import { leanServices } from './leanServices.js'
import { platformFromEnv, type PlatformName } from './platform.js'
import { baseNode, namedNode } from './processName.js'
import type { MasterMessage } from './protocol.js'
import {
  PROBE_ANSWER, RESUME_ENV, createReexec, decodeResume, fingerprint, readMarker, recoverFailedReexec, removeMarker, runProbe, writeMarker,
} from './reexec.js'
import { SERVICE_HOSTS, ServiceSupervisor, serviceOptions, serviceProcessesEnv, serviceSpecs } from './services.js'
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
  /** The CLI entry (`cli.js`, or `src/cli.ts` under tsx): what the core runs, and what an update
   *  replaces on disk. */
  scriptPath: string
  /** What the services run instead, when it is not the CLI entry: the lean bundle the entry carries
   *  (./leanBundle.ts), so each service parses its own code and not the whole CLI's. Only ever an
   *  optimisation: a service starts from `scriptPath` whenever it cannot be used (./leanServices.ts). */
  serviceScriptPath?: string
  /** What the lean bundle's folder fingerprints to as this master starts (./leanBundle.ts
   *  `leanFingerprint`): checked before every service is started from it. */
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
}

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
    say(`${PROBE_ANSWER} · protocol ${status.protocol} · v${status.masterVersion}`)
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
  const readPid = (): number | null => {
    try { return Number.parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10) || null } catch { return null }
  }
  const options = supervisorOptions(env, config.execArgv)
  const execArgv = coreExecArgv(config.execArgv, options.heapLimitMiB)
  // Trimmed here rather than by the core: the master outlives every core, and two trimmers rewriting
  // one file in place would race.
  const stopTrimming = trimLogEvery(config.logFile)
  // The core's stamp, local time (lib/log.ts): in UTC, the master's lines sat hours away from the core's
  // lines around them in the one log they share.
  const log = (line: string) => console.log(`${ts()} ${line}`)
  // Each process exec'd through a link named after it, so Activity Monitor and `top` tell them apart.
  const node = baseNode(config.nodePath)
  const named = (name: string): string => namedNode(node, name, config.runtimeDir, { log })
  // Set by the launchd agent or systemd unit `harness service install` writes (./platform.ts).
  const platform = platformFromEnv(env)
  if (platform) log(`[harnessd] run by ${platform}, which starts this master again if it dies`)
  if (resume) log(`[harnessd] master re-executed (pid ${process.pid})${config.version ? ` · now v${config.version}` : ''}`)
  if (config.serviceScriptPath && config.serviceScriptPath !== config.scriptPath) {
    log(`[harnessd] services run from ${config.serviceScriptPath}${config.bundleFingerprint ? ', as this master does' : ''}`)
  }
  // The bundle this master's code came from, read once, as it starts; the bundle on disk is read
  // again before every core starts.
  const own = config.bundleFingerprint ?? fingerprint(config.scriptPath)
  const bundle = () => fingerprint(config.scriptPath)
  const markerFile = config.reexecMarkerFile
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  if (markerFile) {
    // A re-execution before this start that never brought a core up: back to the previous bundle,
    // which the supervisor then re-executes this master on before it starts anything.
    recoverFailedReexec({
      marker: readMarker(markerFile), pid: process.pid, alive, current: bundle,
      restoreUpdate: config.restoreUpdate, removeMarker: () => removeMarker(markerFile), log,
    })
  }
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
  const services = new ServiceSupervisor(specs, {
    spawnService: (spec, extra) => {
      const script = lean.scriptFor(spec.name)
      // One process for every service it hosts, each on its own link to the core (services/process.ts).
      const handle = coreHandle(spawn(named(`harnessd-${spec.name}`), [...coreExecArgv(config.execArgv, spec.heapLimitMiB), script, '__service', spec.services.join(',')], {
        env: { ...env, ...extra },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      }))
      lean.started(spec.name, script, handle)
      return handle
    },
    now: () => performance.now(),
    wallClock: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log,
  }, serviceOptions(env), { HARNESSD_SERVICE_TOKEN: token })
  const reexec = markerFile ? createReexec({
    own, current: bundle, nodePath: named('harnessd'), execArgv: config.execArgv, scriptPath: config.scriptPath, env, pid: process.pid,
    execve, exists: existsSync,
    probe: (args, probeEnv) => runProbe(node, args, probeEnv),
    stopChildren: (done) => services.stop(done),
    startChildren: () => services.start(),
    writeMarker: (marker) => writeMarker(markerFile, marker),
    removeMarker: () => removeMarker(markerFile),
    stopping: () => stopping,
    now: () => Date.now(),
    log,
  }) : null
  const supervisor = new Supervisor({
    spawnCore: (extra) => coreHandle(spawn(named('harnessd-core'), [...execArgv, config.scriptPath, '__run'], {
      // Told which services this master runs, so it routes to exactly those and runs the rest itself.
      env: { ...env, ...extra, HARNESSD_SERVICE_TOKEN: token, ...serviceProcessesEnv(specs) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })),
    now: () => performance.now(),
    wallClock: () => Date.now(),
    writeStatus: (status) => { if (config.statusFile) writeStatusFile(config.statusFile, { ...status, masterPid: process.pid, ...(platform ? { platform } : {}) }) },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    // On a full disk the claim fails, and the master carries on without it: it was thrown out of the
    // core's `bound` message, and took the master down.
    claimPidFile: () => {
      try { writeFileSync(config.pidFile, `${process.pid}\n`) } catch (error) { log(`[harnessd] could not write the pid file: ${(error as Error).message}`) }
    },
    releasePidFile: () => { if (readPid() === process.pid) rmSync(config.pidFile, { force: true }) },
    restoreUpdate: config.restoreUpdate,
    confirmUpdate: config.confirmUpdate,
    bundle,
    log,
    // An experiment's process, started once the core says it is on (./services.ts `onDemand`).
    want: (service) => services.want(service),
    // The services go with the master, after the core: none is left holding the core's socket.
    exit: (code) => {
      stopping = true
      reexec?.cancel()
      // A master stopped before its first core came up has not failed to come up: its own marker goes
      // with it. Left behind by a stop, a sign-out or a shutdown in the seconds after a re-execution, it
      // made the next start roll a good update back and reject its version (recoverFailedReexec).
      if (markerFile && readMarker(markerFile)?.pid === process.pid) removeMarker(markerFile)
      services.stop(() => {
        stopTrimming()
        exit(code)
      })
    },
    ...(reexec && markerFile ? {
      reexec: reexec.reexec,
      // The re-executed master has brought a core up: its marker has served.
      coreUp: () => removeMarker(markerFile),
    } : {}),
  }, options, { version: config.version, resume, unjudgedUpdate: unjudged })
  // Services stop beside the core, inside the same grace `harness stop` gives the whole daemon.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    onSignal(signal, () => {
      stopping = true
      reexec?.cancel()
      services.stop(() => {})
      supervisor.stop(signal)
    })
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

