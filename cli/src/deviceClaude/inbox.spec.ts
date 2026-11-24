/**
 * `harness device claude inbox <session id>` (inbox.ts), the follower Claude Code's mod runs on Windows: it holds the
 * session's poll on the daemon's `/api/hook/inbox` over the daemon's pipe and prints one JSON line for each answer. The
 * pipe is stood in by a Unix socket named harness-<32 hex> (as pipeAuth.spec.ts does), served with the daemon's token
 * as the daemon serves it (lib/localSocket.ts), so a request reaches the handler only with a valid auth. The follower's
 * waits and writes are recorded, never slept or printed. Its caller is watched through a process table and pids that
 * stand in for Claude Code's (`claude.exe` → `harness.exe` → this `node.exe`).
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/** A poll the daemon holds and never answers, as one with a dial holds it until the person speaks. */
const held = (): Promise<Answer> => new Promise(() => {})

/** A poll the daemon holds until [answer] is called. */
function holding(): { poll: Promise<Answer>; answer(answer: Answer): void } {
  let answer!: (answer: Answer) => void
  const poll = new Promise<Answer>((resolve) => { answer = resolve })
  return { poll, answer }
}

/**
 * The daemon's handler: each poll gets the next of [answers], once it settles, then 404, as a daemon older than the
 * inbox answers.
 */
function inboxHandler(answers: Array<Answer | Promise<Answer>>, seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', async () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body })
      const answer = await (answers.shift() ?? { status: 404, body: { error: 'NOT_FOUND' } })
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
async function windowsDaemon(answers: Array<Answer | Promise<Answer>>, serve: 'daemon' | 'no proof' | 'another token' = 'daemon') {
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

/** This follower's pid, its parent's (`harness.exe`) and Claude Code's, which started `harness.exe`. */
const NODE = 100
const HARNESS = 200
const CLAUDE = 300
type Row = { pid: number; parentPid: number; executable: string; startMarker: string }
/** The process table as `harness-pty ps --json` reads it on Windows, with Claude Code's start marker [claude]. */
const table = (claude = 'w:3'): Row[] => [
  { pid: 1, parentPid: 0, executable: 'explorer.exe', startMarker: 'w:1' },
  { pid: CLAUDE, parentPid: 1, executable: 'claude.exe', startMarker: claude },
  { pid: HARNESS, parentPid: CLAUDE, executable: 'C:\\Users\\me\\.harness\\bin\\HARNESS.EXE', startMarker: 'w:4' },
  { pid: NODE, parentPid: HARNESS, executable: 'node.exe', startMarker: 'w:5' },
]

/** Pids that run until a test ends one, and a table read from [tables] in turn, the last one after. */
function processes(...tables: Array<() => Row[] | null>) {
  const running = new Set([1, CLAUDE, HARNESS, NODE])
  const counts = { rows: 0 }
  const liveness = {
    alive: (pid: number) => running.has(pid),
    rows: async () => tables[Math.min(counts.rows++, tables.length - 1)]!(),
  }
  return { running, counts, liveness }
}

/**
 * The follower started, with its lines and waits recorded; the write of line [stopAt] fails, as one to a closed stdout
 * does. Its clock moves a second at each read unless a test gives one: every poll was held, as a daemon with a dial
 * holds it.
 */
function start(dir: string, options: Partial<InboxDeps> & { id?: string; stopAt?: number } = {}) {
  const lines: string[] = []
  const waits: number[] = []
  const { id = SESSION, stopAt, ...deps } = options
  const ended = { done: false }
  const run = followInbox(id, {
    dataDir: dir, port: PORT, platform: 'win32', acts: () => true, proof: tableProof().proof, fetch: never,
    write: async (line) => {
      lines.push(line)
      return lines.length !== stopAt
    },
    wait: async (ms) => { waits.push(ms) },
    parentAlive: () => true,
    pid: NODE, ppid: HARNESS, liveness: processes(() => table()).liveness,
    now: stepping(1_000),
    ...deps,
  }).then((code) => {
    ended.done = true
    return { code, lines, waits }
  })
  return { run, ended, lines }
}

const follow = (dir: string, options: Parameters<typeof start>[1] = {}) => start(dir, options).run

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

  // Review Focus 6: `harness.exe` starts this `node.exe` with no job object, and Windows kills no child.
  it.each([['harness.exe', HARNESS], ['Claude Code', CLAUDE]])('ends with nothing written and no poll when %s is gone at the start', async (_name, pid) => {
    const { dir, count } = await windowsDaemon([{ status: 200, body: { text: 'hi' } }])
    const { running, liveness } = processes(() => table())
    running.delete(pid)
    expect(await follow(dir, { liveness })).toEqual({ code: 0, lines: [], waits: [] })
    expect(count.connections).toBe(0)
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

/**
 * Claude Code ends while the follower runs (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 15): Windows kills no
 * child, and `harness.exe` waits on this `node.exe`, so only the watch of its caller ends it. The watch's ticks run on
 * fake intervals; the daemon's pipe runs on real time, so what crosses it is waited for, never slept on.
 */
describe('the inbox follower on Windows, once its caller is gone', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }) })
  afterEach(() => { vi.useRealTimers() })

  it.each([['Claude Code', CLAUDE], ['harness.exe', HARNESS]])('ends within 2 s once %s is gone in the middle of a held poll, with no line', async (_name, pid) => {
    const { dir, seen } = await windowsDaemon([held()])
    const { running, liveness } = processes(() => table())
    const follower = start(dir, { liveness, stopAt: 1 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    running.delete(pid)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(follower.ended.done).toBe(true))
    expect(await follower.run).toEqual({ code: 0, lines: [], waits: [] })
  })

  it('ends within 2 s once Claude Code is gone in the middle of the minute\'s wait, with no line', async () => {
    const { dir, seen } = await windowsDaemon([{ status: 503, body: { error: 'NO_DEVICE' } }])
    const { running, liveness } = processes(() => table())
    const waits: number[] = []
    // A wait only the end of its caller cuts short.
    const wait = (ms: number, signal?: AbortSignal) => {
      waits.push(ms)
      return new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve()) })
    }
    const follower = start(dir, { liveness, wait, stopAt: 1 })
    await vi.waitFor(() => expect(waits).toEqual([60_000]))
    running.delete(CLAUDE)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(follower.ended.done).toBe(true))
    expect(follower.lines).toEqual([])
    expect(seen).toHaveLength(1)
  })

  // A pid Windows gave to another process passes `alive`; the table's start marker tells it apart.
  it.each([
    ['taken by another process', () => table('w:9')],
    ['missing from the table', () => table().filter((row) => row.pid !== CLAUDE)],
  ])('ends at the minute\'s proof once Claude Code\'s pid is %s', async (_name, reread) => {
    const { dir, seen } = await windowsDaemon([held()])
    const { counts, liveness } = processes(() => table(), reread)
    const follower = start(dir, { liveness, stopAt: 1 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(59_000)
    expect(counts.rows).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(follower.ended.done).toBe(true))
    expect(await follower.run).toEqual({ code: 0, lines: [], waits: [] })
    expect(counts.rows).toBe(2)
  })

  it('polls on and prints each line while Claude Code runs', async () => {
    const first = holding()
    const { dir, seen } = await windowsDaemon([first.poll, { status: 200, body: {} }])
    const { counts, liveness } = processes(() => table())
    const follower = start(dir, { liveness })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(follower.ended.done).toBe(false)
    first.answer({ status: 200, body: { text: 'hi' } })
    expect(await follower.run).toEqual({ code: 0, lines: ['{"text":"hi"}', '{}', OFF], waits: [] })
    expect(counts.rows).toBe(4)
  })

  // Fail open: a live session's follower is never ended for want of a table.
  const unreadable = (): null => null
  const throws = (): never => { throw new Error('harness-pty ps failed') }
  it.each<[string, Array<() => Row[] | null>]>([
    ['unreadable at the start', [unreadable]],
    ['throwing at the start', [throws]],
    ['without this process at the start', [() => []]],
    ['unreadable at the minute\'s proof', [() => table(), unreadable]],
    ['throwing at the minute\'s proof', [() => table(), throws]],
  ])('with the table %s, polls on and prints each line', async (_name, tables) => {
    const first = holding()
    const { dir, seen } = await windowsDaemon([first.poll])
    const { liveness } = processes(...tables)
    const follower = start(dir, { liveness })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(180_000)
    expect(follower.ended.done).toBe(false)
    first.answer({ status: 200, body: { text: 'hi' } })
    expect(await follower.run).toEqual({ code: 0, lines: ['{"text":"hi"}', OFF], waits: [] })
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

  it('ends within 2 s once its parent is gone in the middle of a held poll, and reads no table', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    cleanup.push(() => vi.useRealTimers())
    const dir = dataDir()
    const seen: Seen[] = []
    const served = await listenLocalSocket(inboxHandler([held()], seen), unixSocketPath(dir, PORT, 'darwin')!)
    cleanup.push(served.close)
    const { running, counts, liveness } = processes(() => table())
    const follower = start(dir, { platform: 'darwin', liveness, stopAt: 1 })
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    running.delete(HARNESS)
    await vi.advanceTimersByTimeAsync(2_000)
    await vi.waitFor(() => expect(follower.ended.done).toBe(true))
    expect(await follower.run).toEqual({ code: 0, lines: [], waits: [] })
    expect(counts.rows).toBe(0)
  })
})
