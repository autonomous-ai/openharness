/** Every machine, and About You without being asked: the pieces, with a fake bridge and fake machines. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DAY } from './fixtures.mjs'
import { buildRequest, due, messagesSince } from '../lib/due.mjs'
import { checkAutobuild, ownAgent, RETRY_MS } from '../lib/autobuild.mjs'
import { askMachines, merge, newestAbout, syncAbout } from '../lib/fleet.mjs'

const now = new Date('2026-10-10T12:00:00').getTime()
const day = (offset) => { const d = new Date(now - offset * DAY); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

test('due: first build as soon as there is anything; then enough new messages, at most daily', () => {
  assert.equal(due({ memories: [], sessions: { asks: 0 } }, { now }).due, false)
  assert.deepEqual(due({ memories: [], sessions: { asks: 5 } }, { now }), { due: true, first: true, reason: 'no About You yet', newMessages: 5 })
  assert.equal(due({ memories: [{ kind: 'you' }], sessions: null }, { now }).due, true)
  const activity = [{ day: day(3), asks: 150 }, { day: day(1), asks: 100 }, { day: day(5), asks: 999 }]
  const built = (ago) => ({ memories: [], sessions: { asks: 5000, activity }, about: { modified: now - ago * DAY } })
  assert.equal(messagesSince(activity, now - 4 * DAY), 250)
  assert.equal(due(built(4), { now }).due, true)
  assert.equal(due(built(0.5), { now }).reason, 'built in the last day')
  assert.equal(due(built(2), { now }).due, false, 'only 100 new since two days ago')
  assert.equal(buildRequest({ first: true }), 'Build my About You, and use it in every agent.')
  assert.equal(buildRequest({ first: false }, { deliveryOff: true }), 'Update my About You with what I have said since it was last built.')
})

function bridge(agents) {
  const calls = []
  return {
    calls,
    request: async (machine, type, payload) => { calls.push([machine, type, payload]); return { agents } },
    send: async (machine, type, payload) => { calls.push([machine, type, payload]) },
  }
}

test('autobuild asks its own idle agent once, and never a busy one, another workspace\'s, or twice in two hours', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'memories-auto-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'memories-other-'))
  const snap = { memories: [], sessions: { asks: 40 } }
  const agent = (over) => ({ id: 'a1', dsh: 'autonomous/memories', status: 'active', project: { cwd: workspace }, monitor: { activity: 'idle', activityKnown: true }, ...over })

  const busy = bridge([agent({ monitor: { activity: 'working', activityKnown: true } })])
  assert.equal((await checkAutobuild({ snapshot: snap, workspace, local: 'm1', ...busy, now })).reason, 'agent is working')
  const other = bridge([agent({ project: { cwd: elsewhere } })])
  assert.equal((await checkAutobuild({ snapshot: snap, workspace, local: 'm1', ...other, now })).reason, 'no agent in this workspace')

  const idle = bridge([agent()])
  const done = await checkAutobuild({ snapshot: snap, workspace, local: 'm1', ...idle, now })
  assert.equal(done.sent, true)
  assert.deepEqual(idle.calls.at(-1), ['m1', 'message', { agentId: 'a1', content: 'Build my About You, and use it in every agent.' }])
  assert.equal((await checkAutobuild({ snapshot: snap, workspace, local: 'm1', ...idle, now: now + 60_000 })).reason, 'asked recently')
  assert.equal((await checkAutobuild({ snapshot: snap, workspace, local: 'm1', ...bridge([agent()]), now: now + RETRY_MS + 1 })).sent, true)
  assert.equal(JSON.parse(readFileSync(join(workspace, '.harness', 'memories-autobuild.json'), 'utf8')).agentId, 'a1')

  const quiet = mkdtempSync(join(tmpdir(), 'memories-auto-'))
  const off = bridge([agent({ project: { cwd: quiet } })])
  await checkAutobuild({ snapshot: { ...snap, delivery: { choseOff: true } }, workspace: quiet, local: 'm1', ...off, now })
  assert.equal(off.calls.at(-1)[2].content, 'Build my About You.', 'a person who turned delivery off is not turned back on')
  assert.equal(ownAgent([agent({ status: 'stopped' })], workspace), null)
})

const remoteSnapshot = (name, about) => ({
  memories: [{ id: 'claude:x.md', agent: 'claude', kind: 'you', title: `From ${name}`, modified: now - DAY, size: 1, body: '' }],
  agents: [{ id: 'claude', memories: 1, sessions: 4, instructions: 0, present: true }, { id: 'codex', memories: 0, sessions: 2, instructions: 0, present: true }],
  projects: [{ key: '/w/app', name: 'app', path: '~/w/app', memories: ['claude:x.md'], sessions: 3, asks: 9, engines: { claude: 9 }, lastAt: now }],
  sessions: { sessions: 6, asks: 20, firstAt: now - 90 * DAY, engines: [{ engine: 'claude', sessions: 4, asks: 15, lastAt: now }, { engine: 'grok', sessions: 2, asks: 5, lastAt: now }], activity: [{ day: day(1), engine: 'claude', asks: 15 }] },
  about,
})

test('merge: rows labeled and unique per machine, counts summed, projects joined by name', () => {
  const local = {
    memories: [{ id: 'claude:x.md', agent: 'claude', kind: 'you', title: 'Here', modified: now, size: 1, body: '' }],
    agents: [{ id: 'claude', memories: 1, sessions: 10, instructions: 1, present: true }, { id: 'codex', memories: 0, sessions: 0, instructions: 0, present: false }],
    projects: [{ key: '/h/app', name: 'app', path: '~/code/app', memories: ['claude:x.md'], sessions: 2, asks: 4, engines: { codex: 4 }, lastAt: now - DAY }],
    sessions: { sessions: 10, asks: 100, firstAt: now - 30 * DAY, engines: [{ engine: 'codex', sessions: 10, asks: 100, lastAt: now }], activity: [{ day: day(0), engine: 'codex', asks: 100 }] },
  }
  const remotes = [{ id: 'm2', name: 'mini', online: true, snapshot: remoteSnapshot('mini') }, { id: 'm3', name: 'box', online: true, snapshot: null, error: 'needs the newest Harness' }]
  const all = merge(local, remotes, { id: 'm1', name: 'laptop' })
  assert.deepEqual(all.memories.map((row) => [row.id, row.machine.name]), [['claude:x.md', 'laptop'], ['m2|claude:x.md', 'mini']])
  assert.equal(all.memories[1].origin, 'claude:x.md')
  assert.deepEqual(all.agents.find((agent) => agent.id === 'claude'), { id: 'claude', memories: 2, sessions: 14, instructions: 1, present: true, machines: ['laptop', 'mini'] })
  assert.equal(all.agents.find((agent) => agent.id === 'codex').present, true)
  assert.deepEqual(all.projects.map((project) => [project.name, project.memories, project.sessions, project.machines]), [['app', ['claude:x.md', 'm2|claude:x.md'], 5, ['laptop', 'mini']]])
  assert.equal(all.sessions.asks, 120)
  assert.equal(all.sessions.firstAt, now - 90 * DAY)
  assert.deepEqual(all.sessions.engines.map((row) => [row.engine, row.asks]), [['codex', 100], ['claude', 15], ['grok', 5]])
  assert.equal(local.sessions.engines.length, 1, 'the local snapshot is not changed')
  assert.deepEqual(all.machines.map((machine) => [machine.name, machine.ok, machine.error ?? null]), [['laptop', true, null], ['mini', true, null], ['box', false, 'needs the newest Harness']])
})

test('sync: the newest About You everywhere, by text, never sent back to where it came from', async () => {
  const here = { id: 'm1', name: 'laptop' }
  const older = { text: '## A\n- old\n', modified: now - 2 * DAY }
  const newer = { text: '## A\n- new\n', modified: now - DAY }
  const remotes = [
    { id: 'm2', name: 'mini', snapshot: remoteSnapshot('mini', newer) },
    { id: 'm3', name: 'box', snapshot: remoteSnapshot('box', older) },
    { id: 'm4', name: 'off', snapshot: null },
  ]
  assert.equal(newestAbout({ about: older }, remotes, here).from, 'm2')
  const written = []
  const sent = []
  const result = await syncAbout({ local: { about: older }, remotes, here, request: async (id, type, payload) => { sent.push([id, type, payload.text]) }, writeHere: async (text) => { written.push(text) } })
  assert.deepEqual(written, [newer.text])
  assert.deepEqual(sent, [['m3', 'memory_about_put', newer.text]])
  assert.deepEqual(result, { wroteHere: true, sentTo: ['box'], failed: [] })

  // A moment later this machine's copy is newer by file time but the same words: nothing moves.
  const settled = await syncAbout({ local: { about: { ...newer, modified: now } }, remotes: [{ id: 'm2', name: 'mini', snapshot: remoteSnapshot('mini', newer) }], here, request: async () => { throw new Error('nothing to send') }, writeHere: async () => { throw new Error('nothing to write') } })
  assert.deepEqual(settled, { wroteHere: false, sentTo: [], failed: [] })

  const failed = await syncAbout({ local: { about: newer }, remotes: [{ id: 'm3', name: 'box', snapshot: remoteSnapshot('box', older) }], here, request: async () => { throw new Error('link down') }, writeHere: async () => {} })
  assert.deepEqual(failed.failed, [{ name: 'box', error: 'link down' }])
  assert.deepEqual(await syncAbout({ local: {}, remotes: [], here, request: async () => {}, writeHere: async () => {} }), { wroteHere: false, sentTo: [], failed: [] })
})

test('askMachines: online machines asked, an old Harness and an offline one said as such', async () => {
  const report = async () => ({ machines: [
    { machineId: 'm1', name: 'laptop', current: true, online: true },
    { machineId: 'm2', name: 'mini', current: false, online: true },
    { machineId: 'm3', name: 'box', current: false, online: true },
    { machineId: 'm4', name: 'away', current: false, online: false },
    { machineId: 'm5', name: 'rig', current: false, online: true },
  ], error: null })
  const request = async (id) => {
    if (id === 'm2') return { snapshot: remoteSnapshot('mini') }
    if (id === 'm5') throw Object.assign(new Error('E2EE_REQUIRED'), { code: 'E2EE_REQUIRED' })
    throw Object.assign(new Error('UNSUPPORTED'), { code: 'UNSUPPORTED' })
  }
  const asked = await askMachines({ machinesReport: report, request })
  assert.deepEqual(asked.here, { id: 'm1', name: 'laptop' })
  assert.deepEqual(asked.remotes.map((remote) => [remote.name, Boolean(remote.snapshot), remote.error]), [['mini', true, null], ['box', false, 'needs the newest Harness'], ['away', false, 'offline'], ['rig', false, 'needs the newest Harness']])
})

test('the viewer with a fleet: other machines merged in, About You synced, the build asked for', async () => {
  const { createViewer } = await import('../viewer.mjs')
  const { makeHome } = await import('./fixtures.mjs')
  const { home, env } = makeHome()
  const workspace = mkdtempSync(join(tmpdir(), 'memories-ws-'))
  mkdirSync(join(home, '.harness', 'memory'), { recursive: true })
  const calls = []
  const fleet = {
    machinesReport: async () => ({ machines: [{ machineId: 'm1', name: 'laptop', current: true, online: true }, { machineId: 'm2', name: 'mini', current: false, online: true }] }),
    request: async (id, type, payload) => {
      calls.push([id, type])
      if (type === 'memory_snapshot') return { snapshot: remoteSnapshot('mini', { text: '## How you work\n- From the mini.\n', modified: Date.now() - 60_000 }) }
      if (type === 'agents_list') return { agents: [{ id: 'a1', dsh: 'autonomous/memories', status: 'active', project: { cwd: workspace }, monitor: { activity: 'idle', activityKnown: true } }] }
      return {}
    },
    send: async (id, type, payload) => { calls.push([id, type, payload.content]) },
  }
  const viewer = createViewer({ workspace, env, home, fleet, intervalMs: 60_000 })
  await viewer.start()
  try {
    await viewer.tend()
    const snap = viewer.snapshot()
    assert.ok(snap.memories.some((row) => row.machine?.name === 'mini'))
    assert.match(readFileSync(join(home, '.harness', 'memory', 'about-you.md'), 'utf8'), /From the mini/, 'About You built on the mini arrived here')
    assert.equal(snap.about.lines[0].text, 'From the mini.')
    assert.ok(!calls.some(([, type]) => type === 'message'), 'About You exists now: no build is due')
  } finally { await viewer.close() }
})

test('the switch: newest on/off choice everywhere, applied with its own time', async () => {
  const { syncChoice } = await import('../lib/fleet.mjs')
  const here = { id: 'm1', name: 'laptop' }
  const delivery = (on, at) => ({ on, choseOff: !on, choiceAt: at })
  const remotes = [
    { id: 'm2', name: 'mini', snapshot: { delivery: delivery(false, now) } },
    { id: 'm3', name: 'box', snapshot: { delivery: delivery(true, now - DAY) } },
    { id: 'm4', name: 'fresh', snapshot: { delivery: { on: false } } },
    { id: 'm5', name: 'old', snapshot: null },
  ]
  const applied = []
  const sent = []
  const result = await syncChoice({ local: { delivery: delivery(true, now - 2 * DAY) }, remotes, here,
    request: async (id, type, payload) => { sent.push([id, type, payload]) }, applyHere: async (on, at) => { applied.push([on, at]) } })
  assert.deepEqual(applied, [[false, now]], 'turned off here, with the time it was turned off on the mini')
  assert.deepEqual(sent, [['m3', 'memory_deliver', { on: false, choiceAt: now }], ['m4', 'memory_deliver', { on: false, choiceAt: now }]])
  assert.deepEqual(result, { appliedHere: true, sentTo: ['box', 'fresh'], failed: [] })
  const none = await syncChoice({ local: { delivery: { on: false } }, remotes: [{ id: 'm2', name: 'mini', snapshot: { delivery: { on: false } } }], here, request: async () => { throw new Error('no') }, applyHere: async () => { throw new Error('no') } })
  assert.deepEqual(none, { appliedHere: false, sentTo: [], failed: [] }, 'nobody chose anything yet: nothing moves')
})

test('the switch in the viewer: a token, then off and on, here and on the machines that answer', async () => {
  const { createViewer } = await import('../viewer.mjs')
  const { makeHome } = await import('./fixtures.mjs')
  const { writeAbout } = await import('../lib/about.mjs')
  const { request: httpRequest } = await import('node:http')
  const { home, env } = makeHome()
  writeAbout(join(home, '.harness', 'memory'), '## How you work\n- Short answers.\n')
  const sent = []
  const fleet = {
    machinesReport: async () => ({ machines: [{ machineId: 'm1', name: 'laptop', current: true, online: true }, { machineId: 'm2', name: 'mini', current: false, online: true }] }),
    request: async (id, type, payload) => {
      if (type === 'memory_snapshot') return { snapshot: remoteSnapshot('mini', { text: '## How you work\n- Short answers.\n', modified: 1 }) }
      if (type === 'agents_list') return { agents: [] }
      sent.push([id, type, payload.on]); return {}
    },
    send: async () => {},
  }
  const workspace = mkdtempSync(join(tmpdir(), 'memories-ws-'))
  const viewer = createViewer({ workspace, env, home, fleet, intervalMs: 60_000 })
  const port = await viewer.start()
  const post = (body, token) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/deliver', method: 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(token ? { 'x-memories-token': token } : {}) } }, (res) => {
      let text = ''; res.on('data', (c) => { text += c }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(JSON.stringify(body))
  })
  try {
    await viewer.tend()
    assert.equal((await post({ on: true })).status, 403, 'no token, no switch')
    assert.equal((await post({ on: 'yes' }, viewer.token)).status, 400)
    const on = await post({ on: true }, viewer.token)
    assert.equal(on.body.ok, true)
    assert.equal(viewer.snapshot().delivery.on, true)
    assert.ok(viewer.snapshot().delivery.tokens > 20)
    const off = await post({ on: false }, viewer.token)
    assert.deepEqual(off.body.sentTo, ['mini'])
    assert.equal(viewer.snapshot().delivery.on, false)
    assert.equal(viewer.snapshot().delivery.choseOff, true)
    assert.deepEqual(sent.filter(([, type]) => type === 'memory_deliver'), [['m2', 'memory_deliver', true], ['m2', 'memory_deliver', false]])
    const page = await new Promise((resolve) => httpRequest({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, (res) => { let t = ''; res.on('data', (c) => { t += c }); res.on('end', () => resolve(t)) }).end())
    assert.ok(page.includes(viewer.token) && !page.includes('__MEMORIES_TOKEN__'), 'the page carries its token')
  } finally { await viewer.close() }
})

test('copies out of date are brought up to date by the pane while delivery is on, not when it is off', async () => {
  const { createViewer } = await import('../viewer.mjs')
  const { makeHome } = await import('./fixtures.mjs')
  const { writeAbout } = await import('../lib/about.mjs')
  const { deliver, status } = await import('../lib/deliver.mjs')
  const { writeFileSync } = await import('node:fs')
  const { home, env } = makeHome()
  writeAbout(join(home, '.harness', 'memory'), '## How you work\n- Short answers.\n')
  deliver('on', { env, home })
  // Edited by hand, past the write path: the copies no longer match.
  writeFileSync(join(home, '.harness', 'memory', 'about-you.md'), '## How you work\n- Tabs, not spaces.\n')
  assert.ok(status({ env, home }).agents.some((agent) => !agent.current))
  const viewer = createViewer({ workspace: mkdtempSync(join(tmpdir(), 'memories-ws-')), env, home })
  await viewer.start()
  try {
    await viewer.look()
    assert.ok(viewer.snapshot().delivery.agents.every((agent) => agent.current), 'every copy current again')
    assert.match(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8'), /Tabs, not spaces/)
  } finally { await viewer.close() }
})
