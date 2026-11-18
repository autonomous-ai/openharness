/**
 * The move at a start (docs/plans/2026-11-18-linux-xdg-paths-design.md, When the move runs, Where the move runs, Failures
 * and state), on a real home: which commands run it, what each outcome says and records, when a failed one is tried
 * again, the lock another start holds, and the start again from the new paths. tmux, systemctl and execve are fakes.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { readBridge } from './bridge.js'
import { checkMove } from './conditions.js'
import { readJournal } from './journal.js'
import { LOCK_WAIT_MS, moveLockPath, type LockDeps } from './lock.js'
import { runMove, type MoveDeps } from './move.js'
import { defaultTmux, type Tmux } from './panes.js'
import { readMoveRecord } from './record.js'
import { answers, moveHomeAtStart, ptyHostRuns, reexecTarget, type StartDeps } from './start.js'

// node:fs with no flush to the device: what a power cut keeps is journal.ts's to test, and here a flush only slows each step.
const disk: StartDeps['io'] = { ...fs, fsyncSync: () => {} }

const NOW = 1_763_000_000_000
const PROC_NOW = 1_763_000_000
const MINUTE = 60_000
const NODE = 'runtime/node-v24.11.1-linux-x64/bin/node'
// The lock's other owner, and this start, as the fake lock's process table knows them.
const OTHER = 4_242
const SELF = 4_343
// Root writes through any folder's mode.
const asRoot = process.getuid?.() === 0

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fresh(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function put(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode })
  chmodSync(path, mode)
}

interface Home {
  root: string; home: string; legacy: string; data: string; state: string
  tmux: Tmux
  /** What the fake tmux says of its version. */
  tmuxVersion: string
  clock: { now: number }
  /** Every execve, as asked. */
  execs: { file: string; args: string[]; env: NodeJS.ProcessEnv }[]
  deps(over?: Partial<StartDeps>): StartDeps
}

/**
 * A ~/.harness from before the move, as a release installs and runs it: the managed Node and cli.js, the data folder,
 * a sign-in and the computer's id; a pane its daemon tagged, on tmux 3.4. This start runs from that Node and cli.js.
 */
function legacyHome({ unknown = false }: { unknown?: boolean } = {}): Home {
  const root = fresh('move-start-'), home = join(root, 'h'), legacy = join(home, '.harness')
  put(join(legacy, NODE), '#!/bin/sh\n', 0o755)
  put(join(legacy, 'cli', 'cli.js'), '// harness\n', 0o644)
  put(join(legacy, 'cli', 'data', 'registry.json'), '[]')
  put(join(legacy, 'auth', 'session.json'), '{"token":"t-1"}')
  put(join(legacy, 'computer-id'), 'c0ffee-machine')
  if (unknown) put(join(legacy, 'notes', 'keep'), 'notes\n')
  const panes = new Map([['%1', harnessPaneOwner(join(legacy, 'cli', 'data'))]])
  const execs: Home['execs'] = []
  const clock = { now: NOW }
  const t: Home = {
    root, home, legacy, data: join(home, '.local', 'share', 'harness'), state: join(home, '.local', 'state', 'harness'),
    tmuxVersion: 'tmux 3.4', clock, execs,
    tmux: defaultTmux((args) => {
      if (args[0] === '-V') return { status: 0, stdout: `${t.tmuxVersion}\n` }
      if (args[0] === 'list-panes') {
        const withId = args[3].startsWith('#{pane_id}|')
        return { status: 0, stdout: [...panes].map(([id, tag]) => withId ? `${id}|${tag}\n` : `${tag}\n`).join('') }
      }
      // set-option -p -t <pane> @harness_daemon <tag>
      panes.set(args[3], args[5])
      return { status: 0, stdout: '' }
    }),
    deps: (over = {}) => ({
      platform: 'linux', home, io: disk, tmux: t.tmux, run: () => ({ status: 0 }), now: () => clock.now, procNow: () => PROC_NOW,
      alive: () => false, answers: async () => false, ptyHostRuns: () => false,
      execve: (file, args, env) => { execs.push({ file, args, env }) }, execPath: join(legacy, NODE), execArgv: [], print: null, ...over,
    }),
  }
  return t
}

/** process.argv for `harness <args>` run from the old tree's Node and cli.js. */
const argvOf = (t: Home, ...args: string[]): string[] => [join(t.legacy, NODE), join(t.legacy, 'cli', 'cli.js'), ...args]

/** The lines of harness.log in the data folder where it is now: an override's, the XDG one once moved, else ~/.harness's. */
function logOf(t: Home, env: NodeJS.ProcessEnv = {}): string[] {
  const folder = env.ADAPTER_DATA_DIR ?? join(existsSync(t.data) ? t.data : t.legacy, 'cli', 'data')
  try {
    return readFileSync(join(folder, 'harness.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** A lock on the move another live start holds, and the fake process table and watch this start waits with. */
function heldByAnother(t: Home): { lock: LockDeps; release(): void } {
  const path = moveLockPath(t.state)
  put(join(path, 'owner'), JSON.stringify({ pid: OTHER, start: 7 }))
  let wake = (): void => {}
  return {
    lock: { pid: SELF, startTime: (pid) => pid === OTHER ? 7 : pid === SELF ? 3 : null, watch: (_folder, onChange) => { wake = onChange; return { close: () => {} } } },
    release: () => {
      rmSync(path, { recursive: true })
      wake()
    },
  }
}

const moved = (t: Home): string => `home move: moved · data ${t.data} · state ${t.state}`

describe('the move at a start', () => {
  it('only start and __harnessd run it, and only on Linux', async () => {
    const untouchable = new Proxy({}, { get: (_target, name) => () => { throw new Error(`the move read ${String(name)}`) } }) as StartDeps['io']
    for (const args of [['status'], ['stop'], ['__run'], ['__service', 'search'], ['start', '--help'], ['start', '-h']]) {
      const t = legacyHome()
      await moveHomeAtStart(argvOf(t, ...args), {}, t.deps({ io: untouchable }))
      expect(readdirSync(t.home), args.join(' ')).toEqual(['.harness'])
    }
    const mac = legacyHome()
    await moveHomeAtStart(argvOf(mac, 'start'), {}, mac.deps({ platform: 'darwin', io: untouchable }))
    expect(readdirSync(mac.home)).toEqual(['.harness'])
    for (const args of [['start'], ['start', '-f'], ['start', '--if-down'], ['__harnessd']]) {
      const t = legacyHome()
      await moveHomeAtStart(argvOf(t, ...args), {}, t.deps())
      expect(existsSync(join(t.data, 'cli', 'cli.js')), args.join(' ')).toBe(true)
    }
  })

  const HOLDS: { name: string; hold(t: Home): { env?: NodeJS.ProcessEnv; deps?: Partial<StartDeps> }; record: { state: string; reason?: string }; line: string }[] = [
    {
      name: 'an update that awaits its verdict',
      hold: (t) => { put(join(t.legacy, 'cli', 'update-pending.json'), '{}'); return {} },
      record: { state: 'waiting', reason: 'update-pending' },
      line: 'home move: waiting update-pending · it moves at the start after this update settles',
    },
    {
      name: 'an override inside ~/.harness',
      hold: (t) => ({ env: { ADAPTER_DATA_DIR: join(t.legacy, 'cli', 'data') } }),
      record: { state: 'skipped-override' },
      line: 'home move: skipped-override · ADAPTER_DATA_DIR names a folder inside ~/.harness; unset it to move',
    },
    {
      name: 'a ~/.harness that is a link',
      hold: (t) => {
        const real = join(t.root, 'elsewhere')
        renameSync(t.legacy, real)
        symlinkSync(real, t.legacy)
        return {}
      },
      record: { state: 'skipped-override' },
      line: 'home move: skipped-override · ~/.harness is a link; it stays where it points',
    },
    {
      name: 'tmux before 3.0 with a pane of this daemon',
      hold: (t) => { t.tmuxVersion = 'tmux 2.9'; return {} },
      record: { state: 'waiting', reason: 'old-tmux' },
      line: 'home move: waiting old-tmux · close the agents, then harness start',
    },
    {
      name: 'a live PTY host',
      hold: () => ({ deps: { ptyHostRuns: () => true } }),
      record: { state: 'waiting', reason: 'pty-host' },
      line: 'home move: waiting pty-host · close the agents, then harness start',
    },
  ]

  it.each(HOLDS)('a held move writes its record once and logs one line at each start: $name', async ({ hold, record, line }) => {
    const t = legacyHome()
    const { env = {}, deps = {} } = hold(t)
    await moveHomeAtStart(argvOf(t, '__harnessd'), env, t.deps(deps))
    expect(readMoveRecord(t.home, env)).toEqual({ version: 1, ...record, entries: 0, bytesCopied: 0, panes: 0, oldProcesses: 0, at: NOW })
    expect(logOf(t, env)).toEqual([line])
    const file = join(t.legacy, 'home-move.json')
    utimesSync(file, 1_000, 1_000)
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, 'start', '--if-down'), env, t.deps(deps))
    expect(statSync(file).mtimeMs).toBe(1_000_000)
    expect(logOf(t, env)).toEqual([line, line])
    expect(existsSync(t.data)).toBe(false)
    expect(t.execs).toEqual([])
  })

  it('a moved home logs "home move: moved · data <root> · state <root>" in the data folder\'s harness.log where it is now, and on a terminal', async () => {
    const t = legacyHome({ unknown: true })
    put(join(t.legacy, 'cli', 'data', 'harness.log'), 'a line from before\n')
    const printed: string[] = []
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ print: (line) => printed.push(line) }))
    const lines = ['home move: unknown entry notes · moved to data', moved(t)]
    expect(readFileSync(join(t.data, 'cli', 'data', 'harness.log'), 'utf8')).toBe(`a line from before\n${lines.join('\n')}\n`)
    expect(printed).toEqual(lines)
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'bridged' })

    // Not on a terminal (systemd's start): the log alone.
    const quiet = legacyHome()
    await moveHomeAtStart(argvOf(quiet, '__harnessd'), {}, quiet.deps({ print: null }))
    expect(logOf(quiet)).toEqual([moved(quiet)])
  })

  it('a failed move logs "home move: failed <reason> · ~/.harness is as it was", and the start goes on', async () => {
    const t = legacyHome()
    // Somebody's state root: the move takes nothing over.
    mkdirSync(t.state, { recursive: true })
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    expect(logOf(t)).toEqual(['home move: failed target-exists · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'target-exists', failedAt: NOW })
    expect(existsSync(t.data)).toBe(false)
    expect(t.execs).toEqual([])
  })

  it.skipIf(asRoot)('an XDG state base this account cannot write fails with permission, and ~/.harness is as it was', async () => {
    const t = legacyHome()
    const base = dirname(t.state)
    mkdirSync(base, { recursive: true })
    chmodSync(base, 0o500)
    try {
      await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    } finally {
      chmodSync(base, 0o700)
    }
    expect(logOf(t)).toEqual(['home move: failed permission · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'permission' })
    expect(readdirSync(base)).toEqual([])
  })

  it('a failure after the data root\'s commit runs from the new folders, and does not say ~/.harness is as it was', async () => {
    const t = legacyHome()
    const noProc = (): number => { throw Object.assign(new Error('no /proc'), { code: 'EIO' }) }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ procNow: noProc }))
    expect(existsSync(t.data)).toBe(true)
    expect(logOf(t)).toEqual(['home move: failed io · the next start finishes it'])
    expect(t.execs).toHaveLength(1)
  })

  it('a journal is recovered before anything else: the failed hour, and a data root already there, do not stop it', async () => {
    const t = legacyHome()
    const noProc = (): number => { throw Object.assign(new Error('no /proc'), { code: 'EIO' }) }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ procNow: noProc }))
    expect(readJournal(t.legacy)).not.toBeNull()
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(readJournal(t.legacy)).toBeNull()
    expect(readBridge(t.state)).toMatchObject({ oldHome: t.legacy, movedAt: PROC_NOW })
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'bridged' })
    expect(logOf(t)).toEqual(['home move: failed io · the next start finishes it', moved(t)])
    expect(t.execs).toHaveLength(2)
  })

  it('a failed move is tried again at once by harness start, and by __harnessd and --if-down an hour after the last try', async () => {
    const t = legacyHome()
    mkdirSync(t.state, { recursive: true })
    /** Whether a start at [minutes] tried the move: each try that fails logs its line. */
    const tries = async (minutes: number, ...args: string[]): Promise<boolean> => {
      t.clock.now = NOW + minutes * MINUTE
      const before = logOf(t).length
      await moveHomeAtStart(argvOf(t, ...args), {}, t.deps())
      return logOf(t).length > before
    }
    expect(await tries(0, '__harnessd')).toBe(true)
    expect(await tries(59, '__harnessd')).toBe(false)
    expect(await tries(59, 'start', '--if-down')).toBe(false)
    expect(await tries(59, 'start')).toBe(true)
    expect(await tries(60, 'start', '-f')).toBe(true)
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', failedAt: NOW + 60 * MINUTE })
    // The hour counts from the last try, not the first.
    expect(await tries(119, '__harnessd')).toBe(false)
    expect(await tries(121, 'start', '--if-down')).toBe(true)
    expect(existsSync(t.data)).toBe(false)
  })

  it('a start that waited for another start\'s move resolves the roots again, and starts again from the new paths', async () => {
    const t = legacyHome()
    const other = heldByAnother(t)
    const waiting = moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps({ lock: other.lock }))
    // The other start moves, as its own run does, then lets go of the lock.
    const check = await checkMove({ ...t.deps(), env: {}, hasExecve: true, fs: disk })
    if (!check.move) throw new Error(`this home does not move: ${JSON.stringify(check.hold)}`)
    const deps: MoveDeps = { ...t.deps(), log: () => {} }
    expect(await runMove(check, {}, deps)).toMatchObject({ state: 'bridged' })
    other.release()
    await waiting
    // Its move was the other start's to say.
    expect(logOf(t)).toEqual([])
    expect(t.execs).toHaveLength(1)
    expect(t.execs[0].file).toBe(join(t.state, NODE))
  })

  it('a lock still held after 30 s lets the start go on, unmoved', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = legacyHome()
    const other = heldByAnother(t)
    const waiting = moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ lock: other.lock }))
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS)
    await waiting
    expect(existsSync(t.data)).toBe(false)
    expect(readMoveRecord(t.home, {})).toBeNull()
    expect(logOf(t)).toEqual([])
    expect(t.execs).toEqual([])
  })

  it('a ~/.harness beside the data root that is not the bridge is said once, and nothing in it is deleted', async () => {
    const t = legacyHome()
    mkdirSync(join(t.data, 'cli', 'data'), { recursive: true })
    mkdirSync(t.state, { recursive: true })
    const before = readdirSync(t.legacy, { recursive: true }).sort()
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(logOf(t)).toEqual(['home move: ~/.harness is no longer read'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ stray: true })
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    expect(logOf(t)).toEqual(['home move: ~/.harness is no longer read'])
    expect(readdirSync(t.legacy, { recursive: true }).sort()).toEqual(before)
    expect(t.execs).toEqual([])
  })

  it('anything the move throws is caught: one failed io line, and the start goes on', async () => {
    const t = legacyHome()
    const io = { ...disk, readdirSync: (() => { throw new Error('unreadable') }) as unknown as typeof fs.readdirSync }
    await expect(moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ io }))).resolves.toBeUndefined()
    expect(logOf(t)).toEqual(['home move: failed io · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'io' })
    expect(existsSync(t.data)).toBe(false)
    expect(t.execs).toEqual([])
  })
})

describe('the process starts again from the new paths', () => {
  const plan = { legacy: '/h/.harness', data: '/h/.local/share/harness', state: '/h/.local/state/harness' }

  it('reexecTarget maps a Node and a cli.js in ~/.harness, and keeps Node\'s options and the arguments', () => {
    expect(reexecTarget(plan, `/h/.harness/${NODE}`, [`/h/.harness/${NODE}`, '/h/.harness/cli/cli.js', 'start', '-f'], ['--max-old-space-size=4096'])).toEqual({
      file: `/h/.local/state/harness/${NODE}`,
      args: [`/h/.local/state/harness/${NODE}`, '--max-old-space-size=4096', '/h/.local/share/harness/cli/cli.js', 'start', '-f'],
    })
    expect(reexecTarget(plan, '/usr/bin/node', ['/usr/bin/node', '/h/.harness/cli/cli.js', '__harnessd'], [])).toEqual({
      file: '/usr/bin/node', args: ['/usr/bin/node', '/h/.local/share/harness/cli/cli.js', '__harnessd'],
    })
    // Harness OS's, or a checkout's: nothing of it was in ~/.harness.
    expect(reexecTarget(plan, '/usr/bin/node', ['/usr/bin/node', '/usr/lib/harness/cli.mjs', 'start'], [])).toBeNull()
  })

  it('after a move execve runs once, with the same environment', async () => {
    const t = legacyHome()
    const env = { PATH: '/usr/bin', HARNESS_SOMETHING: '1' }
    await moveHomeAtStart(argvOf(t, '__harnessd'), env, t.deps({ execArgv: ['--max-old-space-size=4096'] }))
    expect(t.execs).toEqual([{ file: join(t.state, NODE), args: [join(t.state, NODE), '--max-old-space-size=4096', join(t.data, 'cli', 'cli.js'), '__harnessd'], env }])
    expect(t.execs[0].env).toBe(env)
  })

  it('with no target, or one that is not there, the start goes on in this process', async () => {
    const outside = legacyHome()
    await moveHomeAtStart(['/usr/bin/node', '/usr/lib/harness/cli.mjs', 'start'], {}, outside.deps({ execPath: '/usr/bin/node' }))
    expect(existsSync(outside.data)).toBe(true)
    expect(outside.execs).toEqual([])
    const gone = legacyHome()
    await moveHomeAtStart(argvOf(gone, 'start'), {}, gone.deps({ execPath: join(gone.legacy, 'runtime', 'node-gone', 'bin', 'node') }))
    expect(existsSync(gone.data)).toBe(true)
    expect(gone.execs).toEqual([])
  })
})

describe('what the conditions read of this computer', () => {
  it('a PTY host runs while a discovery file of its folder names a live process', () => {
    const dir = fresh('pty-')
    expect(ptyHostRuns(dir)).toBe(false)
    const ended = spawnSync(process.execPath, ['-e', '']).pid
    put(join(dir, 'run', 'pty-host-p1.json'), JSON.stringify({ pid: ended }))
    put(join(dir, 'run', 'notes.json'), JSON.stringify({ pid: process.pid }))
    expect(ptyHostRuns(dir)).toBe(false)
    put(join(dir, 'run', 'pty-host-v2-1.json'), JSON.stringify({ pid: process.pid }))
    expect(ptyHostRuns(dir)).toBe(true)
  })

  it('a daemon answers on its socket; a path nobody listens on does not', async () => {
    const dir = fresh('sock-'), socket = join(dir, 'daemon-1.sock')
    expect(await answers(socket)).toBe(false)
    const server = createServer((connection) => connection.end())
    await new Promise<void>((done) => server.listen(socket, done))
    try {
      expect(await answers(socket)).toBe(true)
    } finally {
      await new Promise((done) => server.close(done))
    }
  })
})
