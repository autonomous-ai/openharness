import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listenLocalSocket, type LocalSocketServer } from '../lib/localSocket.js'
import { LISTENER_MAX_CONNECTIONS } from '../services/devicesListener.js'
import { devicesListenerPath } from './listenerPath.js'
import { ASK_ANSWER_MAX, askDevices, streamDevices, tellDevices } from './listenerClient.js'

const FRONT = { type: 'front', app: 'ghostty' }
const dirs: string[] = []
const servers: LocalSocketServer[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) await server.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A short data folder of the test's own, so the socket is beside it and never under the developer's home.
function dataDir(): string {
  const dir = mkdtempSync('/tmp/hdc-')
  dirs.push(dir)
  return dir
}

interface Heard { method?: string; url?: string; body: string }
/** A real private socket where the devices listener would be, answering as [answer] says; it hears every request. */
async function listener(dir: string, answer: (res: ServerResponse) => void = res => { res.writeHead(204).end() }) {
  const heard: Heard[] = []
  const server = await listenLocalSocket((req: IncomingMessage, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      heard.push({ method: req.method, url: req.url, body })
      answer(res)
    })
  }, devicesListenerPath(dir)!)
  servers.push(server)
  return { heard, server }
}

describe.skipIf(process.platform === 'win32')('tellDevices, on a socket', () => {
  it("tells the data folder's devices socket: POST /, the message as JSON, true on 204", async () => {
    const dir = dataDir()
    const { heard } = await listener(dir)
    expect(await tellDevices(dir, FRONT)).toBe(true)
    expect(heard).toEqual([{ method: 'POST', url: '/', body: '{"type":"front","app":"ghostty"}' }])
  })

  it('true on 200 with an answer', async () => {
    const dir = dataDir()
    await listener(dir, res => { res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') })
    expect(await tellDevices(dir, FRONT)).toBe(true)
  })

  it('false when the listener answers 400, 404, 413, 429 or 500', async () => {
    const dir = dataDir()
    let status = 0
    const { heard } = await listener(dir, res => { res.writeHead(status).end() })
    for (status of [400, 404, 413, 429, 500]) expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toHaveLength(5)
  })

  it('an answer is never left unread: more tells than the listener takes connections are all heard', async () => {
    const dir = dataDir()
    // An answer larger than the stream buffers before it is read: a short one is taken whole unread, and its connection freed.
    const { heard, server } = await listener(dir, res => { res.writeHead(429).end('x'.repeat(1 << 20)) })
    // One connection held by each unread answer would refuse the tells past the cap. A connection let go is either
    // closed or, on Node 24, kept alive for the next tell: both leave room, so the count of open ones proves nothing.
    server.server.maxConnections = LISTENER_MAX_CONNECTIONS
    const tells = LISTENER_MAX_CONNECTIONS + 4
    for (let i = 0; i < tells; i++) expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toHaveLength(tells)
  })

  it('false with no socket there, and nothing is sent', async () => {
    const dir = dataDir()
    // A listener of another data folder hears nothing either.
    const { heard } = await listener(dataDir())
    expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toEqual([])
  })

  it('a socket of another account, or one looser than 0600, is told nothing', async () => {
    const dir = dataDir()
    const { heard, server } = await listener(dir)
    const uid = process.getuid!()
    const other = vi.spyOn(process, 'getuid').mockReturnValue(uid + 1)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    other.mockRestore()
    chmodSync(server.path, 0o666)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    chmodSync(server.path, 0o600)
    chmodSync(dir, 0o777)
    expect(await tellDevices(dir, FRONT)).toBe(false)
    expect(heard).toEqual([])
    // The same socket, private again, is told.
    chmodSync(dir, 0o700)
    expect(await tellDevices(dir, FRONT)).toBe(true)
    expect(heard).toHaveLength(1)
  })

  it('false when the listener does not answer in time', async () => {
    const dir = dataDir()
    const { heard } = await listener(dir, () => {})
    expect(await tellDevices(dir, FRONT, { timeoutMs: 50 })).toBe(false)
    expect(heard).toHaveLength(1)
  })
})

describe('tellDevices, anywhere', () => {
  it('false on Windows without a call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(await tellDevices('C:\\Users\\me\\.harness', FRONT, { platform: 'win32', fetch })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const rejects = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed') })
    expect(await tellDevices('/tmp/hdc-none', FRONT, { platform: 'linux', fetch: rejects })).toBe(false)
    const throws = vi.fn<typeof globalThis.fetch>(() => { throw new TypeError('fetch failed') })
    expect(await tellDevices('/tmp/hdc-none', FRONT, { platform: 'linux', fetch: throws })).toBe(false)
    expect(rejects).toHaveBeenCalledOnce()
    expect(throws).toHaveBeenCalledOnce()
  })
})

const TABS = { type: 'tabs' }
const LINE = '{"app":"terminal-app","tty":"/dev/ttys023"}\n'
const RAISE_LINE = '{"app":"iterm","tty":"/dev/ttys4","raise":true}\n'
const open = () => new AbortController().signal

/** A listener that answers each request with an NDJSON stream left open, for the test to write on and end. */
async function streamer(dir: string) {
  const answers: ServerResponse[] = []
  const { heard } = await listener(dir, res => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' }).flushHeaders()
    answers.push(res)
  })
  return { heard, answers }
}

describe.skipIf(process.platform === 'win32')('streamDevices, on a socket', () => {
  it('streamDevices posts the message and hands each chunk on until the listener ends the stream: true', async () => {
    const dir = dataDir()
    const { heard, answers } = await streamer(dir)
    // A listener ends a stream's body, or destroys its connection (services/devicesListener.ts): either is its end.
    const ends = [(res: ServerResponse) => res.end(), (res: ServerResponse) => res.destroy()]
    for (const [i, end] of ends.entries()) {
      const chunks: Buffer[] = []
      const done = streamDevices(dir, TABS, data => { chunks.push(data) }, { signal: open() })
      await vi.waitFor(() => expect(answers).toHaveLength(i + 1))
      const res = answers[i]!
      res.write(LINE)
      await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toBe(LINE))
      res.write(RAISE_LINE)
      await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toBe(`${LINE}${RAISE_LINE}`))
      expect(chunks.every(chunk => Buffer.isBuffer(chunk))).toBe(true)
      end(res)
      expect(await done).toBe(true)
    }
    expect(heard).toEqual([
      { method: 'POST', url: '/', body: '{"type":"tabs"}' },
      { method: 'POST', url: '/', body: '{"type":"tabs"}' },
    ])
  })

  it('false for no socket, a socket of another account, a 404, a 429 and no answer in 2 s', async () => {
    const chunk = vi.fn()
    // No socket there: a listener of another data folder hears nothing.
    const { heard: elsewhere } = await listener(dataDir())
    expect(await streamDevices(dataDir(), TABS, chunk, { signal: open() })).toBe(false)
    expect(elsewhere).toEqual([])
    const dir = dataDir()
    let status = 0, taken = () => {}
    const { heard } = await listener(dir, res => { if (status) res.writeHead(status).end('{"error":"Not now."}'); else taken() })
    const other = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    expect(await streamDevices(dir, TABS, chunk, { signal: open() })).toBe(false)
    other.mockRestore()
    expect(heard).toEqual([])
    for (status of [404, 429]) expect(await streamDevices(dir, TABS, chunk, { signal: open() })).toBe(false)
    expect(heard).toHaveLength(2)
    // A listener that takes the request and never answers. Not vi.waitFor, which moves fake timers on as it waits.
    status = 0
    const reached = new Promise<void>(resolve => { taken = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const done = streamDevices(dir, TABS, chunk, { signal: open() })
      await reached
      await vi.advanceTimersByTimeAsync(1_999)
      expect(await Promise.race([done, 'waiting'])).toBe('waiting')
      await vi.advanceTimersByTimeAsync(1)
      expect(await done).toBe(false)
    } finally { vi.useRealTimers() }
    expect(chunk).not.toHaveBeenCalled()
  })

  it('an abort ends it and lets its connection go', async () => {
    const dir = dataDir()
    const { answers } = await streamer(dir)
    const abort = new AbortController()
    const chunks: Buffer[] = []
    const done = streamDevices(dir, TABS, data => { chunks.push(data) }, { signal: abort.signal })
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    answers[0]!.write(LINE)
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    const gone = new Promise(resolve => answers[0]!.socket!.once('close', resolve))
    abort.abort()
    // It had opened.
    expect(await done).toBe(true)
    await gone
    // Aborted before an answer: none had opened.
    const quiet = dataDir()
    const { heard } = await listener(quiet, () => {})
    const before = new AbortController()
    const unanswered = streamDevices(quiet, TABS, vi.fn(), { signal: before.signal })
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    before.abort()
    expect(await unanswered).toBe(false)
  })
})

describe('streamDevices, anywhere', () => {
  it('false on Windows without a call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(await streamDevices('C:\\Users\\me\\.harness', TABS, vi.fn(), { signal: open(), platform: 'win32', fetch })).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const rejects = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed') })
    expect(await streamDevices('/tmp/hdc-none', TABS, vi.fn(), { signal: open(), platform: 'linux', fetch: rejects })).toBe(false)
    const throws = vi.fn<typeof globalThis.fetch>(() => { throw new TypeError('fetch failed') })
    expect(await streamDevices('/tmp/hdc-none', TABS, vi.fn(), { signal: open(), platform: 'linux', fetch: throws })).toBe(false)
    // A body that breaks part way, once its first chunk is read: the stream had opened, and that chunk was handed on.
    let pulls = 0
    const breaks = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      pull(body) { if (pulls++ === 0) body.enqueue(Buffer.from(LINE)); else body.error(new Error('reset')) },
    }), { status: 200 }))
    const chunk = vi.fn()
    expect(await streamDevices('/tmp/hdc-none', TABS, chunk, { signal: open(), platform: 'linux', fetch: breaks })).toBe(true)
    expect(chunk.mock.calls.map(([data]) => String(data))).toEqual([LINE])
    expect(rejects).toHaveBeenCalledOnce()
    expect(throws).toHaveBeenCalledOnce()
  })
})

const NOTICE = { type: 'notice', text: 'Turn on the VPN' }
const json = (body: string) => (res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }).end(body) }

describe.skipIf(process.platform === 'win32')('askDevices, on a socket', () => {
  it("the answer's object on a 200", async () => {
    const dir = dataDir()
    const { heard } = await listener(dir, json('{"result":"shown"}'))
    expect(await askDevices(dir, NOTICE)).toEqual({ result: 'shown' })
    expect(heard).toEqual([{ method: 'POST', url: '/', body: JSON.stringify(NOTICE) }])
  })

  it('null for a 204, 400, 404, 413, 429 and 500', async () => {
    const dir = dataDir()
    let status = 0
    const { heard } = await listener(dir, res => { res.writeHead(status).end(status === 204 ? undefined : '{"result":"shown"}') })
    for (status of [204, 400, 404, 413, 429, 500]) expect(await askDevices(dir, NOTICE)).toBeNull()
    expect(heard).toHaveLength(6)
  })

  it('null for a body that is not a JSON object, or is over 1024 bytes', async () => {
    const dir = dataDir()
    let body = ''
    await listener(dir, res => json(body)(res))
    const big = JSON.stringify({ result: 'x'.repeat(2048) })
    for (body of ['[]', '"x"', '{not json', 'null', big]) expect(await askDevices(dir, NOTICE)).toBeNull()
    // At the bound, an object is still read.
    body = JSON.stringify({ result: 'x'.repeat(ASK_ANSWER_MAX - '{"result":""}'.length) })
    expect(Buffer.byteLength(body)).toBe(ASK_ANSWER_MAX)
    expect(await askDevices(dir, NOTICE)).toEqual(JSON.parse(body))
  })

  it('null with no socket and with a socket of another account, and nothing is sent', async () => {
    const { heard: elsewhere } = await listener(dataDir(), json('{"result":"shown"}'))
    expect(await askDevices(dataDir(), NOTICE)).toBeNull()
    expect(elsewhere).toEqual([])
    const dir = dataDir()
    const { heard } = await listener(dir, json('{"result":"shown"}'))
    const other = vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
    expect(await askDevices(dir, NOTICE)).toBeNull()
    other.mockRestore()
    expect(heard).toEqual([])
  })

  it('null when the listener does not answer in time', async () => {
    const dir = dataDir()
    const { heard } = await listener(dir, () => {})
    expect(await askDevices(dir, NOTICE, { timeoutMs: 50 })).toBeNull()
    expect(heard).toHaveLength(1)
    // Headers in time, the body never ending: the bound covers the body too.
    const slow = dataDir()
    await listener(slow, res => { res.writeHead(200, { 'content-type': 'application/json' }).write('{"result":') })
    expect(await askDevices(slow, NOTICE, { timeoutMs: 50 })).toBeNull()
  })

  it('more asks than the listener takes connections are all answered', async () => {
    const dir = dataDir()
    // An answer larger than the stream buffers before it is read, so an unread one would hold its connection.
    const { heard, server } = await listener(dir, res => { res.writeHead(200).end('x'.repeat(1 << 20)) })
    server.server.maxConnections = LISTENER_MAX_CONNECTIONS
    const asks = LISTENER_MAX_CONNECTIONS + 4
    for (let i = 0; i < asks; i++) expect(await askDevices(dir, NOTICE)).toBeNull()
    expect(heard).toHaveLength(asks)
  })
})

describe('askDevices, anywhere', () => {
  it('null on Windows without a call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    expect(await askDevices('C:\\Users\\me\\.harness', NOTICE, { platform: 'win32', fetch })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const rejects = vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('fetch failed') })
    expect(await askDevices('/tmp/hdc-none', NOTICE, { platform: 'linux', fetch: rejects })).toBeNull()
    const breaks = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({
      pull(body) { body.error(new Error('reset')) },
    }), { status: 200 }))
    expect(await askDevices('/tmp/hdc-none', NOTICE, { platform: 'linux', fetch: breaks })).toBeNull()
  })
})
