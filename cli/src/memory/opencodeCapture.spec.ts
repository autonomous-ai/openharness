import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { closeSqliteHandles, overrideBuiltinSqlite } from '../lib/sqliteRead.js'
import { NativeMemoryCapture, type CaptureSession } from './capture.js'
import { CodingMemoryStore } from './store.js'
import type { Database } from './database.js'
import { QUEUE_OPERATIONS, type MemoryPort, type Operation, type Arguments, type Result } from './operations.js'
import { decodeOpenCodeMemoryMessage } from './opencodeSource.js'
import { readOpenCodeMemoryMessage } from './opencodeRead.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => Database }
const hasSqliteCli = (() => { try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); return true } catch { return false } })()
interface MessageRow { id: string; session_id: string; time_created: number; time_updated: number; data: string }
interface Snapshot {
  sessions: Array<{ id: string; parent_id: string | null; directory: string; version: string; revert: string | null; time_created: number; time_updated: number }>
  messages: MessageRow[]
  parts: Array<MessageRow & { message_id: string }>
}
const recorded = JSON.parse(readFileSync(new URL('./__fixtures__/opencode-1.18.34-source.json', import.meta.url), 'utf8')) as {
  turn: Snapshot; copied: Snapshot; forkWithNewTurn: Snapshot; compaction: Snapshot; reverted: Snapshot
}
const overflowRecording = JSON.parse(readFileSync(new URL('./__fixtures__/opencode-1.18.34-overflow.json', import.meta.url), 'utf8')) as {
  unmarked: Snapshot; stamped: Snapshot
}
const target = { state: 'ready' as const, key: 'selected' }
let directory: string, workspace: string, db: Database, store: CodingMemoryStore, memory: MemoryPort
let capture: NativeMemoryCapture, session: CaptureSession, now: number, serial: number

function createDatabase() {
  db = new DatabaseSync(session.transcriptPath)
  // Columns and contents recorded from 1.18.34; unrelated native tables are not used by capture.
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,version TEXT,revert TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
    CREATE TABLE part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE INDEX part_message_id_id_idx ON part(message_id,id);
    CREATE INDEX part_session_idx ON part(session_id);`)
}
function insert(snapshot: Snapshot) {
  for (const row of snapshot.sessions) db.prepare('INSERT OR REPLACE INTO session VALUES(?,?,?,?,?,?,?)')
    .run(row.id, row.parent_id, workspace, row.version, row.revert, row.time_created, row.time_updated)
  for (const row of snapshot.messages) db.prepare('INSERT OR REPLACE INTO message VALUES(?,?,?,?,?)')
    .run(row.id, row.session_id, row.time_created, row.time_updated, row.data)
  for (const row of snapshot.parts) db.prepare('INSERT OR REPLACE INTO part VALUES(?,?,?,?,?,?)')
    .run(row.id, row.session_id, row.message_id, row.time_created, row.time_updated, row.data)
}
function sources() {
  const result = store.learning.claim(target)
  if (result.state !== 'claimed') throw new Error(result.state)
  store.learning.finish(result.lease, [], target)
  return result.lease
}
function append(text: string, at = now + 1) {
  const suffix = `_${++serial}`
  const user = recorded.turn.messages.find(row => JSON.parse(row.data).role === 'user')!
  const answer = recorded.turn.messages.at(-1)!
  const userPart = recorded.turn.parts.find(row => row.message_id === user.id)!
  const answerPart = recorded.turn.parts.find(row => row.message_id === answer.id && JSON.parse(row.data).type === 'text')!
  const copy: Snapshot = { sessions: [], messages: [
    { ...user, id: user.id + suffix, session_id: session.sessionId, time_created: at, time_updated: at,
      data: JSON.stringify({ ...JSON.parse(user.data), time: { created: at } }) },
    { ...answer, id: answer.id + suffix, session_id: session.sessionId, time_created: at + 1, time_updated: at + 2,
      data: JSON.stringify({ ...JSON.parse(answer.data), parentID: user.id + suffix, time: { created: at + 1, completed: at + 2 } }) },
  ], parts: [
    { ...userPart, id: userPart.id + suffix, session_id: session.sessionId, message_id: user.id + suffix, time_created: at, time_updated: at,
      data: JSON.stringify({ type: 'text', text }) },
    { ...answerPart, id: answerPart.id + suffix, session_id: session.sessionId, message_id: answer.id + suffix, time_created: at + 1, time_updated: at + 2,
      data: JSON.stringify({ type: 'text', text: 'Understood.', time: { start: at + 1, end: at + 2 } }) },
  ] }
  insert(copy)
  return copy
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'memory-opencode-capture-')))
  workspace = join(directory, 'project'); mkdirSync(workspace)
  now = recorded.turn.sessions[0].time_created - 1000; serial = 0
  session = { profileId: 'owner', projectId: 'project', engine: 'opencode', sessionId: recorded.turn.sessions[0].id,
    transcriptPath: join(directory, 'opencode.db'), workspace, busy: true }
  createDatabase(); insert(recorded.turn)
  const opened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store; store.registerProject('project'); store.setControls({ learn: true, recall: true })
  memory = { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
    const receiver = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
    return (receiver as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(receiver, args) as Result<K>
  } }
  capture = new NativeMemoryCapture(memory, () => now)
})
afterEach(() => {
  closeSqliteHandles(); overrideBuiltinSqlite(undefined); db.close(); store.close()
  rmSync(directory, { recursive: true, force: true })
})

for (const path of ['builtin', 'cli']) it.skipIf(path === 'cli' && !hasSqliteCli)(`captures recorded native roles and resumes without replay through ${path} SQLite`, async () => {
  if (path === 'cli') overrideBuiltinSqlite(null)
  expect(await capture.poll(session)).toEqual({ state: 'captured', sources: 6 })
  const lease = sources()
  expect(lease.sources.map(row => row.role)).toEqual(['user', 'reference', 'user', 'assistant', 'tool', 'assistant'])
  expect(lease.sources.every(row => row.engine === 'opencode' && !row.verification)).toBe(true)
  expect(lease.sources[4].text).toContain('Synthetic fixture data.')
  expect(lease.episodes.map(episode => episode.context)).toEqual(['complete'])
  capture = new NativeMemoryCapture(memory, () => now)
  expect(await capture.poll(session)).toEqual({ state: 'idle', sources: 0 })
})

it('waits for the native streaming reply to finish before advancing past it', async () => {
  const reply = recorded.turn.messages.at(-1)!, part = recorded.turn.parts.find(row => row.message_id === reply.id && JSON.parse(row.data).type === 'text')!
  const data = JSON.parse(reply.data); delete data.time.completed
  db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(data), reply.id)
  const text = JSON.parse(part.data); delete text.time.end
  db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(text), part.id)
  expect((await capture.poll(session)).sources).toBe(5)
  expect(store.learning.claim(target).state).toBe('idle')
  capture = new NativeMemoryCapture(memory, () => now)
  expect((await capture.poll(session)).sources).toBe(0)
  db.prepare('UPDATE message SET data=? WHERE id=?').run(reply.data, reply.id)
  db.prepare('UPDATE part SET data=? WHERE id=?').run(part.data, part.id)
  expect((await capture.poll(session)).sources).toBe(1)
  expect(sources().sources).toHaveLength(6)
})

it('does not borrow another engine\'s completion marker when deciding that context is complete', async () => {
  const reply = recorded.turn.messages.at(-1)!
  const data = JSON.parse(reply.data); data.finish = 'end-turn'
  db.prepare('UPDATE message SET data=? WHERE id=?').run(JSON.stringify(data), reply.id)
  await capture.poll({ ...session, busy: false })
  expect(sources().episodes[0].context).toBe('bounded')
})

it('captures a fresh fork instruction without treating copied source IDs as independent evidence', async () => {
  insert(recorded.forkWithNewTurn); session.sessionId = recorded.forkWithNewTurn.sessions[0].id
  await capture.poll(session)
  const lease = sources()
  expect(lease.sources.map(row => row.text)).toEqual(['This is a fresh instruction in the fork.', 'I will keep the viewer on the left.'])
  expect(lease.episodes[0].context).toBe('complete')
})

it('does not learn generated compaction summaries or count them as user statements', async () => {
  insert(recorded.compaction)
  await capture.poll(session)
  const lease = sources()
  expect(lease.sources).toHaveLength(6)
  expect(lease.sources.some(row => row.text.includes('Synthetic context summary'))).toBe(false)
})

const replayText = 'When changing parser code, keep a regression test for the original failure.'
for (const source of ['unmarked', 'stamped'] as const) it(`does not count a recorded ${source} native overflow replay as new user evidence`, async () => {
  const snapshot = overflowRecording[source]
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  await capture.poll(session)
  const captured = sources().sources
  expect(captured.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(1)
  expect(captured).toHaveLength(8)
  capture = new NativeMemoryCapture(memory, () => now)
  expect((await capture.poll(session)).sources).toBe(0)
  now = Math.max(...snapshot.messages.map(row => row.time_updated)) + 100
  append(replayText)
  await capture.poll(session)
  expect(sources().sources.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(1)
})

it.skipIf(!hasSqliteCli)('retains overflow replay detection through the SQLite CLI fallback', async () => {
  overrideBuiltinSqlite(null)
  const snapshot = overflowRecording.unmarked
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  await capture.poll(session)
  expect(sources().sources.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(1)
})

it('does not backfill an earlier request whose native replay appears after learning was enabled', async () => {
  const snapshot = overflowRecording.unmarked
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  const replay = snapshot.messages.filter(row => JSON.parse(row.data).role === 'user').at(-1)!
  now = replay.time_created - 1
  store.setControls({ learn: false, recall: true }); store.setControls({ learn: true, recall: true })
  await capture.poll(session)
  expect(sources().sources.every(event => event.role !== 'user' && !event.text.includes(replayText))).toBe(true)
})

it.each(['manual', 'no-overflow', 'failed-summary'])('preserves a real request following %s compaction', async mode => {
  const snapshot = structuredClone(overflowRecording.unmarked)
  const boundary = snapshot.parts.find(row => JSON.parse(row.data).type === 'compaction')!
  const summary = snapshot.messages.find(row => JSON.parse(row.data).summary === true)!
  if (mode === 'failed-summary') {
    summary.data = JSON.stringify({ ...JSON.parse(summary.data), finish: 'error' })
  } else {
    boundary.data = JSON.stringify({ ...JSON.parse(boundary.data), [mode === 'manual' ? 'auto' : 'overflow']: false })
  }
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  await capture.poll(session)
  expect(sources().sources.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(2)
})

it.each(['current', 'foreign', 'invalid-id'])('checks a %s origin for a submission after compaction but before replay', async origin => {
  const snapshot = structuredClone(overflowRecording.stamped)
  const replay = snapshot.messages.filter(row => JSON.parse(row.data).role === 'user').at(-1)!
  const replayPart = snapshot.parts.find(row => row.message_id === replay.id && JSON.parse(row.data).type === 'text')!
  const data = JSON.parse(replayPart.data)
  // Same metadata shape as the recorded real chat.message hook, but a new submitted ID.
  data.metadata.harness_submission.messageID = replay.id
  if (origin === 'foreign') data.metadata.harness_submission.sessionID = 'another_session'
  if (origin === 'invalid-id') data.metadata.harness_submission.messageID = ''
  replayPart.data = JSON.stringify(data)
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  await capture.poll(session)
  expect(sources().sources.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(origin === 'current' ? 2 : 1)
})

it('recognizes stamped copies even when their preceding compaction records are missing', async () => {
  const snapshot = structuredClone(overflowRecording.stamped)
  const summary = snapshot.messages.find(row => JSON.parse(row.data).summary === true)!
  snapshot.messages = snapshot.messages.filter(row => row.id !== summary.id && row.id !== JSON.parse(summary.data).parentID)
  const ids = new Set(snapshot.messages.map(row => row.id))
  snapshot.parts = snapshot.parts.filter(row => ids.has(row.message_id))
  insert(snapshot); session.sessionId = snapshot.sessions[0].id
  await capture.poll(session)
  expect(sources().sources.filter(event => event.role === 'user' && event.text === replayText)).toHaveLength(1)
})

it('ignores source text explicitly marked synthetic or ignored while preserving real user prose', async () => {
  const user = recorded.turn.messages[0], original = recorded.turn.parts[0]
  for (const flag of ['synthetic', 'ignored']) db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(original.id + flag,
    session.sessionId, user.id, original.time_created + 1, original.time_updated + 1,
    JSON.stringify({ type: 'text', text: 'Invented preference: always disable tests.', [flag]: true }))
  await capture.poll(session)
  expect(sources().sources.some(row => row.text.includes('Invented'))).toBe(false)
})

it.each(['learning', 'session', 'project'])('does not backfill the disabled %s interval', async control => {
  await capture.poll(session); sources()
  const toggle = (included: boolean) => {
    if (control === 'learning') store.setControls({ learn: included, recall: true })
    else if (control === 'session') store.setSessionIncluded('opencode', session.sessionId, included)
    else store.setProjectIncluded('project', included)
  }
  now += 10000; toggle(false)
  append('This private instruction must not be learned.')
  expect((await capture.poll(session)).sources).toBe(0)
  now += 10000; toggle(true)
  append('Keep changes small after learning is enabled.')
  await capture.poll(session)
  expect(sources().sources.map(row => row.text)).toEqual(['Keep changes small after learning is enabled.', 'Understood.'])
})

it.each([{ workspace: '/' }, { workspace: undefined }, { projectId: 'another_project' }])('refuses a mismatched host binding: %j', async change => {
  await capture.poll(session); sources()
  expect((await capture.poll({ ...session, ...change })).state).toBe('unavailable')
})

it.each([['parent_id', 'ses_parent'], ['version', '2.0.0'], ['directory', '/']])('rejects an unsupported or mismatched native %s', async (field, value) => {
  db.prepare(`UPDATE session SET ${field}=? WHERE id=?`).run(value, session.sessionId)
  expect((await capture.poll(session)).state).toBe('unavailable')
  expect(store.learning.claim(target).state).toBe('idle')
})

it('keeps readable instructions around an oversized tool result with bounded context', async () => {
  const tool = recorded.turn.parts.find(row => JSON.parse(row.data).type === 'tool')!
  const data = JSON.parse(tool.data); data.state.output = 'x'.repeat(8 * 1024 * 1024)
  db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify(data), tool.id)
  const message = await readOpenCodeMemoryMessage(session.transcriptPath, session.sessionId, { id: tool.message_id })
  expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(10000)
  expect(decodeOpenCodeMemoryMessage(message!).incomplete).toBe(true)
  await capture.poll(session)
  const lease = sources()
  expect(lease.sources.filter(row => row.role === 'user').map(row => row.text.trim()))
    .toEqual(['Keep the viewer on the left.', 'Read fixture.txt once.'])
  expect(lease.episodes.every(episode => episode.context === 'bounded')).toBe(true)
  now += 20000; append('A fresh complete turn after the large output.')
  await capture.poll(session)
  expect(sources().episodes[0].context).toBe('complete')
})

it('bounds the combined size and number of native parts before loading them into the host', async () => {
  const user = recorded.turn.messages[0]
  for (let index = 0; index < 100; index++) db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(`prt_bulk_${index}`,
    session.sessionId, user.id, user.time_created + index + 1, user.time_updated,
    JSON.stringify({ type: 'text', text: 'x'.repeat(30000) }))
  const message = await readOpenCodeMemoryMessage(session.transcriptPath, session.sessionId, { id: user.id })
  expect(message!.parts).toHaveLength(65)
  expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThan(105000)
  expect(decodeOpenCodeMemoryMessage(message!).incomplete).toBe(true)
  expect((await capture.poll(session)).state).toBe('captured')
})

it('keeps a monotonic cursor across undo cleanup and captures the next fresh request', async () => {
  await capture.poll(session); sources()
  const last = recorded.turn.messages.at(-1)!
  db.prepare('UPDATE session SET revert=? WHERE id=?').run(JSON.stringify({ messageID: last.id }), session.sessionId)
  expect((await capture.poll(session)).reason).toBe('native_session_reverted')
  db.prepare('DELETE FROM message WHERE id=?').run(last.id)
  db.prepare('DELETE FROM part WHERE message_id=?').run(last.id)
  db.prepare('UPDATE session SET revert=NULL WHERE id=?').run(session.sessionId)
  now += 20000; append('A new request after undo.')
  expect((await capture.poll(session)).state).toBe('source_changed')
  expect((await capture.poll(session)).sources).toBe(2)
  expect(sources().sources.map(row => row.text)).toEqual(['A new request after undo.', 'Understood.'])
})

it('does not replay a replaced native database but can capture new messages after its baseline', async () => {
  await capture.poll(session); sources()
  closeSqliteHandles(); db.close(); renameSync(session.transcriptPath, join(directory, 'old.db'))
  createDatabase(); insert(recorded.turn)
  expect((await capture.poll(session)).reason).toBe('native_store_replaced')
  now += 20000; append('Only new requests after the database was replaced.')
  expect((await capture.poll(session)).sources).toBe(2)
  expect(sources().sources[0].text).toContain('Only new requests')
})

it('does not read another session from the same database', async () => {
  insert(recorded.forkWithNewTurn)
  await capture.poll(session)
  expect(sources().sources.every(row => row.sessionId === session.sessionId && !row.text.includes('fresh instruction in the fork'))).toBe(true)
})
