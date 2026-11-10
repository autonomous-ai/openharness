/**
 * Setup puts Podman on a computer that has none, behind one password or UAC prompt the person asked for, and gives
 * macOS and Windows the machine Podman runs in. Each step is told to the caller before it starts, so a daemon or a
 * Windows restart resumes where it stopped (spec § Setup: Harness installs Podman). Prior art:
 * ai-assitant-sanbox `electron/sandbox-runtime/installer.ts`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BOOT_TOLERANCE_SEC } from '../../lib/bootId.js'
import { PodmanError, type Podman } from './podman.js'
import { PODMAN_RELEASE } from './podmanRelease.js'

export type SetupStep = 'installing' | 'starting_podman' | 'restart_needed'
export type SetupResult = 'done' | 'restart_needed'

type Run = (cmd: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
// The person types a password in this time too.
const INSTALL_TIMEOUT_MS = 10 * 60_000
const MACHINE_INIT_TIMEOUT_MS = 10 * 60_000
const GiB = 1024 ** 3
const MiB = 1024 ** 2
const MAX_MACHINE_MEMORY = 16 * GiB
// Enough of the installer's complaint to act on.
const MESSAGE_LIMIT = 500

const LINUX_MANAGERS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['apt-get', ['install', '-y', 'podman', 'uidmap', 'slirp4netns']],
  ['dnf', ['install', '-y', 'podman']],
  ['pacman', ['-S', '--noconfirm', 'podman']],
  ['zypper', ['--non-interactive', 'install', 'podman']],
]

/**
 * Setup's `interactive`: the password dialog shows only in a desktop session. A daemon started over SSH, or a Linux
 * one with no display, would wait on a dialog nobody can see.
 */
export function canAskForPassword(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.SSH_CONNECTION) return false
  return platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

const powershellQuoted = (text: string) => `'${text.replaceAll("'", "''")}'`

/** Runs elevated, hidden, behind the one UAC prompt: WSL 2 and the MSI both before any restart, so nothing asks again. */
function windowsScript(msi: string, enableWsl: boolean): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    ...(enableWsl ? ['wsl.exe --install --no-distribution', 'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'] : []),
    `$msi = Start-Process -FilePath msiexec.exe -ArgumentList '/i', ${powershellQuoted(`"${msi}"`)}, '/qn', '/norestart' -Wait -PassThru`,
    // 3010 is success that wants a restart; WSL's own restart step covers it.
    'if ($msi.ExitCode -ne 0 -and $msi.ExitCode -ne 3010) { exit $msi.ExitCode }',
    'exit 0',
  ].join('\r\n')
}

/**
 * The hidden PowerShell that raises the UAC prompt. The elevated one starts hidden too: the prompt is the only window.
 * A declined prompt throws, and `-Command` needs the catch to end with a failing code (docs/windows-rules.md § 2).
 */
function elevate(script: string): string {
  return 'try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ErrorAction Stop'
    + ` -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${powershellQuoted(`"${script}"`)}; exit $p.ExitCode }`
    + ' catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
}

/** The path is read by sh inside an AppleScript string: quoted for sh, then escaped for AppleScript. */
function macInstallScript(pkg: string): string {
  const command = `installer -pkg '${pkg.replaceAll("'", `'\\''`)}' -target /`
  return `do shell script "${command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    + ' with prompt "Harness needs your password to install Podman for Browser." with administrator privileges'
}

function installFailed(what: string, result: { code: number; stdout: string; stderr: string }): PodmanError {
  const said = (result.stderr.trim() || result.stdout.trim()).slice(-MESSAGE_LIMIT)
  return new PodmanError('podman_install_failed', `${what} exited ${result.code}${said ? `: ${said}` : ''}`)
}

const manual = (why: string) => new PodmanError('podman_manual', why)

export class Setup {
  constructor(private readonly deps: {
    podman: Podman
    platform: NodeJS.Platform
    arch: string
    download: (url: string, to: string, timeoutMs: number) => Promise<void>
    sha256: (file: string) => Promise<string>
    run: Run
    which: (cmd: string) => Promise<string | null>
    interactive: () => boolean
    /** When this boot began, in seconds (as lib/bootId.ts reads it). */
    bootTime: () => number
    hostMemoryBytes: number
    hostCpus: number
    step: (s: SetupStep | null, bootTime?: number) => void
  }) {}

  /** Throws PodmanError `podman_install_failed`, `podman_manual` or `podman_down`; the recorded step stays for Retry. */
  async run(from: { step: SetupStep | null; bootTime?: number }): Promise<SetupResult> {
    const { podman, platform, step } = this.deps
    let at = from.step
    if (at === 'restart_needed') {
      // A daemon restart alone must not resume: only a new boot has WSL 2 working.
      if (from.bootTime !== undefined && Math.abs(this.deps.bootTime() - from.bootTime) <= BOOT_TOLERANCE_SEC) return 'restart_needed'
      at = 'starting_podman'
    }
    // A Podman the person installed is never replaced, whatever its version.
    if (at !== 'starting_podman' && !(await podman.path()) && (await this.install()) === 'restart_needed') return 'restart_needed'
    if (platform === 'darwin' || platform === 'win32') await this.startPodman()
    step(null)
    return 'done'
  }

  private async install(): Promise<SetupResult> {
    const { platform, arch, step } = this.deps
    if (!this.deps.interactive()) throw manual('No desktop session here to ask for the password')
    if (platform === 'linux') return await this.installLinux()
    const artifact = (PODMAN_RELEASE.artifacts as Partial<Record<string, { url: string; sha256: string }>>)[`${platform}-${arch}`]
    if (!artifact) throw manual(`No Podman installer for ${platform} ${arch}`)
    if (platform === 'darwin') {
      step('installing')
      await this.withInstaller(artifact, async (pkg) => {
        const result = await this.deps.run('osascript', ['-e', macInstallScript(pkg)], { timeoutMs: INSTALL_TIMEOUT_MS })
        if (result.code !== 0) throw installFailed('The Podman installer', result)
      })
      return 'done'
    }
    const availability = await this.deps.podman.available()
    const enableWsl = availability.state === 'needs_setup' && availability.restart
    step('installing')
    await this.withInstaller(artifact, async (msi, dir) => {
      const script = join(dir, 'install-podman.ps1')
      await writeFile(script, windowsScript(msi, enableWsl))
      const result = await this.deps.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', elevate(script)], { timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.code !== 0) throw installFailed('The Podman installer', result)
    })
    if (!enableWsl) return 'done'
    step('restart_needed', this.deps.bootTime())
    return 'restart_needed'
  }

  private async installLinux(): Promise<SetupResult> {
    const pkexec = await this.deps.which('pkexec')
    if (!pkexec) throw manual('pkexec is not installed')
    for (const [name, args] of LINUX_MANAGERS) {
      const manager = await this.deps.which(name)
      if (!manager) continue
      this.deps.step('installing')
      const result = await this.deps.run(pkexec, [manager, ...args], { timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.code !== 0) throw installFailed(`${name} install podman`, result)
      return 'done'
    }
    throw manual('No known package manager (apt-get, dnf, pacman, zypper)')
  }

  /** The installer lives in a folder of its own, removed after use: a file that fails its checksum is never run. */
  private async withInstaller(artifact: { url: string; sha256: string }, use: (file: string, dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'harness-podman-'))
    try {
      const file = join(dir, basename(artifact.url))
      try {
        await this.deps.download(artifact.url, file, DOWNLOAD_TIMEOUT_MS)
      } catch (error) {
        throw new PodmanError('podman_install_failed', `The Podman installer did not download: ${(error as Error).message}`)
      }
      if ((await this.deps.sha256(file)) !== artifact.sha256) {
        throw new PodmanError('podman_install_failed', `The Podman installer failed its checksum (${basename(artifact.url)})`)
      }
      await use(file, dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /** An existing machine is used as it is: none of its settings change. */
  private async startPodman(): Promise<void> {
    const { podman, platform, hostMemoryBytes, hostCpus } = this.deps
    this.deps.step('starting_podman')
    try {
      const { stdout } = await podman.run(['machine', 'list', '--format', 'json'])
      if ((JSON.parse(stdout) as unknown[]).length === 0) {
        // A WSL machine ignores sizes, and only a rootful one can apply memory, CPU and process limits on current WSL.
        const init = platform === 'win32'
          ? ['machine', 'init', '--rootful']
          : ['machine', 'init', '--memory', String(Math.floor(Math.min(hostMemoryBytes / 2, MAX_MACHINE_MEMORY) / MiB)), '--cpus', String(Math.max(2, Math.floor(hostCpus / 2)))]
        await podman.run(init, { timeoutMs: MACHINE_INIT_TIMEOUT_MS })
      }
    } catch (error) {
      throw new PodmanError('podman_down', (error as Error).message)
    }
    await podman.startMachine()
  }
}
