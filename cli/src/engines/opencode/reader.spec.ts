import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OpencodeReader, readOpencodeMessages } from './reader.js'
import { opencodeV2TurnOpen } from '../launchControl.js'
import { lastOpencodeTurnText, opencodeMessagesToEvents } from './normalizer.js'
import type { LiveEvent } from '../../lib/normalize.js'

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
