import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { asks, ftsQuery, openIndex, overview, search } from '../lib/sessions.mjs'
import { DAY, makeHome } from './fixtures.mjs'

const now = Date.now()
const { home, project } = makeHome({ now })
const index = await openIndex(join(home, '.harness', 'cli', 'data'))

test('a missing index is a plain explanation, not an exception', async () => {
  const missing = await openIndex(mkdtempSync(join(tmpdir(), 'memories-noindex-')))
  assert.equal(missing.db, undefined)
  assert.match(missing.error, /No session index/)
})

test('the index opens read-only', () => {
  assert.ok(index.db)
  assert.throws(() => index.db.exec('CREATE TABLE x (a)'), /readonly/)
})

test('overview: totals per agent, your messages per day, folders', () => {
  const view = overview(index.db, { now })
  assert.equal(view.sessions, 4)
  assert.equal(view.asks, 4, 'a turn with no message from you is not counted')
  assert.deepEqual(view.engines.map((row) => [row.engine, row.asks]), [['claude', 2], ['codex', 2], ['hermes', 0]])
  assert.ok(view.activity.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day)))
  const here = view.folders.find((folder) => folder.cwd === project)
  assert.deepEqual(here.engines, { claude: 2, codex: 1 })
})

test('asks: your own messages, newest first, filtered', () => {
  const all = asks(index.db, { since: 0 })
  assert.equal(all.length, 4)
  assert.ok(all[0].at >= all[1].at)
  assert.deepEqual(asks(index.db, { since: now - 7 * DAY }).map((row) => row.engine).sort(), ['claude', 'claude', 'codex'])
  assert.equal(asks(index.db, { since: 0, engine: 'codex' }).length, 2)
  assert.equal(asks(index.db, { since: 0, maxChars: 40 })[0].text.length <= 40, true)
})

test('search: any typed text is a safe query, one hit per conversation', () => {
  for (const nasty of ['"', 'AND OR NOT', 'NEAR(', 'col:value', '*', '()', "o'brien"]) assert.doesNotThrow(() => search(index.db, nasty))
  assert.equal(ftsQuery('Keep it short!'), '"keep"* "it"* "short"*')
  const hits = search(index.db, 'short')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].sessionId, 's1')
  assert.match(hits[0].snippet, /\u0002short\u0003/)
  assert.equal(search(index.db, 'fridays docs', { any: true }).length, 2)
})
