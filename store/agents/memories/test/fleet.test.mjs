/** Every machine, and About You without being asked: the pieces, with a fake bridge and fake machines. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DAY } from './fixtures.mjs'
import { due, messagesSince } from '../lib/due.mjs'
import { askMachines, merge, newestAbout, newestChoice, syncAbout } from '../lib/fleet.mjs'

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
  assert.equal(all.agents.find((agent) => agent.id === 'codex').present, false, 'installed on the mini is not installed here')
  assert.deepEqual(all.projects.map((project) => [project.name, project.memories, project.sessions, project.machines]), [['app', ['claude:x.md', 'm2|claude:x.md'], 5, ['laptop', 'mini']]])
  assert.equal(all.sessions.asks, 120)
  assert.equal(all.sessions.firstAt, now - 90 * DAY)
  assert.deepEqual(all.sessions.engines.map((row) => [row.engine, row.asks]), [['codex', 100], ['claude', 15], ['grok', 5]])
  assert.equal(local.sessions.engines.length, 1, 'the local snapshot is not changed')
  assert.deepEqual(all.machines.map((machine) => [machine.name, machine.ok, machine.error ?? null]), [['laptop', true, null], ['mini', true, null], ['box', false, 'needs the newest Harness']])
})

test('sync: the newest About You everywhere, by text, never sent back to where it came from', async () => {
  const here = { id: 'm1', name: 'laptop' }
  const older = { text: '## A\n- old\n', modified: now - 2 * DAY, gen: 3 }
  const newer = { text: '## A\n- new\n', modified: now - DAY, gen: 4 }
  const remotes = [
    { id: 'm2', name: 'mini', snapshot: remoteSnapshot('mini', newer) },
    { id: 'm3', name: 'box', snapshot: remoteSnapshot('box', older) },
    { id: 'm4', name: 'off', snapshot: null },
  ]
  assert.equal(newestAbout({ about: older }, remotes, here).from, 'm2')
  const written = []
  const sent = []
  const result = await syncAbout({ local: { about: older }, remotes, here, request: async (id, type, payload) => { sent.push([id, type, payload.text]); assert.equal(payload.gen, 4) }, writeHere: async (text, gen) => { written.push(text); assert.equal(gen, 4) } })
  assert.deepEqual(written, [newer.text])
  assert.deepEqual(sent, [['m3', 'memory_about_put', newer.text]])
  assert.deepEqual(written.length, 1)
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
      if (type === 'memory_snapshot') return { snapshot: remoteSnapshot('mini', { text: '## How you work\n- From the mini.\n', modified: Date.now() - 60_000, gen: 2 }) }
      return {}
    },
  }
  const viewer = createViewer({ workspace, env, home, fleet, intervalMs: 60_000 })
  await viewer.start()
  try {
    await viewer.tend()
    const snap = viewer.snapshot()
    assert.ok(snap.memories.some((row) => row.machine?.name === 'mini'))
    assert.match(readFileSync(join(home, '.harness', 'memory', 'about-you.md'), 'utf8'), /From the mini/, 'About You built on the mini arrived here')
    assert.equal(snap.about.lines[0].text, 'From the mini.')
    assert.ok(!calls.some(([, type]) => type === 'message'), 'the pane never types into an agent')
    assert.equal(snap.delivery.on, true, 'nobody chose: on, as the default')
    assert.equal(snap.delivery.choiceAt, 1, 'at the earliest time, so any real choice wins')
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
      sent.push([id, type, payload.on]); return {}
    },
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
    const delivers = sent.filter(([, type]) => type === 'memory_deliver')
    assert.deepEqual(delivers[0], ['m2', 'memory_deliver', true], 'the default on reached the mini, which had no choice')
    assert.deepEqual(delivers.at(-1), ['m2', 'memory_deliver', false], 'and the click on Off reached it too')
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

test('clocks cannot win: a newer build outranks a machine whose clock runs ahead', async () => {
  const here = { id: 'm1', name: 'laptop' }
  const fresh = { text: '## A\n- built here just now\n', modified: now, gen: 7 }
  const ahead = { text: '## A\n- older build, clock an hour ahead\n', modified: now + 3_600_000, gen: 6 }
  const best = newestAbout({ about: fresh }, [{ id: 'm2', name: 'fast-clock', snapshot: remoteSnapshot('fast-clock', ahead) }], here)
  assert.equal(best.from, 'm1')
  assert.equal(best.gen, 7)
})

test('choices: newest wins, the same time goes to off, the default on loses to any real choice', () => {
  const here = { id: 'm1', name: 'laptop' }
  const d = (on, at) => ({ delivery: { on, choseOff: !on, choiceAt: at } })
  assert.equal(newestChoice(d(true, 5), [{ id: 'm2', snapshot: d(false, 5) }], here).on, false, 'tie: off')
  assert.equal(newestChoice(d(false, 5), [{ id: 'm2', snapshot: d(true, 5) }], here).on, false, 'tie: off, either side')
  assert.equal(newestChoice(d(true, 1), [{ id: 'm2', snapshot: d(false, 2) }], here).on, false, 'the default on (1) loses')
  assert.equal(newestChoice({ delivery: { on: true } }, [{ id: 'm2', snapshot: { delivery: { on: false } } }], here), null, 'no time, no choice')
})

test('a machine that slept through Off cannot turn it back on with a rebuild', async () => {
  const { deliver, readState } = await import('../lib/deliver.mjs')
  const { writeAbout } = await import('../lib/about.mjs')
  const { makeHome } = await import('./fixtures.mjs')
  const { homes } = await import('../lib/agents.mjs')
  const { home, env } = makeHome()
  const memory = join(home, '.harness', 'memory')
  writeAbout(memory, '## A\n- one\n')
  deliver('on', { env, home, choiceAt: 1, exact: true })
  deliver('off', { env, home })
  const off = readState(homes(env, home))
  assert.equal(off.on, false)
  assert.ok(off.choiceAt > 1)
  // A rebuild here, or one arriving from another machine, only refreshes: the choice stays off.
  writeAbout(memory, '## A\n- two\n')
  deliver('refresh', { env, home })
  assert.equal(readState(homes(env, home)).on, false)
  assert.equal(readState(homes(env, home)).choiceAt, off.choiceAt)
  // A local choice is always later than the last one, whatever the clock says.
  deliver('on', { env, home, choiceAt: 5 })
  assert.equal(readState(homes(env, home)).choiceAt, off.choiceAt + 1)
})

test('state written by the first Memories keeps the person\'s choice', async () => {
  const { readState } = await import('../lib/deliver.mjs')
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'memories-legacy-'))
  writeFileSync(join(dir, 'delivery.json'), JSON.stringify({ on: false, updatedAt: '2026-10-10T04:00:00.000Z', agents: [] }))
  const state = readState({ memory: dir })
  assert.equal(state.choseOff, true)
  assert.equal(state.choiceAt, 2, 'dated just after the default, before any real click: its updatedAt moved with every refresh')
})

test('builds number themselves: later than any seen anywhere and than now; a newer copy keeps its own', async () => {
  const { writeAbout, readAbout, noteSeen } = await import('../lib/about.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'memories-gen-'))
  writeAbout(dir, '## A\n- one\n', { now: 100 })
  assert.equal(readAbout(dir).gen, 100)
  noteSeen(dir, 900)
  writeAbout(dir, '## A\n- two\n', { now: 200 })
  assert.equal(readAbout(dir).gen, 901, 'outranks the highest seen even when this clock is behind')
  assert.equal(writeAbout(dir, '## A\n- an older copy\n', { gen: 400 }), null)
  writeAbout(dir, '## A\n- a newer copy\n', { gen: 1000 })
  assert.equal(readAbout(dir).gen, 1000)
  writeAbout(dir, '## A\n- three\n', { now: 300 })
  assert.equal(readAbout(dir).gen, 1001)
})

test('merge keeps two local projects with one name apart; another machine joins only an unambiguous one', () => {
  const local = { memories: [], agents: [], sessions: null, projects: [
    { key: '/a/api', name: 'api', path: '~/a/api', memories: ['x'], sessions: 1, asks: 1, engines: {}, lastAt: 1 },
    { key: '/b/api', name: 'api', path: '~/b/api', memories: ['y'], sessions: 1, asks: 1, engines: {}, lastAt: 1 },
    { key: '/c/web', name: 'web', path: '~/c/web', memories: ['z'], sessions: 1, asks: 1, engines: {}, lastAt: 1 },
  ] }
  const remote = { memories: [], agents: [], projects: [
    { key: '/r/api', name: 'api', memories: ['q'], sessions: 2, asks: 2, engines: {}, lastAt: 2 },
    { key: '/r/web', name: 'web', memories: ['w'], sessions: 2, asks: 2, engines: {}, lastAt: 2 },
  ] }
  const all = merge(local, [{ id: 'm2', name: 'mini', online: true, snapshot: remote }], { id: 'm1', name: 'laptop' })
  const by = Object.fromEntries(all.projects.map((p) => [p.key, p]))
  assert.equal(by['/a/api'].path, '~/a/api')
  assert.equal(by['/b/api'].path, '~/b/api')
  assert.deepEqual(by['m2|/r/api'].memories, ['m2|q'], 'ambiguous here: its own project')
  assert.deepEqual(by['/c/web'].memories, ['z', 'm2|w'], 'unambiguous: joined')
  assert.deepEqual(by['/c/web'].machines, ['laptop', 'mini'])
})

test('second review: nothing from elsewhere moves state backwards; a new machine\'s build beats an old one', async () => {
  const { deliver, readState } = await import('../lib/deliver.mjs')
  const { writeAbout, readAbout } = await import('../lib/about.mjs')
  const { makeHome } = await import('./fixtures.mjs')
  const { homes } = await import('../lib/agents.mjs')
  const { home, env } = makeHome()
  const memory = join(home, '.harness', 'memory')
  writeAbout(memory, '## A\n- mine\n', { now: 5_000 })
  deliver('off', { env, home, choiceAt: 5_000 })
  assert.equal(deliver('on', { env, home, choiceAt: 1, exact: true }).ignored, true, 'an older choice from elsewhere is ignored')
  assert.equal(deliver('on', { env, home, choiceAt: readState(homes(env, home)).choiceAt, exact: true }).ignored, true, 'same time: off stays')
  assert.equal(readState(homes(env, home)).on, false)
  assert.equal(writeAbout(memory, '## A\n- an old copy\n', { gen: 4 }), null, 'an older build from elsewhere is not written')
  assert.match(readAbout(memory).text, /mine/)
  // An old machine (gen 5) wakes after a new machine built for the first time: the new build is later.
  const fresh = mkdtempSync(join(tmpdir(), 'memories-new-'))
  writeAbout(fresh, '## A\n- first build on the new machine\n', { now: 10_000 })
  assert.ok(readAbout(fresh).gen > 5)
})
