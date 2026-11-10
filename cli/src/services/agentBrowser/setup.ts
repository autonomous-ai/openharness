/**
 * Setup puts Podman on a computer that has none, behind one password prompt the person asked for, and gives macOS the
 * machine Podman runs in. Each step is told to the caller before it starts, so a daemon restart resumes where it
 * stopped (spec § Setup: Harness installs Podman). Prior art: ai-assitant-sanbox
 * `electron/sandbox-runtime/installer.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { PodmanError, type Podman } from './podman.js'
import { PODMAN_RELEASE } from './podmanRelease.js'

export type SetupStep = 'installing' | 'starting_podman'

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
// Harness's own machine, made when the person's will not start (spec § Podman).
const OWN_MACHINE = 'harness'

// Folders only root can write on a Linux distribution.
const SYSTEM_DIRS = ['/usr/bin', '/usr/sbin', '/bin', '/sbin']

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

/** One argument for sh, whatever it holds. */
const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * What runs as root, after the person types the password: $1 is the downloaded pkg, $2 its pinned SHA-256. The pkg
 * sits in the person's own temp folder while the dialog is open, where any of their processes could swap it, so root
 * copies it into a folder only root can open, checks that copy and installs that copy (security review, 2026-11-10).
 */
const ROOT_INSTALL = [
  'umask 077',
  'dir=$(/usr/bin/mktemp -d /var/tmp/harness-podman.XXXXXXXX) || exit 1',
  'trap \'/bin/rm -rf "$dir"\' EXIT',
  '/bin/chmod 700 "$dir" || exit 1',
  '/bin/cp -- "$1" "$dir/podman.pkg" || exit 1',
  'sum=$(/usr/bin/shasum -a 256 "$dir/podman.pkg") || exit 1',
  'if [ "${sum%% *}" != "$2" ]; then echo "The Podman installer changed after its checksum" >&2; exit 3; fi',
  '/usr/sbin/installer -pkg "$dir/podman.pkg" -target /',
].join('; ')

/** The command is read by sh inside an AppleScript string: quoted for sh, then escaped for AppleScript. */
function macInstallScript(pkg: string, sha256: string): string {
  const command = ['/bin/sh', '-c', ROOT_INSTALL, 'harness-podman-install', pkg, sha256].map(shQuote).join(' ')
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
    hostMemoryBytes: number
    hostCpus: number
    step: (s: SetupStep | null) => void
  }) {}

  /** Throws PodmanError `podman_install_failed`, `podman_manual` or `podman_down`; the recorded step stays for Retry. */
  async run(from: { step: SetupStep | null }): Promise<void> {
    const { podman, platform, step } = this.deps
    // A Podman the person installed is never replaced, whatever its version.
    if (from.step !== 'starting_podman' && !(await podman.path())) await this.install()
    if (platform === 'darwin') await this.startPodman()
    step(null)
  }

  private async install(): Promise<void> {
    const { platform, arch } = this.deps
    if (!this.deps.interactive()) throw manual('No desktop session here to ask for the password')
    if (platform === 'linux') return await this.installLinux()
    const artifact = (PODMAN_RELEASE.artifacts as Partial<Record<string, { url: string; sha256: string }>>)[`${platform}-${arch}`]
    if (!artifact) throw manual(`No Podman installer for ${platform} ${arch}`)
    this.deps.step('installing')
    await this.withInstaller(artifact, async (pkg) => {
      const result = await this.deps.run('osascript', ['-e', macInstallScript(pkg, artifact.sha256)], { timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.code !== 0) throw installFailed('The Podman installer', result)
    })
  }

  /**
   * A tool pkexec runs as root must be one only root can change. `which` reads the person's login shell PATH, which any
   * of their processes can point at a folder of its own (security review, 2026-11-10).
   */
  private async systemTool(name: string): Promise<string | null> {
    const found = await this.deps.which(name)
    if (found && !SYSTEM_DIRS.includes(dirname(found))) throw manual(`${name} at ${found} is not in a system folder`)
    return found
  }

  private async installLinux(): Promise<void> {
    const pkexec = await this.systemTool('pkexec')
    if (!pkexec) throw manual('pkexec is not installed')
    for (const [name, args] of LINUX_MANAGERS) {
      const manager = await this.systemTool(name)
      if (!manager) continue
      this.deps.step('installing')
      const result = await this.deps.run(pkexec, [manager, ...args], { timeoutMs: INSTALL_TIMEOUT_MS })
      if (result.code !== 0) throw installFailed(`${name} install podman`, result)
      return
    }
    throw manual('No known package manager (apt-get, dnf, pacman, zypper)')
  }

  /**
   * The installer lives in a folder of its own, removed after use: a file that fails its checksum never reaches the
   * password dialog. Root checks it again on its own copy (ROOT_INSTALL).
   */
  private async withInstaller(artifact: { url: string; sha256: string }, use: (file: string) => Promise<void>): Promise<void> {
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
      await use(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * An existing machine is used as it is: none of its settings change. One that would not start is left alone, and
   * Harness makes its own beside it; the person's default connection stays theirs (spec § Podman).
   */
  private async startPodman(): Promise<void> {
    const { podman, hostMemoryBytes, hostCpus } = this.deps
    this.deps.step('starting_podman')
    try {
      const { stdout } = await podman.run(['machine', 'list', '--format', 'json'])
      const names = (JSON.parse(stdout) as Array<{ Name?: string }>).map(machine => machine.Name)
      const own = await this.usesOwnMachine(names)
      if (own) podman.useConnection(OWN_MACHINE)
      if (own ? !names.includes(OWN_MACHINE) : names.length === 0) {
        const init = ['machine', 'init', '--memory', String(Math.floor(Math.min(hostMemoryBytes / 2, MAX_MACHINE_MEMORY) / MiB)), '--cpus', String(Math.max(2, Math.floor(hostCpus / 2)))]
        await podman.run(own ? [...init, OWN_MACHINE] : init, { timeoutMs: MACHINE_INIT_TIMEOUT_MS })
      }
    } catch (error) {
      throw new PodmanError('podman_down', (error as Error).message)
    }
    await podman.startMachine()
  }

  /**
   * Whether Harness runs its own machine: it already has one, or the person's would not start. A machine of that name
   * is one an earlier setup made and was cut off before it was recorded. Its own function so the one await runs on
   * every call: an await inside a short-circuit left the next `if` with a negative implicit-else count under v8.
   */
  private async usesOwnMachine(names: Array<string | undefined>): Promise<boolean> {
    const { podman } = this.deps
    if (podman.connection() !== null || names.includes(OWN_MACHINE)) return true
    if (names.length === 0) return false
    const answer = await podman.available()
    return answer.state === 'needs_setup' && answer.ownMachine === true
  }
}
