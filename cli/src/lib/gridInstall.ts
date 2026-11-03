/**
 * Put `grid` on a machine that has none, with grid's own public installer.
 *
 * `harness login` used to CHECK for `grid` and, finding none, print "install the grid CLI yourself"
 * and skip the grid half of sign-in. Every fresh install — a new machine, a colleague's laptop —
 * landed there, and everything the Grid harness does shells out to `grid`, so on those
 * machines the Grid harness could only report that nothing was installed. The plan's answer
 * (`docs/plans/2026-09-14-004-harness-grid-plan.md`, Change 2c) is a signed, pinned managed
 * runtime, which is release-pipeline work nobody has done. This is the interim that closes the gap
 * today: run the installer grid itself publishes and maintains, `https://grid.autonomous.ai/install.sh`
 * — on macOS it installs `uv` if needed and `uv tool install`s the release wheel to
 * `~/.local/bin/grid`; on Linux it downloads the sha256-verified release binary to the same place.
 * Exactly the by-hand steps, run for the person.
 *
 * ⚠️ Best-effort, never a reason `harness start` or `harness login` fails. No `curl`, no network, a
 * refused download — every one is a sentence in the log and a daemon that runs as before. A
 * machine that already has `grid` is never touched by [ensureGridInstalled]; only Windows' pin
 * ([installGrid], `gridWindowsPin.ts`) installs over one.
 *
 * Idempotent and serialised: two callers (start and a login that follows it) share one in-flight
 * install rather than racing two installers into the same directory.
 */
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { delimiter, join, win32 } from 'node:path'
import { env } from '../config/env.js'
import { binaryOnPath } from './binaryOnPath.js'
import { withGridCallsPaused } from './gridCalls.js'
import { gridAvailable, isReleaseNumber } from './gridExec.js'

export const GRID_INSTALL_URL = 'https://grid.autonomous.ai/install.sh'

/** The Windows installer. Served from GitHub, not grid.autonomous.ai: that host serves install.sh only. */
export const GRID_INSTALL_PS1_URL = 'https://raw.githubusercontent.com/autonomous-ai/autonomous-grid/main/install.ps1'

/**
 * The program that runs the installer script. Windows has no bash; its installer is PowerShell, which
 * has `irm` built in (so no `curl` either). Windows PowerShell 5.1 ships with every supported Windows,
 * and is named by absolute path: `CreateProcess` searches the current folder first for a bare name.
 */
export function installerCommand(
  platform: NodeJS.Platform,
  script: string,
  environment: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  if (platform !== 'win32') return { file: 'bash', args: ['-c', script] }
  const root = environment.SystemRoot || 'C:\\Windows'
  return {
    file: win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  }
}

/**
 * grid's PowerShell installer, told which release to lay down when [version] is given. install.ps1 fails by `throw`;
 * caught here, its sentence is printed alone instead of inside PowerShell's error record.
 */
export function windowsInstallScript(version: string | null): string {
  const pinned = version ? `$env:GRID_VERSION='${version}'; ` : ''
  return `try { ${pinned}irm ${GRID_INSTALL_PS1_URL} | iex } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
}

/** Where grid's installer puts the binary on both platforms — the reason `gridBinaryPath` falls
 *  back to this directory when `~/.local/bin` is not on the daemon's PATH. */
export const GRID_INSTALL_DIR = join(homedir(), '.local', 'bin')

/** A download plus, on macOS, a `uv` bootstrap and a wheel install: minutes on a slow link, never
 *  hours. Past this the installer is killed and reported, not waited on forever. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

const MAX_CAPTURED_CHARS = 16 * 1024

export type GridInstallStatus =
  /** `grid` was already there; nothing ran. */
  | 'present'
  /** The installer ran and `grid` is now resolvable. */
  | 'installed'
  /** Not attempted: switched off, or no `curl` to fetch the installer with. */
  | 'skipped'
  /** The installer ran and failed, or ran and left no `grid` behind. */
  | 'failed'

export interface GridInstallResult {
  status: GridInstallStatus
  /** One sentence for the log or stderr. Never contains a credential — the installer takes none. */
  message: string
}

export interface GridInstallDeps {
  available: () => boolean
  curlOnPath: () => boolean
  /** Run the installer; resolves with its exit code and bounded output. Injected for the tests. */
  run: (script: string, timeoutMs: number) => Promise<{ exitCode: number; output: string }>
  enabled: boolean
  /** Defaults to this machine's. Injected so the Windows branch is tested on any OS. */
  platform?: NodeJS.Platform
  /** Windows: runs the installer with this process's grid calls held back ([withGridCallsPaused] unless injected). */
  pause?: <T>(install: () => Promise<T>) => Promise<T>
}

function capped(sofar: string, chunk: Buffer): string {
  return sofar.length >= MAX_CAPTURED_CHARS ? sofar : (sofar + chunk.toString()).slice(0, MAX_CAPTURED_CHARS)
}

/** The installer, piped to bash the way its README says, with `~/.local/bin` ahead on PATH so the
 *  `uv` it may have just installed is found by the same run. */
export function runInstaller(script: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const { file, args } = installerCommand(process.platform, script)
    const child = spawn(file, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${GRID_INSTALL_DIR}${delimiter}${process.env.PATH ?? ''}` },
    })
    let output = ''
    let settled = false
    const settle = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, output })
    }
    const timer = setTimeout(() => {
      output = capped(output, Buffer.from(`\n(installer killed after ${Math.round(timeoutMs / 60_000)} minutes)`))
      child.kill('SIGKILL')
      settle(124)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => { output = capped(output, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { output = capped(output, chunk) })
    child.on('error', (err) => { output = capped(output, Buffer.from(err.message)); settle(1) })
    child.on('close', (code) => settle(code ?? 1))
  })
}

export const defaultGridInstallDeps: GridInstallDeps = {
  available: () => gridAvailable(),
  curlOnPath: () => binaryOnPath('curl'),
  run: runInstaller,
  enabled: !env.DISABLE_GRID_INSTALL,
}

let inFlight: Promise<GridInstallResult> | null = null

/**
 * Make sure this machine has `grid`, installing it when it does not. Safe to call from anywhere and
 * as often as wanted: a machine that has it answers at once, and concurrent callers share one run.
 */
export function ensureGridInstalled(deps: GridInstallDeps = defaultGridInstallDeps): Promise<GridInstallResult> {
  if (deps.available()) return Promise.resolve({ status: 'present', message: '`grid` is installed' })
  return installGrid(null, deps)
}

/**
 * Run grid's installer, whether or not `grid` is already there: the latest release, or — on Windows, where
 * Harness follows its pin this way (`gridWindowsPin.ts`) — [version], over the grid already installed.
 * Shares one in-flight run with [ensureGridInstalled].
 */
export function installGrid(version: string | null, deps: GridInstallDeps = defaultGridInstallDeps): Promise<GridInstallResult> {
  if (!deps.enabled) return Promise.resolve({ status: 'skipped', message: 'grid install is switched off (DISABLE_GRID_INSTALL)' })
  // It goes into a PowerShell line: a plain release number, nothing else.
  if (version !== null && !isReleaseNumber(version)) {
    return Promise.resolve({ status: 'skipped', message: `not a grid release number: ${JSON.stringify(version)}` })
  }
  const windows = (deps.platform ?? process.platform) === 'win32'
  if (!windows && !deps.curlOnPath()) {
    return Promise.resolve({ status: 'skipped', message: 'no `grid` on this machine and no `curl` to fetch its installer with — install it from ' + GRID_INSTALL_URL })
  }
  if (inFlight) return inFlight
  inFlight = (async (): Promise<GridInstallResult> => {
    try {
      const script = windows ? windowsInstallScript(version) : `curl -fsSL ${GRID_INSTALL_URL} | bash`
      // On Windows, with no grid call of this process running: a running grid makes install.ps1 refuse, and one
      // started while it replaces files breaks the install (gridCalls.ts).
      const run = () => deps.run(script, INSTALL_TIMEOUT_MS)
      const { exitCode, output } = windows ? await (deps.pause ?? withGridCallsPaused)(run) : await run()
      const tail = output.trim().split('\n').map((line) => line.trimEnd()).slice(-3).join(' · ').replace(/\[[0-9;]*m/g, '')
      if (exitCode !== 0) {
        return { status: 'failed', message: `grid installer exited ${exitCode}${tail ? ` · ${tail}` : ''}` }
      }
      if (!deps.available()) {
        return { status: 'failed', message: `grid installer finished but left no \`grid\` in ${GRID_INSTALL_DIR}${tail ? ` · ${tail}` : ''}` }
      }
      return { status: 'installed', message: `installed \`grid\` to ${GRID_INSTALL_DIR}` }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}
