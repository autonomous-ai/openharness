import { type ChildProcess, execFile } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createOrcaActions, ORCA_HANDLE, orcaDeps, type OrcaDeps } from './orca.js'

// The real execFile, watched: a spec reads how the child of a run ended.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile) }
})

const HANDLE = 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER = 'term_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const FAKE_PATH_ORCA = '/fake/bin/orca'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A fake `orca` that writes its arguments, NUL-separated, then runs [tail]. Never the real one. */
function fakeOrca(tail = 'exit 0'): { file: string; argv(): string[] } {
  const file = join(dir, 'orca')
  const out = join(dir, 'argv')
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\0' "$@" > '${out}'\n${tail}\n`)
  chmodSync(file, 0o755)
  return { file, argv: () => readFileSync(out, 'utf8').split('\0').slice(0, -1) }
}

interface Call { file: string; args: string[]; timeoutMs: number }

/** A recording `run` that runs nothing: each call answers the next of [codes], then exit 0. */
function recorder(over: Partial<OrcaDeps> = {}, codes: Array<number | null> = []) {
  const calls: Call[] = []
  const deps: OrcaDeps = {
    run: async (file, args, timeoutMs) => {
      calls.push({ file, args, timeoutMs })
      return { code: codes.length ? codes.shift()! : 0 }
    },
    onPath: (name) => (name === 'orca' ? FAKE_PATH_ORCA : null),
    exists: () => false,
    platform: 'darwin',
    ...over,
  }
  return { calls, orca: createOrcaActions(deps) }
}

describe('Orca actions', () => {
  it('send passes the exact argv, the text as one argument', async () => {
    const fake = fakeOrca()
    const orca = createOrcaActions({ ...orcaDeps(), onPath: () => fake.file })
    expect(await orca.send(HANDLE, 'fix the login bug')).toBe(true)
    expect(fake.argv()).toEqual(['terminal', 'send', '--terminal', HANDLE, '--text=fix the login bug', '--enter', '--wait-submit', '5', '--json'])
  })

  it('a text with quotes, $( ) and a leading -- reaches orca unchanged inside --text=, where orca never reads it as a flag', async () => {
    const fake = fakeOrca()
    const marker = join(dir, 'ran')
    const text = `-- it's "quoted" $(touch ${marker}) \`touch ${marker}\` ; touch ${marker} | touch ${marker}`
    const orca = createOrcaActions({ ...orcaDeps(), onPath: () => fake.file })
    expect(await orca.send(HANDLE, text)).toBe(true)
    expect(fake.argv()).toHaveLength(9)
    expect(fake.argv()[4]).toBe(`--text=${text}`)
    expect(existsSync(marker)).toBe(false)
  })

  it('a transcript with a newline or a control character is typed as one line', async () => {
    const { calls, orca } = recorder()
    expect(await orca.send(HANDLE, 'first line\nsecond\r\tthird\u001b[2J\u007f\u009bend\u0000')).toBe(true)
    expect(calls[0].args[4]).toBe('--text=first line second  third [2J  end ')
  })

  // Orca comes forward with every other app, by its bundle id (open.ts): the switch only picks the terminal inside it.
  it('switchTo runs the switch alone, on every platform: ok when it exits 0, failed when it does not', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, orca } = recorder({ platform })
      expect(await orca.switchTo(HANDLE)).toBe('ok')
      expect(calls).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', 'switch', '--terminal', HANDLE, '--json'], timeoutMs: 10_000 }])
    }
    // A non-zero exit, then a run with no exit code (its timeout's kill).
    const refused = recorder({}, [1, null])
    expect(await refused.orca.switchTo(HANDLE)).toBe('failed')
    expect(await refused.orca.switchTo(HANDLE)).toBe('failed')
    expect(refused.calls).toHaveLength(2)
  })

  it('a handle that is not term_<uuid> runs nothing', async () => {
    expect(ORCA_HANDLE.test(HANDLE)).toBe(true)
    const { calls, orca } = recorder()
    for (const handle of ['', 'term_', 'term_0f8e2c1a', HANDLE.toUpperCase(), `${HANDLE}0`, `${HANDLE}\n`, ` ${HANDLE}`, `term_${'g'.repeat(36)}`, '--help']) {
      expect(await orca.send(handle, 'hi')).toBe(false)
      expect(await orca.switchTo(handle)).toBe('failed')
    }
    expect(calls).toEqual([])
  })

  it('no orca on PATH and none in the app runs nothing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, orca } = recorder({ platform, onPath: () => null })
      expect(await orca.send(HANDLE, 'hi')).toBe(false)
      expect(await orca.switchTo(HANDLE)).toBe('failed')
      expect(calls).toEqual([])
    }
    // The app's folder is a macOS path: Linux never runs it.
    const linux = recorder({ platform: 'linux', onPath: () => null, exists: () => true })
    expect(await linux.orca.send(HANDLE, 'hi')).toBe(false)
    expect(linux.calls).toEqual([])

    // The real lookup reads PATH.
    vi.stubEnv('PATH', dir)
    expect(orcaDeps().onPath('orca')).toBeNull()
    const fake = fakeOrca()
    expect(orcaDeps().onPath('orca')).toBe(fake.file)
  })

  it('the app\'s own binary is used on macOS when PATH has none', async () => {
    const looked: string[] = []
    const { calls, orca } = recorder({ onPath: () => null, exists: (path) => { looked.push(path); return path === APP_ORCA } })
    expect(await orca.send(HANDLE, 'hi')).toBe(true)
    expect(calls.map((call) => call.file)).toEqual([APP_ORCA])
    expect(looked).toEqual([APP_ORCA])

    const both = recorder({ exists: () => true })
    expect(await both.orca.send(HANDLE, 'hi')).toBe(true)
    expect(both.calls.map((call) => call.file)).toEqual([FAKE_PATH_ORCA])
  })

  it('a run that outlasts 10 s is killed and is false', async () => {
    // The fake sleeps 300 s, past the test's own timeout: an answer at all means it was killed.
    const fake = fakeOrca('exec sleep 300')
    const real = orcaDeps()
    const asked: number[] = []
    const orca = createOrcaActions({
      ...real,
      onPath: () => fake.file,
      // The real run, with the 10 s it is asked for cut short so the test does not wait them out.
      run: (file, args, timeoutMs) => {
        asked.push(timeoutMs)
        return real.run(file, args, 200)
      },
    })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    expect(asked).toEqual([10_000])
  })

  it('a run that ignores SIGTERM is killed with SIGKILL at its deadline and is false', async () => {
    // Deaf to SIGTERM, it would outlive a kill that sent one: its sleep runs past the test's own timeout.
    const fake = fakeOrca(`trap '' TERM\nexec sleep 300`)
    const real = orcaDeps()
    const orca = createOrcaActions({ ...real, onPath: () => fake.file, run: (file, args) => real.run(file, args, 1000) })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    // The run's own child says how it ended. A pid file the fake writes may not exist yet: on a loaded machine its shell
    // can still be starting at the deadline.
    const child = vi.mocked(execFile).mock.results.at(-1)!.value as ChildProcess
    // A run that is never killed fails the test on its timeout, and its sleep, deaf to SIGTERM, would outlive the suite.
    onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    // Answered by the deadline, the child may still be on its way out.
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    expect(child.signalCode).toBe('SIGKILL')
  })

  it('a non-zero exit is false', async () => {
    const fake = fakeOrca('exit 3')
    const orca = createOrcaActions({ ...orcaDeps(), onPath: () => fake.file })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    expect(await orcaDeps().run(fake.file, [], 10_000)).toEqual({ code: 3 })
    // A binary that cannot start has no exit code.
    expect(await orcaDeps().run(join(dir, 'missing'), [], 10_000)).toEqual({ code: null })
  })

  /** A `run` that holds each command until the test lets it end. */
  function held() {
    const calls: string[][] = []
    const waiting: Array<(code?: number | null) => void> = []
    const orca = createOrcaActions({
      run: (_file, args) => {
        calls.push(args)
        return new Promise((resolve) => waiting.push((code = 0) => resolve({ code })))
      },
      onPath: () => FAKE_PATH_ORCA,
      exists: () => false,
      platform: 'linux',
    })
    return { calls, waiting, orca }
  }

  it('a second command for the same handle while one runs is false; another handle\'s runs', async () => {
    const { calls, waiting, orca } = held()
    const first = orca.send(HANDLE, 'one')
    expect(await orca.send(HANDLE, 'two')).toBe(false)
    const other = orca.switchTo(OTHER)
    expect(calls.map((args) => args[3])).toEqual([HANDLE, OTHER])
    for (const done of waiting) done()
    expect(await first).toBe(true)
    expect(await other).toBe('ok')

    // Once its command has ended, the handle takes the next one.
    const next = orca.send(HANDLE, 'three')
    waiting[2]()
    expect(await next).toBe(true)
  })

  it('a switch for a handle whose words are still typed is busy and runs nothing', async () => {
    const { calls, waiting, orca } = held()
    const sent = orca.send(HANDLE, 'one')
    expect(await orca.switchTo(HANDLE)).toBe('busy')
    expect(calls).toHaveLength(1)
    waiting[0]()
    expect(await sent).toBe(true)
  })

  // A tap 0.4 to 1 s after a swipe's rest meets the rest's switch: it is the tap's too, and then Orca comes forward.
  it('a switch while a switch for the same handle runs is ok from that one run; another handle\'s runs', async () => {
    const { calls, waiting, orca } = held()
    const rest = orca.switchTo(HANDLE)
    const tap = orca.switchTo(HANDLE)
    const other = orca.switchTo(OTHER)
    expect(calls.map((args) => args[3])).toEqual([HANDLE, OTHER])
    for (const done of waiting) done()
    expect(await rest).toBe('ok')
    expect(await tap).toBe('ok')
    expect(await other).toBe('ok')

    // Once it has ended, the next switch is a run of its own, with its own outcome.
    const next = orca.switchTo(HANDLE)
    expect(calls).toHaveLength(3)
    waiting[2](1)
    expect(await next).toBe('failed')
  })

  // A switch types nothing: the words wait for it to end, then are typed, and no other words go with them.
  it('a send while a switch runs on its terminal waits for the switch, then types; a second send meanwhile is false', async () => {
    const { calls, waiting, orca } = held()
    const shown = orca.switchTo(HANDLE)
    const sent = orca.send(HANDLE, 'one')
    expect(await orca.send(HANDLE, 'two')).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls.map((args) => args[1])).toEqual(['switch'])
    waiting[0]()
    expect(await shown).toBe('ok')
    await vi.waitFor(() => expect(calls.map((args) => args[1])).toEqual(['switch', 'send']))
    expect(calls[1][4]).toBe('--text=one')
    waiting[1]()
    expect(await sent).toBe(true)
  })

  // The words name their terminal: a switch that failed or timed out (the run's 10 s deadline answers no code) shows
  // nothing, and they are typed all the same.
  it('a send behind a switch that fails or times out still types, and a switch while it types is busy', async () => {
    const { calls, waiting, orca } = held()
    const shown = orca.switchTo(HANDLE)
    const sent = orca.send(HANDLE, 'one')
    waiting[0](null)
    expect(await shown).toBe('failed')
    await vi.waitFor(() => expect(calls.map((args) => args[1])).toEqual(['switch', 'send']))
    expect(await orca.switchTo(HANDLE)).toBe('busy')
    waiting[1]()
    expect(await sent).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('a text over 2000 characters runs nothing', async () => {
    const { calls, orca } = recorder()
    expect(await orca.send(HANDLE, 'a'.repeat(2001))).toBe(false)
    expect(calls).toEqual([])
    expect(await orca.send(HANDLE, 'a'.repeat(2000))).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('an empty text runs nothing', async () => {
    const { calls, orca } = recorder()
    expect(await orca.send(HANDLE, '')).toBe(false)
    expect(calls).toEqual([])
  })
})
