import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ASKS_CHARS, ASKS_LIMIT, createViewer } from '../viewer.mjs'
import { makeHome, sessionIndex } from './fixtures.mjs'

const { home, env } = makeHome()
const workspace = mkdtempSync(join(tmpdir(), 'memories-ws-'))
let viewer, port

before(async () => { viewer = createViewer({ workspace, env, home, intervalMs: 50 }); port = await viewer.start() })
after(async () => { await viewer.close() })

function get(path, { port: to = port, method = 'GET', host = `127.0.0.1:${to}`, headers = {}, until } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: to, path, method, headers: { host, ...headers } }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
        if (until && until(body)) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body }) }
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('the page is served with a policy that runs only its own scripts', async () => {
  const page = await get('/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /script-src 'self'/)
  assert.match(page.body, /<script type="module" src="app.js">/)
  const instance = /name="memories-instance" content="([0-9a-f]{12})"/.exec(page.body)?.[1]
  assert.ok(instance, 'the page knows which viewer served it')
  assert.equal(JSON.parse((await get('/api/state')).body).instance, instance, 'and the snapshot says the same, so a restart is noticed')
  for (const asset of ['/app.js', '/app.css', '/self.css', '/self.js']) assert.equal((await get(asset)).status, 200, asset)
})

test('only loopback hosts and same-origin requests are answered; nothing can be posted', async () => {
  assert.equal((await get('/api/state', { host: 'evil.example' })).status, 403)
  assert.equal((await get('/api/state', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await get('/api/state', { method: 'POST' })).status, 405)
  assert.equal((await get('/../lib/state.mjs')).status, 404)
})

test('the state: memories, agents, sessions, projects, and the header verdict', async () => {
  const state = JSON.parse((await get('/api/state')).body)
  assert.ok(state.memories.length > 10)
  assert.equal(state.sessions.asks, 4)
  assert.ok(state.projects.some((project) => project.name === 'my-app' && project.sessions === 2))
  assert.equal(state.about, null)
  const verdict = JSON.parse(readFileSync(join(workspace, '.harness', 'verdict.json'), 'utf8'))
  assert.equal(verdict.ready, true)
  assert.match(verdict.summary, /memories from 6 agents · About You not built yet/)
})

test('session search and related conversations', async () => {
  const found = JSON.parse((await get('/api/search?q=fridays')).body)
  assert.equal(found.hits.length, 1)
  assert.equal(found.hits[0].engine, 'codex')
  const state = JSON.parse((await get('/api/state')).body)
  const short = state.memories.find((row) => row.title === 'Short answers')
  const related = JSON.parse((await get(`/api/related?id=${encodeURIComponent(short.id)}`)).body)
  assert.ok(Array.isArray(related.hits))
  assert.equal((await get('/api/related?id=nope')).status, 404)
})

test('the event stream opens with a snapshot', async () => {
  const stream = await get('/events', { until: (body) => body.includes('\n\n') })
  assert.match(stream.headers['content-type'], /text\/event-stream/)
  assert.match(stream.body, /^event: snapshot\ndata: \{/)
})

test('your messages: newest first, from the session index', async () => {
  const answer = JSON.parse((await get('/api/asks')).body)
  assert.equal(answer.limit, ASKS_LIMIT)
  assert.equal(answer.maxChars, ASKS_CHARS)
  assert.deepEqual(answer.asks.map((ask) => ask.text).sort(), ['never release on fridays', 'no, too long again', 'please keep it short, tldr only', 'write the docs in plain words'], 'a turn with no ask is not a message')
  assert.ok(answer.asks.every((ask, n) => n === 0 || answer.asks[n - 1].at >= ask.at), 'newest first')
  assert.equal(answer.asks.at(-1).text, 'write the docs in plain words')
  assert.deepEqual(Object.keys(answer.asks[0]).sort(), ['at', 'cwd', 'engine', 'length', 'sessionId', 'text', 'title', 'turn'])
})

test('your messages are answered only to this pane, and only read', async () => {
  assert.equal((await get('/api/asks', { host: 'evil.example' })).status, 403)
  assert.equal((await get('/api/asks', { host: `evil.example:${port}` })).status, 403)
  assert.equal((await get('/api/asks', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await get('/api/asks', { headers: { origin: 'null' } })).status, 403)
  assert.equal((await get('/api/asks', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
  assert.equal((await get('/api/asks', { headers: { 'sec-fetch-site': 'same-site' } })).status, 403)
  assert.equal((await get('/api/asks', { headers: { 'sec-fetch-site': 'same-origin', origin: `http://127.0.0.1:${port}` } })).status, 200)
  assert.equal((await get('/api/asks', { headers: { 'sec-fetch-site': 'none' } })).status, 200)
  assert.equal((await get('/api/asks', { host: `localhost:${port}` })).status, 200)
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await get('/api/asks', { method })).status, 405, method)
  const head = await get('/api/asks', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  assert.equal(head.headers['cache-control'], 'no-store')
})

test('your messages: at most 4000, each at most 400 characters, whatever the page asks for', async () => {
  const many = mkdtempSync(join(tmpdir(), 'memories-many-'))
  const long = `${'word '.repeat(300)}end`
  sessionIndex(join(many, '.harness', 'cli', 'data'), {
    turns: Array.from({ length: ASKS_LIMIT + 150 }, (_, n) => ({ session: `s${n % 40}`, engine: n % 2 ? 'codex' : 'claude', cwd: '/work', title: 'Many', ask: n === 0 ? long : `message ${n}`, daysAgo: n / 100 })),
  })
  const other = createViewer({ env: { MEMORIES_HOME: join(many, '.harness', 'memory') }, home: many, intervalMs: 60_000 })
  const otherPort = await other.start()
  try {
    const answer = JSON.parse((await get('/api/asks?limit=999999&maxChars=999999&since=0', { port: otherPort })).body)
    assert.equal(answer.asks.length, ASKS_LIMIT)
    const first = answer.asks.find((ask) => ask.text.startsWith('word'))
    assert.equal(first.text.length, ASKS_CHARS)
    assert.equal(first.length, long.length, 'the full length is still said')
    assert.ok(answer.asks.every((ask) => ask.text.length <= ASKS_CHARS))
  } finally { await other.close() }
})

test('your messages with no session index: none, and why', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'memories-bare-'))
  const other = createViewer({ env: { MEMORIES_HOME: join(bare, '.harness', 'memory') }, home: bare, intervalMs: 60_000 })
  const otherPort = await other.start()
  try {
    const answer = JSON.parse((await get('/api/asks', { port: otherPort })).body)
    assert.deepEqual(answer.asks, [])
    assert.match(answer.error, /No session index/)
  } finally { await other.close() }
})

test('one page: the header with its switch, and Sense of Self under it; nothing else is served', async () => {
  for (const asset of ['/self.js', '/self-model.js', '/loop.js', '/memory-data.js']) {
    const answer = await get(asset)
    assert.equal(answer.status, 200, asset)
    assert.match(answer.headers['content-type'], /text\/javascript/)
  }
  assert.match((await get('/self.css')).headers['content-type'], /text\/css/)
  for (const gone of ['/markdown.js', '/fuzzy.js', '/heatmap.js', '/views.js']) assert.equal((await get(gone)).status, 404, gone)
  const page = await get('/')
  for (const id of ['q', 'count', 'switch', 'switch-button', 'stage']) assert.match(page.body, new RegExp(`id="${id}"`), id)
  for (const gone of ['list', 'preview', 'band', 'views']) assert.doesNotMatch(page.body, new RegExp(`id="${gone}"`), gone)
  assert.doesNotMatch(page.body, /<script(?![^>]*\bsrc=)/, 'no inline script')
})
