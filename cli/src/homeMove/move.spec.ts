/**
 * The move's run (docs/plans/2026-11-18-linux-xdg-paths-design.md, The move, Rollback, Recovery after a crash), on a
 * real home: every step in order, a failure at each one undone, a crash after each one finished or undone.
 */
import * as fs from 'node:fs'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HARNESS_ENTRIES } from '../config/harnessHome.js'
import { createHomeAdopter, readAdoptedHomes } from '../engines/kit/homeAdoption.js'
import { systemdUnit } from '../harnessd/platform.js'
import { harnessPaneOwner } from '../lib/harnessSessionLabel.js'
import { isBridge, readBridge } from './bridge.js'
import { checkMove, type ConditionDeps, type MoveCheck, type Reason } from './conditions.js'
import { readJournal, type Journal } from './journal.js'
import { recoverMove, runMove, type MoveDeps } from './move.js'
import { defaultTmux } from './panes.js'
import type { MoveEntry, MovePlan } from './plan.js'
import { readMoveRecord } from './record.js'

type Io = MoveDeps['io']

// node:fs with no flush to the device: what a power cut keeps is journal.ts's to test, and here a flush only slows each step.
const disk: Io = { ...fs, fsyncSync: () => {} }

const NOW = 1_763_000_000_000
const PROC_NOW = 1_763_000_000
const NODE = 'runtime/node-v24.11.1-linux-x64/bin/node'
const OTHER_TAG = 'aaaaaaaaaaaaaaaa'
const UNKNOWN = 'notes'
const ENTRIES = Object.keys(HARNESS_ENTRIES).length + 1
const asRoot = process.getuid?.() === 0

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    // The cases that take write permission away give it back, so the folder can go.
    for (const folder of [join('h', '.local', 'bin'), join('h', '.local', 'share')]) {
      try { chmodSync(join(root, folder), 0o755) } catch { /* not made */ }
    }
    for (const image of ['', '.crash', '.pristine']) rmSync(`${root}${image}`, { recursive: true, force: true })
  }
})

function fresh(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'move-run-')))
  roots.push(root)
  return root
}

function put(path: string, text: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, text, { mode })
  chmodSync(path, mode)
}

const failure = (code: string): Error => Object.assign(new Error(code), { code })
const mode = (path: string): number => lstatSync(path).mode & 0o7777
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

interface Home {
  root: string; home: string; legacy: string; env: NodeJS.ProcessEnv; binDir: string; unitFile: string
  plan: MovePlan; check: Extract<MoveCheck, { move: true }>; conditions: ConditionDeps
  /** Each pane's tag on the fake tmux server, by its id. */
  panes: Map<string, string>
  /** Every systemctl call. */
  systemctl: string[][]
  logs: string[]
  /** How many daemon-reloads fail, from the next; the next retag of this pane fails. */
  fail: { reloads: number; pane: string | null }
  deps(over?: Partial<MoveDeps>): MoveDeps
}

/**
 * A ~/.harness from before the move: every table entry and one it does not know, `auth/session.json` and `computer-id`
 * with known bytes, 600 files in 700 folders, records that name the tree, a sealed engine-home pool; the launcher and
 * the systemd unit outside it; two panes tagged by its daemon and one by another, on tmux 3.4.
 */
async function legacyHome({ env: envOf = () => ({}), bases = true, absent = [] }: { env?: (root: string) => NodeJS.ProcessEnv; bases?: boolean; absent?: string[] } = {}): Promise<Home> {
  const root = fresh(), env = envOf(root)
  const home = join(root, 'h'), legacy = join(home, '.harness')
  const at = (...rest: string[]): string => join(legacy, ...rest)
  for (const name of [...Object.keys(HARNESS_ENTRIES), UNKNOWN].filter((name) => !absent.includes(name))) {
    if (name === 'computer-id') put(at(name), 'c0ffee-machine', 0o600)
    else put(at(name, 'keep'), `${name}\n`, 0o644)
  }
  put(at('auth', 'session.json'), '{"token":"t-1"}')
  put(at(NODE), '#!/bin/sh\n', 0o755)
  put(at('runtime', 'current-node'), `${at(NODE)}\n`, 0o644)
  put(at('cli', 'cli.js'), '// harness\n', 0o644)
  put(at('cli', 'data', 'registry.json'), JSON.stringify([{ id: 'a1', claudeHome: at('claude-profiles', 'work'), cwd: '/srv/app' }]))
  const engineHomes = at('cli', 'data', 'engine-homes.json')
  put(engineHomes, JSON.stringify({ claude: [at('claude-profiles', 'work')], codex: [] }))
  createHomeAdopter(engineHomes).adopt({ claude: ['/elsewhere/.claude'], codex: [at('claude-profiles', 'codex-work')] })

  const dataDir = env.ADAPTER_DATA_DIR || at('cli', 'data')
  const binDir = env.HARNESS_BIN_DIR || join(home, '.local', 'bin')
  put(join(binDir, 'harness'), `#!/bin/sh\nexec '${at(NODE)}' '${at('cli', 'cli.js')}' "$@"\n`, 0o755)
  const unitFile = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user', 'harnessd.service')
  put(unitFile, systemdUnit({ nodePath: at(NODE), scriptPath: at('cli', 'cli.js'), logFile: join(dataDir, 'harness.log'), home, env: {} }), 0o644)
  if (bases) for (const base of ['share', 'state']) mkdirSync(join(home, '.local', base), { recursive: true })

  const oldTag = harnessPaneOwner(dataDir)
  const panes = new Map([['%1', oldTag], ['%2', oldTag], ['%3', OTHER_TAG]])
  const fail: Home['fail'] = { reloads: 0, pane: null }
  const tmux = defaultTmux((args) => {
    if (args[0] === '-V') return { status: 0, stdout: 'tmux 3.4\n' }
    if (args[0] === 'list-panes') {
      const withId = args[3].startsWith('#{pane_id}|')
      return { status: 0, stdout: [...panes].map(([id, tag]) => withId ? `${id}|${tag}\n` : `${tag}\n`).join('') }
    }
    // set-option -p -t <pane> @harness_daemon <tag>
    if (fail.pane === args[3]) {
      fail.pane = null
      return { status: 1, stdout: '' }
    }
    panes.set(args[3], args[5])
    return { status: 0, stdout: '' }
  })
  const systemctl: string[][] = []
  const run = (command: string, args: string[]): { status: number | null } => {
    systemctl.push([command, ...args])
    if (fail.reloads === 0) return { status: 0 }
    fail.reloads -= 1
    return { status: 1 }
  }
  const logs: string[] = []
  const conditions: ConditionDeps = {
    platform: 'linux', home, env, hasExecve: true, fs, alive: () => false, answers: async () => false, tmux, ptyHostRuns: () => false,
  }
  const check = await checkMove(conditions)
  if (!check.move) throw new Error(`this home does not move: ${JSON.stringify(check.hold)}`)
  return {
    root, home, legacy, env, binDir, unitFile, plan: check.plan, check, conditions, panes, systemctl, logs, fail,
    deps: (over = {}) => ({ io: disk, tmux, run, now: () => NOW, procNow: () => PROC_NOW, log: (line) => logs.push(line), ...over }),
  }
}

/** Every path under the home's root, with its mode and its bytes or its link's text, and each pane's tag. */
function snapshot(t: Home): Record<string, string> {
  const seen: Record<string, string> = { tmux: JSON.stringify([...t.panes]) }
  const walk = (path: string): void => {
    const st = lstatSync(path)
    const what = st.isSymbolicLink() ? `-> ${readlinkSync(path)}` : st.isDirectory() ? 'folder' : readFileSync(path, 'utf8')
    seen[relative(t.root, path)] = `${(st.mode & 0o7777).toString(8)} ${what}`
    if (st.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name))
  }
  walk(t.root)
  return seen
}

/** The bytes of every file under [path]. */
function fileBytes(path: string): number {
  const st = lstatSync(path)
  if (st.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + fileBytes(join(path, name)), 0)
  return st.isFile() ? st.size : 0
}

/** The record a failed move leaves, taken out so what is left can be compared with what was. */
function failedRecord(t: Home): unknown {
  const record = readMoveRecord(t.home, t.env)
  rmSync(join(t.legacy, 'home-move.json'))
  return record
}

const entryNamed = (t: Home, name: string): MoveEntry => t.plan.entries.find((entry) => entry.name === name)!
const stagedData = (t: Home, name: string): string => join(entryNamed(t, 'cli').staged, 'data', name)

/** node:fs, with its first rename [when] picks failing with [code]. */
function failingRename(when: (from: string, to: string) => boolean, code = 'EIO'): Io {
  let failed = false
  return {
    ...disk,
    renameSync: (from, to) => {
      if (!failed && when(String(from), String(to))) {
        failed = true
        throw failure(code)
      }
      fs.renameSync(from, to)
    },
  }
}

/** node:fs where the staging folders are on another disk: an entry's first rename fails, and [during] runs after each copy. */
function acrossDisks(t: Home, during: (from: string, to: string) => void = () => {}): Io {
  const crossed = new Set<string>()
  return {
    ...disk,
    renameSync: (from, to) => {
      if (t.plan.entries.some((entry) => entry.from === from) && !crossed.has(String(from))) {
        crossed.add(String(from))
        throw failure('EXDEV')
      }
      fs.renameSync(from, to)
    },
    cpSync: (from, to, options) => {
      fs.cpSync(from, to, options)
      during(String(from), String(to))
    },
  }
}

/**
 * What the disk and the panes hold this instant, kept as [name]; the function returned puts it back, as often as it is
 * called. Taken during a move, it is what a crash then leaves the next start.
 */
function imageOf(t: Home, name: string): () => void {
  const image = `${t.root}.${name}`
  rmSync(image, { recursive: true, force: true })
  copyTree(t.root, image)
  const panes = [...t.panes]
  return () => {
    rmSync(t.root, { recursive: true, force: true })
    copyTree(image, t.root)
    t.panes.clear()
    for (const [id, tag] of panes) t.panes.set(id, tag)
  }
}

/** [from] copied to [to] as it is: cpSync keeps a file's mode, not a folder's (Node 24.3), which is set after. */
function copyTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  const walk = (path: string): void => {
    const st = lstatSync(join(from, path))
    if (!st.isDirectory()) return
    for (const name of readdirSync(join(from, path))) walk(join(path, name))
    chmodSync(join(to, path), st.mode & 0o7777)
  }
  walk('')
}

/** [io] that calls [written] once each journal write is done: its head's rename into place, and each step's line. */
function journalWrites(t: Home, io: Io, written: () => void): Io {
  const path = join(t.legacy, '.move.json'), lines = new Set<number>()
  return {
    ...io,
    openSync: ((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const fd = io.openSync(file, flags, mode)
      if (file === path) lines.add(fd)
      return fd
    }) as typeof fs.openSync,
    closeSync: (fd) => {
      io.closeSync(fd)
      if (lines.delete(fd)) written()
    },
    renameSync: (from, to) => {
      io.renameSync(from, to)
      if (to === path) written()
    },
  }
}

/** Runs the move and crashes it after the journal write [when] picks; returns the journal the crash left, null with no crash. */
async function crashAfter(t: Home, when: (write: number, journal: Journal) => boolean): Promise<Journal | null> {
  let writes = 0
  // Set in the io's call: typed by its initial value, it would read as never set.
  let crashed = null as { journal: Journal; restore: () => void } | null
  const io = journalWrites(t, disk, () => {
    if (crashed) return
    const journal = readJournal(t.legacy)!
    if (!when(writes++, journal)) return
    crashed = { journal, restore: imageOf(t, 'crash') }
    throw new Error('crash')
  })
  await runMove(t.check, t.env, t.deps({ io }))
  if (!crashed) return null
  crashed.restore()
  return crashed.journal
}

describe('the move', () => {
  it('an upgrade with data', async () => {
    const t = await legacyHome({ bases: false })
    const { plan, check } = t
    const outcome = await runMove(check, t.env, t.deps())
    expect(outcome).toEqual({ state: 'bridged', entries: ENTRIES, bytesCopied: 0, panes: 2 })

    // Every entry is in its root, and ~/.harness holds a link to each, but the two folders the bridge keeps real.
    for (const entry of plan.entries) {
      expect(existsSync(entry.to)).toBe(true)
      if (entry.name === 'hook-routes' || entry.name === 'connections') expect(lstatSync(entry.from).isDirectory()).toBe(true)
      else expect(readlinkSync(entry.from)).toBe(entry.to)
    }
    expect(readdirSync(t.legacy).sort()).toEqual(plan.entries.map((entry) => entry.name).sort())
    expect(isBridge(t.legacy)).toBe(true)
    expect(readFileSync(join(plan.data, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(readFileSync(join(plan.data, 'computer-id'), 'utf8')).toBe('c0ffee-machine')
    expect([mode(join(plan.data, 'auth')), mode(join(plan.data, 'auth', 'session.json')), mode(join(plan.data, 'computer-id'))]).toEqual([0o700, 0o600, 0o600])
    // XDG bases that were not there are made owner-only.
    expect([mode(join(t.home, '.local', 'share')), mode(join(t.home, '.local', 'state')), mode(plan.data), mode(plan.state)]).toEqual([0o700, 0o700, 0o700, 0o700])

    // What named the old tree names the new one, inside and out.
    expect(readFileSync(join(plan.state, 'runtime', 'current-node'), 'utf8')).toBe(`${plan.state}/${NODE}\n`)
    expect(json(join(plan.data, 'cli', 'data', 'registry.json'))).toEqual([{ id: 'a1', claudeHome: `${plan.data}/claude-profiles/work`, cwd: '/srv/app' }])
    const homes = readAdoptedHomes(join(plan.data, 'cli', 'data', 'engine-homes.json')).homes
    expect({ claude: new Set(homes.claude), codex: new Set(homes.codex) }).toEqual({
      claude: new Set([`${plan.data}/claude-profiles/work`, '/elsewhere/.claude']), codex: new Set([`${plan.data}/claude-profiles/codex-work`]),
    })
    expect(readdirSync(join(plan.data, 'cli', 'data')).filter((name) => name.endsWith('.before-move'))).toEqual([])
    expect(readFileSync(join(t.binDir, 'harness'), 'utf8')).toBe(`#!/bin/sh\nexec '${plan.state}/${NODE}' '${plan.data}/cli/cli.js' "$@"\n`)
    expect(readFileSync(t.unitFile, 'utf8')).toBe(systemdUnit({
      nodePath: `${plan.state}/${NODE}`, scriptPath: `${plan.data}/cli/cli.js`, logFile: `${plan.data}/cli/data/harness.log`, home: t.home, env: {},
    }))
    expect(t.systemctl).toEqual([['systemctl', '--user', 'daemon-reload']])
    expect([...t.panes]).toEqual([['%1', check.newTag], ['%2', check.newTag], ['%3', OTHER_TAG]])

    expect(readBridge(plan.state)).toEqual({
      version: 1, movedAt: PROC_NOW, oldHome: t.legacy, oldDataDir: join(t.legacy, 'cli', 'data'), oldTag: check.oldTag, newTag: check.newTag, panes: ['%1', '%2'],
    })
    expect(readMoveRecord(t.home, t.env)).toEqual({ version: 1, state: 'bridged', entries: ENTRIES, bytesCopied: 0, panes: 2, oldProcesses: 0, at: NOW })
    // The journal and the staging folders are gone.
    expect(readJournal(t.legacy)).toBeNull()
    expect([existsSync(`${plan.data}.moving`), existsSync(`${plan.state}.moving`)]).toEqual([false, false])
  })

  it('an entry the table does not know lands in data and is named in one log line', async () => {
    const t = await legacyHome()
    expect(entryNamed(t, UNKNOWN)).toMatchObject({ known: false, kind: 'data' })
    await runMove(t.check, t.env, t.deps())
    expect(readFileSync(join(t.plan.data, UNKNOWN, 'keep'), 'utf8')).toBe(`${UNKNOWN}\n`)
    expect(readlinkSync(join(t.legacy, UNKNOWN))).toBe(join(t.plan.data, UNKNOWN))
    expect(t.logs).toEqual([expect.stringContaining(UNKNOWN)])
  })

  it('an entry not there at the move gets its link too: an old process writing it late fails, and puts nothing in the bridge', async () => {
    const t = await legacyHome({ absent: ['logs', 'dsh'] })
    expect(await runMove(t.check, t.env, t.deps())).toMatchObject({ state: 'bridged', entries: ENTRIES - 2 })
    expect([readlinkSync(join(t.legacy, 'logs')), readlinkSync(join(t.legacy, 'dsh'))]).toEqual([join(t.plan.state, 'logs'), join(t.plan.data, 'dsh')])
    expect(isBridge(t.legacy)).toBe(true)
    expect(() => mkdirSync(join(t.legacy, 'logs', 'today'), { recursive: true })).toThrow()
    expect(isBridge(t.legacy)).toBe(true)
    expect(readMoveRecord(t.home, t.env)).toMatchObject({ entries: ENTRIES - 2 })
  })

  it('a failed move leaves no link for an entry that was not there', async () => {
    const t = await legacyHome({ absent: ['logs'] })
    const before = snapshot(t)
    expect(await runMove(t.check, t.env, t.deps({ io: failingRename((from) => from === `${t.plan.data}.moving`) }))).toEqual({ state: 'failed', reason: 'io' })
    failedRecord(t)
    expect(snapshot(t)).toEqual(before)
  })

  it('records it cannot read are left unchanged, and said in one line by count and kind, with no path or name', async () => {
    const t = await legacyHome()
    put(join(t.legacy, 'cli', 'data', 'claude-profiles.json'), '{ not json')
    for (const agent of ['agent-7f3a', 'agent-8e2b']) put(join(t.legacy, 'cli', 'data', 'stopped-agents', `${agent}.json`), '{ cut')
    expect(await runMove(t.check, t.env, t.deps())).toMatchObject({ state: 'bridged' })
    expect(t.logs.filter((line) => !line.includes(UNKNOWN))).toEqual(['home move: 3 records left unchanged · claude-profiles.json, stopped-agents'])
    expect(readFileSync(join(t.plan.data, 'cli', 'data', 'claude-profiles.json'), 'utf8')).toBe('{ not json')
  })

  it('a folder recreated at an old path mid-move is merged', async () => {
    const t = await legacyHome()
    const logs = entryNamed(t, 'logs'), auth = entryNamed(t, 'auth')
    const io: Io = {
      ...disk,
      renameSync: (from, to) => {
        fs.renameSync(from, to)
        // A hook that ran between the entry's rename and its link wrote its event offline, where the folder was.
        if (from === logs.from) put(join(logs.from, 'offline.json'), '{"event":1}')
        // One that ran once the link was in put a folder of its own in its place.
        if (to === stagedData(t, 'registry.json')) {
          unlinkSync(auth.from)
          put(join(auth.from, 'late.json'), '{"event":2}')
        }
      },
    }
    expect(await runMove(t.check, t.env, t.deps({ io }))).toMatchObject({ state: 'bridged' })
    expect(readFileSync(join(t.plan.state, 'logs', 'offline.json'), 'utf8')).toBe('{"event":1}')
    expect(readFileSync(join(t.plan.data, 'auth', 'late.json'), 'utf8')).toBe('{"event":2}')
    expect(readFileSync(join(t.plan.data, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect([readlinkSync(logs.from), readlinkSync(auth.from)]).toEqual([logs.to, auth.to])
    expect(isBridge(t.legacy)).toBe(true)
  })

  it('custom XDG folders', async () => {
    const t = await legacyHome({
      bases: false,
      env: (root) => ({ XDG_DATA_HOME: join(root, 'disk', 'my data'), XDG_STATE_HOME: join(root, 'disk', 'state'), XDG_CONFIG_HOME: join(root, 'config') }),
    })
    expect(t.plan).toMatchObject({ data: join(t.root, 'disk', 'my data', 'harness'), state: join(t.root, 'disk', 'state', 'harness') })
    expect(await runMove(t.check, t.env, t.deps())).toMatchObject({ state: 'bridged' })
    expect([readlinkSync(join(t.legacy, 'auth')), readlinkSync(join(t.legacy, 'logs'))]).toEqual([join(t.plan.data, 'auth'), join(t.plan.state, 'logs')])
    expect(readFileSync(join(t.plan.data, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(mode(join(t.root, 'disk', 'my data'))).toBe(0o700)
    // The unit in XDG_CONFIG_HOME carries the roots, so a daemon systemd starts finds them.
    expect(readFileSync(t.unitFile, 'utf8')).toContain(`Environment="XDG_DATA_HOME=${t.env.XDG_DATA_HOME}"`)
    expect(readMoveRecord(t.home, t.env)).toMatchObject({ state: 'bridged' })
  })

  it('an override elsewhere still wins', async () => {
    const t = await legacyHome({ env: (root) => ({ ADAPTER_DATA_DIR: join(root, 'elsewhere', 'data'), HARNESS_BIN_DIR: join(root, 'bin') }) })
    const dataDir = t.env.ADAPTER_DATA_DIR!
    put(join(dataDir, 'registry.json'), JSON.stringify([{ id: 'a1', claudeHome: join(t.legacy, 'claude-profiles', 'work') }]))
    expect(t.check.newTag).toBe(t.check.oldTag)
    expect(await runMove(t.check, t.env, t.deps())).toEqual({ state: 'bridged', entries: ENTRIES, bytesCopied: 0, panes: 0 })
    // Its folder stays, its records are rewritten where it is, and its panes keep their tag.
    expect(json(join(dataDir, 'registry.json'))).toEqual([{ id: 'a1', claudeHome: `${t.plan.data}/claude-profiles/work` }])
    expect([...t.panes.values()]).toEqual([t.check.oldTag, t.check.oldTag, OTHER_TAG])
    expect(readBridge(t.plan.state)).toMatchObject({ oldDataDir: dataDir, panes: [] })
    // The launcher where HARNESS_BIN_DIR put it.
    expect(readFileSync(join(t.binDir, 'harness'), 'utf8')).toContain(`'${t.plan.data}/cli/cli.js'`)
  })

  it('a run after success does nothing', async () => {
    const t = await legacyHome()
    await runMove(t.check, t.env, t.deps())
    const after = snapshot(t)
    expect(await checkMove(t.conditions)).toEqual({ move: false, hold: null })
    expect(await recoverMove(t.home, t.env, t.deps())).toBeNull()
    expect(snapshot(t)).toEqual(after)
  })
})

describe('a failed move', () => {
  const FAILURES: [string, Reason, (t: Home) => Partial<MoveDeps>][] = [
    ['the stage of the first entry', 'io', (t) => ({ io: failingRename((from) => from === t.plan.entries[0].from) })],
    ['the stage of a middle entry', 'io', (t) => ({ io: failingRename((from) => from === t.plan.entries[13].from) })],
    ['the stage of the last entry', 'io', (t) => ({ io: failingRename((from) => from === t.plan.entries.at(-1)!.from) })],
    ['the rewrite of a record inside', 'io', (t) => ({ io: failingRename((_, to) => to === stagedData(t, 'registry.json')) })],
    ['the engine-home reseal, after its pool is set aside', 'io', (t) => ({
      io: {
        ...disk,
        renameSync: (from, to) => {
          fs.renameSync(from, to)
          // A file where the new pool goes stops the reseal once the old pool's last name is aside.
          const file = stagedData(t, 'engine-homes.json')
          if (from === `${file}.confirmations`) writeFileSync(`${file}.adoptions`, 'not a folder')
        },
      },
    })],
    // Root writes anywhere: an unwritable folder fails nothing for it.
    ...asRoot ? [] : [['the rewrite outside', 'permission', (t: Home) => {
      chmodSync(t.binDir, 0o555)
      return {}
    }] as [string, Reason, (t: Home) => Partial<MoveDeps>]],
    ['the daemon-reload', 'io', (t) => {
      t.fail.reloads = 1
      return {}
    }],
    ['the retag of the panes', 'io', (t) => {
      t.fail.pane = '%2'
      return {}
    }],
    ['the commit of the state root', 'io', (t) => ({ io: failingRename((from) => from === `${t.plan.state}.moving`) })],
    ['the commit of the data root', 'io', (t) => ({ io: failingRename((from) => from === `${t.plan.data}.moving`) })],
  ]

  it.each(FAILURES)('a failure at %s rolls back to the exact tree', async (_, reason, inject) => {
    const t = await legacyHome()
    const deps = t.deps(inject(t))
    const before = snapshot(t)
    expect(await runMove(t.check, t.env, deps)).toEqual({ state: 'failed', reason })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason, failedAt: NOW })
    // The tree, the launcher and the unit, and the panes' tags, as they were.
    expect(snapshot(t)).toEqual(before)
  })

  it('a rollback that cannot undo a step keeps its journal, and the next start undoes the rest', async () => {
    const t = await legacyHome()
    const before = snapshot(t)
    // The daemon-reload fails in the move, and again in its rollback.
    t.fail.reloads = 2
    expect(await runMove(t.check, t.env, t.deps())).toEqual({ state: 'failed', reason: 'io' })
    expect(readJournal(t.legacy)).not.toBeNull()
    // A move undone is a move failed: recorded at the try that undid it.
    expect(await recoverMove(t.home, t.env, t.deps({ now: () => NOW + 1 }))).toEqual({ state: 'failed', reason: 'io' })
    expect(t.systemctl).toHaveLength(3)
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'io', failedAt: NOW + 1 })
    expect(snapshot(t)).toEqual(before)
  })

  it.skipIf(asRoot)('a pool the rollback cannot set back is set back by the next start, from where its entry went back', async () => {
    const t = await legacyHome()
    const before = snapshot(t)
    const reload = t.deps().run
    const sealed = `${stagedData(t, 'engine-homes.json')}.adoptions`, back = join(t.legacy, 'cli', 'data', 'engine-homes.json.adoptions')
    // Once the pool is sealed again it cannot be removed, and the daemon-reload after it fails.
    const run: MoveDeps['run'] = (command, args) => {
      chmodSync(sealed, 0o555)
      return reload(command, args)
    }
    t.fail.reloads = 1
    try {
      expect(await runMove(t.check, t.env, t.deps({ run }))).toEqual({ state: 'failed', reason: 'io' })
      expect(existsSync(`${back}.before-move`)).toBe(true)
    } finally {
      chmodSync(back, 0o700)
    }
    expect(await recoverMove(t.home, t.env, t.deps())).toEqual({ state: 'failed', reason: 'io' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'io' })
    expect(snapshot(t)).toEqual(before)
  })

  it.skipIf(asRoot)('an unwritable base fails with permission and leaves the tree as it was', async () => {
    const t = await legacyHome()
    chmodSync(join(t.home, '.local', 'share'), 0o555)
    const before = snapshot(t)
    expect(await runMove(t.check, t.env, t.deps())).toEqual({ state: 'failed', reason: 'permission' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'permission' })
    expect(snapshot(t)).toEqual(before)
  })

  it.each([
    ['a state root that is already there', (plan: MovePlan) => plan.state],
    ['a staging folder something left full', (plan: MovePlan) => `${plan.data}.moving`],
  ])('%s fails with target-exists', async (_, folder) => {
    const t = await legacyHome()
    put(join(folder(t.plan), 'somebody.txt'), 'theirs')
    const before = snapshot(t)
    expect(await runMove(t.check, t.env, t.deps())).toEqual({ state: 'failed', reason: 'target-exists' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'target-exists' })
    expect(snapshot(t)).toEqual(before)
  })

  it('a full disk fails with no-space', async () => {
    const t = await legacyHome()
    const third = t.plan.entries[2]
    const io: Io = { ...acrossDisks(t), cpSync: (from, to, options) => {
      if (from === third.from) throw failure('ENOSPC')
      fs.cpSync(from, to, options)
    } }
    const before = snapshot(t)
    expect(await runMove(t.check, t.env, t.deps({ io }))).toEqual({ state: 'failed', reason: 'no-space' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'no-space' })
    expect(snapshot(t)).toEqual(before)
  })
})

describe('across filesystems', () => {
  it('EXDEV on rename: a write during the copy is kept, bytesCopied counts, the originals go at the finish', async () => {
    const t = await legacyHome()
    const auth = entryNamed(t, 'auth'), late = 'written during the copy'
    const bytes = fileBytes(t.legacy) + late.length
    const io = acrossDisks(t, (from) => {
      if (from === auth.from) writeFileSync(join(auth.from, 'late.json'), late, { mode: 0o600 })
    })
    expect(await runMove(t.check, t.env, t.deps({ io, now: Date.now }))).toEqual({ state: 'bridged', entries: ENTRIES, bytesCopied: bytes, panes: 2 })
    expect(readFileSync(join(t.plan.data, 'auth', 'late.json'), 'utf8')).toBe(late)
    expect(readFileSync(join(t.plan.data, 'auth', 'session.json'), 'utf8')).toBe('{"token":"t-1"}')
    expect(existsSync(join(t.legacy, '.move-old'))).toBe(false)
    expect(isBridge(t.legacy)).toBe(true)
    expect(readMoveRecord(t.home, t.env)).toMatchObject({ state: 'bridged', bytesCopied: bytes })
  })

  it('a crash during a copy leaves the entry as it was', async () => {
    const t = await legacyHome()
    const before = snapshot(t)
    const auth = entryNamed(t, 'auth'), moving = `${t.plan.data}.moving`
    let restore = (): void => { throw new Error('the move never crashed') }
    const io: Io = {
      ...acrossDisks(t, (from, to) => {
        if (from !== auth.from) return
        // The copy cut off mid-file.
        writeFileSync(join(to, 'session.json'), '{"tok')
        restore = imageOf(t, 'crash')
        throw new Error('crash')
      }),
      // The data root's folders are on another device.
      lstatSync: ((path: fs.PathLike, options?: fs.StatSyncOptions) => {
        const st = fs.lstatSync(path, options)
        return st && String(path).startsWith(moving) ? Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.Stats, st, { dev: Number(st.dev) + 1 }) : st
      }) as typeof fs.lstatSync,
    }
    await runMove(t.check, t.env, t.deps({ io }))
    restore()
    expect(await recoverMove(t.home, t.env, t.deps())).toEqual({ state: 'failed', reason: 'io' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'io', failedAt: NOW })
    expect(snapshot(t)).toEqual(before)
  })
})

describe('recovery after a crash', () => {
  it('a crash at each step is finished or rolled back by the next start, and recovery run twice does its work once', async () => {
    const t = await legacyHome()
    const pristine = imageOf(t, 'pristine')
    const before = snapshot(t)
    let writes = 0
    const counting = journalWrites(t, disk, () => { writes += 1 })
    const moved = await runMove(t.check, t.env, t.deps({ io: counting }))
    const after = snapshot(t)
    const seen = { finished: 0, rolledBack: 0 }
    for (let k = 0; k < writes; k++) {
      pristine()
      const journal = await crashAfter(t, (write) => write === k)
      const step = `a crash after ${JSON.stringify(journal?.done.at(-1) ?? 'the journal')}`
      const committed = existsSync(t.plan.data)
      expect(await recoverMove(t.home, t.env, t.deps()), step).toEqual(committed ? moved : { state: 'failed', reason: 'io' })
      if (!committed) expect(failedRecord(t), step).toMatchObject({ state: 'failed', reason: 'io', failedAt: NOW })
      expect(snapshot(t), step).toEqual(committed ? after : before)
      expect(await recoverMove(t.home, t.env, t.deps()), step).toBeNull()
      expect(snapshot(t), step).toEqual(committed ? after : before)
      seen[committed ? 'finished' : 'rolledBack'] += 1
    }
    expect(seen.finished).toBeGreaterThan(0)
    expect(seen.rolledBack).toBeGreaterThan(seen.finished)
  })

  it('a crash after the state root\'s rename rolls back', async () => {
    const t = await legacyHome()
    const before = snapshot(t)
    await crashAfter(t, () => existsSync(t.plan.state) && !existsSync(t.plan.data))
    expect([existsSync(t.plan.state), existsSync(t.plan.data)]).toEqual([true, false])
    expect(await recoverMove(t.home, t.env, t.deps())).toEqual({ state: 'failed', reason: 'io' })
    expect(failedRecord(t)).toMatchObject({ state: 'failed', reason: 'io' })
    expect(snapshot(t)).toEqual(before)
  })
})
