/** Sense of Self without a browser: the render loop, the data it reads, and the mind it draws. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agent, createMemoryData, refs } from '../viewer/memory-data.js'
import { createLoop } from '../viewer/loop.js'
import { buildMind, recallMatch } from '../viewer/self-model.js'
import { snapshot } from '../lib/state.mjs'
import { asks as readAsks, openIndex } from '../lib/sessions.mjs'
import { homes } from '../lib/agents.mjs'
import { growHome, makeHome } from './fixtures.mjs'

// ── loop.js: one loop, only while visible, asleep when nothing moves ────────────────────────────

/** Frames that run only when the test says so. */
function frames() {
  let next = 1
  const queued = new Map()
  return {
    frame: (fn) => { const id = next++; queued.set(id, fn); return id },
    cancelFrame: (id) => queued.delete(id),
    pending: () => queued.size,
    run(times = 1, at = 1000) { for (let n = 0; n < times; n++) { const batch = [...queued.values()]; queued.clear(); for (const fn of batch) fn(at + n * 16) } },
  }
}

test('the loop draws only while the tab is visible', () => {
  let hide = false
  const clock = frames()
  const loop = createLoop({ frame: clock.frame, cancelFrame: clock.cancelFrame, hidden: () => hide })
  let drawn = 0
  loop.set(() => { drawn++; return true })
  clock.run(3)
  assert.equal(drawn, 0, 'nothing before the pane says the tab is visible')
  loop.start()
  clock.run(3)
  assert.equal(drawn, 3)
  assert.equal(clock.pending(), 1, 'one frame at a time')
  loop.stop()
  assert.equal(clock.pending(), 0, 'hidden: the frame waiting is cancelled')
  clock.run(5)
  assert.equal(drawn, 3)
  hide = true
  loop.start()
  assert.equal(clock.pending(), 0, 'a hidden document gets no frame even when asked')
  hide = false
  loop.wake()
  clock.run(2)
  assert.equal(drawn, 5)
})

test('a scene with nothing moving sleeps until woken, and one that throws stops', () => {
  const clock = frames()
  const errors = []
  const loop = createLoop({ frame: clock.frame, cancelFrame: clock.cancelFrame, hidden: () => false, report: (error) => errors.push(error) })
  let moving = 2
  let drawn = 0
  loop.start()
  loop.set((at, dt) => { drawn++; assert.ok(dt >= 0 && dt <= 0.1); return moving-- > 0 })
  clock.run(10)
  assert.equal(drawn, 3, 'two frames moving, then one that says it is still')
  assert.equal(clock.pending(), 0)
  loop.wake(); loop.wake()
  assert.equal(clock.pending(), 1, 'waking twice is one frame')
  loop.set(() => { throw new Error('draw') })
  clock.run(3)
  assert.deepEqual(errors.map((error) => error.message), ['draw'])
  assert.equal(clock.pending(), 0)
})

// ── self-model.js: the mind Sense of Self draws ─────────────────────────────────────────────────

async function mindOf(made) {
  const snap = await snapshot({ env: made.env, home: made.home, now: Date.now() })
  const index = await openIndex(homes(made.env, made.home).harnessData)
  const asks = index.db ? readAsks(index.db, { limit: 4000, maxChars: 400 }) : []
  index.db?.close()
  return { snap, asks, mind: buildMind({ snapshot: snap, asks }, { agent, refs }) }
}

test('a real-sized home: every memory in the lake, every line a belief held up by what it cites', async () => {
  const made = growHome(makeHome())
  const started = performance.now()
  const { snap, asks, mind } = await mindOf(made)
  const built = performance.now() - started
  assert.equal(asks.length, 4000)
  assert.ok(snap.memories.length >= 100, `${snap.memories.length} memories`)
  assert.equal(mind.orbs.length, snap.memories.length, 'every memory is an orb')
  assert.equal(mind.beliefs.length, 25)
  assert.deepEqual(mind.sections.map((s) => s.name), ['How you work', 'What you want from agents', 'Taste', 'Engineering principles', 'Right now'])
  assert.ok(mind.beliefs.every((b) => b.mems.length === 2 && b.askN > 0 && b.motes.length > 0), 'each belief: its two memories and its messages')
  assert.ok(mind.orbs.some((o) => !o.beliefs.length), 'memories that hold up no belief stay in the lake')
  assert.equal(mind.motes.n, 4000)
  // Messages gather over their project: its folder, a folder in a worktree of it.
  const payments = mind.columns.find((c) => c.name === 'payments')
  assert.ok(payments.asks > 300 && payments.orbs.length >= 10, `payments: ${payments.asks} messages, ${payments.orbs.length} memories`)
  const placed = mind.motes.col.filter(Boolean).length
  assert.ok(placed > 3900, `${placed} of 4000 messages placed in a project`)
  assert.ok(built < 5000, `built in ${Math.round(built)} ms`)
})

test('recall: memories by every word, your messages, and the beliefs they stir', async () => {
  const { mind } = await mindOf(growHome(makeHome()))
  const found = recallMatch(mind, 'release train payments')
  assert.ok(found.mems.length >= 1 && found.mems[0].m.title === 'Release train', found.mems.map((o) => o.m.title).join(', '))
  assert.ok(found.mems.every((o) => o.lp === 'payments' || o.lb.includes('payments')))
  const words = recallMatch(mind, 'refund flow')
  assert.ok(words.local.length > 50, `${words.local.length} messages`)
  assert.ok(words.direct.some((b) => b.text.includes('refund')), 'a belief that says it')
  assert.ok(words.beliefs.size >= words.direct.length)
  assert.ok(words.local.every((i, n) => n === 0 || mind.asks[words.local[n - 1]].at >= mind.asks[i].at), 'newest first')
  assert.deepEqual(recallMatch(mind, ' ').mems, [])
})

test('the quiet homes: no About You yet, and nothing at all', async () => {
  const fresh = await mindOf(makeHome())
  assert.equal(fresh.mind.beliefs.length, 0, 'no About You: no beliefs, and the scene says how to build one')
  assert.ok(fresh.mind.orbs.length > 10)
  assert.ok(fresh.mind.orbs.some((o) => o.lb.includes('<img src=x')), 'hostile text is still just a memory')
  const empty = buildMind({ snapshot: { memories: [], agents: [], projects: [] }, asks: [] }, { agent, refs })
  assert.deepEqual([empty.orbs.length, empty.beliefs.length, empty.motes.n, empty.columns.length], [0, 0, 0, 0])
  const odd = buildMind({ snapshot: { about: { lines: [{ text: 'Cites nothing here.', refs: ['claude:gone.md', 'session:abc', 'asks:3'] }, { text: '  ' }] } }, asks: [] }, { agent, refs })
  assert.equal(odd.beliefs.length, 1)
  assert.deepEqual(odd.beliefs[0].threads.map((th) => th.kind), ['asks', 'session', 'missing'])
})

// ── memory-data.js: the MemoryData interface over this viewer's routes ──────────────────────────

const SNAP = {
  memories: [
    { id: 'claude:.claude/projects/x/memory/short-answers.md', agent: 'claude', title: 'Short answers', path: '~/.claude/projects/x/memory/short-answers.md' },
    { id: 'claude:.claude/projects/x/memory/b.md', agent: 'claude', title: 'Merge when green', path: '~/.claude/projects/x/memory/b.md' },
    { id: 'codex:.codex/memories/MEMORY.md#1', agent: 'codex', title: 'Testing', path: '~/.codex/memories/MEMORY.md' },
  ],
  agents: [{ id: 'claude', name: 'Claude Code', color: '#d97757' }],
  sessions: { asks: 4 },
}

function fakeFetch(routes) {
  const calls = []
  const fetch = async (path) => {
    calls.push(path)
    const route = Object.keys(routes).find((prefix) => path.startsWith(prefix))
    if (!route) return { ok: false, status: 404, json: async () => ({}) }
    const value = await routes[route](path)
    return { ok: true, status: 200, json: async () => value }
  }
  return { fetch, calls }
}

test('load: the snapshot the pane received, and your messages read once', async () => {
  const { fetch, calls } = fakeFetch({ '/api/asks': () => ({ asks: [{ at: 1, text: 'hi' }] }) })
  const data = createMemoryData({ fetch, graceMs: 10_000 })
  const loading = data.load()
  data.receive(SNAP)
  const loaded = await loading
  assert.equal(loaded.snapshot, SNAP)
  assert.deepEqual(loaded.asks, [{ at: 1, text: 'hi' }])
  assert.equal(loaded.real, true)
  assert.equal(loaded.asksError, null)
  await data.load()
  assert.deepEqual(calls, ['/api/asks'], 'no /api/state while /events delivers, and the messages once')
  data.receive({ ...SNAP, observedAt: 2 })
  await data.load()
  assert.equal(calls.length, 1, 'a new snapshot with the same messages: not read again')
  data.receive({ ...SNAP, sessions: { asks: 5 } })
  await data.load()
  assert.equal(calls.length, 2, 'new messages: read again')
})

test('load: no snapshot from /events in time, so /api/state', async () => {
  const { fetch, calls } = fakeFetch({ '/api/state': () => SNAP, '/api/asks': () => ({ asks: [], error: 'No session index on this computer yet.' }) })
  const data = createMemoryData({ fetch, graceMs: 5 })
  const [a, b] = await Promise.all([data.load(), data.load()])
  assert.equal(a.snapshot.memories.length, 3)
  assert.equal(b.snapshot, a.snapshot)
  assert.equal(a.asksError, 'No session index on this computer yet.')
  assert.deepEqual(calls, ['/api/state', '/api/asks'], 'two loads, one read of each')
  const viaPane = createMemoryData({ fetch: async () => { throw new Error('not this') }, graceMs: 5, fallback: async () => ({ ...SNAP, from: 'pane' }) })
  assert.equal((await viaPane.load()).snapshot.from, 'pane', 'the pane’s own read, through its instance check')
  const failing = createMemoryData({ fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), graceMs: 5 })
  await assert.rejects(failing.load(), /503/)
})

test('search: one question asked once, shared by every view', async () => {
  let answers = 0
  const { fetch, calls } = fakeFetch({ '/api/search': () => ({ q: 'x', hits: [{ sessionId: `s${++answers}` }] }) })
  const data = createMemoryData({ fetch })
  data.receive(SNAP)
  assert.deepEqual(await data.search('  '), [])
  assert.equal(calls.length, 0)
  const [one, two] = await Promise.all([data.search('release'), data.searchAnswer('release ')])
  assert.deepEqual(one, two.hits)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], '/api/search?q=release')
  data.receive({ ...SNAP, sessions: { asks: 9 } })
  await data.search('release')
  assert.equal(calls.length, 2, 'new messages: asked again')
  for (let n = 0; n < 12; n++) await data.search(`q${n}`)
  await data.search('release')
  assert.equal(calls.length, 2 + 12 + 1, 'only the last few questions are kept')
  const down = createMemoryData({ fetch: async () => { throw new Error('offline') } })
  assert.deepEqual(await down.searchAnswer('x'), { q: 'x', hits: [], error: 'Search is not available right now.' })
})

test('refs and agents, as the prototypes read them', () => {
  const line = { refs: ['claude:short-answers.md', 'claude:merge-when-green.md', 'codex:MEMORY.md', 'asks:12', 'session:abc', 'nonsense', 'gemini:none.md'] }
  assert.deepEqual(refs(line, SNAP).map((row) => row.title), ['Short answers', 'Merge when green', 'Testing'])
  assert.deepEqual(refs({}, SNAP), [])
  assert.deepEqual(refs(line, null), [])
  assert.deepEqual(agent('claude', SNAP), { id: 'claude', name: 'Claude Code', color: '#d97757' })
  assert.deepEqual(agent('amp', SNAP), { id: 'amp', name: 'Amp', color: '#c9a227' })
  assert.equal(agent('zed', SNAP).color, '#8a8f98')
  const data = createMemoryData({ fetch: async () => ({ ok: true, json: async () => ({}) }) })
  data.receive(SNAP)
  assert.equal(data.refs({ refs: ['claude:b.md'] })[0].title, 'Merge when green', 'the latest snapshot by default')
  assert.equal(data.agent('claude').name, 'Claude Code')
})

test('onChange hears every snapshot after the first, and can stop', () => {
  const data = createMemoryData({ fetch: async () => ({ ok: true, json: async () => ({}) }) })
  const heard = []
  const stop = data.onChange((snap) => heard.push(snap.observedAt))
  data.onChange(() => { throw new Error('a broken listener') })
  data.receive({ ...SNAP, observedAt: 1 })
  data.receive({ ...SNAP, observedAt: 2 })
  data.receive(null)
  stop()
  data.receive({ ...SNAP, observedAt: 3 })
  assert.deepEqual(heard, [2])
  assert.equal(data.snapshot().observedAt, 3)
})

test('a conversation and the conversations about a memory, from the viewer', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/conversation': () => ({ sessionId: 's1', title: 'Fix login', cwd: '/w', turns: [{ turn: 0, at: 1, ask: 'hi', answer: 'hello' }] }),
    '/api/related': () => ({ id: 'm', hits: [{ sessionId: 's1', turn: 0 }] }),
  })
  const data = createMemoryData({ fetch })
  const found = await data.conversation('s 1/x', 3)
  assert.deepEqual(found, { title: 'Fix login', cwd: '/w', turns: [{ turn: 0, at: 1, ask: 'hi', answer: 'hello' }], error: null })
  assert.equal(calls[0], '/api/conversation?sessionId=s+1%2Fx&turn=3')
  await data.conversation('s1', -1)
  assert.equal(calls[1], '/api/conversation?sessionId=s1', 'a hit on the name has no turn')
  assert.deepEqual(await data.related('claude:a b.md'), [{ sessionId: 's1', turn: 0 }])
  assert.equal(calls[2], '/api/related?id=claude%3Aa%20b.md')
  const down = createMemoryData({ fetch: async () => { throw new Error('offline') } })
  assert.deepEqual((await down.conversation('s1', 0)).turns, [])
  assert.deepEqual(await down.related('x'), [])
})
