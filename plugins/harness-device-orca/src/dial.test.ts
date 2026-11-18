// The loop, against a clock, a launcher and a watch of this file's own, and Node's real connect to servers on sockets
// in a folder it makes under /tmp: never the developer's own harness, daemon or dial.
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { mkdtempSync, renameSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { startDial, type Dial } from './dial'
import { MISSING, nodeInputs, type DialInputs, type Ran } from './inputs'
import type { DialState } from './protocol'

const UNPLUGGED = '{"daemon":true,"devicesSocket":"/run/h/devices.sock","devicesReady":false}'
const AGENT = '{"attached":true,"agent":{"name":"api","app":"Orca"}}'
const LINK = { args: ['device', 'orca', 'link'], path: '/usr/bin:/bin', timeoutMs: 5_000, maxBytes: 4_096 }

let dir = ''
let servers: Server[] = []
let dials: Dial[] = []

beforeEach(() => {
  dir = mkdtempSync('/tmp/hdo-')
})

afterEach(async () => {
  await Promise.all(dials.map((dial) => dial.stop()))
  dials = []
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
  servers = []
  rmSync(dir, { recursive: true, force: true })
})

function ready(socket: string): string {
  return JSON.stringify({ daemon: true, devicesSocket: socket, devicesReady: true })
}

type Timer = { at: number; run: () => void }
type Watch = { folder: string; changed: (name: string | null) => void; failed: () => void; closed: boolean }

/** A loop on inputs of the test's own. `answers` are link's, one a run; with none left, a run lasts until aborted.
 *  `replies` are the devices' answers to the posts, one a post: a status, null, or one the test settles, which an abort
 *  makes null; with none left, 204. */
function world(answers: (Ran | Promise<Ran>)[], over: Partial<DialInputs> = {}) {
  let time = 0
  const timers = new Set<Timer>()
  const scheduled: number[] = []
  const runs: { file: string; args: readonly string[]; path: string; timeoutMs: number; maxBytes: number; signal: AbortSignal; at: number }[] = []
  const posts: { socket: string; body: string; signal: AbortSignal }[] = []
  const replies: (number | null | Promise<number | null>)[] = []
  const watches: Watch[] = []
  const states: DialState[] = []
  const logs: string[] = []
  const checks = new Set<() => void>()
  // Each call the loop makes may be the one a test waits for.
  const called = () => {
    for (const check of checks) check()
  }
  const inputs: DialInputs = {
    platform: 'darwin',
    home: '/h',
    path: '/usr/bin:/bin',
    run(file, args, bounds) {
      runs.push({ file, args, ...bounds, at: time })
      called()
      if (answers.length > 0) return Promise.resolve(answers.shift()!)
      return new Promise((settle) => bounds.signal.addEventListener('abort', () => settle(null)))
    },
    connect: nodeInputs().connect,
    post(socket, body, signal) {
      posts.push({ socket, body, signal })
      called()
      const reply = replies.length > 0 ? replies.shift()! : 204
      return new Promise((settle) => {
        signal.addEventListener('abort', () => settle(null))
        void Promise.resolve(reply).then(settle)
      })
    },
    watch(folder, changed, failed) {
      const watch = { folder, changed, failed, closed: false }
      watches.push(watch)
      called()
      return () => {
        watch.closed = true
      }
    },
    now: () => time,
    after(ms, run) {
      const timer = { at: time + ms, run }
      timers.add(timer)
      scheduled.push(ms)
      called()
      return () => {
        timers.delete(timer)
      }
    },
    ...over,
  }
  const dial = startDial(inputs, {
    changed(state) {
      states.push(state)
      called()
    },
    log(line) {
      logs.push(line)
      called()
    },
  })
  dials.push(dial)
  return {
    dial,
    runs,
    posts,
    replies,
    watches,
    states,
    logs,
    timers,
    scheduled,
    due: () => [...timers].map((timer) => timer.at),
    /** Resolves once `holds` does: it is asked again at each call the loop makes. */
    until(holds: () => boolean): Promise<void> {
      return new Promise((done) => {
        const check = () => {
          if (!holds()) return
          checks.delete(check)
          done()
        }
        checks.add(check)
        check()
      })
    },
    /** The clock to `at`, each timer due by then fired at its own time. */
    to(at: number): void {
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= at).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.delete(due)
        time = due.at
        due.run()
      }
      time = at
    },
  }
}

type Opened = { req: IncomingMessage; res: ServerResponse; body: string; closed: Promise<void> }

/** A devices' socket in the test's folder; `open` gets each stream opened on it. */
async function serve(open: (stream: Opened) => void): Promise<string> {
  const socket = `${dir}/s${servers.length}.sock`
  const server = createServer((req, res) => {
    const closed = new Promise<void>((done) => res.on('close', done))
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => open({ req, res, body, closed }))
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(socket, done))
  return socket
}

/** A devices' socket whose next stream is answered 200 at once. */
async function devices(): Promise<{ socket: string; opened: Promise<Opened> }> {
  let opened: (stream: Opened) => void = () => {}
  const next = new Promise<Opened>((done) => (opened = done))
  const socket = await serve((stream) => {
    stream.res.writeHead(200)
    stream.res.flushHeaders()
    opened(stream)
  })
  return { socket, opened: next }
}

/** A loop whose link says ready, and the stream it opened. */
async function streaming(more: (Ran | Promise<Ran>)[] = []) {
  const { socket, opened } = await devices()
  const w = world([ready(socket), ...more])
  return { w, stream: await opened }
}

/** Unplugged with its watch on, its look again done, and a second gone since the last pass: a change asks at once. */
async function watching(more: (Ran | Promise<Ran>)[]) {
  const w = world([UNPLUGGED, UNPLUGGED, ...more])
  await w.until(() => w.timers.size > 0)
  w.to(1_000)
  await w.until(() => w.runs.length === 2 && w.timers.size > 0)
  w.to(2_000)
  return w
}

/** A connect that answers 200 with the chunks the test sends, each as sent; an abort ends them. */
function feed() {
  const queue: Uint8Array[] = []
  let ended = false
  let wake = () => {}
  return {
    connect(_socket: string, _body: string, signal: AbortSignal) {
      signal.addEventListener('abort', () => {
        queue.length = 0
        ended = true
        wake()
      })
      async function* chunks(): AsyncGenerator<Uint8Array> {
        for (;;) {
          const chunk = queue.shift()
          if (chunk) yield chunk
          else if (ended) return
          else await new Promise<void>((done) => (wake = done))
        }
      }
      return Promise.resolve({ status: 200, chunks: chunks() })
    },
    send(...chunks: Uint8Array[]) {
      queue.push(...chunks)
      wake()
    },
  }
}

const bytes = (text: string) => new TextEncoder().encode(text)

test('on Windows the state is windows, and nothing is run or scheduled', async () => {
  const w = world([], { platform: 'win32' })
  await w.until(() => w.states.length > 0)
  await w.dial.stop()
  assert.deepEqual([w.states, w.runs, w.scheduled, w.watches], [[{ state: 'windows' }], [], [], []])
})

test('with no launcher the state is noHarness; ~/.local/bin/harness is asked first, then harness', async () => {
  const w = world([MISSING, MISSING])
  await w.until(() => w.states.length > 0)
  assert.deepEqual(w.states, [{ state: 'noHarness' }])
  assert.deepEqual(
    w.runs.map(({ file, args, path, timeoutMs, maxBytes }) => ({ file, args, path, timeoutMs, maxBytes })),
    [
      { file: '/h/.local/bin/harness', ...LINK },
      { file: 'harness', ...LINK },
    ]
  )
  // The first answer that is not missing is the launcher's.
  const second = world([MISSING, UNPLUGGED])
  await second.until(() => second.states.length > 0)
  assert.deepEqual(second.states, [{ state: 'unplugged' }])
})

test('with no home only harness is asked', async () => {
  const w = world([MISSING], { home: '' })
  await w.until(() => w.states.length > 0)
  assert.deepEqual(w.runs.map((run) => run.file), ['harness'])
})

test('a launcher that prints missing is notRunning, and the next is not asked', async () => {
  const w = world(['missing', null])
  await w.until(() => w.states.length > 0)
  assert.deepEqual([w.states, w.runs.length], [[{ state: 'notRunning' }], 1])
})

test('a launcher that fails is notRunning, and the next is not asked', async () => {
  const w = world([null])
  await w.until(() => w.states.length > 0)
  assert.deepEqual([w.states, w.runs.length], [[{ state: 'notRunning' }], 1])
})

test('a launcher that prints anything else is notRunning, and nothing is connected', async () => {
  const printed = [
    '',
    'warning\n{"daemon":true}',
    '[]',
    'null',
    '{"daemon":"yes","devicesReady":true}',
    '{"daemon":true}',
    '{"daemon":true,"devicesSocket":"/run/h/devices.sock","devicesReady":"yes"}',
    '{"daemon":true,"devicesSocket":"devices.sock","devicesReady":true}',
    '{"daemon":true,"devicesSocket":"devices.sock","devicesReady":false}',
    '{"daemon":true,"devicesSocket":7,"devicesReady":true}',
    '{"daemon":true,"devicesReady":true}',
    // Node 22's connect throws past its own error handler on a NUL in the path (Orca 1.4.256's Node 24 says EINVAL).
    '{"daemon":true,"devicesSocket":"/run/h/devices\\u0000.sock","devicesReady":true}',
  ]
  for (const out of printed) {
    let connected = 0
    const connect = () => {
      connected += 1
      return Promise.resolve(null)
    }
    const w = world([out], { connect })
    await w.until(() => w.states.length > 0)
    assert.deepEqual([out, w.states, connected, w.watches], [out, [{ state: 'notRunning' }], 0, []])
  }
})

test('daemon false is notRunning, whatever devicesReady says, and nothing is connected; daemon true with devicesReady false is unplugged', async () => {
  const cases = [
    ['{"daemon":false,"devicesSocket":"/run/h/devices.sock","devicesReady":true}', 'notRunning', []],
    ['{"daemon":false,"devicesSocket":"/run/h/devices.sock","devicesReady":false}', 'notRunning', []],
    ['{"daemon":false,"devicesReady":false}', 'notRunning', []],
    [UNPLUGGED, 'unplugged', ['/run/h']],
    ['{"daemon":true,"devicesReady":false}', 'unplugged', []],
  ] as const
  for (const [out, state, folders] of cases) {
    let connected = 0
    const connect = () => {
      connected += 1
      return Promise.resolve(null)
    }
    const w = world([out], { connect })
    await w.until(() => w.states.length > 0)
    assert.deepEqual(
      [out, w.states, connected, w.watches.map((watch) => watch.folder)],
      [out, [{ state }], 0, folders]
    )
  }
})

test("unplugged watches the folder of devicesSocket, and a change of the socket's entry asks link again at once", async () => {
  const w = await watching([UNPLUGGED])
  assert.deepEqual(w.watches.map((watch) => watch.folder), ['/run/h'])
  w.watches[0].changed('devices.sock')
  assert.deepEqual(w.runs.map((run) => run.at), [0, 1_000, 2_000])
})

test('a change of another entry asks nothing; a change with no name asks', async () => {
  const w = await watching([UNPLUGGED])
  w.watches[0].changed('registry.json')
  assert.equal(w.runs.length, 2)
  w.watches[0].changed(null)
  assert.equal(w.runs.length, 3)
})

test('changes ask link at most once a second', async () => {
  const w = await watching([UNPLUGGED, UNPLUGGED])
  for (let i = 0; i < 3; i++) w.watches[0].changed('devices.sock')
  await w.until(() => w.timers.size > 0)
  assert.deepEqual(w.due(), [3_000])
  w.to(3_000)
  await w.until(() => w.runs.length === 4 && w.timers.size > 0)
  assert.deepEqual(w.runs.map((run) => run.at), [0, 1_000, 2_000, 3_000])
})

test('a change while link runs asks once more', async () => {
  let answer: (ran: Ran) => void = () => {}
  const w = await watching([new Promise<Ran>((done) => (answer = done)), UNPLUGGED])
  w.watches[0].changed('devices.sock')
  // The run outlasts a second, so the one more starts as it ends.
  w.to(3_500)
  w.watches[0].changed('devices.sock')
  answer(UNPLUGGED)
  await w.until(() => w.runs.length === 4 || w.timers.size > 0)
  assert.deepEqual(w.runs.map((run) => run.at), [0, 1_000, 2_000, 3_500])
})

test('a watch that cannot start is logged once, asks nothing more, and the next pass tries it again', async () => {
  const folders: string[] = []
  const w = world([UNPLUGGED, UNPLUGGED, UNPLUGGED], {
    watch(folder, _changed, failed) {
      folders.push(folder)
      failed()
      return () => {}
    },
  })
  await w.until(() => w.timers.size > 0)
  // The wait of 1 s, not the look again a second after a watch that started.
  w.to(w.due()[0])
  await w.until(() => w.runs.length === 2 && w.timers.size > 0)
  // The backoff goes on: the watch is not a reason to ask again.
  assert.deepEqual(w.due(), [3_000])
  w.to(3_000)
  await w.until(() => w.runs.length === 3 && w.timers.size > 0)
  assert.deepEqual(folders, ['/run/h', '/run/h', '/run/h'])
  assert.deepEqual(w.logs, ['dial: unplugged', 'dial: watch unavailable'])
})

test('a watch that stops on its own is logged, and the next pass watches again', async () => {
  const w = world([UNPLUGGED, UNPLUGGED, UNPLUGGED])
  await w.until(() => w.timers.size > 0)
  w.to(1_000)
  await w.until(() => w.runs.length === 2 && w.timers.size > 0)
  w.watches[0].failed()
  assert.deepEqual(w.logs, ['dial: unplugged', 'dial: watch unavailable'])
  w.to(w.due()[0])
  await w.until(() => w.runs.length === 3 && w.timers.size > 0)
  assert.deepEqual(w.watches.map((watch) => watch.folder), ['/run/h', '/run/h'])
})

test('the watcher closes when the state leaves unplugged', async () => {
  const w = world([UNPLUGGED, null])
  await w.until(() => w.timers.size > 0)
  assert.equal(w.watches[0].closed, false)
  w.to(1_000)
  await w.until(() => w.states.length === 2)
  assert.deepEqual([w.states[1], w.watches.length, w.watches[0].closed], [{ state: 'notRunning' }, 1, true])
})

test('once the watch is on, link is asked once more a second after, so a socket made as the watch started is seen', async () => {
  const w = world([null, UNPLUGGED, UNPLUGGED])
  await w.until(() => w.timers.size > 0)
  w.to(1_000)
  await w.until(() => w.watches.length === 1 && w.timers.size > 0)
  // Before the wait of 2 s the second pass would otherwise take.
  assert.deepEqual(w.due(), [2_000])
  w.to(2_000)
  await w.until(() => w.runs.length === 3 && w.timers.size > 0)
  // Once: the watch that stays on asks nothing more, and link is looked at again in 5 min.
  assert.deepEqual([w.watches.length, w.due()], [1, [302_000]])
})

test('the stream: the open is POST / with {"type":"dial","standby":true}, and each line becomes the state', async () => {
  const { w, stream } = await streaming()
  assert.deepEqual([stream.req.method, stream.req.url, stream.body], ['POST', '/', '{"type":"dial","standby":true}'])
  for (const [i, line] of ['{"attached":false}', '{"attached":true,"agent":null}', AGENT].entries()) {
    stream.res.write(`${line}\n`)
    await w.until(() => w.states.length === i + 1)
  }
  const agent = { state: 'attached', agent: { name: 'api', app: 'Orca' } }
  assert.deepEqual(w.states, [{ state: 'unplugged' }, { state: 'attached' }, agent])
  assert.deepEqual(w.dial.state(), agent)
})

test('a 409 is elsewhere; a 404, a 429 and a 500 are notRunning', async () => {
  let status = 0
  const socket = await serve(({ res }) => res.writeHead(status).end())
  const cases = [[409, 'elsewhere'], [404, 'notRunning'], [429, 'notRunning'], [500, 'notRunning']] as const
  for (const [code, state] of cases) {
    status = code
    const w = world([ready(socket)])
    await w.until(() => w.states.length > 0)
    assert.deepEqual([code, w.states], [code, [{ state }]])
  }
})

test('a connect that is refused, or gets no answer in 2 s, is notRunning', async () => {
  // A socket file whose listener is gone, as a crashed devices process leaves it: closing would remove its name.
  const left = await serve(() => {})
  renameSync(left, `${dir}/stale.sock`)
  const gone = servers.pop()!
  await new Promise((done) => gone.close(done))
  const refused = world([ready(`${dir}/stale.sock`)])
  await refused.until(() => refused.states.length > 0)
  assert.deepEqual(refused.states, [{ state: 'notRunning' }])

  let asked = () => {}
  const open = new Promise<void>((done) => (asked = done))
  const silent = world([ready(await serve(() => asked()))])
  await open
  assert.deepEqual([silent.states, silent.due()], [[], [2_000]])
  silent.to(2_000)
  await silent.until(() => silent.states.length > 0)
  assert.deepEqual(silent.states, [{ state: 'notRunning' }])
})

test('a line split across two chunks is one state, and two lines in one chunk are two', async () => {
  const stream = feed()
  const w = world([ready('/run/h/devices.sock')], { connect: stream.connect })
  const line = bytes('{"attached":true,"agent":{"name":"café","app":"Orca"}}\n')
  // Between the two bytes of é.
  const cut = line.indexOf(0xa9)
  stream.send(line.subarray(0, cut), line.subarray(cut))
  await w.until(() => w.states.length === 1)
  stream.send(bytes('{"attached":false}\n{"attached":true,"agent":null}\n'))
  await w.until(() => w.states.length === 3)
  assert.deepEqual(w.states, [
    { state: 'attached', agent: { name: 'café', app: 'Orca' } },
    { state: 'unplugged' },
    { state: 'attached' },
  ])
})

test('a line over 1 KiB, and 1 KiB with no newline, drop the stream and are logged; a line of 1 KiB with its newline is taken', async () => {
  const { w, stream } = await streaming()
  const name = 'n'.repeat(1_023 - '{"attached":true,"agent":{"name":"","app":"Orca"}}'.length)
  stream.res.write(`{"attached":true,"agent":{"name":"${name}","app":"Orca"}}\n`)
  await w.until(() => w.states.length === 1)
  assert.equal(w.states[0].agent?.name, name)

  for (const tooLong of [`${'x'.repeat(1_024)}\n`, 'x'.repeat(1_024)]) {
    const { w, stream } = await streaming()
    stream.res.write('{"attached":true,"agent":null}\n')
    await w.until(() => w.states.length === 1)
    stream.res.write(tooLong)
    await stream.closed
    await w.until(() => w.timers.size > 0)
    assert.deepEqual([w.states, w.dial.state()], [[{ state: 'attached' }], { state: 'attached' }])
    assert.deepEqual(w.logs, ['dial: attached', 'dial: line too long'])
  }
})

test('a malformed line is skipped and counted, the state stays, and the next good line is taken', async () => {
  const { w, stream } = await streaming()
  stream.res.write('{"attached":true,"agent":null}\n')
  await w.until(() => w.states.length === 1)
  const malformed = ['not json', '[]', '{"attached":"yes"}', '{"attached":true}', '{"attached":true,"agent":{"name":1,"app":"Orca"}}']
  stream.res.write(`${malformed.join('\n')}\n{"attached":false}\n`)
  await w.until(() => w.states.length === 2)
  assert.deepEqual([w.states, w.logs], [[{ state: 'attached' }, { state: 'unplugged' }], ['dial: attached', 'dial: unplugged']])
  stream.res.end()
  await w.until(() => w.logs.length === 3)
  assert.equal(w.logs[2], 'dial: 5 lines skipped')
})

test('only name and app are taken from an agent', async () => {
  const { w, stream } = await streaming()
  stream.res.write('{"attached":true,"agent":{"id":"a1","name":"api","app":"Orca","terminal":"t1"},"cwd":"/x"}\n')
  await w.until(() => w.states.length === 1)
  assert.deepEqual(w.states, [{ state: 'attached', agent: { name: 'api', app: 'Orca' } }])
})

test('{"replaced":true} ends the stream like a close', async () => {
  const { w, stream } = await streaming()
  stream.res.write('{"attached":true,"agent":null}\n{"replaced":true}\n')
  await stream.closed
  await w.until(() => w.timers.size > 0)
  assert.deepEqual([w.states, w.logs, w.due()], [[{ state: 'attached' }], ['dial: attached'], [1_000]])
})

test('when the stream ends the state is kept, and link is asked again after 1 s, 2 s, 4 s, 8 s, 16 s, 30 s and 30 s', async () => {
  const { w, stream } = await streaming([null, null, null, null, null, null, null])
  stream.res.write('{"attached":true,"agent":null}\n')
  await w.until(() => w.states.length === 1)
  stream.res.end()
  await w.until(() => w.timers.size > 0)
  assert.deepEqual(w.dial.state(), { state: 'attached' })
  for (let pass = 2; pass <= 8; pass++) {
    w.to(w.due()[0])
    await w.until(() => w.runs.length === pass && w.timers.size > 0)
  }
  assert.deepEqual(w.runs.map((run) => run.at), [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000, 91_000])
})

test('a pass that ends unplugged with its watch on looks again in 5 min, and starts the wait again from 1 s', async () => {
  const { socket, opened } = await devices()
  // Three failing passes first, so the wait has grown to 8 s.
  const w = world([null, null, null, UNPLUGGED, UNPLUGGED, ready(socket)])
  for (let pass = 1; pass <= 4; pass++) {
    await w.until(() => w.runs.length === pass && w.timers.size > 0)
    w.to(w.due()[0])
  }
  await w.until(() => w.runs.length === 5 && w.timers.size > 0)
  assert.deepEqual([w.runs.map((run) => run.at), w.due()], [[0, 1_000, 3_000, 7_000, 8_000], [308_000]])
  // The socket appears; the stream it opens ends at once.
  w.to(9_000)
  w.watches[0].changed('devices.sock')
  const stream = await opened
  stream.res.write('{"attached":true,"agent":null}\n')
  await w.until(() => w.states.length === 3)
  stream.res.end()
  await w.until(() => w.timers.size > 0)
  assert.deepEqual(w.due(), [10_000])
})

test('a stream that stayed open over 30 s starts the wait again from 1 s; one that stayed 30 s does not', async () => {
  for (const [open, wait] of [[30_001, 1_000], [30_000, 4_000]] as const) {
    const { socket, opened } = await devices()
    // Two passes first, so the wait has grown to 4 s.
    const w = world([null, null, ready(socket)])
    await w.until(() => w.timers.size > 0)
    w.to(1_000)
    await w.until(() => w.runs.length === 2 && w.timers.size > 0)
    w.to(3_000)
    const stream = await opened
    stream.res.write('{"attached":true,"agent":null}\n')
    await w.until(() => w.states.length === 2)
    w.to(3_000 + open)
    stream.res.end()
    await w.until(() => w.timers.size > 0)
    assert.deepEqual([open, w.due()], [open, [3_000 + open + wait]])
  }
})

test('the same state twice is told once', async () => {
  const { w, stream } = await streaming()
  stream.res.write(`${AGENT}\n${AGENT}\n{"attached":false}\n{"attached":false}\n{"attached":true,"agent":null}\n`)
  await w.until(() => w.states.length === 3)
  const agent = { state: 'attached', agent: { name: 'api', app: 'Orca' } }
  assert.deepEqual(w.states, [agent, { state: 'unplugged' }, { state: 'attached' }])
})

test('stop ends a running link, and nothing is told after it', async () => {
  const w = world([])
  await w.until(() => w.runs.length === 1)
  await w.dial.stop()
  assert.deepEqual([w.runs.length, w.runs[0].signal.aborted, w.states, w.logs, w.timers.size], [1, true, [], [], 0])
})

test('stop ends a connect that waits for its answer, and leaves no timer', async () => {
  let asked: (stream: Opened) => void = () => {}
  const open = new Promise<Opened>((done) => (asked = done))
  const w = world([ready(await serve((stream) => asked(stream)))])
  const stream = await open
  await w.dial.stop()
  await stream.closed
  assert.deepEqual([w.states, w.timers.size], [[], 0])
})

test('stop ends an open stream: its connection closes, and nothing is told or logged after it', async () => {
  const { w, stream } = await streaming()
  // The skipped line would be logged as the stream ends.
  stream.res.write('not json\n{"attached":true,"agent":null}\n')
  await w.until(() => w.states.length === 1)
  await w.dial.stop()
  await stream.closed
  assert.deepEqual([w.states, w.logs, w.timers.size], [[{ state: 'attached' }], ['dial: attached'], 0])
})

test('stop closes the watcher: a change after it asks nothing', async () => {
  const w = world([UNPLUGGED])
  await w.until(() => w.timers.size > 0)
  await w.dial.stop()
  assert.equal(w.watches[0].closed, true)
  w.watches[0].changed('devices.sock')
  assert.equal(w.runs.length, 1)
})

test('stop cancels the wait: no timer is left', async () => {
  const w = world([null])
  await w.until(() => w.timers.size > 0)
  await w.dial.stop()
  assert.equal(w.timers.size, 0)
})

test('the log names each state as it changes, and holds no name, app or path', async () => {
  const { w, stream } = await streaming([null])
  const web = '{"attached":true,"agent":{"name":"web","app":"Codex"}}'
  stream.res.write(`{"attached":false}\n${AGENT}\n${web}\nnot json\n`)
  await w.until(() => w.states.length === 3)
  stream.res.end()
  await w.until(() => w.timers.size > 0)
  w.to(1_000)
  await w.until(() => w.states.length === 4)
  assert.deepEqual(w.logs, ['dial: unplugged', 'dial: attached', 'dial: 1 lines skipped', 'dial: notRunning'])
})

const H = (n: number) => `term_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
/** The body that tells the devices these terminals. */
const fronted = (...ids: string[]) => `{"type":"orcaFront","terminals":[${ids.map((id) => `"${id}"`).join(',')}]}`
const bodies = (w: { posts: { body: string }[] }) => w.posts.map((post) => post.body)
/** Every answer already given reaches the loop: it takes them in microtasks, and this resolves on a turn after them. */
const answered = () => new Promise<void>((done) => setImmediate(done))

test("front() with a stream open posts the ids to the stream's socket", async () => {
  const { socket, opened } = await devices()
  const w = world([ready(socket)])
  await opened
  w.dial.front([H(1), H(2)])
  await w.until(() => w.posts.length === 1)
  assert.deepEqual(
    w.posts.map(({ socket, body }) => ({ socket, body })),
    [{ socket, body: '{"type":"orcaFront","terminals":["term_00000000-0000-4000-8000-000000000001","term_00000000-0000-4000-8000-000000000002"]}' }]
  )
})

test('front(null) posts "terminals":null', async () => {
  const { w } = await streaming()
  w.dial.front(null)
  await w.until(() => w.posts.length === 1)
  assert.deepEqual(bodies(w), ['{"type":"orcaFront","terminals":null}'])
})

test('ids that are no handle are left out, the order kept, and at most 50 go', async () => {
  const { w } = await streaming()
  // Not in order, so a sort would show.
  const handles = Array.from({ length: 54 }, (_, i) => H(54 - i))
  w.dial.front([...handles.slice(0, 2), 'x', H(1).toUpperCase(), 7 as unknown as string, ...handles.slice(2)])
  await w.until(() => w.posts.length === 1)
  assert.deepEqual(JSON.parse(w.posts[0].body), { type: 'orcaFront', terminals: handles.slice(0, 50) })
})

test('with no stream open nothing is posted, and the latest ids go when one opens', async () => {
  const elsewhere = await serve(({ res }) => res.writeHead(409).end())
  const { socket } = await devices()
  const w = world([UNPLUGGED, null, ready(elsewhere), ready(socket)])
  await w.until(() => w.states.length === 1 && w.timers.size > 0)
  w.dial.front([H(1)])
  w.to(1_000)
  await w.until(() => w.states.length === 2 && w.timers.size > 0)
  w.dial.front([H(2)])
  w.to(2_000)
  await w.until(() => w.states.length === 3 && w.timers.size > 0)
  assert.deepEqual([w.states, w.posts], [[{ state: 'unplugged' }, { state: 'notRunning' }, { state: 'elsewhere' }], []])
  w.to(4_000)
  await w.until(() => w.posts.length === 1)
  assert.deepEqual(bodies(w), [fronted(H(2))])
})

test('each open posts the latest ids again', async () => {
  const { socket, opened } = await devices()
  const w = world([ready(socket), ready(socket)])
  const stream = await opened
  w.dial.front([H(1)])
  await w.until(() => w.posts.length === 1)
  await answered()
  stream.res.end()
  await w.until(() => w.due().includes(1_000))
  w.to(1_000)
  await w.until(() => w.posts.length === 2)
  assert.deepEqual(w.posts.map(({ socket, body }) => ({ socket, body })), [
    { socket, body: fronted(H(1)) },
    { socket, body: fronted(H(1)) },
  ])
})

test('the same ids again post nothing', async () => {
  const { w } = await streaming()
  w.dial.front([H(1), H(2)])
  await w.until(() => w.posts.length === 1)
  await answered()
  w.dial.front([H(1), H(2)])
  await answered()
  assert.deepEqual(bodies(w), [fronted(H(1), H(2))])
})

test('a send that fails is sent once more 1 s later; if that fails too it is logged once, with no id', async () => {
  const { w } = await streaming()
  w.replies.push(500, null)
  w.dial.front([H(1)])
  await w.until(() => w.due().includes(1_000))
  // The same ids during the wait, as a tab renamed sends them, wait for the retry too.
  w.dial.front([H(1)])
  await answered()
  assert.deepEqual([w.posts.length, w.logs, w.due()], [1, [], [1_000]])
  w.to(1_000)
  await w.until(() => w.logs.length > 0)
  w.to(60_000)
  await answered()
  assert.deepEqual([bodies(w), w.logs, w.timers.size], [[fronted(H(1)), fronted(H(1))], ['dial: front not sent'], 0])
  assert.equal(w.logs.some((line) => line.includes('term_')), false)
})

test('after a logged failure the same ids are sent again at the next front()', async () => {
  const { w } = await streaming()
  w.replies.push(500, 500)
  w.dial.front([H(1)])
  await w.until(() => w.due().includes(1_000))
  w.to(1_000)
  await w.until(() => w.logs.length > 0)
  w.dial.front([H(1)])
  await w.until(() => w.posts.length === 3)
  assert.deepEqual(bodies(w), [fronted(H(1)), fronted(H(1)), fronted(H(1))])
})

test("a newer front() during the wait is sent at once, and the older one's retry is not", async () => {
  const { w } = await streaming()
  w.replies.push(500)
  w.dial.front([H(1)])
  await w.until(() => w.due().includes(1_000))
  w.dial.front([H(2)])
  await w.until(() => w.posts.length === 2)
  await answered()
  w.to(5_000)
  await answered()
  assert.deepEqual([bodies(w), w.logs, w.timers.size], [[fronted(H(1)), fronted(H(2))], [], 0])

  // Back to the ids the devices took: nothing to send, and the refused one's retry is not sent either.
  w.replies.push(500)
  w.dial.front([H(3)])
  await w.until(() => w.due().includes(6_000))
  w.dial.front([H(2)])
  w.to(10_000)
  await answered()
  assert.deepEqual([bodies(w), w.logs, w.timers.size], [[fronted(H(1)), fronted(H(2)), fronted(H(3))], [], 0])
})

test('the stream ending during the wait cancels the retry: nothing more is sent or logged', async () => {
  const { w, stream } = await streaming()
  w.replies.push(500)
  w.dial.front([H(1)])
  await w.until(() => w.due().includes(1_000))
  w.to(500)
  stream.res.end()
  // The next pass's wait alone.
  await w.until(() => w.due().includes(1_500))
  assert.deepEqual(w.due(), [1_500])
  w.to(1_500)
  await w.until(() => w.runs.length === 2)
  assert.deepEqual([bodies(w), w.logs], [[fronted(H(1))], []])
})

test('sends never overlap: front() calls while one is in flight send only the latest once it answers', async () => {
  const { w } = await streaming()
  let answer: (status: number) => void = () => {}
  w.replies.push(new Promise((done) => (answer = done)))
  w.dial.front([H(1)])
  await w.until(() => w.posts.length === 1)
  w.dial.front([H(2)])
  w.dial.front([H(3)])
  await answered()
  assert.deepEqual(bodies(w), [fronted(H(1))])
  answer(204)
  await w.until(() => w.posts.length === 2)
  await answered()
  assert.deepEqual(bodies(w), [fronted(H(1)), fronted(H(3))])

  // One that fails once a newer one waits is neither sent again nor logged: the newer goes at once.
  let refuse: (status: number) => void = () => {}
  w.replies.push(new Promise((done) => (refuse = done)))
  w.dial.front([H(4)])
  await w.until(() => w.posts.length === 3)
  w.dial.front([H(5)])
  refuse(500)
  await answered()
  w.to(5_000)
  await answered()
  assert.deepEqual([bodies(w).slice(2), w.logs, w.timers.size], [[fronted(H(4)), fronted(H(5))], [], 0])
})

test('a send with no answer in 2 s is aborted and counts as failed', async () => {
  const { w } = await streaming()
  w.replies.push(new Promise(() => {}))
  w.dial.front([H(1)])
  await w.until(() => w.posts.length === 1)
  assert.deepEqual(w.due(), [2_000])
  w.to(1_999)
  assert.equal(w.posts[0].signal.aborted, false)
  w.to(2_000)
  assert.equal(w.posts[0].signal.aborted, true)
  await w.until(() => w.due().includes(3_000))
  w.to(3_000)
  await w.until(() => w.posts.length === 2)
  assert.deepEqual([bodies(w), w.logs], [[fronted(H(1)), fronted(H(1))], []])
})

test('a daemon from before orcaFront answers 404: one retry, one line, and the state and the stream are untouched', async () => {
  const { w, stream } = await streaming()
  stream.res.write('{"attached":true,"agent":null}\n')
  await w.until(() => w.states.length === 1)
  w.replies.push(404, 404)
  w.dial.front([H(1)])
  await w.until(() => w.due().includes(1_000))
  w.to(1_000)
  await w.until(() => w.logs.length === 2)
  w.to(60_000)
  await answered()
  assert.deepEqual([w.posts.length, w.logs, w.dial.state()], [2, ['dial: attached', 'dial: front not sent'], { state: 'attached' }])
  // A later line of the same stream still becomes the state.
  stream.res.write(`${AGENT}\n`)
  await w.until(() => w.states.length === 2)
  assert.deepEqual(w.dial.state(), { state: 'attached', agent: { name: 'api', app: 'Orca' } })
})

test('on Windows, and after stop(), front() posts nothing and throws nothing; stop() aborts a send in flight and leaves no timer', async () => {
  const windows = world([], { platform: 'win32' })
  await windows.until(() => windows.states.length > 0)
  windows.dial.front([H(1)])
  windows.dial.front(null)
  await answered()
  assert.deepEqual([windows.posts, windows.timers.size], [[], 0])

  const { w } = await streaming()
  w.replies.push(new Promise(() => {}))
  w.dial.front([H(1)])
  await w.until(() => w.posts.length === 1)
  await w.dial.stop()
  assert.deepEqual([w.posts[0].signal.aborted, w.timers.size], [true, 0])
  w.dial.front([H(2)])
  await answered()
  assert.deepEqual([w.posts.length, w.logs], [1, []])

  // A retry that waits is cancelled too.
  const waiting = await streaming()
  waiting.w.replies.push(500)
  waiting.w.dial.front([H(1)])
  await waiting.w.until(() => waiting.w.due().includes(1_000))
  // From the call of stop(), though the stream ends a moment after it.
  const stopping = waiting.w.dial.stop()
  waiting.w.dial.front([H(2)])
  await stopping
  assert.deepEqual([waiting.w.posts.length, waiting.w.timers.size], [1, 0])
})
