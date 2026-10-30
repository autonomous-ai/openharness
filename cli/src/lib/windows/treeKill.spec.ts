import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../processTable.js'
import {
  TREE_MAX_DEPTH, TREE_MAX_PROCESSES, endProcessTree, processTreeKillDeps, windowsStartTime, type TreeKillDeps,
} from './treeKill.js'

const SELF = 4000

/** A host row: [pid] under [parentPid], started at FILETIME [start] (`w:<start>`, as pty/src/ps.rs writes it). */
const row = (pid: number, parentPid: number, start: number | string): ProcessRow => ({
  pid, parentPid, executable: 'x.exe', args: 'x.exe', startMarker: typeof start === 'string' ? start : `w:${start}`,
})

const errno = (code: string) => Object.assign(new Error(code), { code })

/** Deps over [rows], whose `kill` records each pid and throws [fails]' error for it. */
function deps(rows: ProcessRow[] | null, fails: Record<number, Error> = {}) {
  const killed: number[] = []
  const read = vi.fn(async () => rows)
  const given: TreeKillDeps = {
    rows: read,
    kill: (pid) => {
      killed.push(pid)
      if (fails[pid]) throw fails[pid]
    },
    self: SELF,
  }
  return { deps: given, killed, read }
}

describe('windowsStartTime', () => {
  it('reads a Windows marker as its FILETIME, exactly (past 2^53), and nothing else as one', () => {
    expect(windowsStartTime('w:133')).toBe(133n)
    expect(windowsStartTime('w:134012345678901234')).toBe(134012345678901234n)
    for (const marker of ['', 'w:', 'w:-1', 'w:1.5', 'Thu Jul 30 10:00:00 2026', '133', 'w:12a']) expect(windowsStartTime(marker)).toBeNull()
  })
})

describe('endProcessTree', () => {
  it('never ends the daemon, nor a pid that cannot be one, and reads nothing for them', async () => {
    const { deps: d, killed, read } = deps([row(SELF, 1, 10)])
    for (const pid of [SELF, 0, -1, 1.5, Number.NaN, 2 ** 53]) expect(await endProcessTree(pid, d)).toBe('failed')
    expect(killed).toEqual([])
    expect(read).not.toHaveBeenCalled()
  })

  it('ends the leaves first, then their parents, then the root, reading the table once', async () => {
    // 900 ─┬─ 901 ── 903 ── 904
    //      └─ 902
    // 950 is another tree, and 4 the host above the root: neither is touched.
    const rows = [row(4, 1, 50), row(900, 4, 100), row(901, 900, 110), row(902, 900, 120), row(903, 901, 130), row(904, 903, 140), row(950, 4, 105)]
    const { deps: d, killed, read } = deps(rows)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([904, 903, 901, 902, 900])
    expect(read).toHaveBeenCalledOnce()
  })

  it('takes a child started in the same tick as its parent, never one started before it (a reused parent pid)', async () => {
    // 700 started before the root: its parentPid 900 names the process that had that pid before, not the root.
    // 701 is that unrelated process's child, and must not be reached through it either.
    const rows = [row(900, 4, 100), row(901, 900, 100), row(700, 900, 99), row(701, 700, 150)]
    const { deps: d, killed } = deps(rows)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([901, 900])
  })

  it('leaves out a child whose marker, or whose parent\'s, is no Windows creation time: its order cannot be read', async () => {
    const rows = [row(900, 4, 100), row(901, 900, 'Thu Jul 30 10:00:00 2026'), row(902, 901, 200), row(903, 900, 110)]
    const { deps: d, killed } = deps(rows)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([903, 900])
    // The root's own marker unreadable: none of its children can be ordered after it.
    const odd = deps([row(900, 4, 'odd'), row(901, 900, 110)])
    expect(await endProcessTree(900, odd.deps)).toBe('sent')
    expect(odd.killed).toEqual([900])
  })

  it('never ends the daemon, nor pid 0, found under the root', async () => {
    const rows = [row(900, 4, 100), row(SELF, 900, 110), row(0, 900, 120), row(901, 900, 130)]
    const { deps: d, killed } = deps(rows)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([901, 900])
  })

  it('ends a root the table does not list, alone', async () => {
    const { deps: d, killed } = deps([row(901, 900, 110)])
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([900])
  })

  it('reads the root\'s outcome: gone when it was not there, failed on any other error', async () => {
    expect(await endProcessTree(900, deps([row(900, 4, 100)], { 900: errno('ESRCH') }).deps)).toBe('gone')
    expect(await endProcessTree(900, deps([row(900, 4, 100)], { 900: errno('EPERM') }).deps)).toBe('failed')
    expect(await endProcessTree(900, deps([row(900, 4, 100)], { 900: new Error('no code') }).deps)).toBe('failed')
  })

  it('goes on past a descendant that is gone or would not end, and still ends the root', async () => {
    const rows = [row(900, 4, 100), row(901, 900, 110), row(902, 900, 120), row(903, 900, 130)]
    const { deps: d, killed } = deps(rows, { 901: errno('ESRCH'), 902: errno('EPERM') })
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([901, 902, 903, 900])
  })

  it('ends the root alone when the table cannot be read, or the read throws', async () => {
    const { deps: d, killed } = deps(null)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([900])
    const thrown = deps(null)
    thrown.deps.rows = async () => { throw new Error('host gone') }
    expect(await endProcessTree(900, thrown.deps)).toBe('sent')
    expect(thrown.killed).toEqual([900])
    expect(await endProcessTree(900, deps(null, { 900: errno('ESRCH') }).deps)).toBe('gone')
  })

  it('ends a cycle in the parent links once each, and stops', async () => {
    // Markers that could never be (each equal), so the start order does not break the cycle: the walk must.
    const rows = [row(900, 902, 100), row(901, 900, 100), row(902, 901, 100), row(903, 903, 100)]
    const { deps: d, killed } = deps(rows)
    expect(await endProcessTree(900, d)).toBe('sent')
    expect(killed).toEqual([902, 901, 900])
  })

  it('stops at its bounds: so deep, and so many', async () => {
    // A chain deeper than the bound: the processes past it are not reached.
    const chain = [row(1000, 4, 100), ...Array.from({ length: TREE_MAX_DEPTH + 5 }, (_, i) => row(1001 + i, 1000 + i, 101 + i))]
    const deep = deps(chain)
    expect(await endProcessTree(1000, deep.deps)).toBe('sent')
    expect(deep.killed).toHaveLength(TREE_MAX_DEPTH + 1)
    expect(deep.killed[0]).toBe(1000 + TREE_MAX_DEPTH)
    expect(deep.killed.at(-1)).toBe(1000)
    // A root with more children than the bound: the bound's worth, then the root.
    const wide = deps([row(1000, 4, 100), ...Array.from({ length: TREE_MAX_PROCESSES + 5 }, (_, i) => row(2000 + i, 1000, 101))])
    expect(await endProcessTree(1000, wide.deps)).toBe('sent')
    expect(wide.killed).toHaveLength(TREE_MAX_PROCESSES + 1)
    expect(wide.killed.at(-1)).toBe(1000)
  })
})

describe('processTreeKillDeps', () => {
  afterEach(() => vi.restoreAllMocks())

  it('reads the connected host\'s table, ends with TerminateProcess (process.kill SIGKILL), and is this process', async () => {
    const call = vi.fn(async () => ({ state: 'ok' as const, value: { rows: [row(900, 4, 100)] } }))
    const d = processTreeKillDeps({ call } as never)
    expect(d.self).toBe(process.pid)
    expect(await d.rows()).toEqual([row(900, 4, 100)])
    expect(call).toHaveBeenCalledWith({ op: 'processes' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    d.kill(900)
    expect(kill).toHaveBeenCalledExactlyOnceWith(900, 'SIGKILL')
    kill.mockImplementation(() => { throw errno('ESRCH') })
    expect(() => d.kill(900)).toThrow('ESRCH')
  })
})
