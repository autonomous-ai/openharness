/** Session-control primitives stay in core's eager import closure, independent of search readers. */
import { open } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { processExists as processAlive } from './processLiveness.js'
import type { SessionOwner } from './sessionSearch/external.js'

function run(command: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise(resolve => execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout) => resolve(error ? null : stdout)))
}

export interface StopOptions {
  alive?: (pid: number) => boolean
  kill?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /** Writes to the owner's terminal; tests replace it. */
  writeTty?: (tty: string, text: string) => Promise<void>
  /** The foreground job [pid] leads, if it leads one; tests replace it. */
  job?: (pid: number) => Promise<number | null>
}

/**
 * The foreground job an engine leads in its terminal: the process group it heads, when that group is
 * the one the terminal is showing. Its whole job is signalled then, so what it started for its screen
 * goes with it (Hermes's terminal UI runs a Node child its Python does not pass SIGTERM to). An
 * engine that does not lead its job (Codex's native binary under its Node launcher, anything run
 * without job control) is signalled alone: its group may hold the shell it runs in.
 */
export async function foregroundJob(pid: number, exec: typeof run = run): Promise<number | null> {
  const out = await exec('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], 3_000)
  const [pgid, tpgid] = (out ?? '').trim().split(/\s+/).map(Number)
  return pgid === pid && tpgid === pid ? pid : null
}

/** Failed process evidence is distinct from verified non-leadership for new core admissions. */
export async function verifiedForegroundJob(pid: number, exec: typeof run = run): Promise<number | null | 'unknown'> {
  const out = await exec('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], 3_000)
  if (!out) return 'unknown'
  const values = out.trim().split(/\s+/).map(Number)
  if (values.length !== 2 || !values.every(Number.isSafeInteger) || values[0] <= 0 || values[1] === 0) return 'unknown'
  return values[0] === pid && values[1] === pid ? pid : null
}

/**
 * What a terminal gets back after its engine is stopped from outside: the main screen, no mouse
 * reporting, and a cursor. A TUI that quit cleanly already restored them, and then these change
 * nothing; Codex leaves its cursor hidden, and a TUI made to quit leaves whatever it had on.
 */
export const TERMINAL_RESTORE = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h'

/**
 * Stops the terminal process that has a session open, so Harness can resume it: asked to quit
 * (SIGTERM, which the engines answer by saving and restoring the terminal), then made to after five
 * seconds, and the terminal put back. Whether the process is gone.
 */
export async function stopSessionOwner(owner: Pick<SessionOwner, 'pid' | 'tty'>, opts: StopOptions = {}): Promise<boolean> {
  const alive = opts.alive ?? processAlive
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal) })
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const gone = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited < ms; waited += 100) {
      if (!alive(owner.pid)) return true
      await sleep(100)
    }
    return !alive(owner.pid)
  }
  const job = await (opts.job ?? foregroundJob)(owner.pid).catch(() => null)
  const signal = (name: NodeJS.Signals): void => {
    try { kill(job ? -job : owner.pid, name) } catch { /* already gone */ }
  }
  signal('SIGTERM')
  if (!await gone(5_000)) {
    signal('SIGKILL')
    if (!await gone(2_000)) return false
  }
  if (owner.tty) await (opts.writeTty ?? writeTty)(owner.tty, TERMINAL_RESTORE).catch(() => undefined)
  return true
}

export async function writeTty(tty: string, content: string): Promise<void> {
  const handle = await open(tty, 'w')
  try { await handle.write(content) } finally { await handle.close() }
}
