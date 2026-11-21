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
import { openJournal, readJournal } from './journal.js'
import { LOCK_LOOK_MS, moveLockPath, type LockDeps } from './lock.js'
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

const roots: string[] = [], startFolder = process.cwd()
afterEach(() => {
  vi.useRealTimers()
  process.chdir(startFolder)
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
  /** Every exit, by its code. */
  exits: number[]
  /** The processes the fake lock knows to run, by pid, with the clock tick each started at. */
  procs: Map<number, number>
  /** The fake lock of the start that runs as [pid]: its watch wakes at wake(). */
  lockAs(pid: number): LockDeps
  /** A change beside the lock, as fs.watch would tell it. */
  wake(): void
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
  const execs: Home['execs'] = [], exits: number[] = []
  const clock = { now: NOW }
  const procs = new Map([[SELF, 3]])
  const watchers = new Set<() => void>()
  const t: Home = {
    root, home, legacy, data: join(home, '.local', 'share', 'harness'), state: join(home, '.local', 'state', 'harness'),
    tmuxVersion: 'tmux 3.4', clock, execs, exits, procs,
    lockAs: (pid) => ({
      pid, startTime: (other) => procs.get(other) ?? null,
      watch: (_folder, onChange) => {
        watchers.add(onChange)
        return { close: () => watchers.delete(onChange) }
      },
    }),
    wake: () => { for (const onChange of [...watchers]) onChange() },
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
      execve: (file, args, env) => { execs.push({ file, args, env }) }, execPath: join(legacy, NODE), execArgv: [], print: null, lock: t.lockAs(SELF),
      exit: (code) => { exits.push(code) }, ...over,
    }),
  }
  return t
}

/** process.argv for `harness <args>` run from the old tree's Node and cli.js. */
const argvOf = (t: Home, ...args: string[]): string[] => [join(t.legacy, NODE), join(t.legacy, 'cli', 'cli.js'), ...args]

/** The marker that makes the data root Harness's (config/harnessHome.ts). */
const markerOf = (t: Home): string => join(t.data, '.harness-root')

/** The lines of harness.log in the data folder where it is now: an override's, the XDG one once moved, else ~/.harness's. */
function logOf(t: Home, env: NodeJS.ProcessEnv = {}): string[] {
  const folder = env.ADAPTER_DATA_DIR ?? join(statSync(markerOf(t), { throwIfNoEntry: false })?.isFile() ? t.data : t.legacy, 'cli', 'data')
  try {
    return readFileSync(join(folder, 'harness.log'), 'utf8').split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** A lock on the move another live start holds: it lets go, or it is killed, which changes nothing beside the lock. */
function heldByAnother(t: Home): { release(): void; dies(): void } {
  const path = moveLockPath(t.legacy)
  put(join(path, 'owner'), JSON.stringify({ pid: OTHER, start: 7 }))
  t.procs.set(OTHER, 7)
  return {
    release: () => {
      rmSync(path, { recursive: true })
      t.wake()
    },
    dies: () => { t.procs.delete(OTHER) },
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

  it('a relative ADAPTER_DATA_DIR is the home\'s: the line goes to its harness.log, whatever folder the start runs in', async () => {
    const t = legacyHome()
    process.chdir(fresh('move-start-folder-'))
    await moveHomeAtStart(argvOf(t, '__harnessd'), { ADAPTER_DATA_DIR: 'data' }, t.deps({ ptyHostRuns: () => true }))
    expect(logOf(t, { ADAPTER_DATA_DIR: join(t.home, 'data') })).toEqual(['home move: waiting pty-host · close the agents, then harness start'])
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

  // Somebody else's folder, or one Desktop made before the CLI: the machine stays on ~/.harness, and neither is touched.
  it('a data root that holds no marker beside ~/.harness: the move refuses it with target-exists, and touches neither', async () => {
    const t = legacyHome()
    put(join(t.data, 'theirs.txt'), 'theirs')
    const files = (): string[] => readdirSync(t.legacy, { recursive: true, encoding: 'utf8' }).filter((path) => path !== 'home-move.json' && path !== join('cli', 'data', 'harness.log')).sort()
    const before = files()
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    expect(logOf(t)).toEqual(['home move: failed target-exists · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'target-exists' })
    expect(files()).toEqual(before)
    expect(readFileSync(join(t.legacy, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(readdirSync(t.data)).toEqual(['theirs.txt'])
    expect(existsSync(t.state)).toBe(false)
    expect(t.execs).toEqual([])
  })

  it('a folder named as the marker is none: the move refuses the data root with target-exists, and ~/.harness is as it was', async () => {
    const t = legacyHome()
    mkdirSync(markerOf(t), { recursive: true })
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    expect(logOf(t)).toEqual(['home move: failed target-exists · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'target-exists' })
    expect(readFileSync(join(t.legacy, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(readdirSync(t.data)).toEqual(['.harness-root'])
    expect(t.execs).toEqual([])
  })

  it('a start on a fresh computer marks the data root Harness\'s, and says nothing', async () => {
    for (const made of [[], ['.local/share/harness']]) {
      const t = legacyHome()
      rmSync(t.legacy, { recursive: true })
      for (const folder of made) mkdirSync(join(t.home, folder), { recursive: true })
      await moveHomeAtStart(['/usr/bin/node', '/usr/lib/harness/cli.mjs', 'start'], {}, t.deps({ execPath: '/usr/bin/node' }))
      expect([readFileSync(markerOf(t), 'utf8'), statSync(markerOf(t)).mode & 0o777], made.join()).toEqual(['1\n', 0o600])
      expect(logOf(t)).toEqual([])
      expect(existsSync(t.legacy)).toBe(false)
      expect(t.execs).toEqual([])
    }
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

  it('a move whose rollback fails says the next start puts ~/.harness back, and the start ends there: nothing runs on a tree half moved', async () => {
    const t = legacyHome()
    let failing = true
    const io: StartDeps['io'] = {
      ...disk,
      renameSync: (from, to) => {
        // The data root's commit fails, then the rollback cannot put auth back.
        if (failing && (from === `${t.data}.moving` || to === join(t.legacy, 'auth'))) {
          failing = to !== join(t.legacy, 'auth')
          throw Object.assign(new Error('i/o error'), { code: 'EIO' })
        }
        fs.renameSync(from, to)
      },
    }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ io }))
    expect(logOf(t)).toEqual(['home move: failed io · the next start puts ~/.harness back'])
    expect([t.exits, t.execs]).toEqual([[1], []])
    // The next start puts it back, says so, and goes on.
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(readJournal(t.legacy)).toBeNull()
    expect(readFileSync(join(t.legacy, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(logOf(t)).toEqual(['home move: failed io · the next start puts ~/.harness back', 'home move: failed io · ~/.harness is as it was'])
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', reason: 'io', failedAt: NOW + MINUTE })
    expect(t.exits).toEqual([1])
  })

  it('a failure after the data root\'s commit runs from the new folders, which try again and say it once: never ~/.harness is as it was', async () => {
    const t = legacyHome()
    const noProc = (): number => { throw Object.assign(new Error('no /proc'), { code: 'EIO' }) }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ procNow: noProc }))
    expect(existsSync(t.data)).toBe(true)
    expect(t.execs).toHaveLength(1)
    // The same start, from the new paths.
    const [{ file, args }] = t.execs
    await moveHomeAtStart(args, {}, t.deps({ procNow: noProc, execPath: file }))
    expect(logOf(t)).toEqual(['home move: failed io · the next start finishes it'])
    expect(t.execs).toHaveLength(1)
    // A start that cannot run from them says it itself.
    const outside = legacyHome()
    await moveHomeAtStart(['/usr/bin/node', '/usr/lib/harness/cli.mjs', 'start'], {}, outside.deps({ procNow: noProc, execPath: '/usr/bin/node' }))
    expect(logOf(outside)).toEqual(['home move: failed io · the next start finishes it'])
  })

  it('a journal is recovered before anything else: the failed hour, and a data root already there, do not stop it', async () => {
    const t = legacyHome()
    const noProc = (): number => { throw Object.assign(new Error('no /proc'), { code: 'EIO' }) }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ procNow: noProc }))
    expect(readJournal(t.legacy)).not.toBeNull()
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(readJournal(t.legacy)).toBeNull()
    expect(readBridge(t.state)).toMatchObject({ oldHome: t.legacy })
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'bridged' })
    expect(logOf(t)).toEqual([moved(t)])
    expect(t.execs).toHaveLength(2)
  })

  it('a lock this start cannot take is no try: a failed move not due again says nothing and keeps its hour', async () => {
    const t = legacyHome()
    mkdirSync(t.state, { recursive: true })
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    const failedLine = 'home move: failed target-exists · ~/.harness is as it was'
    expect(logOf(t)).toEqual([failedLine])
    // A process with no start time does not take the lock.
    const noStartTime = t.lockAs(9_999)
    t.clock.now += MINUTE
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps({ lock: noStartTime }))
    expect(logOf(t)).toEqual([failedLine])
    expect(readMoveRecord(t.home, {})).toMatchObject({ reason: 'target-exists', failedAt: NOW })
    // Due again, it is the try, and is said.
    t.clock.now += 60 * MINUTE
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps({ lock: noStartTime }))
    expect(logOf(t)).toEqual([failedLine, 'home move: failed io · ~/.harness is as it was'])
  })

  it('a failed move is tried again at once by harness start on a terminal, and by any other start an hour after the last try', async () => {
    const t = legacyHome()
    mkdirSync(t.state, { recursive: true })
    /** Whether a start at [minutes], on a terminal or not, tried the move: each try that fails logs its line. */
    const tries = async (minutes: number, args: string[], terminal = false): Promise<boolean> => {
      t.clock.now = NOW + minutes * MINUTE
      const before = logOf(t).length
      await moveHomeAtStart(argvOf(t, ...args), {}, t.deps({ print: terminal ? () => {} : null }))
      return logOf(t).length > before
    }
    expect(await tries(0, ['__harnessd'])).toBe(true)
    expect(await tries(59, ['__harnessd'])).toBe(false)
    expect(await tries(59, ['start', '--if-down'], true)).toBe(false)
    // Desktop's own harness start has no terminal: no person typed it.
    expect(await tries(59, ['start'])).toBe(false)
    expect(await tries(59, ['start'], true)).toBe(true)
    expect(await tries(60, ['start', '-f'], true)).toBe(true)
    expect(readMoveRecord(t.home, {})).toMatchObject({ state: 'failed', failedAt: NOW + 60 * MINUTE })
    // The hour counts from the last try, not the first.
    expect(await tries(119, ['__harnessd'])).toBe(false)
    expect(await tries(119, ['start'])).toBe(false)
    expect(await tries(121, ['start', '--if-down'])).toBe(true)
    expect(existsSync(t.data)).toBe(false)
  })

  it('a start that waited for another start\'s move resolves the roots again, and starts again from the new paths', async () => {
    const t = legacyHome()
    const other = heldByAnother(t)
    const waiting = moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
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

  it('two starts that read different XDG_STATE_HOME take the one lock: the second waits for the first', async () => {
    const t = legacyHome()
    // A socket in the data folder: the first start asks whether a daemon answers on it, and waits there for the answer.
    put(join(t.legacy, 'cli', 'data', 'daemon-1.sock'), '')
    let answer = (_answers: boolean): void => {}
    let asked = (): void => {}
    const firstAsked = new Promise<void>((done) => { asked = done })
    let watching = (): void => {}
    const secondWaits = new Promise<'waits'>((done) => { watching = () => done('waits') })
    // The fake watch, woken by the test: fs.watch on macOS (FSEvents) starts telling changes some time after it returns,
    // and may never tell the first start's release, which left the second to its look LOCK_LOOK_MS later.
    const lock = (pid: number, onWatch = (): void => {}): LockDeps => ({
      pid, startTime: (other) => other === SELF || other === OTHER ? 1 : null,
      watch: (folder, onChange) => {
        onWatch()
        return t.lockAs(pid).watch(folder, onChange)
      },
    })
    const first = moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps({
      lock: lock(SELF),
      answers: () => {
        asked()
        return new Promise<boolean>((done) => { answer = done })
      },
    }))
    await firstAsked
    const otherState = join(t.root, 'other-state')
    const second = moveHomeAtStart(argvOf(t, 'start', '--if-down'), { XDG_STATE_HOME: otherState }, t.deps({ lock: lock(OTHER, watching) }))
    expect(await Promise.race([second.then(() => 'went on'), secondWaits])).toBe('waits')
    answer(false)
    await first
    // Its release took the lock's folder away: a change beside the lock.
    t.wake()
    await second
    expect(readBridge(t.state)).toMatchObject({ oldHome: t.legacy })
    expect(existsSync(otherState)).toBe(false)
  })

  it('a start waits while the lock\'s owner lives and the data root is not there, says so once, and takes the lock of an owner killed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = legacyHome()
    const other = heldByAnother(t)
    let settled = false
    const waiting = moveHomeAtStart(argvOf(t, 'start'), {}, t.deps()).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
    expect(logOf(t)).toEqual(['home move: under way · waiting'])
    await vi.advanceTimersByTimeAsync(10 * LOCK_LOOK_MS)
    // A tree half moved is never started on.
    expect(settled).toBe(false)
    expect(logOf(t)).toEqual(['home move: under way · waiting'])
    expect(t.execs).toEqual([])
    // Killed: the next look finds its owner gone.
    other.dies()
    await vi.advanceTimersByTimeAsync(LOCK_LOOK_MS)
    await waiting
    expect(logOf(t)).toEqual(['home move: under way · waiting', moved(t)])
    expect(t.execs).toHaveLength(1)
  })

  it('a start that finds the data root there goes on while the lock\'s owner finishes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const t = legacyHome()
    heldByAnother(t)
    // The other start committed and still finishes: its journal is there.
    mkdirSync(join(t.data, 'cli', 'data'), { recursive: true })
    writeFileSync(markerOf(t), '1\n')
    openJournal({ version: 1, startedAt: NOW, plan: { home: t.home, legacy: t.legacy, data: t.data, state: t.state, entries: [] }, oldTag: 'a', newTag: 'b', done: [] }, disk)
    const start = moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(await Promise.race([start.then(() => 'went on'), new Promise((done) => setImmediate(done, 'waits'))])).toBe('went on')
    expect(existsSync(moveLockPath(t.legacy))).toBe(true)
    expect(logOf(t)).toEqual([])
  })

  it.each([
    ['before the data root\'s commit', (t: Home) => (from: string) => from === join(t.legacy, 'auth'), () => ['home move: failed io · ~/.harness is as it was']],
    ['after it', (t: Home) => (from: string) => from === `${t.data}.moving`, (t: Home) => [moved(t)]],
  ])('a start killed %s leaves its journal and its lock: the next start takes the lock over, recovers, and goes on', async (_, at, said) => {
    const t = legacyHome()
    const killedAt = at(t), image = `${t.root}.killed`
    roots.push(image)
    const io: StartDeps['io'] = {
      ...disk,
      renameSync: (from, to) => {
        fs.renameSync(from, to)
        if (!killedAt(String(from)) || existsSync(image)) return
        // What the disk holds when the process is killed, its lock still in place.
        fs.cpSync(t.root, image, { recursive: true, verbatimSymlinks: true })
        throw new Error('killed')
      },
    }
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps({ io }))
    rmSync(t.root, { recursive: true, force: true })
    fs.cpSync(image, t.root, { recursive: true, verbatimSymlinks: true })
    expect([readJournal(t.legacy), existsSync(moveLockPath(t.legacy))]).toEqual([expect.anything(), true])
    t.execs.length = 0

    t.procs.delete(SELF)
    t.procs.set(OTHER, 7)
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps({ lock: t.lockAs(OTHER) }))
    expect([readJournal(t.legacy), existsSync(moveLockPath(t.legacy))]).toEqual([null, false])
    expect(readFileSync(join(t.legacy, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(logOf(t)).toEqual(said(t))
    expect(t.execs).toHaveLength(existsSync(t.data) ? 1 : 0)
    expect(t.exits).toEqual([])
  })

  it('a ~/.harness beside the data root that is not the bridge is said once, and nothing in it is deleted', async () => {
    const t = legacyHome()
    mkdirSync(join(t.data, 'cli', 'data'), { recursive: true })
    writeFileSync(markerOf(t), '1\n')
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

  it('a start run from ~/.harness once it is the bridge starts again from the new paths, whoever moved it', async () => {
    const t = legacyHome()
    await moveHomeAtStart(argvOf(t, 'start'), {}, t.deps())
    t.execs.length = 0
    // A launcher the move did not rewrite still runs ~/.harness's Node and cli.js, through the bridge's links.
    await moveHomeAtStart(argvOf(t, '__harnessd'), {}, t.deps())
    expect(t.execs).toEqual([{ file: join(t.state, NODE), args: [join(t.state, NODE), join(t.data, 'cli', 'cli.js'), '__harnessd'], env: {} }])
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
