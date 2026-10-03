import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { grokMovedAt, grokProvider, grokTurnOpen, readGrokSession } from './grok.js'
import { scanMemo } from './support.js'
import type { ProcessView, RunningProcess, ScanContext } from './types.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-external-'))
  dirs.push(dir)
  return dir
}

const ID = '01a0438c-0e05-73b1-98f9-978079f9e0a5'
const ID2 = '01a045b0-7db7-7e90-9348-5495a0dd4604'
const ID3 = '9159b98b-4050-4788-a7f7-e4bc235513aa'

/** One `updates.jsonl` line as Grok writes it. */
function line(kind: string, at: { s?: number; ms?: number } = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...(at.s !== undefined ? { timestamp: at.s } : {}),
    method: 'session/update',
    params: {
      sessionId: ID,
      update: { sessionUpdate: kind, ...extra },
      _meta: at.ms !== undefined ? { eventId: 'e', agentTimestampMs: at.ms } : { eventId: 'e' },
    },
  })
}

const PROMPT = line('user_message_chunk', { s: 1_787_839_648, ms: 1_787_839_648_590 }, { content: { type: 'text', text: 'hello' } })
const ANSWER = line('agent_message_chunk', { s: 1_787_839_700, ms: 1_787_839_700_123 }, { content: { type: 'text', text: 'hi' } })
const DONE = line('turn_completed', { s: 1_787_839_701, ms: 1_787_839_701_000 }, { stop_reason: 'end_turn' })
const HOOK = (event: string) => line('hook_execution', { s: 1_787_900_000, ms: 1_787_900_000_000 }, { event_name: event, runs: [] })

interface SessionFixture {
  group?: string
  summary?: unknown
  context?: unknown
  updates?: string[] | string | null
}

function session(root: string, id: string, fixture: SessionFixture = {}): string {
  const dir = join(root, 'sessions', fixture.group ?? encodeURIComponent('/work/app'), id)
  mkdirSync(dir, { recursive: true })
  const summary = fixture.summary === undefined
    ? { info: { id, cwd: '/work/app' }, generated_title: '  Fix the build  ', last_active_at: '2026-08-28T13:11:02.565632Z' }
    : fixture.summary
  const context = fixture.context === undefined ? { audience: 'primary', is_non_interactive: false, working_directory: '/work/app' } : fixture.context
  if (summary !== null) writeFileSync(join(dir, 'summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary))
  if (context !== null) writeFileSync(join(dir, 'prompt_context.json'), typeof context === 'string' ? context : JSON.stringify(context))
  const updates = fixture.updates === undefined ? [HOOK('session_start'), PROMPT, ANSWER, DONE, HOOK('session_end'), HOOK('stop')] : fixture.updates
  if (updates !== null) writeFileSync(join(dir, 'updates.jsonl'), typeof updates === 'string' ? updates : `${updates.join('\n')}\n`)
  return dir
}

/** A scan context that counts how often a memo's reader actually ran. */
function counted(excluded: string[] = []) {
  const memo = scanMemo({ excluded, paceEvery: 1 })
  let reads = 0
  let paces = 0
  const context = (): ScanContext => {
    const inner = memo.context()
    return {
      ...inner,
      memo: (key, fingerprint, read) => inner.memo(key, fingerprint, () => { reads++; return read() }),
      pace: async () => { paces++; await inner.pace() },
    }
  }
  return { context, reads: () => reads, paces: () => paces, prune: () => memo.prune() }
}

function view(rows: RunningProcess[], alive: (pid: number) => boolean = () => true): ProcessView & { listed: () => number } {
  let listed = 0
  return {
    list: async () => { listed++; return rows },
    openFiles: async () => new Map(),
    openFilesOf: async () => new Map(),
    alive,
    listed: () => listed,
  }
}

const grokRow = (pid: number, args = 'grok'): RunningProcess => ({ pid, ppid: 1, executable: '/Users/x/.grok/downloads/grok-1.0.34-macos-aarch64', args })

describe('grokProvider.scan', () => {
  it('offers a person\'s session: its folder, title, stream, and when the conversation last moved', async () => {
    const root = home()
    session(root, ID)
    const found = await grokProvider({ home: root }).scan(counted().context())
    expect(found).toEqual([{
      sessionId: ID, engine: 'grok', cwd: '/work/app', origin: 'terminal', title: 'Fix the build',
      // The last turn's end, not the exit hooks Grok appends hours later.
      mtime: 1_787_839_701_000,
      transcriptPath: join(root, 'sessions', encodeURIComponent('/work/app'), ID, 'updates.jsonl'),
    }])
  })

  it('leaves out headless runs, sub-agents and their forks, hidden and empty sessions', async () => {
    const root = home()
    session(root, ID, { context: { audience: 'primary', is_non_interactive: true } })
    session(root, ID2, { context: { audience: 'subagent', is_non_interactive: false } })
    session(root, ID3, { summary: { info: { id: ID3, cwd: '/work/app' }, session_kind: 'subagent_fork' } })
    const hidden = '11111111-1111-4111-8111-111111111111'
    session(root, hidden, { summary: { info: { id: hidden, cwd: '/work/app' }, hidden: true } })
    const empty = '22222222-2222-4222-8222-222222222222'
    session(root, empty, { updates: [HOOK('session_start'), HOOK('session_end')] })
    expect(await grokProvider({ home: root }).scan(counted().context())).toEqual([])
    expect(await readGrokSession(join(root, 'sessions', encodeURIComponent('/work/app'), ID), ID)).toEqual({ kind: 'skip', reason: 'headless' })
    expect(await readGrokSession(join(root, 'sessions', encodeURIComponent('/work/app'), ID2), ID2)).toEqual({ kind: 'skip', reason: 'subagent' })
    expect(await readGrokSession(join(root, 'sessions', encodeURIComponent('/work/app'), ID3), ID3)).toEqual({ kind: 'skip', reason: 'subagent' })
    expect(await readGrokSession(join(root, 'sessions', encodeURIComponent('/work/app'), hidden), hidden)).toEqual({ kind: 'skip', reason: 'hidden' })
    expect(await readGrokSession(join(root, 'sessions', encodeURIComponent('/work/app'), empty), empty)).toEqual({ kind: 'skip', reason: 'empty' })
  })

  it('keeps a /fork peer: a primary session with a parent', async () => {
    const root = home()
    session(root, ID, { summary: { info: { id: ID, cwd: '/work/app' }, parent_session_id: ID2, session_kind: 'fork' } })
    expect((await grokProvider({ home: root }).scan(counted().context())).map((s) => s.sessionId)).toEqual([ID])
  })

  it('does not offer a session it cannot classify or place', async () => {
    const root = home()
    const group = join(root, 'sessions', encodeURIComponent('/work/app'))
    session(root, ID, { summary: null })
    session(root, ID2, { context: '{"audience":' })
    session(root, ID3, { summary: { info: { id: ID2, cwd: '/work/app' } } })
    const relative = '33333333-3333-4333-8333-333333333333'
    session(root, relative, { summary: { info: { id: relative, cwd: 'work/app' } }, context: { audience: 'primary' } })
    expect(await grokProvider({ home: root }).scan(counted().context())).toEqual([])
    expect(await readGrokSession(join(group, ID), ID)).toEqual({ kind: 'skip', reason: 'unreadable' })
    // Half-written: not a verdict to remember.
    await expect(readGrokSession(join(group, ID2), ID2)).rejects.toThrow()
    expect(await readGrokSession(join(group, ID3), ID3)).toEqual({ kind: 'skip', reason: 'mismatch' })
    expect(await readGrokSession(join(group, relative), relative)).toEqual({ kind: 'skip', reason: 'no-folder' })
  })

  it('reads a session again next scan while its summary is half-written', async () => {
    const root = home()
    const dir = session(root, ID, { summary: '{"info":{"id":' })
    const provider = grokProvider({ home: root })
    const scan = counted()
    expect(await provider.scan(scan.context())).toEqual([])
    expect(await provider.scan(scan.context())).toEqual([])
    expect(scan.reads()).toBe(2)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: ID, cwd: '/work/app' } }))
    expect((await provider.scan(scan.context())).map((s) => s.sessionId)).toEqual([ID])
  })

  it('takes the folder from the prompt context when the summary has none, and needs no title', async () => {
    const root = home()
    session(root, ID, { summary: { last_active_at: 'not a time' }, context: { audience: 'primary', working_directory: '/work/other' } })
    const [found] = await grokProvider({ home: root }).scan(counted().context())
    expect(found).toMatchObject({ cwd: '/work/other', title: '' })
  })

  it('reads a session in a hashed group (its path in `.cwd`) by its own summary', async () => {
    const root = home()
    const long = `/work/${'deep/'.repeat(60)}app`
    const dir = session(root, ID, { group: 'work-deep-app-1a2b3c', summary: { info: { id: ID, cwd: long } } })
    writeFileSync(join(dir, '..', '.cwd'), long)
    expect((await grokProvider({ home: root }).scan(counted().context()))[0].cwd).toBe(long)
  })

  it('skips what is not a session folder', async () => {
    const root = home()
    session(root, ID)
    mkdirSync(join(root, 'sessions', 'group', 'not-a-uuid'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'session_search.sqlite'), '')
    writeFileSync(join(root, 'sessions', encodeURIComponent('/work/app'), 'prompt_history.jsonl'), '{}\n')
    writeFileSync(join(root, 'sessions', encodeURIComponent('/work/app'), ID2), 'a file, not a folder')
    session(root, ID3, { updates: null })
    expect((await grokProvider({ home: root }).scan(counted().context())).map((s) => s.sessionId)).toEqual([ID])
    expect(await grokProvider({ home: join(root, 'missing') }).scan(counted().context())).toEqual([])
  })

  it('leaves out folders Harness keeps its own sessions in', async () => {
    const root = home()
    session(root, ID)
    expect(await grokProvider({ home: root }).scan(counted(['/work']).context())).toEqual([])
  })

  it('reads a session again only when one of its files changed', async () => {
    const root = home()
    const dir = session(root, ID)
    const provider = grokProvider({ home: root })
    const scan = counted()
    await provider.scan(scan.context())
    await provider.scan(scan.context())
    expect(scan.reads()).toBe(1)
    expect(scan.paces()).toBe(2)
    writeFileSync(join(dir, 'summary.json'), JSON.stringify({ info: { id: ID, cwd: '/work/app' }, generated_title: 'Renamed' }))
    expect((await provider.scan(scan.context()))[0].title).toBe('Renamed')
    expect(scan.reads()).toBe(2)
    rmSync(join(dir, 'prompt_context.json'))
    expect(await provider.scan(scan.context())).toEqual([])
    expect(scan.reads()).toBe(3)
  })
})

describe('when a Grok conversation last moved', () => {
  it('reads milliseconds from `_meta`, else the line\'s seconds, and skips lines that are not the conversation', async () => {
    const root = home()
    const dir = session(root, ID, { updates: [PROMPT, line('tool_call', { s: 1_787_839_800 }), line('current_mode_update', { s: 1_787_839_900 })] })
    expect(await grokMovedAt(join(dir, 'updates.jsonl'))).toBe(1_787_839_800_000)
  })

  it('falls back to the summary\'s last activity, then to the file', async () => {
    const root = home()
    const undated = line('agent_message_chunk')
    const a = session(root, ID, { updates: [line('user_message_chunk'), undated, 'not json', ''] })
    expect(await readGrokSession(a, ID)).toMatchObject({ movedAt: Date.parse('2026-08-28T13:11:02.565632Z') })
    const b = session(root, ID2, { summary: { info: { id: ID2, cwd: '/work/app' } }, updates: [line('user_message_chunk')] })
    utimesSync(join(b, 'updates.jsonl'), 1_700_000_000, 1_700_000_000)
    const found = await grokProvider({ home: root }).scan(counted().context())
    expect(found.find((s) => s.sessionId === ID2)?.mtime).toBe(1_700_000_000_000)
  })

  it('reads further back when the end of the stream is one long line, and gives up past four megabytes', async () => {
    const root = home()
    const big = HOOK('stop').replace('"runs":[]', `"runs":["${'x'.repeat(300 * 1024)}"]`)
    const a = session(root, ID, { updates: [PROMPT, ANSWER, big] })
    expect(await grokMovedAt(join(a, 'updates.jsonl'))).toBe(1_787_839_700_123)
    const huge = HOOK('stop').replace('"runs":[]', `"runs":["${'x'.repeat(5 * 1024 * 1024)}"]`)
    const b = session(root, ID2, { updates: [PROMPT, huge] })
    expect(await grokMovedAt(join(b, 'updates.jsonl'))).toBeNull()
    expect(await grokMovedAt(join(root, 'missing.jsonl'))).toBeNull()
  })

  it('finds a prompt past a long first line, and never in the text of another line', async () => {
    const root = home()
    const setup = HOOK('session_start').replace('"runs":[]', `"runs":["${'y'.repeat(4096)}"]`)
    const quoted = line('agent_message_chunk', { s: 1 }, { content: { type: 'text', text: '"sessionUpdate":"user_message_chunk"' } })
    const a = session(root, ID, { updates: [setup, PROMPT] })
    expect(await readGrokSession(a, ID)).toMatchObject({ kind: 'session' })
    const b = session(root, ID2, { updates: [quoted] })
    expect(await readGrokSession(b, ID2)).toEqual({ kind: 'skip', reason: 'empty' })
    const c = session(root, ID3, { updates: null })
    expect(await readGrokSession(c, ID3)).toEqual({ kind: 'skip', reason: 'empty' })
  })
})

describe('grokProvider.owners', () => {
  const stream = (root: string, cwd = '/work/app', id = ID) => join(root, 'sessions', encodeURIComponent(cwd), id, 'updates.jsonl')

  it('claims each live Grok in `active_sessions.json`, with the stream that says whether it is mid-turn', async () => {
    const root = home()
    session(root, ID)
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([{ session_id: ID, pid: 41, cwd: '/work/app', opened_at: '2026-09-27T10:00:00Z' }]))
    const claims = await grokProvider({ home: root }).owners!(view([grokRow(41)]))
    expect(claims).toEqual([{ sessionId: ID, pid: 41, record: stream(root) }])
  })

  it('reads nothing of the machine when no session is open, and starts over from a corrupt list', async () => {
    const root = home()
    const processes = view([grokRow(41)])
    expect(await grokProvider({ home: root }).owners!(processes)).toEqual([])
    writeFileSync(join(root, 'active_sessions.json'), '[{"session_id":')
    expect(await grokProvider({ home: root }).owners!(processes)).toEqual([])
    writeFileSync(join(root, 'active_sessions.json'), '{"session_id":"x"}')
    expect(await grokProvider({ home: root }).owners!(processes)).toEqual([])
    writeFileSync(join(root, 'active_sessions.json'), '[]')
    expect(await grokProvider({ home: root }).owners!(processes)).toEqual([])
    expect(processes.listed()).toBe(0)
  })

  it('ignores entries a crash left behind: a dead pid, a pid now another program\'s, or Cursor\'s `agent`', async () => {
    const root = home()
    session(root, ID)
    const entries = [41, 42, 43, 44, 45, 46].map((pid) => ({ session_id: ID, pid, cwd: '/work/app' }))
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify(entries))
    const rows: RunningProcess[] = [
      grokRow(41),
      { pid: 42, ppid: 1, executable: '/usr/bin/python3', args: 'python3 worker.py grok' },
      { pid: 43, ppid: 1, executable: '/Users/x/.local/share/cursor-agent/versions/2026.09.26/node', args: 'agent --use-system-ca /Users/x/.local/share/cursor-agent/versions/2026.09.26/index.js' },
      grokRow(45),
      // A process whose arguments cannot be read.
      { pid: 46, ppid: 1, executable: '/bin/zsh', args: '' },
    ]
    const claims = await grokProvider({ home: root }).owners!(view(rows, (pid) => pid !== 41))
    expect(claims).toEqual([{ sessionId: ID, pid: 45, record: stream(root) }])
  })

  it('takes a terminal Grok\'s newest entry as its session, and every session a shared backend holds', async () => {
    const root = home()
    for (const id of [ID, ID2, ID3]) session(root, id)
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([
      // A crashed Grok's entry, its pid now another terminal Grok's with an entry of its own.
      { session_id: ID, pid: 70, cwd: '/work/app', opened_at: '2026-09-20T10:00:00Z' },
      { session_id: ID2, pid: 70, cwd: '/work/app', opened_at: '2026-09-27T10:00:00Z' },
      // Written in the same instant, or without a time: the later entry.
      { session_id: ID, pid: 71, cwd: '/work/app' },
      { session_id: ID3, pid: 71, cwd: '/work/app' },
      { session_id: ID, pid: 72, cwd: '/work/app', opened_at: '2026-09-27T10:00:00Z' },
      { session_id: ID3, pid: 72, cwd: '/work/app', opened_at: '2026-09-20T10:00:00Z' },
      // The newest listed first.
      { session_id: ID3, pid: 73, cwd: '/work/app', opened_at: 1_790_500_000 },
      { session_id: ID2, pid: 73, cwd: '/work/app', opened_at: 1_790_000_000 },
    ]))
    const rows = [grokRow(70), grokRow(71), grokRow(72, 'grok agent leader'), grokRow(73)]
    const claims = await grokProvider({ home: root }).owners!(view(rows))
    expect(claims.map((claim) => [claim.pid, claim.sessionId, claim.app ?? false])).toEqual([
      [70, ID2, false], [71, ID3, false], [72, ID, true], [72, ID3, true], [73, ID3, false],
    ])
  })

  it('ignores an entry opened before the process that now has its pid, allowing the second `ps` truncates', async () => {
    const root = home()
    for (const id of [ID, ID2, ID3]) session(root, id)
    const opened = '2023-11-14T22:13:20Z' // 1_700_000_000 s
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([
      { session_id: ID, pid: 80, cwd: '/work/app', opened_at: opened },
      { session_id: ID, pid: 81, cwd: '/work/app', opened_at: opened },
      { session_id: ID, pid: 82, cwd: '/work/app' },
      // A crashed Grok's entry beside the current one of the Grok that now has its pid.
      { session_id: ID, pid: 83, cwd: '/work/app', opened_at: opened },
      { session_id: ID2, pid: 83, cwd: '/work/app', opened_at: '2023-11-14T22:14:00Z' },
      { session_id: ID, pid: 84, cwd: '/work/app', opened_at: opened },
      { session_id: ID3, pid: 84, cwd: '/work/app', opened_at: '2023-11-14T22:14:00Z' },
    ]))
    const rows = [
      { ...grokRow(80), started: 1_700_000_005_000 },
      { ...grokRow(81), started: 1_700_000_000_500 },
      // No time on the entry: kept.
      { ...grokRow(82), started: 1_700_000_005_000 },
      { ...grokRow(83), started: 1_700_000_030_000 },
      { ...grokRow(84, 'grok agent leader'), started: 1_700_000_030_000 },
    ]
    const claims = await grokProvider({ home: root }).owners!(view(rows))
    expect(claims.map((claim) => [claim.pid, claim.sessionId])).toEqual([[81, ID], [82, ID], [83, ID2], [84, ID3]])
  })

  it('knows a Grok that runs as `agent`, the name it shares with Cursor', async () => {
    const root = home()
    session(root, ID)
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([{ session_id: ID, pid: 50, cwd: '/work/app' }]))
    const claims = await grokProvider({ home: root }).owners!(view([{ pid: 50, ppid: 1, executable: '/Users/x/.grok/bin/agent', args: 'agent' }]))
    expect(claims.map((claim) => claim.pid)).toEqual([50])
  })

  it('never offers to stop a shared backend (the leader, a server, a relay, an editor\'s stdio agent) or a leader\'s client', async () => {
    const root = home()
    session(root, ID)
    const pids = [60, 61, 62, 63, 64, 65]
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify(pids.map((pid) => ({ session_id: ID, pid, cwd: '/work/app' }))))
    const rows = [
      grokRow(60, '/Users/x/.grok/downloads/grok-1.0.34-macos-aarch64 agent leader'),
      grokRow(61, 'grok agent -m grok-4.6 serve --bind 127.0.0.1:0'),
      grokRow(62, 'grok agent headless'),
      grokRow(63, 'grok agent stdio'),
      grokRow(64, 'grok --resume 01a0438c-0e05-73b1-98f9-978079f9e0a5'),
      grokRow(65, 'grok --leader'),
    ]
    const claims = await grokProvider({ home: root }).owners!(view(rows))
    expect(claims.map((claim) => [claim.pid, claim.app ?? false])).toEqual([[60, true], [61, true], [62, true], [63, true], [64, false], [65, true]])
  })

  it('skips entries that are not a session and a pid', async () => {
    const root = home()
    session(root, ID)
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([
      null, 'x', { session_id: 'not-a-uuid', pid: 41 }, { session_id: ID, pid: '41' }, { session_id: ID, pid: 4.5 },
      { session_id: ID, pid: 0 }, { session_id: ID, pid: -3 }, { session_id: ID },
    ]))
    expect(await grokProvider({ home: root }).owners!(view([grokRow(41)]))).toEqual([])
  })

  it('finds the stream by id when the session is not where its folder puts it, and says nothing when it is gone', async () => {
    const root = home()
    session(root, ID, { group: 'work-deep-app-1a2b3c' })
    writeFileSync(join(root, 'sessions', 'session_search.sqlite'), '')
    writeFileSync(join(root, 'active_sessions.json'), JSON.stringify([
      { session_id: ID, pid: 41, cwd: '/work/app' }, { session_id: ID2, pid: 42 },
    ]))
    const provider = grokProvider({ home: root })
    const claims = await provider.owners!(view([grokRow(41), grokRow(42)]))
    expect(claims).toEqual([
      { sessionId: ID, pid: 41, record: join(root, 'sessions', 'work-deep-app-1a2b3c', ID, 'updates.jsonl') },
      { sessionId: ID2, pid: 42, record: '' },
    ])
    expect(await provider.busy!({ pid: 42, record: '' })).toBeNull()
  })
})

describe('grokProvider.busy', () => {
  it('is mid-turn when a prompt came after the last `turn_completed`', async () => {
    const root = home()
    const provider = grokProvider({ home: root })
    const open = session(root, ID, { updates: [PROMPT, ANSWER, DONE, PROMPT, line('tool_call', { s: 1 })] })
    expect(await provider.busy!({ pid: 1, record: join(open, 'updates.jsonl') })).toBe(true)
    const cancelled = line('turn_completed', { s: 2 }, { stop_reason: 'cancelled' })
    const closed = session(root, ID2, { updates: [PROMPT, cancelled, HOOK('stop')] })
    expect(await provider.busy!({ pid: 1, record: join(closed, 'updates.jsonl') })).toBe(false)
  })

  it('is not mid-turn once the process wrote its `session_end`', async () => {
    const root = home()
    const dir = session(root, ID, { updates: [PROMPT, HOOK('session_end'), HOOK('stop')] })
    expect(await grokTurnOpen(join(dir, 'updates.jsonl'))).toBe(false)
  })

  it('cannot say from a stream with no turn in it, or no stream', async () => {
    const root = home()
    const dir = session(root, ID, { updates: [HOOK('session_start'), line('current_mode_update', { s: 1 })] })
    expect(await grokTurnOpen(join(dir, 'updates.jsonl'))).toBeNull()
    expect(await grokTurnOpen(join(root, 'missing.jsonl'))).toBeNull()
  })
})
