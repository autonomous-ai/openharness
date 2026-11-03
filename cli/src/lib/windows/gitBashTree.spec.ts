import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessRow } from '../processTable.js'
import { endGitBashTree, msysTree, type GitBashTreeDeps } from './gitBashTree.js'

const row = (pid: number, parentPid: number, started: number): ProcessRow =>
  ({ pid, parentPid, executable: 'x.exe', startMarker: `w:${started}`, args: '' })

// The helper in a POSIX bash against a made-up /proc; Windows has no /bin/bash, and there the helper runs in the real Git
// Bash against its real /proc in gitBashTimeout.real.spec.ts (manual Windows workflow run 40772897725).
describe.skipIf(process.platform === 'win32')('msysTree', () => {
  let proc: string
  beforeEach(() => { proc = mkdtempSync(join(tmpdir(), 'msys-proc-')) })
  afterEach(() => { rmSync(proc, { recursive: true, force: true }) })

  /** A Git Bash /proc entry: its own pid, its parent's (Git Bash numbering both) and its Windows pid. */
  const entry = (pid: number, ppid: number, winpid?: number): void => {
    mkdirSync(join(proc, String(pid)))
    writeFileSync(join(proc, String(pid), 'ppid'), `${ppid}\n`)
    if (winpid !== undefined) writeFileSync(join(proc, String(pid), 'winpid'), `${winpid}\n`)
  }

  it('lists the Windows pids of the run\'s Git Bash tree from its own parent records, nearest first', async () => {
    // Windows' parent links break where Git Bash starts a program (the sleep's parent there is a process that has
    // gone); Git Bash's own records keep them, so its tree is read there.
    entry(10, 1, 1010) // the run's bash, started by the launcher (Windows pid 1000)
    entry(11, 10, 1011)
    entry(13, 10, 1013)
    entry(12, 11, 1012)
    entry(20, 1, 2020) // someone else's
    entry(21, 20, 2021)
    entry(14, 12) // no Windows pid to read: left out
    expect(await msysTree('/bin/bash', [1000, 1010], proc)).toEqual([1010, 1011, 1013, 1012])
  })

  it('is empty when no Git Bash process is the run\'s, and null when the helper cannot run or does not finish', async () => {
    entry(20, 1, 2020)
    expect(await msysTree('/bin/bash', [1000], proc)).toEqual([])
    expect(await msysTree(join(proc, 'no-such-bash'), [1000], proc)).toBeNull()
    const slow = join(proc, 'slow-bash')
    writeFileSync(slow, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const started = Date.now()
    expect(await msysTree(slow, [1000], proc, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('endGitBashTree', () => {
  // The launcher (100) started the run's bash (101), whose `sleep` (300) Windows shows under a parent that is gone
  // (999); the sleep started a native program (301). 400 is not the run's.
  // 50 is a pid Git Bash still lists but Windows has since given to an older process: started before the run did.
  const rows = [row(100, 1, 10), row(101, 100, 11), row(300, 999, 20), row(301, 300, 21), row(400, 1, 30), row(50, 1, 5)]

  function deps(msys: number[] | null): GitBashTreeDeps & { killed: number[]; reads: number; asked: number[][]; logs: string[] } {
    const gone = new Set<number>()
    const d = {
      killed: [] as number[],
      reads: 0,
      asked: [] as number[][],
      logs: [] as string[],
      log: (line: string) => { d.logs.push(line) },
      self: 1,
      rows: async () => { d.reads++; return rows },
      kill: (pid: number) => {
        if (gone.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
        gone.add(pid)
        d.killed.push(pid)
      },
      msysTree: async (near: number[]) => { d.asked.push(near); return msys },
    }
    return d
  }

  it('ends every process of the run\'s Git Bash tree and what each started, the furthest first, the launcher last', async () => {
    const d = deps([101, 300])
    expect(await endGitBashTree(100, d)).toBe('sent')
    expect(d.asked).toEqual([[100, 101]])
    expect(d.killed).toEqual([301, 300, 101, 100])
    // One read of the table, before anything is ended: what is ended first must not hide what it started.
    expect(d.reads).toBe(1)
  })

  it('ends no process that is not the one Git Bash listed: one Windows does not show, or one older than the run', async () => {
    const d = deps([101, 50, 777, 300])
    await endGitBashTree(100, d)
    expect(d.killed).toEqual([301, 300, 101, 100])
  })

  it('when Git Bash\'s records cannot be read, says so and still ends the launcher\'s Windows tree, as before', async () => {
    const d = deps(null)
    expect(await endGitBashTree(100, d)).toBe('sent')
    expect(d.killed).toEqual([101, 100])
    expect(d.logs).toEqual(["[dsh] could not list Git Bash's processes under pid 100; ending its Windows tree only"])
    const none = deps([])
    await endGitBashTree(100, none)
    expect(none.logs).toEqual([])
  })
})
