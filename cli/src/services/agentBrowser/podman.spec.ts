import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'
import { fakePodman, type FakePodman } from './fakePodman.js'
import { createPodman, PodmanError } from './podman.js'

// Pass-through spies: every call still reaches the fake script, and the spec can read the options it was started with.
vi.mock('node:child_process', async (importOriginal) => {
  const real = (await import('./fakePodman.js')).trackingFakes(await importOriginal<typeof import('node:child_process')>())
  return { ...real, execFile: vi.fn(real.execFile), spawn: vi.fn(real.spawn) }
})
// The login shell is never started in a spec; this stands for what it would have given.
vi.mock('../../lib/loginShellEnv.js', () => ({ oneShotParentEnv: () => ({ ...process.env, FAKE_PODMAN_MARK: 'login-shell' }) }))

const GiB = 1024 ** 3
const info = (version: string, memTotal: number) => JSON.stringify({ version: { Version: version }, host: { memTotal } })

let fake: FakePodman
beforeEach(() => { fake = fakePodman() })
afterEach(async () => {
  await fake.remove()
  vi.unstubAllEnvs()
  vi.mocked(execFile).mockClear()
  vi.mocked(spawn).mockClear()
})

const found = (platform: NodeJS.Platform = 'darwin', now = () => 0) =>
  createPodman({ resolve: async () => fake.path, platform, now })

const failure = async (work: Promise<unknown>): Promise<PodmanError> => {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error).toBeInstanceOf(PodmanError)
  return error as PodmanError
}

describe('createPodman', () => {
  it('finds podman through the login shell, then the installers\' paths', async () => {
    const asked: string[] = []
    const exists = (path: string) => { asked.push(path); return true }
    expect(await createPodman({ resolve: async () => '/shell/podman', exists, platform: 'darwin' }).path()).toBe('/shell/podman')
    expect(asked).toEqual([])
    expect(await createPodman({ resolve: async () => null, exists, platform: 'darwin' }).path()).toBe('/opt/podman/bin/podman')
    expect(await createPodman({ resolve: async () => null, exists: () => false, platform: 'darwin' }).path()).toBeNull()
    expect(await createPodman({ resolve: async () => null, exists, platform: 'linux' }).path()).toBeNull()
    expect(fake.calls()).toEqual([])
  })

  it('with nothing handed in, asks the person\'s own shell', async () => {
    // A stand-in login shell beside the fake: the developer's own shell is never started.
    const shell = join(dirname(fake.path), 'zsh')
    writeFileSync(shell, `#!/bin/sh\nprintf '%s\\n' '${fake.path}'\n`)
    chmodSync(shell, 0o755)
    vi.stubEnv('SHELL', shell)
    expect(await createPodman().path()).toBe(fake.path)
  })

  it('no podman is needs_setup', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(await createPodman({ resolve: async () => null, exists: () => false, platform }).available()).toEqual({ state: 'needs_setup' })
    }
  })

  it('podman info ok is ready', async () => {
    fake.reply('info', { stdout: info('5.8.9', 4 * GiB) })
    expect(await found().available()).toEqual({ state: 'ready' })
    expect(fake.calls().map(call => call.args)).toEqual([['info', '--format', 'json']])
  })

  it('machine stopped is stopped', async () => {
    fake.reply('info', { code: 125, stderr: 'Cannot connect to Podman' })
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: false }]) })
    expect(await found().available()).toEqual({ state: 'stopped' })
    expect(fake.calls().map(call => call.args)).toEqual([['info', '--format', 'json'], ['machine', 'list', '--format', 'json']])
  })

  it('info failing with no machine is needs_setup, and with a running machine or on Linux is podman_down', async () => {
    fake.reply('info', { code: 125 })
    fake.reply('machine list', { stdout: '[]' })
    expect(await found('darwin').available()).toEqual({ state: 'needs_setup' })
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: true }]) })
    expect((await failure(found('darwin').available())).state).toBe('podman_down')
    expect((await failure(found('linux').available())).state).toBe('podman_down')
  })

  it('a version below 4.6 is podman_old', async () => {
    fake.reply('info', { stdout: info('4.5.1', 8 * GiB) })
    expect(await found().available()).toEqual({ state: 'podman_old' })
    fake.reply('info', { stdout: info('4.6.0-rc1', 8 * GiB) })
    expect(await found().available()).toEqual({ state: 'ready' })
    fake.reply('info', { stdout: '{}' })
    expect(await found().available()).toEqual({ state: 'podman_old' })
    expect(await found().memoryBytes()).toBe(0)
  })

  it('less than 3 GiB is podman_memory', async () => {
    fake.reply('info', { stdout: info('5.8.9', 3 * GiB - 1) })
    expect(await found().available()).toEqual({ state: 'podman_memory' })
    fake.reply('info', { stdout: info('5.8.9', 3 * GiB) })
    expect(await found().available()).toEqual({ state: 'ready' })
  })

  it('memoryBytes reads memTotal from podman info on every platform', async () => {
    fake.reply('info', { stdout: info('5.8.9', 7 * GiB) })
    for (const platform of ['darwin', 'linux'] as const) expect(await found(platform).memoryBytes()).toBe(7 * GiB)
  })

  it('info that is not JSON is podman_failed, and does not count as an answer', async () => {
    fake.reply('info', { stdout: 'not json' })
    expect((await failure(found().memoryBytes())).state).toBe('podman_failed')
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: false }]) })
    expect(await found().available()).toEqual({ state: 'stopped' })
  })

  it('available is cached 60 s', async () => {
    fake.reply('info', { stdout: info('5.8.9', 4 * GiB) })
    let now = 1_000
    const podman = found('darwin', () => now)
    await podman.available()
    now += 60_000 - 1
    await podman.available()
    expect(fake.calls()).toHaveLength(1)
    now += 1
    await podman.available()
    expect(fake.calls()).toHaveLength(2)
  })

  it('info times out after 5 s', async () => {
    fake.reply('info', { stdout: info('5.8.9', 4 * GiB) })
    await found().available()
    expect(vi.mocked(execFile).mock.calls[0]![2]).toEqual(expect.objectContaining({ timeout: 5_000 }))
  })

  it('startMachine runs machine start, and a failure is PodmanError(\'podman_down\')', async () => {
    fake.reply('info', { stdout: info('5.8.9', 4 * GiB) })
    const podman = found()
    await podman.available()
    await podman.startMachine()
    expect(fake.calls()[1]!.args).toEqual(['machine', 'start'])
    expect(vi.mocked(execFile).mock.calls[1]![2]).toEqual(expect.objectContaining({ timeout: 10 * 60_000 }))
    // A machine just started is measured again, not read from the cache.
    await podman.available()
    expect(fake.calls()).toHaveLength(3)

    fake.reply('machine start', { code: 125, stderr: 'Error: podman-machine-default: VM already running or starting' })
    await podman.startMachine()
    // Harness's own machine that will not start is Podman down: there is no other machine to make.
    podman.useConnection('harness')
    fake.reply('machine start', { code: 125, stderr: 'Error: vfkit exited unexpectedly' })
    const error = await failure(podman.startMachine())
    expect(error.state).toBe('podman_down')
    expect(error.message).toContain('vfkit exited unexpectedly')
  })

  // The spike's Mac: the person's machine had lost its files to another app, and every start failed after 31 s.
  it('a default machine whose start fails is needs_setup with ownMachine true', async () => {
    fake.reply('info', { code: 125, stderr: 'Error: unable to connect to Podman socket' })
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: false }]) })
    fake.reply('machine start', { code: 125, stderr: 'Error: unable to connect to "gvproxy" socket' })
    const podman = found()
    expect(await podman.available()).toEqual({ state: 'stopped' })
    const error = await failure(podman.startMachine())
    expect(error.state).toBe('needs_setup')
    expect(error.message).toContain('gvproxy')
    expect(await podman.available()).toEqual({ state: 'needs_setup', ownMachine: true })
    expect(fake.calls().map(call => call.args).filter(args => args[0] === 'machine' && args[1] !== 'list')).toEqual([['machine', 'start']])
  })

  it('after setup every call carries --connection harness', async () => {
    const podman = found()
    expect(podman.connection()).toBeNull()
    podman.useConnection('harness')
    expect(podman.connection()).toBe('harness')
    // The person's default connection still fails; only Harness's own answers.
    fake.reply('info', { code: 125 })
    fake.reply('--connection harness info', { stdout: info('5.8.9', 6 * GiB) })
    expect(await podman.available()).toEqual({ state: 'ready' })
    await podman.run(['ps', '-a'])
    const child = podman.spawn(['events', '--format', 'json'])
    child.stdin!.end()
    await new Promise(resolve => child.once('close', resolve))
    // Machine commands act on a machine by its name, not through a connection.
    await podman.startMachine()
    expect(fake.calls().map(call => call.args)).toEqual([
      ['--connection', 'harness', 'info', '--format', 'json'],
      ['--connection', 'harness', 'ps', '-a'],
      ['--connection', 'harness', 'events', '--format', 'json'],
      ['machine', 'start', 'harness'],
    ])
  })

  it('Harness\'s own machine stopped is read from the list by its name', async () => {
    fake.reply('--connection harness info', { code: 125 })
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: true }, { Name: 'harness', Running: false }]) })
    const podman = found()
    podman.useConnection('harness')
    expect(await podman.available()).toEqual({ state: 'stopped' })
    await podman.startMachine()
    expect(fake.calls().at(-1)!.args).toEqual(['machine', 'start', 'harness'])
  })

  it('Harness\'s own machine gone from the list is needs_setup', async () => {
    fake.reply('--connection harness info', { code: 125 })
    fake.reply('machine list', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Running: false }]) })
    const podman = found()
    podman.useConnection('harness')
    expect(await podman.available()).toEqual({ state: 'needs_setup' })
  })

  it('memoryBytes reads machine inspect while the machine is stopped', async () => {
    fake.reply('info', { code: 125, stderr: 'Error: unable to connect to Podman socket' })
    fake.reply('machine inspect', { stdout: JSON.stringify([{ Name: 'podman-machine-default', Resources: { CPUs: 12, Memory: 8192 } }]) })
    expect(await found('darwin').memoryBytes()).toBe(8 * GiB)
    const own = found('darwin')
    own.useConnection('harness')
    fake.reply('--connection harness info', { code: 125 })
    fake.reply('machine inspect harness', { stdout: JSON.stringify([{ Name: 'harness', Resources: { Memory: 4096 } }]) })
    expect(await own.memoryBytes()).toBe(4 * GiB)
    expect(fake.calls().map(call => call.args).filter(args => args[0] === 'machine')).toEqual([['machine', 'inspect'], ['machine', 'inspect', 'harness']])
    // An inspect that names no size reads as no memory, as an info with none does.
    fake.reply('machine inspect', { stdout: '[]' })
    expect(await found('darwin').memoryBytes()).toBe(0)
    // Linux has no machine: an unanswered info is the failure itself.
    expect((await failure(found('linux').memoryBytes())).state).toBe('podman_failed')
  })

  it('run uses the login shell env and ownProcessGroup, and passes stdin', async () => {
    fake.reply('secret create', { stdout: 'abc123\n' })
    const podman = found()
    expect(await podman.run(['secret', 'create', 's1', '-'], { stdin: '{"host":"h"}' }))
      .toEqual({ stdout: 'abc123\n', stderr: '' })
    expect(fake.calls()).toEqual([{ args: ['secret', 'create', 's1', '-'], stdin: '{"host":"h"}', mark: 'login-shell' }])
    expect(vi.mocked(execFile).mock.calls[0]![2])
      .toEqual(expect.objectContaining({ ...ownProcessGroup(), timeout: 30_000, env: expect.objectContaining({ FAKE_PODMAN_MARK: 'login-shell' }) }))

    const child = podman.spawn(['events', '--format', 'json'])
    child.stdin!.end()
    await new Promise(resolve => child.once('close', resolve))
    expect(fake.calls()[1]).toEqual({ args: ['events', '--format', 'json'], stdin: '', mark: 'login-shell' })
    expect(vi.mocked(spawn).mock.calls[0]).toEqual([fake.path, ['events', '--format', 'json'], expect.objectContaining(ownProcessGroup())])
  })

  // Podman 4.9 takes `-` only from a real pipe (cmd/podman/secrets/create.go), and Node hands a child a socket: the
  // proxy secret was refused on GitHub's Ubuntu runner. The fake refuses the same way.
  it('stdin reaches podman through a real pipe, on a connection too', async () => {
    // Values no temporary path can hold: `pw` was in a random folder name once (/tmp/vRkFpwG/…, CI 42924580725).
    const first = 'stdin-only-secret-one', second = 'stdin-only-secret-two'
    const podman = found('linux')
    await podman.run(['secret', 'create', 's1', '-'], { stdin: first })
    podman.useConnection('harness')
    await podman.run(['secret', 'create', 's2', '-'], { stdin: second })
    expect(fake.calls().map(call => [call.args, call.stdin])).toEqual([
      [['secret', 'create', 's1', '-'], first],
      [['--connection', 'harness', 'secret', 'create', 's2', '-'], second],
    ])
    // Through the relay the data is on stdin alone: never in an argument or the environment of either run.
    const runs = vi.mocked(execFile).mock.calls as unknown as Array<[string, string[], { env?: NodeJS.ProcessEnv }]>
    expect(runs).toHaveLength(2)
    for (const [file, args, opts] of runs) {
      for (const secret of [first, second]) {
        expect([file, ...args].join(' ')).not.toContain(secret)
        expect(JSON.stringify(opts.env ?? process.env)).not.toContain(secret)
      }
    }
  })

  it('a slow run with stdin still times out, its podman with it', async () => {
    fake.reply('secret create', { hangMs: 10_000 })
    // Long enough for the fake to start and read its stdin, so there is a podman to leave behind.
    const slow = await failure(found('linux').run(['secret', 'create', 's1', '-'], { stdin: 'pw', timeoutMs: 2_000 }))
    expect(slow.message).toBe('podman secret timed out after 2000 ms')
    // The relay's shell leads its own process group (ownProcessGroup): once run() has failed, its podman and cat are
    // gone with it, not left running or unreaped behind it.
    const shell = vi.mocked(execFile).mock.results[0]!.value as ChildProcess
    expect(() => process.kill(fake.lastPid(), 0)).toThrow(/ESRCH/)
    expect(() => process.kill(-shell.pid!, 0)).toThrow(/ESRCH/)
  })

  it('a run with stdin ends only after its podman and cat have', async () => {
    fake.reply('secret create', { stdout: 'abc123\n' })
    await found('linux').run(['secret', 'create', 's1', '-'], { stdin: 'pw' })
    const shell = vi.mocked(execFile).mock.results[0]!.value as ChildProcess
    expect(() => process.kill(fake.lastPid(), 0)).toThrow(/ESRCH/)
    expect(() => process.kill(-shell.pid!, 0)).toThrow(/ESRCH/)
  })

  it('a failed or slow run is a named PodmanError', async () => {
    fake.reply('rm', { code: 2, stderr: 'Error: no container with name or ID "x" found\n' })
    const podman = found()
    const failed = await failure(podman.run(['rm', 'x']))
    expect(failed.state).toBe('podman_failed')
    expect(failed.message).toBe('podman rm failed: Error: no container with name or ID "x" found')
    fake.reply('ps', { hangMs: 10_000 })
    const slow = await failure(podman.run(['ps'], { timeoutMs: 200 }))
    expect(slow.message).toBe('podman ps timed out after 200 ms')
  })

  // An image build prints a line per package it installs: more than execFile's 1 MB default, which killed the build
  // and read as a timeout.
  it('output over a megabyte is read whole, and a timeout still applies', async () => {
    fake.reply('build', { stdout: 'x'.repeat(3 * 1024 * 1024) })
    const podman = found()
    expect((await podman.run(['build', '-t', 'harness-browser:t', '/ctx'])).stdout).toHaveLength(3 * 1024 * 1024)
    expect(vi.mocked(execFile).mock.calls[0]![2]).toEqual(expect.objectContaining({ timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }))
  })

  it('without podman, run and spawn are needs_setup', async () => {
    const podman = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    expect((await failure(podman.run(['ps']))).state).toBe('needs_setup')
    expect(() => podman.spawn(['events'])).toThrow(PodmanError)
  })
})
