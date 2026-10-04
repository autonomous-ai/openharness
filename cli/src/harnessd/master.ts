/**
 * `harness __harnessd`: the master process `harness start` launches (see ./supervisor.ts for what it
 * does). This file is only its wiring to the operating system: the core child, the pid file, the status
 * file, the log's size, signals.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { trimLogFile } from '../lib/log.js'
import type { MasterMessage } from './protocol.js'
import { DEFAULT_SUPERVISOR_OPTIONS, Supervisor, type CoreHandle, type SupervisorOptions, type SupervisorStatus } from './supervisor.js'

/** How often the master keeps the daemon's log under its cap. */
export const LOG_TRIM_INTERVAL_MS = 60_000

export interface MasterConfig {
  /** The node binary and flags the core runs with. */
  nodePath: string
  execArgv: string[]
  /** The CLI entry (`cli.js`, or `src/cli.ts` under tsx). */
  scriptPath: string
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
}

/** The defaults `runMaster` acts on this process with. */
export const processExit = (code: number): void => { process.exit(code) }
export const onProcessSignal = (signal: NodeJS.Signals, listener: () => void): void => { process.on(signal, listener) }

/** What a config leaves out, taken from this process. Pure: choosing a default does not act on one. */
export function masterDefaults(config: MasterConfig): Required<Pick<MasterConfig, 'env' | 'exit' | 'onSignal'>> {
  return { env: config.env ?? process.env, exit: config.exit ?? processExit, onSignal: config.onSignal ?? onProcessSignal }
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
export function writeStatusFile(file: string, status: SupervisorStatus & { masterPid: number }): void {
  const temp = `${file}.${status.masterPid}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(status)}\n`)
    renameSync(temp, file)
  } catch {
    // Best effort: a full disk must not stop the master from supervising.
    try { rmSync(temp, { force: true }) } catch { /* nothing more to do */ }
  }
}

export type MasterStatusFile = SupervisorStatus & { masterPid: number }

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
    send: (message: MasterMessage) => { try { child.send(message) } catch { /* the core is going */ } },
    kill: (signal) => { try { child.kill(signal) } catch { /* already gone */ } },
    onMessage: (listener) => { child.on('message', listener) },
    onExit: (listener) => { exits.push(listener) },
  }
}

export function runMaster(config: MasterConfig): Supervisor {
  const { env, exit, onSignal } = masterDefaults(config)
  process.title = 'harnessd'
  const readPid = (): number | null => {
    try { return Number.parseInt(readFileSync(config.pidFile, 'utf8').trim(), 10) || null } catch { return null }
  }
  const options = supervisorOptions(env, config.execArgv)
  const execArgv = coreExecArgv(config.execArgv, options.heapLimitMiB)
  // Trimmed here rather than by the core: the master outlives every core, and two trimmers rewriting
  // one file in place would race.
  const stopTrimming = trimLogEvery(config.logFile)
  const supervisor = new Supervisor({
    spawnCore: (extra) => coreHandle(spawn(config.nodePath, [...execArgv, config.scriptPath, '__run'], {
      env: { ...env, ...extra },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })),
    now: () => performance.now(),
    wallClock: () => Date.now(),
    writeStatus: (status) => { if (config.statusFile) writeStatusFile(config.statusFile, { ...status, masterPid: process.pid }) },
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    claimPidFile: () => writeFileSync(config.pidFile, `${process.pid}\n`),
    releasePidFile: () => { if (readPid() === process.pid) rmSync(config.pidFile, { force: true }) },
    restoreUpdate: config.restoreUpdate,
    confirmUpdate: config.confirmUpdate,
    log: (line) => console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 23)} ${line}`),
    exit: (code) => {
      stopTrimming()
      exit(code)
    },
  }, options)
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) onSignal(signal, () => supervisor.stop(signal))
  supervisor.start()
  return supervisor
}

