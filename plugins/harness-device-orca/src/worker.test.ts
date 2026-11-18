// The worker wired to Orca's test kit: a mock host, and a loop on inputs of this file's own (the last case's own home
// and PATH hold no launcher), so no case reaches the developer's own harness, daemon or dial.
import { afterEach, assert, beforeEach, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import type { DialInputs, Ran } from './inputs'
import * as main from './worker'

const READY = '{"daemon":true,"devicesSocket":"/run/h/devices.sock","devicesReady":true}'
const HIDDEN = { id: 'dial', visible: false }
const UNPLUGGED = '{"attached":false}\n'
const ATTACHED = '{"attached":true,"agent":null}\n'
const AGENT = '{"attached":true,"agent":{"name":"api","app":"Orca"}}\n'

let dir = ''
const checks = new Set<() => void>()

beforeEach(() => {
  dir = mkdtempSync('/tmp/hdo-')
})

afterEach(() => {
  checks.clear()
  rmSync(dir, { recursive: true, force: true })
})

/** Resolves once `holds` does: it is asked again after each status bar update, which each change makes. */
function until(holds: () => boolean): Promise<void> {
  return new Promise((done) => {
    const check = () => {
      if (!holds()) return
      checks.delete(check)
      done()
    }
    checks.add(check)
    check()
  })
}

// After the worker's turn, so what it posts with the update is there too.
function updated(): void {
  setImmediate(() => {
    for (const check of checks) check()
  })
}

const ACCEPT = () => ({ ok: true })
// As an Orca without the status bar refuses each update: for good, so it is not sent again.
const REFUSE = () => {
  throw hostError('unknown_method')
}

/** `answer` is each status bar update's: a result, or a throw of hostError. */
function host(answer: () => unknown = ACCEPT) {
  return mockHost({
    results: {
      'statusBar.update': () => {
        updated()
        return answer()
      },
    },
  })
}

/** Refuses the next update once `refuseNext` is called, as Orca refuses one sent too soon. */
function rateLimited() {
  let refuse = false
  return {
    answer() {
      if (!refuse) return { ok: true }
      refuse = false
      throw hostError('rate_limited', '', 50)
    },
    refuseNext() {
      refuse = true
    },
  }
}

/** The loop's clock: each wait the worker asks for, for the test to fire. */
function clock() {
  const waits: { ms: number; run: () => void; cancelled: boolean }[] = []
  return {
    waits,
    after(ms: number, run: () => void) {
      const wait = { ms, run, cancelled: false }
      waits.push(wait)
      updated()
      return () => {
        wait.cancelled = true
      }
    },
  }
}

/** A run that lasts until it is aborted. */
function pending(_file: string, _args: readonly string[], bounds: { signal: AbortSignal }): Promise<Ran> {
  return new Promise((settle) => bounds.signal.addEventListener('abort', () => settle(null)))
}

function inputs(over: Partial<DialInputs>): DialInputs {
  return {
    platform: 'darwin',
    home: '/h',
    path: '/usr/bin:/bin',
    run: pending,
    connect: () => Promise.resolve(null),
    post: () => Promise.resolve(null),
    watch: () => () => {},
    now: () => 0,
    after: () => () => {},
    ...over,
  }
}

/** A stream answered 200 whose lines the test sends; an abort ends it. */
function feed() {
  const queue: string[] = []
  let ended = false
  let wake = () => {}
  const encoder = new TextEncoder()
  return {
    connect(_socket: string, _body: string, signal: AbortSignal) {
      signal.addEventListener('abort', () => {
        ended = true
        wake()
      })
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (;;) {
          const line = queue.shift()
          if (line !== undefined) yield encoder.encode(line)
          else if (ended) return
          else await new Promise<void>((done) => (wake = done))
        }
      }
      return Promise.resolve({ status: 200, chunks: chunks() })
    },
    send(line: string) {
      queue.push(line)
      wake()
    },
  }
}

/** The worker on `over`'s inputs, as Orca mounts it. */
async function mounted(over: Partial<DialInputs>, answer = ACCEPT) {
  let stop = async () => {}
  const worker = await mountWorker(
    {
      default: (orca) => {
        stop = main.wire(orca, inputs(over))
      },
      deactivate: () => stop(),
    },
    { host: host(answer) }
  )
  const changes = () => worker.posts.filter((post) => post.event === 'dial.changed').map((post) => post.payload)
  const updates = () => worker.host.callsOf('statusBar.update')
  return { worker, changes, updates }
}

/** A worker whose link says ready, and the stream it holds. */
async function streaming(answer = ACCEPT, over: Partial<DialInputs> = {}) {
  const stream = feed()
  const m = await mounted({ run: () => Promise.resolve(READY), connect: stream.connect, ...over }, answer)
  return { ...m, stream }
}

test('before the first pass dial.get says checking, and the status bar item is hidden', async () => {
  const { worker, updates } = await mounted({})
  await until(() => updates().length > 0)
  assert.deepEqual(await worker.request('dial.get'), { state: 'checking' })
  assert.deepEqual(updates(), [HIDDEN])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('each change posts dial.changed and updates the status bar', async () => {
  const { worker, stream, changes, updates } = await streaming()
  stream.send(UNPLUGGED)
  await until(() => changes().length === 1)
  stream.send(ATTACHED)
  await until(() => changes().length === 2)
  stream.send(AGENT)
  await until(() => changes().length === 3)
  assert.deepEqual(changes(), [
    { state: 'unplugged' },
    { state: 'attached' },
    { state: 'attached', agent: { name: 'api', app: 'Orca' } },
  ])
  assert.deepEqual(updates().slice(-3), [HIDDEN, { id: 'dial', visible: true, text: 'Dial' }, { id: 'dial', visible: true, text: 'api' }])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('dial.get answers the state as it is now', async () => {
  const { worker, stream, changes } = await streaming()
  stream.send(AGENT)
  await until(() => changes().length === 1)
  assert.deepEqual(await worker.request('dial.get'), { state: 'attached', agent: { name: 'api', app: 'Orca' } })
  await worker.deactivate()
})

test('the log names the state and never the agent\'s name', async () => {
  const { worker, stream, changes } = await streaming()
  stream.send(AGENT)
  await until(() => changes().length === 1)
  assert.ok(worker.logs.some((line) => line.includes('dial: attached')), worker.logs.join('\n'))
  assert.ok(!worker.logs.some((line) => line.includes('api')), worker.logs.join('\n'))
  await worker.deactivate()
})

test('a status bar update Orca refuses is logged once, and dial.changed is still posted', async () => {
  const { worker, stream, changes } = await streaming(REFUSE)
  stream.send(ATTACHED)
  await until(() => changes().length === 1)
  stream.send(AGENT)
  await until(() => changes().length === 2)
  await worker.deactivate()
  assert.deepEqual(changes(), [{ state: 'attached' }, { state: 'attached', agent: { name: 'api', app: 'Orca' } }])
  assert.equal(worker.logs.filter((line) => line.includes('dial: status bar unavailable')).length, 1)
})

test('a status bar update refused for now is sent again after the wait Orca names, and not logged', async () => {
  const bar = rateLimited()
  const time = clock()
  const { worker, stream, changes, updates } = await streaming(bar.answer, { after: time.after })
  stream.send(ATTACHED)
  await until(() => changes().length === 1)
  bar.refuseNext()
  stream.send(AGENT)
  await until(() => changes().length === 2)
  // A turn, for Orca's refusal to reach the worker.
  await new Promise((done) => setImmediate(done))
  const wait = time.waits.find(({ ms }) => ms === 50)
  assert.ok(wait, 'a wait of 50 ms')
  const sent = updates().length
  wait.run()
  await until(() => updates().length === sent + 1)
  const agent = { id: 'dial', visible: true, text: 'api' }
  assert.deepEqual(updates().slice(-2), [agent, agent])
  assert.deepEqual(worker.logs.filter((line) => line.includes('status bar')), [])
  await worker.deactivate()
})

test('a refused update is not sent again once a newer one was', async () => {
  const bar = rateLimited()
  const time = clock()
  const { worker, stream, changes, updates } = await streaming(bar.answer, { after: time.after })
  bar.refuseNext()
  stream.send(ATTACHED)
  await until(() => changes().length === 1)
  await new Promise((done) => setImmediate(done))
  stream.send(AGENT)
  await until(() => changes().length === 2)
  const wait = time.waits.find(({ ms }) => ms === 50)
  assert.ok(wait, 'a wait of 50 ms')
  const sent = updates().length
  wait.run()
  // A turn, for an update the worker should not send.
  await new Promise((done) => setImmediate(done))
  assert.equal(updates().length, sent)
  await worker.deactivate()
})

test('deactivate cancels an update waiting to be sent again, and one it did not stop is not sent', async () => {
  const bar = rateLimited()
  const time = clock()
  const { worker, stream, changes, updates } = await streaming(bar.answer, { after: time.after })
  bar.refuseNext()
  stream.send(ATTACHED)
  await until(() => changes().length === 1)
  await new Promise((done) => setImmediate(done))
  const wait = time.waits.find(({ ms }) => ms === 50)
  assert.ok(wait, 'a wait of 50 ms')
  await worker.deactivate()
  assert.ok(wait.cancelled, 'the wait cancelled')
  const sent = updates().length
  // A timer that fires anyway, as one already on its way can.
  wait.run()
  await new Promise((done) => setImmediate(done))
  assert.equal(updates().length, sent)
})

test('deactivate stops the loop: nothing is posted or updated after it', async () => {
  const { worker, stream, changes, updates } = await streaming()
  stream.send(ATTACHED)
  await until(() => changes().length === 1)
  await worker.deactivate()
  const seen = [worker.posts.length, updates().length]
  stream.send(AGENT)
  // A turn for a line the loop should no longer read.
  await new Promise((done) => setImmediate(done))
  assert.deepEqual([worker.posts.length, updates().length], seen)
})

test('the real worker, with a home and a PATH that hold no launcher, says noHarness', async () => {
  const { HOME, PATH } = process.env
  process.env.HOME = dir
  process.env.PATH = dir
  try {
    const worker = await mountWorker(main, { host: host() })
    const said = () => worker.posts.some((post) => post.event === 'dial.changed' && (post.payload as { state?: string }).state === 'noHarness')
    await until(said)
    assert.deepEqual(worker.refusals, [])
    await worker.deactivate()
  } finally {
    // Assigning undefined to process.env stores the word "undefined".
    if (HOME === undefined) delete process.env.HOME
    else process.env.HOME = HOME
    if (PATH === undefined) delete process.env.PATH
    else process.env.PATH = PATH
  }
})
