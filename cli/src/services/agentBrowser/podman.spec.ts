import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ownProcessGroup } from '../../lib/windows/noWindow.js'
import { fakePodman, type FakePodman } from './fakePodman.js'
import { createPodman, PodmanError } from './podman.js'

// Pass-through spies: every call still reaches the fake script, and the spec can read the options it was started with.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile), spawn: vi.fn(real.spawn) }
})
// The login shell is never started in a spec; this stands for what it would have given.
vi.mock('../../lib/loginShellEnv.js', () => ({ oneShotParentEnv: () => ({ ...process.env, FAKE_PODMAN_MARK: 'login-shell' }) }))

const GiB = 1024 ** 3
const info = (version: string, memTotal: number) => JSON.stringify({ version: { Version: version }, host: { memTotal } })

let fake: FakePodman
beforeEach(() => { fake = fakePodman() })
afterEach(() => {
  fake.remove()
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
    vi.stubEnv('ProgramFiles', 'D:\\Programs')
    expect(await createPodman({ resolve: async () => null, exists, platform: 'win32' }).path())
      .toBe('D:\\Programs\\RedHat\\Podman\\podman.exe')
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

  it('no podman is needs_setup; restart is true only on win32 without WSL 2', async () => {
    const none = (platform: NodeJS.Platform, wsl2: boolean) =>
      createPodman({ resolve: async () => null, exists: () => false, platform, wsl2: async () => wsl2 }).available()
    expect(await none('darwin', false)).toEqual({ state: 'needs_setup', restart: false })
    expect(await none('linux', false)).toEqual({ state: 'needs_setup', restart: false })
    expect(await none('win32', true)).toEqual({ state: 'needs_setup', restart: false })
    expect(await none('win32', false)).toEqual({ state: 'needs_setup', restart: true })
  })

  it('wsl 2 is read from wsl --status, started hidden', async () => {
    vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], _options: object, done: (error: Error | null) => void) => {
      done(null)
      return {} as ChildProcess
    }) as unknown as typeof execFile)
    const podman = createPodman({ resolve: async () => null, exists: () => false, platform: 'win32' })
    expect(await podman.available()).toEqual({ state: 'needs_setup', restart: false })
    expect(vi.mocked(execFile).mock.calls[0]!.slice(0, 3))
      .toEqual(['wsl.exe', ['--status'], expect.objectContaining({ windowsHide: true, timeout: 10_000 })])
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
    expect(await found('win32').available()).toEqual({ state: 'needs_setup', restart: false })
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
    for (const platform of ['darwin', 'linux', 'win32'] as const) expect(await found(platform).memoryBytes()).toBe(7 * GiB)
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
    fake.reply('machine start', { code: 125, stderr: 'Error: vfkit exited unexpectedly' })
    const error = await failure(podman.startMachine())
    expect(error.state).toBe('podman_down')
    expect(error.message).toContain('vfkit exited unexpectedly')
  })

  it('run uses the login shell env and ownProcessGroup, and passes stdin', async () => {
    fake.reply('secret create', { stdout: 'abc123\n' })
    const podman = found()
    expect(await podman.run(['secret', 'create', '--replace', 's1', '-'], { stdin: '{"host":"h"}' }))
      .toEqual({ stdout: 'abc123\n', stderr: '' })
    expect(fake.calls()).toEqual([{ args: ['secret', 'create', '--replace', 's1', '-'], stdin: '{"host":"h"}', mark: 'login-shell' }])
    expect(vi.mocked(execFile).mock.calls[0]![2])
      .toEqual(expect.objectContaining({ ...ownProcessGroup(), timeout: 30_000, env: expect.objectContaining({ FAKE_PODMAN_MARK: 'login-shell' }) }))

    const child = podman.spawn(['events', '--format', 'json'])
    child.stdin!.end()
    await new Promise(resolve => child.once('close', resolve))
    expect(fake.calls()[1]).toEqual({ args: ['events', '--format', 'json'], stdin: '', mark: 'login-shell' })
    expect(vi.mocked(spawn).mock.calls[0]).toEqual([fake.path, ['events', '--format', 'json'], expect.objectContaining(ownProcessGroup())])
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

  it('without podman, run and spawn are needs_setup', async () => {
    const podman = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    expect((await failure(podman.run(['ps']))).state).toBe('needs_setup')
    expect(() => podman.spawn(['events'])).toThrow(PodmanError)
  })
})
