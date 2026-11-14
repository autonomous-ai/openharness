/**
 * The one way the agent browser runs Podman: where it is, whether it can run a browser, and every call to it, each
 * with a timeout, started without a window (docs/windows-rules.md, rule 1) and ended with this process (./tied.ts).
 * Harness runs `podman` only, never `docker`.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { oneShotParentEnv } from '../../lib/loginShellEnv.js'
import { resolveViaLoginShell } from '../../lib/tmuxOnPath.js'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'
import { spawnTied } from './tied.js'

export class PodmanError extends Error {
  /** A call that exited with an error: all it printed, stdout then stderr. A build's RUN steps print to stdout. */
  constructor(readonly state: string, message: string, readonly output?: string) {
    super(message)
    this.name = 'PodmanError'
  }
}

export type Availability =
  | { state: 'ready' }
  | { state: 'stopped' }
  // ownMachine: Podman is here and the person's machine would not start; setup makes Harness's own beside it.
  | { state: 'needs_setup'; ownMachine?: true }
  | { state: 'podman_old' }
  | { state: 'podman_memory' }

export interface Podman {
  path(): Promise<string | null>
  run(args: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string }>
  /** Throws `needs_setup` until Podman has been found. */
  spawn(args: string[]): ChildProcess
  available(): Promise<Availability>
  startMachine(): Promise<void>
  memoryBytes(): Promise<number>
  /** The connection every call but `machine` runs on: null for the person's default one. */
  connection(): string | null
  /** From now on every call runs on that connection, and machine commands act on its machine. */
  useConnection(name: string): void
}

const RUN_TIMEOUT_MS = 30_000
const INFO_TIMEOUT_MS = 5_000
const MACHINE_START_TIMEOUT_MS = 10 * 60_000
const AVAILABLE_CACHE_MS = 60_000
// One browser is capped at 2 GiB, and Podman's VM needs room beside it.
const MIN_MEMORY_BYTES = 3 * 1024 ** 3
const MIN_VERSION: readonly [number, number] = [4, 6]
const MiB = 1024 ** 2
// Enough of Podman's complaint to act on, never a whole build log.
const MESSAGE_LIMIT = 2_000
// An image build prints a line per package it installs, megabytes of it. A call that prints more than this on stdout or
// on stderr is ended, and fails saying so.
export const OUTPUT_LIMIT = 64 * MiB
// `cat | podman …` with podman ($0 "$@") ended by the shell when a timeout ends the shell, never left running. In the
// background so the trap runs at once; stdin is kept on fd 3, since a background list's own stdin is /dev/null. The
// trap is set first and `ended` looked at once podman is started, so a timeout before then still ends it. The shell
// exits only after waiting for both (`wait` again after the trap): a run that failed on its timeout left podman
// unreaped behind it, and a spec's teardown deleted the fake's folder under it (CI, 2026-11-10). The tie's SIGTERM
// (./tied.ts) reaches this shell too, and its trap ends podman.
const STDIN_RELAY = `trap 'ended=1; kill $! 2>/dev/null' TERM; exec 3<&0; cat <&3 | "$0" "$@" 3<&- & [ -z "$ended" ] || kill $!; wait $!; s=$?; until wait; do :; done; exit $s`

/** Where Podman's own installers put it, for a daemon whose login shell does not have it on PATH yet. */
function installedPaths(platform: NodeJS.Platform): string[] {
  return platform === 'darwin' ? ['/opt/podman/bin/podman'] : []
}

function parsed<T>(stdout: string, command: string): T {
  try { return JSON.parse(stdout) as T } catch { throw new PodmanError('podman_failed', `podman ${command} did not answer in JSON`) }
}

function versionAtLeast(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(part => Number.parseInt(part, 10))
  return major > MIN_VERSION[0] || (major === MIN_VERSION[0] && minor >= MIN_VERSION[1])
}

export function createPodman(deps: {
  resolve?: (cmd: string) => Promise<string | null>
  exists?: (path: string) => boolean
  platform?: NodeJS.Platform
  now?: () => number
  /** Bytes, for stdout and for stderr each. */
  outputLimit?: number
} = {}): Podman {
  const resolve = deps.resolve ?? resolveViaLoginShell
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const now = deps.now ?? Date.now
  const outputLimit = deps.outputLimit ?? OUTPUT_LIMIT
  // Kept once found; looked for again while missing, since setup may have just installed it.
  let found: string | null = null
  let cached: { at: number; answer: Promise<Availability> } | null = null
  let connection: string | null = null
  // The person's machine failed to start. Kept in memory only: after a daemon restart one more start is tried.
  let wontStart = false
  /** A machine command's own argument: Harness's machine by name, or none for the person's default machine. */
  const machine = () => (connection ? [connection] : [])
  // Machine commands act on a machine by name and run on the host, never through a connection.
  const onConnection = (args: string[]) => (connection && args[0] !== 'machine' ? ['--connection', connection, ...args] : args)

  async function path(): Promise<string | null> {
    found ??= (await resolve('podman')) ?? installedPaths(platform).find(candidate => exists(candidate)) ?? null
    return found
  }

  async function run(args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    const file = await path()
    if (!file) throw new PodmanError('needs_setup', 'Podman is not installed')
    const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS
    // Podman 4 reads `secret create … -` only from a real pipe (cmd/podman/secrets/create.go, v4.9.3: "if `-` is
    // used, data must be passed into stdin" unless stdin is os.ModeNamedPipe), and Node hands a child a socket on
    // macOS and Linux. `cat` relays the data into a pipe the shell makes. Windows' stdio is already a named pipe.
    const relay = opts.stdin !== undefined && platform !== 'win32'
    const [command, commandArgs] = relay ? ['/bin/sh', ['-c', STDIN_RELAY, file, ...onConnection(args)]] : [file, onConnection(args)]
    return await new Promise((done, fail) => {
      // The daemon was started by launchd or systemd, not a shell: the login shell's environment is what the
      // person's own `podman` sees (its machine connections, its helpers on PATH). In this process's group, as
      // under execFile, which never applied a group of its own.
      const child = spawnTied(command, commandArgs, { env: oneShotParentEnv(), windowsHide: true, platform })
      // The first reason to end the call names its failure.
      let ended: string | undefined
      // Its pipes go first, then the command: something it started (a helper `machine start` leaves) may still hold
      // them, and the call must not wait on it.
      const end = (why: string) => {
        ended ??= why
        child.stdout!.destroy()
        child.stderr!.destroy()
        child.kill()
      }
      const timer = setTimeout(() => end(`timed out after ${timeoutMs} ms`), timeoutMs)
      // Bytes, decoded once: a character of several bytes can fall across two reads.
      const collect = (stream: Readable) => {
        const chunks: Buffer[] = []
        let bytes = 0
        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > outputLimit) end(`printed more than ${outputLimit / MiB} MiB`)
          else chunks.push(chunk)
        })
        return () => Buffer.concat(chunks).toString('utf8')
      }
      const stdout = collect(child.stdout!)
      const stderr = collect(child.stderr!)
      const settle = (code: number | null) => {
        clearTimeout(timer)
        if (ended) return fail(new PodmanError('podman_failed', `podman ${args[0]} ${ended}`))
        const out = stdout()
        const err = stderr()
        if (code === 0) return done({ stdout: out, stderr: err })
        fail(new PodmanError('podman_failed', `podman ${args[0]} failed: ${err.trim().slice(-MESSAGE_LIMIT)}`, `${out.trimEnd()}\n${err.trimEnd()}`.trim()))
      }
      // Once all its output is read. An error is a command that could not be started; unheard, it would crash this
      // process.
      child.once('close', settle)
      child.once('error', () => settle(null))
      // Always closed, so a command that reads stdin never waits on it.
      child.stdin!.end(opts.stdin)
    })
  }

  async function readInfo(): Promise<{ version: string; memTotal: number }> {
    const { stdout } = await run(['info', '--format', 'json'], { timeoutMs: INFO_TIMEOUT_MS })
    const info = parsed<{ version?: { Version?: string }; host?: { memTotal?: number } }>(stdout, 'info')
    return { version: String(info.version?.Version ?? ''), memTotal: Number(info.host?.memTotal ?? 0) }
  }

  async function measure(): Promise<Availability> {
    if (!(await path())) return { state: 'needs_setup' }
    const info = await readInfo().catch(() => null)
    if (info) {
      if (!versionAtLeast(info.version)) return { state: 'podman_old' }
      return info.memTotal < MIN_MEMORY_BYTES ? { state: 'podman_memory' } : { state: 'ready' }
    }
    // Only macOS runs Podman in a machine; on Linux an unanswered info is Podman itself down.
    if (platform === 'darwin') {
      const { stdout } = await run(['machine', 'list', '--format', 'json'])
      const listed = parsed<Array<{ Name?: string; Running?: boolean }>>(stdout, 'machine list')
      const own = machine()[0]
      const machines = own ? listed.filter(listing => listing.Name === own) : listed
      // Podman is here and has no machine (or Harness's own is gone): setup's machine steps make one.
      if (machines.length === 0) return { state: 'needs_setup' }
      if (!machines.some(listing => listing.Running)) return wontStart ? { state: 'needs_setup', ownMachine: true } : { state: 'stopped' }
    }
    throw new PodmanError('podman_down', 'Podman is not running')
  }

  return {
    path,
    run,
    spawn(args) {
      if (!found) throw new PodmanError('needs_setup', 'Podman is not installed')
      // Tied to this process: a crash of it left its `podman events` running, one more per restart.
      return spawnTied(found, onConnection(args), { env: oneShotParentEnv(), ...ownProcessGroup(), platform })
    },
    available() {
      if (cached && now() - cached.at < AVAILABLE_CACHE_MS) return cached.answer
      cached = { at: now(), answer: measure() }
      return cached.answer
    },
    async startMachine() {
      cached = null
      try {
        await run(['machine', 'start', ...machine()], { timeoutMs: MACHINE_START_TIMEOUT_MS })
      } catch (error) {
        // Two browsers can find the machine stopped at once; the second start is then told it already runs.
        if (/already running/i.test((error as Error).message)) return
        if (connection) throw new PodmanError('podman_down', (error as Error).message)
        // Harness never repairs or removes the person's machine: setup makes one of its own instead.
        wontStart = true
        throw new PodmanError('needs_setup', (error as Error).message)
      }
    },
    async memoryBytes() {
      try {
        return (await readInfo()).memTotal
      } catch (error) {
        if (platform !== 'darwin') throw error
        // A stopped machine answers no info: its size is in its own configuration, in MiB (measured in the spike).
        const { stdout } = await run(['machine', 'inspect', ...machine()])
        const [inspected] = parsed<Array<{ Resources?: { Memory?: number } }>>(stdout, 'machine inspect')
        return Number(inspected?.Resources?.Memory ?? 0) * MiB
      }
    },
    connection: () => connection,
    useConnection(name) {
      connection = name
      cached = null
    },
  }
}
