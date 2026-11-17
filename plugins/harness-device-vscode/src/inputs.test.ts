// Node's real inputs, against scripts, sockets and folders in the test's own temporary folder: never the developer's own.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MISSING, nodeInputs } from './inputs'

const OPEN = '{"type":"vscode","window":"a1b2c3d4"}'
const STATE = '{"type":"vscode-state","window":"a1b2c3d4","terminals":[101],"active":101,"focused":true}'
let dir = ''
let servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hdv-'))
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
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

function bounds(extra: { path?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  return { path: '/usr/bin:/bin', timeoutMs: 5_000, maxBytes: 4_096, signal: new AbortController().signal, ...extra }
}

async function serve(handle: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ socketPath: string; server: Server }> {
  const socketPath = `${dir}/d${servers.length}.sock`
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handle(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(socketPath, done))
  return { socketPath, server }
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

describe('nodeInputs', () => {
  it('run answers the stdout of a file that exits 0', async () => {
    const file = script('ok', 'echo "hello $1"')
    expect(await nodeInputs().run(file, ['link'], bounds())).toBe('hello link\n')
  })

  it('a file that is not there is missing, and so is a bare name the PATH it is given does not hold', async () => {
    mkdirSync(`${dir}/empty`)
    expect(await nodeInputs().run(`${dir}/none`, [], bounds())).toBe(MISSING)
    // `sh` is on the process's own PATH, so only the given one can make it missing.
    expect(await nodeInputs().run('sh', [], bounds({ path: `${dir}/empty` }))).toBe(MISSING)
  })

  it("a bare name is found through the PATH it is given, not the process's own", async () => {
    mkdirSync(`${dir}/bin`)
    script('bin/hdv-tool', 'echo "found $PATH"')
    expect(await nodeInputs().run('hdv-tool', [], bounds({ path: `${dir}/bin` }))).toBe(`found ${dir}/bin\n`)
  })

  it('a non-zero exit, output over maxBytes and a run past its timeout are null, and the run past its timeout is killed', async () => {
    expect(await nodeInputs().run(script('fails', 'exit 3'), [], bounds())).toBeNull()
    expect(await nodeInputs().run(script('loud', "printf '%0100d' 0"), [], bounds({ maxBytes: 10 }))).toBeNull()
    const pidFile = `${dir}/pid`
    // /bin/sh itself, not a script just written: macOS checks a new file before its first run, which can outlast 200 ms.
    const slow = ['-c', 'echo $$ > "$0"; exec /bin/sleep 60', pidFile]
    expect(await nodeInputs().run('/bin/sh', slow, bounds({ timeoutMs: 200 }))).toBeNull()
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // The run settles once the child has exited and been reaped, so it is gone by now.
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('an abort ends a run: null', async () => {
    const abort = new AbortController()
    const run = nodeInputs().run(script('slow', 'exec /bin/sleep 60'), [], bounds({ signal: abort.signal }))
    abort.abort()
    expect(await run).toBeNull()
  })

  it('connect posts the body to / and hands on the status and the chunks of the answer it holds', async () => {
    let got: unknown = null
    const { socketPath } = await serve((req, res, body) => {
      got = { method: req.method, url: req.url, body }
      res.writeHead(200)
      res.write('{"show":101}\n')
      res.end('{"show":202}\n')
    })
    const answer = await nodeInputs().connect(socketPath, OPEN, new AbortController().signal)
    expect(answer?.status).toBe(200)
    expect(await text(answer!.chunks)).toBe('{"show":101}\n{"show":202}\n')
    expect(got).toEqual({ method: 'POST', url: '/', body: OPEN })
  })

  it('a socket that is not there, and one nothing listens on, are null to connect and to post', async () => {
    const signal = new AbortController().signal
    // A socket file whose listener is gone, as a crashed process leaves it: closing the server would remove its own name.
    const { socketPath, server } = await serve(() => {})
    renameSync(socketPath, `${dir}/stale.sock`)
    servers.pop()
    await new Promise((done) => server.close(done))
    for (const path of [`${dir}/none.sock`, `${dir}/stale.sock`]) {
      expect(await nodeInputs().connect(path, OPEN, signal)).toBeNull()
      expect(await nodeInputs().post(path, STATE, signal)).toBeNull()
    }
  })

  it('an abort before the head is null; one after it ends the chunks', async () => {
    const early = new AbortController()
    const { socketPath: silent } = await serve(() => early.abort())
    expect(await nodeInputs().connect(silent, OPEN, early.signal)).toBeNull()

    const late = new AbortController()
    const { socketPath: held } = await serve((_req, res) => {
      res.writeHead(200)
      res.write('{"show":101}\n')
    })
    const answer = await nodeInputs().connect(held, OPEN, late.signal)
    let all = ''
    for await (const chunk of answer!.chunks) {
      all += Buffer.from(chunk).toString()
      late.abort()
    }
    expect(all).toBe('{"show":101}\n')
  })

  it('post sends the body with Connection: close on a connection of its own, answers the status, and the connection closes after', async () => {
    let connections = 0
    const got: unknown[] = []
    const closed: Promise<void>[] = []
    const { socketPath, server } = await serve((req, res, body) => {
      got.push({ method: req.method, url: req.url, connection: req.headers.connection, body })
      closed.push(new Promise((done) => req.socket.once('close', () => done())))
      res.writeHead(got.length === 1 ? 204 : 400).end(got.length === 1 ? undefined : 'refused')
    })
    server.on('connection', () => (connections += 1))
    // A connection kept alive would stay open: its close below would never come.
    server.keepAliveTimeout = 0
    const signal = new AbortController().signal
    expect(await nodeInputs().post(socketPath, STATE, signal)).toBe(204)
    expect(await nodeInputs().post(socketPath, STATE, signal)).toBe(400)
    await Promise.all(closed)
    expect(connections).toBe(2)
    expect(got).toEqual([
      { method: 'POST', url: '/', connection: 'close', body: STATE },
      { method: 'POST', url: '/', connection: 'close', body: STATE },
    ])
  })

  it('an abort before its answer makes a post null', async () => {
    const abort = new AbortController()
    const { socketPath } = await serve(() => abort.abort())
    expect(await nodeInputs().post(socketPath, STATE, abort.signal)).toBeNull()
  })

  it('watch tells the name of an entry made in its folder; after its close it tells nothing', async () => {
    const told: (string | null)[] = []
    let failed = 0
    let seen: (name: string | null) => unknown = () => {}
    const close = nodeInputs().watch(
      dir,
      (name) => {
        told.push(name)
        seen(name)
      },
      () => (failed += 1)
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
    expect([told.length, failed]).toEqual([before, 0])
  })

  it('a folder that is not there is watched by nothing, throws nothing, and says it failed', () => {
    const told: (string | null)[] = []
    let failed = 0
    const close = nodeInputs().watch(`${dir}/none`, (name) => told.push(name), () => (failed += 1))
    close()
    expect([told, failed]).toEqual([[], 1])
  })

  it('after runs its function and its cancel stops it; now rises', async () => {
    const inputs = nodeInputs()
    const start = inputs.now()
    const ran: string[] = []
    inputs.after(0, () => ran.push('cancelled'))()
    await new Promise<void>((done) => inputs.after(0, () => done()))
    expect(ran).toEqual([])
    expect(inputs.now()).toBeGreaterThanOrEqual(start)
  })

  it('the window id is made once per activation, in the form the listener takes', () => {
    const first = nodeInputs()
    expect(first.windowId).toMatch(/^[A-Za-z0-9-]{8,36}$/)
    expect([first.windowId === first.windowId, nodeInputs().windowId === first.windowId]).toEqual([true, false])
  })

  it('nodeInputs reads the platform, the home and PATH as they are when it is called', () => {
    const { HOME, PATH } = process.env
    try {
      process.env.HOME = dir
      process.env.PATH = `${dir}/bin`
      const inputs = nodeInputs()
      expect([inputs.platform, inputs.home, inputs.path]).toEqual([process.platform, dir, `${dir}/bin`])
    } finally {
      // Assigning undefined to process.env stores the word "undefined".
      if (HOME === undefined) delete process.env.HOME
      else process.env.HOME = HOME
      if (PATH === undefined) delete process.env.PATH
      else process.env.PATH = PATH
    }
  })
})
