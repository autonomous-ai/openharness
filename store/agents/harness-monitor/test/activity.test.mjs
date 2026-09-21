import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastTurnAt, lastTurns } from '../lib/activity.mjs'

const TURN = '2026-09-18T10:00:00.000Z'
const LATER = '2026-09-20T09:00:00.000Z'

async function transcript(lines) {
  const dir = await mkdtemp(join(tmpdir(), 'hps-activity-'))
  const path = join(dir, 'session.jsonl')
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n'))
  return path
}

test('the last turn wins, and bookkeeping after it is ignored', async () => {
  const path = await transcript([
    { type: 'user', timestamp: '2026-09-10T10:00:00.000Z', content: 'hello' },
    { type: 'assistant', timestamp: TURN, content: 'done' },
    { type: 'system', subtype: 'away_summary', timestamp: LATER, content: 'we were working on…' },
    { type: 'queue-operation', operation: 'enqueue', timestamp: LATER },
    { type: 'file-history-snapshot', timestamp: LATER },
  ])
  assert.equal(await lastTurnAt(path), Date.parse(TURN))
})

test('a codex rollout answers from its payload type', async () => {
  const path = await transcript([
    { type: 'session_meta', timestamp: '2026-09-10T10:00:00.000Z' },
    { type: 'response_item', payload: { type: 'message', role: 'assistant' }, timestamp: TURN },
    { type: 'event_msg', payload: { type: 'token_count' }, timestamp: LATER },
    { type: 'turn_context', timestamp: LATER },
  ])
  assert.equal(await lastTurnAt(path), Date.parse(TURN))
})

test('a transcript with no turn in it says so, rather than guessing from its mtime', async () => {
  const path = await transcript([{ type: 'system', timestamp: LATER }, { type: 'summary', timestamp: LATER }])
  assert.equal(await lastTurnAt(path), null)
})

test('a missing or unreadable file is null, never an exception', async () => {
  assert.equal(await lastTurnAt('/nope/does/not/exist.jsonl'), null)
  assert.equal(await lastTurnAt(''), null)
  assert.equal(await lastTurnAt(undefined), null)
})

test('a truncated first line is dropped rather than parsed', async () => {
  const path = await transcript([{ type: 'assistant', timestamp: TURN }])
  // A tail window that starts mid-record must not produce an answer from the fragment.
  const answer = await lastTurnAt(path)
  assert.equal(answer, Date.parse(TURN))
})

test('the cache keys on size and mtime, so an unchanged file is read once', async () => {
  const path = await transcript([{ type: 'user', timestamp: TURN }])
  const cache = new Map()
  await lastTurnAt(path, { cache })
  await lastTurnAt(path, { cache })
  assert.equal(cache.size, 1)
})

test('a fleet is read in parallel and keyed by agent id', async () => {
  const one = await transcript([{ type: 'user', timestamp: TURN }])
  const two = await transcript([{ type: 'system', timestamp: LATER }])
  const found = await lastTurns([{ id: 'a', transcriptPath: one }, { id: 'b', transcriptPath: two }, { id: 'c', transcriptPath: null }])
  assert.equal(found.get('a'), Date.parse(TURN))
  assert.equal(found.has('b'), false)
  assert.equal(found.has('c'), false)
})
