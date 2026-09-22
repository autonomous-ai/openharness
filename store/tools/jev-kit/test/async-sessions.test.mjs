// Exercise the production Jev clients against a deliberately delayed LOCAL protocol fixture.
// No external provider or user credential is used. Run: node --test store/tools/jev-kit/test/async-sessions.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const agents = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../agents'
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const cases = [
  {
    name: 'trader',
    marker: 'market.json',
    start: 'startTraderViewer',
    zero(s) {
      assert.equal(s.day, 0)
      assert.equal(s.history.length, 0)
      assert.equal(s.holdings, 0)
    }
  },
  {
    name: 'shopper',
    marker: 'shopper.json',
    start: 'startShopperViewer',
    zero(s) {
      assert.equal(s.step, 0)
      assert.equal(s.score.decisions, 0)
      assert.equal(s.history.length, 0)
    }
  },
  {
    name: 'arena',
    marker: 'arena.json',
    start: 'startArenaViewer',
    zero(s) {
      assert.equal(s.frame.totals.decisions, 0)
      assert.equal(s.frame.last, null)
    }
  },
  {
    name: 'fps',
    marker: 'level.json',
    start: 'startFpsViewer',
    zero(s) {
      assert.equal(s.session.decisions, 0)
      assert.equal(s.t, 0)
    }
  },
  {
    name: 'duel',
    marker: 'battle.json',
    start: 'startDuelViewer',
    zero(s) {
      assert.equal(s.moveCount, 0)
      assert.equal(s.history.length, 0)
      assert.equal(s.toMove, 'O')
      assert.equal(s.totals.moves, 0)
    }
  },
  ...['lander', 'pendulum', 'pong'].map((name) => ({
    name,
    marker: name + '.json',
    start: 'start' + name[0].toUpperCase() + name.slice(1) + 'Viewer',
    zero(s, verdict) {
      assert.equal(s.history.length, 0)
      assert.equal(verdict.ready, false)
    }
  })),
  {
    name: 'conductor',
    marker: 'piece.json',
    start: 'startConductorViewer',
    zero(s) {
      assert.equal(s.bar, 2)
      assert.equal(s.totals.bars, 2)
      assert.deepEqual(
        s.plan.map((b) => b.bar),
        [1, 2]
      )
    }
  }
]

async function fixture() {
  let gate = null
  const requests = [],
    holds = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    assert.equal(
      req.headers.authorization,
      'Bearer local-session-protocol-fixture'
    )
    const request = JSON.parse(text)
    requests.push(request)
    if (gate) {
      const held = gate
      gate = null
      held.arrived(request)
      if ((await held.ready) === 'error') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'obsolete fixture failure' }))
        return
      }
    }
    const answers = Object.fromEntries(
      Object.entries(request.questions).map(([id, q]) => {
        if (q.type === 'noul') return [id, { noul: 0.8 }]
        if (q.type === 'score') return [id, { score: 1, confidence: 0.8 }]
        const options = Object.keys(q.criteria || {}),
          pick = options.includes('BUY') ? 'BUY' : options[0]
        return [
          id,
          {
            probabilities: Object.fromEntries(
              options.map((o) => [o, o === pick ? 1 : 0])
            )
          }
        ]
      })
    )
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        model: 'local-delayed-fixture',
        answers,
        usage: { input_tokens: 30 }
      })
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    requests,
    releaseAll() {
      for (const held of holds) held.release()
    },
    url: `http://127.0.0.1:${server.address().port}/fixture`,
    hold() {
      let arrived, release
      const received = new Promise((r) => {
          arrived = r
        }),
        ready = new Promise((r) => {
          release = r
        })
      gate = { arrived, ready }
      const held = { received, release }
      holds.push(held)
      return held
    },
    async close() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  }
}

async function until(read, label = 'expected state') {
  const end = Date.now() + 4000
  while (Date.now() < end) {
    if (await read()) return
    await sleep(20)
  }
  throw new Error('Timed out waiting for ' + label)
}
async function received(hold) {
  let timer
  try {
    return await Promise.race([
      hold.received,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('No model request reached the local fixture')),
          2000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function withViewer(entry, work) {
  const ws = mkdtempSync(join(tmpdir(), `jev-session-${entry.name}-`)),
    wire = await fixture()
  const env = {
    TYPESAFE_API_URL: wire.url,
    TYPESAFE_API_KEY: 'local-session-protocol-fixture',
    TYPESAFE_CREDENTIALS: join(ws, 'empty-credentials'),
    JEV_OFFLINE: '0',
    JEV_LIVE_TESTS: '1'
  }
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]])
  )
  Object.assign(process.env, env)
  const pkg = join(agents, 'jev-' + entry.name)
  const config = {
    ...JSON.parse(readFileSync(join(pkg, 'template', entry.marker), 'utf8')),
    speed: 5000,
    stepMs: 20000,
    tickMs: 5000,
    tempo: 30
  }
  writeFileSync(join(ws, entry.marker), JSON.stringify(config))
  let viewer
  const pending = new Set()
  try {
    const module = await import(pathToFileURL(join(pkg, 'viewer/viewer.mjs')))
    viewer = await module[entry.start]({ workspace: ws, port: 0 })
    function ctl(cmd, body = {}) {
      const p = (async () => {
        const r = await fetch(viewer.url + '/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd, n: 3, ...body })
        })
        assert.equal(r.status, 200)
        return r.json()
      })()
      pending.add(p)
      p.then(
        () => pending.delete(p),
        () => pending.delete(p)
      )
      return p
    }
    const state = async () => (await fetch(viewer.url + '/state')).json()
    const verdict = () =>
      JSON.parse(readFileSync(join(ws, '.harness/verdict.json'), 'utf8'))
    await ctl('pause')
    await work({ ws, wire, config, ctl, state, verdict })
  } finally {
    wire.releaseAll()
    await Promise.allSettled([...pending])
    await viewer?.close()
    await wire.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(ws, { recursive: true, force: true })
  }
}
function progressed(entry, state) {
  if (entry.name === 'arena') assert.ok(state.frame.totals.decisions > 0)
  else if (entry.name === 'fps') assert.ok(state.session.decisions > 0)
  else if (entry.name === 'conductor') assert.ok(state.bar > 2)
  else assert.ok(state.history.length > 0)
}
for (const entry of cases) {
  for (const outcome of ['answer', 'error'])
    test(
      `${entry.name}: reset survives a delayed ${outcome}, cancels the old batch, then runs again`,
      { timeout: 12000 },
      () =>
        withViewer(entry, async ({ wire, ctl, state, verdict }) => {
          const hold = wire.hold(),
            ticking = ctl('tick')
          await received(hold)
          const resetting = ctl('reset')
          await sleep(60) // Both HTTP commands now overlap the explicitly held model answer.
          hold.release(outcome)
          await Promise.all([ticking, resetting])
          const current = await state()
          entry.zero(current, verdict())
          assert.equal(current.error || current.frame?.error || null, null)
          await ctl('tick', { n: 1 })
          progressed(entry, await state())
        })
    )
  test(
    `${entry.name}: a live workspace edit invalidates the old model result`,
    { timeout: 12000 },
    () =>
      withViewer(entry, async ({ ws, wire, config, ctl, state, verdict }) => {
        const hold = wire.hold(),
          ticking = ctl('tick')
        await received(hold)
        const next = {
          ...config,
          title: 'Fresh workspace revision',
          seed: (config.seed || 1) + 19,
          ...(entry.name === 'duel' ? { size: config.size === 6 ? 8 : 6 } : {})
        }
        writeFileSync(join(ws, entry.marker), JSON.stringify(next))
        await until(async () => {
          const s = await state()
          return (s.title || s.frame?.title) === next.title
        }, 'the native file watcher')
        hold.release()
        await ticking
        if (entry.name === 'duel') {
          await until(
            async () => !!(await state()).pending,
            'the new board’s first decision'
          )
          const s = await state()
          assert.equal(s.moveCount, 0)
          assert.equal(s.history.length, 0)
          assert.equal(s.toMove, 'O')
          assert.equal(s.size, next.size)
        } else entry.zero(await state(), verdict())
        await ctl('tick', { n: 1 })
        progressed(entry, await state())
      })
  )
}
test(
  'conductor: a newer audience request replaces an in-flight request without mixing their bars',
  { timeout: 12000 },
  () =>
    withViewer(
      cases.find((c) => c.name === 'conductor'),
      async ({ wire, config, ctl, state }) => {
        const [first, second] = config.moods
        assert.ok(first && second && first !== second)
        const count = wire.requests.length,
          hold = wire.hold(),
          oldRequest = ctl('request', { mood: first })
        await received(hold)
        const newRequest = ctl('request', { mood: second })
        await until(
          async () => (await state()).request === second,
          'the newer audience request'
        )
        hold.release()
        await Promise.all([oldRequest, newRequest])
        const s = await state()
        assert.equal(s.bar, 4)
        assert.deepEqual(
          s.plan.slice(-2).map((b) => b.request),
          [second, second]
        )
        assert.equal(
          wire.requests.length - count,
          5,
          'one obsolete harmony call, then two complete fresh bars; no obsolete notes call'
        )
      }
    )
)
