/**
 * `harness engines install-missing`: install the default agents this computer does not have yet,
 * in the background, before anyone asks for one.
 *
 * ## Why
 *
 * A new user's first harness waited for its agent to install, in the pane: OpenCode, the default,
 * about fourteen seconds; Claude Code and Codex through npm up to a minute. The desktop now runs this
 * as soon as it opens, so by the time the first harness is created its agent is usually there and it
 * starts at once. OpenCode goes first because the first harness is an OpenCode one; then Claude Code,
 * Codex and pi, one at a time (two npm installs at once only compete for the same line).
 *
 * ## The rules it keeps
 *
 *  - **Never reinstall.** Each engine is probed exactly as the daemon probes it for the New Harness
 *    dialog (`probeEngines`: the login shell's PATH, `~/.local/bin`, `~/.opencode/bin`, the npm global
 *    prefix), and one that resolves is left alone. One whose launch path is set by hand
 *    (`OPENCODE_PATH`, …) is skipped: an install cannot fill a path somebody chose.
 *  - **The pane's install, unchanged.** Each install is the very script a pane runs when its engine is
 *    missing (`backgroundInstallArgv`): the vendor's command, the npm fallback where the recipe has one,
 *    npm pointed at `~/.local` and the managed Node when there is none, in the person's login shell so
 *    that PATH matches. The only difference is that nobody is watching: no terminal, stdin from
 *    /dev/null, output to `~/.harness/logs/engine-install.log`, and a time limit
 *    (`ENGINE_INSTALL_TIMEOUT_MS`) after which the install's whole process group is killed.
 *  - **One install of an engine at a time.** That script takes the engine's lock
 *    (`engineInstallLockPath`) while it installs, and so does a pane's; whichever comes second waits
 *    for the first and then finds the engine there. A first harness created while this is still
 *    installing OpenCode therefore waits for it instead of running a second installer beside it.
 *  - **One run at a time.** The whole run holds `install-missing.lock`; a second one started while it
 *    goes (the desktop opened twice, a quit and reopen) says `busy` and exits at once.
 *  - **It outlives the app.** `--background` starts it detached, in a session of its own, and returns.
 *
 * Every lock is an atomic `mkdir` with the holder's pid inside; one whose pid is gone is stale and is
 * taken over, so an install killed with the machine never holds anything for good.
 *
 * ## What it reports
 *
 * One JSON line per engine on stdout and in the log: `{"engine":"opencode","status":"installed",
 * "path":"…","seconds":14.2}`, the status one of `already-installed`, `installed`, `failed` (with a
 * `reason`) or `skipped` (with a `reason`). The same state is kept in `status.json` beside the locks,
 * rewritten as each engine starts and ends, for the desktop to read whenever it likes.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { constants, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEngine, ProcessEngine } from '../engines/types.js'
import { engineBin, enginePathOverride } from './engineBin.js'
import {
  ENGINE_INSTALL,
  ENGINE_INSTALL_TIMEOUT_MS,
  engineInstallLockDir,
  engineInstallLockPath,
  type EngineInstallRecipe,
} from './engineInstall.js'
import { BACKGROUND_INSTALL_BIN_MARK, backgroundInstallArgv } from './engineLaunch.js'
import { probeEngines, type EngineAvailability } from './engineProbe.js'
import { trimLogFile, ts } from './log.js'

/** The engines installed ahead of time, in order: OpenCode first, as the default agent. */
export const WARMUP_ENGINES: readonly ProcessEngine[] = ['opencode', 'claude', 'codex', 'pi']

export type WarmupStatus = 'already-installed' | 'installed' | 'failed' | 'skipped'

/** One engine's line of the summary. */
export interface WarmupResult {
  readonly engine: ProcessEngine
  readonly status: WarmupStatus
  /** Why it failed or was skipped. */
  readonly reason?: string
  /** The executable an install left, as the install's own script resolved it. */
  readonly path?: string
  /** How long the install took. */
  readonly seconds?: number
}

export type WarmupOutcome =
  | { readonly busy: true; readonly pid: number | null }
  | { readonly busy: false; readonly results: readonly WarmupResult[]; readonly interrupted: boolean }

export interface WarmupOptions {
  readonly engines?: readonly ProcessEngine[]
  /** The recipe each engine installs with; `ENGINE_INSTALL` unless a test gives its own. */
  readonly recipes?: Partial<Record<ProcessEngine, EngineInstallRecipe>>
  /** Which engines are there already; `probeEngines`, the daemon's own probe, unless a test gives one. */
  readonly probe?: (engines: readonly AgentEngine[]) => Promise<EngineAvailability[]>
  /** The login shell to install through; the person's own (`SHELL`) when absent. */
  readonly shell?: string
  readonly runtimeNode?: string
  /** Per engine. */
  readonly timeoutMs?: number
  /** How long a timed-out install has to end on SIGTERM before its group is sent SIGKILL. */
  readonly killGraceMs?: number
  readonly logFile?: string
  readonly statusFile?: string
  /** Where the summary's JSON lines go; stdout unless a test collects them. */
  readonly emit?: (line: string) => void
  /** Aborted by a signal: the install running is killed, the rest are not started. */
  readonly signal?: AbortSignal
}

/** Read and sent with a bug report, beside the desktop's own logs (`HARNESS_LOGS_DIR`). */
export function engineInstallLogFile(): string {
  return join(process.env.HARNESS_LOGS_DIR || join(homedir(), '.harness', 'logs'), 'engine-install.log')
}

/** The last run's state, per engine, for the desktop to show. */
export function engineInstallStatusFile(): string {
  return join(engineInstallLockDir(), 'status.json')
}

/** Held for a whole run, so that a second one exits at once. */
export function warmupLockPath(): string {
  return join(engineInstallLockDir(), 'install-missing.lock')
}

/** A run that installs nothing writes four lines; this keeps a year of app starts without growing. */
const LOG_MAX_BYTES = 1024 * 1024

/** A lock folder with no pid this long after it was made is a holder that died before writing one. */
const UNCLAIMED_STALE_MS = 10_000

const DEFAULT_KILL_GRACE_MS = 5_000

// ── locks ──────────────────────────────────────────────────────────────────────────────────────

type LockState = { readonly state: 'free' } | { readonly state: 'held'; readonly pid: number | null } | { readonly state: 'stale' }

/** Whether `pid` is running. EPERM is a process of another user's, alive all the same. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Who holds the lock at [lock]: the same reading as the shell's `harness_lock_take` in
 * engineLaunch.ts, since a pane and this run take each other's locks.
 */
export function inspectLock(lock: string, now: number = Date.now()): LockState {
  let made: number
  try { made = statSync(lock).mtimeMs } catch { return { state: 'free' } }
  let text = ''
  try { text = readFileSync(join(lock, 'pid'), 'utf8').trim() } catch { /* not written yet */ }
  if (!text) return now - made < UNCLAIMED_STALE_MS ? { state: 'held', pid: null } : { state: 'stale' }
  if (!/^[1-9][0-9]*$/.test(text)) return { state: 'stale' }
  const pid = Number(text)
  return pidAlive(pid) ? { state: 'held', pid } : { state: 'stale' }
}

type LockTake = { readonly taken: true } | { readonly taken: false; readonly pid: number | null } | { readonly taken: false; readonly unavailable: true }

/** Take [lock] for [pid], taking over a stale one. Never waits. */
export function takeLock(lock: string, pid: number = process.pid): LockTake {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dirname(lock), { recursive: true })
      mkdirSync(lock)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return { taken: false, unavailable: true }
      const holder = inspectLock(lock)
      if (holder.state === 'held') return { taken: false, pid: holder.pid }
      // Stale, or let go between the mkdir and the look: clear it and try again.
      rmSync(lock, { recursive: true, force: true })
      continue
    }
    try { writeFileSync(join(lock, 'pid'), `${pid}\n`) } catch { /* a lock with no pid goes stale on its own */ }
    return { taken: true }
  }
  return { taken: false, unavailable: true }
}

/** Let go of [lock] if [pid] holds it. A lock taken over from [pid] as stale is the new holder's. */
export function releaseLock(lock: string, pid: number): void {
  let text = ''
  try { text = readFileSync(join(lock, 'pid'), 'utf8').trim() } catch { /* absent, or never written */ }
  if (text && text !== String(pid)) return
  try { rmSync(lock, { recursive: true, force: true }) } catch { /* already gone */ }
}

// ── log and status ─────────────────────────────────────────────────────────────────────────────

interface Log {
  line(engine: string, text: string): void
  close(): void
}

/** Appends `<local time> [<engine>] <text>`, one line each. A log that cannot be written is no reason not to install. */
function openLog(file: string): Log {
  let fd: number | null = null
  try {
    mkdirSync(dirname(file), { recursive: true })
    trimLogFile(file, LOG_MAX_BYTES)
    fd = openSync(file, 'a')
  } catch { /* no log */ }
  return {
    line(engine, text) {
      if (fd === null) return
      try { writeSync(fd, `${ts()} [${engine}] ${text}\n`) } catch { /* disk full: go on */ }
    },
    close() {
      if (fd !== null) try { closeSync(fd) } catch { /* closed */ }
      fd = null
    },
  }
}

interface StatusEntry {
  readonly status: WarmupStatus | 'installing' | 'waiting'
  readonly reason?: string
  readonly path?: string
  readonly at: string
}

/** `status.json`, written whole and renamed into place, so a reader never sees half of it. */
class StatusRecord {
  private readonly engines: Record<string, StatusEntry> = {}
  private readonly startedAt = new Date().toISOString()
  private finishedAt: string | null = null

  constructor(private readonly file: string, engines: readonly ProcessEngine[]) {
    for (const engine of engines) this.engines[engine] = { status: 'waiting', at: this.startedAt }
    this.write()
  }

  set(engine: ProcessEngine, entry: Omit<StatusEntry, 'at'>): void {
    this.engines[engine] = { ...entry, at: new Date().toISOString() }
    this.write()
  }

  finish(): void {
    this.finishedAt = new Date().toISOString()
    this.write()
  }

  private write(): void {
    const body = JSON.stringify({ pid: process.pid, startedAt: this.startedAt, finishedAt: this.finishedAt, engines: this.engines }, null, 2)
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temp, `${body}\n`)
      renameSync(temp, this.file)
    } catch {
      try { rmSync(temp, { force: true }) } catch { /* never made */ }
    }
  }
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

/** SIGTERM, then SIGKILL, to the install's whole process group: `curl | bash` and npm's children too. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try { process.kill(-child.pid, signal) } catch {
    try { child.kill(signal) } catch { /* gone */ }
  }
}

interface InstallContext {
  readonly log: Log
  readonly shell?: string
  readonly runtimeNode?: string
  readonly timeoutMs: number
  readonly killGraceMs: number
  readonly signal?: AbortSignal
}

/** Run one engine's install script to its end, or to its time limit. */
async function installOne(engine: ProcessEngine, recipe: EngineInstallRecipe, context: InstallContext): Promise<WarmupResult> {
  const { log } = context
  const started = Date.now()
  log.line(engine, 'missing; installing')
  const argv = backgroundInstallArgv(engineBin(engine), recipe, context.shell, context.runtimeNode)
  // Detached: a process group of its own, which a time limit kills whole, and a session of its own,
  // so no terminal: the installer can never stop to ask anything.
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let path: string | undefined
  let said: string | undefined
  const onLine = (line: string): void => {
    if (line.startsWith(BACKGROUND_INSTALL_BIN_MARK)) path = line.slice(BACKGROUND_INSTALL_BIN_MARK.length).trim() || undefined
    else if (line.startsWith('harness: ')) said = line.slice('harness: '.length)
    if (line.trim()) log.line(engine, line)
  }
  const streams = [child.stdout, child.stderr].filter((stream) => stream !== null)
  const closed = Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', onLine).on('close', resolve)
  })))

  let ended: 'timeout' | 'interrupted' | null = null
  let killTimer: NodeJS.Timeout | undefined
  const end = (why: 'timeout' | 'interrupted'): void => {
    if (ended) return
    ended = why
    killGroup(child, 'SIGTERM')
    killTimer = setTimeout(() => killGroup(child, 'SIGKILL'), context.killGraceMs)
  }
  const limit = setTimeout(() => end('timeout'), context.timeoutMs)
  const onAbort = (): void => end('interrupted')
  context.signal?.addEventListener('abort', onAbort, { once: true })
  if (context.signal?.aborted) onAbort()

  const code = await new Promise<number | null>((resolve) => {
    child.once('error', (error) => { said = `could not start ${argv[0]}: ${error.message}`; resolve(null) })
    child.once('exit', (status) => resolve(status))
  })
  clearTimeout(limit)
  clearTimeout(killTimer)
  context.signal?.removeEventListener('abort', onAbort)
  // A killed install's helpers may outlive its shell, holding the output open: end them all.
  if (ended) killGroup(child, 'SIGKILL')
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000).unref())])
  for (const stream of streams) stream.destroy()
  // The script let go of the lock itself unless it was killed; then the lock names its dead shell,
  // and a pane would wait ten seconds to find that out.
  if (child.pid) releaseLock(engineInstallLockPath(recipe), child.pid)

  const seconds = Math.round((Date.now() - started) / 100) / 10
  if (ended === 'timeout') return { engine, status: 'failed', reason: `timed out after ${Math.round(context.timeoutMs / 1000)}s`, seconds }
  if (ended === 'interrupted') return { engine, status: 'failed', reason: 'interrupted', seconds }
  if (code === 0 && path) return { engine, status: 'installed', path, seconds }
  return { engine, status: 'failed', reason: said ?? (code === null ? 'the install did not run' : `the install exited ${code}`), seconds }
}

/** Why an engine that is not there cannot be installed here (`probeEngines`' `installable`). */
function skipReason(engine: ProcessEngine): string {
  const override = enginePathOverride(engine)
  return override
    ? `its launch path is set by hand (${override}), which an install cannot fill`
    : 'its launch command could not be resolved'
}

/**
 * Install every engine in [WARMUP_ENGINES] this computer does not have, one at a time, OpenCode first.
 * Never throws for an engine: each one's outcome is in the results.
 */
export async function installMissingEngines(options: WarmupOptions = {}): Promise<WarmupOutcome> {
  const engines = options.engines ?? WARMUP_ENGINES
  const emit = options.emit ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const log = openLog(options.logFile ?? engineInstallLogFile())
  const lock = warmupLockPath()
  const take = takeLock(lock)
  if (!take.taken && !('unavailable' in take)) {
    log.line('install-missing', `another run is installing (pid ${take.pid ?? 'starting'}); this one ends`)
    emit(JSON.stringify({ status: 'busy', pid: take.pid }))
    log.close()
    return { busy: true, pid: take.pid }
  }
  // Without a lock folder at all (a home that cannot be written) installing may still work; a second
  // run beside this one would then find each engine's lock, or no lock either, as the pane would.
  if (!take.taken) log.line('install-missing', `could not take ${lock}; going on without it`)
  const release = (): void => { if (take.taken) releaseLock(lock, process.pid) }
  // A run that ends in an exception still lets go: `exit` runs on the way out of anything but SIGKILL.
  process.once('exit', release)
  const status = new StatusRecord(options.statusFile ?? engineInstallStatusFile(), engines)
  const results: WarmupResult[] = []
  const record = (result: WarmupResult): void => {
    results.push(result)
    status.set(result.engine, { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.path ? { path: result.path } : {}) })
    const line = JSON.stringify(result)
    log.line('summary', line)
    emit(line)
  }
  try {
    log.line('install-missing', `checking ${engines.join(', ')}`)
    const availability = await (options.probe ?? probeEngines)(engines)
    const context: InstallContext = {
      log,
      shell: options.shell,
      runtimeNode: options.runtimeNode,
      timeoutMs: options.timeoutMs ?? ENGINE_INSTALL_TIMEOUT_MS,
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      signal: options.signal,
    }
    for (const [index, engine] of engines.entries()) {
      if (options.signal?.aborted) break
      const found = availability[index]
      if (found?.installed) {
        record({ engine, status: 'already-installed' })
        continue
      }
      const recipe = options.recipes?.[engine] ?? ENGINE_INSTALL[engine]
      if (!found?.installable) {
        record({ engine, status: 'skipped', reason: skipReason(engine) })
        continue
      }
      status.set(engine, { status: 'installing' })
      record(await installOne(engine, recipe, context))
    }
  } finally {
    status.finish()
    process.off('exit', release)
    release()
    log.line('install-missing', 'done')
    log.close()
  }
  return { busy: false, results, interrupted: options.signal?.aborted ?? false }
}

export type BackgroundStart =
  | { readonly status: 'started'; readonly pid: number; readonly log: string }
  | { readonly status: 'busy'; readonly pid: number | null }
  | { readonly status: 'failed'; readonly reason: string }

/**
 * Start [argv], a foreground run of this command, detached: its own session, no terminal, stdin from
 * /dev/null and its errors to the log, so it goes on after the app that started it quits. A run
 * already going is reported and nothing is started.
 */
export function startInBackground(argv: readonly string[], logFile: string = engineInstallLogFile()): BackgroundStart {
  const holder = inspectLock(warmupLockPath())
  if (holder.state === 'held') return { status: 'busy', pid: holder.pid }
  let fd: number
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    fd = openSync(logFile, 'a')
  } catch (error) {
    return { status: 'failed', reason: `could not open ${logFile}: ${(error as Error).message}` }
  }
  try {
    // stdout is not kept: the run writes its summary to the log and status.json itself.
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { /* reported below by the missing pid */ })
    child.unref()
    return child.pid ? { status: 'started', pid: child.pid, log: logFile } : { status: 'failed', reason: `could not start ${argv[0]}` }
  } finally {
    closeSync(fd)
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * The command: `harness engines install-missing [--background]`. [self] is the argv that runs this
 * CLI (node, its flags, the script), which `--background` starts again without the flag.
 */
export async function installMissingCommand(
  options: { background: boolean; self: readonly string[] },
  output: (line: string) => void = (line) => { process.stdout.write(`${line}\n`) },
): Promise<number> {
  if (options.background) {
    const started = startInBackground([...options.self, 'engines', 'install-missing'])
    output(JSON.stringify(started))
    return started.status === 'failed' ? 1 : 0
  }
  // A signal ends the install running (its whole group) and lets go of every lock before exiting,
  // where the default action would leave both behind.
  const abort = new AbortController()
  const onSignal = (signal: NodeJS.Signals): void => abort.abort(signal)
  for (const signal of SIGNALS) process.on(signal, onSignal)
  try {
    const outcome = await installMissingEngines({ signal: abort.signal, emit: output })
    if (outcome.busy) return 0
    if (abort.signal.aborted) return 128 + (constants.signals[abort.signal.reason as NodeJS.Signals] ?? 15)
    return outcome.results.some((result) => result.status === 'failed') ? 1 : 0
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal)
  }
}
