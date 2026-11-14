import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { endRootProcesses, rootProcesses } from './rootProcesses.js'
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
    const dir = root = mkdtempSync(join(tmpdir(), 'htmux-')), idle = 'setInterval(() => {}, 1 << 30)'
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
})
