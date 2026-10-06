import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { codexProvider, codexServer, codexTitles, codexTurnOpen, readCodexHead, rollouts } from './codex.js'
import { scanMemo } from './support.js'
import { type ProcessView, UNSETTLED } from './types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'externals-codex-'))
  dirs.push(dir)
  return dir
}
function write(path: string, lines: unknown[]): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n')
  return path
}
const C = '01a0c4ad-de5e-7000-8000-000000000001'
const D = '01a0c4ad-de5e-7000-8000-000000000002'
const meta = (id: string, source: unknown, originator = 'codex-tui', cwd: unknown = '/work/cohorts') => ({
  timestamp: '2026-09-20T10:00:00Z', type: 'session_meta',
  payload: { id, cwd, originator, source, base_instructions: 'x'.repeat(40_000) },
})
const event = (type: string) => ({ type: 'event_msg', payload: { type } })
const rolloutName = (id: string) => `rollout-2026-09-20T10-00-00-${id}.jsonl`

describe('readCodexHead', () => {
  it('reads the terminal, the Codex app and the editors, not scripts, sub-agents or a broken head', async () => {
    const dir = home()
    const file = (name: string, first: unknown) => write(join(dir, `${name}.jsonl`), [first, event('x')])
    // `meta` carries 40 KB of instructions: past the first window, found by the second.
    expect(await readCodexHead(file('cli', meta(C, 'cli')))).toEqual({ sessionId: C, cwd: '/work/cohorts', origin: 'terminal' })
    const short = { ...meta(C, 'cli'), payload: { ...meta(C, 'cli').payload, base_instructions: 'x' } }
    expect(await readCodexHead(file('short', short))).toMatchObject({ sessionId: C })
    expect(await readCodexHead(file('app', meta(C, 'vscode', 'Codex Desktop')))).toMatchObject({ origin: 'codex-app' })
    expect(await readCodexHead(file('ide', meta(C, 'vscode', 'codex_vscode')))).toMatchObject({ origin: 'editor' })
    expect(await readCodexHead(file('exec', meta(C, 'exec', 'codex_exec')))).toBeNull()
    expect(await readCodexHead(file('sub', meta(C, { subagent: { other: 'guardian' } })))).toBeNull()
    expect(await readCodexHead(file('cwd', meta(C, 'cli', 'codex-tui', 'relative')))).toBeNull()
    expect(await readCodexHead(file('id', meta('x', 'cli')))).toBeNull()
    expect(await readCodexHead(file('type', { type: 'other', payload: {} }))).toBeNull()
    expect(await readCodexHead(file('nopayload', { type: 'session_meta' }))).toBeNull()
    expect(await readCodexHead(file('garbage', 'not json'))).toBeNull()
    // No newline yet: the first line is still being written, and is not judged until it is done —
    // unless it is longer than any first line.
    const partial = join(dir, 'partial.jsonl')
    writeFileSync(partial, JSON.stringify(meta(C, 'cli')))
    expect(await readCodexHead(partial)).toBe(UNSETTLED)
    const endless = join(dir, 'endless.jsonl')
    writeFileSync(endless, 'x'.repeat(1024 * 1024 + 10))
    expect(await readCodexHead(endless)).toBeNull()
  })
})

describe('the rest of a Codex home', () => {
  it('reads thread names, the last one winning, and reads them again only when the file changes', async () => {
    const dir = home()
    const path = write(join(dir, 'session_index.jsonl'), [
      { id: C, thread_name: 'Old name' },
      { id: C, thread_name: 'Retention cohorts' },
      { id: D, thread_name: '   ' },
      { thread_name: 'no id' },
      'half a line',
    ])
    const memo = scanMemo()
    expect(await codexTitles(path, memo.context())).toEqual(new Map([[C, 'Retention cohorts']]))
    expect(await codexTitles(join(dir, 'none.jsonl'), memo.context())).toEqual(new Map())
  })

  it('finds rollouts at any date depth, not beyond, and nothing else', async () => {
    const dir = home()
    write(join(dir, '2026', '09', '20', rolloutName(C)), [meta(C, 'cli')])
    write(join(dir, '2026', '09', '20', 'notes.jsonl'), ['x'])
    write(join(dir, 'a', 'b', 'c', 'd', 'e', rolloutName(D)), [meta(D, 'cli')])
    expect(await rollouts(dir)).toEqual([join(dir, '2026', '09', '20', rolloutName(C))])
  })

  it("says a turn is running until its task_complete or turn_aborted, whatever was said", async () => {
    const dir = home()
    const talk = { type: 'response_item', payload: { type: 'message', content: [{ text: 'then "task_complete" arrives' }] } }
    const file = (name: string, lines: unknown[]) => write(join(dir, `${name}.jsonl`), [meta(C, 'cli'), ...lines])
    expect(await codexTurnOpen(file('ended', [event('task_started'), talk, event('task_complete'), talk]))).toBe(false)
    expect(await codexTurnOpen(file('aborted', [event('task_started'), event('turn_aborted')]))).toBe(false)
    expect(await codexTurnOpen(file('working', [event('task_complete'), event('task_started'), talk]))).toBe(true)
    expect(await codexTurnOpen(file('other', [event('task_started'), { type: 'event_msg', payload: { type: 'task_complete_ish' } }]))).toBe(true)
    expect(await codexTurnOpen(file('unsaid', []))).toBe(true)
    // An agent that talks about the events is not one.
    const quoted = { type: 'event_msg', payload: { type: 'agent_message', phase: 'task_started' } }
    expect(await codexTurnOpen(file('quoted', [event('task_complete'), quoted]))).toBe(false)
    expect(await codexTurnOpen(join(dir, 'gone.jsonl'))).toBe(true)
    expect(await codexTurnOpen(join(dir, 'gone.jsonl'), null)).toBeNull()
    // Too far back to be read: busy, the safe answer.
    expect(await codexTurnOpen(file('long', [event('task_complete'), { type: 'response_item', payload: { big: 'x'.repeat(5 * 1024 * 1024) } }]))).toBe(true)
  })
})

describe('codexProvider', () => {
  it('lists sessions and archived ones with their names, skips what is not a person’s or is Harness’s own', async () => {
    const root = home()
    const live = write(join(root, 'sessions', '2026', '09', '20', rolloutName(C)), [meta(C, 'cli')])
    write(join(root, 'archived_sessions', rolloutName(D)), [meta(D, 'vscode', 'Codex Desktop')])
    write(join(root, 'sessions', '2026', '09', '21', rolloutName('01a0c4ad-de5e-7000-8000-000000000003')), [meta('01a0c4ad-de5e-7000-8000-000000000003', 'exec')])
    write(join(root, 'sessions', '2026', '09', '22', rolloutName('01a0c4ad-de5e-7000-8000-000000000004')), [meta('01a0c4ad-de5e-7000-8000-000000000004', 'cli', 'codex-tui', '/data/harness/recap')])
    mkdirSync(join(root, 'sessions', '2026', '09', '23', rolloutName('01a0c4ad-de5e-7000-8000-000000000005')), { recursive: true })
    symlinkSync(join(root, 'nowhere.jsonl'), join(root, 'archived_sessions', rolloutName('01a0c4ad-de5e-7000-8000-000000000006')))
    write(join(root, 'session_index.jsonl'), [{ id: C, thread_name: 'Retention cohorts' }])
    utimesSync(live, new Date('2026-09-25T00:00:00Z'), new Date('2026-09-25T00:00:00Z'))
    const provider = codexProvider({ home: root })
    const found = await provider.scan(scanMemo({ excluded: ['/data/harness'] }).context())
    expect(found.map((s) => [s.sessionId, s.origin, s.title]).sort()).toEqual([
      [C, 'terminal', 'Retention cohorts'],
      [D, 'codex-app', ''],
    ].sort())
    expect(found.find((s) => s.sessionId === C)).toMatchObject({ engine: 'codex', transcriptPath: live, mtime: Date.parse('2026-09-25T00:00:00Z') })
    // An archived one is found, to read, and says so: Codex resumes it only once `codex unarchive` puts it back.
    expect(found.find((s) => s.sessionId === C)).not.toHaveProperty('archived')
    expect(found.find((s) => s.sessionId === D)).toMatchObject({ archived: true })
  })

  it('knows its owners from the rollouts Codex processes hold open, and asks their rollout about the turn', async () => {
    const root = home()
    const path = write(join(root, rolloutName(C)), [meta(C, 'cli'), event('task_started')])
    const served = join(root, rolloutName(D))
    const view: ProcessView = {
      list: async () => [
        { pid: 201, ppid: 1, executable: 'codex', args: '/opt/codex/bin/codex resume x' },
        { pid: 203, ppid: 1, executable: 'codex', args: '/opt/codex/bin/codex app-server --listen stdio' },
      ],
      openFiles: async () => new Map(), alive: () => true,
      openFilesOf: async (commands) => {
        expect(commands).toEqual(['codex', 'Codex'])
        return new Map([[201, [path, '/dev/ttys003', '/tmp/rollout-notes.txt']], [202, ['/x/rollout-2026-not-an-id.jsonl']], [203, [served]]])
      },
    }
    const provider = codexProvider({ home: root })
    // A server holding a thread is never stopped from here, even when a terminal started it.
    expect(await provider.owners!(view)).toEqual([
      { sessionId: C, pid: 201, record: path },
      { sessionId: D, pid: 203, record: served, app: true },
    ])
    expect(await provider.busy!({ pid: 201, record: path })).toBe(true)
    // Nothing held open: no process is looked at.
    let listed = false
    expect(await provider.owners!({ ...view, openFilesOf: async () => new Map(), list: async () => { listed = true; return [] } })).toEqual([])
    expect(listed).toBe(false)
  })

  it("tells Codex's servers from a person's Codex", () => {
    const row = (executable: string, args: string) => ({ pid: 1, ppid: 0, executable, args })
    expect(codexServer(undefined)).toBe(false)
    expect(codexServer(row('codex', 'codex'))).toBe(false)
    expect(codexServer(row('codex', 'codex -m o3 --yolo'))).toBe(false)
    expect(codexServer(row('codex', 'codex resume 01a0'))).toBe(false)
    expect(codexServer(row('codex', 'codex "run the mcp tests"'))).toBe(false)
    for (const sub of ['app-server', 'mcp-server', 'mcp', 'proto']) expect(codexServer(row('codex', `codex --verbose ${sub}`))).toBe(true)
    expect(codexServer(row('/opt/bin/codex-acp', '/opt/bin/codex-acp'))).toBe(true)
    expect(codexServer(row('node', 'node /opt/lib/codex-acp --stdio'))).toBe(true)
  })
})
