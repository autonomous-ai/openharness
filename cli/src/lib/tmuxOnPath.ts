/**
 * Make `tmux` runnable from the daemon, not just from the user's terminal.
 *
 * Every tmux call in this CLI is `execFile('tmux', …)`, which resolves against the DAEMON's PATH.
 * That is fine while the daemon was started from a terminal and inherits the user's environment,
 * and it breaks the moment it is not: a login/launch-agent context gets a minimal PATH, Homebrew's
 * `/opt/homebrew/bin` is not on it, and every tmux call fails with ENOENT. The visible symptom is
 * agent creation failing for EVERY engine right after a reboot, since nothing else changed.
 *
 * The engine launch was already hardened against exactly this hazard — `buildEngineLaunchArgv`
 * wraps the engine in the user's interactive login shell — but the tmux calls underneath it never
 * were. This closes that asymmetry by asking the same shell where tmux is and putting its directory
 * on the daemon's PATH, once, at startup. Every existing `execFile('tmux', …)` then works unchanged.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path'
import { env as appEnv } from '../config/env.js'
import { binaryOnPath } from './binaryOnPath.js'
import { interactiveEngineShell } from './engineLaunch.js'

// `$0` is a label, `$1` the command being resolved — the same positional shape the engine
// availability probe uses, so a command name can never be interpolated into shell source.
const RESOLVE_SCRIPT = 'command -v "$1" 2>/dev/null'

export type TmuxPathOutcome =
  /** Already resolvable; the daemon's PATH was left alone. */
  | { state: 'present'; path?: string }
  /** Found — through the managed runtime or the user's shell — and its directory prepended to PATH. */
  | { state: 'adopted'; path: string; from: string }
  /** Not resolvable either way — tmux is genuinely absent, or there is no usable login shell. */
  | { state: 'absent'; reason: string }

export type AvailableTmuxPathOutcome = Exclude<TmuxPathOutcome, { state: 'absent' }>

/**
 * Refuse to start over a tmux that cannot be found.
 *
 * ⚠️ NOT used by the daemon any more. A daemon that will not start is a daemon that cannot be fixed
 * — its own updater lives inside the boot it never finishes — and a machine that merely lost tmux
 * from its PATH does not need that. `runForeground` records the reason and runs without a tmux
 * backend instead, which every caller already handles (`TMUX_UNAVAILABLE`). Kept for callers that
 * genuinely have nothing to do without terminals, and for its tests.
 */
export function requireTmuxAvailable(outcome: TmuxPathOutcome): AvailableTmuxPathOutcome {
  if (outcome.state === 'absent') {
    throw new Error(
      `tmux is required but unavailable: ${outcome.reason}. `
      + 'Install tmux, verify `tmux -V`, then run `harness start` again.',
    )
  }
  return outcome
}

/**
 * The tmux the installer put under ~/.harness/runtime, recorded in `current-tmux` exactly as the
 * managed Node is recorded in `current-node` — on a Mac that had no tmux and no Homebrew, the
 * installer downloads our checksum-verified build there and links it as ~/.local/bin/tmux. Null on
 * every other machine, and for a record that names something outside the runtime dir or not
 * executable: only a path inside the directory we own is ever trusted, the same containment check
 * `managedNodePath` applies. A fallback, not a preference — see `ensureTmuxOnPath` for the order.
 */
export function managedTmuxPath(runtimeDir: string = appEnv.ADAPTER_RUNTIME_DIR): string | null {
  try {
    const recorded = readFileSync(join(runtimeDir, 'current-tmux'), 'utf-8').trim()
    if (recorded && recorded.startsWith(runtimeDir + sep)) {
      accessSync(recorded, constants.X_OK)
      return recorded
    }
  } catch {
    // No managed tmux here — the ordinary case on a Mac with Homebrew and on every Linux box.
  }
  return null
}

/** Where the user's own interactive shell finds a command, which is not where the daemon looks. */
export async function resolveViaLoginShell(
  command: string,
  shell: string | undefined = undefined,
): Promise<string | null> {
  const interactive = interactiveEngineShell(shell)
  if (!interactive) return null
  const found = await probe(interactive.path, interactive.args, command)
  if (found) return found
  // ASK AGAIN AS A LOGIN SHELL, because for bash the first ask reads the wrong file.
  //
  // interactiveEngineShell gives zsh `-lic` and bash `-ic`, and that asymmetry is deliberate: a
  // deliberate test pins bash to interactive-only startup files. It is right for LAUNCHING an engine
  // and wrong for ASKING WHERE A BINARY IS, because the two conventions differ — a zsh user's PATH is
  // in .zshrc, which `-i` reads, and a bash user's is conventionally in .bash_profile, which only `-l`
  // reads (.bashrc runs for every subshell, so a PATH built there compounds).
  //
  // Measured on a bash machine here: `bash -ic` resolved nothing, `bash -lic` returned
  // /usr/local/bin/tmux. The daemon therefore logged "tmux: unavailable (spawn tmux ENOENT)" and served
  // ZERO agents while nine tmux sessions were running — the dial showed an empty wheel and nothing said
  // why. Terminal.app runs a login shell on macOS, so this second ask is also the one that matches what
  // the user sees in their own terminal.
  //
  // Only ever a FALLBACK: the first ask stands when it answers, so nothing changes for the shells that
  // already worked, and this costs one extra spawn only on a machine that was about to fail anyway.
  if (interactive.args.includes('-lic')) return null
  return await probe(interactive.path, ['-lic'], command)
}

/** One question to one shell: where is `command`? Null unless it answers with an absolute path. */
function probe(shellPath: string, args: readonly string[], command: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    execFile(
      shellPath,
      [...args, RESOLVE_SCRIPT, 'harness-tmux-probe', command],
      { timeout: 5_000 },
      (error, stdout) => {
        // Login rc files are allowed to be chatty. In particular, nvm commonly prints a
        // "Now using node …" banner before `command -v` writes the actual path. Looking only at
        // stdout's first line then made a perfectly installed Homebrew tmux appear absent whenever
        // Harness was started by the desktop app's minimal PATH.
        const found = String(stdout ?? '').split('\n').map((line) => line.trim()).find(isAbsolute)
        resolve(!error && found ? found : null)
      },
    )
  })
}

/**
 * Idempotent: safe to call on every start, and a no-op when the daemon can already run tmux.
 *
 * The directory is PREPENDED rather than the binary path being threaded through call sites: the
 * tmux client and the tmux server have to agree on their socket, and a daemon that found tmux one
 * way while a helper found it another is how a machine ends up talking to two servers.
 */
export async function ensureTmuxOnPath(
  env: NodeJS.ProcessEnv = process.env,
  shell: string | undefined = undefined,
  runtimeDir: string = appEnv.ADAPTER_RUNTIME_DIR,
): Promise<TmuxPathOutcome> {
  if (binaryOnPath('tmux', env)) return { state: 'present' }
  // The user's own shell is asked first and the managed build is the fallback, in that order on
  // purpose: the point is that the daemon runs the SAME tmux the user's terminal runs, so they
  // share one server. Whatever their shell resolves — Homebrew's, the managed symlink in
  // ~/.local/bin, something they put on PATH themselves — is that truth. The managed build is
  // consulted only when no shell can answer: a launch-agent context with no usable shell, or a
  // Mac where the installer's rc edit has not reached the shell yet.
  const resolved = await resolveViaLoginShell('tmux', shell)
  if (resolved) {
    const dir = dirname(resolved)
    env.PATH = env.PATH ? `${dir}${delimiter}${env.PATH}` : dir
    return { state: 'adopted', path: resolved, from: dir }
  }
  const managed = managedTmuxPath(runtimeDir)
  if (managed) {
    const dir = dirname(managed)
    env.PATH = env.PATH ? `${dir}${delimiter}${env.PATH}` : dir
    return { state: 'adopted', path: managed, from: 'managed runtime' }
  }
  return {
    state: 'absent',
    reason: interactiveEngineShell(shell)
      ? 'the user\'s login shell does not resolve tmux either, and there is no managed tmux'
      : 'no usable login shell to ask, tmux is not on the daemon PATH, and there is no managed tmux',
  }
}
