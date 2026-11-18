import { ChildProcess, execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lutimesSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createOrcaAdapter, createOrcaReads, ORCA_HANDLE, type OrcaChild, orcaDeps, type OrcaDeps, type OrcaReadDeps } from './orca.js'

// The real execFile and spawn, watched: a spec reads how the child of a run or a watch ended.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile), spawn: vi.fn(real.spawn) }
})

const HANDLE = 'term_0f8e2c1a-3b4d-4e5f-8a9b-0c1d2e3f4a5b'
const OTHER = 'term_9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca'
const FAKE_PATH_ORCA = '/fake/bin/orca'

// Orca's reads, on made-up terminals. `orca terminal list --json --include-visual-layouts` in Orca 1.4.256's shapes.
const H = (n: number) => `term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const leaf = (n: number, title: unknown = 'made up') => ({ type: 'terminal', handle: H(n), tabId: 't', leafId: `l${n}`, title, connected: true, active: false })
const panes = (first: unknown, second: unknown) => ({ type: 'pane-split', direction: 'horizontal', first, second })
const tab = (tree: unknown, title: unknown = 'made up') => ({ tabId: 't', title, activeLeafId: 'l', panes: tree })
const group = (...tabs: unknown[]) => ({ type: 'group', groupId: 'g', activeTabId: 't', tabs })
const split = (first: unknown, second: unknown) => ({ type: 'split', direction: 'vertical', first, second })
const listed = (...roots: unknown[]) => listedWith([], ...roots)
/** The same, with these rows in its flat `terminals` list. */
const listedWith = (terminals: unknown, ...roots: unknown[]) => JSON.stringify({ id: 'x', ok: true, result: { terminals,
  visualLayouts: roots.map((root, i) => ({ worktreeId: `w${i}`, worktreePath: `/made/up/${i}`, root })), totalCount: 0, truncated: false } })
/** A row of `terminals`: an agent's has its `agentIdentity`, a shell's none. */
const row = (n: number, worktreePath: unknown, agentIdentity?: unknown) => ({ handle: H(n), worktreePath, tabId: 't', leafId: `l${n}`,
  title: 'made up', ...(agentIdentity === undefined ? {} : { agentIdentity }) })

// Orca 1.4.256's `orca terminal --help`, whole.
const HELP = [
  'orca terminal',
  '',
  'Usage: orca terminal <command> [options]',
  '',
  'Commands:',
  '  list               List live Orca-managed terminals',
  '  show               Show terminal metadata and preview',
  '  read               Read bounded terminal output',
  '  send               Send input to a live terminal',
  '  wait               Wait for a terminal condition',
  '  create             Create a terminal session in the current worktree',
  '  switch             Switch to a terminal tab in the UI',
  '  close              Close one terminal, its whole tab, or every terminal in a workspace',
  '  rename             Set or clear the title of a terminal tab',
  '  set-pane-title     Set or clear the title of one terminal pane',
  '  split              Split an existing terminal pane',
  '',
  'Run `orca terminal <command> --help` for command-specific usage.',
  '',
].join('\n')
// The line an Orca with watch-focus adds after switch's. Its words after the command are made up: upstream's are not known.
const WATCH_LINE = '  watch-focus        Print the focused terminal, then each change'
const HELP_WATCH = HELP.replace('tab in the UI\n', `tab in the UI\n${WATCH_LINE}\n`)

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
type RunAnswer = Awaited<ReturnType<OrcaDeps['run']>>

/** A `run` that runs nothing and records each call: each answers the next of [answers], then exit 0 with nothing printed. */
function recordingRun(answers: Array<Partial<RunAnswer>> = []) {
  const calls: Call[] = []
  const run: OrcaDeps['run'] = async (file, args, timeoutMs) => {
    calls.push({ file, args, timeoutMs })
    return { code: 0, stdout: '', ...answers.shift() }
  }
  return { calls, run }
}

/** The adapter, called with the arguments the Orca actions took: a handle is its pane's id. */
function createOrcaActions(deps: OrcaDeps) {
  const adapter = createOrcaAdapter(deps)
  return {
    send: (handle: string, text: string) => adapter.type({ adapter: 'orca', id: handle }, text, 'claude'),
    switchTo: (handle: string) => adapter.show({ adapter: 'orca', id: handle }, 'a1'),
  }
}

/** Deps whose `run` runs nothing and exits 0. */
function quietDeps(): OrcaDeps {
  return { run: async () => ({ code: 0, stdout: '' }), onPath: () => FAKE_PATH_ORCA, exists: () => false, platform: 'darwin' }
}

/** A recording `run` that runs nothing: each call answers the next of [codes], then exit 0. */
function recorder(over: Partial<OrcaDeps> = {}, codes: Array<number | null> = []) {
  const { calls, run } = recordingRun(codes.map((code) => ({ code })))
  const deps: OrcaDeps = {
    run,
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

  // GNOME's screen reader is /usr/bin/orca: it ignores the arguments it does not know, and starts.
  it('an orca on PATH that is not Orca\'s launcher is never run', async () => {
    fakeOrca()
    vi.stubEnv('PATH', dir)
    // Nor the app's own.
    const orca = createOrcaActions({ ...orcaDeps(), exists: () => false })
    expect(await orca.send(HANDLE, 'hi')).toBe(false)
    expect(await orca.switchTo(HANDLE)).toBe('failed')
    expect(existsSync(join(dir, 'argv'))).toBe(false)
  })

  // The end-to-end tests' daemons run inside the real Orca on a developer's Mac: their harness names a fake as the app's
  // (e2e/harness/daemon.ts). The run is recorded: nothing is started, whichever file the lookup lands on.
  it('the real deps\' app is the one HARNESS_ORCA_APP_BIN names', async () => {
    const fake = join(dir, 'Orca.app', 'Contents', 'Resources', 'bin', 'orca')
    vi.stubEnv('PATH', dir)
    vi.stubEnv('HARNESS_ORCA_APP_BIN', fake)
    const { calls, run } = recordingRun()
    const orca = createOrcaActions({ ...orcaDeps(), run, platform: 'darwin', exists: (path) => path === fake || path === APP_ORCA })
    expect(await orca.send(HANDLE, 'hi')).toBe(true)
    expect(calls.map((call) => call.file)).toEqual([fake])
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
    expect(await orcaDeps().run(fake.file, [], 10_000)).toEqual({ code: 3, stdout: '' })
    // A binary that cannot start has no exit code.
    expect(await orcaDeps().run(join(dir, 'missing'), [], 10_000)).toEqual({ code: null, stdout: '' })
  })

  it('a run its file or an argument refuses before starting, a NUL byte in it, has no exit code and leaves no deadline', async () => {
    const fake = fakeOrca()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    onTestFinished(() => { vi.useRealTimers() })
    expect(await orcaDeps().run(fake.file, ['a\0b'], 10_000)).toEqual({ code: null, stdout: '' })
    expect(vi.getTimerCount()).toBe(0)
  })

  // tmux's answer is what it printed: the pane's process (tmux.ts).
  it('run answers what the command printed', async () => {
    const fake = fakeOrca('echo 4242')
    expect(await orcaDeps().run(fake.file, [], 10_000)).toEqual({ code: 0, stdout: '4242\n' })
  })

  /** A `run` that holds each command until the test lets it end. */
  function held() {
    const calls: string[][] = []
    const waiting: Array<(code?: number | null) => void> = []
    const orca = createOrcaActions({
      run: (_file, args) => {
        calls.push(args)
        return new Promise((resolve) => waiting.push((code = 0) => resolve({ code, stdout: '' })))
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

describe('Orca adapter', () => {
  /** The adapter on a recording `run`: each call answers the next of [codes], then exit 0. */
  function adapterRecorder(codes: Array<number | null> = []) {
    const calls: Call[] = []
    const adapter = createOrcaAdapter({
      ...quietDeps(),
      run: async (file, args, timeoutMs) => {
        calls.push({ file, args, timeoutMs })
        return { code: codes.length ? codes.shift()! : 0, stdout: '' }
      },
    })
    return { calls, adapter }
  }

  it('its id is orca, it taps before its app, and can focus on every platform', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const adapter = createOrcaAdapter({ ...quietDeps(), platform })
      expect(adapter.id).toBe('orca')
      expect(adapter.tap).toBe('before')
      expect(adapter.canShow).toBeUndefined()
      expect(adapter.canFocus({ adapter: 'orca', id: HANDLE })).toBe(true)
    }
  })

  // The hint sets observed.spec.ts and the e2e suites already send for an Orca terminal.
  it('paneOf takes a terminal handle in its own form, and refuses any other', () => {
    const adapter = createOrcaAdapter(quietDeps())
    const place = (hints: Record<string, string>) => ({ host: 'orca', app: 'orca', hints })
    const pane = { adapter: 'orca', id: HANDLE }
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }))).toEqual(pane)
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE, __CFBundleIdentifier: 'com.stablyai.orca' }))).toEqual(pane)
    for (const handle of ['term_0f8e2c1a', `${HANDLE}; rm -rf /`, '--help', '']) {
      expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: handle }))).toBeUndefined()
    }
    expect(adapter.paneOf(place({ ORCA_AGENT_SESSION_ID: 'x' }))).toBeUndefined()
    expect(adapter.paneOf(place({ __CFBundleIdentifier: 'com.stablyai.orca' }))).toBeUndefined()
    expect(adapter.paneOf(place({}))).toBeUndefined()
    // Only the handle names the pane: the host, the app and a tty change nothing.
    expect(adapter.paneOf({ host: 'terminal', app: 'terminal', hints: { ORCA_TERMINAL_HANDLE: HANDLE }, tty: '/dev/ttys004' })).toEqual(pane)
    expect(adapter.paneOf({ host: 'orca', app: 'orca', hints: {}, tty: '/dev/ttys004' })).toBeUndefined()
  })

  it('in a multiplexer it has no pane: the handle names the terminal the multiplexer started in', () => {
    const adapter = createOrcaAdapter(quietDeps())
    const hints = { ORCA_AGENT_SESSION_ID: 'x', ORCA_TERMINAL_HANDLE: HANDLE }
    for (const host of ['herdr', 'rex', 'zellij', 'tmux']) expect(adapter.paneOf({ host, app: 'orca', hints }), host).toBeUndefined()
    for (const host of ['orca', 'wezterm', 'kitty', 'terminal']) expect(adapter.paneOf({ host, app: 'orca', hints }), host).toEqual({ adapter: 'orca', id: HANDLE })
  })

  it('focus is the switch: true only when it exits 0', async () => {
    const { calls, adapter } = adapterRecorder()
    expect(await adapter.focus({ adapter: 'orca', id: HANDLE })).toBe(true)
    expect(calls).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', 'switch', '--terminal', HANDLE, '--json'], timeoutMs: 10_000 }])

    const refused = adapterRecorder([1])
    expect(await refused.adapter.focus({ adapter: 'orca', id: HANDLE })).toBe(false)
    expect(refused.calls).toHaveLength(1)

    const outside = adapterRecorder()
    expect(await outside.adapter.focus({ adapter: 'orca', id: `${HANDLE}; rm -rf /` })).toBe(false)
    expect(outside.calls).toEqual([])
  })

  it('its members work when called apart from it', async () => {
    const { calls, adapter } = adapterRecorder()
    const { paneOf, focus, show, type } = adapter
    const pane = paneOf({ host: 'orca', app: 'orca', hints: { ORCA_TERMINAL_HANDLE: HANDLE } })!
    expect(pane).toEqual({ adapter: 'orca', id: HANDLE })
    expect(await focus(pane)).toBe(true)
    expect(await show(pane, 'a1')).toBe('ok')
    expect(await type(pane, 'hi', 'claude')).toBe(true)
    expect(calls.map((call) => call.args[1])).toEqual(['switch', 'switch', 'send'])
  })
})

// Orca 1.4.256's `terminal switch` reveals a worktree only lightly: a parked or sleeping session showed once the person
// pressed Back, which runs the full activation `worktree activate` runs.
describe('a switch activates its terminal\'s worktree first', () => {
  // Orca's own form: its repo's uuid, `::`, the worktree's folder.
  const WT = 'bfeba4a9-ec47-4daa-bdb0-5a6b702b5a08::/Users/d/autonomous-harness'
  const activated = ['worktree', 'activate', '--worktree', `id:${WT}`, '--json']
  const switched = (handle: string) => ['terminal', 'switch', '--terminal', handle, '--json']
  const pane = (id: string) => ({ adapter: 'orca', id })

  /** The adapter, HANDLE's worktree known, on a `run` that holds each command until the test ends it with a code, or
   *  rejects it. */
  function activating() {
    const calls: string[][] = []
    const waiting: Array<(code?: number | null) => void> = []
    const refusing: Array<() => void> = []
    const lines: string[] = []
    // Each switch told as it starts, with how many commands had run.
    const told: Array<[string, number]> = []
    const worktrees = new Map([[HANDLE, WT]])
    const adapter = createOrcaAdapter({
      ...quietDeps(),
      run: (_file, args) => {
        calls.push(args)
        return new Promise((resolve, reject) => {
          waiting.push((code = 0) => resolve({ code, stdout: '' }))
          refusing.push(() => reject(new Error('made up')))
        })
      },
    }, { worktreeOf: (handle) => worktrees.get(handle), log: (line) => { lines.push(line) }, switching: (handle) => { told.push([handle, calls.length]) } })
    const settled = () => new Promise((resolve) => setImmediate(resolve))
    return { calls, waiting, refusing, lines, told, adapter, settled }
  }

  it('with its worktree known, a rest and a tap run worktree activate, then the switch once it has ended, told as it starts', async () => {
    const { calls, waiting, lines, told, adapter, settled } = activating()
    const shown = adapter.show(pane(HANDLE), 'a1')
    await settled()
    expect(calls).toEqual([activated])
    waiting[0]()
    await vi.waitFor(() => expect(calls).toEqual([activated, switched(HANDLE)]))
    waiting[1]()
    expect(await shown).toBe('ok')

    const focused = adapter.focus(pane(HANDLE))
    await settled()
    waiting[2]()
    await vi.waitFor(() => expect(calls).toHaveLength(4))
    waiting[3]()
    expect(await focused).toBe(true)
    expect(calls.slice(2)).toEqual([activated, switched(HANDLE)])
    expect(lines).toEqual([])
    expect(told).toEqual([[HANDLE, 1], [HANDLE, 3]])
  })

  it('with no worktree known, the switch alone, told as nothing more: the rest that started it was', async () => {
    const { calls, waiting, told, adapter, settled } = activating()
    const shown = adapter.show(pane(OTHER), 'a1')
    await settled()
    expect(calls).toEqual([switched(OTHER)])
    waiting[0]()
    expect(await shown).toBe('ok')
    expect(calls).toHaveLength(1)
    expect(told).toEqual([])
  })

  it('an activate that fails, times out or throws: the switch still runs, its outcome is the answer, and one line says it with no id', async () => {
    for (const end of ['code 1', 'timeout', 'throw'] as const) {
      const { calls, waiting, refusing, lines, adapter, settled } = activating()
      const shown = adapter.show(pane(HANDLE), 'a1')
      await settled()
      if (end === 'throw') refusing[0]()
      else waiting[0](end === 'code 1' ? 1 : null)
      await vi.waitFor(() => expect(calls).toEqual([activated, switched(HANDLE)]))
      waiting[1]()
      expect(await shown, end).toBe('ok')
      expect(lines, end).toEqual(['[device] orca activate · failed'])
    }
    // An activate that worked and a switch that failed: the switch's outcome.
    const { waiting, lines, adapter, settled } = activating()
    const shown = adapter.show(pane(HANDLE), 'a1')
    await settled()
    waiting[0]()
    await vi.waitFor(() => expect(waiting).toHaveLength(2))
    waiting[1](1)
    expect(await shown).toBe('failed')
    expect(lines).toEqual([])
  })

  it('a switch while one activates is that same run; words wait for both; a switch while words are typed is busy and activates nothing', async () => {
    const { calls, waiting, told, adapter, settled } = activating()
    const rest = adapter.show(pane(HANDLE), 'a1')
    const tap = adapter.show(pane(HANDLE), 'a1')
    const typed = adapter.type(pane(HANDLE), 'one', 'claude')
    await settled()
    expect(calls).toEqual([activated])
    waiting[0]()
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]).toEqual(switched(HANDLE))
    waiting[1]()
    expect(await rest).toBe('ok')
    expect(await tap).toBe('ok')
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2][1]).toBe('send')
    expect(await adapter.show(pane(HANDLE), 'a1')).toBe('busy')
    waiting[2]()
    expect(await typed).toBe(true)
    expect(calls).toHaveLength(3)
    expect(told).toEqual([[HANDLE, 1]])
  })
})

/** A child of `spawn` that the test drives: it writes the child's stdout, ends it, and reads the signals it was sent. */
function fakeChild() {
  const listeners: Array<(chunk: Buffer) => void> = []
  const kills: string[] = []
  let end!: () => void
  const child: OrcaChild = {
    onData: (listener) => { listeners.push(listener) },
    exited: new Promise((resolve) => { end = resolve }),
    kill: (signal) => { kills.push(signal) },
  }
  const write = (text: string) => { for (const listener of listeners) listener(Buffer.from(text)) }
  return { child, kills, write, end: () => end() }
}

/** Orca's reads on a recording `run` that answers the next of [answers], a stamp that does not change, and fake
 *  children: never the real Orca. */
function reads(over: Partial<OrcaReadDeps> = {}, answers: Array<Partial<RunAnswer>> = []) {
  const { calls, run } = recordingRun(answers)
  const spawned: Array<{ file: string; args: string[] }> = []
  const children: Array<ReturnType<typeof fakeChild>> = []
  const orca = createOrcaReads({
    run,
    onPath: (name) => (name === 'orca' ? FAKE_PATH_ORCA : null),
    exists: () => false,
    platform: 'darwin',
    mtime: () => ({ realPath: FAKE_PATH_ORCA, mtimeMs: 1 }),
    spawn: (file, args) => {
      spawned.push({ file, args })
      const child = fakeChild()
      children.push(child)
      return child.child
    },
    ...over,
  })
  return { calls, spawned, children, orca }
}

describe('whether Orca watches focus', () => {
  it('true when the Commands list names watch-focus, false for 1.4.256\'s help', async () => {
    const watching = reads({}, [{ stdout: HELP_WATCH }])
    expect(await watching.orca.orcaWatchesFocus()).toBe(true)
    expect(watching.calls).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', '--help'], timeoutMs: 10_000 }])

    const old = reads({}, [{ stdout: HELP }])
    expect(await old.orca.orcaWatchesFocus()).toBe(false)
    expect(old.calls).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', '--help'], timeoutMs: 10_000 }])
  })

  it('only a command\'s own word counts', async () => {
    for (const help of [
      HELP.replace('tab in the UI', 'tab in the UI, as watch-focus would report it'),
      // Past the empty line that ends the list.
      HELP.replace('Run `orca terminal <command> --help` for command-specific usage.', WATCH_LINE),
    ]) {
      expect(await reads({}, [{ stdout: help }]).orca.orcaWatchesFocus(), help).toBe(false)
    }
  })

  it('kept per binary: asked again it runs nothing; a new mtime, or another real path, runs it again', async () => {
    let stamp = { realPath: FAKE_PATH_ORCA, mtimeMs: 1 }
    const stamped: string[] = []
    const { calls, orca } = reads(
      { mtime: (path) => { stamped.push(path); return stamp } },
      [{ stdout: HELP_WATCH }, { stdout: HELP }, { stdout: HELP_WATCH }, { stdout: HELP }],
    )
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(calls).toHaveLength(1)
    // The binary stamped is the one the lookup found.
    expect(stamped).toEqual([FAKE_PATH_ORCA, FAKE_PATH_ORCA])

    // Orca updated in place: every file of its bundle carries the new release's time. A false answer is kept too.
    stamp = { realPath: FAKE_PATH_ORCA, mtimeMs: 2 }
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(calls).toHaveLength(2)

    // The same name, another Orca behind it.
    stamp = { realPath: '/fake/other/orca', mtimeMs: 2 }
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(calls).toHaveLength(3)

    // One answer is kept, the latest binary's: the first binary is asked again.
    stamp = { realPath: FAKE_PATH_ORCA, mtimeMs: 1 }
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(calls).toHaveLength(4)
  })

  it('a run that failed or timed out is false and is asked again', async () => {
    // Each printed a help that names watch-focus: only a run that exited 0 says what the CLI has.
    const { calls, orca } = reads({}, [{ code: 1, stdout: HELP_WATCH }, { code: null, stdout: HELP_WATCH }, { stdout: HELP_WATCH }])
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('a run that rejects is false and is asked again', async () => {
    const calls: string[][] = []
    const { orca } = reads({
      run: async (_file, args) => {
        calls.push(args)
        if (calls.length === 1) throw new Error('made up')
        return { code: 0, stdout: HELP_WATCH }
      },
    })
    expect(await orca.orcaWatchesFocus()).toBe(false)
    expect(await orca.orcaWatchesFocus()).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('two asks at once are one run', async () => {
    const calls: string[][] = []
    const landings: Array<(answer: RunAnswer) => void> = []
    const { orca } = reads({ run: (_file, args) => { calls.push(args); return new Promise((resolve) => landings.push(resolve)) } })
    const first = orca.orcaWatchesFocus()
    const second = orca.orcaWatchesFocus()
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toHaveLength(1)
    landings[0]({ code: 0, stdout: HELP_WATCH })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('no orca binary, or one whose stamp cannot be read, is false and runs nothing', async () => {
    const stamped: string[] = []
    // The app's folder is a macOS path: Linux never looks there.
    const none = reads({ onPath: () => null, platform: 'linux', exists: () => true, mtime: (path) => { stamped.push(path); return { realPath: path, mtimeMs: 1 } } }, [{ stdout: HELP_WATCH }])
    expect(await none.orca.orcaWatchesFocus()).toBe(false)
    expect(none.calls).toEqual([])
    expect(stamped).toEqual([])

    let stamp: { realPath: string; mtimeMs: number } | null = null
    const unstamped = reads({ mtime: () => stamp }, [{ stdout: HELP_WATCH }])
    expect(await unstamped.orca.orcaWatchesFocus()).toBe(false)
    expect(unstamped.calls).toEqual([])
    // Nothing was kept: once the stamp reads, it is asked.
    stamp = { realPath: FAKE_PATH_ORCA, mtimeMs: 1 }
    expect(await unstamped.orca.orcaWatchesFocus()).toBe(true)
    expect(unstamped.calls).toHaveLength(1)
  })

  it('the reads find orca as the actions do: on PATH, else the app\'s own on macOS', async () => {
    const app = reads(
      { onPath: () => null, exists: (path) => path === APP_ORCA, mtime: (path) => ({ realPath: path, mtimeMs: 1 }) },
      [{ stdout: HELP_WATCH }, { stdout: listed(group(tab(leaf(1)))) }],
    )
    expect(await app.orca.orcaWatchesFocus()).toBe(true)
    expect(await app.orca.orcaTabs()).toEqual({ tabs: [{ handle: H(1), title: 'made up' }], terminals: [], worktrees: new Map([[H(1), 'w0']]) })
    app.orca.watchOrcaFocus(() => {})
    expect(app.calls.map((call) => call.file)).toEqual([APP_ORCA, APP_ORCA])
    expect(app.spawned.map((child) => child.file)).toEqual([APP_ORCA])
  })

  it('the real stamp is the file a symlink points at, and its mtime', () => {
    const file = join(dir, 'orca-1.4.256')
    writeFileSync(file, '#!/bin/sh\nexit 1\n')
    const link = join(dir, 'orca')
    symlinkSync(file, link)
    utimesSync(file, 2_000, 2_000)
    lutimesSync(link, 1_000, 1_000)
    expect(orcaDeps().mtime(link)).toEqual({ realPath: join(realpathSync(dir), 'orca-1.4.256'), mtimeMs: 2_000_000 })
    expect(orcaDeps().mtime(join(dir, 'missing'))).toBeNull()
    // A link whose file is gone.
    rmSync(file)
    expect(orcaDeps().mtime(link)).toBeNull()
  })
})

describe("Orca's tab order", () => {
  const order = async (stdout: string) => {
    const read = await reads({}, [{ stdout }]).orca.orcaTabs()
    return read && read.tabs.map((t) => t.handle)
  }

  it('groups, splits of groups, tabs and pane splits, first then second; worktrees as listed', async () => {
    const stdout = listed(split(group(tab(leaf(1)), tab(panes(leaf(2), panes(leaf(3), leaf(4))))), group(tab(leaf(5)))), group(tab(leaf(6))))
    const { calls, orca } = reads({}, [{ stdout }])
    expect((await orca.orcaTabs())?.tabs.map((t) => t.handle)).toEqual([H(1), H(2), H(3), H(4), H(5), H(6)])
    expect(calls).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', 'list', '--json', '--include-visual-layouts'], timeoutMs: 10_000 }])

    // first and second by their names, wherever the JSON puts them.
    const backwards = { type: 'split', second: group(tab({ type: 'pane-split', second: leaf(4), first: leaf(3) })), first: group(tab(leaf(2))) }
    expect(await order(listed(backwards))).toEqual([H(2), H(3), H(4)])
  })

  it('each handle carries its tab\'s title, every pane of a split tab the same', async () => {
    // A pane's own title (the leaf's, here 'made up') names the program in it, not the tab: the tab's is the one taken.
    const stdout = listed(group(tab(leaf(1), 'PM'), tab(panes(leaf(2), panes(leaf(3), leaf(4))), 'Dev'), tab(leaf(1), 'Again')), group(tab(leaf(5), 'Terminal 3')))
    expect((await reads({}, [{ stdout }]).orca.orcaTabs())?.tabs).toEqual([
      { handle: H(1), title: 'PM', renamed: true }, { handle: H(2), title: 'Dev', renamed: true }, { handle: H(3), title: 'Dev', renamed: true },
      { handle: H(4), title: 'Dev', renamed: true }, { handle: H(5), title: 'Terminal 3', renamed: true },
    ])
  })

  it('a tab whose title is none of its panes\' titles is one the person renamed; one titled as a pane of it is not', async () => {
    // Diego's main worktree (Orca 1.4.256): a shell, an agent in a tab Orca titled after its pane, and an agent in a tab
    // he named "PM", its pane "harness root".
    const diego = group(tab(leaf(1, 'Terminal 3'), 'Terminal 3'), tab(leaf(2, 'Skill từ SKILL.md'), 'Skill từ SKILL.md'), tab(leaf(3, 'harness root'), 'PM'))
    // A split tab titled as its second pane; titles compared as cleaned; a pane with no title or a bad one.
    const more = group(tab(panes(leaf(4, 'vim'), leaf(5, 'npm test')), 'npm test'), tab(leaf(6, ' Lead \n dev '), 'Lead dev'),
      tab(panes(leaf(7, 42), leaf(8, 'a\u0007b')), 'a\u0007b'), tab(leaf(9, 'x'.repeat(70)), 'x'.repeat(64)))
    expect((await reads({}, [{ stdout: listed(diego, more) }]).orca.orcaTabs())?.tabs).toEqual([
      { handle: H(1), title: 'Terminal 3' }, { handle: H(2), title: 'Skill từ SKILL.md' }, { handle: H(3), title: 'PM', renamed: true },
      { handle: H(4), title: 'npm test' }, { handle: H(5), title: 'npm test' }, { handle: H(6), title: 'Lead dev' },
      { handle: H(7) }, { handle: H(8) }, { handle: H(9), title: 'x'.repeat(64) },
    ])
  })

  it('the terminals an agent runs in, with their folder and agent: a shell\'s, and any row it cannot hold to its bounds, left out', async () => {
    const terminals = [
      // Diego's: a shell, then two Claude Code agents in the main worktree.
      row(1, '/Users/d/harness'), row(2, '/Users/d/harness', 'claude'), row(3, '/Users/d/harness', 'claude'),
      row(4, '/Users/d/other', 'codex'),
      // A handle named twice keeps its first row.
      row(2, '/Users/d/elsewhere', 'claude'),
      { ...row(5, '/w', 'claude'), handle: 'term_0f8e2c1a' }, { ...row(6, '/w', 'claude'), handle: 42 },
      row(7, 42, 'claude'), row(8, '/w', 42), row(9, null, 'claude'), row(10, '/w', null),
      row(11, `/${'p'.repeat(4096)}`, 'claude'), row(12, '/w', 'c'.repeat(65)),
      row(13, `/${'p'.repeat(4095)}`, 'c'.repeat(64)),
      'made up', null, 42,
    ]
    expect((await reads({}, [{ stdout: listedWith(terminals, group(tab(leaf(1)))) }]).orca.orcaTabs())?.terminals).toEqual([
      { handle: H(2), worktreePath: '/Users/d/harness', agentIdentity: 'claude' },
      { handle: H(3), worktreePath: '/Users/d/harness', agentIdentity: 'claude' },
      { handle: H(4), worktreePath: '/Users/d/other', agentIdentity: 'codex' },
      { handle: H(13), worktreePath: `/${'p'.repeat(4095)}`, agentIdentity: 'c'.repeat(64) },
    ])
    // A list that is no array is no terminals.
    for (const odd of [undefined, null, 'made up', { 0: row(1, '/w', 'claude') }]) {
      expect((await reads({}, [{ stdout: listedWith(odd, group(tab(leaf(1)))) }]).orca.orcaTabs())?.terminals, String(odd)).toEqual([])
    }
    const full = Array.from({ length: 256 }, (_, i) => row(i + 1, '/w', 'claude'))
    expect((await reads({}, [{ stdout: listedWith(full) }]).orca.orcaTabs())?.terminals.map((t) => t.handle))
      .toEqual(Array.from({ length: 256 }, (_, i) => H(i + 1)))
  })

  it('a list cut short, by Orca (its 200 rows by default) or past 256 rows, is no terminals: one left out could be the match', async () => {
    const cut = JSON.parse(listedWith([row(1, '/w', 'claude')], group(tab(leaf(1), 'PM'))))
    cut.result.truncated = true
    const read = await reads({}, [{ stdout: JSON.stringify(cut) }]).orca.orcaTabs()
    expect(read).toEqual({ tabs: [{ handle: H(1), title: 'PM', renamed: true }], terminals: [], worktrees: new Map([[H(1), 'w0']]) })
    const many = Array.from({ length: 257 }, (_, i) => row(i + 1, '/w', 'claude'))
    expect((await reads({}, [{ stdout: listedWith(many) }]).orca.orcaTabs())?.terminals).toEqual([])
  })

  /** A list whose layouts carry these worktree ids, each with its root, and these rows. */
  const listedIn = (terminals: unknown[], ...layouts: Array<[unknown, unknown]>) => JSON.stringify({ id: 'x', ok: true, result: { terminals,
    visualLayouts: layouts.map(([worktreeId, root], i) => ({ worktreeId, worktreePath: `/made/up/${i}`, root })), totalCount: 0, truncated: false } })
  const inWorktree = (n: number, worktreeId: unknown, agentIdentity?: unknown) => ({ ...row(n, '/w', agentIdentity), worktreeId })
  // Orca's own form: its repo's uuid, `::`, the worktree's folder; a folder's bound and 64 more.
  const WT = 'bfeba4a9-ec47-4daa-bdb0-5a6b702b5a08::/Users/d/autonomous-harness'
  const longest = `x::/${'p'.repeat(4160 - 4)}`

  it('each terminal\'s worktree, by its id: its layout\'s, else its row\'s, a shell\'s too; one that is no string, empty, too long or holds a control character is none', async () => {
    const stdout = listedIn([
      // A row of a laid-out terminal does not replace its layout's; one laid out nowhere gives its own, a shell's too.
      inWorktree(1, 'row'), inWorktree(5, 'r5', 'claude'), inWorktree(6, 'r6'),
      inWorktree(7, 42), inWorktree(8, ''), inWorktree(9, `${longest}p`), inWorktree(10, 'a\nb'), inWorktree(11, 'a\u0000b'),
      inWorktree(12, longest), { ...inWorktree(13, 'r13'), handle: 'term_0f8e2c1a' }, row(14, '/w', 'claude'),
    ], [WT, group(tab(leaf(1)), tab(panes(leaf(2), leaf(3))))], [42, group(tab(leaf(4)))], ['w\u0007', group(tab(leaf(15)))])
    expect((await reads({}, [{ stdout }]).orca.orcaTabs())?.worktrees).toEqual(new Map([
      [H(1), WT], [H(2), WT], [H(3), WT], [H(5), 'r5'], [H(6), 'r6'], [H(12), longest],
    ]))
    // A list cut short still gives each row's: only placing an agent needs every row.
    const cut = JSON.parse(listedIn([inWorktree(1, 'r1', 'claude')]))
    cut.result.truncated = true
    expect((await reads({}, [{ stdout: JSON.stringify(cut) }]).orca.orcaTabs())?.worktrees).toEqual(new Map([[H(1), 'r1']]))
  })

  it('at most 256 terminals\' worktrees', async () => {
    const laid = Array.from({ length: 200 }, (_, i) => tab(leaf(i + 1)))
    const rows = Array.from({ length: 300 }, (_, i) => inWorktree(i + 1, `r${i + 1}`))
    const worktrees = (await reads({}, [{ stdout: listedIn(rows, ['w', group(...laid)]) }]).orca.orcaTabs())?.worktrees
    expect(worktrees?.size).toBe(256)
    expect(worktrees?.get(H(200))).toBe('w')
    expect(worktrees?.get(H(256))).toBe('r256')
    expect(worktrees?.has(H(257))).toBe(false)
  })

  it('a read\'s worktree the adapter is given: a bad id read is a switch alone', async () => {
    const stdout = listedIn([inWorktree(1, 'a\nb'), inWorktree(2, WT)])
    const worktrees = (await reads({}, [{ stdout }]).orca.orcaTabs())!.worktrees
    const { calls, run } = recordingRun()
    const adapter = createOrcaAdapter({ ...quietDeps(), run }, { worktreeOf: (handle) => worktrees.get(handle), log: () => {}, switching: () => {} })
    expect(await adapter.show({ adapter: 'orca', id: H(1) }, 'a1')).toBe('ok')
    expect(await adapter.show({ adapter: 'orca', id: H(2) }, 'a1')).toBe('ok')
    expect(calls.map((call) => call.args)).toEqual([
      ['terminal', 'switch', '--terminal', H(1), '--json'],
      ['worktree', 'activate', '--worktree', `id:${WT}`, '--json'], ['terminal', 'switch', '--terminal', H(2), '--json'],
    ])
  })

  it('a title over 64 characters is cut, one with a control character or not a string is none', async () => {
    const stdout = listed(group(
      tab(leaf(1), 'x'.repeat(70)), tab(leaf(2), ' Lead \n  dev '), tab(leaf(3), 'a\u0007b'), tab(leaf(4), 42), tab(leaf(5), null),
      tab(leaf(6), ''), { tabId: 't', activeLeafId: 'l', panes: leaf(7) },
    ))
    const tabs = (await reads({}, [{ stdout }]).orca.orcaTabs())?.tabs
    expect(tabs).toEqual([
      { handle: H(1), title: 'x'.repeat(64), renamed: true }, { handle: H(2), title: 'Lead dev', renamed: true }, { handle: H(3) }, { handle: H(4) },
      { handle: H(5) }, { handle: H(6) }, { handle: H(7) },
    ])
    // None is no title at all, not one that is undefined.
    expect(tabs!.slice(2).every((t) => !('title' in t))).toBe(true)
  })

  it('a node type it does not know, a split with no second, a tab with no panes: that branch has no handles and the rest are read', async () => {
    const stdout = listed(
      group(
        tab(leaf(1)),
        { tabId: 't', title: 'made up', activeLeafId: 'l' },
        tab({ type: 'browser', handle: H(11) }),
        tab(panes(leaf(2), { type: 'webview', first: leaf(12) })),
        tab({ type: 'pane-split', direction: 'horizontal', first: leaf(3) }),
        'no tab',
        null,
      ),
      { type: 'stack', tabs: [tab(leaf(13))] },
      { type: 'split', direction: 'vertical', first: group(tab(leaf(4))) },
      { type: 'group', tabs: { 0: tab(leaf(14)) } },
      undefined,
      group(tab(leaf(5))),
    )
    expect(await order(stdout)).toEqual([H(1), H(2), H(3), H(4), H(5)])
  })

  it('a handle in another form is left out; one named twice keeps its first place', async () => {
    const odd = (handle: unknown) => ({ ...leaf(0), handle })
    const stdout = listed(
      group(tab(leaf(2)), tab(odd('term_0f8e2c1a')), tab(odd(H(3).toUpperCase())), tab(odd(`${H(3)}\n`)), tab(odd(42)), tab(odd(undefined)), tab(leaf(1)), tab(leaf(2))),
      group(tab(leaf(1))),
    )
    expect(await order(stdout)).toEqual([H(2), H(1)])
  })

  it('no visualLayouts, or one that is no array, is no handles', async () => {
    for (const stdout of [
      JSON.stringify({ id: 'x', ok: true, result: { terminals: [], totalCount: 0, truncated: false } }),
      JSON.stringify({ id: 'x', ok: true, result: { terminals: [], visualLayouts: { root: group(tab(leaf(1))) } } }),
      JSON.stringify({ id: 'x', ok: true, result: { visualLayouts: [null, 'made up', 42] } }),
      JSON.stringify({ id: 'x', ok: true, result: 'made up' }),
      JSON.stringify({ id: 'x', ok: true }),
      '42', 'null', '[]', '"made up"',
    ]) {
      expect(await order(stdout), stdout).toEqual([])
    }
  })

  it('the bounds', async () => {
    // 70 worktrees, one terminal each.
    expect(await order(listed(...Array.from({ length: 70 }, (_, i) => group(tab(leaf(i + 1)))))))
      .toEqual(Array.from({ length: 64 }, (_, i) => H(i + 1)))
    // 300 terminals, a tab each.
    expect(await order(listed(group(...Array.from({ length: 300 }, (_, i) => tab(leaf(i + 1)))))))
      .toEqual(Array.from({ length: 256 }, (_, i) => H(i + 1)))
    // A tree 40 deep, of panes, then of groups. A layout's root is depth 1 and the next node down one deeper, so terminal
    // n sits at depth n + 2: those down to depth 32 are 1 to 30.
    let deepPanes: unknown = leaf(40)
    let deepGroups: unknown = group(tab(leaf(40)))
    for (let n = 39; n >= 1; n--) {
      deepPanes = panes(leaf(n), deepPanes)
      deepGroups = split(group(tab(leaf(n))), deepGroups)
    }
    const thirty = Array.from({ length: 30 }, (_, i) => H(i + 1))
    expect(await order(listed(group(tab(deepPanes))))).toEqual(thirty)
    expect(await order(listed(deepGroups))).toEqual(thirty)
  })

  it('a failed read is null', async () => {
    expect(await reads({}, [{ code: 1, stdout: listed(group(tab(leaf(1)))) }]).orca.orcaTabs()).toBeNull()
    // A timeout's kill has no exit code.
    expect(await reads({}, [{ code: null }]).orca.orcaTabs()).toBeNull()
    const none = reads({ onPath: () => null, platform: 'linux' })
    expect(await none.orca.orcaTabs()).toBeNull()
    expect(none.calls).toEqual([])
    for (const stdout of ['', 'made up', '{"id":"x","ok":true', listed(group(tab(leaf(1)))).slice(0, -1)]) {
      expect(await order(stdout), stdout).toBeNull()
    }
    // The real run, of a file it refuses before starting.
    expect(await createOrcaReads({ ...orcaDeps(), onPath: () => join(dir, 'orca\0'), exists: () => false }).orcaTabs()).toBeNull()
  })

  it('a stdout over 1 MiB fails the read', async () => {
    // Read whole, this layout is one handle: only its size fails it.
    const json = join(dir, 'layout.json')
    const root = group(tab(leaf(1)))
    writeFileSync(json, JSON.stringify({ id: 'x', ok: true, result: { terminals: [], visualLayouts: [{ worktreeId: 'w0', worktreePath: '/made/up/0', root }], pad: 'a'.repeat(1_153_434) } }))
    const fake = fakeOrca(`cat '${json}'`)
    const orca = createOrcaReads({ ...orcaDeps(), onPath: () => fake.file, exists: () => false })
    expect(await orca.orcaTabs()).toBeNull()
    expect(fake.argv()).toEqual(['terminal', 'list', '--json', '--include-visual-layouts'])
    writeFileSync(json, listed(root))
    expect((await orca.orcaTabs())?.tabs.map((t) => t.handle)).toEqual([H(1)])
  })
})

describe("Orca's focus watch", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A watch on a fake child, and every handle it told. */
  function watching(over: Partial<OrcaReadDeps> = {}) {
    const fake = reads(over)
    const told: Array<string | null> = []
    const watch = fake.orca.watchOrcaFocus((handle) => told.push(handle))
    return { ...fake, told, watch }
  }

  it('spawns terminal watch-focus --json and tells each line\'s handle, null for none', () => {
    const { spawned, children, told } = watching()
    expect(spawned).toEqual([{ file: FAKE_PATH_ORCA, args: ['terminal', 'watch-focus', '--json'] }])
    children[0].write(`{"handle":"${H(1)}"}\n`)
    children[0].write('{"handle":null}\n')
    children[0].write(`{"handle":"${H(2)}"}\n`)
    expect(told).toEqual([H(1), null, H(2)])
  })

  it('a line split across chunks is one line, and two lines in a chunk are two', () => {
    const { children, told } = watching()
    children[0].write('{"hand')
    children[0].write(`le":"${H(1)}"`)
    expect(told).toEqual([])
    children[0].write(`}\n{"handle":null}\n{"handle":"${H(2)}"}\n{"handle":"${H(3)}`)
    expect(told).toEqual([H(1), null, H(2)])
    children[0].write('"}\n')
    expect(told).toEqual([H(1), null, H(2), H(3)])
  })

  it('a line over 512 bytes is dropped, whole or still growing, and the next line is told', () => {
    // A focus line led by spaces up to that many bytes: by its bytes alone it would be told.
    const padded = (bytes: number) => {
      const line = `{"handle":"${H(9)}"}`
      return `${' '.repeat(bytes - line.length)}${line}`
    }
    const { children, told } = watching()
    // 4 KiB with no newline yet, 100 bytes at a time.
    const long = padded(4096)
    for (let at = 0; at < long.length; at += 100) children[0].write(long.slice(at, at + 100))
    children[0].write('\n{"handle":null}\n')
    expect(told).toEqual([null])
    // Whole in one chunk: 513 bytes is dropped, 512 is told.
    children[0].write(`${padded(513)}\n${padded(512)}\n`)
    expect(told).toEqual([null, H(9)])
  })

  it('a line that is no JSON, no object, has no handle, or a handle in another form is dropped', () => {
    const { children, told } = watching()
    const lines = [
      'made up', '{"handle":', '42', 'null', '[]', `"${H(1)}"`, `[{"handle":"${H(1)}"}]`, '{}', '{"focused":true}',
      '{"handle":42}', '{"handle":true}', '{"handle":{}}', '{"handle":"term_0f8e2c1a"}', `{"handle":"${H(1).toUpperCase()}"}`,
      `{"handle":"${H(1)}\\n"}`, `{"handle":" ${H(1)}"}`, '',
    ]
    children[0].write(lines.map((line) => `${line}\n`).join(''))
    children[0].write(`{"handle":"${H(2)}"}\n`)
    expect(told).toEqual([H(2)])
  })

  it('stop sends SIGTERM, then SIGKILL after 1 s when the child has not gone; a child that went gets no SIGKILL', async () => {
    vi.useFakeTimers()
    const { children, orca } = reads()
    const deaf = orca.watchOrcaFocus(() => {})
    deaf.stop()
    // Stopped twice, it is stopped once.
    deaf.stop()
    expect(children[0].kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(999)
    expect(children[0].kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(1)
    expect(children[0].kills).toEqual(['SIGTERM', 'SIGKILL'])

    const going = orca.watchOrcaFocus(() => {})
    going.stop()
    children[1].end()
    await going.ended
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children[1].kills).toEqual(['SIGTERM'])

    // One that had gone before it was stopped is sent nothing.
    const gone = orca.watchOrcaFocus(() => {})
    children[2].end()
    await gone.ended
    gone.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(children[2].kills).toEqual([])
  })

  it('no line is told after stop', () => {
    const { children, told, watch } = watching()
    children[0].write(`{"handle":"${H(1)}"}\n{"handle":"${H(2)}`)
    watch.stop()
    children[0].write('"}\n{"handle":null}\n')
    expect(told).toEqual([H(1)])
    children[0].end()

    // Stopped by a line it told, the rest of that chunk is not told either.
    const later = reads()
    const heard: Array<string | null> = []
    const stopping = later.orca.watchOrcaFocus((handle) => {
      heard.push(handle)
      stopping.stop()
    })
    later.children[0].write(`{"handle":"${H(1)}"}\n{"handle":"${H(2)}"}\n`)
    expect(heard).toEqual([H(1)])
    later.children[0].end()
  })

  it('ended resolves when the child exits by itself, and when it could not start; with no binary nothing is spawned and it has ended', async () => {
    const { children, watch } = watching()
    let ended = false
    void watch.ended.then(() => { ended = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toBe(false)
    children[0].end()
    await watch.ended
    expect(children[0].kills).toEqual([])

    // The real spawn, of a binary that is not there.
    const missing = createOrcaReads({ ...orcaDeps(), onPath: () => join(dir, 'missing'), exists: () => false }).watchOrcaFocus(() => {})
    await missing.ended
    missing.stop()

    // The real spawn, of a file it refuses before starting: it throws rather than emits.
    const refused = createOrcaReads({ ...orcaDeps(), onPath: () => join(dir, 'orca\0'), exists: () => false }).watchOrcaFocus(() => {})
    await refused.ended
    refused.stop()

    // Out of descriptors (EMFILE), the real spawn returns a child with no pipes, and its error follows.
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new ChildProcess()
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })))
      return child
    })
    const noPipes = createOrcaReads({ ...orcaDeps(), onPath: () => join(dir, 'orca'), exists: () => false }).watchOrcaFocus(() => {})
    await noPipes.ended
    noPipes.stop()
    await new Promise((resolve) => setImmediate(resolve))

    const none = watching({ onPath: () => null, platform: 'linux' })
    expect(none.spawned).toEqual([])
    await none.watch.ended
    none.watch.stop()
  })

  /** A watch on the real spawn, of a script in the test's folder, with the child it started; the child is killed after
   *  the test if it is still there. `arrived` resolves once [heard] lines were told. */
  function realWatch(script: string, heard: number) {
    const fake = fakeOrca(script)
    const told: Array<string | null> = []
    let all!: () => void
    const arrived = new Promise<void>((resolve) => { all = resolve })
    const watch = createOrcaReads({ ...orcaDeps(), onPath: () => fake.file, exists: () => false }).watchOrcaFocus((handle) => {
      if (told.push(handle) === heard) all()
    })
    const child = vi.mocked(spawn).mock.results.at(-1)!.value as ChildProcess
    // Its sleep would outlive the suite.
    onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    return { fake, told, arrived, watch, child }
  }

  it('the real child: a script\'s lines arrive, its stderr does not stall it, and stop ends it', async () => {
    // 200 KiB on stderr is more than its pipe holds (64 KiB on macOS): left unread, the script stalls before its lines.
    const real = realWatch(`head -c 204800 /dev/zero >&2\nprintf '%s\\n' '{"handle":"${H(1)}"}' '{"handle":null}'\nexec sleep 300`, 2)
    await real.arrived
    expect(real.told).toEqual([H(1), null])
    expect(real.fake.argv()).toEqual(['terminal', 'watch-focus', '--json'])
    real.watch.stop()
    await real.watch.ended
    expect(real.child.signalCode).toBe('SIGTERM')
  })

  it('the real child deaf to SIGTERM is killed', async () => {
    // Its line says the trap is set: a SIGTERM before it would end the shell itself.
    const real = realWatch(`trap '' TERM\nprintf '%s\\n' '{"handle":null}'\nexec sleep 300`, 1)
    await real.arrived
    real.watch.stop()
    await real.watch.ended
    expect(real.child.signalCode).toBe('SIGKILL')
  })
})
