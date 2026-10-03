import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { claudeProvider, readClaudeHead } from './claude.js'
import { scanMemo } from './support.js'
import { type ProcessView, UNSETTLED } from './types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'externals-claude-'))
  dirs.push(dir)
  return dir
}
function write(path: string, lines: unknown[]): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  return path
}
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const line = (sessionId: string, entrypoint: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', sessionId, cwd: '/work/dial', entrypoint, timestamp: '2026-09-20T10:00:00Z',
  message: { role: 'user', content: 'fix the dial scroll' }, ...extra,
})
const view = (alive: (pid: number) => boolean): ProcessView => ({
  list: async () => [], openFiles: async () => new Map(), openFilesOf: async () => new Map(), alive,
})

describe('readClaudeHead', () => {
  it('reads a terminal or the Claude app, never a program, a sub-agent or a line it cannot trust', async () => {
    const dir = home()
    const file = (name: string, lines: unknown[]) => write(join(dir, `${name}.jsonl`), lines)
    // The first lines may carry no entrypoint: a mode, a title, a line being written.
    expect(await readClaudeHead(file('t', [{ type: 'permission-mode' }, '{"entrypoint": half', line(A, 'cli')])))
      .toEqual({ sessionId: A, cwd: '/work/dial', origin: 'terminal' })
    expect(await readClaudeHead(file('d', [line(A, 'claude-desktop')]))).toMatchObject({ origin: 'claude-app' })
    expect(await readClaudeHead(file('s', [line(A, 'sdk-cli')]))).toBeNull()
    expect(await readClaudeHead(file('x', [line(A, 'cli', { isSidechain: true })]))).toBeNull()
    expect(await readClaudeHead(file('r', [line(A, 'cli', { cwd: 'relative/path' })]))).toBeNull()
    expect(await readClaudeHead(file('i', [line('short', 'cli')]))).toBeNull()
    // No line says yet: Claude may still be writing it, so it is not judged — unless the file is too
    // long for that.
    expect(await readClaudeHead(file('n', ['["entrypoint"]']))).toBe(UNSETTLED)
    expect(await readClaudeHead(file('e', [{ type: 'summary', summary: 'nothing else' }]))).toBe(UNSETTLED)
    // Past every window without one: not a conversation, for good.
    expect(await readClaudeHead(file('big', [{ type: 'summary', summary: 'x'.repeat(3000) }]), [1024, 2048])).toBeNull()
    // A first prompt with a pasted image runs past the first window: the next, wider one reads it.
    const pasted = line(A, 'cli', { message: { role: 'user', content: [{ type: 'image', source: { data: 'i'.repeat(300 * 1024) } }] } })
    expect(await readClaudeHead(file('pasted', [{ type: 'permission-mode' }, pasted]))).toEqual({ sessionId: A, cwd: '/work/dial', origin: 'terminal' })
  })
})

describe('claudeProvider', () => {
  it("finds a project's own conversations, not a sub-agent's, and not Harness's own byproducts", async () => {
    const root = home()
    const projects = join(root, 'projects')
    write(join(projects, '-work-dial', `${A}.jsonl`), [line(A, 'cli')])
    write(join(projects, '-work-dial', `${B}.jsonl`), [line(B, 'cli', { cwd: '/data/harness/summary-scratch' })])
    write(join(projects, '-work-dial', 'notes.txt'), ['not a transcript'])
    write(join(projects, '-work-dial', A, 'subagents', 'agent-1.jsonl'), [line(A, 'cli')])
    writeFileSync(join(projects, 'stray-file'), '')
    mkdirSync(join(projects, '-work-dial', 'odd.jsonl'))
    symlinkSync(join(root, 'nowhere.jsonl'), join(projects, '-work-dial', 'broken.jsonl'))
    const provider = claudeProvider({ projectsDir: projects, home: root })
    const memo = scanMemo({ excluded: ['/data/harness'] })
    const found = await provider.scan(memo.context())
    expect(found).toEqual([expect.objectContaining({
      sessionId: A, engine: 'claude', cwd: '/work/dial', origin: 'terminal', title: '',
      transcriptPath: join(projects, '-work-dial', `${A}.jsonl`),
    })])
    expect(found[0].mtime).toBeGreaterThan(0)
    // Nothing where nothing is.
    expect(await claudeProvider({ projectsDir: join(root, 'none'), home: root }).scan(memo.context())).toEqual([])
  })

  it('finds a conversation it first saw half-written once Claude has written its first lines', async () => {
    const root = home()
    const projects = join(root, 'projects')
    const path = write(join(projects, '-work-dial', `${B}.jsonl`), [{ type: 'permission-mode' }])
    const provider = claudeProvider({ projectsDir: projects, home: root })
    const memo = scanMemo()
    expect(await provider.scan(memo.context())).toEqual([])
    write(path, [{ type: 'permission-mode' }, line(B, 'cli')])
    expect((await provider.scan(memo.context())).map((s) => s.sessionId)).toEqual([B])
  })

  it('knows its owners from their live process records, and whether they are between turns', async () => {
    const root = home()
    const started = Date.parse('2026-09-27T10:00:00Z')
    write(join(root, 'sessions', '101.json'), [{ pid: 101, sessionId: A, status: 'busy', startedAt: started + 400 }])
    write(join(root, 'sessions', '102.json'), [{ pid: 102, sessionId: B, status: 'idle' }])
    // A crashed Claude's record, its pid now a shell's, and one now a later Claude's.
    write(join(root, 'sessions', '107.json'), [{ pid: 107, sessionId: 'reused-by-a-shell', startedAt: started }])
    write(join(root, 'sessions', '108.json'), [{ pid: 108, sessionId: 'reused-by-claude', startedAt: started }])
    // Alive, but gone from the process list by the time it was read.
    write(join(root, 'sessions', '109.json'), [{ pid: 109, sessionId: 'unlisted' }])
    write(join(root, 'sessions', '103.json'), [{ pid: 103, sessionId: B }])
    write(join(root, 'sessions', '104.json'), ['{ being written'])
    write(join(root, 'sessions', '105.json'), [{ pid: '105', sessionId: B }])
    write(join(root, 'sessions', '106.json'), [{ pid: 106 }])
    write(join(root, 'sessions', 'notes.txt'), ['x'])
    mkdirSync(join(root, 'sessions', 'dir.json'))
    const provider = claudeProvider({ projectsDir: join(root, 'projects'), home: root })
    const running = [
      { pid: 101, ppid: 1, executable: 'claude', args: 'claude --resume x', started },
      { pid: 102, ppid: 1, executable: 'claude', args: 'claude' },
      { pid: 106, ppid: 1, executable: 'claude', args: 'claude', started },
      { pid: 107, ppid: 1, executable: '-zsh', args: '-zsh', started: started + 60_000 },
      { pid: 108, ppid: 1, executable: 'claude', args: 'claude', started: started + 60_000 },
    ]
    const claims = await provider.owners!({ ...view((pid) => [101, 102, 106, 107, 108, 109].includes(pid)), list: async () => running })
    expect(claims.sort((a, b) => a.pid - b.pid)).toEqual([
      { sessionId: A, pid: 101, record: join(root, 'sessions', '101.json') },
      { sessionId: B, pid: 102, record: join(root, 'sessions', '102.json') },
    ])
    expect(await provider.busy!({ pid: 101, record: join(root, 'sessions', '101.json') })).toBe(true)
    expect(await provider.busy!({ pid: 102, record: join(root, 'sessions', '102.json') })).toBe(false)
    // No records at all: nothing is open, and no process is looked at.
    let looked = false
    expect(await claudeProvider({ projectsDir: join(root, 'projects'), home: join(root, 'none') })
      .owners!({ ...view(() => true), list: async () => { looked = true; return [] } })).toEqual([])
    expect(looked).toBe(false)
    // The record gone is the process gone: not mid-turn.
    expect(await provider.busy!({ pid: 9, record: join(root, 'sessions', 'gone.json') })).toBe(false)
  })
})
