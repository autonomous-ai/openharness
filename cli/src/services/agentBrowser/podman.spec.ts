import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alive } from '../../testing/spawnedRuns.js'
import { fakePodman, type FakePodman } from './fakePodman.js'
import { createPodman, OUTPUT_LIMIT, PodmanError, type Podman } from './podman.js'

// A pass-through spy: every call still reaches the fake script, and the spec can read what it was started with.
vi.mock('node:child_process', async (importOriginal) => {
  const real = (await import('./fakePodman.js')).trackingFakes(await importOriginal<typeof import('node:child_process')>())
  return { ...real, spawn: vi.fn(real.spawn) }
})
// The login shell is never started in a spec; this stands for what it would have given.
vi.mock('../../lib/loginShellEnv.js', () => ({ oneShotParentEnv: () => ({ ...process.env, FAKE_PODMAN_MARK: 'login-shell' }) }))

const MiB = 1024 ** 2
const GiB = 1024 ** 3
const CLI = fileURLToPath(new URL('../../..', import.meta.url))
const gone = (...pids: number[]) => vi.waitFor(() => expect(pids.filter(alive)).toEqual([]), { timeout: 10_000, interval: 20 })
const info = (version: string, memTotal: number) => JSON.stringify({ version: { Version: version }, host: { memTotal } })
// Captured before any case fakes the clock: a wait in real time, which a fake clock's case needs (vi.waitFor moves it).
const realSetTimeout = setTimeout
const until = async (ready: () => boolean) => {
  const deadline = Date.now() + 10_000
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('not ready after 10 s')
    await new Promise(done => realSetTimeout(done, 10))
  }
}
const started = (count: number) => until(() => fake.pids().length >= count)

let fake: FakePodman
beforeEach(() => { fake = fakePodman() })
afterEach(async () => {
  vi.useRealTimers()
  await fake.remove()
  vi.unstubAllEnvs()
  vi.mocked(spawn).mockClear()
})

const found = (platform: NodeJS.Platform = 'darwin', now = () => 0) =>
  createPodman({ resolve: async () => fake.path, platform, now })

/** A Node process in place of the agent browser's (tsx, the real modules, the fake as its Podman): it runs `body` with `podman`. */
function standIn(body: string): ChildProcess {
  const script = join(dirname(fake.path), 'stand-in.mts')
  writeFileSync(script, `import { createPodman } from ${JSON.stringify(new URL('./podman.ts', import.meta.url).href)}
const podman = createPodman({ resolve: async () => ${JSON.stringify(fake.path)} })
await podman.path()
${body}
setInterval(() => {}, 1 << 30)
`)
  return spawn(process.execPath, ['--import', 'tsx', script], { cwd: CLI, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** The service's process can die with no chance to stop anything (a crash, SIGKILL, the OOM killer): what it started ends all the same. */
async function endsWithItsProcess(body: string, command: string): Promise<void> {
  fake.reply(command, { hangMs: 60_000 })
  const service = standIn(body)
  try {
    await vi.waitFor(() => expect(fake.pids()).toHaveLength(1), { timeout: 20_000, interval: 20 })
    service.kill('SIGKILL')
    await gone(...fake.pids())
  } finally {
    // By their exact pids, and before the fake's folder goes: this process tracks none of them.
    for (const pid of [...fake.pids(), service.pid!]) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    await gone(...fake.pids(), service.pid!)
  }
}

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

  it.each([
    ['info', 5_000, (podman: Podman) => podman.memoryBytes(), 'info', 'podman_failed'],
    ['a call with no limit of its own', 30_000, (podman: Podman) => podman.run(['ps']), 'ps', 'podman_failed'],
    ['machine start', 10 * 60_000, (podman: Podman) => podman.startMachine(), 'machine', 'needs_setup'],
  ] as const)('%s is given %i ms, then ended and named', async (_, ms, call, command, state) => {
    fake.reply(command, { hangMs: 60_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const outcome = failure(call(found('linux')))
    await started(1)
    const pid = fake.pids()[0]!
    // No group of its own: it stays in this process's, as under execFile, which never applied `detached`.
    expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/)
    await vi.advanceTimersByTimeAsync(ms - 1)
    expect(alive(pid)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const error = await outcome
    expect([error.state, error.message, error.output]).toEqual([state, `podman ${command} timed out after ${ms} ms`, undefined])
    expect(alive(pid)).toBe(false)
  })

  it('startMachine runs machine start, and a failure is PodmanError(\'podman_down\')', async () => {
    fake.reply('info', { stdout: info('5.8.9', 4 * GiB) })
    const podman = found()
    await podman.available()
    await podman.startMachine()
    expect(fake.calls()[1]!.args).toEqual(['machine', 'start'])
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

  it('run and spawn use the login shell env, run passes stdin, and spawn has a group of its own', async () => {
    fake.reply('secret create', { stdout: 'abc123\n' })
    const podman = found()
    expect(await podman.run(['secret', 'create', 's1', '-'], { stdin: '{"host":"h"}' }))
      .toEqual({ stdout: 'abc123\n', stderr: '' })
    expect(fake.calls()).toEqual([{ args: ['secret', 'create', 's1', '-'], stdin: '{"host":"h"}', mark: 'login-shell' }])

    const child = podman.spawn(['events', '--format', 'json'])
    // A group of its own while it runs (ownProcessGroup).
    expect(() => process.kill(-child.pid!, 0)).not.toThrow()
    child.stdin!.end()
    await new Promise(resolve => child.once('close', resolve))
    expect(fake.calls()[1]).toEqual({ args: ['events', '--format', 'json'], stdin: '', mark: 'login-shell' })
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
    const runs = vi.mocked(spawn).mock.calls as unknown as Array<[string, string[], { env?: NodeJS.ProcessEnv }]>
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
    // Once run() has failed, the relay's shell and its podman are gone with it, not left running or unreaped behind it.
    // Looked at as it fails, never polled: the shell is reaped before `close`, and it reaps its podman before it exits.
    const shell = vi.mocked(spawn).mock.results[0]!.value as ChildProcess
    expect([fake.pids().at(-1)!, shell.pid!].filter(alive)).toEqual([])
  })

  it('a run with stdin ends only after its podman and cat have', async () => {
    fake.reply('secret create', { stdout: 'abc123\n' })
    await found('linux').run(['secret', 'create', 's1', '-'], { stdin: 'pw' })
    const shell = vi.mocked(spawn).mock.results[0]!.value as ChildProcess
    expect([fake.pids().at(-1)!, shell.pid!].filter(alive)).toEqual([])
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
  it('output over a megabyte is read whole', async () => {
    fake.reply('build', { stdout: 'x'.repeat(3 * MiB) })
    const podman = found()
    expect((await podman.run(['build', '-t', 'harness-browser:t', '/ctx'])).stdout).toHaveLength(3 * MiB)
  })

  it.each(['stdout', 'stderr'] as const)('%s past the limit ends the call and says so', async (stream) => {
    fake.reply('build', { [stream]: 'x'.repeat(3 * MiB) })
    const error = await failure(createPodman({ resolve: async () => fake.path, platform: 'darwin', outputLimit: 2 * MiB }).run(['build', '/ctx']))
    expect([error.state, error.message, error.output]).toEqual(['podman_failed', 'podman build printed more than 2 MiB', undefined])
  })

  it('the limit is 64 MiB, for stdout and for stderr each', async () => {
    expect(OUTPUT_LIMIT).toBe(64 * MiB)
    fake.reply('build', { stdout: 'x'.repeat(1.5 * MiB), stderr: 'y'.repeat(1.5 * MiB) })
    const read = await createPodman({ resolve: async () => fake.path, platform: 'darwin', outputLimit: 2 * MiB }).run(['build', '/ctx'])
    expect([read.stdout.length, read.stderr.length]).toEqual([1.5 * MiB, 1.5 * MiB])
  })

  // A build log: a character of several bytes can fall across two reads of the pipe.
  it('output whose characters fall across two reads is read whole', async () => {
    const text = `x${'é'.repeat(200_000)}`
    fake.reply('logs', { stdout: text })
    expect((await found().run(['logs'])).stdout).toBe(text)
  })

  it('a call that timed out is over even while something it started still holds its output', async () => {
    // A podman that leaves a helper behind holding its stdout, as `machine start` leaves its VM's.
    const script = join(dirname(fake.path), 'leaves-a-helper')
    const helper = join(dirname(fake.path), 'helper.pid')
    writeFileSync(script, `#!/bin/sh\nsleep 60 &\necho $! > '${helper}'\nexec sleep 60\n`)
    chmodSync(script, 0o755)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const slow = failure(createPodman({ resolve: async () => script, platform: 'linux' }).run(['machine', 'start'], { timeoutMs: 500 }))
    // The clock moves once the helper is there: under load, a real 500 ms ran out before the script had started it.
    await until(() => existsSync(helper) && readFileSync(helper, 'utf8').endsWith('\n'))
    try {
      await vi.advanceTimersByTimeAsync(500)
      expect((await slow).message).toBe('podman machine timed out after 500 ms')
    } finally {
      process.kill(Number(readFileSync(helper, 'utf8')), 'SIGKILL')
    }
  })

  // Each crash of the agent browser's process left its `podman events` running, one more per restart.
  it.each([
    ['podman events', `podman.spawn(['events', '--format', 'json'])`, 'events'],
    ['a call in flight', `void podman.run(['ps'], { timeoutMs: 120_000 }).catch(() => {})`, 'ps'],
    ['a call with stdin in flight, through its relay', `void podman.run(['secret', 'create', 's1', '-'], { stdin: 'pw', timeoutMs: 120_000 }).catch(() => {})`, 'secret create'],
  ])('%s ends when the process that started it is killed', (_, body, command) => endsWithItsProcess(body, command))

  // A detached child on Windows leaves the Job Object that ends it with this process (lib/windows/noWindow.ts).
  it('on Windows podman events is a plain spawn, never detached', async () => {
    const podman = found('win32')
    await podman.path()
    const child = podman.spawn(['events'])
    child.stdin!.end()
    await new Promise(resolve => child.once('close', resolve))
    const [file, args, opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { detached?: boolean; windowsHide?: boolean }]
    expect([file, args, opts.detached, opts.windowsHide]).toEqual([fake.path, ['events'], undefined, true])
  })

  it('a podman removed after it was found ends its stream with the spawn\'s own error, as before the tie', async () => {
    const podman = createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform: 'linux' })
    await podman.path()
    const child = podman.spawn(['events'])
    const errors: Error[] = []
    child.on('error', error => errors.push(error))
    const code = await new Promise<number | null>(done => child.once('close', done))
    expect(errors.map(error => (error as NodeJS.ErrnoException).code)).toEqual(['ENOENT'])
    expect(code).toBeLessThan(0)
  })

  it.each(['linux', 'win32'] as const)('a podman removed after it was found is a failed call (%s)', async (platform) => {
    const error = await failure(createPodman({ resolve: async () => join(dirname(fake.path), 'removed'), platform }).run(['ps']))
    expect([error.state, error.message, error.output]).toEqual(['podman_failed', 'podman ps failed: ', ''])
  })

  it('a call spawn refuses outright (a NUL in an argument) is a failed call', async () => {
    const error = await failure(found('linux').run(['ps', '\0']))
    expect([error.state, error.message]).toEqual(['podman_failed', 'podman ps failed: '])
  })

  it('without podman, run and spawn are needs_setup', async () => {
    const podman = createPodman({ resolve: async () => null, exists: () => false, platform: 'linux' })
    expect((await failure(podman.run(['ps']))).state).toBe('needs_setup')
    expect(() => podman.spawn(['events'])).toThrow(PodmanError)
  })
})
