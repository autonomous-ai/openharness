/**
 * `harness agents install-missing`: install the default agents this computer does not have yet, in
 * the background, on a new user's first run, before anyone asks for one.
 *
 * A new user's first harness waited for its agent to install, in the pane: OpenCode, the default,
 * about fourteen seconds; Claude Code and Codex through npm up to a minute. The desktop starts this
 * once Harness itself is installed (its first run only), so by the time the first harness is created
 * its agent is usually there. OpenCode goes first because the first harness is an OpenCode one.
 *
 * Each agent goes through `installAgent` (agentInstall.ts), the pane's own install: the one lock every
 * install on this machine holds, the agent looked for again once it is held, the recipe and its
 * fallback as a child in a group of its own. A pane created meanwhile waits for it.
 *
 * What it does not do:
 *  - **Reinstall.** An agent at its install paths or on this process's PATH is there. One that is not
 *    is looked for in the person's login shell (`resolveEngineInLoginShell`, bounded) once the lock is
 *    held, before anything is installed: found there, it was there all along.
 *  - **Go against the person.** An agent seen here before and gone now was removed, and is not put
 *    back; one whose install failed is not tried again for a day (`state.json`). Creating a harness of
 *    it still installs it in the pane, where the person asked for it.
 *  - **Run twice, or unlocked.** A run holds a run lock of its own (the same mechanics); one that
 *    cannot take it, held or unusable, reports `busy` and ends.
 *
 * One JSON line per agent on stdout and in the log, `agent-install.log` in the configured logs folder:
 * `{"engine":"opencode","status":"installed","path":"…","seconds":14.2}`, the status one of
 * `already-installed`, `installed`, `failed` or `skipped`, the last two with a `reason`.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProcessEngine } from '../engines/types.js'
import { agentInstallLockDir, agentInstallLogFile, installAgent, resolveAgentFast, type AgentInstallReport } from './agentInstall.js'
import { engineBin, enginePathOverride } from './engineBin.js'
import { ENGINE_INSTALL, type EngineInstallRecipe } from './engineInstall.js'
import { resolveEngineInLoginShell } from './engineLaunch.js'
import { trimLogFile, ts } from './log.js'
import { managedNodePath } from './nodeRuntime.js'
import { ownedLock, type OwnedLock } from './ownedLock.js'

/** The agents installed ahead of time, in order: OpenCode first, as the default agent. */
export const DEFAULT_AGENTS: readonly ProcessEngine[] = ['opencode', 'claude', 'codex', 'pi']

/** How long one agent's install may run with nobody watching: OpenCode's 58 MiB at 0.5 Mbit/s takes 16 minutes. */
export const BACKGROUND_INSTALL_TIMEOUT_MS = 30 * 60_000
/** A failed install is not tried again by the background for this long. */
export const RETRY_FAILED_INSTALL_MS = 24 * 60 * 60_000
/** How long the person's login shell gets to say where an agent is. */
const RESOLVE_TIMEOUT_MS = 10_000
/** A run that installs nothing writes six lines; this keeps months of them without growing. */
const LOG_MAX_BYTES = 1024 * 1024

export type InstallStatus = 'already-installed' | 'installed' | 'failed' | 'skipped'

export interface InstallResult {
  readonly engine: ProcessEngine
  readonly status: InstallStatus
  readonly reason?: string
  readonly path?: string
  readonly seconds?: number
}

export type InstallMissingOutcome =
  | { readonly busy: true; readonly pid: number | null }
  | { readonly busy: false; readonly results: readonly InstallResult[]; readonly interrupted: boolean }

export interface InstallMissingOptions {
  readonly engines?: readonly ProcessEngine[]
  /** The recipe each agent installs with; `ENGINE_INSTALL` unless a test gives its own. */
  readonly recipes?: Partial<Record<ProcessEngine, EngineInstallRecipe>>
  /** The login shell agents are looked for in; the person's own when absent. */
  readonly shell?: string
  readonly runtimeNode?: string
  readonly timeoutMs?: number
  readonly stallMs?: number
  readonly waitMs?: number
  readonly resolveTimeoutMs?: number
  readonly logFile?: string
  readonly stateFile?: string
  /** Wall clock, for the day a failed install is held back. */
  readonly now?: () => number
  /** Where the summary's JSON lines go; stdout unless a test collects them. */
  readonly emit?: (line: string) => void
  /** A signal: the install running is stopped, the rest are not started. */
  readonly signal?: AbortSignal
}

/** What every run has seen of each agent, so that none is put back or retried against the person. */
export function agentInstallStateFile(): string {
  return join(dirname(agentInstallLockDir()), 'agent-install-state.json')
}

/** Held for a whole run, so that a second one ends at once. */
export function installMissingLockDir(): string {
  return join(dirname(agentInstallLockDir()), 'agents-install-missing.lock')
}

function runLock(): OwnedLock {
  const dir = installMissingLockDir()
  return ownedLock({ dir, parent: dirname(dir), label: 'agents install-missing lock', ownerlessStaleMs: 5_000 })
}

/** The run lock for this process, or why not: a holder's pid, or null for one that cannot be read. */
function takeRunLock(): { taken: true; release: () => void } | { taken: false; pid: number | null } {
  const lock = runLock()
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string | null
    let owner
    try {
      token = lock.tryCreate({ purpose: 'install-missing' })
      owner = token ? null : lock.read()
    } catch {
      // Something at the path that is not this lock, or a folder it cannot make: never run unlocked.
      return { taken: false, pid: null }
    }
    if (token) {
      const mine = token
      const release = (): void => {
        process.off('exit', release)
        lock.releaseOwnedBy(mine)
      }
      process.once('exit', release)
      return { taken: true, release }
    }
    if (owner ? lock.reclaimIfStale(owner) : lock.reclaimIfOwnerless()) continue
    return { taken: false, pid: owner?.pid ?? null }
  }
  return { taken: false, pid: null }
}

/** Whether a run lock is held right now, by whom: for `--background`, before starting one. */
function runLockHolder(): { held: boolean; pid: number | null } {
  const lock = runLock()
  let owner
  try { owner = lock.read() } catch { return { held: true, pid: null } }
  if (owner) return lock.reclaimIfStale(owner) ? { held: false, pid: null } : { held: true, pid: owner.pid }
  if (!existsSync(lock.dir)) return { held: false, pid: null }
  return lock.reclaimIfOwnerless() ? { held: false, pid: null } : { held: true, pid: null }
}

// ── log and history ────────────────────────────────────────────────────────────────────────────

interface Log {
  line(engine: string, text: string): void
  close(): void
}

/** `<local time> [<engine>] <text>`, one line each. A log that cannot be written is no reason not to install. */
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

interface AgentHistory {
  presentAt?: string
  installedAt?: string
  failedAt?: string
  reason?: string
}

/** `state.json`: every run's memory of each agent. Unreadable reads as empty: as on a new machine. */
class History {
  private readonly agents: Record<string, AgentHistory>

  constructor(private readonly file: string, private readonly now: () => number) {
    let read: unknown = null
    try { read = JSON.parse(readFileSync(file, 'utf8')) } catch { /* none yet */ }
    const agents = (read as { agents?: unknown } | null)?.agents
    this.agents = agents && typeof agents === 'object' ? { ...(agents as Record<string, AgentHistory>) } : {}
  }

  seenAt(engine: ProcessEngine): string | null {
    return this.agents[engine]?.presentAt ?? null
  }

  /** The failure that holds [engine] back for a day, or null. */
  failedRecently(engine: ProcessEngine): string | null {
    const seen = this.agents[engine]
    const failed = seen?.failedAt ? Date.parse(seen.failedAt) : NaN
    if (!Number.isFinite(failed) || this.now() - failed >= RETRY_FAILED_INSTALL_MS) return null
    return `its install failed at ${seen!.failedAt} (${seen!.reason ?? 'no reason given'}); it is tried again a day after`
  }

  present(engine: ProcessEngine, installed: boolean): void {
    const current = this.agents[engine]
    if (!installed && current?.presentAt && !current.failedAt) return
    const at = new Date(this.now()).toISOString()
    const { failedAt: _failedAt, reason: _reason, ...seen } = current ?? {}
    this.agents[engine] = { ...seen, presentAt: seen.presentAt ?? at, ...(installed ? { installedAt: at } : {}) }
    this.write()
  }

  failed(engine: ProcessEngine, reason: string): void {
    this.agents[engine] = { ...this.agents[engine], failedAt: new Date(this.now()).toISOString(), reason }
    this.write()
  }

  private write(): void {
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temp, `${JSON.stringify({ agents: this.agents }, null, 2)}\n`)
      renameSync(temp, this.file)
    } catch {
      try { rmSync(temp, { force: true }) } catch { /* never made */ }
    }
  }
}

// ── the run ────────────────────────────────────────────────────────────────────────────────────

/**
 * Install every agent in [DEFAULT_AGENTS] this computer does not have, one at a time, OpenCode first.
 * Never throws for an agent: each one's outcome is in the results.
 */
export async function installMissingAgents(options: InstallMissingOptions = {}): Promise<InstallMissingOutcome> {
  const engines = options.engines ?? DEFAULT_AGENTS
  const emit = options.emit ?? ((line: string) => { process.stdout.write(`${line}\n`) })
  const log = openLog(options.logFile ?? agentInstallLogFile())
  const run = takeRunLock()
  if (!run.taken) {
    log.line('install-missing', `another run holds its lock (pid ${run.pid ?? 'unknown'}), or it could not be taken; this one ends`)
    emit(JSON.stringify({ status: 'busy', pid: run.pid }))
    log.close()
    return { busy: true, pid: run.pid }
  }
  const history = new History(options.stateFile ?? agentInstallStateFile(), options.now ?? Date.now)
  const results: InstallResult[] = []
  const record = (result: InstallResult): void => {
    results.push(result)
    const line = JSON.stringify(result)
    log.line('summary', line)
    emit(line)
  }
  const resolveTimeoutMs = options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS
  try {
    log.line('install-missing', `looking for ${engines.join(', ')}`)
    for (const engine of engines) {
      if (options.signal?.aborted) break
      const recipe = options.recipes?.[engine] ?? ENGINE_INSTALL[engine]
      const command = engineBin(engine)
      const override = enginePathOverride(engine)
      if (override) {
        record({ engine, status: 'skipped', reason: `its launch path is set by hand (${override}), which an install cannot fill` })
        continue
      }
      const here = resolveAgentFast(command, recipe)
      if (here) {
        history.present(engine, false)
        record({ engine, status: 'already-installed', path: here })
        continue
      }
      const held = history.failedRecently(engine)
      if (held) {
        record({ engine, status: 'skipped', reason: held })
        continue
      }
      const inShell = (): Promise<{ path: string | null; PATH?: string }> => resolveEngineInLoginShell(command, recipe, {
        shell: options.shell, timeoutMs: resolveTimeoutMs,
      }).then((found) => ({ path: found.path ?? resolveAgentFast(command, recipe, found.PATH ?? undefined), PATH: found.PATH ?? undefined }))
      const seen = history.seenAt(engine)
      if (seen) {
        // Seen here before and not at its install paths: elsewhere on the person's PATH, or removed.
        const found = await inShell()
        if (found.path) record({ engine, status: 'already-installed', path: found.path })
        else record({ engine, status: 'skipped', reason: `it was here on ${seen.slice(0, 10)} and has been removed since, so it is not put back (a new harness of it still installs it)` })
        continue
      }
      const started = Date.now()
      let report: AgentInstallReport
      try {
        report = await installAgent({
          engine,
          recipe,
          command,
          mode: 'background',
          say: (text) => { if (text.trim()) log.line(engine, text) },
          output: (text) => log.line(engine, text),
          signal: options.signal,
          resolve: inShell,
          runtimeNode: options.runtimeNode ?? managedNodePath(),
          timeoutMs: options.timeoutMs ?? BACKGROUND_INSTALL_TIMEOUT_MS,
          stallMs: options.stallMs,
          waitMs: options.waitMs,
        })
      } catch (error) {
        // One agent's install that cannot even start is that agent's failure, never the run's.
        report = { outcome: 'failed', reason: `could not start its install: ${(error as Error).message}` }
      }
      const seconds = Math.round((Date.now() - started) / 100) / 10
      switch (report.outcome) {
        case 'found':
          history.present(engine, false)
          record({ engine, status: 'already-installed', ...(report.path ? { path: report.path } : {}) })
          break
        case 'installed':
          history.present(engine, true)
          record({ engine, status: 'installed', ...(report.path ? { path: report.path } : {}), seconds })
          break
        case 'busy':
          record({ engine, status: 'skipped', reason: report.reason ?? 'another install was still running' })
          break
        case 'interrupted':
          record({ engine, status: 'failed', reason: 'interrupted', seconds })
          break
        case 'failed':
          history.failed(engine, report.reason ?? 'failed')
          record({ engine, status: 'failed', reason: report.reason ?? 'failed', seconds })
          break
      }
    }
  } finally {
    run.release()
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
export function startInBackground(argv: readonly string[], logFile: string = agentInstallLogFile()): BackgroundStart {
  const holder = runLockHolder()
  if (holder.held) return { status: 'busy', pid: holder.pid }
  let fd: number
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    fd = openSync(logFile, 'a')
  } catch (error) {
    return { status: 'failed', reason: `could not open ${logFile}: ${(error as Error).message}` }
  }
  try {
    // stdout is not kept: the run writes its summary to the log itself.
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', fd] })
    child.on('error', () => { /* reported below by the missing pid */ })
    child.unref()
    return child.pid ? { status: 'started', pid: child.pid, log: logFile } : { status: 'failed', reason: `could not start ${argv[0]}` }
  } finally {
    closeSync(fd)
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/** `harness agents install-missing [--background]`. [self] runs this CLI (node, its flags, the script). */
export async function installMissingCommand(
  options: { background: boolean; self: readonly string[] },
  output: (line: string) => void = (line) => { process.stdout.write(`${line}\n`) },
): Promise<number> {
  if (options.background) {
    const started = startInBackground([...options.self, 'agents', 'install-missing'])
    output(JSON.stringify(started))
    return started.status === 'failed' ? 1 : 0
  }
  // A signal stops the install running (its whole group) and lets go of every lock before exiting,
  // where the default action would leave both behind.
  const abort = new AbortController()
  const onSignal = (signal: NodeJS.Signals): void => abort.abort(signal)
  for (const signal of SIGNALS) process.on(signal, onSignal)
  try {
    const outcome = await installMissingAgents({ signal: abort.signal, emit: output })
    if (outcome.busy) return 0
    if (abort.signal.aborted) return 128 + (constants.signals[abort.signal.reason as NodeJS.Signals] ?? 15)
    return outcome.results.some((result) => result.status === 'failed') ? 1 : 0
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal)
  }
}
