import { type ChildProcess, execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { appCodexCandidates, CODEX_THREAD, codexQueueDeps, createCodexQueue, type CodexQueueDeps, type CodexRunEnd } from './codexQueue.js'
import { MAX_TEXT } from './orca.js'
import { storePackageLook } from '../../lib/windows/storePackage.js'
import { writeExecutable } from '../../testing/executableFixture.js'

// The real execFile, watched: a spec reads how the child of a run ended.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile) }
})

// The login shell, never a real one: each spec says what it gave and when its read ends.
const shell = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv, read: (): Promise<NodeJS.ProcessEnv> => Promise.resolve({}) }))
vi.mock('../../lib/loginShellEnv.js', async (original) => ({
  ...await original<typeof import('../../lib/loginShellEnv.js')>(),
  loginShellEnvironment: () => shell.env,
  warmLoginShellEnvironment: () => shell.read(),
  // The module's own rule, restated: the real one reads the module's cache, which this mock never fills.
  oneShotParentEnv: () => ({ ...shell.env, ...process.env }),
}))

const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const OTHER = '9b2f4c1e-7d3a-4e5b-8c6d-0e1f2a3b4c5d'
const FAKE_CODEX = '/fake/bin/codex'
const APP_CODEX = '/fake/ChatGPT.app/codex'
const REFUSED = { outcome: 'failed', reason: 'refused' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-queue-'))
  // The real look never reaches the developer's own ChatGPT app: it looks here alone, where there is none.
  vi.stubEnv('HARNESS_CODEX_APP_BIN', join(dir, 'no-app', 'codex'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  shell.env = {}
  shell.read = () => Promise.resolve({})
  rmSync(dir, { recursive: true, force: true })
})

/** Every job the microtask queue holds has run: a read of the login shell that has ended has been taken. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

/** A file that can be run, at [path]. */
function executable(path: string, body = '#!/bin/sh\nexit 0\n'): string {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

/** A fake `codex` that writes its arguments (NUL-separated), its CODEX_HOME and its folder, then runs [tail]. Never the
 *  real one. */
function fakeCodex(tail = 'exit 0') {
  const out = (name: string) => join(dir, `${name}.out`)
  const file = join(dir, 'codex')
  writeExecutable(file, [
    '#!/bin/sh',
    `printf '%s\\0' "$@" > '${out('argv')}'`,
    `printf '%s' "$CODEX_HOME" > '${out('home')}'`,
    `pwd -P > '${out('cwd')}'`,
    tail,
    '',
  ].join('\n'))
  return {
    file,
    argv: () => readFileSync(out('argv'), 'utf8').split('\0').slice(0, -1),
    home: () => readFileSync(out('home'), 'utf8'),
    cwd: () => readFileSync(out('cwd'), 'utf8').trimEnd(),
  }
}

type Call = Parameters<CodexQueueDeps['run']>

/** A recording `run` that runs nothing: each call answers the next of [ends], then exit 0. */
function recorder(over: Partial<CodexQueueDeps> = {}, ends: CodexRunEnd[] = []) {
  const calls: Call[] = []
  const queue = createCodexQueue({
    run: async (...call) => {
      calls.push(call)
      return ends.length ? ends.shift()! : 0
    },
    binary: () => FAKE_CODEX,
    appBinary: () => null,
    parentEnv: () => ({ PATH: '/usr/bin' }),
    readLoginShell: vi.fn(),
    platform: 'darwin',
    home: '/home/u/.codex',
    cwd: '/home/u',
    ...over,
  })
  return { calls, queue }
}

/** A `run` that holds each command until the test lets it end. */
function held() {
  const calls: Call[] = []
  const waiting: Array<(end: CodexRunEnd) => void> = []
  const queue = createCodexQueue({
    run: (...call) => {
      calls.push(call)
      return new Promise((resolve) => waiting.push(resolve))
    },
    binary: () => FAKE_CODEX,
    appBinary: () => null,
    parentEnv: () => ({ PATH: '/usr/bin' }),
    readLoginShell: vi.fn(),
    platform: 'linux',
    home: '/home/u/.codex',
    cwd: '/home/u',
  })
  return { calls, waiting, queue }
}

/** The real deps, running [file] in the test's folder under a Codex home of its own. */
function realQueue(file: string, over: Partial<CodexQueueDeps> = {}) {
  return createCodexQueue({ ...codexQueueDeps(), binary: () => file, home: join(dir, 'codex-home'), cwd: dir, ...over })
}

/** What a real run is asked for, in the test's folder. */
const options = () => ({ cwd: dir, env: process.env, timeoutMs: 10_000 })

describe('codex queue', () => {
  it('send runs codex queue with the thread and the text joined to its flag, in the home directory, under the Codex home, for 10 s', async () => {
    const { calls, queue } = recorder()
    expect(await queue.send(THREAD, 'fix the login bug', false)).toEqual({ outcome: 'queued' })
    expect(calls).toEqual([[
      FAKE_CODEX,
      ['queue', '--thread', THREAD, '--message=fix the login bug'],
      { cwd: '/home/u', env: { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }, timeoutMs: 10_000 },
    ]])
  })

  it('a text that starts with --, with quotes, $( ) and two lines reaches codex whole, as one argument', async () => {
    const fake = fakeCodex()
    const marker = join(dir, 'ran')
    const text = `--dash "q" $(touch ${marker}) \`touch ${marker}\`\nsecond line`
    const cwd = join(dir, 'home')
    mkdirSync(cwd)
    const home = join(dir, 'codex-home')
    const queue = realQueue(fake.file, { home, cwd })
    expect(await queue.send(THREAD, text, false)).toEqual({ outcome: 'queued' })
    expect(fake.argv()).toEqual(['queue', '--thread', THREAD, `--message=${text}`])
    expect(existsSync(marker)).toBe(false)
    expect(fake.home()).toBe(home)
    expect(fake.cwd()).toBe(realpathSync(cwd))
  })

  it('a thread id that is not a lower-case UUID, an empty text, one over MAX_TEXT characters and one with a NUL run nothing and answer failed, refused', async () => {
    expect(CODEX_THREAD.test(THREAD)).toBe(true)
    const { calls, queue } = recorder()
    for (const id of ['', THREAD.toUpperCase(), `${THREAD}; rm -rf /`, '--help', 'my session']) {
      expect(await queue.send(id, 'hi', false)).toEqual(REFUSED)
    }
    for (const text of ['', 'a'.repeat(MAX_TEXT + 1), 'one\0two']) {
      expect(await queue.send(THREAD, text, false)).toEqual(REFUSED)
    }
    expect(calls).toEqual([])
  })

  it('a text of 20,000 characters is queued whole, in one run', async () => {
    const { calls, queue } = recorder()
    expect(await queue.send(THREAD, 'a'.repeat(20_000), false)).toEqual({ outcome: 'queued' })
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toContain(`--message=${'a'.repeat(20_000)}`)
  })

  it('exit 0 is queued; a non-zero exit is failed with its exit code; a binary that cannot start, and no binary, are failed with no binary', async () => {
    const { queue } = recorder({}, [0, 1, 127, 'not-started'])
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'queued' })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'exit 1', ran: 'path' })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'exit 127', ran: 'path' })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'no binary', ran: 'path' })

    const none = recorder({ binary: () => null })
    expect(await none.queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'no binary', ran: 'path' })
    expect(none.calls).toEqual([])
  })

  it('the real run answers the exit code, not-started for a missing file, and never rejects', async () => {
    const fake = fakeCodex('exit 3')
    const { run } = codexQueueDeps()
    expect(await run(fake.file, [], options())).toBe(3)
    expect(await run(join(dir, 'missing'), [], options())).toBe('not-started')
    // A file that is there but cannot be run starts nothing either.
    const plain = join(dir, 'plain')
    writeFileSync(plain, '')
    expect(await run(plain, [], options())).toBe('not-started')
    // execFile throws on an argument with a NUL, before any child.
    expect(await run(fake.file, ['one\0two'], options())).toBe('not-started')
  })

  it('a run that outlasts its 10 s answers timeout at the deadline, and its codex is killed with SIGKILL', async () => {
    // Deaf to SIGTERM, it would outlive a kill that sent one: its sleep runs past the test's own timeout.
    const fake = fakeCodex(`trap '' TERM\nexec sleep 300`)
    const real = codexQueueDeps()
    const asked: number[] = []
    const queue = realQueue(fake.file, {
      // The real run, with the 10 s it is asked for cut short so the test does not wait them out.
      run: (file, args, given) => {
        asked.push(given.timeoutMs)
        return real.run(file, args, { ...given, timeoutMs: 200 })
      },
    })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'timeout' })
    expect(asked).toEqual([10_000])
    const child = vi.mocked(execFile).mock.results.at(-1)!.value as ChildProcess
    // A run that is never killed fails the test on its timeout, and its sleep, deaf to SIGTERM, would outlive the suite.
    onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    // Answered by the deadline, the child may still be on its way out.
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    expect(child.signalCode).toBe('SIGKILL')
  })

  // Neither an exit code nor the deadline: the message may be queued, so it is no definite failure.
  it('a codex killed by a signal answers timeout, never failed', async () => {
    const fake = fakeCodex('kill -KILL $$')
    expect(await codexQueueDeps().run(fake.file, [], options())).toBe('unknown')
    expect(await realQueue(fake.file).send(THREAD, 'hi', false)).toEqual({ outcome: 'timeout' })
  })

  it('run ends its codex\'s stdin at once', async () => {
    const fake = fakeCodex('cat > /dev/null')
    expect(await codexQueueDeps().run(fake.file, [], options())).toBe(0)
  })

  it('a second send for the same thread while one runs is busy and runs nothing; another thread\'s runs; the thread is free again after queued, failed and timeout', async () => {
    const { calls, waiting, queue } = held()
    const first = queue.send(THREAD, 'one', false)
    expect(await queue.send(THREAD, 'two', false)).toEqual({ outcome: 'busy' })
    const other = queue.send(OTHER, 'three', false)
    expect(calls.map(([, args]) => args[2])).toEqual([THREAD, OTHER])
    waiting[0](0)
    waiting[1](0)
    expect(await first).toEqual({ outcome: 'queued' })
    expect(await other).toEqual({ outcome: 'queued' })

    // After queued, after failed, after timeout: each next send runs.
    const failed = queue.send(THREAD, 'four', false)
    waiting[2](1)
    expect(await failed).toEqual({ outcome: 'failed', reason: 'exit 1', ran: 'path' })
    const timedOut = queue.send(THREAD, 'five', false)
    waiting[3]('unknown')
    expect(await timedOut).toEqual({ outcome: 'timeout' })
    const next = queue.send(THREAD, 'six', false)
    waiting[4](0)
    expect(await next).toEqual({ outcome: 'queued' })
    expect(calls).toHaveLength(5)
  })

  it('can() is whether the binary is there, asked each time', () => {
    let found: string | null = null
    const { queue } = recorder({ binary: () => found })
    expect(queue.can(false)).toBe(false)
    found = FAKE_CODEX
    expect(queue.can(false)).toBe(true)
    found = null
    expect(queue.can(false)).toBe(false)
  })

  it('the binary is the Codex Harness launches, looked for again after 30 s', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    onTestFinished(() => { vi.useRealTimers() })
    const { binary } = codexQueueDeps()
    vi.stubEnv('CODEX_PATH', '')
    vi.stubEnv('PATH', dir)
    expect(binary()).toBeNull()
    const onPath = executable(join(dir, 'codex'))
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBe(onPath)

    // Its own path, missing: Harness would not launch the codex on PATH, so neither does the queue.
    const own = join(dir, 'other', 'my-codex')
    vi.stubEnv('CODEX_PATH', own)
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBeNull()
    mkdirSync(join(dir, 'other'))
    executable(own)
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBe(own)
  })

  // The dial's list asks can() for each queue-able Codex row on every 1 s tick while a dial is connected (cableSession.ts
  // `ticked`, cableHost.ts `machineSnapshot`): a walk of a 63-folder PATH took 0.24 to 0.36 ms with codex on it and 0.7 ms
  // without (this Mac, 2026-11-15).
  it('the binary is looked for once in 30 s: a codex installed or removed is seen after them', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    onTestFinished(() => { vi.useRealTimers() })
    const { binary } = codexQueueDeps()
    vi.stubEnv('CODEX_PATH', '')
    vi.stubEnv('PATH', dir)
    expect(binary()).toBeNull()
    const onPath = executable(join(dir, 'codex'))
    vi.advanceTimersByTime(29_999)
    expect(binary()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(binary()).toBe(onPath)
    rmSync(onPath)
    vi.advanceTimersByTime(29_999)
    expect(binary()).toBe(onPath)
    vi.advanceTimersByTime(1)
    expect(binary()).toBeNull()
  })

  it('codex on the login shell\'s PATH is found before the daemon\'s, and CODEX_PATH before both', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    onTestFinished(() => { vi.useRealTimers() })
    const login = join(dir, 'login')
    const daemon = join(dir, 'daemon')
    mkdirSync(login)
    mkdirSync(daemon)
    const fromLogin = executable(join(login, 'codex'))
    const fromDaemon = executable(join(daemon, 'codex'))
    shell.env = { PATH: login }
    vi.stubEnv('PATH', daemon)
    vi.stubEnv('CODEX_PATH', '')
    const { binary } = codexQueueDeps()
    expect(binary()).toBe(fromLogin)
    rmSync(fromLogin)
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBe(fromDaemon)

    executable(fromLogin)
    mkdirSync(join(dir, 'other'))
    const own = executable(join(dir, 'other', 'my-codex'))
    vi.stubEnv('CODEX_PATH', own)
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBe(own)
    // Its own path, missing: a launch would not run the codex on either PATH, so neither does the queue.
    vi.stubEnv('CODEX_PATH', join(dir, 'missing', 'codex'))
    vi.advanceTimersByTime(30_000)
    expect(binary()).toBeNull()
  })

  // A look taken while the login shell was not read yet saw the daemon's PATH alone.
  it('a look taken before the login shell was read is taken again once it is read', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    onTestFinished(() => { vi.useRealTimers() })
    const login = join(dir, 'login')
    const daemon = join(dir, 'daemon')
    mkdirSync(login)
    mkdirSync(daemon)
    vi.stubEnv('CODEX_PATH', '')
    vi.stubEnv('PATH', daemon)
    let ended!: (env: NodeJS.ProcessEnv) => void
    shell.read = () => new Promise((resolve) => { ended = resolve })
    const deps = codexQueueDeps()
    expect(deps.binary()).toBeNull()
    const fromLogin = executable(join(login, 'codex'))
    shell.env = { PATH: login }
    expect(deps.binary()).toBeNull()
    deps.readLoginShell()
    await settled()
    expect(deps.binary()).toBeNull()
    ended(shell.env)
    await settled()
    expect(deps.binary()).toBe(fromLogin)
  })

  it('a read that gives nothing changes nothing and never throws', async () => {
    const onPath = executable(join(dir, 'codex'))
    vi.stubEnv('CODEX_PATH', '')
    vi.stubEnv('PATH', dir)
    const deps = codexQueueDeps()
    expect(() => deps.readLoginShell()).not.toThrow()
    await settled()
    expect(deps.binary()).toBe(onPath)
    expect(deps.parentEnv().PATH).toBe(dir)
  })

  it('the run\'s environment is the login shell\'s with the daemon\'s on top, PATH the login shell\'s then the daemon\'s, CODEX_HOME the daemon\'s', async () => {
    shell.env = { PATH: '/login/bin', CODEX_HOME: '/login/codex', ONLY_LOGIN: '1', BOTH: 'login' }
    vi.stubEnv('PATH', '/daemon/bin')
    vi.stubEnv('BOTH', 'daemon')
    const calls: Call[] = []
    const queue = createCodexQueue({
      ...codexQueueDeps(),
      run: async (...call) => { calls.push(call); return 0 },
      binary: () => FAKE_CODEX,
      home: '/daemon/codex',
      cwd: dir,
    })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'queued' })
    expect(calls).toHaveLength(1)
    expect(calls[0][2].env).toMatchObject({ PATH: `/login/bin${delimiter}/daemon/bin`, CODEX_HOME: '/daemon/codex', ONLY_LOGIN: '1', BOTH: 'daemon' })
  })

  // An empty segment is the folder codex runs in, the home folder: `env node` would run a `node` from there.
  it('an empty PATH on either side adds no empty segment', () => {
    const { parentEnv } = codexQueueDeps()
    vi.stubEnv('PATH', '/daemon/bin')
    expect(parentEnv().PATH).toBe('/daemon/bin')
    shell.env = { PATH: '/login/bin' }
    vi.stubEnv('PATH', '')
    expect(parentEnv().PATH).toBe('/login/bin')
    // Neither: no PATH at all, so the system's default is searched, never the folder.
    shell.env = { PATH: '' }
    expect(parentEnv().PATH).toBeUndefined()
    // Nor one inside a side: a profile's `PATH="$PATH:"` leaves one at its end, a doubled colon one in its middle.
    shell.env = { PATH: `/login/bin${delimiter}` }
    vi.stubEnv('PATH', `${delimiter}/daemon/a${delimiter}${delimiter}/daemon/b`)
    expect(parentEnv().PATH).toBe(['/login/bin', '/daemon/a', '/daemon/b'].join(delimiter))
  })

  // The interactive shell can take its 5 s: a computer whose dial never meets a Codex session never starts it.
  it('the login shell is read on first use: never at creation, once however often it is asked', async () => {
    const readLoginShell = vi.fn()
    const { queue } = recorder({ readLoginShell })
    expect(readLoginShell).not.toHaveBeenCalled()
    queue.can(false)
    queue.can(false)
    await queue.send(THREAD, 'hi', false)
    expect(readLoginShell).toHaveBeenCalledTimes(1)

    const sentFirst = vi.fn()
    await recorder({ readLoginShell: sentFirst }).queue.send(THREAD, 'hi', false)
    expect(sentFirst).toHaveBeenCalledTimes(1)

    const refused = vi.fn()
    expect(await recorder({ readLoginShell: refused }).queue.send('my session', 'hi', false)).toEqual(REFUSED)
    expect(refused).not.toHaveBeenCalled()
  })

  it('an app session on macOS runs the app\'s own codex; with none there it runs the other', async () => {
    const { calls, queue } = recorder({ appBinary: () => APP_CODEX })
    expect(await queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'queued' })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'queued' })
    const args = ['queue', '--thread', THREAD, '--message=hi']
    const how = { cwd: '/home/u', env: { PATH: '/usr/bin', CODEX_HOME: '/home/u/.codex' }, timeoutMs: 10_000 }
    expect(calls).toEqual([[APP_CODEX, args, how], [FAKE_CODEX, args, how]])

    const none = recorder()
    expect(await none.queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'queued' })
    expect(none.calls.map(([file]) => file)).toEqual([FAKE_CODEX])
  })

  it('can() is true for an app session with only the app\'s codex, and false for another session there', async () => {
    const { calls, queue } = recorder({ appBinary: () => APP_CODEX, binary: () => null })
    expect(queue.can(true)).toBe(true)
    expect(queue.can(false)).toBe(false)
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'no binary', ran: 'path' })
    expect(calls).toEqual([])
  })

  // The ChatGPT app and its CLI are macOS's and Windows': on Linux there is nothing to look for.
  it('on Linux the app\'s codex is never asked for', async () => {
    const appBinary = vi.fn(() => APP_CODEX)
    const { calls, queue } = recorder({ platform: 'linux', appBinary })
    expect(queue.can(true)).toBe(true)
    expect(await queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'queued' })
    expect(calls.map(([file]) => file)).toEqual([FAKE_CODEX])
    expect(appBinary).not.toHaveBeenCalled()
  })

  // An older app with no `queue` exits 2: run again through the other codex, the words could run twice.
  it('a failure names the codex that ran, and a failed app codex is not run again through the other', async () => {
    const app = recorder({ appBinary: () => APP_CODEX }, [2, 'not-started'])
    expect(await app.queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'failed', reason: 'exit 2', ran: 'app' })
    expect(app.calls.map(([file]) => file)).toEqual([APP_CODEX])
    expect(await app.queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'failed', reason: 'no binary', ran: 'app' })
    expect(app.calls.map(([file]) => file)).toEqual([APP_CODEX, APP_CODEX])

    const other = recorder({ appBinary: () => APP_CODEX }, [127])
    expect(await other.queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'exit 127', ran: 'path' })
    expect(other.calls.map(([file]) => file)).toEqual([FAKE_CODEX])
    expect(await other.queue.send('my session', 'hi', true)).toEqual(REFUSED)
  })

  it('the app\'s codex is the absolute path HARNESS_CODEX_APP_BIN names, alone; else the app in /Applications, then in ~/Applications', () => {
    const inApps = [
      '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      '/Users/u/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    ]
    for (const named of [undefined, '', 'codex']) expect(appCodexCandidates(named, '/Users/u')).toEqual(inApps)
    expect(appCodexCandidates('/t/app/codex', '/Users/u')).toEqual(['/t/app/codex'])
  })

  it('the real app look finds an executable there, passes over a file that cannot run, and holds 30 s', () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    onTestFinished(() => { vi.useRealTimers() })
    const bin = join(dir, 'ChatGPT.app', 'codex')
    vi.stubEnv('HARNESS_CODEX_APP_BIN', bin)
    const { appBinary } = codexQueueDeps()
    expect(appBinary()).toBeNull()
    mkdirSync(join(dir, 'ChatGPT.app'))
    writeFileSync(bin, '#!/bin/sh\nexit 0\n')
    vi.advanceTimersByTime(30_000)
    expect(appBinary()).toBeNull()
    chmodSync(bin, 0o755)
    vi.advanceTimersByTime(29_999)
    expect(appBinary()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(appBinary()).toBe(bin)
  })
})

describe('codex queue on Windows', () => {
  // PATH there is the daemon's own, with no login shell. The ChatGPT app holds a Codex of its own, which runs its
  // threads (docs/plans/2026-11-19-dial-windows-vm-notes.md `## Task 37`, section 2), as on macOS.
  it('an app session runs the app\'s own codex, another session the codex on PATH, and the login shell is never read', async () => {
    const readLoginShell = vi.fn()
    const { calls, queue } = recorder({ platform: 'win32', readLoginShell, appBinary: () => APP_CODEX })
    expect(queue.can(false)).toBe(true)
    expect(queue.can(true)).toBe(true)
    expect(await queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'queued' })
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'queued' })
    expect(calls.map(([file]) => file)).toEqual([APP_CODEX, FAKE_CODEX])
    expect(readLoginShell).not.toHaveBeenCalled()

    // A package with none: the codex on PATH.
    const none = recorder({ platform: 'win32' })
    expect(await none.queue.send(THREAD, 'hi', true)).toEqual({ outcome: 'queued' })
    expect(none.calls.map(([file]) => file)).toEqual([FAKE_CODEX])
  })

  it('can() is true for an app session with only the app\'s codex, and false for another session', () => {
    const { queue } = recorder({ platform: 'win32', appBinary: () => APP_CODEX, binary: () => null })
    expect(queue.can(true)).toBe(true)
    expect(queue.can(false)).toBe(false)
  })

  it('send runs codex queue with a text cmd.exe would split or expand as one argument', async () => {
    const { calls, queue } = recorder({ platform: 'win32' })
    const text = 'fix&calc | more 100%PATH% say "hi\r\nsecond line'
    expect(await queue.send(THREAD, text, false)).toEqual({ outcome: 'queued' })
    expect(calls.map(([, args]) => args)).toEqual([['queue', '--thread', THREAD, `--message=${text}`]])
  })

  it('a run that could not start is failed, no binary', async () => {
    const { queue } = recorder({ platform: 'win32' }, ['not-started'])
    expect(await queue.send(THREAD, 'hi', false)).toEqual({ outcome: 'failed', reason: 'no binary', ran: 'path' })
  })

  describe('the real run', () => {
    beforeEach(() => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
      Object.defineProperty(process, 'platform', { value: 'win32' })
      onTestFinished(() => { Object.defineProperty(process, 'platform', platform) })
    })

    /** Codex as npm installs it (fixtures/npm-codex.cmd, the VM's codex.cmd byte for byte), with a node.exe beside it. */
    function npmCodex() {
      const npm = join(dir, 'npm')
      const script = join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      mkdirSync(dirname(script), { recursive: true })
      writeFileSync(script, '')
      const shim = join(npm, 'codex.cmd')
      writeFileSync(shim, readFileSync(join(import.meta.dirname, '..', '..', 'lib', 'windows', 'fixtures', 'npm-codex.cmd')))
      const node = join(npm, 'node.exe')
      writeFileSync(node, '')
      return { shim, script, node }
    }

    it('starts the npm shim\'s node on its script, hidden, with no shell', async () => {
      const { shim, script, node } = npmCodex()
      vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], _options: object, done: (error: null) => void) => {
        done(null)
        return { pid: 1, stdin: null }
      }) as unknown as typeof execFile)
      const env = { PATH: dir, CODEX_HOME: join(dir, 'codex-home') }
      const args = ['queue', '--thread', THREAD, '--message=fix&calc 100%PATH%']
      expect(await codexQueueDeps().run(shim, args, { cwd: dir, env, timeoutMs: 10_000 })).toBe(0)
      const [file, given, how] = vi.mocked(execFile).mock.calls.at(-1)! as unknown as
        [string, string[], { shell?: unknown; windowsHide?: boolean; env?: NodeJS.ProcessEnv; cwd?: string }]
      expect(file).toBe(node)
      expect(given).toEqual([script, ...args])
      expect(how).toMatchObject({ cwd: dir, env, windowsHide: true })
      expect(how.shell).toBeUndefined()
    })

    /** The ChatGPT app's package as Windows installs it, in a folder named for its version, with its codex.exe. */
    function appPackage(version: string) {
      const folder = join(dir, `OpenAI.Codex_${version}_arm64__2p2nqsd0c76g0`)
      const codex = join(folder, 'app', 'resources', 'codex.exe')
      mkdirSync(dirname(codex), { recursive: true })
      return { folder, codex: executable(codex) }
    }

    /** A package query that waits for the test to answer each ask. */
    function packageQuery() {
      const asked: string[] = []
      const answers: Array<(folder: string | null) => void> = []
      const query = (name: string) => {
        asked.push(name)
        return new Promise<string | null>((resolve) => answers.push(resolve))
      }
      return { asked, answers, query }
    }

    it('the app\'s codex is the OpenAI.Codex package\'s, asked once in the background; the codex on PATH answers until it has', async () => {
      vi.useFakeTimers({ toFake: ['performance'] })
      onTestFinished(() => { vi.useRealTimers() })
      const app = appPackage('26.1117.3838.0')
      const { asked, answers, query } = packageQuery()
      const { appBinary } = codexQueueDeps(storePackageLook('OpenAI.Codex', query))
      expect(appBinary()).toBeNull()
      vi.advanceTimersByTime(30_000)
      expect(appBinary()).toBeNull()
      // One ask at a time.
      expect(asked).toEqual(['OpenAI.Codex'])
      answers[0]!(app.folder)
      await settled()
      expect(appBinary()).toBe(app.codex)
      // Asking starts a PowerShell: a codex.exe that is there is never asked for again.
      vi.advanceTimersByTime(600_000)
      expect(appBinary()).toBe(app.codex)
      expect(asked).toHaveLength(1)
    })

    it('a package folder is not asked for again while it is there, codex.exe in it or not, and one that went (an update) at once', async () => {
      vi.useFakeTimers({ toFake: ['performance'] })
      onTestFinished(() => { vi.useRealTimers() })
      const { asked, answers, query } = packageQuery()
      const { appBinary } = codexQueueDeps(storePackageLook('OpenAI.Codex', query))
      const empty = appPackage('26.1100.0.0')
      rmSync(empty.codex)
      expect(appBinary()).toBeNull()
      answers[0]!(empty.folder)
      await settled()
      // Asking starts a PowerShell: twenty minutes of looks ask nothing more.
      for (let look = 0; look < 40; look++) {
        vi.advanceTimersByTime(30_000)
        expect(appBinary()).toBeNull()
      }
      expect(asked).toHaveLength(1)

      // An update removes the old version's folder; the new one is in a folder named for its version.
      rmSync(empty.folder, { recursive: true })
      const old = appPackage('26.1117.3838.0')
      vi.advanceTimersByTime(30_000)
      expect(appBinary()).toBeNull()
      expect(asked).toHaveLength(2)
      answers[1]!(old.folder)
      await settled()
      expect(appBinary()).toBe(old.codex)
      rmSync(old.folder, { recursive: true })
      const updated = appPackage('26.1201.1000.0')
      vi.advanceTimersByTime(30_000)
      expect(appBinary()).toBeNull()
      expect(asked).toHaveLength(3)
      answers[2]!(updated.folder)
      await settled()
      expect(appBinary()).toBe(updated.codex)
    })

    it('a package not installed, or a query that fails, is no app codex, and is asked again after 10 minutes', async () => {
      vi.useFakeTimers({ toFake: ['performance'] })
      onTestFinished(() => { vi.useRealTimers() })
      const asked: string[] = []
      // Not installed, then a query that fails.
      const { appBinary } = codexQueueDeps(storePackageLook('OpenAI.Codex', async (name) => {
        asked.push(name)
        if (asked.length === 1) return null
        throw new Error('no PowerShell')
      }))
      expect(appBinary()).toBeNull()
      await settled()
      for (const ask of [1, 2]) {
        vi.advanceTimersByTime(570_000)
        expect(appBinary()).toBeNull()
        expect(asked).toHaveLength(ask)
        vi.advanceTimersByTime(30_000)
        expect(appBinary()).toBeNull()
        await settled()
        expect(asked).toHaveLength(ask + 1)
      }
    })

    it('a batch file only cmd.exe could run is not started', async () => {
      const other = join(dir, 'codex.cmd')
      writeFileSync(other, '@echo off\r\nstart calc %*\r\n')
      const before = vi.mocked(execFile).mock.calls.length
      expect(await codexQueueDeps().run(other, ['queue'], options())).toBe('not-started')
      expect(vi.mocked(execFile).mock.calls.length).toBe(before)
    })
  })
})
