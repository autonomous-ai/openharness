/**
 * Search: conversations found by the daemon's session search (Cmd-P's), labeled from the index here, with the
 * package's own search when no daemon answers; and the words around where a search found a conversation.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { createViewer } from '../viewer.mjs'
import { makeHome } from './fixtures.mjs'

const { home, env } = makeHome()
const workspace = mkdtempSync(join(tmpdir(), 'memories-search-'))

/** A daemon as the bridge reaches it: what it was asked, and what it answers. */
const daemon = { reports: 0, asked: [], answer: () => ({ hits: [] }), machines: [{ machineId: 'here', name: 'studio', current: true, online: true }] }
const fleet = {
  machinesReport: async () => { daemon.reports++; return { machines: daemon.machines } },
  request: async (machineId, type, payload) => {
    if (type !== 'session_search') return {}
    daemon.asked.push({ machineId, type, payload })
    return daemon.answer(payload)
  },
}
let viewer, port
before(async () => { viewer = createViewer({ workspace, env, home, intervalMs: 60_000, fleetIntervalMs: 3_600_000, idleFleetIntervalMs: 3_600_000, fleet }); port = await viewer.start() })
after(async () => { await viewer.close() })
beforeEach(() => {
  daemon.asked = []
  daemon.answer = () => ({ hits: [] })
  daemon.machines = [{ machineId: 'here', name: 'studio', current: true, online: true }]
})

function get(path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('asks the daemon, as Cmd-P does, and labels its hits from the index here', async () => {
  daemon.answer = () => ({ hits: [
    { sessionId: 's1', agentId: 'agent-s1', engine: 'claude', turn: 1, at: 5, lastAt: 9, field: 'ask', snippet: 'no,  too \u0002long\u0003 again', together: true, score: 1 },
    { sessionId: 'outside', agentId: '', engine: 'codex', turn: 0, at: null, lastAt: 7, field: 'ask', snippet: 'x', external: { title: 'Their own title', cwd: '/w', origin: 'terminal' } },
    { sessionId: 'unknown', engine: 'grok', turn: 'x', snippet: null },
    { agentId: 'no-session' },
  ] })
  const { body } = await get('/api/search?q=too%20long')
  assert.deepEqual(daemon.asked.map(({ machineId, type, payload }) => [machineId, type, payload]), [['here', 'session_search', { query: 'too long', limit: 20 }]])
  assert.deepEqual(body.hits[0], { sessionId: 's1', turn: 1, at: 5, engine: 'claude', title: 'Fix login', cwd: body.hits[0].cwd, snippet: 'no, too \u0002long\u0003 again' })
  assert.match(body.hits[0].cwd, /my-app$/)
  assert.deepEqual([body.hits[1].title, body.hits[1].cwd, body.hits[1].at], ['Their own title', '/w', 7])
  assert.deepEqual(body.hits[2], { sessionId: 'unknown', turn: -1, at: null, engine: 'grok', title: '', cwd: '', snippet: '' })
  assert.equal(body.hits.length, 3)
  // The machine is looked up once, not on every keystroke.
  const before = daemon.reports
  await get('/api/search?q=again')
  assert.equal(daemon.reports, before)
})

test('without a daemon that answers, finds with its own search, and looks for the machine again next time', async () => {
  daemon.answer = () => { throw new Error('the bridge is down') }
  const failed = (await get('/api/search?q=fridays')).body
  assert.equal(failed.hits.length, 1)
  assert.equal(failed.hits[0].engine, 'codex')
  const before = daemon.reports
  daemon.answer = () => ({ error: 'UNSUPPORTED' })
  assert.equal((await get('/api/search?q=fridays')).body.hits.length, 1)
  assert.equal(daemon.reports, before + 1)
  daemon.machines = [{ machineId: 'elsewhere', current: false }]
  daemon.answer = () => { throw new Error('forget the machine') }
  await get('/api/search?q=fridays')
  assert.equal((await get('/api/search?q=fridays')).body.hits.length, 1)
  assert.equal(daemon.asked.filter((ask) => ask.machineId === 'elsewhere').length, 0)
})

test('related conversations want any of the words, so they stay with its own search', async () => {
  const state = (await get('/api/state')).body
  const short = state.memories.find((row) => row.title === 'Short answers')
  const related = (await get(`/api/related?id=${encodeURIComponent(short.id)}`)).body
  assert.ok(Array.isArray(related.hits))
  assert.equal(daemon.asked.length, 0)
})

test('the words around a hit: its turn and the ones before it, or a conversation\'s last ones, read from the index', async () => {
  const at = (await get('/api/conversation?sessionId=s1&turn=1')).body
  assert.equal(at.title, 'Fix login')
  assert.deepEqual(at.turns.map((turn) => [turn.turn, turn.ask]), [[0, 'please keep it short, tldr only'], [1, 'no, too long again']])
  const last = (await get('/api/conversation?sessionId=s1')).body
  assert.deepEqual(last.turns.map((turn) => turn.turn), [0, 1])
  assert.deepEqual((await get('/api/conversation?sessionId=nope&turn=0')).body.turns, [])
  assert.deepEqual((await get('/api/conversation')).body, { turns: [] })
  assert.equal((await get('/api/conversation?sessionId=s1', 'evil.example')).status, 403)
})
