/**
 * The one way the agent browser runs Podman: where it is, whether it can run a browser, and every call to it, each
 * with a timeout and started without a window (docs/windows-rules.md, rule 1). Harness runs `podman` only, never
 * `docker`.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import { oneShotParentEnv } from '../../lib/loginShellEnv.js'
import { resolveViaLoginShell } from '../../lib/tmuxOnPath.js'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'

export class PodmanError extends Error {
  constructor(readonly state: string, message: string) {
    super(message)
    this.name = 'PodmanError'
  }
}

export type Availability =
  | { state: 'ready' }
  | { state: 'stopped' }
  | { state: 'needs_setup'; restart: boolean }
  | { state: 'podman_old' }
  | { state: 'podman_memory' }

export interface Podman {
  path(): Promise<string | null>
  run(args: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<{ stdout: string; stderr: string }>
  spawn(args: string[]): ChildProcess
  available(): Promise<Availability>
  startMachine(): Promise<void>
  memoryBytes(): Promise<number>
}

const RUN_TIMEOUT_MS = 30_000
const INFO_TIMEOUT_MS = 5_000
const MACHINE_START_TIMEOUT_MS = 10 * 60_000
const AVAILABLE_CACHE_MS = 60_000
const WSL_STATUS_TIMEOUT_MS = 10_000
// One browser is capped at 2 GiB, and Podman's VM needs room beside it.
const MIN_MEMORY_BYTES = 3 * 1024 ** 3
const MIN_VERSION: readonly [number, number] = [4, 6]
// Enough of Podman's complaint to act on, never a whole build log.
const MESSAGE_LIMIT = 2_000
// An image build prints a line per package it installs, past execFile's 1 MB default, which kills the child.
const OUTPUT_LIMIT = 64 * 1024 * 1024

/** Where Podman's own installers put it, for a daemon whose login shell does not have it on PATH yet. */
function installedPaths(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/opt/podman/bin/podman']
  if (platform === 'win32') return [win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'RedHat', 'Podman', 'podman.exe')]
  return []
}

/** WSL 2 answers `wsl --status` with 0; a Windows without it, or with only the inbox stub, does not. */
function wslInstalled(): Promise<boolean> {
  return new Promise(resolve => {
    execFile('wsl.exe', ['--status'], { timeout: WSL_STATUS_TIMEOUT_MS, ...ownProcessGroup('win32') }, error => resolve(!error))
  })
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
  wsl2?: () => Promise<boolean>
  now?: () => number
} = {}): Podman {
  const resolve = deps.resolve ?? resolveViaLoginShell
  const exists = deps.exists ?? existsSync
  const platform = deps.platform ?? process.platform
  const wsl2 = deps.wsl2 ?? wslInstalled
  const now = deps.now ?? Date.now
  // Kept once found; looked for again while missing, since setup may have just installed it.
  let found: string | null = null
  let cached: { at: number; answer: Promise<Availability> } | null = null

  async function path(): Promise<string | null> {
    found ??= (await resolve('podman')) ?? installedPaths(platform).find(candidate => exists(candidate)) ?? null
    return found
  }

  async function run(args: string[], opts: { timeoutMs?: number; stdin?: string } = {}): Promise<{ stdout: string; stderr: string }> {
    const file = await path()
    if (!file) throw new PodmanError('needs_setup', 'Podman is not installed')
    const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS
    return await new Promise((done, fail) => {
      // The daemon was started by launchd or systemd, not a shell: the login shell's environment is what the
      // person's own `podman` sees (its machine connections, its helpers on PATH).
      const child = execFile(file, args, { env: oneShotParentEnv(), timeout: timeoutMs, maxBuffer: OUTPUT_LIMIT, ...ownProcessGroup() }, (error, stdout, stderr) => {
        if (!error) return done({ stdout, stderr })
        fail(new PodmanError('podman_failed', error.killed
          ? `podman ${args[0]} timed out after ${timeoutMs} ms`
          : `podman ${args[0]} failed: ${stderr.trim().slice(-MESSAGE_LIMIT)}`))
      })
      // Always closed, so a command that reads stdin never waits on it.
      child.stdin?.end(opts.stdin)
    })
  }

  async function readInfo(): Promise<{ version: string; memTotal: number }> {
    const { stdout } = await run(['info', '--format', 'json'], { timeoutMs: INFO_TIMEOUT_MS })
    const info = parsed<{ version?: { Version?: string }; host?: { memTotal?: number } }>(stdout, 'info')
    return { version: String(info.version?.Version ?? ''), memTotal: Number(info.host?.memTotal ?? 0) }
  }

  async function measure(): Promise<Availability> {
    if (!(await path())) return { state: 'needs_setup', restart: platform === 'win32' && !(await wsl2()) }
    const info = await readInfo().catch(() => null)
    if (info) {
      if (!versionAtLeast(info.version)) return { state: 'podman_old' }
      return info.memTotal < MIN_MEMORY_BYTES ? { state: 'podman_memory' } : { state: 'ready' }
    }
    // Only macOS and Windows run Podman in a machine; on Linux an unanswered info is Podman itself down.
    if (platform === 'darwin' || platform === 'win32') {
      const { stdout } = await run(['machine', 'list', '--format', 'json'])
      const machines = parsed<Array<{ Running?: boolean }>>(stdout, 'machine list')
      // Podman is here and has no machine: setup's machine steps make one.
      if (machines.length === 0) return { state: 'needs_setup', restart: false }
      if (!machines.some(machine => machine.Running)) return { state: 'stopped' }
    }
    throw new PodmanError('podman_down', 'Podman is not running')
  }

  return {
    path,
    run,
    spawn(args) {
      if (!found) throw new PodmanError('needs_setup', 'Podman is not installed')
      return spawn(found, args, { env: oneShotParentEnv(), stdio: 'pipe', ...ownProcessGroup() })
    },
    available() {
      if (cached && now() - cached.at < AVAILABLE_CACHE_MS) return cached.answer
      cached = { at: now(), answer: measure() }
      return cached.answer
    },
    async startMachine() {
      cached = null
      try {
        await run(['machine', 'start'], { timeoutMs: MACHINE_START_TIMEOUT_MS })
      } catch (error) {
        // Two browsers can find the machine stopped at once; the second start is then told it already runs.
        if (/already running/i.test((error as Error).message)) return
        throw new PodmanError('podman_down', (error as Error).message)
      }
    },
    async memoryBytes() {
      return (await readInfo()).memTotal
    },
  }
}
