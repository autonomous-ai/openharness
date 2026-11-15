import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertTestRoot, endRootProcesses, lsofFolders, ownFolders, rootProcesses, workingFolders } from './rootProcesses.js'
import { alive, processTable, type ProcessRow } from './spawnedRuns.js'

const row = (pid: number, ppid: number, pgid: number, command: string): ProcessRow => ({ pid, ppid, pgid, command })
const ROOT = '/tmp/htmux-abc'
/** The caller is 50, started by 41, in the group 40 leads. */
const OWN = [row(40, 1, 40, 'node vitest'), row(41, 40, 40, 'node (vitest 1)'), row(50, 41, 40, 'node (vitest 2)')]

/** Asks [probe] every 50 ms until it answers, at most 10 s. */
async function until<T>(probe: () => T | null): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const found = probe()
    if (found !== null) return found
    if (Date.now() > deadline) throw new Error('timed out after 10000 ms')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('rootProcesses', () => {
  it('a match that leads a group gives the group, with the members that do not name the root', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abc/bin/codex app-server'), row(101, 100, 100, 'node /repo/cli/e2e/harness/fakeEngine.mjs app-server')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [100], pids: [], all: [100, 101] })
  })

  it('a match that leads no group is alone: a test\'s own tmux call is in the worker\'s group', () => {
    const table = [...OWN, row(60, 50, 40, 'tmux -S /tmp/htmux-abc/tmux-501/default list-panes')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [60], all: [60] })
  })

  it('never the caller, its parent, pid 1, or the caller\'s own group as a group', () => {
    const named = (pid: number, ppid: number, pgid: number) => row(pid, ppid, pgid, `node ${ROOT}/x`)
    expect(rootProcesses(ROOT, [named(1, 0, 1), named(40, 1, 40), named(41, 40, 40), named(50, 41, 40)], 50)).toEqual({ groups: [], pids: [40], all: [40] })
  })

  it('names nothing but a test root: an empty path, `/` or a TMPDIR would name other runs\' processes, or every one', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abc/bin/codex app-server'), row(110, 1, 110, 'node /x')]
    for (const root of ['', '/', '/tmp', 'htmux-abc', '/tmp/htmux-abc/bin']) {
      expect(() => rootProcesses(root, table, 50), root).toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${root}`)
    }
  })

  it('a root whose path begins another\'s is not that root, nor is the root named alone', () => {
    const table = [...OWN, row(100, 1, 100, 'node /tmp/htmux-abcd/bin/codex app-server'), row(110, 1, 110, 'rm -rf /tmp/htmux-abc')]
    expect(rootProcesses(ROOT, table, 50)).toEqual({ groups: [], pids: [], all: [] })
  })
})

// A real engine started by name in a tile names no root: `claude`, `claude --resume <id>`. Many were found on a
// developer's Mac, parented to pid 1, each with its working folder in a test's root (audit of 2026-11-15).
describe('a process whose working folder is in the root', () => {
  it('is the test\'s, alone or with the group it leads, though its command line names nothing', () => {
    const table = [...OWN, row(100, 1, 100, 'claude'), row(101, 100, 100, 'node mcp-server'), row(110, 1, 90, 'claude --resume 1'),
      row(120, 1, 120, 'sleep 600'), row(130, 1, 130, 'sleep 600'), row(140, 1, 140, 'sleep 600')]
    // 120 is in a root whose name begins this one's, 130 outside, 140 not known.
    const folders = new Map([[100, ROOT], [110, `${ROOT}/projects/a`], [120, `${ROOT}d/projects`], [130, '/tmp']])
    expect(rootProcesses(ROOT, table, 50, folders)).toEqual({ groups: [100], pids: [110], all: [100, 101, 110] })
  })

  it('is never the caller, its parent or pid 1', () => {
    const table = [row(1, 0, 1, 'launchd'), ...OWN]
    expect(rootProcesses(ROOT, table, 50, new Map([[1, ROOT], [40, ROOT], [41, ROOT], [50, `${ROOT}/x`]]))).toEqual({ groups: [], pids: [40], all: [40] })
  })

  it('is read from lsof\'s fields, and kept only for a process of this account', () => {
    const rows = lsofFolders(`p100\nu501\nfcwd\nn${ROOT}/a b\np200\nu0\nfcwd\nn${ROOT}\np300\nu501\nfcwd\nn/\n`)
    expect(rows).toEqual([{ pid: 100, uid: 501, folder: `${ROOT}/a b` }, { pid: 200, uid: 0, folder: ROOT }, { pid: 300, uid: 501, folder: '/' }])
    expect([...ownFolders(rows, 501)]).toEqual([[100, `${ROOT}/a b`], [300, '/']])
    // Another account's process in the root is judged by its command line alone.
    const table = [...OWN, row(100, 1, 100, 'sleep 600'), row(200, 1, 200, 'sleep 600')]
    expect(rootProcesses(ROOT, table, 50, ownFolders(rows, 501))).toEqual({ groups: [100], pids: [], all: [100] })
  })

  it('is read for this process, on this machine', () => {
    expect(workingFolders(processTable()).get(process.pid)).toBe(realpathSync(process.cwd()))
  })

  it.runIf(process.platform === 'darwin')('is unknown, said once, when lsof cannot run: the sweep then goes by command line', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('PATH', '/nowhere')
    try {
      expect(workingFolders([])).toEqual(new Map())
      expect(said.mock.calls).toEqual([[expect.stringMatching(/^\[e2e sweep\] no working folders read \(lsof: .+\): swept by command line alone$/)]])
    } finally { vi.unstubAllEnvs(); said.mockRestore() }
  })
})

describe('a test root', () => {
  let made: string[] = []
  afterEach(() => { for (const folder of made) rmSync(folder, { recursive: true, force: true }); made = [] })
  /** A temporary folder with a root in it, a home and a checkout beside them: all made up. */
  const places = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    made.push(base)
    for (const name of ['tmp/htmux-abc', 'home', 'repo/cli/src/testing']) mkdirSync(join(base, name), { recursive: true })
    return { base, root: join(base, 'tmp', 'htmux-abc'), at: { tmp: join(base, 'tmp'), home: join(base, 'home'), checkout: join(base, 'repo', 'cli', 'src', 'testing') } }
  }

  it('is a folder isolatedTmux made, given as its real path, there or already removed', () => {
    const { root, at } = places()
    expect(() => assertTestRoot(root, at)).not.toThrow()
    rmSync(root, { recursive: true })
    expect(() => assertTestRoot(root, at)).not.toThrow()
  })

  it('is nothing else: not a folder outside the temporary one or deeper in it, a link, the home, or what holds the checkout', () => {
    const { base, root, at } = places()
    mkdirSync(join(root, 'htmux-deeper'))
    symlinkSync(join(base, 'home'), join(at.tmp, 'htmux-link'))
    const refused = (path: string, where = at) => expect(() => assertTestRoot(path, where), path).toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
    for (const path of ['', '/', at.tmp, 'htmux-abc', join(at.tmp, 'htmux-'), join(at.tmp, 'other'), join(base, 'htmux-abc'), join(root, 'htmux-deeper'), join(at.tmp, 'htmux-link')]) refused(path)
    // A temporary folder that is the home's parent, or the checkout's: the root would be the home, or hold the checkout.
    refused(root, { ...at, home: root })
    refused(root, { ...at, checkout: join(root, 'repo', 'cli', 'src', 'testing') })
    // Given through a link to the temporary folder: not its real path.
    symlinkSync(at.tmp, join(base, 'tmp-link'))
    refused(join(base, 'tmp-link', 'htmux-abc'))
  })
})

describe('endRootProcesses', () => {
  let root: string | undefined
  let leader: ChildProcess | undefined
  let started: ChildProcess[] = []
  // Only what this spec started, by its own pids: other sessions run end-to-end daemons on this machine.
  afterEach(() => {
    if (leader?.pid) { try { process.kill(-leader.pid, 'SIGKILL') } catch { /* the group is gone */ } }
    for (const child of started) child.kill('SIGKILL')
    if (root) rmSync(root, { recursive: true, force: true })
    root = leader = undefined
    started = []
  })

  it('ends a group that left its parent and a process of the caller\'s own group, and nothing else', async () => {
    const dir = root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-'))), idle = 'setInterval(() => {}, 1 << 30)'
    // A group of its own whose child names nothing of the root, as `codex app-server` is started (lib/codexRateLimits.ts).
    const group = leader = spawn(process.execPath, ['-e', `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], { stdio: 'ignore' }); ${idle}`, join(dir, 'bin', 'codex')], { stdio: 'ignore', detached: true })
    // In this spec's own group, as a test's `tmux -S <root>/…` call is; and one under a root whose path begins this one's.
    const own = spawn(process.execPath, ['-e', idle, join(dir, 'own')], { stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', idle, `${dir}x/other`], { stdio: 'ignore' })
    started = [own, other]
    // Until each one runs its own command line: a process not yet past its exec still shows this worker's.
    const members = await until(() => {
      const table = processTable()
      const rows = table.filter((each) => each.pgid === group.pid)
      const running = (pid: number | undefined, path: string) => table.some((each) => each.pid === pid && each.command.includes(path))
      return rows.length === 2 && running(own.pid, join(dir, 'own')) && running(other.pid, `${dir}x/other`) ? rows.map((each) => each.pid) : null
    })
    expect(await endRootProcesses(dir)).toEqual([])
    expect([...members, own.pid!].filter(alive)).toEqual([])
    expect(alive(other.pid!)).toBe(true)
  })

  it('ends a process left in the root whose command line names nothing, and none in a folder whose name begins the root\'s', async () => {
    const dir = root = realpathSync(mkdtempSync(join(tmpdir(), 'htmux-')))
    mkdirSync(join(dir, 'projects'))
    mkdirSync(`${dir}x`)
    const inside = spawn('sleep', ['600'], { cwd: join(dir, 'projects'), stdio: 'ignore' }), beside = spawn('sleep', ['600'], { cwd: `${dir}x`, stdio: 'ignore' })
    started = [inside, beside]
    await until(() => processTable().filter((each) => (each.pid === inside.pid || each.pid === beside.pid) && each.command === 'sleep 600').length === 2 || null)
    try {
      expect(await endRootProcesses(dir)).toEqual([])
      expect([alive(inside.pid!), alive(beside.pid!)]).toEqual([false, true])
      // A second close of the same daemon: the root is gone, and nothing is left to end.
      rmSync(dir, { recursive: true, force: true })
      expect(await endRootProcesses(dir)).toEqual([])
    } finally { rmSync(`${dir}x`, { recursive: true, force: true }) }
  })

  it('signals nothing, and says which, for a root that is not a test\'s', async () => {
    const outer = root = realpathSync(mkdtempSync(join(tmpdir(), 'root-guard-')))
    const link = join(realpathSync(tmpdir()), `htmux-link-${process.pid}`)
    mkdirSync(join(outer, 'htmux-abc'))
    symlinkSync(outer, link)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      for (const path of ['/', realpathSync(tmpdir()), outer, join(outer, 'htmux-abc'), link]) {
        await expect(endRootProcesses(path), path).rejects.toThrow(`not a test root (isolatedTmux's <tmp>/htmux-XXXXXX): ${path}`)
      }
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      rmSync(link, { force: true })
    }
  })
})
