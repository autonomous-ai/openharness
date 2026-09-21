import assert from 'node:assert/strict'
import { test } from 'node:test'
import { daemonResumes, mergeRows, parseModel, projectOf, resolveRef, summarize, tilde } from '../lib/inventory.mjs'
import { DAY, HOME, HOUR, frame, pane, row, table } from './fixtures.mjs'

const now = Date.now()
const base = { paneRows: new Map([['%1', pane()]]), table: table(), now, home: HOME }

test('a runtime profile is read back as a model and an effort', () => {
  assert.deepEqual(parseModel('runtime-v1:a1:claude:opus-5@high'), { model: 'opus-5', effort: 'high' })
  assert.deepEqual(parseModel('gpt-6-astra'), { model: 'gpt-6-astra', effort: null })
  assert.deepEqual(parseModel(null), { model: null, effort: null })
})

test('paths are shown against the home they belong to', () => {
  assert.equal(tilde(`${HOME}/code/widgets`, HOME), '~/code/widgets')
  assert.equal(tilde('/opt/thing', HOME), '/opt/thing')
  assert.equal(tilde('', HOME), '')
})

test('a project without a frame is named, not left blank', () => {
  assert.equal(projectOf({ project: null }).project, 'unknown')
  assert.equal(projectOf(frame()).project, 'widgets')
})

test('state comes from the pane and the process, not from the daemon status', () => {
  const running = mergeRows([frame()], base)[0]
  assert.equal(running.state, 'running')

  const paused = mergeRows([frame()], { ...base, table: table({ comm: '-zsh' }) })[0]
  assert.equal(paused.state, 'paused')
  assert.equal(paused.rssBytes, 0)

  const gone = mergeRows([frame()], { ...base, paneRows: new Map() })[0]
  assert.equal(gone.state, 'gone')
})

test('idle comes from the last turn, never from the transcript mtime the daemon sends', () => {
  const turns = new Map([['a1', now - 5 * DAY]])
  const rows = mergeRows([frame({ updatedAt: now })], { ...base, turns, registry: new Map() })
  assert.equal(rows[0].idleMs, 5 * DAY)
  assert.equal(rows[0].idle, '5d')
})

test('with no turn to read, the daemon last hook is next, and registration last', () => {
  const registry = new Map([['a1', { lastHookAt: now - 2 * HOUR, transcriptPath: '/nope' }]])
  assert.equal(mergeRows([frame()], { ...base, registry })[0].idleMs, 2 * HOUR)
  const created = now - 9 * DAY
  const bare = mergeRows([frame({ createdAt: created })], { ...base, registry: new Map() })[0]
  assert.equal(bare.idleMs, now - created)
})

test('a remote row is marked, and carries no local facts it cannot know', () => {
  const rows = mergeRows([frame()], { ...base, local: false, machine: { name: 'studio', machineId: 'm2' } })
  assert.equal(rows[0].local, false)
  assert.equal(rows[0].machine, 'studio')
  assert.equal(rows[0].rssBytes, 0)
  assert.equal(rows[0].enginePid, null)
  assert.equal(rows[0].state, 'running') // the daemon's word for it is all there is
})

test('working is a refusal signal, and CPU or a fresh turn is enough for it', () => {
  const busy = mergeRows([frame()], { ...base, table: table({ cpu: 40 }), turns: new Map([['a1', now - 9 * DAY]]) })[0]
  assert.equal(busy.working, true)
  const quiet = mergeRows([frame()], { ...base, paneRows: new Map([['%1', pane({ lastOutput: now - 4 * HOUR })]]), turns: new Map([['a1', now - 9 * DAY]]) })[0]
  assert.equal(quiet.working, false)
})

test('the summary counts what the gauges show', () => {
  const rows = [row({ id: 'a' }), row({ id: 'b', state: 'paused', rssBytes: 0 }), row({ id: 'c', state: 'gone', rssBytes: 0 }), row({ id: 'd', needsInput: true })]
  const summary = summarize(rows)
  assert.equal(summary.total, 4)
  assert.equal(summary.running, 2)
  assert.equal(summary.paused, 1)
  assert.equal(summary.gone, 1)
  assert.equal(summary.needsInput, 1)
  assert.equal(summary.held, 800 * 1024 * 1024)
})

test('a ref is a row number, a pane, an id prefix, a name, or a unique substring', () => {
  const rows = [row({ id: 'abc123', name: 'widgets', title: 'Fix the reconciler' }), row({ id: 'def456', name: 'gadgets', pane: '%9', title: 'Ship the thing' })]
  assert.equal(resolveRef('1', rows).row.id, 'abc123')
  assert.equal(resolveRef('%9', rows).row.id, 'def456')
  assert.equal(resolveRef('abc', rows).row.id, 'abc123')
  assert.equal(resolveRef('gadgets', rows).row.id, 'def456')
  assert.equal(resolveRef('reconciler', rows).row.id, 'abc123')
  assert.match(resolveRef('3', rows).error, /no row 3/)
  assert.match(resolveRef('%7', rows).error, /pane %7/)
  assert.match(resolveRef('gets', rows).error, /matches 2 harnesses/)
  assert.match(resolveRef('', rows).error, /Name a harness/)
})

test('a paused row describes itself from the ticket the daemon threw away', () => {
  // Measured against a real pause: the daemon rewrites the row as a terminal and keeps only the cwd.
  const released = frame({ engine: 'terminal', sessionId: '', title: null, name: 'e2e-project' })
  const state = { pins: [], retired: {}, paused: { a1: { at: now - 2 * HOUR, sessionId: 'sess-0123456789ab', engine: 'claude', pane: '%1', title: 'Fix the reconciler' } } }
  const paused = mergeRows([released], { ...base, table: table({ comm: '-zsh' }), state })[0]
  assert.equal(paused.state, 'paused')
  assert.equal(paused.engine, 'claude')
  assert.equal(paused.title, 'Fix the reconciler')
  assert.equal(paused.sessionId, 'sess-0123456789ab')
  assert.equal(paused.pausedAt, now - 2 * HOUR)
})

test('a shell nobody paused is a shell, not a paused agent', () => {
  const shell = frame({ engine: 'terminal', sessionId: '', title: null })
  const row = mergeRows([shell], { ...base, table: table({ comm: '-zsh' }) })[0]
  assert.equal(row.state, 'terminal')
  assert.equal(summarize([row]).terminals, 1)
  assert.equal(summarize([row]).paused, 0)
})

test('a harness the daemon saved is paused, has no pane, and comes back through the daemon', () => {
  const saved = frame({ status: 'stopped', tmuxPane: null, sessionId: 'sess-0123456789ab', engine: 'claude' })
  const stopped = new Map([['a1', { agentId: 'a1', transcriptPath: '/nope', lastHookAt: now - 3 * DAY }]])
  const row = mergeRows([saved], { ...base, stopped })[0]
  assert.equal(row.state, 'paused')
  assert.equal(row.saved, true)
  assert.equal(row.pane, null)
  assert.equal(row.rssBytes, 0)
  assert.equal(row.resumeVia, 'daemon')
  assert.equal(row.idleMs, 3 * DAY, 'idle comes from the saved record, not from now')
})

test('a saved harness on an engine the daemon cannot resume is shown, and marked as stuck', () => {
  const saved = frame({ status: 'stopped', tmuxPane: null, engine: 'opencode' })
  const row = mergeRows([saved], base)[0]
  assert.equal(row.state, 'paused')
  assert.equal(row.resumable, false)
  assert.equal(row.resumeVia, null)
})

test('on a daemon with agent_resume, only Claude Code and Codex with a bound conversation are pausable', () => {
  // Each one running, in a pane of its own.
  const engines = { c: 'claude', x: 'codex', o: 'opencode', u: 'claude' }
  const paneRows = new Map(Object.keys(engines).map((id, i) => [`%${i + 1}`, pane({ pane: `%${i + 1}`, pid: 100 + i })]))
  const byPid = new Map(Object.entries(engines).map(([id, engine], i) => [100 + i, { pid: 100 + i, ppid: 1, rss: 1e8, cpu: 0, comm: `/usr/local/bin/${engine}` }]))
  const rows = mergeRows([
    frame({ id: 'c', engine: 'claude', sessionId: 'sess-0123456789ab', tmuxPane: '%1' }),
    frame({ id: 'x', engine: 'codex', sessionId: 'sess-abcdef012345', tmuxPane: '%2' }),
    frame({ id: 'o', engine: 'opencode', sessionId: 'sess-fedcba987654', tmuxPane: '%3' }),
    frame({ id: 'u', engine: 'claude', sessionId: '', tmuxPane: '%4' }),
  ], { ...base, paneRows, table: { byPid, children: new Map() }, daemonResume: true })
  assert.ok(rows.every((r) => r.state === 'running'))
  const by = Object.fromEntries(rows.map((r) => [r.id, r.resumeVia]))
  assert.deepEqual(by, { c: 'daemon', x: 'daemon', o: null, u: null })
})

test('a harness paused before the daemon could save it still comes back the old way', () => {
  const released = frame({ engine: 'terminal', sessionId: '' })
  const state = { pins: [], paused: { a1: { sessionId: 'sess-0123456789ab', engine: 'claude', pane: '%1' } } }
  const row = mergeRows([released], { ...base, table: table({ comm: '-zsh' }), state, daemonResume: true })[0]
  assert.equal(row.state, 'paused')
  assert.equal(row.resumeVia, 'legacy', 'agent_resume would attach to the shell and call it success, so it must not be used here')
})

test('the capability probe reads the daemon\'s own answer, and caches it', async () => {
  let asked = 0
  const has = async () => { asked += 1; const error = new Error('x'); error.code = 'MISSING_AGENT_ID'; throw error }
  const lacks = async () => { const error = new Error('x'); error.code = 'UNSUPPORTED'; throw error }
  assert.equal(await daemonResumes('m-new', { ask: has, now: 1 }), true)
  assert.equal(await daemonResumes('m-new', { ask: has, now: 2 }), true)
  assert.equal(asked, 1, 'asked once a minute, not once a refresh')
  assert.equal(await daemonResumes('m-old', { ask: lacks, now: 1 }), false)
})

test('a closed Terminal the daemon saved is a shell, not a paused harness', () => {
  const row = mergeRows([frame({ status: 'stopped', tmuxPane: null, engine: 'terminal' })], base)[0]
  assert.equal(row.state, 'terminal')
  assert.equal(row.resumable, false)
})
