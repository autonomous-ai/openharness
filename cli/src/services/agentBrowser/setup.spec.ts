import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Availability, Podman } from './podman.js'
import { PodmanError } from './podman.js'
import { PODMAN_RELEASE } from './podmanRelease.js'
import { canAskForPassword, Setup, type SetupStep } from './setup.js'

const GiB = 1024 ** 3
const TEN_MINUTES = 10 * 60_000

interface Rig {
  platform?: NodeJS.Platform
  arch?: string
  installed?: boolean
  machines?: unknown[]
  /** The person's machine would not start (podman.ts remembers it). */
  ownMachine?: boolean
  /** The connection Podman already runs on, from the state file. */
  connection?: string
  checksum?: string
  downloadFails?: string
  runCode?: (cmd: string) => number
  runStderr?: string
  runStdout?: string
  /** Stands in for the privilege step: what the run of osascript or pkexec does instead. */
  onRun?: (cmd: string, args: string[]) => { code: number; stdout: string; stderr: string }
  which?: string[]
  /** Where `which` finds each tool; /usr/bin unless said. */
  whichDir?: string
  interactive?: boolean
  hostMemoryBytes?: number
  hostCpus?: number
}

/** Every dependency of Setup as a fake: nothing here installs, downloads or elevates anything. */
function rig(options: Rig = {}) {
  const platform = options.platform ?? 'darwin'
  const downloads: Array<{ url: string; to: string; timeoutMs: number }> = []
  const runs: Array<{ cmd: string; args: string[]; timeoutMs: number }> = []
  const steps: Array<SetupStep | null> = []
  const podmanRuns: string[][] = []
  // The connection each machine start ran on.
  const startedOn: Array<string | null> = []
  let connection = options.connection ?? null
  const podman = {
    path: async () => (options.installed ? '/opt/podman/bin/podman' : null),
    run: vi.fn(async (args: string[], _opts?: { timeoutMs?: number }) => {
      podmanRuns.push(args)
      return { stdout: args[1] === 'list' ? JSON.stringify(options.machines ?? []) : '', stderr: '' }
    }),
    spawn: () => { throw new Error('setup never spawns') },
    available: async (): Promise<Availability> => ({ state: 'needs_setup', ...(options.ownMachine ? { ownMachine: true as const } : {}) }),
    startMachine: vi.fn(async () => { podmanRuns.push(['machine', 'start']); startedOn.push(connection) }),
    memoryBytes: async () => 0,
    connection: () => connection,
    useConnection: vi.fn((name: string) => { connection = name }),
  } satisfies Podman
  const setup = new Setup({
    podman,
    platform,
    arch: options.arch ?? 'arm64',
    download: async (url, to, timeoutMs) => {
      downloads.push({ url, to, timeoutMs })
      if (options.downloadFails) throw new Error(options.downloadFails)
      writeFileSync(to, 'installer')
    },
    sha256: async () => options.checksum ?? Object.values(PODMAN_RELEASE.artifacts).find(a => a.url === downloads.at(-1)!.url)!.sha256,
    run: async (cmd, args, opts) => {
      runs.push({ cmd, args, timeoutMs: opts.timeoutMs })
      if (options.onRun) return options.onRun(cmd, args)
      return { code: options.runCode?.(cmd) ?? 0, stdout: options.runStdout ?? '', stderr: options.runStderr ?? '' }
    },
    which: async cmd => ((options.which ?? []).includes(cmd) ? `${options.whichDir ?? '/usr/bin'}/${cmd}` : null),
    interactive: () => options.interactive ?? true,
    hostMemoryBytes: options.hostMemoryBytes ?? 16 * GiB,
    hostCpus: options.hostCpus ?? 8,
    step: (s) => { steps.push(s) },
  })
  return { setup, podman, downloads, runs, steps, podmanRuns, startedOn }
}

/**
 * Runs the shell command inside osascript's `do shell script "…"` as the test's own user, with a fake `installer`
 * that records what it was given. Nothing here elevates or installs anything.
 */
function fakeRoot(before: () => void) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-setup-spec-'))
  const bin = join(dir, 'bin')
  const log = join(dir, 'log')
  spawnSync('/bin/mkdir', [bin, log])
  writeFileSync(join(bin, 'installer'), `#!/bin/sh
printf '%s\\n' "$@" > '${log}/args'
/bin/ls -ld "$(dirname "$2")" > '${log}/dir'
/bin/cat "$2" > '${log}/bytes'
`)
  chmodSync(join(bin, 'installer'), 0o755)
  const onRun = (cmd: string, args: string[]) => {
    expect(cmd).toBe('osascript')
    const quoted = /^do shell script "((?:[^"\\]|\\.)*)" with prompt /.exec(args[1]!)
    expect(quoted).not.toBeNull()
    const command = quoted![1]!.replace(/\\(.)/g, '$1').replaceAll('/usr/sbin/installer', join(bin, 'installer'))
    before()
    // A bare `installer` would find the fake too: the test never reaches a real one.
    const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } })
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
  }
  const read = (name: string) => (existsSync(join(log, name)) ? readFileSync(join(log, name), 'utf8') : null)
  return { onRun, read, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The pinned digest, for the length of one test, is the digest of the bytes the fake download writes. */
async function pinnedTo(bytes: string, work: () => Promise<void>): Promise<void> {
  const artifact = PODMAN_RELEASE.artifacts['darwin-arm64']
  const pinned = artifact.sha256
  artifact.sha256 = createHash('sha256').update(bytes).digest('hex')
  try { await work() } finally { artifact.sha256 = pinned }
}

const failure = async (work: Promise<unknown>): Promise<PodmanError> => {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(PodmanError)
  return error as PodmanError
}

describe('PODMAN_RELEASE', () => {
  it('pins one official Podman 5 release, each file with its SHA-256', () => {
    expect(PODMAN_RELEASE.version).toMatch(/^5\.\d+\.\d+$/)
    for (const artifact of Object.values(PODMAN_RELEASE.artifacts)) {
      expect(artifact.url.startsWith(`https://github.com/podman-container-tools/podman/releases/download/v${PODMAN_RELEASE.version}/`)).toBe(true)
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('Setup', () => {
  it('macOS installs the pkg through osascript with administrator privileges', async () => {
    const r = rig({ platform: 'darwin', arch: 'arm64' })
    await r.setup.run({ step: null })
    expect(r.downloads).toEqual([{ url: PODMAN_RELEASE.artifacts['darwin-arm64'].url, to: expect.stringMatching(/podman-installer-macos-arm64\.pkg$/), timeoutMs: TEN_MINUTES }])
    expect(r.runs).toHaveLength(1)
    expect(r.runs[0]!.cmd).toBe('osascript')
    expect(r.runs[0]!.timeoutMs).toBe(TEN_MINUTES)
    expect(r.runs[0]!.args[0]).toBe('-e')
    expect(r.runs[0]!.args[1]).toMatch(/^do shell script ".*" with prompt "Harness needs your password to install Podman for Browser\." with administrator privileges$/)
    expect(existsSync(r.downloads[0]!.to)).toBe(false)
    expect(r.steps[0]).toBe('installing')
  })

  it('the root step installs, from a root-only copy, exactly the bytes it verified, and removes the copy', async () => {
    await pinnedTo('installer', async () => {
      const root = fakeRoot(() => {})
      try {
        const r = rig({ onRun: root.onRun })
        await r.setup.run({ step: null })
        const [flag, pkg, target, to] = root.read('args')!.trimEnd().split('\n')
        expect([flag, target, to]).toEqual(['-pkg', '-target', '/'])
        expect(dirname(pkg!)).not.toBe(dirname(r.downloads[0]!.to))
        expect(root.read('dir')).toMatch(/^drwx------[@+.]? /)
        expect(root.read('bytes')).toBe('installer')
        expect(existsSync(dirname(pkg!))).toBe(false)
      } finally {
        root.cleanup()
      }
    })
  })

  it('a pkg swapped while the password dialog is open is refused and nothing is installed', async () => {
    await pinnedTo('installer', async () => {
      let swapped = ''
      const root = fakeRoot(() => { writeFileSync(swapped, 'not the installer') })
      try {
        const r = rig({ onRun: (cmd, args) => { swapped = r.downloads[0]!.to; return root.onRun(cmd, args) } })
        const error = await failure(r.setup.run({ step: null }))
        expect(error.state).toBe('podman_install_failed')
        expect(error.message).toContain('The Podman installer changed after its checksum')
        expect(root.read('args')).toBeNull()
        expect(r.podmanRuns).toEqual([])
      } finally {
        root.cleanup()
      }
    })
  })

  it('an Intel Mac gets the amd64 pkg', async () => {
    const r = rig({ platform: 'darwin', arch: 'x64' })
    await r.setup.run({ step: null })
    expect(r.downloads[0]!.url).toBe(PODMAN_RELEASE.artifacts['darwin-x64'].url)
  })

  it('a bad checksum deletes the file and fails podman_install_failed', async () => {
    const r = rig({ checksum: '0'.repeat(64) })
    expect((await failure(r.setup.run({ step: null }))).state).toBe('podman_install_failed')
    expect(r.runs).toEqual([])
    expect(existsSync(r.downloads[0]!.to)).toBe(false)
  })

  it('a failed download is podman_install_failed', async () => {
    const r = rig({ downloadFails: 'socket hang up' })
    const error = await failure(r.setup.run({ step: null }))
    expect(error.state).toBe('podman_install_failed')
    expect(error.message).toContain('socket hang up')
    expect(r.runs).toEqual([])
  })

  it('a cancelled password dialog is podman_install_failed', async () => {
    const r = rig({ runCode: () => 1, runStderr: '0:89: execution error: User canceled. (-128)\n' })
    const error = await failure(r.setup.run({ step: null }))
    expect(error.state).toBe('podman_install_failed')
    expect(error.message).toContain('User canceled')
    expect(r.podmanRuns).toEqual([])
  })

  it('Linux uses pkexec with the distro\'s package manager', async () => {
    const managers: Array<[string, string[]]> = [
      ['apt-get', ['install', '-y', 'podman', 'uidmap', 'slirp4netns']],
      ['dnf', ['install', '-y', 'podman']],
      ['pacman', ['-S', '--noconfirm', 'podman']],
      ['zypper', ['--non-interactive', 'install', 'podman']],
    ]
    for (const [index, [manager, args]] of managers.entries()) {
      // Every manager after this one is present too: the first in the list wins.
      const r = rig({ platform: 'linux', which: ['pkexec', ...managers.slice(index).map(([name]) => name)] })
      await r.setup.run({ step: null })
      expect(r.runs).toEqual([{ cmd: '/usr/bin/pkexec', args: [`/usr/bin/${manager}`, ...args], timeoutMs: TEN_MINUTES }])
      expect(r.downloads).toEqual([])
    }
    const dismissed = rig({ platform: 'linux', which: ['pkexec', 'dnf'], runCode: () => 126 })
    expect((await failure(dismissed.setup.run({ step: null }))).message).toBe('dnf install podman exited 126')
    const missing = rig({ platform: 'linux', which: ['pkexec', 'apt-get'], runCode: () => 100, runStdout: 'E: Unable to locate package podman\n' })
    const error = await failure(missing.setup.run({ step: null }))
    expect(error.state).toBe('podman_install_failed')
    expect(error.message).toBe('apt-get install podman exited 100: E: Unable to locate package podman')
  })

  it('Linux never runs as root a tool found outside the system folders', async () => {
    for (const whichDir of ['/home/me/.local/bin', '/usr/local/bin', '/usr/bin/../../tmp']) {
      const r = rig({ platform: 'linux', which: ['pkexec', 'apt-get'], whichDir })
      expect((await failure(r.setup.run({ step: null }))).state).toBe('podman_manual')
      expect(r.runs).toEqual([])
    }
  })

  it('no way to ask is podman_manual', async () => {
    for (const options of [
      { platform: 'linux', which: ['apt-get'] },
      { platform: 'linux', which: ['pkexec'] },
      { platform: 'darwin', interactive: false },
      { platform: 'linux', which: ['pkexec', 'apt-get'], interactive: false },
      { platform: 'darwin', arch: 'ia32' },
    ] satisfies Rig[]) {
      const r = rig(options)
      expect((await failure(r.setup.run({ step: null }))).state).toBe('podman_manual')
      expect(r.runs).toEqual([])
      expect(r.downloads).toEqual([])
      expect(r.steps).toEqual([])
    }
  })

  it('machine init when there is none', async () => {
    const mac = rig({ platform: 'darwin', installed: true, hostMemoryBytes: 16 * GiB, hostCpus: 10 })
    await mac.setup.run({ step: null })
    expect(mac.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--memory', '8192', '--cpus', '5'], ['machine', 'start']])
    expect(mac.podman.run.mock.calls[1]![1]).toEqual({ timeoutMs: TEN_MINUTES })
    expect(mac.steps).toEqual(['starting_podman', null])

    const big = rig({ platform: 'darwin', installed: true, hostMemoryBytes: 64 * GiB, hostCpus: 2 })
    await big.setup.run({ step: null })
    expect(big.podmanRuns[1]).toEqual(['machine', 'init', '--memory', '16384', '--cpus', '2'])
  })

  it('a machine that will not be made is podman_down', async () => {
    const r = rig({ installed: true })
    r.podman.run.mockRejectedValueOnce(new PodmanError('podman_failed', 'podman machine failed: no space left'))
    const error = await failure(r.setup.run({ step: null }))
    expect(error.state).toBe('podman_down')
    expect(error.message).toContain('no space left')
  })

  it('an existing machine is never changed', async () => {
    const r = rig({ platform: 'darwin', installed: true, machines: [{ Name: 'podman-machine-default', Running: false }] })
    await r.setup.run({ step: null })
    expect(r.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'start']])
  })

  it('setup then inits and starts a machine named harness, and never runs start, set, rm or reset on the other one', async () => {
    const person = [{ Name: 'podman-machine-default', Running: false }]
    const mac = rig({ platform: 'darwin', installed: true, machines: person, ownMachine: true, hostMemoryBytes: 16 * GiB, hostCpus: 10 })
    await mac.setup.run({ step: null })
    expect(mac.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--memory', '8192', '--cpus', '5', 'harness'], ['machine', 'start']])
    expect(mac.podman.run.mock.calls[1]![1]).toEqual({ timeoutMs: TEN_MINUTES })
    expect(mac.startedOn).toEqual(['harness'])
  })

  it('the default connection is not changed', async () => {
    const r = rig({ platform: 'darwin', installed: true, machines: [{ Name: 'podman-machine-default', Running: false }], ownMachine: true })
    await r.setup.run({ step: null })
    expect(r.podmanRuns.filter(args => args[0] === 'system' || ['set', 'rm', 'reset', 'stop'].includes(args[1]!))).toEqual([])
    expect(r.runs).toEqual([])
  })

  it('a machine named harness from a setup cut off is used, and one gone is made again', async () => {
    const cutOff = rig({ platform: 'darwin', installed: true, machines: [{ Name: 'podman-machine-default' }, { Name: 'harness' }] })
    await cutOff.setup.run({ step: 'starting_podman' })
    expect(cutOff.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'start']])
    expect(cutOff.startedOn).toEqual(['harness'])

    const gone = rig({ platform: 'darwin', installed: true, machines: [{ Name: 'podman-machine-default' }], connection: 'harness', hostCpus: 4 })
    await gone.setup.run({ step: null })
    expect(gone.podmanRuns[1]).toEqual(['machine', 'init', '--memory', '8192', '--cpus', '2', 'harness'])
    expect(gone.startedOn).toEqual(['harness'])
  })

  it('an installed Podman is never replaced', async () => {
    const r = rig({ platform: 'darwin', installed: true, interactive: false })
    await r.setup.run({ step: 'installing' })
    expect(r.downloads).toEqual([])
    expect(r.runs).toEqual([])
  })

  it('Linux skips the machine steps', async () => {
    const r = rig({ platform: 'linux', installed: true })
    await r.setup.run({ step: null })
    expect(r.podmanRuns).toEqual([])
    expect(r.steps).toEqual([null])
  })

  it('resumes from the recorded step', async () => {
    const r = rig({ platform: 'darwin', installed: false })
    await r.setup.run({ step: 'starting_podman' })
    expect(r.downloads).toEqual([])
    expect(r.runs).toEqual([])
    expect(r.podmanRuns.at(-1)).toEqual(['machine', 'start'])
  })
})

describe('canAskForPassword', () => {
  it('is false over SSH, and on Linux without a display', () => {
    expect(canAskForPassword({}, 'darwin')).toBe(true)
    expect(canAskForPassword({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'darwin')).toBe(false)
    expect(canAskForPassword({}, 'linux')).toBe(false)
    expect(canAskForPassword({ DISPLAY: ':0' }, 'linux')).toBe(true)
    expect(canAskForPassword({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true)
  })
})
