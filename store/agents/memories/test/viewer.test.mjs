import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createViewer } from '../viewer.mjs'
import { makeHome } from './fixtures.mjs'

const { home, env } = makeHome()
const workspace = mkdtempSync(join(tmpdir(), 'memories-ws-'))
let viewer, port

before(async () => { viewer = createViewer({ workspace, env, home, intervalMs: 50 }); port = await viewer.start() })
after(async () => { await viewer.close() })

function get(path, { method = 'GET', host = `127.0.0.1:${port}`, headers = {}, until } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
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
  for (const asset of ['/app.js', '/app.css', '/markdown.js', '/fuzzy.js', '/heatmap.js']) assert.equal((await get(asset)).status, 200, asset)
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
