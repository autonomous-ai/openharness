/**
 * A command that ends when this process ends, however it ends. Every service starts this way each child that runs until
 * stopped or can run 30 s or more.
 *
 * Why: each crash of a service's process (an uncaught error, SIGKILL, the OOM killer, the master's hung-heartbeat kill)
 * left the children it started running on the person's computer, one more per crash: a `podman events`, a headless
 * Chrome, a `codex app-server`, a login flow holding a port. The master ends a service by its pid alone, nobody ends a
 * dead service's children, and a timeout of the service's own dies with it.
 *
 * On macOS and Linux the child is `/bin/sh -c TIED file args…` with a fourth pipe, fd 3, from this process:
 * - A watcher in the background holds fd 3. When this process ends, in any way, the OS closes this end, the watcher
 *   reads end-of-file and sends SIGTERM to the command.
 * - `exec` turns the shell into the command, so the child's pid, stdio, exit code and signals are the command's own:
 *   `child.kill` reaches it directly, and `$$`, the pid the watcher signals, is the command. The command does not
 *   inherit fd 3, and the watcher holds none of its stdio. The file and its arguments are `$0` and `$@`, never read by
 *   the shell.
 * - A detached command leads a process group of its own, and its callers stop it with a group kill: the watcher, which
 *   is in that group too, signals the group, so what the command started there ends with it.
 * - When the command exits by itself, a newline on fd 3 lets the watcher go without a signal: no watcher outlives its
 *   command. It is written only while fd 3 is open, and an error on fd 3 (a watcher already gone) is heard and
 *   dropped: unheard, it would crash this process. A command that waits for all its children does not wait for the
 *   watcher, which it does not know as its own.
 * - A command that is not there, or a cwd that is not, is looked for first and left to the plain spawn: callers tell
 *   "not installed" from its `ENOENT` error (gridExec.ts, codexRateLimits.ts), and a person reads its message, which
 *   names the command. Through the shell it would be exit 127 (126 from macOS's sh), or `spawn /bin/sh ENOENT`. The
 *   file is looked for as exec looks: on the PATH of the env given, or from the cwd given.
 * Measured on macOS (bash 3.2 and dash): a tied command, and a detached one with a child in its group, were gone
 * within 5 ms of their parent's SIGKILL, where a plain one was still alive after 2 s. A tied start costs 1.7 to 3.7 ms
 * more (`/usr/bin/true` to `close`: 1.25 ms plain; by path 4.7 ms on bash, 2.9 ms on dash; by bare name on 81 PATH
 * entries 4.9 and 3.8 ms). The busiest caller, the Swarm's readiness pass (three `git` calls a checkout every 10
 * minutes, 64 checkouts at most), takes under 0.7 s more a pass.
 *
 * Accepted: a command that ignores SIGTERM outlives this process, as it outlives its stop. If this process dies between
 * reaping its command and writing the newline, the watcher signals a pid that may be free again. Under a PID 1 that
 * does not reap, each command leaves a zombie watcher; Harness never runs as PID 1 (launchd, systemd, a Windows task).
 * A command that appears between the look and the spawn runs untied, once; so does one found only through an empty
 * PATH entry (the current folder), which the look does not search.
 *
 * On Windows it is a plain spawn: Node puts every child it starts without `detached` in a Job Object that ends it with
 * this process (lib/windows/noWindow.ts).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Writable } from 'node:stream'
import { resolveBinaryOnPath } from './binaryOnPath.js'

// fd 3 is closed on its own line: bash (macOS's sh) keeps a saved copy of a redirected fd across `exec cmd 3<&-`.
const TIED = '{ read -r _ <&3 || kill $$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"'
const TIED_GROUP = '{ read -r _ <&3 || kill -TERM -$$; } </dev/null >/dev/null 2>&1 & exec 3<&-; exec "$0" "$@"'

export type TiedStdio = 'pipe' | 'ignore' | 'inherit' | number

export interface TiedOptions {
  cwd?: string
  /** The command's environment, and the PATH a bare name is looked for on; this process's when left out. */
  env?: NodeJS.ProcessEnv
  /** The command leads a process group of its own, and the tie ends the whole group. */
  detached?: boolean
  windowsHide?: boolean
  /** stdin, stdout and stderr, as `spawn` takes them; three pipes when left out. */
  stdio?: readonly [TiedStdio, TiedStdio, TiedStdio]
  platform?: NodeJS.Platform
}

export function spawnTied(
  file: string,
  args: readonly string[],
  { platform = process.platform, stdio = ['pipe', 'pipe', 'pipe'], ...options }: TiedOptions = {},
): ChildProcess {
  if (platform === 'win32' || !startable(file, options)) return spawn(file, args, { ...options, stdio: [...stdio] })
  const child = spawn('/bin/sh', ['-c', options.detached ? TIED_GROUP : TIED, file, ...args], { ...options, stdio: [...stdio, 'pipe'] })
  // Out of fds (EMFILE), spawn hands back a child with no stdio and its `error` to follow: nothing started, nothing to
  // tie, and the caller hears it as from a plain spawn. Read past, it threw before any caller listened, and the error
  // that followed crashed the service.
  const tie = child.stdio?.[3] as Writable | undefined
  if (!tie) return child
  tie.on('error', () => {})
  child.once('exit', () => { if (tie.writable) tie.write('\n') })
  return child
}

export interface TiedExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Milliseconds; none when 0 or left out, as execFile. */
  timeout?: number
  /** What ends the command at its timeout or past maxBuffer: SIGTERM unless said. */
  killSignal?: NodeJS.Signals
  /** Bytes, for stdout and for stderr each: 1024 * 1024 unless said, execFile's own default. */
  maxBuffer?: number
  /** Written to the command's stdin, which is always ended. */
  input?: string
  windowsHide?: boolean
  platform?: NodeJS.Platform
}

/** Shaped as execFile's error. */
export interface TiedExecError extends Error {
  /** The exit code; null when a signal ended it; spawn's own (`'ENOENT'`) when it could not start;
   *  `'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` past maxBuffer. */
  code: number | string | null
  /** This call ended it: its timeout, or maxBuffer. */
  killed: boolean
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** `file` and `args`, joined by spaces. */
  cmd: string
}

/**
 * `execFile`, tied: a caller's timeouts, output limits and error handling read as they did under `execFile`, and a
 * crash of its service no longer leaves the command running. The agent browser's `podman.run` loop, moved here so
 * every service has one, not a copy each.
 */
export function execFileTied(
  file: string,
  args: readonly string[],
  { timeout = 0, killSignal = 'SIGTERM', maxBuffer = 1024 * 1024, input, ...options }: TiedExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const cmd = [file, ...args].join(' ')
  return new Promise((done, fail) => {
    const child = spawnTied(file, args, options)
    // The first reason this call ends the command names its failure.
    let ended: 'timeout' | 'stdout' | 'stderr' | undefined
    // Its pipes go first, then the command, as execFile does: something it started (a git credential helper, an `lms`
    // daemon, the VM `podman machine start` leaves) may still hold them, and the call must not wait on it.
    const end = (why: NonNullable<typeof ended>) => {
      ended ??= why
      child.stdout?.destroy()
      child.stderr?.destroy()
      child.kill(killSignal)
    }
    const timer = timeout > 0 ? setTimeout(() => end('timeout'), timeout) : undefined
    // Bytes, counted per stream and decoded once: a character of several bytes can fall across two reads.
    const collect = (stream: 'stdout' | 'stderr') => {
      const chunks: Buffer[] = []
      let bytes = 0
      // None out of fds, as from execFile: the start's error says so.
      child[stream]?.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxBuffer) end(stream)
        else chunks.push(chunk)
      })
      return () => Buffer.concat(chunks).toString('utf8')
    }
    const stdout = collect('stdout')
    const stderr = collect('stderr')
    // Once all its output is read.
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      const out = stdout()
      const err = stderr()
      if (code === 0 && !ended) return done({ stdout: out, stderr: err })
      const overflowed = ended === 'stdout' || ended === 'stderr'
      fail(Object.assign(new Error(overflowed ? `${ended} maxBuffer length exceeded` : `Command failed: ${cmd}\n${err}`), {
        code: overflowed ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code, killed: ended !== undefined, signal, stdout: out, stderr: err, cmd,
      }))
    })
    // A command that could not be started, with spawn's own code: unheard, it would crash this process. Its `close`
    // follows, and finds the call settled.
    child.once('error', (error) => {
      clearTimeout(timer)
      fail(Object.assign(error, { cmd, killed: false, signal: null, stdout: '', stderr: '' }))
    })
    // Always ended, so a command that reads stdin never waits on it. One that exits before reading it all leaves the
    // write to fail (EPIPE), which is not the call's failure.
    child.stdin?.on('error', () => {}).end(input)
  })
}

/** Whether exec would find the file and the cwd: a path is looked at from the cwd, as exec sees it after the chdir. */
function startable(file: string, { cwd, env }: TiedOptions): boolean {
  if (cwd !== undefined && !isDirectory(cwd)) return false
  return resolveBinaryOnPath(file.includes('/') ? resolve(cwd ?? '', file) : file, env) !== null
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}
