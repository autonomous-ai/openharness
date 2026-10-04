/**
 * `harness __harnessd`: the master process `harness start` launches (see ./supervisor.ts for what it
 * does). This file is only its wiring to the operating system: the core child, the pid file, signals.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { MasterMessage } from './protocol.js'
import { DEFAULT_SUPERVISOR_OPTIONS, Supervisor, type CoreHandle, type SupervisorOptions } from './supervisor.js'

export interface MasterConfig {
  /** The node binary and flags the core runs with. */
  nodePath: string
  execArgv: string[]
  /** The CLI entry (`cli.js`, or `src/cli.ts` under tsx). */
  scriptPath: string
  pidFile: string
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

/** Supervisor timings from the environment, for tests; anything unset or invalid keeps its default. */
export function supervisorOptions(env: NodeJS.ProcessEnv): SupervisorOptions {
  const read = (name: string, fallback: number, min: number): number => {
    const value = Number(env[name])
    return env[name] !== undefined && Number.isFinite(value) && value >= min ? value : fallback
  }
  const d = DEFAULT_SUPERVISOR_OPTIONS
  return {
    bindTimeoutMs: read('HARNESSD_BIND_TIMEOUT_MS', d.bindTimeoutMs, 1),
    heartbeatTimeoutMs: read('HARNESSD_HEARTBEAT_TIMEOUT_MS', d.heartbeatTimeoutMs, 1),
    stopGraceMs: read('HARNESSD_STOP_GRACE_MS', d.stopGraceMs, 1),
    initialBackoffMs: read('HARNESSD_INITIAL_BACKOFF_MS', d.initialBackoffMs, 0),
    maxBackoffMs: read('HARNESSD_MAX_BACKOFF_MS', d.maxBackoffMs, 0),
    backoffResetMs: read('HARNESSD_BACKOFF_RESET_MS', d.backoffResetMs, 0),
    rssLimitMiB: read('HARNESSD_RSS_LIMIT_MIB', d.rssLimitMiB, 0),
    updateProbationMs: read('HARNESSD_UPDATE_PROBATION_MS', d.updateProbationMs, 0),
  }
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
  const supervisor = new Supervisor({
    spawnCore: (extra) => coreHandle(spawn(config.nodePath, [...config.execArgv, config.scriptPath, '__run'], {
      env: { ...env, ...extra },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })),
    now: () => Date.now(),
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    claimPidFile: () => writeFileSync(config.pidFile, `${process.pid}\n`),
    releasePidFile: () => { if (readPid() === process.pid) rmSync(config.pidFile, { force: true }) },
    restoreUpdate: config.restoreUpdate,
    confirmUpdate: config.confirmUpdate,
    log: (line) => console.log(`${new Date().toISOString().replace('T', ' ').slice(0, 23)} ${line}`),
    exit,
  }, supervisorOptions(env))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) onSignal(signal, () => supervisor.stop(signal))
  supervisor.start()
  return supervisor
}

