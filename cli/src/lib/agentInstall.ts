/**
 * Installing one agent on this machine, for a pane whose agent is missing (`harness agents install
 * <agent> --pane`, run by the pane's install-if-missing script) and for the background install the
 * desktop starts on a new user's first run (`harness agents install-missing`, agentInstallMissing.ts).
 * One implementation for both, so the lock and the installer's handling cannot disagree.
 *
 * ## One lock for every agent install
 *
 * Every install on this machine holds `agentInstallLockDir()` (ownedLock.ts, the daemon spawn lock's
 * mechanics: an O_EXCL owner record with the holder's pid and start marker; stale when that process
 * is gone; an ownerless one debris after a few seconds). One lock, not one per agent: Claude Code,
 * Codex and pi all install with `npm install -g` into the same `~/.local` prefix, and two npm installs
 * into one prefix at once can leave it half written whichever packages they are. A desktop that is
 * installing OpenCode in the background when the first harness is created makes that harness wait for
 * it rather than run a second installer beside it; then the agent is looked for again, since the
 * install it waited for may have been its own.
 *
 * The wait says so, and again every fifteen seconds; Ctrl-C ends it (130), and past
 * `AGENT_INSTALL_WAIT_MS` it ends with a line saying why (75), never with a second install.
 *
 * ## The installer is a child, in a group of its own
 *
 * The recipe's line runs as `/bin/sh -c` in a process group of its own, so that the whole of a
 * `curl … | bash` can be stopped: on Ctrl-C or SIGTERM (passed on to it), at a time limit, and when
 * this process exits. Its output goes straight to the pane, or line by line to the log.
 *
 * A recipe with a `fallback` (OpenCode: its native installer, then the npm package) runs its first
 * line with a private TMPDIR, where OpenCode's installer downloads and unpacks, and stops it after
 * `AGENT_INSTALL_STALL_MS` without a byte written there: a download from GitHub Releases that was
 * accepted and then stalled has no time limit of its own in the vendor's script (a network in Vietnam
 * could not reach GitHub at all on 2026-10-08, the reason for the fallback). A fixed limit on the whole
 * install would stop a healthy slow one instead: OpenCode's download is 43 to 58 MiB (v1.18.35), three
 * to four minutes at 2 Mbit/s. The fallback runs when the first line left no executable, and never
 * after one the person ended with Ctrl-C (130).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { constants as osConstants, homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { env } from '../config/env.js'
import { baseNode } from '../harnessd/baseNode.js'
import { engineInstallName, engineInstallPaths, npmEnginePrefix, type EngineInstallRecipe } from './engineInstall.js'
import { ownedLock, type OwnedLock, type OwnedLockRecord } from './ownedLock.js'

/** How long an install waits for another one to finish: OpenCode stalled out (a minute) and then
 *  its npm package at 2 Mbit/s (about four), with a margin. */
export const AGENT_INSTALL_WAIT_MS = 300_000
/** A first install line with a fallback that writes nothing for this long has stalled. */
export const AGENT_INSTALL_STALL_MS = 60_000
/** What an install's exit code says when it waited out another install without starting its own. */
export const AGENT_INSTALL_BUSY_EXIT = 75

const PROGRESS_EVERY_MS = 15_000
const POLL_MS = 250
/** A lock directory with no owner record this long after it was made is debris (ownedLock.ts). */
const OWNERLESS_STALE_MS = 5_000
const KILL_GRACE_MS = 5_000

/** The one lock every agent install on this machine holds: product-root state, shared by every daemon. */
export function agentInstallLockDir(): string {
  return join(homedir(), '.harness', 'run', 'agent-install.lock')
}

/** The installs' log, in the configured logs folder, the one bug reports read. */
export function agentInstallLogFile(): string {
  return join(env.HARNESS_LOGS_DIR, 'agent-install.log')
}

function installLock(): OwnedLock {
  const dir = agentInstallLockDir()
  return ownedLock({ dir, parent: dirname(dir), label: 'agent install lock', ownerlessStaleMs: OWNERLESS_STALE_MS })
}

export type InstallMode = 'pane' | 'background'

export type AgentInstallOutcome = 'installed' | 'found' | 'failed' | 'busy' | 'interrupted'

export interface AgentInstallReport {
  readonly outcome: AgentInstallOutcome
  /** The executable, when this process could resolve it. */
  readonly path?: string
  readonly reason?: string
  /** The exit status of the last install line that ran. */
  readonly status?: number
}

/** The command's exit code for a report: what the pane's script reads. */
export function agentInstallExitCode(report: AgentInstallReport): number {
  switch (report.outcome) {
    case 'installed': case 'found': return 0
    case 'interrupted': return 130
    case 'busy': return AGENT_INSTALL_BUSY_EXIT
    case 'failed': return report.status && report.status > 0 && report.status !== AGENT_INSTALL_BUSY_EXIT && report.status !== 130 ? report.status : 1
  }
}

/** What a resolve found: the executable, and the PATH it looked on (a login shell's, in the background). */
export interface AgentResolution {
  readonly path: string | null
  readonly PATH?: string
}

export interface AgentInstallOptions {
  /** The agent, for the lock's record and the lines. */
  readonly engine: string
  readonly recipe: EngineInstallRecipe
  /** The command a launch runs (`engineBin`), looked for first. */
  readonly command: string
  readonly mode: InstallMode
  /** One `harness:` line for the person or the log. */
  readonly say: (line: string) => void
  /** The installer's own output: the pane's terminal, or line by line. */
  readonly output: 'inherit' | ((line: string) => void)
  /** Ctrl-C or SIGTERM: the wait ends, or the installer is stopped. */
  readonly signal?: AbortSignal
  /** How the agent is looked for once the lock is held; this process's PATH and the install paths by default. */
  readonly resolve?: () => Promise<AgentResolution>
  readonly runtimeNode?: string
  readonly waitMs?: number
  readonly stallMs?: number
  /** For each install line; none in a pane, where a person can stop it. */
  readonly timeoutMs?: number
}

// ── finding the agent ───────────────────────────────────────────────────────────────────────────

function executableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** [command] and the recipe's executables on [PATH], then at the recipe's own install paths. */
export function resolveAgentFast(command: string, recipe: EngineInstallRecipe, PATH: string | undefined = process.env.PATH): string | null {
  const names = [command, ...recipe.executable.names].filter(Boolean)
  for (const name of names) {
    if (name.includes('/')) {
      if (executableFile(name)) return name
      continue
    }
    for (const dir of (PATH ?? '').split(delimiter)) {
      if (dir && executableFile(join(dir, name))) return join(dir, name)
    }
  }
  return engineInstallPaths(recipe).find(executableFile) ?? null
}

/** Whether [name] is an executable on [PATH]. */
function onPath(name: string, PATH: string | undefined): boolean {
  return (PATH ?? '').split(delimiter).some((dir) => dir && executableFile(join(dir, name)))
}

/**
 * The environment an install line runs with: npm pointed at `~/.local` (both spellings, for the
 * install only: the person's .npmrc is not rewritten), and the managed Node at the end of PATH when
 * there is no npm on it, as the pane's `npmRuntimePrelude` does.
 */
function installEnvironment(recipe: EngineInstallRecipe, PATH: string | undefined, runtimeNode: string | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, ...(PATH ? { PATH } : {}) }
  if (!recipe.executable.npmGlobal) return environment
  environment.npm_config_prefix = npmEnginePrefix()
  environment.NPM_CONFIG_PREFIX = npmEnginePrefix()
  if (!onPath('npm', environment.PATH) || !onPath('node', environment.PATH)) {
    for (const node of [runtimeNode, baseNode(process.execPath)]) {
      if (!node) continue
      const bin = dirname(node)
      if (executableFile(join(bin, 'node')) && executableFile(join(bin, 'npm'))) {
        environment.PATH = `${bin}${environment.PATH ? `${delimiter}${environment.PATH}` : ''}`
        break
      }
    }
  }
  return environment
}

// ── the lock ────────────────────────────────────────────────────────────────────────────────────

type LockTake =
  | { readonly kind: 'held'; readonly release: () => void; readonly waited: boolean }
  | { readonly kind: 'busy'; readonly owner: OwnedLockRecord | null }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'unsafe'; readonly reason: string }

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(done, ms)
  function done(): void {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  signal?.addEventListener('abort', done, { once: true })
})

/**
 * Take the install lock for [fields], waiting up to [waitMs] for a live holder. [onWaiting] fires once,
 * the first time a holder is seen, and [onStillWaiting] every fifteen seconds after.
 */
async function takeInstallLock(
  fields: Record<string, unknown>,
  opts: { waitMs: number; signal?: AbortSignal; onWaiting: (owner: OwnedLockRecord) => void; onStillWaiting: (seconds: number) => void },
): Promise<LockTake> {
  const lock = installLock()
  const started = Date.now()
  let announced = false
  let nextProgress = PROGRESS_EVERY_MS
  for (;;) {
    if (opts.signal?.aborted) return { kind: 'interrupted' }
    let token: string | null
    let owner: OwnedLockRecord | null
    try {
      token = lock.tryCreate(fields)
      owner = token ? null : lock.read()
    } catch (error) {
      return { kind: 'unsafe', reason: (error as Error).message }
    }
    if (token) {
      const mine = token
      const release = (): void => {
        process.off('exit', release)
        lock.releaseOwnedBy(mine)
      }
      // An install that ends in an exception still lets go: `exit` runs on the way out of anything but SIGKILL.
      process.once('exit', release)
      return { kind: 'held', release, waited: announced }
    }
    if (owner ? lock.reclaimIfStale(owner) : lock.reclaimIfOwnerless()) continue
    const waited = Date.now() - started
    if (owner && !announced) {
      announced = true
      opts.onWaiting(owner)
    }
    if (announced && waited >= nextProgress) {
      opts.onStillWaiting(Math.round(waited / 1000))
      nextProgress += PROGRESS_EVERY_MS
    }
    if (waited >= opts.waitMs) return { kind: 'busy', owner }
    await sleep(POLL_MS, opts.signal)
  }
}

// ── the installer ───────────────────────────────────────────────────────────────────────────────

interface LineRun {
  /** Its exit status; 128 + the signal for one killed by a signal. */
  readonly status: number
  /** Why this process stopped it, if it did. */
  readonly stopped: 'stall' | 'signal' | 'timeout' | null
}

/** The bytes and entries under [dir]: what a download or an unpacking adds to as it goes. */
function sizeOf(dir: string): number {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    try { total += 1 + (entry.isDirectory() ? sizeOf(path) : lstatSync(path).size) } catch { /* gone meanwhile */ }
  }
  return total
}

/** Run [line] as `/bin/sh -c` in a process group of its own; see the header for when it is stopped. */
async function runInstallLine(line: string, opts: {
  env: NodeJS.ProcessEnv
  output: AgentInstallOptions['output']
  signal?: AbortSignal
  stallMs?: number
  timeoutMs?: number
  say: (line: string) => void
}): Promise<LineRun> {
  const scratch = opts.stallMs ? mkdtempSync(join(tmpdir(), 'harness-install-')) : null
  const env = scratch ? { ...opts.env, TMPDIR: scratch } : opts.env
  let child: ChildProcess
  try {
    child = spawn('/bin/sh', ['-c', line], {
      detached: true,
      env,
      stdio: opts.output === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
    opts.say(`harness: could not start the install: ${(error as Error).message}`)
    return { status: 127, stopped: null }
  }
  const group = (signal: NodeJS.Signals): void => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch { /* gone */ }
  }
  let stopped: LineRun['stopped'] = null
  let killTimer: NodeJS.Timeout | undefined
  const stop = (why: NonNullable<LineRun['stopped']>, signal: NodeJS.Signals = 'SIGTERM'): void => {
    if (stopped) return
    stopped = why
    group(signal)
    killTimer = setTimeout(() => group('SIGKILL'), KILL_GRACE_MS)
  }
  // This process going for any reason takes the installer with it, rather than leave it writing
  // into a prefix whose lock is about to be let go.
  const onExit = (): void => group('SIGKILL')
  process.on('exit', onExit)
  const onAbort = (): void => stop('signal', (opts.signal?.reason as NodeJS.Signals) ?? 'SIGTERM')
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  if (opts.signal?.aborted) onAbort()
  const limit = opts.timeoutMs ? setTimeout(() => stop('timeout'), opts.timeoutMs) : undefined
  let watch: NodeJS.Timeout | undefined
  if (scratch && opts.stallMs) {
    let size = -1
    let quietSince = Date.now()
    const stallMs = opts.stallMs
    watch = setInterval(() => {
      let now = size
      try { now = sizeOf(scratch) } catch { /* unreadable: no progress */ }
      if (now !== size) {
        size = now
        quietSince = Date.now()
      } else if (Date.now() - quietSince >= stallMs) {
        opts.say(`harness: that install made no progress for ${Math.round(stallMs / 1000)}s, so it was stopped`)
        stop('stall')
      }
    }, Math.min(1_000, stallMs))
  }
  const lines = typeof opts.output === 'function' ? opts.output : null
  const streams = lines ? [child.stdout, child.stderr].filter((stream) => stream !== null) : []
  const closed = Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (text) => { if (text.trim()) lines!(text) }).on('close', resolve)
  })))
  const status = await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      opts.say(`harness: could not start the install: ${error.message}`)
      resolve(127)
    })
    child.once('exit', (code, signal) => resolve(code ?? 128 + (signal ? osConstants.signals[signal] ?? 1 : 1)))
  })
  clearTimeout(limit)
  clearTimeout(killTimer)
  clearInterval(watch)
  opts.signal?.removeEventListener('abort', onAbort)
  process.off('exit', onExit)
  // Whatever of a stopped install is still running, or held the output open, goes now.
  if (stopped) group('SIGKILL')
  await Promise.race([closed, sleep(1_000)])
  for (const stream of streams) stream.destroy()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  return { status, stopped }
}

// ── one install ─────────────────────────────────────────────────────────────────────────────────

/** Install [opts.engine] unless it is there once the lock is held. Never throws for the install itself. */
export async function installAgent(opts: AgentInstallOptions): Promise<AgentInstallReport> {
  const { recipe, say, mode } = opts
  const pane = mode === 'pane'
  const name = engineInstallName(recipe)
  const waitMs = opts.waitMs ?? AGENT_INSTALL_WAIT_MS
  const holderName = (owner: OwnedLockRecord | null): string => {
    const recorded = owner?.fields.name
    return typeof recorded === 'string' && recorded ? recorded : 'Another agent'
  }
  const where = (owner: OwnedLockRecord | null): string => owner?.fields.purpose === 'background' ? 'in the background' : 'in another terminal'
  const take = await takeInstallLock({ purpose: mode, engine: opts.engine, name }, {
    waitMs,
    signal: opts.signal,
    onWaiting: (owner) => {
      const holder = holderName(owner)
      const stopHint = pane ? ' (Ctrl-C stops waiting)' : ''
      say(holder === name
        ? `harness: ${name} is already installing ${where(owner)} — waiting for it${stopHint}`
        : `harness: ${holder} is installing ${where(owner)}; ${name} installs after it — waiting${stopHint}`)
    },
    onStillWaiting: (seconds) => say(`harness: still waiting for that install (${seconds}s)`),
  })
  if (take.kind === 'interrupted') {
    say(`harness: stopped waiting, so ${pane ? 'the agent was not started' : `${name} was not installed`}.`)
    return { outcome: 'interrupted', reason: 'interrupted' }
  }
  if (take.kind === 'unsafe') {
    say(`harness: ${take.reason}`)
    return { outcome: 'failed', reason: take.reason }
  }
  if (take.kind === 'busy') {
    const holder = holderName(take.owner)
    const reason = `${holder} was still installing ${where(take.owner)} after ${Math.round(waitMs / 1000)}s`
    const log = take.owner?.fields.purpose === 'background' ? ` (${agentInstallLogFile()})` : ''
    say(pane
      ? `harness: ${reason}, so this agent was not started. Create it again once that install finishes${log}.`
      : `harness: ${reason}; ${name} was not installed`)
    return { outcome: 'busy', reason }
  }
  try {
    // Looked for again with the lock held: the install it waited for may have been this agent's.
    const again: AgentResolution = await (opts.resolve ?? (async () => ({ path: resolveAgentFast(opts.command, recipe) })))()
    if (again.path) {
      if (take.waited) say(`harness: ${name} is installed`)
      return { outcome: 'found', path: again.path }
    }
    const env = installEnvironment(recipe, again.PATH, opts.runtimeNode)
    if (recipe.executable.npmGlobal && !onPath('npm', env.PATH)) {
      say('harness: npm is unavailable and the managed Node.js/npm runtime could not be used.')
      return { outcome: 'failed', reason: 'npm is unavailable', status: 1 }
    }
    say(pane ? 'harness: engine is missing — installing it in this terminal' : `harness: ${name} is missing — installing it in the background`)
    say(`harness: $ ${recipe.command}`)
    say('')
    if (recipe.executable.npmGlobal) say(`harness: installing for this user in ${npmEnginePrefix()}`)
    const line = (text: string, stallMs?: number) => runInstallLine(text, {
      env, output: opts.output, signal: opts.signal, stallMs, timeoutMs: opts.timeoutMs, say,
    })
    let run = await line(recipe.command, recipe.fallback ? opts.stallMs ?? AGENT_INSTALL_STALL_MS : undefined)
    const found = (): string | null => resolveAgentFast(opts.command, recipe, env.PATH)
    if (run.stopped === 'signal') {
      say(`harness: the install was stopped, so ${pane ? 'the agent was not started' : `${name} was not installed`}.`)
      return { outcome: 'interrupted', reason: 'interrupted', status: 130 }
    }
    // `curl … | bash` exits 0 when curl itself fails (bash ran an empty script), so the fallback is
    // decided by whether an executable exists afterwards, not by the first line's status; and never
    // after an install the person ended with Ctrl-C.
    if (recipe.fallback && run.stopped !== 'timeout' && run.status !== 130 && !found()) {
      say('')
      say('harness: that install did not finish; trying the npm package instead')
      say(`harness: $ ${recipe.fallback}`)
      say('')
      run = await line(recipe.fallback)
      if (run.stopped === 'signal') {
        say(`harness: the install was stopped, so ${pane ? 'the agent was not started' : `${name} was not installed`}.`)
        return { outcome: 'interrupted', reason: 'interrupted', status: 130 }
      }
    }
    if (run.stopped === 'timeout') {
      const reason = `timed out after ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`
      say(`harness: the ${name} install ${reason}`)
      return { outcome: 'failed', reason, status: 124 }
    }
    const path = found() ?? (opts.resolve ? (await opts.resolve()).path : null)
    if (run.status !== 0) {
      const reason = `the ${name} install failed (exit ${run.status})`
      if (!pane) say(`harness: ${reason}`)
      return { outcome: 'failed', reason, status: run.status }
    }
    if (path) return { outcome: 'installed', path, status: 0 }
    // A pane looks for it itself, with its shell's whole PATH and npm's own prefix; in the background
    // an install that leaves nothing to find is a failure.
    if (pane) return { outcome: 'installed', status: 0 }
    const reason = `the ${name} install completed, but its executable could not be found`
    say(`harness: ${reason}`)
    return { outcome: 'failed', reason, status: 0 }
  } finally {
    take.release()
  }
}
