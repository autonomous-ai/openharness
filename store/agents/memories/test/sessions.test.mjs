import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { asks, folders, ftsQuery, openIndex, overview, search } from '../lib/sessions.mjs'
import { projectsFor } from '../lib/state.mjs'
import { DAY, makeHome, sessionIndex } from './fixtures.mjs'

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

test("Harness's own sessions are placed by their folder and named by their harness, beside the ones it did not start", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memories-harness-rows-'))
  const app = join(dir, 'code', 'my-app')
  const worktree = join(app, '.claude', 'worktrees', 'quiet-otter')
  // As the CLI indexes them: a harness's row has its agent, its header, its title and folder, and no
  // origin; one Harness did not start has no agent and says where it ran. A row indexed before Harness
  // rows carried a folder (the CLI fills it in on its next sweep) still counts, in no folder.
  sessionIndex(dir, {
    now,
    turns: [
      { session: 'h1', engine: 'claude', agent: 'agent-1', header: 'Claude · Fix login · code my-app', cwd: app, title: 'Fix login', ask: 'the login token expires early', daysAgo: 0 },
      { session: 'h1', engine: 'claude', ask: 'keep the old cookie name', daysAgo: 0 },
      { session: 'h2', engine: 'claude', agent: 'agent-2', header: 'Claude · Release · quiet-otter worktrees', cwd: worktree, title: 'Release', ask: 'tag the release', daysAgo: 1 },
      { session: 'e1', engine: 'codex', agent: '', origin: 'terminal', cwd: app, title: 'Docs pass', ask: 'write the login docs', daysAgo: 2 },
      { session: 'old', engine: 'claude', agent: 'agent-3', header: 'Claude · Old', ask: 'from before the folders', daysAgo: 3 },
    ],
  })
  const { db } = await openIndex(dir)
  assert.ok(db)
  const here = folders(db).find((folder) => folder.cwd === app)
  assert.deepEqual([here.sessions, here.asks, here.engines], [2, 3, { claude: 2, codex: 1 }])
  assert.ok(!folders(db).some((folder) => folder.cwd === ''), 'a row with no folder yet is in none')
  assert.equal(overview(db, { now }).asks, 5)
  assert.deepEqual(asks(db, { since: 0, cwd: app }).map((row) => [row.sessionId, row.title]).sort(),
    [['e1', 'Docs pass'], ['h1', 'Fix login'], ['h1', 'Fix login']])
  assert.deepEqual(search(db, 'login').map((hit) => [hit.sessionId, hit.title, hit.cwd]).sort(),
    [['e1', 'Docs pass', app], ['h1', 'Fix login', app]])
  // The project's memories, and the harness in its worktree, count together.
  const [project] = projectsFor([{ id: 'claude:x.md', project: { name: 'my-app', path: app } }], folders(db), dir)
  assert.deepEqual([project.sessions, project.asks, project.engines], [3, 4, { claude: 3, codex: 1 }])
  db.close()
})
