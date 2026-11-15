import { type ChildProcess, execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CODEX_THREAD, codexQueueDeps, createCodexQueue, type CodexQueueDeps, type CodexRunEnd } from './codexQueue.js'

// The real execFile, watched: a spec reads how the child of a run ended.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile) }
})

const THREAD = '01a1de76-a3b7-7270-b39e-1245893274c1'
const OTHER = '9b2f4c1e-7d3a-4e5b-8c6d-0e1f2a3b4c5d'
const FAKE_CODEX = '/fake/bin/codex'
const REFUSED = { outcome: 'failed', reason: 'refused' }

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-queue-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

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
  const file = executable(join(dir, 'codex'), [
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
const options = () => ({ cwd: dir, env: {}, timeoutMs: 10_000 })

describe('codex queue', () => {
  it('send runs codex queue with the thread and the text joined to its flag, in the home directory, under the Codex home, for 10 s', async () => {
    const { calls, queue } = recorder()
    expect(await queue.send(THREAD, 'fix the login bug')).toEqual({ outcome: 'queued' })
    expect(calls).toEqual([[
      FAKE_CODEX,
      ['queue', '--thread', THREAD, '--message=fix the login bug'],
      { cwd: '/home/u', env: { CODEX_HOME: '/home/u/.codex' }, timeoutMs: 10_000 },
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
    expect(await queue.send(THREAD, text)).toEqual({ outcome: 'queued' })
    expect(fake.argv()).toEqual(['queue', '--thread', THREAD, `--message=${text}`])
    expect(existsSync(marker)).toBe(false)
    expect(fake.home()).toBe(home)
    expect(fake.cwd()).toBe(realpathSync(cwd))
  })

  it('a thread id that is not a lower-case UUID, an empty text, one over 2000 characters and one with a NUL run nothing and answer failed, refused', async () => {
    expect(CODEX_THREAD.test(THREAD)).toBe(true)
    const { calls, queue } = recorder()
    for (const id of ['', THREAD.toUpperCase(), `${THREAD}; rm -rf /`, '--help', 'my session']) {
      expect(await queue.send(id, 'hi')).toEqual(REFUSED)
    }
    for (const text of ['', 'a'.repeat(2001), 'one\0two']) {
      expect(await queue.send(THREAD, text)).toEqual(REFUSED)
    }
    expect(calls).toEqual([])
    expect(await queue.send(THREAD, 'a'.repeat(2000))).toEqual({ outcome: 'queued' })
    expect(calls).toHaveLength(1)
  })

  it('exit 0 is queued; a non-zero exit is failed with its exit code; a binary that cannot start, and no binary, are failed with no binary', async () => {
    const { queue } = recorder({}, [0, 1, 127, 'not-started'])
    expect(await queue.send(THREAD, 'hi')).toEqual({ outcome: 'queued' })
    expect(await queue.send(THREAD, 'hi')).toEqual({ outcome: 'failed', reason: 'exit 1' })
    expect(await queue.send(THREAD, 'hi')).toEqual({ outcome: 'failed', reason: 'exit 127' })
    expect(await queue.send(THREAD, 'hi')).toEqual({ outcome: 'failed', reason: 'no binary' })

    const none = recorder({ binary: () => null })
    expect(await none.queue.send(THREAD, 'hi')).toEqual({ outcome: 'failed', reason: 'no binary' })
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
    expect(await queue.send(THREAD, 'hi')).toEqual({ outcome: 'timeout' })
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
    expect(await realQueue(fake.file).send(THREAD, 'hi')).toEqual({ outcome: 'timeout' })
  })

  it('run ends its codex\'s stdin at once', async () => {
    const fake = fakeCodex('cat > /dev/null')
    expect(await codexQueueDeps().run(fake.file, [], options())).toBe(0)
  })

  it('a second send for the same thread while one runs is busy and runs nothing; another thread\'s runs; the thread is free again after queued, failed and timeout', async () => {
    const { calls, waiting, queue } = held()
    const first = queue.send(THREAD, 'one')
    expect(await queue.send(THREAD, 'two')).toEqual({ outcome: 'busy' })
    const other = queue.send(OTHER, 'three')
    expect(calls.map(([, args]) => args[2])).toEqual([THREAD, OTHER])
    waiting[0](0)
    waiting[1](0)
    expect(await first).toEqual({ outcome: 'queued' })
    expect(await other).toEqual({ outcome: 'queued' })

    // After queued, after failed, after timeout: each next send runs.
    const failed = queue.send(THREAD, 'four')
    waiting[2](1)
    expect(await failed).toEqual({ outcome: 'failed', reason: 'exit 1' })
    const timedOut = queue.send(THREAD, 'five')
    waiting[3]('unknown')
    expect(await timedOut).toEqual({ outcome: 'timeout' })
    const next = queue.send(THREAD, 'six')
    waiting[4](0)
    expect(await next).toEqual({ outcome: 'queued' })
    expect(calls).toHaveLength(5)
  })

  it('can() is whether the binary is there, asked each time, and false on Windows', async () => {
    let found: string | null = null
    const { queue } = recorder({ binary: () => found })
    expect(queue.can()).toBe(false)
    found = FAKE_CODEX
    expect(queue.can()).toBe(true)
    found = null
    expect(queue.can()).toBe(false)

    const windows = recorder({ platform: 'win32' })
    expect(windows.queue.can()).toBe(false)
    expect(await windows.queue.send(THREAD, 'hi')).toEqual({ outcome: 'failed', reason: 'no binary' })
    expect(windows.calls).toEqual([])
  })

  it('the binary is the Codex Harness launches, asked each time', () => {
    const { binary } = codexQueueDeps()
    vi.stubEnv('CODEX_PATH', '')
    vi.stubEnv('PATH', dir)
    expect(binary()).toBeNull()
    const onPath = executable(join(dir, 'codex'))
    expect(binary()).toBe(onPath)

    // Its own path, missing: Harness would not launch the codex on PATH, so neither does the queue.
    const own = join(dir, 'other', 'my-codex')
    vi.stubEnv('CODEX_PATH', own)
    expect(binary()).toBeNull()
    mkdirSync(join(dir, 'other'))
    executable(own)
    expect(binary()).toBe(own)
  })
})
