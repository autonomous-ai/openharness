/**
 * Orca's account homes, from a fake `orca` answer in Orca 1.4.256's shape with made-up ids and emails, and throwaway
 * folders as the homes. The real `orca`, the person's Orca profiles and ~/.claude are never run or read.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createOrcaHomesCache,
  orcaBinary,
  type OrcaHomes,
  orcaHomesDeps,
  type OrcaHomesDeps,
  type OrcaHomesFailure,
  type OrcaHomesRead,
  readOrcaHomes,
} from './orcaHomes.js'
import { writeExecutable } from '../testing/executableFixture.js'

// The real spawn, watched: a spec reads how the child of a run ended.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, spawn: vi.fn(real.spawn) }
})

const uid = process.getuid!()
const FAKE_ORCA = '/fake/bin/orca'
const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const NONE: OrcaHomes = { claude: [], codex: [] }

const cleanup: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway folder of this user's, by its real path. */
function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-home-')))
  cleanup.push(dir)
  return dir
}

/** An empty file at [path] in a throwaway folder. On Windows each `\` in [path] is a folder; elsewhere it is part of the
 *  file's name, so the real path ends as a Windows one does on both. */
function file(path: string): string {
  const made = join(home(), path)
  mkdirSync(dirname(made), { recursive: true })
  writeFileSync(made, '')
  return made
}

/** PATH holding [found], in order: the first that `accept` takes, as resolveBinaryOnPath answers. */
const onPathOf = (found: string[], names: string[] = []) => (name: string, accept: (path: string) => boolean) => {
  names.push(name)
  return name === 'orca' ? found.find(accept) ?? null : null
}

const LOCAL_APP_DATA = 'C:\\Users\\a\\AppData\\Local'
const DEFAULT_ORCA = 'C:\\Users\\a\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe'
const ORCA_CMD = join(import.meta.dirname, '../lib/windows/fixtures/orca.cmd')

/** One account of `orca account list --json`, made up: Orca's id and email beside its home. */
const account = (n: number, home: unknown) => ({
  id: `acct-${n}-5d1e9b`,
  email: `person${n}@example.com`,
  label: `Made up ${n}`,
  home,
  createdAt: 1763337600000,
})
/** The whole answer, with an engine this module does not read beside the two it does. */
const answer = (claude: unknown, codex: unknown = { accounts: [] }) =>
  JSON.stringify({ id: 'req-1', ok: true, result: { claude, codex, gemini: { activeAccountId: null, accounts: [] } } })
const engine = (...accounts: unknown[]) => ({ activeAccountId: 'acct-1-5d1e9b', accounts })

type RunAnswer = Awaited<ReturnType<OrcaHomesDeps['run']>>
interface Call { file: string; args: string[]; opts: { timeoutMs: number; maxBytes: number } }

/** Deps whose `run` runs nothing: it records each call and answers [answer], by default exit 0 with nothing printed. */
function fakeDeps(answered: Partial<RunAnswer> = {}, over: Partial<OrcaHomesDeps> = {}) {
  const calls: Call[] = []
  const deps: OrcaHomesDeps = {
    run: async (file, args, opts) => {
      calls.push({ file, args, opts })
      return { code: 0, stdout: '', timedOut: false, ...answered }
    },
    onPath: (name) => (name === 'orca' ? FAKE_ORCA : null),
    exists: () => false,
    platform: 'darwin',
    uid,
    ...over,
  }
  return { calls, deps }
}

describe('orcaBinary', () => {
  it("is the orca on PATH, else, on macOS, the app's own", () => {
    expect(orcaBinary({ onPath: (name) => (name === 'orca' ? FAKE_ORCA : null), exists: () => true, platform: 'darwin' })).toBe(FAKE_ORCA)
    const looked: string[] = []
    expect(orcaBinary({ onPath: () => null, exists: (path) => { looked.push(path); return path === APP_ORCA }, platform: 'darwin' })).toBe(APP_ORCA)
    expect(looked).toEqual([APP_ORCA])
    expect(orcaBinary({ onPath: () => null, exists: () => false, platform: 'darwin' })).toBeNull()
    // The app's folder is a macOS path.
    expect(orcaBinary({ onPath: () => null, exists: () => true, platform: 'linux' })).toBeNull()
  })

  // Orca's CLI on Windows is the native `<Orca>\resources\bin\orca.exe`. The `orca.cmd` beside it only forwards to it,
  // through cmd.exe, which reparses every argument (fixtures/orca.cmd).
  describe('on Windows', () => {
    it("is Orca's orca.exe on PATH, by its real path, in any case", () => {
      const names: string[] = []
      const exe = file('Orca\\resources\\bin\\orca.exe')
      expect(orcaBinary({ onPath: onPathOf([exe], names), exists: () => false, platform: 'win32', localAppData: LOCAL_APP_DATA })).toBe(exe)
      expect(names).toEqual(['orca'])
      const upper = file('ORCA\\Resources\\Bin\\Orca.EXE')
      expect(orcaBinary({ onPath: onPathOf([upper]), exists: () => false, platform: 'win32' })).toBe(upper)
    })

    it("an orca.cmd, even in resources\\bin, another orca.exe and the other platforms' launchers are not taken", () => {
      const others = [
        file('Orca\\resources\\bin\\orca.cmd'), file('other\\orca.exe'), file('Orca\\resources\\orca.exe'),
        file('Orca/resources/bin/orca'), file('Orca/resources/bin/orca-ide'), file('Orca.app/Contents/Resources/bin/orca'),
      ]
      expect(orcaBinary({ onPath: onPathOf(others), exists: () => false, platform: 'win32' })).toBeNull()
      const exe = file('Orca\\resources\\bin\\orca.exe')
      expect(orcaBinary({ onPath: onPathOf([...others, exe]), exists: () => false, platform: 'win32' })).toBe(exe)
    })

    // Orca's installer does not put resources\bin on PATH (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 1 §2).
    it('else the orca.exe of the per-user install, when it is there', () => {
      const looked: string[] = []
      const exists = (path: string) => { looked.push(path); return path === DEFAULT_ORCA }
      expect(orcaBinary({ onPath: () => null, exists, platform: 'win32', localAppData: LOCAL_APP_DATA })).toBe(DEFAULT_ORCA)
      expect(looked).toEqual([DEFAULT_ORCA])
      // An orca.cmd alone there, or nothing, is none.
      const cmd = DEFAULT_ORCA.replace(/\.exe$/, '.cmd')
      expect(orcaBinary({ onPath: () => null, exists: (path) => path === cmd, platform: 'win32', localAppData: LOCAL_APP_DATA })).toBeNull()
      expect(orcaBinary({ onPath: () => null, exists: () => false, platform: 'win32', localAppData: LOCAL_APP_DATA })).toBeNull()
      // The one on PATH comes first.
      const exe = file('Orca\\resources\\bin\\orca.exe')
      expect(orcaBinary({ onPath: onPathOf([exe]), exists: () => true, platform: 'win32', localAppData: LOCAL_APP_DATA })).toBe(exe)
    })

    it('a LOCALAPPDATA that is not absolute, or none, gives no default, and the macOS app is never looked at', () => {
      for (const localAppData of ['AppData\\Local', '.', '', undefined]) {
        const looked: string[] = []
        const exists = (path: string) => { looked.push(path); return true }
        expect(orcaBinary({ onPath: () => null, exists, platform: 'win32', localAppData }), localAppData).toBeNull()
        expect(looked).toEqual([])
      }
    })

    it('elsewhere the per-user install is never looked at', () => {
      for (const platform of ['darwin', 'linux'] as const) {
        const looked: string[] = []
        orcaBinary({ onPath: () => null, exists: (path) => { looked.push(path); return false }, platform, localAppData: LOCAL_APP_DATA })
        expect(looked).not.toContain(DEFAULT_ORCA)
      }
    })
  })
})

describe('readOrcaHomes', () => {
  it("keeps each account's home and nothing else", async () => {
    const [a, b, c] = [home(), home(), home()]
    const { calls, deps } = fakeDeps({ stdout: answer(engine(account(1, a), account(2, b)), engine(account(3, c))) })
    const read = await readOrcaHomes(deps)
    expect(read).toEqual({ homes: { claude: [a, b], codex: [c] } })
    const kept = JSON.stringify(read)
    for (const n of [1, 2, 3]) expect(kept).not.toContain(`acct-${n}`)
    expect(kept).not.toContain('@')
    expect(kept).not.toContain('Made up')
    expect(calls).toEqual([{ file: FAKE_ORCA, args: ['account', 'list', '--json'], opts: { timeoutMs: 5000, maxBytes: 262144 } }])
  })

  it('refuses a home that is relative, not normalised, missing, a file, another user\'s, too long or holds a control character', async () => {
    const base = home()
    const kept = join(base, 'a')
    mkdirSync(kept)
    const file = join(base, 'file')
    writeFileSync(file, '')
    const tab = join(base, 'a\tb')
    const newline = join(base, 'a\nb')
    mkdirSync(tab)
    mkdirSync(newline)
    // Past 1024 bytes. Linux's PATH_MAX is 4096, so the folder is real there and only the bound refuses it; macOS's is
    // 1024, so no folder can have it.
    const long = join(base, ...Array<string>(6).fill('d'.repeat(200)))
    if (process.platform === 'linux') mkdirSync(long, { recursive: true })
    // Each but the missing one names a real folder of this user's, or a file: only the check named refuses it.
    const refused: unknown[] = [
      relative(process.cwd(), kept), `${base}/a/../a`, `${base}/./a`, `${base}//a`, `${kept}/`,
      join(base, 'missing'), file, tab, newline, long, 42, null, {}, [kept],
    ]
    const { deps } = fakeDeps({ stdout: answer(
      engine(null, kept.slice(1), ...refused.map((path, n) => account(n, path)), account(99, kept)),
      engine(...refused.map((path, n) => account(n, path)), account(100, kept)),
    ) })
    expect(await readOrcaHomes(deps)).toEqual({ homes: { claude: [kept], codex: [kept] } })
    // Another user's: the same folder, owned by a uid that is not this one.
    expect(await readOrcaHomes({ ...deps, uid: uid + 1 })).toEqual({ homes: NONE })
  })

  it('on Windows it runs orca.exe and keeps a home that is a folder of this account', async () => {
    const a = home()
    const exe = file('Orca\\resources\\bin\\orca.exe')
    // Windows has no uid (-1): there the profile decides (dialSkill.ts ownDirectory).
    const { calls, deps } = fakeDeps({ stdout: answer(engine(account(1, a))) }, { platform: 'win32', onPath: onPathOf([exe]), uid: process.getuid?.() ?? -1 })
    expect(await readOrcaHomes(deps)).toEqual({ homes: { claude: [a], codex: [] } })
    expect(calls.map((call) => call.file)).toEqual([exe])
  })

  it('keeps each home once', async () => {
    const [a, b] = [home(), home()]
    const { deps } = fakeDeps({ stdout: answer(engine(account(1, a), account(2, b), account(3, a)), engine(account(4, b), account(5, b))) })
    expect(await readOrcaHomes(deps)).toEqual({ homes: { claude: [a, b], codex: [b] } })
  })

  it('keeps at most 64 an engine', async () => {
    const base = home()
    const homes = Array.from({ length: 70 }, (_, n) => {
      const path = join(base, `h${n}`)
      mkdirSync(path)
      return path
    })
    const accounts = homes.map((path, n) => account(n, path))
    const { deps } = fakeDeps({ stdout: answer(engine(...accounts), engine(...accounts)) })
    expect(await readOrcaHomes(deps)).toEqual({ homes: { claude: homes.slice(0, 64), codex: homes.slice(0, 64) } })
  })

  it('no orca runs nothing', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, deps } = fakeDeps({}, { platform, onPath: () => null })
      expect(await readOrcaHomes(deps)).toEqual({ homes: NONE, failure: 'no orca' })
      expect(calls).toEqual([])
    }
    // Linux never runs the macOS app's binary.
    const linux = fakeDeps({}, { platform: 'linux', onPath: () => null, exists: () => true })
    expect(await readOrcaHomes(linux.deps)).toEqual({ homes: NONE, failure: 'no orca' })
    expect(linux.calls).toEqual([])
  })

  it('an exit other than 0 is failed', async () => {
    const a = home()
    // An Orca with no `account list`; a run with no exit code (killed, not started, or past its byte bound); and an exit
    // other than 0 whatever it printed.
    for (const answered of [
      { code: 1, stdout: 'Unknown command: account\n' },
      { code: null, stdout: '' },
      { code: 2, stdout: answer(engine(account(1, a))) },
    ]) {
      expect(await readOrcaHomes(fakeDeps(answered).deps)).toEqual({ homes: NONE, failure: 'failed' })
    }
  })

  it('a run past its deadline is timed out', async () => {
    expect(await readOrcaHomes(fakeDeps({ code: null, stdout: '', timedOut: true }).deps)).toEqual({ homes: NONE, failure: 'timed out' })
  })

  it('an answer that is not JSON, not ok or not an object is unreadable', async () => {
    const a = home()
    const whole = answer(engine(account(1, a)))
    for (const stdout of [
      '', 'not json', whole.slice(0, -1), 'null', '[]', '"ok"', '42',
      JSON.stringify({ ok: false, error: { code: 'not_running', message: 'Orca is not running' } }),
      JSON.stringify({ ok: 'true', result: { claude: engine(account(1, a)) } }),
      JSON.stringify({ result: { claude: engine(account(1, a)) } }),
      JSON.stringify({ ok: true }),
      JSON.stringify({ ok: true, result: [engine(account(1, a))] }),
      JSON.stringify({ ok: true, result: 'claude' }),
    ]) {
      expect(await readOrcaHomes(fakeDeps({ stdout }).deps)).toEqual({ homes: NONE, failure: 'unreadable' })
    }
  })

  it('an engine with no accounts list has no homes', async () => {
    const a = home()
    const read = (result: unknown) => readOrcaHomes(fakeDeps({ stdout: JSON.stringify({ ok: true, result }) }).deps)
    expect(await read({ claude: engine(account(1, a)) })).toEqual({ homes: { claude: [a], codex: [] } })
    expect(await read({ codex: engine(account(1, a)) })).toEqual({ homes: { claude: [], codex: [a] } })
    expect(await read({})).toEqual({ homes: NONE })
    expect(await read({ claude: {}, codex: { accounts: 'none' } })).toEqual({ homes: NONE })
    expect(await read({ claude: null, codex: [account(1, a)] })).toEqual({ homes: NONE })
  })
})

describe('orcaHomesDeps', () => {
  /** A fake `orca` in a throwaway folder, at [path] in it, that runs [body]. Never the real one. */
  function script(body: string, path = 'orca'): string {
    const file = join(home(), path)
    mkdirSync(dirname(file), { recursive: true })
    writeExecutable(file, `#!/bin/sh\n${body}\n`)
    return file
  }

  /** How the latest spawned child ended, once it has: its signal, or null for an exit of its own. */
  async function ending(): Promise<NodeJS.Signals | null> {
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess
    // A child never killed would outlive the suite.
    onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    return child.signalCode
  }

  it('the real run ends at its deadline and at its byte bound', async () => {
    const { run } = orcaHomesDeps()
    // The fake sleeps 300 s, past the test's own timeout: an answer at all means the deadline gave it.
    expect(await run(script('exec sleep 300'), [], { timeoutMs: 200, maxBytes: 262144 })).toEqual({ code: null, stdout: '', timedOut: true })
    expect(await ending()).toBe('SIGKILL')

    // 300 KB, then a sleep past the test's own timeout and a deadline past it too: only the bound can end it.
    const loud = script('head -c 307200 /dev/zero\nexec sleep 300')
    expect(await run(loud, [], { timeoutMs: 600_000, maxBytes: 262144 })).toEqual({ code: null, stdout: '', timedOut: false })
    expect(await ending()).toBe('SIGKILL')

    // At the bound, the answer is whole.
    const full = await run(script('head -c 262144 /dev/zero'), [], { timeoutMs: 600_000, maxBytes: 262144 })
    expect({ ...full, stdout: full.stdout.length }).toEqual({ code: 0, stdout: 262144, timedOut: false })
  })

  it('the real run answers what it printed, with no shell and stdin closed', async () => {
    const { run } = orcaHomesDeps()
    // `cat` reads stdin to its end: one left open would wait for the deadline.
    const echo = script('cat\nprintf "%s|" "$@"')
    expect(await run(echo, ['account', 'list', '--json', '$(touch x); x'], { timeoutMs: 600_000, maxBytes: 1024 }))
      .toEqual({ code: 0, stdout: 'account|list|--json|$(touch x); x|', timedOut: false })
    expect(await run(script('exit 3'), [], { timeoutMs: 600_000, maxBytes: 1024 })).toEqual({ code: 3, stdout: '', timedOut: false })
    // A binary that cannot start, and an argument refused before starting (a NUL byte), have no exit code.
    expect(await run(join(home(), 'missing'), [], { timeoutMs: 600_000, maxBytes: 1024 })).toEqual({ code: null, stdout: '', timedOut: false })
    expect(await run(echo, ['a\0b'], { timeoutMs: 600_000, maxBytes: 1024 })).toEqual({ code: null, stdout: '', timedOut: false })
  })

  it('the real deps name the per-user install folder Windows gives', () => {
    vi.stubEnv('LOCALAPPDATA', LOCAL_APP_DATA)
    expect(orcaHomesDeps().localAppData).toBe(LOCAL_APP_DATA)
    expect(orcaHomesDeps('win32').platform).toBe('win32')
  })

  // Spawned for real off Windows too, where the .exe is not there: only how it was started is read.
  it('the real run on Windows starts orca.exe itself, hidden, with its arguments unchanged and no shell', async () => {
    const args = ['orchestration', 'send', '--text=a & b\r\nc %PATH% "d" ^|e']
    expect(await orcaHomesDeps('win32').run(DEFAULT_ORCA, args, { timeoutMs: 600_000, maxBytes: 1024 })).toEqual({ code: null, stdout: '', timedOut: false })
    const [started, given, options] = vi.mocked(spawn).mock.calls.at(-1)!
    expect(started).toBe(DEFAULT_ORCA)
    expect(given).toEqual(args)
    // No env of its own: the child's is this process's, with no ELECTRON_RUN_AS_NODE.
    expect(options).toEqual({ stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    expect(options?.env).toBeUndefined()
  })

  it('the real run on Windows refuses orca.cmd and starts nothing', async () => {
    const before = vi.mocked(spawn).mock.calls.length
    for (const args of [['account', 'list', '--json'], ['orchestration', 'send', '--text=hi']]) {
      expect(await orcaHomesDeps('win32').run(ORCA_CMD, args, { timeoutMs: 600_000, maxBytes: 1024 })).toEqual({ code: null, stdout: '', timedOut: false })
    }
    expect(vi.mocked(spawn).mock.calls.length).toBe(before)
  })

  it("the real deps read Orca's own launcher on PATH, through a link and past another orca", async () => {
    const a = home()
    // Where Orca installs it: in the app on macOS, beside its binary on Linux.
    for (const install of ['Orca.app/Contents/Resources/bin/orca', 'Orca/resources/bin/orca']) {
      // printf is the shell's own: PATH holds the fakes alone.
      const launcher = script(`[ "$*" = 'account list --json' ] || exit 9\nprintf '%s' '${answer(engine(account(1, a)))}'`, install)
      const linked = join(home(), 'orca')
      symlinkSync(launcher, linked)
      const other = script('exit 0')
      vi.stubEnv('PATH', [dirname(other), dirname(linked)].join(delimiter))
      // Never the app's own `orca`, even if the fake were not found.
      expect(await readOrcaHomes({ ...orcaHomesDeps(), exists: () => false }), install).toEqual({ homes: { claude: [a], codex: [] } })
    }
  })

  // The end-to-end tests' daemons run inside the real Orca on a developer's Mac: their harness names a fake as the app's
  // (e2e/harness/daemon.ts). Only looked at, never run: a lookup that fell to the real app's would not start it.
  it("the app's own is the absolute path HARNESS_ORCA_APP_BIN names, else /Applications'", () => {
    const fake = script('exit 0', 'Orca.app/Contents/Resources/bin/orca')
    vi.stubEnv('PATH', dirname(script('exit 0')))
    const looked: string[] = []
    const lookup = () => orcaBinary({ ...orcaHomesDeps(), platform: 'darwin', exists: (path) => { looked.push(path); return path === fake } })
    vi.stubEnv('HARNESS_ORCA_APP_BIN', fake)
    expect(lookup()).toBe(fake)
    // A relative one is never looked up.
    vi.stubEnv('HARNESS_ORCA_APP_BIN', 'orca')
    expect(lookup()).toBeNull()
    vi.stubEnv('HARNESS_ORCA_APP_BIN', '')
    expect(lookup()).toBeNull()
    expect(looked).toEqual([fake, APP_ORCA, APP_ORCA])
  })

  // GNOME's screen reader is /usr/bin/orca: it ignores the arguments it does not know, and starts.
  it("an orca on PATH that is not Orca's launcher is never run", async () => {
    const ran = join(home(), 'ran')
    const reader = script(`: > '${ran}'`)
    vi.stubEnv('PATH', dirname(reader))
    expect(await readOrcaHomes({ ...orcaHomesDeps(), exists: () => false })).toEqual({ homes: NONE, failure: 'no orca' })
    expect(existsSync(ran)).toBe(false)
  })

  // On Linux Orca links its CLI as `orca-ide`, beside the screen reader's `orca`.
  describe("on Linux Orca's CLI is orca-ide", () => {
    const linked = (target: string, name: string): string => {
      const link = join(home(), name)
      symlinkSync(target, link)
      return link
    }
    const linux = () => orcaBinary({ ...orcaHomesDeps(), platform: 'linux', exists: () => false })

    it('found by its real path, before an orca launcher', () => {
      const ide = linked(script('exit 0', 'Orca/resources/bin/orca-ide'), 'orca-ide')
      const orca = linked(script('exit 0', 'Orca/resources/bin/orca'), 'orca')
      vi.stubEnv('PATH', [dirname(orca), dirname(ide)].join(delimiter))
      expect(linux()).toBe(ide)
    })

    it('the screen reader alone gives none', () => {
      vi.stubEnv('PATH', dirname(script('exit 0')))
      expect(linux()).toBeNull()
    })

    it('an orca-ide whose real path is elsewhere is passed over', () => {
      const other = script('exit 0', 'orca-ide')
      const orca = linked(script('exit 0', 'Orca/resources/bin/orca'), 'orca')
      vi.stubEnv('PATH', [dirname(other), dirname(orca)].join(delimiter))
      expect(linux()).toBe(orca)
      vi.stubEnv('PATH', dirname(other))
      expect(linux()).toBeNull()
    })

    it('on macOS orca-ide is never looked for', () => {
      const names: string[] = []
      orcaBinary({ onPath: (name) => { names.push(name); return null }, exists: () => false, platform: 'darwin' })
      expect(names).toEqual(['orca'])
    })
  })
})

describe('createOrcaHomesCache', () => {
  const A: OrcaHomes = { claude: ['/made/up/a', '/made/up/b'], codex: ['/made/up/c'] }
  const B: OrcaHomes = { claude: ['/made/up/a'], codex: ['/made/up/c', '/made/up/d'] }
  const ok = (homes: OrcaHomes) => () => Promise.resolve<OrcaHomesRead>({ homes })
  const failed = (failure: OrcaHomesFailure) => () => Promise.resolve<OrcaHomesRead>({ homes: NONE, failure })

  /** A cache whose reads answer [reads] in turn, on a clock the test moves. */
  function cacheOf(reads: Array<() => Promise<OrcaHomesRead>>, platform: NodeJS.Platform = 'darwin') {
    let clock = 1_000_000
    let count = 0
    const lines: string[] = []
    const cache = createOrcaHomesCache({
      read: () => {
        count += 1
        return reads.shift()!()
      },
      now: () => clock,
      platform,
      log: (line) => { lines.push(line) },
    })
    return { cache, lines, reads: () => count, advance: (ms: number) => { clock += ms } }
  }

  it('the first refresh reads, and says how many', async () => {
    const t = cacheOf([ok(A)])
    expect(t.cache.get()).toEqual(NONE)
    expect(await t.cache.refresh()).toBe(true)
    expect(t.cache.get()).toEqual(A)
    expect(t.lines).toEqual(['[observed] orca homes · 2 claude · 1 codex'])

    // A first read with no homes changes nothing, and still says so.
    const empty = cacheOf([ok(NONE)])
    expect(await empty.cache.refresh()).toBe(false)
    expect(empty.lines).toEqual(['[observed] orca homes · 0 claude · 0 codex'])
  })

  it('a refresh within 5 minutes reads nothing', async () => {
    const t = cacheOf([ok(A)])
    await t.cache.refresh()
    t.advance(5 * 60_000 - 1)
    expect(await t.cache.refresh()).toBe(false)
    expect(t.reads()).toBe(1)
    expect(t.lines).toHaveLength(1)
    expect(t.cache.get()).toEqual(A)
  })

  it('after 5 minutes it reads again, and says whether the list changed', async () => {
    const t = cacheOf([ok(A), ok(A), ok(B)])
    await t.cache.refresh()
    t.advance(5 * 60_000)
    expect(await t.cache.refresh()).toBe(false)
    t.advance(5 * 60_000)
    expect(await t.cache.refresh()).toBe(true)
    expect(t.cache.get()).toEqual(B)
    expect(t.reads()).toBe(3)
    expect(t.lines).toEqual([
      '[observed] orca homes · 2 claude · 1 codex',
      '[observed] orca homes · 2 claude · 1 codex',
      '[observed] orca homes · 1 claude · 2 codex',
    ])
  })

  it('two refreshes share one read', async () => {
    let settle!: (read: OrcaHomesRead) => void
    const t = cacheOf([() => new Promise((resolve) => { settle = resolve })])
    const first = t.cache.refresh()
    const second = t.cache.refresh()
    expect(t.reads()).toBe(1)
    settle({ homes: A })
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(t.lines).toHaveLength(1)
    // Done, it is the last read: one within 5 minutes reads nothing.
    expect(await t.cache.refresh()).toBe(false)
    expect(t.reads()).toBe(1)
  })

  it('a failed read empties the list and names its kind', async () => {
    for (const failure of ['no orca', 'failed', 'timed out', 'unreadable'] as const) {
      const t = cacheOf([ok(A), failed(failure)])
      await t.cache.refresh()
      t.advance(5 * 60_000)
      expect(await t.cache.refresh()).toBe(true)
      expect(t.cache.get()).toEqual(NONE)
      expect(t.lines.at(-1)).toBe(`[observed] orca homes · not read · ${failure}`)
    }
  })

  // A failed read empties the list: the plugin's setup must not take that for Orca listing no home.
  it('answered says whether the last read gave Orca\'s answer', async () => {
    const t = cacheOf([ok(NONE), failed('timed out'), ok(A)])
    expect(t.cache.answered()).toBe(false)
    await t.cache.refresh()
    expect(t.cache.answered()).toBe(true)
    t.advance(5 * 60_000)
    await t.cache.refresh()
    expect(t.cache.answered()).toBe(false)
    t.advance(5 * 60_000)
    await t.cache.refresh()
    expect(t.cache.answered()).toBe(true)
  })

  it('a read that throws is failed', async () => {
    const t = cacheOf([ok(A), () => { throw new Error('/made/up/a person1@example.com') }, () => Promise.reject(new Error('/made/up/b'))])
    await t.cache.refresh()
    t.advance(5 * 60_000)
    expect(await t.cache.refresh()).toBe(true)
    expect(t.cache.get()).toEqual(NONE)
    t.advance(5 * 60_000)
    expect(await t.cache.refresh()).toBe(false)
    // The error's text is never said: it can name paths and emails.
    expect(t.lines.slice(1)).toEqual(['[observed] orca homes · not read · failed', '[observed] orca homes · not read · failed'])
  })

  it('on Windows it reads as elsewhere', async () => {
    const t = cacheOf([ok(A)], 'win32')
    expect(await t.cache.refresh()).toBe(true)
    expect(t.reads()).toBe(1)
    expect(t.lines).toEqual(['[observed] orca homes · 2 claude · 1 codex'])
    expect(t.cache.get()).toEqual(A)
  })
})
