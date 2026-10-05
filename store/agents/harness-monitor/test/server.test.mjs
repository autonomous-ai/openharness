import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY, HOUR, row } from './fixtures.mjs'
import { createViewer } from '../viewer.mjs'
import { cleanupReviews } from '../lib/cleanup.mjs'

/** A viewer over a fleet that is entirely made up: no daemon, no tmux, no processes. */
async function serve(rows = [row({ id: 'a1', idleMs: 2 * DAY }), row({ id: 'a2', state: 'stopped', idleMs: 20 * DAY, rssBytes: 0 })], options = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'hps-server-'))
  // A fresh rules file and ticket book per test: tests in one file run in one process, and a pin left by
  // one test must not decide what the next one sees.
  process.env.HARNESS_MONITOR_CONFIG = join(workspace, 'config', 'policy.jsonc')
  process.env.HARNESS_MONITOR_STATE = join(workspace, 'state')
  const done = []
  const viewer = createViewer({
    workspace,
    intervalMs: 60_000,
    collect: async () => ({ rows, machines: [], problems: [], observedAt: Date.now() }),
    scan: async () => '$ ',
    verbs: {
      stop: async (target) => { done.push(['stop', target.id]); return { ok: true, id: target.id, name: target.name, action: 'stop', detail: 'engine stopped', freed: target.rssBytes, ticket: { sessionId: 'sess-0123456789ab', engine: target.engine } } },
      open: async (target) => { done.push(['open', target.id]); return { ok: true, id: target.id, name: target.name, action: 'open', reopened: true, detail: 'reopened' } },
    },
    ...options,
  })
  const port = await viewer.start()
  await viewer.observed
  return { viewer, port, workspace, done, base: `http://127.0.0.1:${port}` }
}

test('the snapshot carries the fleet, the policy and the plan', async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json()
  assert.equal(snapshot.status, 'ok')
  assert.equal(snapshot.rows.length, 2)
  assert.equal(snapshot.summary.running, 1)
  assert.equal(snapshot.policy.runningCeiling, 100)
  assert.match(snapshot.configPath, /policy\.jsonc$/, 'the pane can tell a person where the file is')
  assert.ok(snapshot.plan.find((entry) => entry.id === 'a1' && entry.action === 'stop'))
  assert.equal(snapshot.plan.find((entry) => entry.id === 'a2').action, 'keep', 'already stopped: nothing left to do')
})

test('the page is served with a token in it and a CSP that forbids inline script', async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const response = await fetch(`${base}/`)
  const html = await response.text()
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/)
  assert.equal(html.includes('__HPS_TOKEN__'), false)
  assert.match(html, new RegExp(`content="${viewer.token}"`))
  for (const path of ['/app.js', '/app.css', '/scale.js']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path)
  }
  assert.equal((await fetch(`${base}/../viewer.mjs`)).status, 404)
  assert.equal((await fetch(`${base}/monitor.json`)).status, 404)
})

test('a request for another host is refused, whatever it asks for', async (t) => {
  const { viewer, base, port } = await serve()
  t.after(() => viewer.close())
  // `fetch` will not let a caller forge Host, so this one goes out over a raw request: a page reaching
  // this server through some other name (a DNS rebind, a proxy) must not be answered.
  const forged = await new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/api/snapshot', headers: { host: 'example.com' } }, (response) => {
      response.resume(); resolve(response.statusCode)
    })
    request.end()
  })
  assert.equal(forged, 403)
  const cross = await fetch(`${base}/api/snapshot`, { headers: { origin: 'http://evil.example' } })
  assert.equal(cross.status, 403)
})

test('a write without the token does nothing', async (t) => {
  const { viewer, base, done } = await serve()
  t.after(() => viewer.close())
  const response = await fetch(`${base}/api/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'stop', ids: ['a1'] }) })
  assert.equal(response.status, 403)
  assert.deepEqual(done, [])
})

test('cleanup requires the page token, a reviewed target, and retains per-row results', async t => {
  let previews = 0, closed = 0
  const cleanup = cleanupReviews({ preview: async () => {
    previews++; return { rows: [{ id: 'hidden', name: 'Hidden session' }], kept: 2, problems: [] }
  }, close: async row => { closed++; return { ...row, ok: true, action: 'close', detail: 'Closed. History kept.' } } })
  const { viewer, base } = await serve(undefined, { cleanup })
  t.after(() => viewer.close())
  assert.equal((await fetch(`${base}/api/cleanup/preview`, { method: 'POST', body: '{}' })).status, 403)
  assert.equal(previews, 0)
  const plan = await post(base, viewer.token, '/api/cleanup/preview', {})
  assert.equal(closed, 0)
  const wrong = await post(base, viewer.token, '/api/cleanup/close', { reviewId: plan.reviewId, id: 'visible' })
  assert.match(wrong.error, /Refresh/); assert.equal(closed, 0)
  const result = await post(base, viewer.token, '/api/cleanup/close', { reviewId: plan.reviewId, id: 'hidden' })
  assert.equal(result.ok, true)
  await post(base, viewer.token, '/api/cleanup/close', { reviewId: plan.reviewId, id: 'hidden' })
  assert.equal(closed, 1)
})

test('a verb Harness Monitor does not have is refused by name', async (t) => {
  const { viewer, base, done } = await serve()
  t.after(() => viewer.close())
  const reply = await post(base, viewer.token, '/api/act', { verb: 'retire', ids: ['a1'] })
  assert.match(reply.error, /Not a verb/)
  const empty = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: [] })
  assert.match(empty.error, /at least one/)
  const unknown = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: ['nope'] })
  assert.match(unknown.error, /not in the current view/)
  assert.deepEqual(done, [])
})

test('a verb with the token acts, records a receipt, and refreshes', async (t) => {
  const { viewer, base, workspace, done } = await serve()
  t.after(() => viewer.close())
  const reply = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: ['a1'] })
  assert.equal(reply.results.length, 1)
  assert.deepEqual(done, [['stop', 'a1']])
  const tickets = await readFile(join(process.env.HARNESS_MONITOR_STATE, 'stopped.json'), 'utf8').catch(() => '{}')
  assert.deepEqual(JSON.parse(tickets), {}, 'saved lifecycle belongs to the daemon, not a second ticket book')
  const log = await readFile(join(process.env.HARNESS_MONITOR_STATE, 'log.jsonl'), 'utf8')
  assert.match(log, /"by":"pane"/)
})

test('pinning is a state edit and needs no engine at all', async (t) => {
  const { viewer, base, workspace, done } = await serve()
  t.after(() => viewer.close())
  await post(base, viewer.token, '/api/act', { verb: 'pin', ids: ['a1', 'a2'] })
  const rules = await readFile(process.env.HARNESS_MONITOR_CONFIG, 'utf8')
  assert.match(rules, /"pins": \["a1","a2"\]/, 'pins land in the rules file, where a person can see them')
  assert.match(rules, /\/\/ Most engines running at once/, 'and the comments are still there')
  assert.deepEqual(done, [])
})
test('cleanup rechecks the plan while explicit row stops remain explicit', async (t) => {
  let reads = 0
  const { viewer, base, done } = await serve(undefined, { collect: async () => ({ rows: [row({ id: 'a1', idleMs: reads++ ? 0 : 2 * DAY })], problems: [] }) })
  t.after(() => viewer.close())
  const refused = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: ['a1'] })
  assert.equal(refused.results[0].ok, false); assert.deepEqual(done, [])
  const explicit = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: ['a1'], manual: true })
  assert.equal(explicit.results[0].ok, true); assert.deepEqual(done, [['stop', 'a1']])
})
test('the reviewed conversation cannot be replaced by a newly eligible conversation', async (t) => {
  const current = row({ id: 'a1', idleMs: 2 * DAY, sessionId: 'new-conversation' })
  const { viewer, base, done } = await serve([current])
  t.after(() => viewer.close())
  for (const manual of [false, true]) {
    const reply = await post(base, viewer.token, '/api/act', { verb: 'stop', ids: ['a1'], manual,
      expected: [{ id: 'a1', sessionId: 'reviewed-conversation', lastActivity: current.lastActivity }] })
    assert.equal(reply.results[0].ok, false)
    assert.match(reply.results[0].detail, /changed since you reviewed/)
  }
  assert.deepEqual(done, [])
})

test('a policy is validated before it is written', async (t) => {
  const { viewer, base, workspace } = await serve()
  t.after(() => viewer.close())
  const bad = await post(base, viewer.token, '/api/policy', { policy: { stopAfterIdle: 'whenever' } })
  assert.match(bad.error, /Not a duration/)
  const worse = await post(base, viewer.token, '/api/policy', { policy: { stopAfterIdle: '2d', hideAfterIdle: '1d' } })
  assert.match(worse.error, /at least stopAfterIdle/)
  const good = await post(base, viewer.token, '/api/policy', { policy: { stopAfterIdle: '8h', protect: { pinned: false } } })
  assert.equal(good.policy.stopAfterIdle, '8h')
  const rules = await readFile(process.env.HARNESS_MONITOR_CONFIG, 'utf8')
  assert.match(rules, /"stopAfterIdle": "8h"/)
  assert.match(rules, /"pinned": true/, 'the pane may only change the thresholds it draws, never a guard')
})

test('permanent deletion requires one explicit target, matching identity, and a review token', async t => {
  const target = row({ id: 'a1', createdAt: 1234 }), calls = []
  const previewDelete = async target => { calls.push('review'); return { ok: true, id: target.id, reviewId: 'review-token' } }
  const deleteHarness = async (target, options) => { calls.push(options.reviewId); return { ok: true, id: target.id, deleted: true } }
  const worktreeAction = async (target, options) => { calls.push(options); return { ok: true, id: target.id, deleted: true } }
  const { viewer, base } = await serve([target], { verbs: { previewDelete, deleteHarness, worktreeAction } })
  t.after(() => viewer.close())
  const request = payload => post(base, viewer.token, '/api/act', payload)
  const approved = { ids: ['a1'], manual: true, expected: [target] }
  for (const verb of ['delete', 'delete-review', 'worktree-review', 'worktree-delete']) {
    assert.ok((await request({ verb, ids: ['a1'] })).error)
    assert.ok((await request({ ...approved, verb, ids: ['a1', 'a2'] })).error)
    const changed = await request({ ...approved, verb, reviewId: 'token', expected: [{ ...target, createdAt: 5678 }] })
    assert.equal(changed.results[0].ok, false)
  }
  assert.ok((await request({ ...approved, verb: 'delete' })).error)
  assert.deepEqual(calls, [])
  assert.equal((await request({ ...approved, verb: 'delete-review' })).results[0].reviewId, 'review-token')
  assert.equal((await request({ ...approved, verb: 'delete', reviewId: 'review-token' })).results[0].deleted, true)
  assert.equal((await request({ ...approved, verb: 'worktree-delete', reviewId: 'worktree-token', path: '/reviewed/path', discardChanges: true })).results[0].deleted, true)
  assert.deepEqual(calls, ['review', 'review-token', { reviewId: 'worktree-token', path: '/reviewed/path', discardChanges: true }])
})

test('the pane header verdict is written from the same plan the page draws', async (t) => {
  const { viewer, workspace } = await serve()
  t.after(() => viewer.close())
  const verdict = JSON.parse(await readFile(join(workspace, '.harness', 'verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(verdict.summary, /2 harnesses/)
  assert.ok(verdict.findings.length)
})

test('workspace inspection binds identity and does not refresh the fleet or write an action receipt', async t => {
  let reads = 0, inspections = 0
  const target = row({ id: 'a1', createdAt: 1234 })
  const { viewer, base } = await serve([target], {
    collect: async () => { reads++; return { rows: [target], machines: [], problems: [] } },
    verbs: { inspectWorkspace: async () => { inspections++; return { ok: true, workspace: { kind: 'main', path: '/project' } } } },
  })
  t.after(() => viewer.close())
  const request = payload => post(base, viewer.token, '/api/act', payload)
  const payload = { verb: 'workspace-inspect', ids: ['a1'], manual: true, expected: [target] }
  assert.equal((await request({ ...payload, expected: [{ ...target, createdAt: 5678 }] })).results[0].ok, false)
  assert.equal(inspections, 0)
  assert.equal((await request(payload)).results[0].workspace.path, '/project')
  assert.equal(inspections, 1); assert.equal(reads, 1)
  assert.deepEqual(viewer.snapshot().log, [])
})

test('selected deletion carries the checkboxes, full path and dirty consent to the owning operation', async t => {
  const target = row({ id: 'a1', createdAt: 1234 }), received = []
  const { viewer, base } = await serve([target], { verbs: { deleteHarness: async (row, options) => {
    received.push(options); return { ok: true, id: row.id, deleted: true, sessionDeleted: false, worktreeDeleted: true }
  } } })
  t.after(() => viewer.close())
  const selection = { reviewId: 'reviewed', choices: { sessionData: false, worktreeData: true }, path: '/full/worktree', discardChanges: true }
  assert.equal((await post(base, viewer.token, '/api/act', { verb: 'delete', ids: ['a1'], manual: true, expected: [target], ...selection })).results[0].worktreeDeleted, true)
  assert.deepEqual(received, [selection])
})

test('the stream opens with the current snapshot', async (t) => {
  const { viewer, base } = await serve()
  t.after(() => viewer.close())
  const response = await fetch(`${base}/events`)
  const reader = response.body.getReader()
  const { value } = await reader.read()
  const text = new TextDecoder().decode(value)
  assert.match(text, /^event: snapshot/)
  assert.match(text, /"status":"ok"/)
  await reader.cancel()
})

async function post(base, token, path, payload) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hps-token': token },
    body: JSON.stringify(payload),
  })
  return response.json()
}

test('the fleet is read on a tick only while a pane is connected; remote machines on their own clock', async (t) => {
  let reads = 0
  const calls = []
  const { viewer, base } = await serve(undefined, {
    intervalMs: 40,
    remoteIntervalMs: 150,
    collect: async (options) => { reads += 1; calls.push(options.remoteIntervalMs); return { rows: [], machines: [], problems: [], observedAt: Date.now() } },
  })
  t.after(() => viewer.close())
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

  await sleep(200)
  assert.equal(reads, 1, 'the start-up read, and nothing more without a pane')

  const response = await fetch(`${base}/events`)
  const reader = response.body.getReader()
  await reader.read()
  await sleep(220)
  assert.ok(reads >= 3, `a pane keeps the fleet read on a tick (${reads} reads)`)
  assert.ok(calls.slice(1).every((v) => v === 150), 'ticks hand the collector the remote clock, not a forced remote read')

  await reader.cancel()
  await sleep(60)
  const atLeave = reads
  await sleep(200)
  assert.ok(reads - atLeave <= 1, `reads stop once the last pane leaves (${reads - atLeave} more)`)

  // Refresh is the person asking: it reads now and asks the remote machines too.
  await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hps-token': viewer.token }, body: '{}' })
  assert.equal(calls.at(-1), 0, 'a refresh forces the remote read')
})
