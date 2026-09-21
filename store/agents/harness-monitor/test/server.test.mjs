import assert from 'node:assert/strict'
import { test } from 'node:test'
import http from 'node:http'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAY, HOUR, row } from './fixtures.mjs'
import { createViewer } from '../viewer.mjs'

/** A viewer over a fleet that is entirely made up: no daemon, no tmux, no processes. */
async function serve(rows = [row({ id: 'a1', idleMs: 2 * DAY }), row({ id: 'a2', state: 'paused', idleMs: 20 * DAY, rssBytes: 0 })], options = {}) {
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
      pause: async (target) => { done.push(['pause', target.id]); return { ok: true, id: target.id, name: target.name, action: 'pause', detail: 'engine stopped', freed: target.rssBytes, ticket: { sessionId: 'sess-0123456789ab', engine: target.engine } } },
      resume: async (target) => { done.push(['resume', target.id]); return { ok: true, id: target.id, name: target.name, action: 'resume', resumed: true, detail: 'resumed' } },
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
  assert.ok(snapshot.plan.find((entry) => entry.id === 'a1' && entry.action === 'pause'))
  assert.equal(snapshot.plan.find((entry) => entry.id === 'a2').action, 'keep', 'already paused: nothing left to do')
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
  const response = await fetch(`${base}/api/act`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'pause', ids: ['a1'] }) })
  assert.equal(response.status, 403)
  assert.deepEqual(done, [])
})

test('a verb Harness Monitor does not have is refused by name', async (t) => {
  const { viewer, base, done } = await serve()
  t.after(() => viewer.close())
  const reply = await post(base, viewer.token, '/api/act', { verb: 'retire', ids: ['a1'] })
  assert.match(reply.error, /Not a verb/)
  const empty = await post(base, viewer.token, '/api/act', { verb: 'pause', ids: [] })
  assert.match(empty.error, /at least one/)
  const unknown = await post(base, viewer.token, '/api/act', { verb: 'pause', ids: ['nope'] })
  assert.match(unknown.error, /not in the current view/)
  assert.deepEqual(done, [])
})

test('a verb with the token acts, records a receipt, and refreshes', async (t) => {
  const { viewer, base, workspace, done } = await serve()
  t.after(() => viewer.close())
  const reply = await post(base, viewer.token, '/api/act', { verb: 'pause', ids: ['a1'] })
  assert.equal(reply.results.length, 1)
  assert.deepEqual(done, [['pause', 'a1']])
  const tickets = JSON.parse(await readFile(join(process.env.HARNESS_MONITOR_STATE, 'paused.json'), 'utf8'))
  assert.ok(tickets.a1, 'the resume ticket was written down')
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

test('a policy is validated before it is written', async (t) => {
  const { viewer, base, workspace } = await serve()
  t.after(() => viewer.close())
  const bad = await post(base, viewer.token, '/api/policy', { policy: { pauseAfterIdle: 'whenever' } })
  assert.match(bad.error, /Not a duration/)
  const worse = await post(base, viewer.token, '/api/policy', { policy: { pauseAfterIdle: '2d', hideAfterIdle: '1d' } })
  assert.match(worse.error, /at least pauseAfterIdle/)
  const good = await post(base, viewer.token, '/api/policy', { policy: { pauseAfterIdle: '8h', protect: { pinned: false } } })
  assert.equal(good.policy.pauseAfterIdle, '8h')
  const rules = await readFile(process.env.HARNESS_MONITOR_CONFIG, 'utf8')
  assert.match(rules, /"pauseAfterIdle": "8h"/)
  assert.match(rules, /"pinned": true/, 'the pane may only change the thresholds it draws, never a guard')
})

test('the pane header verdict is written from the same plan the page draws', async (t) => {
  const { viewer, workspace } = await serve()
  t.after(() => viewer.close())
  const verdict = JSON.parse(await readFile(join(workspace, '.harness', 'verdict.json'), 'utf8'))
  assert.equal(verdict.ready, false)
  assert.match(verdict.summary, /2 harnesses/)
  assert.ok(verdict.findings.length)
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

test('the page arrives with the current fleet in it, and a title cannot break out of the data block', async (t) => {
  const hostile = row({ id: 'x1', title: '</script><script>alert(1)</script>' })
  const { viewer, base } = await serve([hostile])
  t.after(() => viewer.close())
  const html = await (await fetch(`${base}/`)).text()
  const block = html.match(/<script type="application\/json" id="initial-snapshot">([\s\S]*?)<\/script>/)
  assert.ok(block, 'the data block is there and closes where it should')
  assert.equal(block[1].includes('</script>'), false)
  assert.equal(JSON.parse(block[1]).rows[0].title, '</script><script>alert(1)</script>', 'and the title survives intact')
})
