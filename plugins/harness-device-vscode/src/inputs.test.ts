// Node's real inputs, against scripts, sockets, pipes and folders in the test's own temporary folder: never the
// developer's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MISSING, nodeInputs } from './inputs'
import { writeExecutable } from '../../../cli/src/testing/executableFixture'
import {
  checkPipeAuth, NonceWindow, PIPE_AUTH_HEADER, PIPE_PROOF_HEADER, pipeIdOf, pipeProofValue,
} from '../../../cli/src/lib/windows/pipeAuth'

// The real execFile, watched: every run below still starts its file.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return { ...real, execFile: vi.fn(real.execFile) }
})

const OPEN = '{"type":"vscode","window":"a1b2c3d4"}'
const STATE = '{"type":"vscode-state","window":"a1b2c3d4","terminals":[101],"active":101,"focused":true}'
// The devices' token, as link prints it.
const TOKEN = '5f'.repeat(32)
// A /bin/sh script, a Unix socket or HOME: Windows has none of them. The pipe's cases run there.
const unix = it.skipIf(process.platform === 'win32')
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
  writeExecutable(file, `#!/bin/sh\n${body}\n`)
  return file
}

function bounds(extra: { path?: string; cwd?: string; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}) {
  return { path: '/usr/bin:/bin', cwd: dir, timeoutMs: 5_000, maxBytes: 4_096, signal: new AbortController().signal, ...extra }
}

async function serve(
  handle: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  socketPath = `${dir}/d${servers.length}.sock`
): Promise<{ socketPath: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => handle(req, res, body))
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(socketPath, done))
  return { socketPath, server }
}

// A pipe's name on Windows; elsewhere a Unix socket whose name ends the same way, as the CLI's pipe tests stand one in.
function pipeName(): string {
  const id = randomBytes(16).toString('hex')
  return process.platform === 'win32' ? `\\\\.\\pipe\\harness-${id}` : `${dir}/harness-${id}`
}

/** The devices' pipe as the CLI serves it: each request's auth checked by the CLI's own half, 401 unproven when it is not
 *  valid; each answer proven with `proof`'s token, or not at all. `handle` gets only the requests whose auth is valid. */
async function servePipe(proof: Buffer | null, handle: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
  const token = Buffer.from(TOKEN, 'hex')
  const seen = new NonceWindow()
  const authed: boolean[] = []
  const pipe = pipeName()
  await serve((req, res, body) => {
    const auth = checkPipeAuth(token, req.headers[PIPE_AUTH_HEADER] as string | undefined, seen, pipeIdOf(pipe)!)
    authed.push(auth !== null)
    if (!auth) return void res.writeHead(401).end('{"error":"PIPE_AUTH_REQUIRED"}')
    if (proof) res.setHeader(PIPE_PROOF_HEADER, pipeProofValue(proof, auth.nonce))
    handle(req, res, body)
  }, pipe)
  return { pipe, authed }
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
  unix('run answers the stdout of a file that exits 0', async () => {
    const file = script('ok', 'echo "hello $1"')
    expect(await nodeInputs().run(file, ['link'], bounds())).toBe('hello link\n')
  })

  it('a file that is not there is missing, and so is a bare name the PATH it is given does not hold', async () => {
    mkdirSync(`${dir}/empty`)
    expect(await nodeInputs().run(`${dir}/none`, [], bounds())).toBe(MISSING)
    // `sh` is on the process's own PATH, so only the given one can make it missing.
    expect(await nodeInputs().run('sh', [], bounds({ path: `${dir}/empty` }))).toBe(MISSING)
  })

  unix("a bare name is found through the PATH it is given, not the process's own", async () => {
    mkdirSync(`${dir}/bin`)
    script('bin/hdv-tool', 'echo "found $PATH"')
    expect(await nodeInputs().run('hdv-tool', [], bounds({ path: `${dir}/bin` }))).toBe(`found ${dir}/bin\n`)
  })

  unix('run starts its file in the folder it is given', async () => {
    mkdirSync(`${dir}/home`)
    expect(await nodeInputs().run('/bin/pwd', [], bounds({ cwd: `${dir}/home` }))).toBe(`${realpathSync(`${dir}/home`)}\n`)
  })

  // Windows looks for a bare name in the working folder before PATH: the extension host's can be the folder VS Code
  // opened, whose own harness.exe must never run.
  it.runIf(process.platform === 'win32')("a bare name is never looked for in the process's own working folder", async () => {
    mkdirSync(join(dir, 'opened'))
    mkdirSync(join(dir, 'home'))
    copyFileSync(process.execPath, join(dir, 'opened', 'harness.exe'))
    const was = process.cwd()
    process.chdir(join(dir, 'opened'))
    try {
      expect(await nodeInputs().run('harness', ['-e', 'console.log(1)'], bounds({ path: join(dir, 'home'), cwd: join(dir, 'home') }))).toBe(MISSING)
    } finally {
      process.chdir(was)
    }
  })

  unix('a non-zero exit, output over maxBytes and a run past its timeout are null, and the run past its timeout is killed', async () => {
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

  unix('an abort ends a run: null', async () => {
    const abort = new AbortController()
    const run = nodeInputs().run(script('slow', 'exec /bin/sleep 60'), [], bounds({ signal: abort.signal }))
    abort.abort()
    expect(await run).toBeNull()
  })

  it('run starts its file hidden, so no console window flashes up on Windows', async () => {
    await nodeInputs().run(`${dir}/none`, [], bounds())
    expect(vi.mocked(execFile).mock.calls.at(-1)?.[2]).toMatchObject({ windowsHide: true })
  })

  unix('connect posts the body to / and hands on the status and the chunks of the answer it holds', async () => {
    let got: unknown = null
    const { socketPath } = await serve((req, res, body) => {
      got = { method: req.method, url: req.url, body }
      res.writeHead(200)
      res.write('{"show":101}\n')
      res.end('{"show":202}\n')
    })
    const answer = await nodeInputs().connect({ socket: socketPath }, OPEN, new AbortController().signal)
    expect(answer?.status).toBe(200)
    expect(await text(answer!.chunks)).toBe('{"show":101}\n{"show":202}\n')
    expect(got).toEqual({ method: 'POST', url: '/', body: OPEN })
  })

  unix('a socket that is not there, and one nothing listens on, are null to connect and to post', async () => {
    const signal = new AbortController().signal
    // A socket file whose listener is gone, as a crashed process leaves it: closing the server would remove its own name.
    const { socketPath, server } = await serve(() => {})
    renameSync(socketPath, `${dir}/stale.sock`)
    servers.pop()
    await new Promise((done) => server.close(done))
    for (const path of [`${dir}/none.sock`, `${dir}/stale.sock`]) {
      expect(await nodeInputs().connect({ socket: path }, OPEN, signal)).toBeNull()
      expect(await nodeInputs().post({ socket: path }, STATE, signal)).toBeNull()
    }
  })

  unix('an abort before the head is null; one after it ends the chunks', async () => {
    const early = new AbortController()
    const { socketPath: silent } = await serve(() => early.abort())
    expect(await nodeInputs().connect({ socket: silent }, OPEN, early.signal)).toBeNull()

    const late = new AbortController()
    const { socketPath: held } = await serve((_req, res) => {
      res.writeHead(200)
      res.write('{"show":101}\n')
    })
    const answer = await nodeInputs().connect({ socket: held }, OPEN, late.signal)
    let all = ''
    for await (const chunk of answer!.chunks) {
      all += Buffer.from(chunk).toString()
      late.abort()
    }
    expect(all).toBe('{"show":101}\n')
  })

  unix('post sends the body with Connection: close on a connection of its own, answers the status, and the connection closes after', async () => {
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
    expect(await nodeInputs().post({ socket: socketPath }, STATE, signal)).toBe(204)
    expect(await nodeInputs().post({ socket: socketPath }, STATE, signal)).toBe(400)
    await Promise.all(closed)
    expect(connections).toBe(2)
    expect(got).toEqual([
      { method: 'POST', url: '/', connection: 'close', body: STATE },
      { method: 'POST', url: '/', connection: 'close', body: STATE },
    ])
  })

  unix('an abort before its answer makes a post null', async () => {
    const abort = new AbortController()
    const { socketPath } = await serve(() => abort.abort())
    expect(await nodeInputs().post({ socket: socketPath }, STATE, abort.signal)).toBeNull()
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

  unix('nodeInputs reads the platform, the home and PATH as they are when it is called', () => {
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

describe('nodeInputs over a pipe', () => {
  it('connect signs the request, and hands on the status and the chunks of an answer that proves the token', async () => {
    let got = ''
    const { pipe, authed } = await servePipe(Buffer.from(TOKEN, 'hex'), (_req, res, body) => {
      got = body
      res.writeHead(200)
      res.write('{"show":101}\n')
      res.end('{"show":202}\n')
    })
    const answer = await nodeInputs().connect({ pipe, token: TOKEN }, OPEN, new AbortController().signal)
    expect(answer?.status).toBe(200)
    expect(await text(answer!.chunks)).toBe('{"show":101}\n{"show":202}\n')
    expect([authed, got]).toEqual([[true], OPEN])
  })

  it('post signs each request with a nonce of its own, and answers the status of an answer that proves the token', async () => {
    const { pipe, authed } = await servePipe(Buffer.from(TOKEN, 'hex'), (_req, res) => res.writeHead(204).end())
    const signal = new AbortController().signal
    // The CLI's half takes a nonce once: a second post with the first one's would get 401, unproven.
    expect(await nodeInputs().post({ pipe, token: TOKEN }, STATE, signal)).toBe(204)
    expect(await nodeInputs().post({ pipe, token: TOKEN }, STATE, signal)).toBe(204)
    expect(authed).toEqual([true, true])
  })

  it("an answer with no proof, or another token's, is null to connect and to post, and its connection is closed", async () => {
    for (const proof of [null, Buffer.alloc(32)]) {
      const closed: Promise<void>[] = []
      // The answer's head and a line, then held open: only the client's close ends it.
      const { pipe, authed } = await servePipe(proof, (req, res) => {
        closed.push(new Promise((done) => req.socket.once('close', () => done())))
        res.writeHead(200)
        res.write('{"show":101}\n')
      })
      expect(await nodeInputs().connect({ pipe, token: TOKEN }, OPEN, new AbortController().signal)).toBeNull()
      expect(await nodeInputs().post({ pipe, token: TOKEN }, STATE, new AbortController().signal)).toBeNull()
      await Promise.all(closed)
      expect([closed.length, authed]).toEqual([2, [true, true]])
    }
  })
})
