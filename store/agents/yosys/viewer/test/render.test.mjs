// The schematic renderer's job bookkeeping, on a fake worker: replies, failures, the timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRenderer } from '../lib/render.mjs'

const NET = {
  modules: {
    top: { attributes: {}, ports: {}, netnames: {}, cells: { a: { type: '$and' }, b: { type: '$xor' }, u: { type: 'sub' } } },
    sub: { attributes: {}, ports: {}, netnames: {}, cells: {} },
  },
  __module: 'top',
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'yosys-render-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const skinPath = join(dir, 'default.svg')
  writeFileSync(skinPath, '<svg><g s:type="$and"/><g s:alias val="$or"/></svg>')
  const made = []
  class FakeWorker extends EventEmitter {
    constructor(path) { super(); this.path = path; this.posted = []; this.terminated = false; made.push(this) }
    postMessage(message) { this.posted.push(message) }
    terminate() { this.terminated = true }
    unref() { this.unrefed = true }
  }
  return { dir, skinPath, made, FakeWorker }
}

/** Settles to ['ok', value] or ['error', message] — or stays 'pending'. */
function track(promise) {
  const box = { state: 'pending' }
  promise.then((v) => { box.state = ['ok', v] }, (e) => { box.state = ['error', e.message] })
  return box
}

test('without netlistsvg installed there is nothing to draw with, and no worker is started', async (t) => {
  const { dir, made, FakeWorker } = fixture(t)
  const render = createRenderer({ skinPath: join(dir, 'missing.svg'), workerPath: '/w.mjs', Worker: FakeWorker })
  await assert.rejects(render(NET), /netlistsvg is not installed here — run toolchain\/setup\.sh/)
  assert.equal(made.length, 0)
})

test('one worker draws every module; a reply settles its own job only', async (t) => {
  const { skinPath, made, FakeWorker } = fixture(t)
  const render = createRenderer({ skinPath, workerPath: '/w.mjs', Worker: FakeWorker })
  const first = render(NET)
  const second = track(render({ ...NET, __module: 'sub' }))
  assert.equal(made.length, 1)
  const [w] = made
  assert.equal(w.path, '/w.mjs')
  assert.equal(w.unrefed, true)
  const [m1, m2] = w.posted
  assert.deepEqual([m1.id, m2.id], [1, 2])
  assert.match(m1.skin, /s:type="\$and"/)
  // a type the skin draws keeps its $, an unknown internal cell loses it, an instance is named
  assert.deepEqual(Object.fromEntries(Object.entries(m1.netlist.modules.top.cells).map(([k, c]) => [k, c.type])),
    { a: '$and', b: 'xor', u: 'sub u' })
  assert.deepEqual(Object.keys(m2.netlist.modules), ['sub'])

  w.emit('message', { id: 99, svg: '<svg>stray</svg>' }) // nobody asked for this one
  w.emit('message', { id: 1, svg: '<svg>top</svg>' })
  assert.equal(await first, '<svg>top</svg>')
  await sleep(0)
  assert.equal(second.state, 'pending')
  w.emit('message', { id: 2, error: 'Cannot read properties of undefined' })
  await sleep(0)
  assert.deepEqual(second.state, ['error', 'Cannot read properties of undefined'])

  const empty = render(NET)
  w.emit('message', { id: 3 })
  await assert.rejects(empty, /netlistsvg drew nothing/)
  assert.equal(made.length, 1)
})

test('a worker that dies fails what it had, and the next request gets a new one', async (t) => {
  const { skinPath, made, FakeWorker } = fixture(t)
  const render = createRenderer({ skinPath, workerPath: '/w.mjs', Worker: FakeWorker, timeoutMs: 120 })
  const pending = [track(render(NET)), track(render(NET))]
  await sleep(60)
  made[0].emit('error', new Error('worker crashed'))
  await sleep(0)
  assert.deepEqual(pending.map((p) => p.state), [['error', 'worker crashed'], ['error', 'worker crashed']])
  const next = track(render(NET))
  assert.equal(made.length, 2)
  // past the dead jobs' deadline, not yet the new job's: their timers must not reach the new worker
  await sleep(90)
  assert.equal(made[1].terminated, false, 'a dead job timed out later and killed the new worker')
  assert.equal(next.state, 'pending')
  made[1].emit('message', { id: made[1].posted[0].id, svg: '<svg/>' })
  await sleep(0)
  assert.deepEqual(next.state, ['ok', '<svg/>'])
})

test('a layout past the timeout is abandoned: its worker goes, the jobs sharing it are interrupted', async (t) => {
  const { skinPath, made, FakeWorker } = fixture(t)
  const render = createRenderer({ skinPath, workerPath: '/w.mjs', Worker: FakeWorker, timeoutMs: 100 })
  let next
  const slow = track(render(NET).catch((e) => {
    next = track(render(NET)) // asked for again at once, as the page does
    throw e
  }))
  await sleep(50)
  const sharing = track(render(NET)) // due at 150 ms; the new job at 200
  await sleep(125)
  assert.deepEqual(slow.state, ['error', 'this module is too large to lay out in the pane (over 0 s)'])
  assert.deepEqual(sharing.state, ['error', 'interrupted'])
  assert.equal(made[0].terminated, true)
  assert.equal(made.length, 2)
  // a reply from the abandoned worker is nobody's
  made[0].emit('message', { id: made[0].posted[0].id, svg: '<svg>late</svg>' })
  assert.equal(made[1].terminated, false, 'an interrupted job timed out later and killed the new worker')
  assert.equal(next.state, 'pending')
  made[1].emit('message', { id: made[1].posted[0].id, svg: '<svg/>' })
  await sleep(0)
  assert.deepEqual(next.state, ['ok', '<svg/>'])
})

test('the default timeout reads as the pane says it', async (t) => {
  const { skinPath, FakeWorker } = fixture(t)
  const realSetTimeout = globalThis.setTimeout
  let delay, job
  globalThis.setTimeout = (fn, ms) => { delay = ms; return realSetTimeout(fn, 0) } // and run out at once
  try {
    job = createRenderer({ skinPath, workerPath: '/w.mjs', Worker: FakeWorker })(NET)
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
  assert.equal(delay, 90_000)
  await assert.rejects(job, /this module is too large to lay out in the pane \(over 90 s\)/)
})
