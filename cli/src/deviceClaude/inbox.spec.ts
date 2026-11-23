/**
 * `harness device claude inbox <session id>` (inbox.ts), the follower Claude Code's mod runs on Windows: it holds the
 * session's poll on the daemon's `/api/hook/inbox` over the daemon's pipe and prints one JSON line for each answer. The
 * pipe is stood in by a Unix socket named harness-<32 hex> (as pipeAuth.spec.ts does), served with the daemon's token
 * as the daemon serves it (lib/localSocket.ts), so a request reaches the handler only with a valid auth. The follower's
 * waits and writes are recorded, never slept or printed.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { daemonRecordPath, writeDaemonRecord } from '../lib/daemonRecord.js'
import { listenLocalSocket, unixSocketPath } from '../lib/localSocket.js'
import { ensureDaemonToken } from '../lib/windows/pipeAuth.js'
import { createDaemonProof, followInbox, type InboxDeps } from './inbox.js'

const PORT = 4997
const SESSION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const OFF = '{"off":true}'

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A data folder the token checks take, short enough for the sockets that stand in for its pipe. */
function dataDir(): string {
  const dir = mkdtempSync('/tmp/hn-inbox-')
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const filetime = (ms: number) => `w:${(BigInt(Math.floor(ms)) + 11_644_473_600_000n) * 10_000n}`

type Answer = { status: number; body: unknown }
type Seen = { method: string; url: string; body: string }

/** The daemon's handler: each poll gets the next of [answers], then 404, as a daemon older than the inbox answers. */
function inboxHandler(answers: Answer[], seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body })
      const answer = answers.shift() ?? { status: 404, body: { error: 'NOT_FOUND' } }
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  }
}

/** Counts the connections [server] takes, and keeps a client that went from failing the test. */
function counted(server: Server): { connections: number } {
  const count = { connections: 0 }
  server.on('connection', (socket) => {
    count.connections++
    socket.on('error', () => {})
  })
  return count
}

/**
 * The daemon's pipe recorded in a data folder with its token, served by [serve]: the daemon, with this token; a server
 * that answers 200 `{"text":"x"}` with no proof; or the daemon's server with another token.
 */
async function windowsDaemon(answers: Answer[], serve: 'daemon' | 'no proof' | 'another token' = 'daemon') {
  const dir = dataDir()
  const pipe = join(dir, `harness-${randomBytes(16).toString('hex')}`)
  const token = ensureDaemonToken(dir)
  writeDaemonRecord(dir, PORT, PORT, { pipe, pid: process.pid })
  const seen: Seen[] = []
  let server: Server
  if (serve === 'no proof') {
    server = createServer(inboxHandler(Array.from({ length: 8 }, () => ({ status: 200, body: { text: 'x' } })), seen))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    await new Promise<void>((resolve) => { server.listen(pipe, resolve) })
  } else {
    const served = await listenLocalSocket(inboxHandler(answers, seen), pipe, { token: serve === 'daemon' ? token : randomBytes(32) })
    cleanup.push(served.close)
    server = served.server
  }
  return { dir, token, seen, count: counted(server) }
}

/** A proof whose process table holds the recorded pid, started an hour ago, and counts its reads. */
function tableProof(alive = true) {
  const counts = { rows: 0 }
  const proof = createDaemonProof({
    liveness: {
      alive: () => alive,
      rows: async () => {
        counts.rows++
        return [{ pid: process.pid, executable: 'harness.exe', startMarker: filetime(Date.now() - 3_600_000) }]
      },
    },
  })
  return { counts, proof }
}

/** Over the pipe, never the port: plain fetch is never the daemon's way on Windows. */
const never = (async () => { throw new Error('plain fetch was called') }) as unknown as typeof fetch

/** A clock [stepMs] later at each read. */
function stepping(stepMs: number): () => number {
  let at = 0
  return () => (at += stepMs)
}

/**
 * The follower with its lines and waits recorded; the write of line [stopAt] fails, as one to a closed stdout does. Its
 * clock moves a second at each read unless a test gives one: every poll was held, as a daemon with a dial holds it.
 */
async function follow(dir: string, options: Partial<InboxDeps> & { id?: string; stopAt?: number } = {}) {
  const lines: string[] = []
  const waits: number[] = []
  const { id = SESSION, stopAt, ...deps } = options
  const code = await followInbox(id, {
    dataDir: dir, port: PORT, platform: 'win32', acts: () => true, proof: tableProof().proof, fetch: never,
    write: async (line) => {
      lines.push(line)
      return lines.length !== stopAt
    },
    wait: async (ms) => { waits.push(ms) },
    parentAlive: () => true,
    now: stepping(1_000),
    ...deps,
  })
  return { code, lines, waits }
}

describe('the inbox follower on Windows', () => {
  it('prints what the person said, one line each, and polls again at once', async () => {
    const text = 'hi & 100% "x"\nnext'
    const { dir, seen } = await windowsDaemon([{ status: 200, body: { text } }, { status: 200, body: {} }])
    const { code, lines, waits } = await follow(dir)
    expect(code).toBe(0)
    // The text whole, as one line: its newline is escaped.
    expect(lines).toEqual(['{"text":"hi & 100% \\"x\\"\\nnext"}', '{}', OFF])
    expect(JSON.parse(lines[0]!)).toEqual({ text })
    expect(waits).toEqual([])
    const poll = { method: 'POST', url: '/api/hook/inbox', body: JSON.stringify({ sessionId: SESSION }) }
    expect(seen).toEqual([poll, poll, poll])
  })

  it('twenty polls read the process table once', async () => {
    const { dir, seen } = await windowsDaemon(Array.from({ length: 20 }, () => ({ status: 200, body: {} })))
    const { counts, proof } = tableProof()
    const { lines } = await follow(dir, { proof })
    expect(lines).toEqual([...Array<string>(20).fill('{}'), OFF])
    expect(seen).toHaveLength(21)
    expect(counts.rows).toBe(1)
  })

  // Review Focus 2: something else holds the recorded pipe's name.
  it.each(['no proof', 'another token'] as const)('an answer with %s is dropped unread, and the next poll proves again', async (serve) => {
    const { dir } = await windowsDaemon([{ status: 200, body: { text: 'x' } }, { status: 200, body: { text: 'x' } }], serve)
    const { counts, proof } = tableProof()
    expect(await follow(dir, { proof, stopAt: 2 })).toEqual({ code: 0, lines: ['{}', '{}'], waits: [60_000, 60_000] })
    expect(counts.rows).toBe(2)
  })

  it('with no daemon record, or its process gone, connects to nothing, waits a minute and prints {}', async () => {
    const noRecord = await windowsDaemon([{ status: 200, body: { text: 'x' } }])
    rmSync(daemonRecordPath(noRecord.dir, PORT))
    expect(await follow(noRecord.dir, { stopAt: 1 })).toEqual({ code: 0, lines: ['{}'], waits: [60_000] })
    expect(noRecord.count.connections).toBe(0)

    const gone = await windowsDaemon([{ status: 200, body: { text: 'x' } }])
    const { counts, proof } = tableProof(false)
    expect(await follow(gone.dir, { proof, stopAt: 1 })).toEqual({ code: 0, lines: ['{}'], waits: [60_000] })
    expect(gone.count.connections).toBe(0)
    expect(counts.rows).toBe(0)
  })

  // As the Mac mod does: a 200 with no text that was not held would have it poll again at once, and spin.
  it('a 200 with no text back under a second waits a minute before it prints {}', async () => {
    const { dir, seen } = await windowsDaemon([{ status: 200, body: {} }, { status: 200, body: { text: 5 } }])
    expect(await follow(dir, { now: stepping(999) })).toEqual({ code: 0, lines: ['{}', '{}', OFF], waits: [60_000, 60_000] })
    expect(seen).toHaveLength(3)
  })

  it('a text back under a second is printed with no wait, and the next poll goes at once', async () => {
    const { dir } = await windowsDaemon([{ status: 200, body: { text: 'hi' } }])
    expect(await follow(dir, { now: () => 0 })).toEqual({ code: 0, lines: ['{"text":"hi"}', OFF], waits: [] })
  })

  it('a 503 NO_DEVICE waits a minute, prints {} and polls again', async () => {
    const { dir, seen } = await windowsDaemon([{ status: 503, body: { error: 'NO_DEVICE' } }])
    expect(await follow(dir)).toEqual({ code: 0, lines: ['{}', OFF], waits: [60_000] })
    expect(seen).toHaveLength(2)
  })

  it('a 404, a daemon older than the inbox, prints off and polls no more', async () => {
    const { dir, seen } = await windowsDaemon([])
    expect(await follow(dir)).toEqual({ code: 0, lines: [OFF], waits: [] })
    expect(seen).toHaveLength(1)
  })

  it('the plugin off before a poll prints off and polls nothing', async () => {
    const { dir, count } = await windowsDaemon([{ status: 200, body: { text: 'hi' } }])
    expect(await follow(dir, { acts: () => false })).toEqual({ code: 0, lines: [OFF], waits: [] })
    expect(count.connections).toBe(0)
  })

  // As the Mac mod checks once the poll is back: nothing said at the dial reaches a session after `disable`.
  it('the plugin turned off while a poll is held prints off, and not the text', async () => {
    const { dir, seen } = await windowsDaemon([{ status: 200, body: { text: 'hi' } }])
    let asked = 0
    expect(await follow(dir, { acts: () => asked++ === 0 })).toEqual({ code: 0, lines: [OFF], waits: [] })
    expect(seen).toHaveLength(1)
  })

  it('an id in upper case, or not a UUID, prints off and connects to nothing', async () => {
    const { dir, count } = await windowsDaemon([])
    for (const id of [SESSION.toUpperCase(), 'not-a-session', '', `${SESSION}\n`, `../${SESSION}`]) {
      expect(await follow(dir, { id }), JSON.stringify(id)).toEqual({ code: 0, lines: [OFF], waits: [] })
    }
    expect(count.connections).toBe(0)
  })

  it('a text over 20,000 characters, an empty one, or one that is no string prints {}', async () => {
    const longest = 'a'.repeat(20_000)
    const { dir } = await windowsDaemon([
      { status: 200, body: { text: `${longest}a` } },
      { status: 200, body: { text: '' } },
      { status: 200, body: { text: 5 } },
      { status: 200, body: null },
      { status: 200, body: { text: longest } },
    ])
    expect(await follow(dir)).toEqual({ code: 0, lines: ['{}', '{}', '{}', '{}', JSON.stringify({ text: longest }), OFF], waits: [] })
  })

  // Review Focus 6: Claude Code killed `harness.exe`, and its `node.exe` runs on.
  it('ends with nothing more written and no poll once its parent is gone', async () => {
    const before = await windowsDaemon([{ status: 200, body: { text: 'hi' } }])
    expect(await follow(before.dir, { parentAlive: () => false })).toEqual({ code: 0, lines: [], waits: [] })
    expect(before.count.connections).toBe(0)

    const during = await windowsDaemon([{ status: 200, body: { text: 'hi' } }, { status: 200, body: {} }])
    let checks = 0
    expect(await follow(during.dir, { parentAlive: () => checks++ === 0 })).toEqual({ code: 0, lines: ['{"text":"hi"}'], waits: [] })
    expect(during.seen).toHaveLength(1)
  })

  it('ends at once when a write fails, with no further poll', async () => {
    const { dir, seen } = await windowsDaemon([{ status: 200, body: { text: 'hi' } }, { status: 200, body: {} }])
    expect(await follow(dir, { stopAt: 1 })).toEqual({ code: 0, lines: ['{"text":"hi"}'], waits: [] })
    expect(seen).toHaveLength(1)
  })

  it('prints nothing on stderr or the console, and no line holds a token', async () => {
    const stderr = vi.spyOn(process.stderr, 'write')
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name))
    const runs = [
      await windowsDaemon([{ status: 200, body: { text: 'hi' } }, { status: 503, body: { error: 'NO_DEVICE' } }]),
      await windowsDaemon([], 'no proof'),
      await windowsDaemon([], 'another token'),
    ]
    const lines: string[] = []
    for (const { dir } of runs) lines.push(...(await follow(dir, { stopAt: 3 })).lines)
    expect(lines).toEqual(['{"text":"hi"}', '{}', OFF, '{}', '{}', '{}', '{}', '{}', '{}'])
    for (const { token } of runs) expect(lines.join('\n')).not.toContain(token.toString('hex'))
    expect(stderr).not.toHaveBeenCalled()
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled()
  })
})

describe('the inbox follower on macOS', () => {
  it('prints what the person said, through the daemon\'s socket', async () => {
    const dir = dataDir()
    const seen: Seen[] = []
    const served = await listenLocalSocket(inboxHandler([{ status: 200, body: { text: 'hi' } }, { status: 200, body: {} }], seen), unixSocketPath(dir, PORT, 'darwin')!)
    cleanup.push(served.close)
    const { counts, proof } = tableProof()
    expect(await follow(dir, { platform: 'darwin', proof })).toEqual({ code: 0, lines: ['{"text":"hi"}', '{}', OFF], waits: [] })
    expect(seen).toHaveLength(3)
    expect(counts.rows).toBe(0)
  })
})
