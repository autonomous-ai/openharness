/**
 * The one place this daemon runs the `grid` CLI.
 *
 * `gridHandoff.ts` and `gridLogout.ts` each grew their own spawn because there were two calls. The
 * harness-grid flow adds several more — ensure, models, endpoint — and a per-caller spawn is how a
 * PATH check, a capture bound and an exit-code meaning end up disagreeing three ways. So: one
 * resolver, one classification, one bounded capture. The hand-off and the sign-out keep their own
 * spawn (a token on stdin; a passthrough to the terminal where a person is watching), but they
 * resolve the binary HERE, through [gridBinaryPath] — so every grid call on this daemon runs the one
 * `grid`.
 *
 * **Which binary.** `HARNESS_GRID_BIN` (an explicit override, for a developer testing an unreleased
 * grid) → the runtime this daemon manages → `grid` on PATH. The managed runtime is PINNED, and it
 * deliberately outranks PATH: the pin is what makes [GRID_VERSION_FLOOR] a property we ship and test
 * rather than one we discover on a user's machine. PATH is the fallback for a checkout with no
 * runtime installed, not the preferred answer.
 *
 * ⚠️ The managed binary and a user's own `grid` share one `~/.grid` — credentials, device id, the
 * network registry. They are two readers of one state directory, so a grid state-format change is a
 * coordination point: the pin has to move before or with it.
 */
import { spawn } from 'node:child_process'
import { binaryOnPath } from './binaryOnPath.js'
import { GRID_NO_UPDATE_CHECK_VAR, gridBinaryPath, gridChildEnv } from './gridBinary.js'

// Which `grid` to run is gridBinary.ts's, which the core keeps for its launches; said again here for
// every grid call that imports it from this module.
export { GRID_BINARY, GRID_NO_UPDATE_CHECK_VAR, gridAvailable, gridBinaryPath, gridChildEnv, gridCliPresence, managedGridPath, type GridCliPresence } from './gridBinary.js'

/**
 * The oldest `grid` this daemon can drive.
 *
 * `grid login --harness` — the whole of the one-sign-in flow — landed in 0.3.36 (autonomous-grid
 * `3286163`, 2026-09-04). An older binary answers argparse's exit 2, which the hand-off already
 * reads as OUTDATED; this constant is what lets every OTHER call say so in one sentence instead of
 * each one rediscovering it.
 */
export const GRID_VERSION_FLOOR = '0.3.36'

/** A bound on what one child can put into a capture. The passthrough, where there is one, is never
 *  bounded — only what this process holds in memory. Mirrors `gridHandoff.ts`. */
const MAX_CAPTURED_CHARS = 64 * 1024

/** A `grid` call that has not answered in this long is not going to. The daemon runs these on its
 *  sign-in path, where a hung child would otherwise hang the command that spawned it. */
const DEFAULT_TIMEOUT_MS = 30_000

export type GridCode = 'OK' | 'GRID_CLI_MISSING' | 'GRID_CLI_OUTDATED' | 'GRID_FAILED'

export interface GridResult {
  code: GridCode
  /** The child's own exit code; 1 when there was no child, or it died on a signal. */
  exitCode: number
  stdout: string
  stderr: string
  /** This module's classification, in a sentence. Empty on success. Never contains a credential. */
  message: string
}

/** argparse exits 2 on an unknown flag, BEFORE any handler runs — so a `grid` predating a flag we
 *  pass fails at once and unmistakably. Same constant, same reason, as `gridHandoff.ts`. */
const ARGPARSE_USAGE_EXIT = 2

const MISSING_MESSAGE =
  'No `grid` on PATH and no managed grid runtime, so there is nothing to run. Reinstall harness, or '
  + 'install the grid CLI yourself.'

const OUTDATED_MESSAGE =
  `This machine's \`grid\` is older than ${GRID_VERSION_FLOOR}, which is the oldest the harness can `
  + 'drive. Update it, then try again.'

function capped(sofar: string, chunk: Buffer): string {
  return sofar.length >= MAX_CAPTURED_CHARS ? sofar : (sofar + chunk.toString()).slice(0, MAX_CAPTURED_CHARS)
}


export interface GridExecOptions {
  /** Written to the child's stdin, which is then closed. For the token hand-off and nothing else. */
  stdin?: string
  timeoutMs?: number
  processEnv?: NodeJS.ProcessEnv
}

/**
 * Run `grid` with `args` and classify what happened. Never throws.
 *
 * Both streams are captured, never inherited: every caller here is the daemon or a command that
 * renders its own output, and a child writing straight to the terminal from inside the sign-in path
 * would interleave with the harness's own lines.
 */
export async function gridExec(args: readonly string[], opts: GridExecOptions = {}): Promise<GridResult> {
  const processEnv = opts.processEnv ?? process.env
  const binary = gridBinaryPath(processEnv)
  if (!binaryOnPath(binary, processEnv)) {
    return { code: 'GRID_CLI_MISSING', exitCode: 1, stdout: '', stderr: '', message: MISSING_MESSAGE }
  }
  return await new Promise<GridResult>((resolve) => {
    const child = spawn(binary, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: gridChildEnv(processEnv) })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (result: GridResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      settle({
        code: 'GRID_FAILED',
        exitCode: 1,
        stdout,
        stderr,
        message: `\`grid ${args[0] ?? ''}\` did not answer within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)}s.`,
      })
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => { stdout = capped(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = capped(stderr, chunk) })
    child.once('error', (err: NodeJS.ErrnoException) => settle(err.code === 'ENOENT'
      ? { code: 'GRID_CLI_MISSING', exitCode: 1, stdout, stderr, message: MISSING_MESSAGE }
      : { code: 'GRID_FAILED', exitCode: 1, stdout, stderr, message: `Could not run \`${binary}\`: ${err.message}` }))

    // stdio[0] is a pipe, so this is never null; refusing loudly rather than optional-chaining past
    // it, because a child left waiting on a stdin nobody closes hangs with nothing on screen.
    const { stdin } = child
    if (!stdin) {
      try { child.kill() } catch { /* ignore */ }
      settle({ code: 'GRID_FAILED', exitCode: 1, stdout, stderr, message: `Could not open a pipe to \`${binary}\`.` })
      return
    }
    stdin.on('error', () => { /* EPIPE — a child that exits before reading is its own story */ })
    stdin.end(opts.stdin ?? '')

    // `close`, not `exit`: the capture must be complete before it is reported on.
    child.once('close', (status, signal) => {
      if (status === 0) { settle({ code: 'OK', exitCode: 0, stdout, stderr, message: '' }); return }
      if (status === ARGPARSE_USAGE_EXIT) {
        settle({ code: 'GRID_CLI_OUTDATED', exitCode: status, stdout, stderr, message: OUTDATED_MESSAGE })
        return
      }
      const how = status === null ? `was killed by ${signal ?? 'a signal'}` : `exited ${status}`
      settle({ code: 'GRID_FAILED', exitCode: status ?? 1, stdout, stderr, message: `\`grid ${args[0] ?? ''}\` ${how}.` })
    })
  })
}

/**
 * Run a `--json` command and parse its document, or null.
 *
 * Null covers every way there is no answer — no binary, a refusal, output that is not JSON — because
 * every caller here does the same thing with all of them: carry on without the grid. The reason is
 * still available on the `GridResult` for a caller that wants to log it.
 */
export async function gridJson<T>(
  args: readonly string[],
  opts: GridExecOptions = {},
): Promise<{ value: T | null; result: GridResult }> {
  const result = await gridExec([...args, '--json'], opts)
  if (result.code !== 'OK') return { value: null, result }
  try {
    return { value: JSON.parse(result.stdout) as T, result }
  } catch {
    return { value: null, result }
  }
}

/** `grid version` prints `grid <semver>`; null when it could not be read. */
export async function gridVersion(opts: GridExecOptions = {}): Promise<string | null> {
  const result = await gridExec(['version'], opts)
  if (result.code !== 'OK') return null
  const match = /(\d+\.\d+\.\d+)/.exec(result.stdout)
  return match ? match[1] : null
}

/** Ordinary three-part semver compare, enough for a floor check. A version that cannot be parsed is
 *  treated as NOT meeting the floor: refusing to drive an unknown build is the safe direction. */
export function meetsVersionFloor(version: string | null, floor: string = GRID_VERSION_FLOOR): boolean {
  if (!version) return false
  const parse = (value: string): number[] => value.split('.').map((part) => Number.parseInt(part, 10))
  const [major = 0, minor = 0, patch = 0] = parse(version)
  const [flMajor = 0, flMinor = 0, flPatch = 0] = parse(floor)
  if ([major, minor, patch].some((n) => !Number.isFinite(n))) return false
  if (major !== flMajor) return major > flMajor
  if (minor !== flMinor) return minor > flMinor
  return patch >= flPatch
}
