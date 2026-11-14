import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrcaActions, ORCA_HANDLE, orcaDeps, type OrcaDeps } from './orca.js'

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
    expect(fake.argv()).toEqual(['terminal', 'send', '--terminal', HANDLE, '--text', 'fix the login bug', '--enter', '--wait-submit', '5', '--json'])
  })

  it('a text with quotes, $( ) and a leading -- reaches orca unchanged as the value of --text', async () => {
    const fake = fakeOrca()
    const marker = join(dir, 'ran')
    const text = `-- it's "quoted" $(touch ${marker}) \`touch ${marker}\` ; touch ${marker} | touch ${marker}`
    const orca = createOrcaActions({ ...orcaDeps(), onPath: () => fake.file })
    expect(await orca.send(HANDLE, text)).toBe(true)
    expect(fake.argv()).toHaveLength(10)
    expect(fake.argv()[5]).toBe(text)
    expect(existsSync(marker)).toBe(false)
  })

  it('a transcript with a newline or a control character is typed as one line', async () => {
    const { calls, orca } = recorder()
    expect(await orca.send(HANDLE, 'first line\nsecond\r\tthird\u001b[2J\u007f\u009bend\u0000')).toBe(true)
    expect(calls[0].args[5]).toBe('first line second  third [2J  end ')
  })

  it('open switches, then brings Orca forward on macOS only', async () => {
    const mac = recorder()
    expect(await mac.orca.open(HANDLE)).toBe(true)
    expect(mac.calls).toEqual([
      { file: FAKE_PATH_ORCA, args: ['terminal', 'switch', '--terminal', HANDLE, '--json'], timeoutMs: 10_000 },
      { file: '/usr/bin/open', args: ['-b', 'com.stablyai.orca'], timeoutMs: 10_000 },
    ])

    const linux = recorder({ platform: 'linux' })
    expect(await linux.orca.open(HANDLE)).toBe(true)
    expect(linux.calls.map((call) => call.args)).toEqual([['terminal', 'switch', '--terminal', HANDLE, '--json']])

    // A failed switch brings nothing forward; a switch that worked stays true when Orca does not come forward.
    const refused = recorder({}, [1])
    expect(await refused.orca.open(HANDLE)).toBe(false)
    expect(refused.calls).toHaveLength(1)
    const notForward = recorder({}, [0, 1])
    expect(await notForward.orca.open(HANDLE)).toBe(true)
    expect(notForward.calls).toHaveLength(2)
  })

  it('a handle that is not term_<uuid> runs nothing', async () => {
    expect(ORCA_HANDLE.test(HANDLE)).toBe(true)
    const { calls, orca } = recorder()
    for (const handle of ['', 'term_', 'term_0f8e2c1a', HANDLE.toUpperCase(), `${HANDLE}0`, `${HANDLE}\n`, ` ${HANDLE}`, `term_${'g'.repeat(36)}`, '--help']) {
      expect(await orca.send(handle, 'hi')).toBe(false)
      expect(await orca.open(handle)).toBe(false)
    }
    expect(calls).toEqual([])
  })

  it('no orca on PATH and none in the app runs nothing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, orca } = recorder({ platform, onPath: () => null })
      expect(await orca.send(HANDLE, 'hi')).toBe(false)
      expect(await orca.open(HANDLE)).toBe(false)
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

  it('a run that ignores SIGTERM is killed at its deadline and is false', async () => {
    const pidFile = join(dir, 'pid')
    // Deaf to the kill's SIGTERM, it would exit 0 once its sleep ends, as if the text had been sent.
    const fake = fakeOrca(`trap '' TERM\necho $$ > '${pidFile}'\nexec sleep 3`)
    const real = orcaDeps()
    const orca = createOrcaActions({ ...real, onPath: () => fake.file, run: (file, args) => real.run(file, args, 1000) })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
  })

  it('a non-zero exit is false', async () => {
    const fake = fakeOrca('exit 3')
    const orca = createOrcaActions({ ...orcaDeps(), onPath: () => fake.file })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    expect(await orcaDeps().run(fake.file, [], 10_000)).toEqual({ code: 3 })
    // A binary that cannot start has no exit code.
    expect(await orcaDeps().run(join(dir, 'missing'), [], 10_000)).toEqual({ code: null })
  })

  it('a second command for the same handle while one runs is false; another handle\'s runs', async () => {
    const calls: string[][] = []
    const waiting: Array<() => void> = []
    const orca = createOrcaActions({
      run: (_file, args) => {
        calls.push(args)
        return new Promise((resolve) => waiting.push(() => resolve({ code: 0 })))
      },
      onPath: () => FAKE_PATH_ORCA,
      exists: () => false,
      platform: 'linux',
    })
    const first = orca.send(HANDLE, 'one')
    expect(await orca.send(HANDLE, 'two')).toBe(false)
    expect(await orca.open(HANDLE)).toBe(false)
    const other = orca.open(OTHER)
    expect(calls.map((args) => args[3])).toEqual([HANDLE, OTHER])
    for (const done of waiting) done()
    expect(await first).toBe(true)
    expect(await other).toBe(true)

    // Once its command has ended, the handle takes the next one.
    const next = orca.send(HANDLE, 'three')
    waiting[2]()
    expect(await next).toBe(true)
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
