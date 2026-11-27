/**
 * The environment the user's own shell would give a command — for engine one-shots only.
 *
 * A recap child inherits the DAEMON's environment, and the daemon is detached: its parent is launchd
 * (or systemd), not a shell, so it never read the user's profile. An engine that resolves its
 * credential from an environment variable therefore works in the user's pane and fails in the recap.
 *
 * Measured, and this is the whole bug behind "pi stopped recapping": `~/.pi/agent/models.json` holds
 *     "apiKey": "$LOCAL_API_KEY"
 * and that variable is exported from `~/.zshrc`. The daemon has no such variable, so pi exited 1 with
 * "No API key found for the selected model" after 14ms, every time, while `pi` in a tmux pane was fine.
 *
 * INTERACTIVE login shell, deliberately. `zsh -lc` reads .zprofile/.zlogin and would NOT have found it;
 * `.zshrc` is only read for interactive shells. Verified both ways on the reporting machine.
 *
 * This is not a new privilege: an engine started in a pane already runs with exactly this environment.
 * All it does is let the recap run where the agent it summarises runs.
 */
import { spawn } from 'node:child_process'
import { currentUserShell } from './userShell.js'

/** Printed before the dump so anything a chatty rc file writes to stdout is skipped, not parsed. */
const SENTINEL = '__HARNESS_ENV_BEGIN__'
const CAPTURE_TIMEOUT_MS = 5_000
const CAPTURE_MAX_BYTES = 1024 * 1024

let cached: NodeJS.ProcessEnv | null = null
let capturedKey = ''
let flightKey = ''
// The in-flight capture, not just its resolved value — two overlapping warm-up calls (there is only
// ever one production caller today, but this keeps it true regardless) must join the same spawn
// rather than each starting their own shell.
let inFlight: Promise<NodeJS.ProcessEnv> | null = null

/** What was captured, or `{}` if nothing has been. NEVER spawns — see warmLoginShellEnvironment. */
export function loginShellEnvironment(): NodeJS.ProcessEnv {
  return cached ?? {}
}

function parse(stdout: string): NodeJS.ProcessEnv {
  const start = stdout.indexOf(SENTINEL)
  if (start < 0) return {}
  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of stdout.slice(start + SENTINEL.length).split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    parsed[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return parsed
}

async function capture(shell: string): Promise<NodeJS.ProcessEnv> {
  return await new Promise<NodeJS.ProcessEnv>((resolve) => {
    let child: ReturnType<typeof spawn>
    let settled = false, bytes = 0
    const chunks: Buffer[] = []
    const finish = (value: NodeJS.ProcessEnv, failure?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) {
        console.error(`[env] ${failure}: login shell environment unavailable; using daemon environment`)
        child?.kill('SIGKILL')
      }
      child?.stdout?.destroy()
      resolve(value)
    }
    // A descendant can inherit stdout after the shell dies. The deadline ends our wait independently of close.
    const timer = setTimeout(() => finish({}, 'LOGIN_SHELL_TIMEOUT'), CAPTURE_TIMEOUT_MS)
    try {
      child = spawn(shell, ['-lic', `printf %s ${SENTINEL}; env -0`], {
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
      })
    } catch {
      finish({}, 'LOGIN_SHELL_FAILED')
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > CAPTURE_MAX_BYTES) { finish({}, 'LOGIN_SHELL_OUTPUT_LIMIT'); return }
      chunks.push(chunk)
    })
    child.once('error', () => finish({}, 'LOGIN_SHELL_FAILED'))
    child.once('close', (code) => {
      if (code !== 0) { finish({}, 'LOGIN_SHELL_FAILED'); return }
      const value = parse(Buffer.concat(chunks).toString('utf8'))
      finish(value, Object.keys(value).length ? undefined : 'LOGIN_SHELL_FAILED')
    })
  })
}

/** Capture once for this shell/PATH. Overlapping readers share one bounded asynchronous shell. */
export function warmLoginShellEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shell = process.platform === 'win32' ? undefined : currentUserShell()
  const key = `${shell ?? ''}\0${process.env.PATH ?? ''}`
  if (inFlight) return flightKey === key ? inFlight : inFlight.then(() => warmLoginShellEnvironment())
  if (cached && capturedKey === key) return Promise.resolve(cached)
  cached = null
  capturedKey = flightKey = key
  inFlight = (shell ? capture(shell) : Promise.resolve({})).then(value => (cached = value)).finally(() => {
    inFlight = null
  })
  return inFlight
}

/**
 * The base environment for a one-shot child: the user's shell environment, with the daemon's own
 * environment layered ON TOP.
 *
 * That precedence is the safety property — every variable the daemon already has keeps its current
 * value, so nothing that works today can change. The shell only fills in what is missing.
 */
export function oneShotParentEnv(): NodeJS.ProcessEnv {
  return { ...loginShellEnvironment(), ...process.env }
}

/** Test seam. */
export function resetLoginShellEnvironmentCache(): void {
  cached = null
  capturedKey = flightKey = ''
  inFlight = null
}

/**
 * The one startup line about the capture, or null when there is nothing to say. Windows has no POSIX
 * login shell, so the empty capture there is the normal case, not a failure worth a line at every
 * start.
 */
export function loginShellCaptureLine(
  count: number,
  elapsedMs: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (count > 0) return `[env] read ${count} variables from the login shell in ${elapsedMs}ms (engine one-shots only)`
  if (platform === 'win32') return null
  return '[env] could not read a login shell environment — engine one-shots use the daemon environment only'
}
