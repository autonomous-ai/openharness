import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OpencodeReader, readOpencodeMessages } from './reader.js'
import { opencodeV2TurnOpen } from '../launchControl.js'
import { lastOpencodeTurnText, opencodeMessagesToEvents } from './normalizer.js'
import type { LiveEvent } from '../../lib/normalize.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import { sqliteReadAll } from '../../lib/sqliteRead.js'
import { enableOffThreadSqlite, resetOffThreadSqlite } from '../../lib/sqliteThread.js'
import { KIB, MIB, pageReads, withinBudget } from '../../testing/storePages.js'

// The real reads, with a seam to make one of them go unanswered, as a busy store or the read threads' deadline does.
vi.mock('../../lib/sqliteRead.js', async (real) => {
  const actual = await real<typeof import('../../lib/sqliteRead.js')>()
  return { ...actual, sqliteReadAll: vi.fn(actual.sqliteReadAll) }
})

/** Polls until the store has been read [more] times since [from]: the read that seeds a reader, and a poll after it. */
async function readsPast(from: number, more = 2): Promise<void> {
  await vi.waitFor(() => expect(vi.mocked(sqliteReadAll).mock.calls.length).toBeGreaterThanOrEqual(from + more), { timeout: 5_000, interval: 10 })
}

const hasSqlite = (() => {
  try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false }
})()
const d = hasSqlite ? describe : describe.skip

const SID = 'ses_testABC123'

function run(db: string, sql: string): void {
  execFileSync('sqlite3', [db, sql], { stdio: ['ignore', 'ignore', 'inherit'] })
}
function esc(v: unknown): string {
  return JSON.stringify(v).replace(/'/g, "''")
}
function schema(db: string): void {
  run(db,
    'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);' +
    'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);')
}
function insertMessage(
  db: string, mid: string, tc: number, data: Record<string, unknown>,
  parts: Array<{ id: string; tc: number; data: Record<string, unknown> }>,
): void {
  let sql = `INSERT INTO message VALUES ('${mid}','${SID}',${tc},'${esc(data)}');`
  for (const p of parts) sql += `INSERT INTO part VALUES ('${p.id}','${mid}','${SID}',${p.tc},'${esc(p.data)}');`
  run(db, sql)
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

d('OpencodeReader (sqlite3 CLI)', () => {
  let dir = ''
  let db = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-reader-')); db = join(dir, 'opencode.db'); schema(db) })
  // maxRetries: a reader poll (sqlite3 CLI writing its journal) can still be touching the directory
  // when the test ends, and a bare rmSync then dies with ENOTEMPTY — seen on CI (ubuntu-latest),
  // where it made an unrelated PR red. Node retries the removal on exactly that class of error.
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  /**
   * Attaching mid-turn must still open the turn.
   *
   * A silent hydrate loses the opening frame of a turn that is already running, and the daemon then
   * drops that turn's recap because it never saw it open — measured on a real pane as
   * `[turn] ses_fec1 ended` followed by `[recap] DROPPED (no turn_started was ever seen…)`, on both
   * terminal backends. Kilo, an opencode fork, already carried this fix; opencode was left behind.
   */
  it('opens the turn when only the user row exists yet', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'price eth' } }])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 600_000 })
    await reader.start()
    reader.stop()
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'price eth' } }])
  })

  it('opens the turn when the assistant is already working', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'hi there' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [{ id: 'p2', tc: 2, data: { type: 'text', text: 'working…' } }])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 600_000 })
    await reader.start()
    reader.stop()
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'hi there' } }])
  })

  /** Re-attaching to an idle session must stay silent, or every daemon restart invents a turn. */
  it('says nothing when the last turn already finished, or the session is empty', async () => {
    const quiet: LiveEvent[] = []
    const empty = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => quiet.push(...e), pollMs: 600_000 })
    await empty.start(); empty.stop()
    expect(quiet).toEqual([])

    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'hi' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'done' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const idle: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => idle.push(...e), pollMs: 600_000 })
    await reader.start(); reader.stop()
    expect(idle).toEqual([])
  })

  /** The backstop must not double-fire once the poll re-reads the same rows. */
  it('does not open the same turn twice when the poll re-reads it', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'once' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [{ id: 'p2', tc: 2, data: { type: 'text', text: 'w' } }])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 10 })
    await reader.start()
    await wait(120)
    reader.stop()
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
  })

  it('reads messages grouped with their parts, ordered', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'hi' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'hello' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const messages = await readOpencodeMessages(db, SID)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
    expect(messages[0].parts[0].data.text).toBe('hi')
  })

  it('rejects a non-id session (no injection surface)', async () => {
    expect(await readOpencodeMessages(db, "x'; DROP TABLE message;--")).toEqual([])
  })

  it('hydrates silently, then streams a new turn incrementally', async () => {
    // A pre-existing, completed turn: the reader must NOT replay it on attach.
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'old' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'done' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    expect(events).toHaveLength(0) // hydrate = no replay

    // A fresh turn arrives — a new user prompt, an assistant text, a tool, then a terminal step-finish.
    insertMessage(db, 'm3', 10, { role: 'user' }, [{ id: 'p4', tc: 10, data: { type: 'text', text: 'who won?' } }])
    insertMessage(db, 'm4', 11, { role: 'assistant' }, [
      { id: 'p5', tc: 11, data: { type: 'text', text: 'Spain' } },
      { id: 'p6', tc: 12, data: { type: 'tool', tool: 'webfetch', state: { status: 'completed', input: { url: 'u' }, output: 'ok' } } },
      { id: 'p7', tc: 13, data: { type: 'step-finish', reason: 'stop' } },
    ])
    await wait(200)
    reader.stop()

    const types = events.map((e) => e.type)
    expect(types).toContain('turn_started')
    expect(types).toContain('text_delta')
    expect(types).toContain('tool_start')
    expect(types).toContain('tool_end')
    expect(types).toContain('turn_ended')
    const started = events.find((e) => e.type === 'turn_started')
    expect(started).toMatchObject({ payload: { userMessage: 'who won?' } })
    expect(reader.turnOpen).toBe(false) // closed by step-finish reason:stop
  })

  it('waits for a task part\'s input before announcing the sub-agent', async () => {
    // opencode creates the `task` part when the call STARTS streaming, with `state.input` still empty, and
    // fills the arguments in a moment later. Announcing on first sight gave every sub-agent the same
    // `Delegated task` placeholder — measured live, two parallel sub-agents produced two identical rows.
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'old' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [{ id: 'p2', tc: 2, data: { type: 'step-finish', reason: 'stop' } }])
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()

    insertMessage(db, 'm3', 10, { role: 'user' }, [{ id: 'p3', tc: 10, data: { type: 'text', text: 'spawn two' } }])
    insertMessage(db, 'm4', 11, { role: 'assistant' }, [
      { id: 'p4', tc: 11, data: { type: 'tool', tool: 'task', state: { status: 'running', input: {} } } },
    ])
    await wait(120)
    expect(events.filter((e) => e.type === 'tool_start')).toHaveLength(0)   // nothing worth showing yet

    run(db, `UPDATE part SET data='${esc({ type: 'tool', tool: 'task', state: { status: 'running', input: { description: 'Count .md files', subagent_type: 'general' } } })}' WHERE id='p4';`)
    await wait(120)
    reader.stop()

    const start = events.find((e) => e.type === 'tool_start')
    expect(start).toMatchObject({ payload: { tool: 'Task', input: { description: 'Count .md files' } } })
  })

  it('emits text deltas incrementally as an assistant message grows', async () => {
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    insertMessage(db, 'm1', 5, { role: 'user' }, [{ id: 'p1', tc: 5, data: { type: 'text', text: 'go' } }])
    insertMessage(db, 'm2', 6, { role: 'assistant' }, [{ id: 'p2', tc: 6, data: { type: 'text', text: 'Hel' } }])
    await wait(120)
    // The same part grows (streaming) — only the NEW suffix should be emitted.
    run(db, `UPDATE part SET data='${esc({ type: 'text', text: 'Hello world' })}' WHERE id='p2';`)
    await wait(120)
    reader.stop()
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { payload: { content: string } }).payload.content)
    expect(deltas.join('')).toBe('Hello world')
    expect(deltas).toContain('Hel')
    expect(deltas).toContain('lo world')
  })

  // #4065: a first read the store did not answer left no cursor, and the next poll emitted the whole session as new. This
  // store has no session_message table: its first read finds none, as ever, and the legacy read after it goes unanswered.
  it('reads the session in full again after a first read the store did not answer, and emits only what is new', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'an old prompt' } }])
    insertMessage(db, 'm2', 2, { role: 'assistant' }, [
      { id: 'p2', tc: 2, data: { type: 'text', text: 'an old answer' } },
      { id: 'p3', tc: 3, data: { type: 'step-finish', reason: 'stop' } },
    ])
    const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
    vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 })
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length, 3)
      expect(events).toEqual([])
      insertMessage(db, 'm3', 4, { role: 'user' }, [{ id: 'p4', tc: 4, data: { type: 'text', text: 'a new prompt' } }])
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 })
    } finally {
      reader.stop()
    }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })
})

/**
 * OpenCode 2 keeps a conversation in `session_message` (one row per prompt, assistant step and turn end) and no
 * longer writes the `message`/`part` tables. The shapes below are those of a recorded 2.0.29 store, with made-up text.
 */
d('OpencodeReader (OpenCode 2 session_message)', () => {
  let dir = ''
  let db = ''
  const CHILD = 'ses_childXYZ789'
  function v2Schema(): void {
    run(db, 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
  }
  function row(seq: number, type: string, data: Record<string, unknown>, opts: { id?: string; tc?: number; sid?: string } = {}): void {
    run(db, `INSERT INTO session_message VALUES ('${opts.id ?? `msg_${String(seq).padStart(3, '0')}`}','${opts.sid ?? SID}','${type}',${seq},${opts.tc ?? seq},${opts.tc ?? seq},'${esc(data)}');`)
  }
  const user = (seq: number, text: string, opts: { id?: string; tc?: number; sid?: string } = {}): void => row(seq, 'user', { text, time: { created: seq }, files: [], agents: [] }, opts)
  const assistant = (seq: number, content: unknown[], finish?: string, opts: { id?: string; tc?: number; sid?: string } = {}): void =>
    row(seq, 'assistant', { content, ...(finish ? { finish } : {}), time: { created: seq } }, opts)
  const idle = (seq: number, outcome: string): void => row(seq, 'idle', { outcome, time: { created: seq } })
  const tool = (id: string, name: string, status: string, input: Record<string, unknown>, text?: string, metadata: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ type: 'tool', id, name, state: { status, input, content: text === undefined ? [] : [{ type: 'text', text }], metadata }, time: { created: 1, ran: 2, completed: 3 } })

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-reader-v2-')); db = join(dir, 'opencode.db'); schema(db); v2Schema() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

  it('reads a v2 session, which has no message or part rows, as v1 messages', async () => {
    user(1, 'list the files')
    assistant(2, [
      { type: 'reasoning', text: 'I will look' },
      tool('call_1', 'bash', 'completed', { command: 'ls' }, 'a.txt\nb.txt'),
      { type: 'text', text: 'Two files.' },
    ], 'stop')
    idle(3, 'succeeded')
    row(4, 'compaction', { status: 'completed' })
    row(5, 'synthetic', { text: 'injected' })

    const messages = await readOpencodeMessages(db, SID)
    expect(messages.map((m) => [m.role, m.seq])).toEqual([['user', 1], ['assistant', 2], ['assistant', 3]])
    expect(messages[0].parts[0].data.text).toBe('list the files')
    expect(messages[1].parts.map((p) => p.type)).toEqual(['reasoning', 'tool', 'text', 'step-finish'])
    expect(messages[1].parts[1]).toMatchObject({ id: 'call_1', data: { tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt\nb.txt' } } })

    const kinds = opencodeMessagesToEvents(messages).map((e) => e.type)
    expect(kinds).toEqual(['user_message', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'done'])
    expect(lastOpencodeTurnText(messages)).toEqual({ userMessage: 'list the files', assistantText: 'Two files.' })
  })

  it('orders by time_created, then seq — not by seq alone, which can disagree with real time in a real store', async () => {
    user(1, 'first', { id: 'msg_z', tc: 100 })
    assistant(2, [{ type: 'text', text: 'second' }], 'stop', { id: 'msg_a', tc: 100 })
    user(3, 'third', { id: 'msg_m', tc: 50 })
    const messages = await readOpencodeMessages(db, SID)
    expect(messages.map((m) => m.id)).toEqual(['msg_m', 'msg_z', 'msg_a'])
    const after = await readOpencodeMessages(db, SID, { tc: 100, id: 'msg_a', seq: 2 })
    expect(after.map((m) => m.id)).toEqual([])
  })

  it('reports a failed tool by its error and finds a sub-agent in either spelling of its session id', async () => {
    user(1, 'go')
    assistant(2, [
      { type: 'tool', id: 'call_e', name: 'read', state: { status: 'error', input: {}, content: [], error: { type: 'x', message: 'File not found' }, metadata: {} }, time: { created: 1 } },
      tool('call_t', 'task', 'completed', { description: 'Count files', subagent_type: 'general' }, '<task_result>3</task_result>', { sessionId: CHILD }),
      tool('call_s', 'subagent', 'completed', { description: 'Other' }, 'ok', { sessionID: CHILD }),
    ], 'stop')
    const parts = (await readOpencodeMessages(db, SID))[1].parts
    expect(parts[0].data.state).toMatchObject({ status: 'error', output: 'File not found' })
    expect((parts[1].data.state as { metadata: { sessionId: string } }).metadata.sessionId).toBe(CHILD)
    expect((parts[2].data.state as { metadata: { sessionId: string } }).metadata.sessionId).toBe(CHILD)
  })

  it('shows the tools v2 added as the v1 ones they stand for: shell as Bash, a sub-agent as a Task that closes with its call', async () => {
    user(1, 'go')
    assistant(2, [
      tool('call_s', 'shell', 'completed', { command: 'ls', workdir: '/work' }, 'a.txt'),
      tool('call_b', 'subagent', 'completed', { agent: 'general', description: 'Count files', prompt: 'count', background: true }, 'started', { sessionID: CHILD, status: 'running' }),
      tool('call_x', 'execute', 'completed', { code: 'return 1' }, '1'),
    ], 'stop')
    user(1, 'child prompt', { sid: CHILD, id: 'msg_c1' })
    assistant(2, [tool('c_1', 'glob', 'completed', {}, 'x')], 'stop', { sid: CHILD, id: 'msg_c2' })
    const messages = await readOpencodeMessages(db, SID)
    const events = opencodeMessagesToEvents(messages)
    const started = events.filter((e) => e.type === 'tool_start').map((e) => (e as { payload: { tool: string; input: unknown } }).payload)
    expect(started.map((p) => p.tool)).toEqual(['Bash', 'Task', 'Execute'])
    expect(started[0].input).toEqual({ command: 'ls', workdir: '/work' })
    expect(started[1].input).toEqual({ subagent_type: 'general', description: 'Count files' })
    // Even a background sub-agent, which the tool reports `running`, is closed: an open row would hold the turn open.
    expect(events.filter((e) => e.type === 'tool_end').map((e) => (e as { payload: { tool: string } }).payload.tool)).toEqual(['Bash', 'Task', 'Execute'])
  })

  it('reads a store OpenCode 2 created, which has no message or part tables', async () => {
    const fresh = join(dir, 'fresh.db')
    run(fresh, 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
    const same = db
    db = fresh
    try {
      expect(await readOpencodeMessages(db, SID)).toEqual([])
      user(1, 'hello')
      assistant(2, [{ type: 'text', text: 'hi' }], 'stop')
      expect((await readOpencodeMessages(db, SID)).map((m) => m.role)).toEqual(['user', 'assistant'])
      const events: LiveEvent[] = []
      const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
      await reader.start()
      user(3, 'again')
      await wait(150)
      reader.stop()
      expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'again' } }])
    } finally { db = same }
  })

  it('falls back to the legacy tables when the session has no v2 rows', async () => {
    insertMessage(db, 'm1', 1, { role: 'user' }, [{ id: 'p1', tc: 1, data: { type: 'text', text: 'old v1 session' } }])
    user(1, 'a different session', { sid: 'ses_other' })
    const messages = await readOpencodeMessages(db, SID)
    expect(messages.map((m) => [m.id, m.seq])).toEqual([['m1', undefined]])
    expect(await readOpencodeMessages(db, SID, { tc: 1, id: 'm1' })).toEqual([])
  })

  it('opens the turn on attach until the assistant finishes or the turn goes idle', async () => {
    user(1, 'run the tests')
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 600_000 })
    await reader.start(); reader.stop()
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'run the tests' } }])

    assistant(2, [tool('call_1', 'bash', 'completed', { command: 'npm test' }, 'ok')], 'tool-calls')
    const mid: LiveEvent[] = []
    const midReader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => mid.push(...e), pollMs: 600_000 })
    await midReader.start(); midReader.stop()
    expect(mid.map((e) => e.type)).toEqual(['turn_started']) // a step that ended in tool calls is not the end of the turn

    assistant(3, [{ type: 'text', text: 'passed' }], 'stop')
    const done: LiveEvent[] = []
    const doneReader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => done.push(...e), pollMs: 600_000 })
    await doneReader.start(); doneReader.stop()
    expect(done).toEqual([])
  })

  it('streams a v2 turn live and closes it on idle, even when it was interrupted', async () => {
    user(1, 'old')
    assistant(2, [{ type: 'text', text: 'done' }], 'stop')
    idle(3, 'succeeded')
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 30 })
    await reader.start()
    expect(events).toEqual([]) // hydrate = no replay

    user(4, 'spawn one')
    const spawn = tool('call_t', 'task', 'completed', { description: 'Count files', subagent_type: 'general' }, '<task_result>3</task_result>', { sessionId: CHILD })
    assistant(5, [spawn, { type: 'text', text: 'Hel' }])
    user(1, 'child prompt', { sid: CHILD, id: 'msg_c1' })
    assistant(2, [tool('c_1', 'glob', 'completed', {}, 'x'), tool('c_2', 'grep', 'completed', {}, 'y')], 'stop', { sid: CHILD, id: 'msg_c2' })
    await wait(200)
    run(db, `UPDATE session_message SET data='${esc({ content: [spawn, { type: 'text', text: 'Hello' }], time: { created: 5 } })}' WHERE id='msg_005';`)
    await wait(120)
    expect(reader.turnOpen).toBe(true)
    idle(6, 'interrupted') // no assistant step ever finished with `stop`
    await wait(150)
    reader.stop()

    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended']))
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
    expect(events.find((e) => e.type === 'turn_started')).toMatchObject({ payload: { userMessage: 'spawn one' } })
    const end = events.find((e) => e.type === 'tool_end')
    expect(end).toMatchObject({ payload: { tool: 'Task', subagent: { totalToolUseCount: 2 } } })
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { payload: { content: string } }).payload.content).join('')
    expect(text).toBe('Hello')
    expect(events[events.length - 1].type).toBe('turn_ended')
    expect(reader.turnOpen).toBe(false)
  })

  // #4065, for an OpenCode 2 session: a first read the store did not answer must not read as a v1 session either.
  it('reads the session in full again after a first read the store did not answer, and emits only what is new', async () => {
    user(1, 'an old prompt')
    assistant(2, [{ type: 'text', text: 'an old answer' }], 'stop')
    idle(3, 'succeeded')
    vi.mocked(sqliteReadAll).mockResolvedValueOnce({ ok: false, reason: 'transient' })
    const events: LiveEvent[] = []
    const reader = new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 })
    try {
      await reader.start()
      await readsPast(vi.mocked(sqliteReadAll).mock.calls.length)
      expect(events).toEqual([])
      user(4, 'a new prompt')
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5_000, interval: 10 })
    } finally {
      reader.stop()
    }
    expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
  })
})

d('opencodeV2TurnOpen (OpenCode 2 session_message)', () => {
  let dir = ''
  let db = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-v2-turn-')); db = join(dir, 'opencode.db')
    run(db, 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const row = (seq: number, type: string, sid = SID): void =>
    run(db, `INSERT INTO session_message VALUES ('m${seq}${sid}','${sid}','${type}',${seq},${seq},${seq},'{}');`)

  // Rows as 2.0.24 writes them: system, user, assistant…, idle {outcome} — measured on a live store.
  it('is open from the user row until its idle row, whatever the outcome', async () => {
    expect(await opencodeV2TurnOpen(db, SID)).toBe(false)
    row(1, 'system'); row(2, 'user'); row(3, 'assistant')
    expect(await opencodeV2TurnOpen(db, SID)).toBe(true)
    row(4, 'idle')
    expect(await opencodeV2TurnOpen(db, SID)).toBe(false)
    row(5, 'user'); row(6, 'model-switched')
    expect(await opencodeV2TurnOpen(db, SID)).toBe(true)
    row(7, 'user', 'ses_other'); row(8, 'idle', 'ses_other')
    expect(await opencodeV2TurnOpen(db, SID)).toBe(true)
  })

  it('is unknown for a store it cannot read or an id it will not query', async () => {
    expect(await opencodeV2TurnOpen(join(dir, 'missing.db'), SID)).toBeNull()
    expect(await opencodeV2TurnOpen(db, "x' OR 1=1")).toBeNull()
  })
})

// Only the read threads enforce a reply limit, so they are on (#4188: a session over 32 MiB was refused on every poll,
// so its reader never seeded and its history never loaded). The store is written with the binding, in WAL as
// OpenCode's own is: the sqlite3 CLI cannot take megabytes on a command line, and in the older journal mode a read in
// the middle of a large page would fail the writer's commit with `database is locked`, now and then.
const withBuiltin = builtinSqlite() ? describe : describe.skip

withBuiltin('OpencodeReader pages by bytes', () => {
  let dir = ''
  let db = ''
  let w: DatabaseLike
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-pages-'))
    db = join(dir, 'opencode.db')
    w = new (builtinSqlite()!)(db, { readOnly: false })
    w.exec('PRAGMA journal_mode = WAL')
    vi.mocked(sqliteReadAll).mockClear()
    enableOffThreadSqlite()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await resetOffThreadSqlite()
    closeSqliteHandles()
    w.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  const listen = (): { events: LiveEvent[]; reader: OpencodeReader } => {
    const events: LiveEvent[] = []
    return { events, reader: new OpencodeReader({ dbPath: db, sessionId: SID, onEvents: (e) => events.push(...e), pollMs: 20 }) }
  }
  const tooBig = (error: { mock: { calls: unknown[][] } }): string[] =>
    error.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('too big'))

  // A 1.x store, whose session_message table is there and empty.
  describe('OpenCode 1', () => {
    beforeEach(() => {
      w.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);'
        + 'CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);'
        + 'CREATE INDEX part_message_id_id_idx ON part (message_id, id);'
        + 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);')
    })
    /** A message and its parts in one transaction: a poll never sees the message without them. */
    const put = (mid: string, tc: number, role: string, parts: Array<Record<string, unknown>>): void => {
      w.exec('BEGIN')
      w.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').all(mid, SID, tc, JSON.stringify({ role }))
      parts.forEach((data, p) => w.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').all(`${mid}-p${p}`, mid, SID, tc * 10 + p, JSON.stringify(data)))
      w.exec('COMMIT')
    }
    const id = (n: number): string => `m${String(n).padStart(4, '0')}`
    /** Turn i: a prompt, and a finished answer of `bytes`. */
    const turn = (i: number, bytes: number): void => {
      put(id(2 * i), 2 * i, 'user', [{ type: 'text', text: `q${i}` }])
      put(id(2 * i + 1), 2 * i + 1, 'assistant', [{ type: 'text', text: 'x'.repeat(bytes) }, { type: 'step-finish', reason: 'stop' }])
    }

    it('reads a session larger than the row cap whole, a page at a time, and a reader seeds from it', async () => {
      for (let i = 0; i < 80; i++) turn(i, 500 * KIB) // 39 MiB
      const messages = await readOpencodeMessages(db, SID)
      expect(messages.map((m) => m.id)).toEqual(Array.from({ length: 160 }, (_, n) => id(n)))
      expect(messages[159].parts.map((p) => p.type)).toEqual(['text', 'step-finish'])
      expect(String(messages[159].parts[0].data.text)).toHaveLength(500 * KIB)
      const reads = await pageReads(vi.mocked(sqliteReadAll))
      expect(reads.length).toBeGreaterThan(9)
      expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
      expect((await readOpencodeMessages(db, SID, { tc: 157, id: id(157) })).map((m) => m.id)).toEqual([id(158), id(159)])
      // A reader seeds from it in silence and streams only what comes after. On the base it never seeds.
      const { events, reader } = listen()
      try {
        await reader.start()
        expect(events).toEqual([])
        put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
      } finally { reader.stop() }
      expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
    })

    it('never splits a message from its parts, and reads its data once', async () => {
      turn(0, 10)
      put(id(2), 2, 'assistant', [0, 1, 2].map(() => ({ type: 'text', text: 'y'.repeat(2 * MIB) }))) // 6 MiB: over the budget
      turn(2, 10)
      const messages = await readOpencodeMessages(db, SID)
      expect(messages.map((m) => [m.id, m.parts.length])).toEqual([[id(0), 1], [id(1), 2], [id(2), 3], [id(4), 1], [id(5), 2]])
      const reads = await pageReads(vi.mocked(sqliteReadAll))
      const own = reads.find((read) => read.rows.some((row) => row.mid === id(2)))!
      expect(own.units).toBe(1)
      expect(own.rows.filter((row) => row.mdata !== null)).toHaveLength(1)
    })

    it('leaves out a message over the row cap, says so once, and reads on', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      turn(0, 10); put(id(2), 2, 'assistant', [{ type: 'text', text: 'z'.repeat(33 * MIB) }]); turn(2, 10)
      for (let n = 0; n < 2; n++) expect((await readOpencodeMessages(db, SID)).map((m) => m.id)).toEqual([id(0), id(1), id(4), id(5)])
      // A reader that polls over it does not stick: what comes after still arrives.
      const { events, reader } = listen()
      try {
        await reader.start()
        put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
        await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
      } finally { reader.stop() }
      expect(tooBig(error)).toEqual([`[opencode] ses_test id ${id(2)} unreadable · too big`])
    })

    // #4065: a seed from the first pages alone would emit the rest as new on the next poll.
    it('reads nothing when a later page fails, and seeds from the next whole read, replaying nothing', async () => {
      for (let i = 0; i < 12; i++) turn(i, 500 * KIB) // two pages
      const actual = await vi.importActual<typeof import('../../lib/sqliteRead.js')>('../../lib/sqliteRead.js')
      // The v2 read (no rows), the first page, then a second page the store does not answer.
      const fail = (): void => {
        vi.mocked(sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll).mockImplementationOnce(actual.sqliteReadAll)
          .mockResolvedValueOnce({ ok: false, reason: 'transient' })
      }
      fail()
      expect(await readOpencodeMessages(db, SID)).toEqual([])
      fail()
      const { events, reader } = listen()
      try {
        await reader.start()
        await readsPast(vi.mocked(sqliteReadAll).mock.calls.length, 3)
        expect(events).toEqual([])
        put(id(900), 900, 'user', [{ type: 'text', text: 'a new prompt' }])
        await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 10_000, interval: 10 })
      } finally { reader.stop() }
      expect(events).toEqual([{ type: 'turn_started', payload: { userMessage: 'a new prompt' } }])
    })
  })

  // The store has session_message alone.
  describe('OpenCode 2', () => {
    beforeEach(() => {
      w.exec('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
    })
    // Rows share a time_created in pairs: the seq orders them, and a page may end between the two.
    const row = (seq: number, type: string, data: Record<string, unknown>): void => {
      w.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').all(`msg_${String(seq).padStart(4, '0')}`, SID, type, seq, seq >> 1, seq >> 1, JSON.stringify(data))
    }
    const prompt = (text: string): Record<string, unknown> => ({ text, time: { created: 1 }, files: [], agents: [] })
    const answer = (bytes: number): Record<string, unknown> => ({ content: [{ type: 'text', text: 'x'.repeat(bytes) }], finish: 'stop', time: { created: 1 } })

    it('reads an OpenCode 2 session larger than the row cap whole, in time_created then seq order', async () => {
      for (let i = 0; i < 80; i++) {
        row(3 * i + 1, 'user', prompt(`q${i}`))
        row(3 * i + 2, 'assistant', answer(500 * KIB)); row(3 * i + 3, 'idle', { outcome: 'succeeded', time: { created: 1 } })
      }
      const messages = await readOpencodeMessages(db, SID)
      expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: 240 }, (_, n) => n + 1))
      const reads = await pageReads(vi.mocked(sqliteReadAll))
      expect(reads.length).toBeGreaterThan(9)
      expect(reads.every((read) => read.ok && read.bytes <= read.maxBuffer && withinBudget(read))).toBe(true)
      expect((await readOpencodeMessages(db, SID, { tc: 118, id: 'msg_0237', seq: 237 })).map((m) => m.seq)).toEqual([238, 239, 240])
    })

    it('leaves out an OpenCode 2 row over the row cap, says so once, and reads on', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      row(1, 'user', prompt('q')); row(2, 'assistant', answer(33 * MIB)); row(3, 'user', prompt('next'))
      for (let n = 0; n < 2; n++) expect((await readOpencodeMessages(db, SID)).map((m) => m.seq)).toEqual([1, 3])
      const { events, reader } = listen()
      try {
        await reader.start()
        row(4, 'user', prompt('a new prompt'))
        await vi.waitFor(() => expect(JSON.stringify(events)).toContain('a new prompt'), { timeout: 10_000, interval: 10 })
      } finally { reader.stop() }
      expect(tooBig(error)).toEqual(['[opencode] ses_test seq 2 unreadable · too big'])
    })
  })
})
