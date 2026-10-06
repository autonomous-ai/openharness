import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { UNSETTLED } from './types.js'
import {
  absoluteFolder, entries, epochMs, fileStamp, firstLine, harnessTtys, listProcesses, parseLine, parseLsof, parseTtys,
  processAlive, processTtys, processView, readHead, readJson, readTail, readText, record, run, scanMemo, text, UUID,
  within,
} from './support.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'externals-support-'))
  dirs.push(dir)
  return dir
}

describe('reading files', () => {
  it('reads a head, a tail and a first line, and reads nothing from what is not there', async () => {
    const dir = home()
    const path = join(dir, 'a.jsonl')
    writeFileSync(path, 'first line\nsecond line\nthird')
    expect(await readHead(path, 5)).toBe('first')
    expect(await readTail(path, 5)).toBe('third')
    expect(await readTail(path, 1_000)).toBe('first line\nsecond line\nthird')
    expect(await firstLine(path, 1_000)).toBe('first line')
    // A first line longer than what is read is not a line.
    expect(await firstLine(path, 4)).toBeNull()
    expect(await readHead(join(dir, 'none'), 5)).toBe('')
    expect(await readTail(join(dir, 'none'), 5)).toBe('')
    expect(await firstLine(join(dir, 'none'), 5)).toBeNull()
  })

  it('lists a folder, and nothing for one that is missing', async () => {
    const dir = home()
    writeFileSync(join(dir, 'x'), '')
    expect((await entries(dir)).map((entry) => entry.name)).toEqual(['x'])
    expect(await entries(join(dir, 'none'))).toEqual([])
  })

  it('reads JSON files and lines, and says null for anything half-written', async () => {
    const dir = home()
    writeFileSync(join(dir, 'ok.json'), '{"a":1}')
    writeFileSync(join(dir, 'bad.json'), '{"a":')
    expect(await readJson(join(dir, 'ok.json'))).toEqual({ a: 1 })
    expect(await readJson(join(dir, 'bad.json'))).toBeNull()
    expect(await readJson(join(dir, 'none.json'))).toBeNull()
    expect(await readText(join(dir, 'ok.json'))).toBe('{"a":1}')
    expect(await readText(join(dir, 'none.json'))).toBe('')
    expect(parseLine('[1]')).toEqual([1])
    expect(parseLine('nope')).toBeNull()
  })

  it("stamps a file by size and time, and nothing that is not a file", async () => {
    const dir = home()
    const path = join(dir, 'f')
    writeFileSync(path, 'abc')
    const stamp = await fileStamp(path)
    expect(stamp?.stamp).toMatch(/^3:\d/)
    expect(stamp?.mtime).toBeGreaterThan(0)
    expect(await fileStamp(dir)).toBeNull()
    expect(await fileStamp(join(dir, 'none'))).toBeNull()
  })
})

describe('reading values', () => {
  it('takes strings, records, uuids and absolute folders only when they are what they say', () => {
    expect(text('a')).toBe('a')
    expect(text(1)).toBe('')
    expect(record({ a: 1 })).toEqual({ a: 1 })
    expect(record([1])).toBeNull()
    expect(record(null)).toBeNull()
    expect(record('x')).toBeNull()
    expect(UUID.test('11111111-2222-4333-8444-555555555555')).toBe(true)
    expect(UUID.test('not-a-uuid')).toBe(false)
    expect(absoluteFolder('/work')).toBe('/work')
    expect(absoluteFolder('work')).toBeNull()
    expect(absoluteFolder(3)).toBeNull()
  })

  it('reads a time in every unit the engines write', () => {
    const ms = Date.parse('2026-09-27T10:00:00Z')
    expect(epochMs(ms / 1000)).toBe(ms)
    expect(epochMs(ms / 1000 + 0.25)).toBe(ms + 250)
    expect(epochMs(ms)).toBe(ms)
    expect(epochMs(ms * 1000)).toBe(ms)
    expect(epochMs(ms * 1_000_000)).toBe(ms)
    expect(epochMs('2026-09-27T10:00:00Z')).toBe(ms)
    expect(epochMs(String(ms / 1000))).toBe(ms)
    expect(epochMs('no time')).toBeNull()
    expect(epochMs(0)).toBeNull()
    expect(epochMs(-5)).toBeNull()
    expect(epochMs(Number.NaN)).toBeNull()
    expect(epochMs(null)).toBeNull()
  })

  it('says whether a path is a folder or inside it', () => {
    expect(within('/a/b', '/a/b')).toBe(true)
    expect(within('/a/b', '/a/b/c/d')).toBe(true)
    expect(within('/a/b', '/a/bc')).toBe(false)
    expect(within('/a/b', '/a')).toBe(false)
  })
})

describe('scanMemo', () => {
  it('reads again only what changed, and forgets what a scan did not ask for', async () => {
    const memo = scanMemo({ excluded: ['/data/harness'] })
    let reads = 0
    const read = async () => ++reads
    const ctx = memo.context()
    expect(await ctx.memo('a', '1', read)).toBe(1)
    expect(await ctx.memo('a', '1', read)).toBe(1)
    expect(await ctx.memo('a', '2', read)).toBe(2)
    expect(await ctx.memo('b', '1', read)).toBe(3)
    memo.prune()
    // The next scan asks only for a: b is forgotten, and read again when asked.
    const next = memo.context()
    expect(await next.memo('a', '2', read)).toBe(2)
    memo.prune()
    expect(await memo.context().memo('b', '1', read)).toBe(4)
    expect(ctx.excluded('/data/harness/summary-scratch')).toBe(true)
    expect(ctx.excluded('/work')).toBe(false)
  })

  it("keeps a file's head for good once it can be judged, and reads it again until then", async () => {
    const memo = scanMemo()
    let reads = 0
    let answer: string | null | typeof UNSETTLED = UNSETTLED
    const read = async () => { reads++; return answer }
    const ctx = memo.context()
    expect(await ctx.head('f', '1', read)).toBeNull()
    expect(await ctx.head('f', '1', read)).toBeNull()
    expect(reads).toBe(1)
    answer = 'head'
    expect(await ctx.head('f', '2', read)).toBe('head')
    expect(await ctx.head('f', '3', read)).toBe('head')
    expect(reads).toBe(2)
    answer = null
    expect(await ctx.head('g', '1', read)).toBeNull()
    expect(await ctx.head('g', '2', read)).toBeNull()
    expect(reads).toBe(3)
    memo.prune()
    memo.prune()
    expect(await memo.context().head('g', '9', read)).toBeNull()
    expect(reads).toBe(4)
  })

  it('lets the daemon breathe every so often, and has sensible defaults', async () => {
    const ctx = scanMemo({ excluded: [], paceEvery: 2 }).context()
    await ctx.pace()
    await ctx.pace()
    const plain = scanMemo().context()
    expect(plain.excluded('/anything')).toBe(false)
    for (let i = 0; i < 64; i++) await plain.pace()
  })
})

describe('processes', () => {
  it('knows this process is alive, and one that cannot exist is not', () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(2 ** 22 + 7)).toBe(false)
  })

  it("runs a command and keeps what it printed, even when it fails", async () => {
    expect(await run('/bin/sh', ['-c', 'printf ok'], 5_000)).toBe('ok')
    expect(await run('/bin/sh', ['-c', 'printf partial; exit 1'], 5_000)).toBe('partial')
    expect(await run('/bin/sh', ['-c', 'exit 1'], 5_000)).toBeNull()
  })

  it('reads lsof and ps output', () => {
    expect(parseLsof('p10\nf3\nn/a\nn/b\np11\nn/c\nx\n')).toEqual(new Map([[10, ['/a', '/b']], [11, ['/c']]]))
    expect(parseLsof('n/orphan\np0\nn/zero\n')).toEqual(new Map())
    expect(parseTtys('  10 ttys003\n  11 ??\n  12 ?\n\n')).toEqual(new Map([
      [10, '/dev/ttys003'], [11, null], [12, null],
    ]))
  })

  it("asks the machine through one view, and reads each process's terminal", async () => {
    const calls: string[] = []
    const exec = async (command: string, args: readonly string[]) => {
      calls.push(`${command} ${args.join(' ')}`)
      return command === 'lsof' ? 'p7\nn/f\n' : '  7 ttys001\n'
    }
    let listed = 0
    const view = processView(exec, () => true, async () => { listed++; return [{ pid: 7, ppid: 1, executable: 'x', args: '' }] })
    expect(await view.list()).toHaveLength(1)
    await view.list()
    expect(listed).toBe(1)
    expect(await view.openFiles([7, 8])).toEqual(new Map([[7, ['/f']]]))
    expect(await view.openFiles([])).toEqual(new Map())
    expect(await view.openFilesOf(['codex', 'Codex'])).toEqual(new Map([[7, ['/f']]]))
    expect(await view.openFilesOf([])).toEqual(new Map())
    expect(view.alive(1)).toBe(true)
    expect(calls).toEqual([
      'lsof -n -P -Fpn -a -p 7,8',
      'lsof -n -P -Fpn -c codex -c Codex',
    ])
    expect(await processTtys([7], exec)).toEqual(new Map([[7, '/dev/ttys001']]))
    expect(await processTtys([], exec)).toEqual(new Map())
    const quiet = processView(async () => null)
    expect(await quiet.openFiles([1])).toEqual(new Map())
    expect(await quiet.openFilesOf(['x'])).toEqual(new Map())
    expect(await processTtys([1], async () => null)).toEqual(new Map())
  })

  it('lists the real machine: this very process is among them, with its own open files', async () => {
    const view = processView()
    const me = (await view.list()).find((row) => row.pid === process.pid)
    expect(me?.args).toContain('node')
    const dir = home()
    const held = join(dir, 'held.txt')
    writeFileSync(held, 'x')
    const { open } = await import('node:fs/promises')
    const handle = await open(held, 'r')
    try {
      const files = await view.openFiles([process.pid])
      expect((files.get(process.pid) ?? []).some((path) => path.endsWith('held.txt'))).toBe(true)
    } finally {
      await handle.close()
    }
    expect((await processTtys([process.pid])).has(process.pid)).toBe(true)
  })

  it('lists no processes when ps cannot be read, and each start time when it can be read', async () => {
    expect(await listProcesses(async () => null)).toEqual([])
    const row = { pid: 5, parentPid: 1, executable: 'grok', args: 'grok', startMarker: 'Sun Sep 27 09:05:03 2026' }
    expect(await listProcesses(async () => [row, { ...row, pid: 6, startMarker: 'soon' }])).toEqual([
      { pid: 5, ppid: 1, executable: 'grok', args: 'grok', started: Date.parse('Sun Sep 27 09:05:03 2026') },
      { pid: 6, ppid: 1, executable: 'grok', args: 'grok' },
    ])
  })

  it("knows Harness's own panes by their tmux session names, and by a daemon's tag wherever they moved", async () => {
    const out = '/dev/ttys001\tharness-claude-1\t\n/dev/ttys002\tmy-own\t\n\n/dev/ttys003\n'
      // A daemon's pane the person moved into a session of their own, and one another daemon tagged:
      // either way an agent, never a process a take-over stops.
      + '/dev/ttys004\tmy-claude-work\t0123456789abcdef\n/dev/ttys005\ttheirs\tfedcba9876543210\n'
    expect(await harnessTtys(async () => ({ stdout: out, failed: false, stderr: '' }))).toEqual(new Set(['/dev/ttys001', '/dev/ttys004', '/dev/ttys005']))
    // No server running: no panes of Harness's. Could not ask: nobody can say.
    expect(await harnessTtys(async () => ({ stdout: '', failed: true, stderr: 'no server running on /tmp/tmux-501/default' }))).toEqual(new Set())
    expect(await harnessTtys(async () => ({ stdout: '', failed: true, stderr: 'error connecting to /tmp/x (No such file or directory)' }))).toEqual(new Set())
    expect(await harnessTtys(async () => ({ stdout: '', failed: true, stderr: '' }))).toBeNull()
    // Before tmux 3.0 the tag rides the pane's start command (`paneOwnerFormat`), asked for as such.
    let asked: readonly string[] = []
    const old = '/dev/ttys006\tmy-claude-work\t/usr/bin/env HARNESS_DAEMON=0123456789abcdef\n/dev/ttys007\tmy-own\t\n'
    expect(await harnessTtys(async (_command, args) => { asked = args; return { stdout: old, failed: false, stderr: '' } }, false))
      .toEqual(new Set(['/dev/ttys006']))
    expect(asked.at(-1)).toContain('#{m:/usr/bin/env HARNESS_DAEMON=*,#{pane_start_command}}')
    // A real tmux answers one way or the other: a private one with no server, never the developer's own.
    vi.stubEnv('TMUX', undefined)
    vi.stubEnv('TMUX_PANE', undefined)
    vi.stubEnv('TMUX_TMPDIR', home())
    try {
      expect(await harnessTtys()).toEqual(new Set())
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reads entries through a symlinked folder too', async () => {
    const dir = home()
    mkdirSync(join(dir, 'real'))
    writeFileSync(join(dir, 'real', 'f'), '')
    symlinkSync(join(dir, 'real'), join(dir, 'link'))
    expect((await entries(join(dir, 'link'))).map((entry) => entry.name)).toEqual(['f'])
  })
})
