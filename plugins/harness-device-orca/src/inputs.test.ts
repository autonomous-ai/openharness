// Node's real inputs, against scripts, sockets and folders this file makes under /tmp: never the developer's own.
import { afterEach, assert, beforeEach, test } from 'orca/testing'
import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MISSING, nodeInputs } from './inputs'

const BODY = '{"type":"dial","standby":true}'
const FRONT = '{"type":"orcaFront","terminals":null}'
const TOKEN = 'ab'.repeat(32)
let dir = ''
let servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync('/tmp/hdo-')
})

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
  servers = []
  rmSync(dir, { recursive: true, force: true })
})

function script(name: string, body: string): string {
  const file = `${dir}/${name}`
  // A bare /bin/sh, run once to its exit, then the body into the same file: macOS checks a new file on its first run,
  // queued machine-wide, and under load that alone passed the 5 s a run is given (cli/src/testing/executableFixture.ts,
  // which this plugin, with no dependencies, cannot import).
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  spawnSync(file)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  return file
}

function bounds(extra: { path?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  return { path: '/usr/bin:/bin', timeoutMs: 5_000, maxBytes: 4_096, signal: new AbortController().signal, ...extra }
}

async function serve(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void, socketPath = `${dir}/devices.sock`): Promise<string> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handle(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(socketPath, done))
  return socketPath
}

// HMAC-SHA256(token, separator ‖ nonce), as the devices compute it (cli/src/lib/windows/pipeAuth.ts).
function mac(token: string, separator: number, nonce: string): string {
  return createHmac('sha256', Buffer.from(token, 'hex')).update(Buffer.of(separator)).update(nonce).digest('hex')
}

/** The devices' pipe, stood in by a Unix socket named as a pipe is, harness-<32 hex>. A request whose auth proves TOKEN
 *  for a nonce that starts with that id is handed on with the proof its answer owes; any other is answered 401, as the
 *  devices answer it. */
async function servePipe(handle: (res: ServerResponse, proof: string, body: string) => void): Promise<string> {
  const id = randomBytes(16).toString('hex')
  return serve((req, res, body) => {
    const [nonce = '', auth] = String(req.headers['x-harness-auth']).split('.')
    if (nonce.length === 64 && nonce.startsWith(id) && auth === mac(TOKEN, 0x01, nonce)) handle(res, mac(TOKEN, 0x00, nonce), body)
    else res.writeHead(401).end('{"error":"PIPE_AUTH_REQUIRED"}')
  }, `${dir}/harness-${id}`)
}

// macOS starts a folder's watch a moment after fs.watch returns and misses what came before it, so the entry is
// written again until the watcher tells it.
async function writeUntilTold(file: string, told: Promise<unknown>): Promise<void> {
  writeFileSync(file, '')
  const again = setInterval(() => writeFileSync(file, ''), 20)
  try {
    await told
  } finally {
    clearInterval(again)
  }
}

async function text(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  let all = ''
  for await (const chunk of chunks) all += Buffer.from(chunk).toString()
  return all
}

test('run answers the stdout of a file that exits 0', async () => {
  const file = script('ok', 'echo "hello $1"')
  assert.equal(await nodeInputs().run(file, ['dial'], bounds()), 'hello dial\n')
})

test('a file that is not there is missing, and so is a bare name the PATH it is given does not hold', async () => {
  mkdirSync(`${dir}/empty`)
  assert.equal(await nodeInputs().run(`${dir}/none`, [], bounds()), MISSING)
  // `sh` is on the process's own PATH, so only the given one can make it missing.
  assert.equal(await nodeInputs().run('sh', [], bounds({ path: `${dir}/empty` })), MISSING)
})

test("a bare name is found through the PATH it is given, not the process's own", async () => {
  mkdirSync(`${dir}/bin`)
  script('bin/hdo-tool', 'echo "found $PATH"')
  assert.equal(await nodeInputs().run('hdo-tool', [], bounds({ path: `${dir}/bin` })), `found ${dir}/bin\n`)
})

test('a non-zero exit, output over maxBytes and a run past its timeout are null, and the run past its timeout is killed', async () => {
  assert.equal(await nodeInputs().run(script('fails', 'exit 3'), [], bounds()), null)
  assert.equal(await nodeInputs().run(script('loud', "printf '%0100d' 0"), [], bounds({ maxBytes: 10 })), null)
  const pidFile = `${dir}/pid`
  // /bin/sh itself, not a script just written: macOS checks a new file before its first run, which can outlast 200 ms.
  const slow = ['-c', 'echo $$ > "$0"; exec /bin/sleep 60', pidFile]
  assert.equal(await nodeInputs().run('/bin/sh', slow, bounds({ timeoutMs: 200 })), null)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  // The run settles once the child has exited and been reaped, so it is gone by now.
  assert.throws(() => process.kill(pid, 0))
})

test('an abort ends a run: null', async () => {
  const abort = new AbortController()
  const run = nodeInputs().run(script('slow', 'exec /bin/sleep 60'), [], bounds({ signal: abort.signal }))
  abort.abort()
  assert.equal(await run, null)
})

test('connect posts the body to / and hands on the status and the chunks', async () => {
  let got: unknown = null
  const socketPath = await serve((req, res, body) => {
    got = { method: req.method, url: req.url, body }
    res.writeHead(200)
    res.write('{"attached":false}\n')
    res.end('{"attached":true,"agent":null}\n')
  })
  const answer = await nodeInputs().connect({ socket: socketPath }, BODY, new AbortController().signal)
  assert.ok(answer)
  assert.equal(answer.status, 200)
  assert.equal(await text(answer.chunks), '{"attached":false}\n{"attached":true,"agent":null}\n')
  assert.deepEqual(got, { method: 'POST', url: '/', body: BODY })
})

test('a socket that is not there, and one nothing listens on, are null', async () => {
  const signal = new AbortController().signal
  assert.equal(await nodeInputs().connect({ socket: `${dir}/none.sock` }, BODY, signal), null)
  // A socket file whose listener is gone, as a crashed process leaves it: closing the server would remove its own name.
  const socketPath = await serve(() => {})
  renameSync(socketPath, `${dir}/stale.sock`)
  const server = servers.pop()!
  await new Promise((done) => server.close(done))
  assert.equal(await nodeInputs().connect({ socket: `${dir}/stale.sock` }, BODY, signal), null)
})

test('an abort before the answer is null', async () => {
  const abort = new AbortController()
  const socketPath = await serve(() => abort.abort())
  assert.equal(await nodeInputs().connect({ socket: socketPath }, BODY, abort.signal), null)
})

test('an abort after it ends the chunks', async () => {
  const abort = new AbortController()
  const socketPath = await serve((_req, res) => {
    res.writeHead(200)
    res.write('{"attached":false}\n')
  })
  const answer = await nodeInputs().connect({ socket: socketPath }, BODY, abort.signal)
  assert.ok(answer)
  let all = ''
  for await (const chunk of answer.chunks) {
    all += Buffer.from(chunk).toString()
    abort.abort()
  }
  assert.equal(all, '{"attached":false}\n')
})

test('post posts the body to / on a connection of its own and answers the status', async () => {
  const got: unknown[] = []
  const socketPath = await serve((req, res, body) => {
    got.push({ method: req.method, url: req.url, body, connection: req.headers.connection })
    if (got.length === 1) res.writeHead(204).end()
    else res.writeHead(400).end('{"error":"bad"}\n')
  })
  const signal = new AbortController().signal
  assert.equal(await nodeInputs().post({ socket: socketPath }, FRONT, signal), 204)
  assert.equal(await nodeInputs().post({ socket: socketPath }, FRONT, signal), 400)
  const seen = { method: 'POST', url: '/', body: FRONT, connection: 'close' }
  assert.deepEqual(got, [seen, seen])
})

test('post to a socket that is not there, and to one nothing listens on, is null', async () => {
  const signal = new AbortController().signal
  assert.equal(await nodeInputs().post({ socket: `${dir}/none.sock` }, FRONT, signal), null)
  const socketPath = await serve(() => {})
  renameSync(socketPath, `${dir}/stale.sock`)
  const server = servers.pop()!
  await new Promise((done) => server.close(done))
  assert.equal(await nodeInputs().post({ socket: `${dir}/stale.sock` }, FRONT, signal), null)
})

test('an abort before the answer makes post null', async () => {
  const abort = new AbortController()
  const socketPath = await serve(() => abort.abort())
  assert.equal(await nodeInputs().post({ socket: socketPath }, FRONT, abort.signal), null)
})

test('over a pipe, connect proves the token, and hands on the status and the chunks of an answer that proves it back', async () => {
  let got = ''
  const pipe = await servePipe((res, proof, body) => {
    got = body
    res.writeHead(200, { 'x-harness-proof': proof })
    res.end('{"attached":false}\n')
  })
  const answer = await nodeInputs().connect({ pipe, token: TOKEN }, BODY, new AbortController().signal)
  assert.ok(answer)
  assert.equal(answer.status, 200)
  assert.equal(await text(answer.chunks), '{"attached":false}\n')
  assert.equal(got, BODY)
})

test('over a pipe, post proves the token, and answers the status of an answer that proves it back', async () => {
  let got = ''
  const pipe = await servePipe((res, proof, body) => {
    got = body
    res.writeHead(204, { 'x-harness-proof': proof }).end()
  })
  assert.equal(await nodeInputs().post({ pipe, token: TOKEN }, FRONT, new AbortController().signal), 204)
  assert.equal(got, FRONT)
})

test('an answer over a pipe with no proof, or a wrong one, is null and closed unread; so is the answer to another token', async () => {
  const wrongs = [() => undefined, (proof: string) => `${proof[0] === '0' ? '1' : '0'}${proof.slice(1)}`]
  for (const wrong of wrongs) {
    const closed: Promise<void>[] = []
    const pipe = await servePipe((res, proof) => {
      closed.push(new Promise((done) => res.on('close', done)))
      const given = wrong(proof)
      res.writeHead(200, given === undefined ? {} : { 'x-harness-proof': given })
      // Left open, as a stream is: only the plugin can close it.
      res.write('{"attached":false}\n')
    })
    const signal = new AbortController().signal
    assert.equal(await nodeInputs().connect({ pipe, token: TOKEN }, BODY, signal), null)
    assert.equal(await nodeInputs().post({ pipe, token: TOKEN }, FRONT, signal), null)
    await Promise.all(closed)
    assert.equal(closed.length, 2)
  }
  let handled = 0
  const pipe = await servePipe(() => (handled += 1))
  const signal = new AbortController().signal
  assert.equal(await nodeInputs().connect({ pipe, token: 'cd'.repeat(32) }, BODY, signal), null)
  assert.equal(await nodeInputs().post({ pipe, token: 'cd'.repeat(32) }, FRONT, signal), null)
  assert.equal(handled, 0)
})

test('watch tells the name of an entry made in its folder; after its close it tells nothing', async () => {
  const told: (string | null)[] = []
  let seen: (name: string | null) => unknown = () => {}
  const close = nodeInputs().watch(
    dir,
    (name) => {
      told.push(name)
      seen(name)
    },
    () => assert.fail('failed')
  )
  await writeUntilTold(`${dir}/devices.sock`, new Promise<void>((done) => (seen = (name) => name === 'devices.sock' && done())))
  close()
  // A second watcher on the same folder says when the next entry was seen, so no wait is guessed.
  const before = told.length
  let closeOther = () => {}
  await writeUntilTold(
    `${dir}/registry.json`,
    new Promise<void>((done) => (closeOther = nodeInputs().watch(dir, (name) => name === 'registry.json' && done(), () => {})))
  )
  closeOther()
  assert.equal(told.length, before)
})

test('a folder that is not there is watched by nothing, throws nothing, and says it failed', () => {
  let failed = 0
  const close = nodeInputs().watch(`${dir}/none`, () => assert.fail('told'), () => (failed += 1))
  close()
  assert.equal(failed, 1)
})

test('after runs its function and its cancel stops it; now rises', async () => {
  const inputs = nodeInputs()
  const start = inputs.now()
  const ran: string[] = []
  inputs.after(0, () => ran.push('cancelled'))()
  await new Promise<void>((done) => inputs.after(0, () => done()))
  assert.deepEqual(ran, [])
  assert.ok(inputs.now() >= start)
})

test('nodeInputs reads the platform, the home and PATH as they are when it is called', () => {
  const { HOME, PATH } = process.env
  try {
    process.env.HOME = dir
    process.env.PATH = `${dir}/bin`
    const inputs = nodeInputs()
    assert.deepEqual([inputs.platform, inputs.home, inputs.path], [process.platform, dir, `${dir}/bin`])
  } finally {
    // Assigning undefined to process.env stores the word "undefined".
    if (HOME === undefined) delete process.env.HOME
    else process.env.HOME = HOME
    if (PATH === undefined) delete process.env.PATH
    else process.env.PATH = PATH
  }
})
