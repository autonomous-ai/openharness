/**
 * Run a DSH's own commands — setup, doctor, workspace init, the viewer — the way the user's terminal
 * would: through their interactive shell, so `uv`, `npm`, `node` and `kicad-cli` resolve from the
 * PATH their rc files build, not from the detached daemon's. This is the same reasoning (and the
 * same shell selection) `engineLaunch.ts` uses to exec an engine in a pane.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { win32 } from 'node:path'
import { harnessNodePrelude, interactiveEngineShell } from '../lib/engineLaunch.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { shellSingleQuote } from '../lib/shellQuote.js'
import { findGitBash, INSTALL_GIT_FOR_WINDOWS } from '../lib/windows/gitBash.js'

export interface DshCommandOptions {
  cwd: string
  env?: Record<string, string>
  /** Each line of combined stdout+stderr, as it arrives. */
  onLine?: (line: string) => void
  timeoutMs?: number
  /** The platform and Git Bash to run under, when not this computer's: a test runs Windows' path on any computer. */
  host?: DshShellHost
}

export interface DshCommandResult {
  code: number | null
  signal: NodeJS.Signals | null
  lines: string[]
  timedOut: boolean
}

/**
 * What the shell itself says about being interactive without a terminal — not the DSH's output.
 * `zsh -lic` with no tty cannot enable the line editor, and an rc file that sets `zle` makes zsh
 * complain once per option. `bash -lic`, the usual shell on Linux, says it has no job control, and a
 * login bash says `logout` when a script exits. The engine never sees any of this because its pane
 * HAS a tty. Dropped so a doctor's lines, which the desktop shows verbatim, are the doctor's.
 */
export function isShellNoise(line: string): boolean {
  return /can't change option: zle$/.test(line) || /^\(eval\):\d+: can't change option: zle$/.test(line)
    || BASH_NO_TTY.test(line) || line === 'logout'
}

const BASH_NO_TTY = /^(?:\S*\/)?bash: (?:cannot set terminal process group \(-?\d+\): Inappropriate ioctl for device|no job control in this shell)$/

/**
 * The shell's report of a job of its own that a signal ended (`/bin/sh: line 1: 31849 Terminated: 15  sleep 30`
 * on macOS, `bash: line 1: 31849 Terminated  sleep 30` on Linux). Once a command has outlived its timeout its
 * whole group is sent SIGTERM, and a shell that is still in `wait` when its job dies says so before it goes:
 * that is the stop, told by the shell, not the command's output. Seen under load (a full unit run with 12
 * busy loops), where the job's death reached the shell before the shell's own SIGTERM did.
 */
export function isKilledJobReport(line: string): boolean {
  return /^(?:\S*\/)?(?:ba)?sh: line \d+: +\d+ (?:Terminated|Killed)(?::\s*\d+)?\s+\S/.test(line)
}

/**
 * `[path, ...args]` that runs `script` through the user's shell, or `/bin/sh -c` when none is known; on Windows,
 * which has neither, through Git Bash (`gitBashArgv`).
 *
 * AS A LOGIN SHELL, whatever the shell. interactiveEngineShell gives bash `-ic` on purpose for a pane
 * (see tmuxOnPath.ts on why), but a bash user's PATH conventionally lives in `.bash_profile`, which
 * only `-l` reads — and Terminal.app opens a login shell, so that file is what "on my terminal it
 * works" means. Measured 2026-09-16: Solid's doctor answered `miss codex on PATH` from the daemon
 * while `harness dsh doctor` in Terminal found it, because codex was an npm global under nvm and nvm
 * is sourced from `.bash_profile`. A setup or a doctor is one process, so the reason bash panes avoid
 * `-l` (a PATH built in .bashrc compounding across subshells) does not apply here.
 */
export function dshShellArgv(script: string, host: DshShellHost = {}): { path: string; args: string[]; env?: Record<string, string> } {
  if ((host.platform ?? process.platform) === 'win32') return gitBashArgv(script, (host.gitBash ?? findGitBash)())
  const shell = interactiveEngineShell()
  const body = `${dshNodeFallback()}\n${script}`
  if (shell) {
    const args = shell.args.map((a) => (a === '-ic' ? '-lic' : a))
    return { path: shell.path, args: [...args, body] }
  }
  return { path: '/bin/sh', args: ['-c', body] }
}

/** The platform and the Git Bash lookup `dshShellArgv` uses; a test gives Windows' on any computer. */
export interface DshShellHost {
  platform?: NodeJS.Platform
  gitBash?: () => string | null
}

/** What a person is told when a package's setup or doctor cannot run here: a Windows computer without Git Bash, as an
 *  install's refusal (before the download, or once fetched) or as a command's one line. */
export const DSH_SHELL_UNAVAILABLE = `This harness runs a setup or check script, which needs Git Bash on Windows, and it was not found. ${INSTALL_GIT_FOR_WINDOWS}`

/**
 * Windows: Git Bash, as a login shell like the user's shell elsewhere, so its profile builds PATH (and puts cygpath
 * on it). Thrown when there is none, and runDshCommand reports that as the command's one line: the doctor or setup
 * says what to install, where `spawn /bin/sh ENOENT` said nothing a person could act on.
 *
 * Two lines go before the command. `unalias node`: Git Bash profiles can say `alias node='winpty node.exe'`, and winpty
 * fails with "stdin is not a tty" here, where the command's output is a pipe. And Harness's Node at the end of a PATH
 * with none, as `dshNodeFallback` does elsewhere, but written by cygpath: its folder is a `C:\...` path, whose colon
 * would split a Git Bash PATH in two. Both were found, and checked on Windows 11, by an outside contribution (#1511).
 *
 * CHERE_INVOKING: Git for Windows' /etc/profile changes a login shell to $HOME unless it is set, and a setup or doctor
 * runs in the harness's folder (review of #2025).
 */
function gitBashArgv(script: string, bash: string | null): { path: string; args: string[]; env: Record<string, string> } {
  if (!bash) throw new Error(DSH_SHELL_UNAVAILABLE)
  const runtimeDir = shellSingleQuote(win32.dirname(managedNodePath()))
  const body = [
    'unalias node 2>/dev/null || true',
    `if ! command -v node >/dev/null 2>&1; then PATH="\${PATH:+$PATH:}$(cygpath -u -- ${runtimeDir})"; export PATH; fi`,
    script,
  ].join('\n')
  return { path: bash, args: ['-lic', body], env: { CHERE_INVOKING: '1' } }
}

/**
 * Whether this computer has a shell for a DSH's commands. Every Store install on Windows failed in its setup or doctor
 * (2026-10-28: 0 of 25 since 10-26): there was no shell there, and the `/bin/sh` fallback is not there. They run in
 * Git Bash now (`gitBashArgv`), so Windows has one when Git for Windows is installed; without it, an install is refused
 * before anything runs, with DSH_SHELL_UNAVAILABLE as its words.
 */
export function dshShellAvailable(host: DshShellHost = {}): boolean {
  return (host.platform ?? process.platform) !== 'win32' || (host.gitBash ?? findGitBash)() !== null
}

/**
 * The line run before a DSH's command: when the login shell's PATH has no `node`, the Node this
 * daemon runs on joins the END of it. Since the product moved to a private runtime, a machine with no
 * node on PATH is the normal case (see nodeRuntime.ts), and a package whose setup says `npm ci` or
 * whose viewer is `node viewer.mjs` would otherwise fail on exactly the machines Harness set up
 * itself. Appended, not prepended, so a node the person installed always wins; and run after the rc
 * files, so a profile that assigns PATH outright cannot drop it.
 */
export function dshNodeFallback(): string {
  return harnessNodePrelude(managedNodePath()).trimEnd()
}

export function spawnDshCommand(script: string, opts: { cwd: string; env?: Record<string, string>; host?: DshShellHost }): ChildProcess {
  const { path, args, env } = dshShellArgv(script, opts.host)
  return spawn(path, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...env, ...(opts.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so stopping it stops what it started (`sh -c node …`).
    detached: true,
  })
}

/** Run to completion, collecting output lines. Never rejects: a spawn failure is a non-zero exit. */
export function runDshCommand(script: string, opts: DshCommandOptions): Promise<DshCommandResult> {
  return new Promise((resolve) => {
    const lines: string[] = []
    let timedOut = false
    let settled = false
    let child: ChildProcess
    try {
      child = spawnDshCommand(script, { cwd: opts.cwd, env: opts.env, host: opts.host })
    } catch (error) {
      // spawn throws only Errors (an invalid argument: a NUL in the cwd, say).
      const line = `could not start: ${(error as Error).message}`
      opts.onLine?.(line)
      resolve({ code: 127, signal: null, lines: [line], timedOut: false })
      return
    }
    const feed = (chunk: Buffer, carry: { rest: string }): void => {
      carry.rest += chunk.toString('utf8')
      let at: number
      while ((at = carry.rest.indexOf('\n')) >= 0) {
        const line = carry.rest.slice(0, at).replace(/\r$/, '')
        carry.rest = carry.rest.slice(at + 1)
        if (isShellNoise(line) || (timedOut && isKilledJobReport(line))) continue
        lines.push(line)
        opts.onLine?.(line)
      }
    }
    const out = { rest: '' }
    const err = { rest: '' }
    child.stdout?.on('data', (chunk: Buffer) => feed(chunk, out))
    child.stderr?.on('data', (chunk: Buffer) => feed(chunk, err))
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const carry of [out, err]) {
        if (carry.rest && !(timedOut && isKilledJobReport(carry.rest))) { lines.push(carry.rest); opts.onLine?.(carry.rest) }
      }
      resolve({ code, signal, lines, timedOut })
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
        timedOut = true
        killProcessGroup(child)
      }, opts.timeoutMs)
      : null
    timer?.unref?.()
    child.on('error', (error) => {
      const line = `could not start: ${error.message}`
      lines.push(line)
      opts.onLine?.(line)
      finish(127, null)
    })
    child.on('exit', (code, signal) => finish(code, signal))
  })
}

/** SIGTERM the child's whole group, then SIGKILL what is left a moment later. */
export function killProcessGroup(child: ChildProcess, graceMs = 3_000): void {
  const pid = child.pid
  if (!pid) return
  const timer = killPidGroup(pid, graceMs)
  child.once('exit', () => clearTimeout(timer))
}

/** The same, for a group this process did not spawn (a viewer left over from an earlier daemon —
 *  see viewerLedger.ts): nothing to wait on, so the SIGKILL follow-up fires unconditionally. */
export function killPidGroup(pid: number, graceMs = 3_000): NodeJS.Timeout {
  // pid 1 would make `-pid` "every process in my session"; nothing this daemon reaps is init.
  if (!Number.isInteger(pid) || pid <= 1) return setTimeout(() => {}, 0)
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal) } catch { /* already gone */ }
    try { process.kill(pid, signal) } catch { /* already gone */ }
  }
  signalGroup('SIGTERM')
  const timer = setTimeout(() => signalGroup('SIGKILL'), graceMs)
  timer.unref?.()
  return timer
}
