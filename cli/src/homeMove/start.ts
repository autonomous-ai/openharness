/**
 * The move at a start (docs/plans/2026-11-18-linux-xdg-paths-design.md, When the move runs, Where the move runs, Failures
 * and state). `harness start`, `start -f`, `start --if-down` and `__harnessd` move ~/.harness to the XDG roots before
 * anything that resolves a path loads (entry.ts), then start again from the new paths: the process that moved still runs
 * the Node and cli.js it was started from, and derives paths from them.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { harnessRoot, legacyHarnessHome, xdgRoots } from '../config/harnessHome.js'
import { isBridge, procNow } from './bridge.js'
import { checkMove, withEnvFile, type ConditionDeps, type Hold } from './conditions.js'
import { readJournal } from './journal.js'
import { withMoveLock, type LockDeps } from './lock.js'
import { failed, recoverMove, runMove, type MoveDeps, type MoveOutcome } from './move.js'
import { defaultTmux } from './panes.js'
import { movedPath, type MovePlan } from './plan.js'
import { readMoveRecord, writeMoveRecord } from './record.js'

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => void
type Roots = Pick<MovePlan, 'legacy' | 'data' | 'state'>

/** What a start reads of this computer and of its own process, and what it runs. */
export interface StartDeps extends Omit<MoveDeps, 'io' | 'log'>, Pick<ConditionDeps, 'alive' | 'answers' | 'ptyHostRuns'> {
  platform: NodeJS.Platform
  home: string
  io: MoveDeps['io'] & ConditionDeps['fs']
  /** process.execve, which Node has from 22.15; without it nothing moves (conditions.ts). */
  execve: Execve | undefined
  execPath: string
  execArgv: readonly string[]
  /** Prints a line on this start's terminal; null when its output is not one. */
  print: ((line: string) => void) | null
  /** Ends this process: a start on a tree half moved runs nothing. */
  exit(code: number): void
  lock?: LockDeps
}

// A start no person typed (systemd's, the sign-in task's, Desktop's) tries a failed move again an hour after the last try.
const RETRY_MS = 3_600_000
// `systemctl --user daemon-reload` answers within a second: one that does not fails its step, which is rolled back.
const SYSTEMCTL_LIMIT_MS = 30_000
// A PTY host's discovery files in its folder (lib/ptyHost/launch.ts), each naming the host's pid.
const PTY_HOST_FILE = /^pty-host-.+\.json$/
const OLD_HOME = legacyHarnessHome('~', 'linux')
const CLOSE_AGENTS = 'close the agents, then harness start'
// Said once a start has waited LOCK_LOOK_MS for another start's move (lock.ts).
const UNDER_WAY = 'home move: under way · waiting'

/**
 * Moves ~/.harness at a start command, says how it went in the data folder's harness.log (and on a terminal), and starts
 * this process again from the new paths when the roots moved under it. Whatever happens the start goes on, but on a
 * tree half moved, a journal left with the data root not there: it ends, and the next start puts ~/.harness back.
 */
export async function moveHomeAtStart(argv: readonly string[], env: NodeJS.ProcessEnv, deps: StartDeps = thisStart()): Promise<void> {
  const [, , command, ...flags] = argv
  // Reading start's options never starts, stops or touches anything (cli.ts).
  if ((command !== 'start' && command !== '__harnessd') || flags.includes('--help') || flags.includes('-h') || deps.platform !== 'linux') return
  let environment: NodeJS.ProcessEnv
  try {
    environment = withEnvFile({ fs: deps.io, env })
  } catch {
    // config/loadEnv.ts refuses this start right after, naming the file.
    return
  }
  const roots: Roots = { legacy: legacyHarnessHome(deps.home, 'linux'), ...xdgRoots(deps.home, environment) }
  const lines: string[] = []
  const moveDeps: MoveDeps = { ...deps, log: (line) => lines.push(line) }
  const moved = fs.existsSync(roots.data)
  // A person typed it: a harness start on a terminal. Desktop starts the daemon the same way, with no terminal.
  const explicit = command === 'start' && !flags.includes('--if-down') && deps.print !== null
  let outcome: MoveOutcome | null = null
  try {
    // A journal is finished, or undone, before anything else: a crash after the data root's commit left one beside it.
    if (moved ? readJournal(roots.legacy) : fs.existsSync(roots.legacy)) {
      outcome = await moveOrHold(explicit, env, environment, roots, deps, moveDeps, lines)
    } else if (moved) {
      noteStray(roots, environment, deps, lines)
    }
  } catch (error) {
    // A lock this start could not take is no try: a failed move not due again keeps its hour, and says nothing.
    outcome = due(explicit, environment, deps) || readJournal(roots.legacy) ? failure(error, environment, deps, moveDeps) : null
  }
  const movedNow = fs.existsSync(roots.data)
  // A rollback that could not undo every step keeps its journal for the next start.
  const halfMoved = !movedNow && readJournal(roots.legacy) !== null
  // Moved, by this start, another, or long ago: one run from ~/.harness runs again from the new paths. That run finishes
  // what failed after the commit, and says how it went: said here too, it would be said twice.
  const again = movedNow ? startAgain(roots, argv, env, deps) : null
  if (outcome?.state === 'bridged') lines.push(`home move: moved · data ${roots.data} · state ${roots.state}`)
  if (outcome?.state === 'failed' && !again) lines.push(`home move: failed ${outcome.reason} · ${afterFailure(movedNow, halfMoved)}`)
  say(lines, environment, deps)
  if (halfMoved) return deps.exit(1)
  again?.()
}

function afterFailure(movedNow: boolean, halfMoved: boolean): string {
  if (movedNow) return 'the next start finishes it'
  return halfMoved ? `the next start puts ${OLD_HOME} back` : `${OLD_HOME} is as it was`
}

/** This process's Node and cli.js at their places after the move, with Node's options and the arguments; null when neither was in ~/.harness. */
export function reexecTarget(plan: Roots, execPath: string, argv: readonly string[], execArgv: readonly string[]): { file: string; args: string[] } | null {
  const [, script, ...rest] = argv
  const file = movedPath(plan, execPath)
  const moved = script === undefined ? [] : [movedPath(plan, script)]
  if (file === execPath && (script === undefined || moved[0] === script)) return null
  return { file, args: [file, ...execArgv, ...moved, ...rest] }
}

/**
 * Under the move lock: the journal an earlier move left, then the conditions, then the move, or the hold, recorded and
 * said. Null when there is nothing to say: no move to make, a failed one not yet due again, or a move another start
 * holds the lock for and has committed (this start then goes on from the new roots while that one finishes).
 */
async function moveOrHold(explicit: boolean, env: NodeJS.ProcessEnv, environment: NodeJS.ProcessEnv, roots: Roots, deps: StartDeps, moveDeps: MoveDeps, lines: string[]): Promise<MoveOutcome | null> {
  const wait = { committed: () => fs.existsSync(roots.data), long: () => say([UNDER_WAY], environment, deps) }
  const locked = await withMoveLock(roots.legacy, async () => {
    const recovered = await recoverMove(deps.home, environment, moveDeps)
    if (recovered) return recovered
    if (!due(explicit, environment, deps)) return null
    const check = await checkMove({ ...deps, env, hasExecve: deps.execve !== undefined, fs: deps.io })
    if (check.move) return runMove(check, environment, moveDeps)
    if (check.hold) noteHold(check.hold, roots.legacy, deps.now(), lines)
    return null
  }, wait, deps.lock)
  return locked.held ? locked.value : null
}

/** Whether a move is due: one that failed is tried again at once when a person typed harness start, else an hour after the last try. */
function due(explicit: boolean, environment: NodeJS.ProcessEnv, deps: StartDeps): boolean {
  const record = readMoveRecord(deps.home, environment)
  return explicit || record?.state !== 'failed' || deps.now() - (record.failedAt ?? record.at) >= RETRY_MS
}

/** A held move: one line at each start, its record in ~/.harness when the state or the reason changes. */
function noteHold(hold: Hold, legacy: string, now: number, lines: string[]): void {
  lines.push(heldLine(hold))
  const reason = hold.state === 'waiting' ? hold.reason : undefined
  writeMoveRecord(legacy, { version: 1, state: hold.state, reason, entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at: now })
}

function heldLine(hold: Hold): string {
  if (hold.state === 'waiting') return `home move: waiting ${hold.reason} · ${hold.reason === 'update-pending' ? 'it moves at the start after this update settles' : CLOSE_AGENTS}`
  return hold.name === OLD_HOME ? `home move: skipped-override · ${OLD_HOME} is a link; it stays where it points`
    : `home move: skipped-override · ${hold.name} names a folder inside ${OLD_HOME}; unset it to move`
}

/** A ~/.harness beside the data root that is not the bridge: nothing reads it (the root rule), which is said once and deleted never. */
function noteStray(roots: Roots, environment: NodeJS.ProcessEnv, deps: StartDeps, lines: string[]): void {
  if (!fs.existsSync(roots.legacy) || isBridge(roots.legacy)) return
  // A fresh install on the XDG roots has no record yet.
  const record = readMoveRecord(deps.home, environment) ?? { version: 1, state: 'moved', entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at: deps.now() }
  fs.mkdirSync(roots.state, { recursive: true, mode: 0o700 })
  if (writeMoveRecord(roots.state, { ...record, stray: true })) lines.push(`home move: ${OLD_HOME} is no longer read`)
}

/** What the move threw, recorded in the state root the rule reads now, as the move's own failures are. */
function failure(error: unknown, environment: NodeJS.ProcessEnv, deps: StartDeps, moveDeps: MoveDeps): MoveOutcome {
  try {
    return failed(harnessRoot('state', deps.home, 'linux', { env: environment, exists: fs.existsSync }), error, moveDeps)
  } catch {
    // Nowhere to record it: the line still says it.
    return { state: 'failed', reason: 'io' }
  }
}

/** [lines] at the end of harness.log in the data folder where it is now, and on a terminal. */
function say(lines: readonly string[], environment: NodeJS.ProcessEnv, deps: StartDeps): void {
  if (lines.length === 0) return
  for (const line of lines) deps.print?.(line)
  try {
    const folder = environment.ADAPTER_DATA_DIR
      ? resolve(environment.ADAPTER_DATA_DIR)
      : join(harnessRoot('data', deps.home, 'linux', { env: environment, exists: fs.existsSync }), 'cli', 'data')
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
    fs.appendFileSync(join(folder, 'harness.log'), lines.map((line) => `${line}\n`).join(''), { mode: 0o600 })
  } catch {
    // A log that cannot be written: the record, and a terminal, still say it.
  }
}

/**
 * The execve from the new paths, same pid (systemd follows it), when this process ran from ~/.harness and its files are
 * there; null when it does not start again.
 */
function startAgain(roots: Roots, argv: readonly string[], env: NodeJS.ProcessEnv, deps: StartDeps): (() => void) | null {
  const target = reexecTarget(roots, deps.execPath, argv, deps.execArgv)
  const { execve } = deps
  if (!target || !execve) return null
  // An execve that fails ends the process: a Node or a cli.js that is not there leaves this start where it is.
  const script = target.args[deps.execArgv.length + 1]
  if (!runnable(target.file) || (script !== undefined && !fs.existsSync(script))) return null
  return () => execve(target.file, target.args, env)
}

function runnable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Whether something accepts a connection on [socket]: a daemon serving it. conditions.ts bounds the wait. */
export function answers(socket: string): Promise<boolean> {
  return new Promise((done) => {
    const connection = createConnection(socket)
    const end = (answer: boolean): void => {
      connection.destroy()
      done(answer)
    }
    connection.once('connect', () => end(true)).once('error', () => end(false))
  })
}

/** Whether a PTY host runs for [ptyDir]: a discovery file in its folder names a live process. */
export function ptyHostRuns(ptyDir: string): boolean {
  const folder = join(ptyDir, 'run')
  let names: string[]
  try {
    names = fs.readdirSync(folder)
  } catch {
    return false
  }
  return names.some((name) => {
    if (!PTY_HOST_FILE.test(name)) return false
    try {
      const { pid } = JSON.parse(fs.readFileSync(join(folder, name), 'utf8')) as { pid?: unknown }
      return Number.isSafeInteger(pid) && (pid as number) > 0 && processRuns(pid as number)
    } catch {
      return false
    }
  })
}

function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Another account's process runs too.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** systemctl's status, null when it did not end within its limit. */
function runCommand(command: string, args: string[]): { status: number | null } {
  return { status: spawnSync(command, args, { stdio: 'ignore', timeout: SYSTEMCTL_LIMIT_MS }).status }
}

function thisStart(): StartDeps {
  return {
    platform: process.platform, home: homedir(), io: fs, tmux: defaultTmux(), run: runCommand, now: Date.now, procNow,
    alive: processRuns, answers, ptyHostRuns,
    execve: (process as NodeJS.Process & { execve?: Execve }).execve?.bind(process), execPath: process.execPath, execArgv: process.execArgv,
    print: process.stdout.isTTY ? (line) => console.log(line) : null, exit: (code) => process.exit(code),
  }
}
