import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { Availability, Podman } from './podman.js'
import { PodmanError } from './podman.js'
import { PODMAN_RELEASE } from './podmanRelease.js'
import { canAskForPassword, Setup, type SetupStep } from './setup.js'

const GiB = 1024 ** 3
const BOOT = 1_800_000_000
const TEN_MINUTES = 10 * 60_000

interface Rig {
  platform?: NodeJS.Platform
  arch?: string
  installed?: boolean
  wsl2?: boolean
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
  which?: string[]
  interactive?: boolean
  bootTime?: number
  hostMemoryBytes?: number
  hostCpus?: number
}

/** Every dependency of Setup as a fake: nothing here installs, downloads or elevates anything. */
function rig(options: Rig = {}) {
  const platform = options.platform ?? 'darwin'
  const downloads: Array<{ url: string; to: string; timeoutMs: number }> = []
  const runs: Array<{ cmd: string; args: string[]; timeoutMs: number; script?: string }> = []
  const steps: Array<[SetupStep | null, number | undefined]> = []
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
    argv: () => { throw new Error('setup never spawns') },
    available: async (): Promise<Availability> => ({ state: 'needs_setup', restart: platform === 'win32' && !options.wsl2, ...(options.ownMachine ? { ownMachine: true as const } : {}) }),
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
      // The elevated script is read while it exists: setup deletes it with the installer.
      const file = args[args.length - 1]!.match(/'-File','"([^"]+)"'/)?.[1]
      runs.push({ cmd, args, timeoutMs: opts.timeoutMs, ...(file ? { script: readFileSync(file, 'utf8') } : {}) })
      return { code: options.runCode?.(cmd) ?? 0, stdout: options.runStdout ?? '', stderr: options.runStderr ?? '' }
    },
    which: async cmd => ((options.which ?? []).includes(cmd) ? `/usr/bin/${cmd}` : null),
    interactive: () => options.interactive ?? true,
    bootTime: () => options.bootTime ?? BOOT,
    hostMemoryBytes: options.hostMemoryBytes ?? 16 * GiB,
    hostCpus: options.hostCpus ?? 8,
    step: (s, bootTime) => { steps.push([s, bootTime]) },
  })
  return { setup, podman, downloads, runs, steps, podmanRuns, startedOn }
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
    expect(await r.setup.run({ step: null })).toBe('done')
    expect(r.downloads).toEqual([{ url: PODMAN_RELEASE.artifacts['darwin-arm64'].url, to: expect.stringMatching(/podman-installer-macos-arm64\.pkg$/), timeoutMs: TEN_MINUTES }])
    expect(r.runs).toHaveLength(1)
    expect(r.runs[0]!.cmd).toBe('osascript')
    expect(r.runs[0]!.timeoutMs).toBe(TEN_MINUTES)
    expect(r.runs[0]!.args).toEqual(['-e',
      `do shell script "installer -pkg '${r.downloads[0]!.to}' -target /" with prompt "Harness needs your password to install Podman for Browser." with administrator privileges`])
    expect(existsSync(r.downloads[0]!.to)).toBe(false)
    expect(r.steps[0]).toEqual(['installing', undefined])
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

  it('Windows runs one elevated script that enables WSL 2 when missing and installs the MSI', async () => {
    const r = rig({ platform: 'win32', arch: 'x64', wsl2: false })
    await r.setup.run({ step: null })
    expect(r.downloads[0]!.url).toBe(PODMAN_RELEASE.artifacts['win32-x64'].url)
    expect(r.runs).toHaveLength(1)
    const [call] = r.runs
    expect(call!.cmd).toBe('powershell.exe')
    expect(call!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(call!.args[3]!.match(/Start-Process/g)).toHaveLength(1)
    expect(call!.args[3]).toContain('Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden')
    expect(call!.timeoutMs).toBe(TEN_MINUTES)
    expect(call!.script).toContain('wsl.exe --install --no-distribution')
    expect(call!.script).toMatch(/msiexec\.exe -ArgumentList '\/i', '"[^"]+podman-installer-windows-amd64\.msi"', '\/qn', '\/norestart'/)

    const withWsl = rig({ platform: 'win32', arch: 'arm64', wsl2: true })
    expect(await withWsl.setup.run({ step: null })).toBe('done')
    expect(withWsl.downloads[0]!.url).toBe(PODMAN_RELEASE.artifacts['win32-arm64'].url)
    expect(withWsl.runs[0]!.script).not.toContain('wsl.exe')
    expect(withWsl.runs[0]!.script).toContain('/qn')
  })

  it('a declined UAC prompt is podman_install_failed', async () => {
    const r = rig({ platform: 'win32', arch: 'x64', runCode: () => 1, runStderr: 'The operation was canceled by the user.' })
    const error = await failure(r.setup.run({ step: null }))
    expect(error.state).toBe('podman_install_failed')
    expect(error.message).toContain('canceled by the user')
    expect(r.steps).toEqual([['installing', undefined]])
  })

  it('Windows returns restart_needed after the script when WSL 2 was just enabled', async () => {
    const r = rig({ platform: 'win32', arch: 'x64', wsl2: false })
    expect(await r.setup.run({ step: null })).toBe('restart_needed')
    expect(r.steps).toEqual([['installing', undefined], ['restart_needed', BOOT]])
    expect(r.podmanRuns).toEqual([])
  })

  it('restart_needed resumes only after the boot time changed', async () => {
    const same = rig({ platform: 'win32', arch: 'x64', installed: true, bootTime: BOOT + 30 })
    expect(await same.setup.run({ step: 'restart_needed', bootTime: BOOT })).toBe('restart_needed')
    expect(same.podmanRuns).toEqual([])
    expect(same.steps).toEqual([])

    const later = rig({ platform: 'win32', arch: 'x64', installed: true, bootTime: BOOT + 3_600 })
    expect(await later.setup.run({ step: 'restart_needed', bootTime: BOOT })).toBe('done')
    expect(later.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--rootful'], ['machine', 'start']])
  })

  it('after the restart no elevated call is made', async () => {
    const r = rig({ platform: 'win32', arch: 'x64', installed: false, bootTime: BOOT + 3_600 })
    await r.setup.run({ step: 'restart_needed', bootTime: BOOT })
    expect(r.runs).toEqual([])
    expect(r.downloads).toEqual([])
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
      expect(await r.setup.run({ step: null })).toBe('done')
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

  it('no way to ask is podman_manual', async () => {
    for (const options of [
      { platform: 'linux', which: ['apt-get'] },
      { platform: 'linux', which: ['pkexec'] },
      { platform: 'darwin', interactive: false },
      { platform: 'win32', arch: 'x64', interactive: false },
      { platform: 'linux', which: ['pkexec', 'apt-get'], interactive: false },
      { platform: 'win32', arch: 'ia32' },
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
    expect(mac.steps).toEqual([['starting_podman', undefined], [null, undefined]])

    const big = rig({ platform: 'darwin', installed: true, hostMemoryBytes: 64 * GiB, hostCpus: 2 })
    await big.setup.run({ step: null })
    expect(big.podmanRuns[1]).toEqual(['machine', 'init', '--memory', '16384', '--cpus', '2'])

    const windows = rig({ platform: 'win32', installed: true })
    await windows.setup.run({ step: null })
    expect(windows.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--rootful'], ['machine', 'start']])
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
    expect(await mac.setup.run({ step: null })).toBe('done')
    expect(mac.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--memory', '8192', '--cpus', '5', 'harness'], ['machine', 'start']])
    expect(mac.podman.run.mock.calls[1]![1]).toEqual({ timeoutMs: TEN_MINUTES })
    expect(mac.startedOn).toEqual(['harness'])

    // Windows reaches its rootful machine as root, through the connection init names `<machine>-root`.
    const windows = rig({ platform: 'win32', installed: true, machines: person, ownMachine: true })
    await windows.setup.run({ step: null })
    expect(windows.podmanRuns).toEqual([['machine', 'list', '--format', 'json'], ['machine', 'init', '--rootful', 'harness'], ['machine', 'start']])
    expect(windows.startedOn).toEqual(['harness-root'])
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
    expect(await r.setup.run({ step: 'installing' })).toBe('done')
    expect(r.downloads).toEqual([])
    expect(r.runs).toEqual([])
  })

  it('Linux skips the machine steps', async () => {
    const r = rig({ platform: 'linux', installed: true })
    expect(await r.setup.run({ step: null })).toBe('done')
    expect(r.podmanRuns).toEqual([])
    expect(r.steps).toEqual([[null, undefined]])
  })

  it('resumes from the recorded step', async () => {
    const r = rig({ platform: 'darwin', installed: false })
    expect(await r.setup.run({ step: 'starting_podman' })).toBe('done')
    expect(r.downloads).toEqual([])
    expect(r.runs).toEqual([])
    expect(r.podmanRuns.at(-1)).toEqual(['machine', 'start'])
  })
})

describe('canAskForPassword', () => {
  it('is false over SSH, and on Linux without a display', () => {
    expect(canAskForPassword({}, 'darwin')).toBe(true)
    expect(canAskForPassword({}, 'win32')).toBe(true)
    expect(canAskForPassword({ SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'darwin')).toBe(false)
    expect(canAskForPassword({}, 'linux')).toBe(false)
    expect(canAskForPassword({ DISPLAY: ':0' }, 'linux')).toBe(true)
    expect(canAskForPassword({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe(true)
  })
})
