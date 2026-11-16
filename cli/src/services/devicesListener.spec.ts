import { Agent, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_IDS } from '../cable/hosts/hostDetect.js'
import { FRONT_NONE } from '../cable/hosts/frontApp.js'
import { TAB_APPS, type Tab } from '../cable/hosts/tabs.js'
import { listenLocalSocket } from '../lib/localSocket.js'
import {
  ATTACH_MAX_BYTES, ATTACH_PER_SECOND, attachHandler, DIAL_MAX_BYTES, DIAL_NAME_MAX, DIAL_PER_SECOND, dialStream, FRONT_MAX_BYTES, FRONT_PER_SECOND,
  frontHandler, LISTENER_DROPPED_PER_SECOND, LISTENER_MAX_CONNECTIONS, openDevicesListener, REFUSED, TAB_MAX_BYTES, TAB_PER_SECOND, tabHandler,
  TABS_MAX_BYTES, TABS_PER_SECOND, tabsStream, type DevicesListener, type ListenerHandler, type ListenerStream, type ListenerStreamHandler, type StreamEnd,
} from './devicesListener.js'

const dirs: string[] = []
const listeners: DevicesListener[] = []
const agents: Agent[] = []
const raws: Socket[] = []

// A socket's path has 96 bytes (lib/localSocket.ts): the test's longer temporary folder would send it to the short
// folder under the home.
function shortDir(): string {
  const dir = mkdtempSync('/tmp/hdl-')
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const agent of agents.splice(0)) agent.destroy()
  for (const socket of raws.splice(0)) socket.destroy()
  for (const listener of listeners.splice(0)) await listener.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A listener on a socket of the test's own, and every line it logged. */
async function open(handlers: Record<string, ListenerHandler | ListenerStreamHandler>, options: { path?: string; now?: () => number } = {}) {
  const path = options.path ?? join(shortDir(), 'devices.sock')
  const lines: string[] = []
  const listener = await openDevicesListener({ path, handlers, log: (line) => lines.push(line), now: options.now })
  if (listener) listeners.push(listener)
  return { path, lines, listener }
}

interface Answer { status: number; body: string; reused: boolean }

/** One sender's connection: its messages go one after another on one socket, kept alive. */
function connection(path: string) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  agents.push(agent)
  const send = (body: string, method = 'POST', url = '/'): Promise<Answer> => new Promise((resolve, reject) => {
    const sent = request({ socketPath: path, agent, method, path: url }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, reused: sent.reusedSocket }))
    })
    sent.on('error', reject)
    sent.end(body)
  })
  return { send, front: (app: string) => send(JSON.stringify({ type: 'front', app })) }
}

/** One message on a connection of its own, closed after its answer: a sender that opens one per message. */
function once(path: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: path, agent: false, method: 'POST', path: '/', headers: { Connection: 'close' } }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    sent.on('error', reject)
    sent.end(body)
  })
}

const frontBody = (app: string): string => JSON.stringify({ type: 'front', app })

/** A front of ghostty padded to exactly `bytes`. */
function frontOf(bytes: number): string {
  const unpadded = Buffer.byteLength(JSON.stringify({ type: 'front', app: 'ghostty', pad: '' }))
  const body = JSON.stringify({ type: 'front', app: 'ghostty', pad: 'x'.repeat(bytes - unpadded) })
  expect(Buffer.byteLength(body)).toBe(bytes)
  return body
}

const post = (body: string, length = Buffer.byteLength(body)): string =>
  `POST / HTTP/1.1\r\nHost: devices\r\nContent-Length: ${length}\r\n\r\n${body}`

/** A bare connection that writes `text`, and everything it read until the listener closed it. */
function bare(path: string, text: string): { socket: Socket; read: Promise<string> } {
  const socket = connect(path, () => socket.write(text))
  raws.push(socket)
  let got = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => { got += chunk })
  // A connection the listener drops may be reset rather than ended.
  socket.on('error', () => {})
  return { socket, read: new Promise((resolve) => socket.once('close', () => resolve(got))) }
}

/** A handler whose answer waits: `entered` once it runs, its `gone`, and how to answer it. */
function held(maxBytes = 64) {
  let entered!: () => void
  const called = new Promise<void>((resolve) => { entered = resolve })
  const state: { gone?: AbortSignal; answer?: (value: unknown) => void } = {}
  const handler: ListenerHandler = {
    maxBytes, perSecond: 10,
    handle: (_message, gone) => new Promise((resolve) => {
      state.gone = gone
      state.answer = resolve
      // A held poll lets go when its sender goes.
      gone.addEventListener('abort', () => resolve(undefined))
      entered()
    }),
  }
  return { handler, called, state }
}

const MINUTE = 60_000

const LIVE = '{"type":"live"}'
const TABS = '{"type":"tabs"}'
const STANDBY = '{"type":"tabs","standby":true}'
const REPLACED = '{"replaced":true}'
const TAB: Tab = { app: 'terminal-app', tty: '/dev/ttys023' }

/** A stream handler that keeps every stream it is handed. `answer` is what its open answers, or throws, handed the
 *  stream too. */
function streamHandler(answer: (message: Record<string, unknown>, stream: ListenerStream) => typeof REFUSED | void = () => {}, perSecond = 10) {
  const opened: ListenerStream[] = []
  const waiters: (() => void)[] = []
  const handler: ListenerStreamHandler = {
    maxBytes: 64, perSecond,
    open: (message, stream) => {
      opened.push(stream)
      for (const each of waiters.splice(0)) each()
      return answer(message, stream)
    },
  }
  /** Once `count` streams have been handed out. */
  const handed = (count: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => { if (opened.length >= count) resolve(); else waiters.push(check) }
    check()
  })
  return { handler, opened, handed }
}

const endOf = (stream: ListenerStream): Promise<void> => new Promise((resolve) => {
  if (stream.ended.aborted) resolve()
  else stream.ended.addEventListener('abort', () => resolve())
})

interface Asked {
  status: number | undefined
  type: string | undefined
  /** Every whole line that came. */
  lines(): string[]
  /** Once `count` lines have come. */
  got(count: number): Promise<string[]>
  /** Once the listener closed the connection, or the client did. */
  closed: Promise<void>
  close(): void
}

/** A message on a connection of its own, as a watch asks for a stream: the answer's head, and its body line by line. */
function asked(path: string, body = TABS): Promise<Asked> {
  return new Promise((resolve, reject) => {
    const sent = request({ socketPath: path, agent: false, method: 'POST', path: '/' }, (res) => {
      let text = ''
      const arrivals: (() => void)[] = []
      const lines = (): string[] => text.split('\n').slice(0, -1)
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        text += chunk
        for (const each of arrivals.splice(0)) each()
      })
      // The listener ends a stream by closing its connection, which its client reads as an error.
      res.on('error', () => {})
      resolve({
        status: res.statusCode,
        type: res.headers['content-type'],
        lines,
        got: (count) => new Promise((done) => {
          const check = (): void => { if (lines().length >= count) done(lines()); else arrivals.push(check) }
          check()
        }),
        closed: new Promise((done) => res.once('close', done)),
        close: () => sent.destroy(),
      })
    })
    sent.on('error', reject)
    sent.end(body)
  })
}

/** A tab of terminal-app padded to exactly `bytes`. */
function tabOfBytes(bytes: number): string {
  const unpadded = Buffer.byteLength(JSON.stringify({ type: 'tab', ...TAB, pad: '' }))
  const body = JSON.stringify({ type: 'tab', ...TAB, pad: 'x'.repeat(bytes - unpadded) })
  expect(Buffer.byteLength(body)).toBe(bytes)
  return body
}

/** More than a socket's and its client's buffers hold, so a line this long cannot drain while nothing reads it. */
const UNDRAINABLE = { pad: 'x'.repeat(4 << 20) }

describe.skipIf(process.platform === 'win32')('the devices listener', () => {
  describe('who may connect', () => {
    it('the socket is 0600, and a socket, at the path asked for', async () => {
      const fronts: string[] = []
      const { path, listener } = await open({ front: frontHandler((app) => fronts.push(app)) })
      expect(listener).not.toBeNull()
      const seen = lstatSync(path)
      expect(seen.isSocket()).toBe(true)
      expect(seen.mode & 0o777).toBe(0o600)
      expect((await connection(path).front('ghostty')).status).toBe(204)
      expect(fronts).toEqual(['ghostty'])
    })

    it('a folder that is not this account\'s own is refused: nothing is opened', async () => {
      vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1)
      const { path, lines, listener } = await open({ front: frontHandler(() => {}) })
      expect(listener).toBeNull()
      expect(existsSync(path)).toBe(false)
      expect(lines).toEqual(['[devices] listener not opened · folder not private'])
    })

    it('a folder others can write to is refused', async () => {
      const dir = shortDir()
      chmodSync(dir, 0o757)
      const { path, lines, listener } = await open({ front: frontHandler(() => {}) }, { path: join(dir, 'devices.sock') })
      expect(listener).toBeNull()
      expect(existsSync(path)).toBe(false)
      expect(lines).toEqual(['[devices] listener not opened · folder not private'])
    })

    it('a folder that is a link is refused', async () => {
      const link = join(shortDir(), 'link')
      symlinkSync(shortDir(), link)
      const { path, lines, listener } = await open({ front: frontHandler(() => {}) }, { path: join(link, 'devices.sock') })
      expect(listener).toBeNull()
      expect(existsSync(path)).toBe(false)
      expect(lines).toEqual(['[devices] listener not opened · folder not private'])
    })

    it('a short folder that is not there yet is made, owner only', async () => {
      const folder = join(shortDir(), '.harness', 's', '0123456789abcdef')
      const { path, lines, listener } = await open({ front: frontHandler(() => {}) }, { path: join(folder, 'devices.sock') })
      expect(listener).not.toBeNull()
      expect(statSync(folder).mode & 0o777).toBe(0o700)
      expect(lstatSync(path).mode & 0o777).toBe(0o600)
      expect(lines).toEqual(['[devices] listener open'])
    })

    it('a socket that cannot be made is "failed", and nothing is opened', async () => {
      const { path, lines, listener } = await open({ front: frontHandler(() => {}) }, { path: join(shortDir(), 'missing', 'devices.sock') })
      expect(listener).toBeNull()
      expect(existsSync(dirname(path))).toBe(false)
      expect(lines).toEqual(['[devices] listener not opened · failed'])
    })

    it('a live listener already on the path: nothing is opened, and the first still answers', async () => {
      const fronts: string[] = []
      const first = await open({ front: frontHandler((app) => fronts.push(app)) })
      const second = await open({ front: frontHandler(() => { throw new Error('the second must never be reached') }) }, { path: first.path })
      expect(second.listener).toBeNull()
      expect(second.lines).toEqual(['[devices] listener not opened · in use'])
      expect((await connection(first.path).front('vscode')).status).toBe(204)
      expect(fronts).toEqual(['vscode'])
    })

    it('the socket file of a process that died is replaced', async () => {
      const path = join(shortDir(), 'devices.sock')
      const dead = await listenLocalSocket((_req, res) => res.end(), path)
      dead.server.close()
      expect(lstatSync(path).isSocket()).toBe(true)
      const fronts: string[] = []
      const { listener } = await open({ front: frontHandler((app) => fronts.push(app)) }, { path })
      expect(listener).not.toBeNull()
      expect((await connection(path).front('cursor')).status).toBe(204)
      expect(fronts).toEqual(['cursor'])
    })

    // Node's own would hold one for a minute and more, and sixteen of them every connection the listener takes.
    it('a connection that sends nothing, or stops partway through a message, is closed after the timeout', { timeout: 10_000 }, async () => {
      const { path } = await open({ front: frontHandler(() => {}) })
      const silent = bare(path, '')
      const partway = bare(path, post('{', 10))
      expect(await silent.read).toBe('')
      await partway.read
    })

    // Node checks a request's headers and body against their timeouts only every 30 s, and keeps a connection idle after
    // its answer 5 s and a second: measured at 30 s and 6 s.
    it('a connection that sends a byte at a time, or kept alive sends nothing after its answer, is closed after the timeout', { timeout: 10_000 }, async () => {
      const { path } = await open({ front: frontHandler(() => {}) })
      const started = performance.now()
      const message = post(frontBody('ghostty'))
      const trickling = bare(path, message[0]!)
      let sent = 1
      // 17 s for the whole message.
      const drip = setInterval(() => { if (!trickling.socket.destroyed && sent < message.length) trickling.socket.write(message[sent++]!) }, 200)
      const kept = bare(path, message)
      try {
        const answer = await kept.read
        expect(answer).toMatch(/^HTTP\/1\.1 204 /)
        // What a Node client reads to let go of an idle connection a second before that.
        expect(answer).toMatch(/\r\nKeep-Alive: timeout=2\r\n/)
        expect(await trickling.read).toBe('')
      } finally {
        clearInterval(drip)
      }
      expect(performance.now() - started).toBeLessThan(4_000)
    })

    it('the 17th connection at once is closed, and the 16 go on', async () => {
      const { path } = await open({ front: frontHandler(() => {}) })
      const sixteen = Array.from({ length: LISTENER_MAX_CONNECTIONS }, () => connection(path))
      expect(sixteen).toHaveLength(16)
      for (const each of sixteen) expect((await each.front('ghostty')).status).toBe(204)
      expect(await bare(path, '').read).toBe('')
      for (const each of sixteen) expect(await each.front('vscode')).toMatchObject({ status: 204, reused: true })
    })
  })

  describe('what a message may be', () => {
    it('an oversized body is dropped and counted, and the handler never runs', async () => {
      const fronts: string[] = []
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)) })
      expect((await connection(path).send(frontOf(FRONT_MAX_BYTES))).status).toBe(204)
      expect((await connection(path).send(frontOf(FRONT_MAX_BYTES + 1))).status).toBe(413)
      // A body of 1 MiB is answered once one byte past the largest limit has come, before the rest is sent, and the
      // connection is closed: the listener reads no more than that.
      const { read } = bare(path, post('x'.repeat(FRONT_MAX_BYTES + 1), 1 << 20))
      expect(await read).toMatch(/^HTTP\/1\.1 413 /)
      expect(fronts).toEqual(['ghostty'])
    })

    it('a body over its own type\'s limit and under another type\'s is dropped', async () => {
      const fronts: string[] = []
      const big: ListenerHandler = { maxBytes: 1024, perSecond: 10, handle: () => undefined }
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)), big })
      expect((await connection(path).send(frontOf(200))).status).toBe(413)
      expect(fronts).toEqual([])
      // Over the largest limit, nothing is read past it.
      const { read } = bare(path, post('x'.repeat(1025), 1 << 20))
      expect(await read).toMatch(/^HTTP\/1\.1 413 /)
    })

    it('an unknown type is dropped and counted', async () => {
      const { path } = await open({ front: frontHandler(() => {}) })
      const sender = connection(path)
      for (const type of ['nope', '__proto__', 'constructor', 'toString']) {
        expect((await sender.send(JSON.stringify({ type }))).status, type).toBe(404)
      }
    })

    it('a body that is not a JSON object with a string type is refused', async () => {
      const fronts: string[] = []
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)) })
      const sender = connection(path)
      for (const body of ['[]', '"front"', 'null', '{', '{"type":7}', '{}']) expect((await sender.send(body)).status, body).toBe(400)
      expect(fronts).toEqual([])
    })

    it('anything but POST / is refused', async () => {
      const fronts: string[] = []
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)) })
      expect((await connection(path).send('', 'GET', '/')).status).toBe(405)
      expect((await connection(path).send(JSON.stringify({ type: 'front', app: 'ghostty' }), 'POST', '/front')).status).toBe(405)
      // Its body is never read: the connection is closed rather than waded through to the end of 1 MiB.
      const { read } = bare(path, `GET / HTTP/1.1\r\nHost: devices\r\nContent-Length: ${1 << 20}\r\n\r\nx`)
      expect(await read).toMatch(/^HTTP\/1\.1 405 /)
      expect(fronts).toEqual([])
    })
  })

  describe('what a flood costs', () => {
    it('the 11th front within a second on one connection is dropped; another connection\'s is taken', async () => {
      let now = 0
      const fronts: string[] = []
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)) }, { now: () => now })
      const one = connection(path), two = connection(path)
      for (let i = 0; i < FRONT_PER_SECOND; i++) expect((await one.front('ghostty')).status).toBe(204)
      expect(await one.front('vscode')).toMatchObject({ status: 429, reused: true })
      expect((await two.front('cursor')).status).toBe(204)

      // A second later ten more pass.
      now = 1_000
      for (let i = 0; i < FRONT_PER_SECOND; i++) expect((await one.front('ghostty')).status).toBe(204)
      expect((await one.front('vscode')).status).toBe(429)

      // A clock set back refills nothing.
      now = 500
      expect((await one.front('vscode')).status).toBe(429)
      now = 1_000
      expect((await one.front('vscode')).status).toBe(429)
      expect(fronts).toEqual([...Array(10).fill('ghostty'), 'cursor', ...Array(10).fill('ghostty')])
    })

    it('the first second takes no more than ten fronts on a connection', async () => {
      let now = 0
      const fronts: string[] = []
      const { path } = await open({ front: frontHandler((app) => fronts.push(app)) }, { now: () => now })
      const sender = connection(path)
      for (let i = 0; i < FRONT_PER_SECOND; i++) {
        now = i * 99
        expect((await sender.front('ghostty')).status).toBe(204)
      }
      now = 999
      expect((await sender.front('vscode')).status).toBe(429)
      // A second after the first, one more; the second's second is 99 ms later.
      now = 1_000
      expect((await sender.front('cursor')).status).toBe(204)
      expect((await sender.front('vscode')).status).toBe(429)
      expect(fronts).toEqual([...Array(10).fill('ghostty'), 'cursor'])
    })

    it('fresh connections, one front each: past the listener\'s budget within a second, dropped as rate', async () => {
      let now = 0
      const fronts: string[] = []
      const { path, lines } = await open({ front: frontHandler((app) => fronts.push(app)) }, { now: () => now })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // What its connections could send at once, each at its own rate.
      const budget = LISTENER_MAX_CONNECTIONS * FRONT_PER_SECOND
      for (let i = 0; i < budget; i++) expect(await once(path, frontBody('ghostty'))).toBe(204)
      expect(await once(path, frontBody('vscode'))).toBe(429)
      now = 1_000
      expect(await once(path, frontBody('cursor'))).toBe(204)
      expect(fronts).toEqual([...Array(budget).fill('ghostty'), 'cursor'])
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 1 over rate, 0 refused, 0 failed')
    })

    it('past the listener\'s budget of dropped messages in a second, a message is refused unread and its connection closed', async () => {
      let now = 0
      const fronts: string[] = []
      const { path, lines } = await open({ front: frontHandler((app) => fronts.push(app)) }, { now: () => now })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const junk = ['{"type":"nope"}', '{', frontBody('Ghostty'), frontOf(FRONT_MAX_BYTES + 1)]
      for (let i = 0; i < LISTENER_DROPPED_PER_SECOND; i++) expect(await once(path, junk[i % junk.length]!)).toBeGreaterThanOrEqual(400)
      // Even a front: nothing more is read this second, of any size.
      expect(await once(path, frontBody('ghostty'))).toBe(429)
      const { read } = bare(path, post('x', 1 << 20))
      expect(await read).toMatch(/^HTTP\/1\.1 429 /)
      now = 1_000
      expect(await once(path, frontBody('vscode'))).toBe(204)
      expect(fronts).toEqual(['vscode'])
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 25 unknown, 25 oversized, 2 over rate, 50 refused, 0 failed')
    })

    it('each type has a rate of its own on a connection', async () => {
      let pings = 0
      const ping: ListenerHandler = { maxBytes: 64, perSecond: 1, handle: () => { pings++ } }
      const { path } = await open({ front: frontHandler(() => {}), ping }, { now: () => 0 })
      const sender = connection(path)
      for (let i = 0; i < FRONT_PER_SECOND; i++) expect((await sender.front('ghostty')).status).toBe(204)
      expect((await sender.front('ghostty')).status).toBe(429)
      expect((await sender.send('{"type":"ping"}')).status).toBe(204)
      expect((await sender.send('{"type":"ping"}')).status).toBe(429)
      expect(pings).toBe(1)
    })
  })

  describe('what is said of it', () => {
    it('opening logs "[devices] listener open" and no path', async () => {
      const { lines } = await open({ front: frontHandler(() => {}) })
      expect(lines).toEqual(['[devices] listener open'])
    })

    it('nothing logs or echoes what was sent', async () => {
      const fronts: string[] = []
      const { path, lines } = await open({ front: frontHandler((app) => fronts.push(app)) }, { now: () => 0 })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const answers: string[] = []
      const said = async (answer: Promise<Answer>, status: number) => {
        const { status: got, body } = await answer
        expect(got).toBe(status)
        answers.push(body)
      }

      await said(connection(path).send(JSON.stringify({ type: 'made-up-7c2e', app: 'ghostty' })), 404)
      await said(connection(path).send(JSON.stringify({ type: 'front', app: 'com.mitchellh.ghostty', pad: 'marker-5f3a'.repeat(8) })), 413)
      const burst = connection(path)
      for (let i = 0; i < FRONT_PER_SECOND; i++) await said(burst.front('ghostty'), 204)
      await said(burst.front('ghostty'), 429)
      const refused = connection(path)
      await said(refused.send(JSON.stringify({ type: 7, app: 'ghostty' })), 400)
      await said(refused.front('com.mitchellh.ghostty'), 400)
      await said(refused.front('marker-5f3a'), 400)

      expect(answers.every((body) => body === '')).toBe(true)
      expect(lines).toEqual(['[devices] listener open'])
      vi.advanceTimersByTime(MINUTE)
      expect(lines).toEqual(['[devices] listener open', '[devices] listener in the last minute: 1 unknown, 1 oversized, 1 over rate, 3 refused, 0 failed'])
      for (const text of [...lines, ...answers]) expect(text).not.toMatch(/ghostty|marker-5f3a|made-up-7c2e/)
      expect(fronts).toEqual(Array(10).fill('ghostty'))

      // The next minute starts from nothing.
      await said(connection(path).send('{"type":"nope"}'), 404)
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 1 unknown, 0 oversized, 0 over rate, 0 refused, 0 failed')
    })

    it('a handler that throws is 500, counted failed, logged with no text of the error, and the next message is taken', async () => {
      const fronts: string[] = []
      const { path, lines } = await open({
        front: frontHandler((app) => fronts.push(app)),
        boom: { maxBytes: 64, perSecond: 10, handle: () => { throw new Error('secret-9b1d') } },
        later: { maxBytes: 64, perSecond: 10, handle: () => Promise.reject(new Error('secret-9b1d')) },
        odd: { maxBytes: 64, perSecond: 10, handle: () => 1n },
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const sender = connection(path)
      for (const type of ['boom', 'later', 'odd']) expect(await sender.send(JSON.stringify({ type }))).toMatchObject({ status: 500, body: '' })
      expect((await sender.front('vscode')).status).toBe(204)
      expect(fronts).toEqual(['vscode'])
      vi.advanceTimersByTime(MINUTE)
      expect(lines).toEqual(['[devices] listener open', '[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 0 refused, 3 failed'])
    })
  })

  describe('the door for the handlers to come', () => {
    it('a handler\'s value is the answer, and a promise is waited for', async () => {
      let asked: AbortSignal | undefined
      const later = held()
      const { path } = await open({
        ask: { maxBytes: 64, perSecond: 10, handle: (message, gone) => { asked = gone; return { asked: message.type } } },
        later: later.handler,
      })
      expect(await connection(path).send('{"type":"ask"}')).toMatchObject({ status: 200, body: '{"asked":"ask"}' })
      expect(asked?.aborted).toBe(false)

      const answer = connection(path).send('{"type":"later"}')
      await later.called
      later.state.answer!({ n: 2 })
      expect(await answer).toMatchObject({ status: 200, body: '{"n":2}' })
      expect(later.state.gone!.aborted).toBe(false)
    })

    it('gone aborts when the sender\'s connection closes before the answer', async () => {
      const later = held()
      const { path } = await open({ later: later.handler })
      const { socket } = bare(path, post('{"type":"later"}'))
      await later.called
      expect(later.state.gone!.aborted).toBe(false)
      const aborted = new Promise((resolve) => later.state.gone!.addEventListener('abort', resolve))
      socket.destroy()
      await aborted
      expect(later.state.gone!.aborted).toBe(true)
    })
  })

  describe('close', () => {
    it('close removes the socket, ends open connections, aborts every gone and leaves no timer; a second close does nothing', async () => {
      const later = held()
      const { path, lines, listener } = await open({ front: frontHandler(() => {}), later: later.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const idle = connection(path)
      expect((await idle.send('{"type":"nope"}')).status).toBe(404)
      // The minute's count, and the idle connection's deadline.
      expect(vi.getTimerCount()).toBe(2)
      const waiting = bare(path, post('{"type":"later"}'))
      await later.called

      await listener!.close()
      expect(later.state.gone!.aborted).toBe(true)
      expect(await waiting.read).toBe('')
      expect(existsSync(path)).toBe(false)
      expect(vi.getTimerCount()).toBe(0)

      await listener!.close()
      vi.advanceTimersByTime(MINUTE)
      expect(lines).toEqual(['[devices] listener open'])
      await expect(idle.front('ghostty')).rejects.toThrow()
    })

    it('close ends an open stream and leaves no timer', async () => {
      const live = streamHandler()
      const { path, listener } = await open({ live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stopped = bare(path, post(LIVE))
      stopped.socket.pause()
      await live.handed(1)
      const [stream] = live.opened
      // A line waiting to drain: its connection's deadline is gone, and the line's own 2 s is the one timer.
      expect(stream!.write(UNDRAINABLE)).toBe(true)
      expect(vi.getTimerCount()).toBe(1)

      await listener!.close()
      expect(stream!.ended.aborted).toBe(true)
      expect(stream!.write({ n: 1 })).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
      stopped.socket.resume()
      await stopped.read
    })
  })

  describe('a stream', () => {
    it('a stream handler answers 200, its lines arrive as NDJSON, and it ends when the client closes', async () => {
      const live = streamHandler()
      const { path } = await open({ live: live.handler })
      // The head comes before any line: the stream is open once it is asked for.
      const client = await asked(path, LIVE)
      expect(client).toMatchObject({ status: 200, type: 'application/x-ndjson' })
      const [stream] = live.opened
      expect(stream!.write({ n: 1 })).toBe(true)
      await client.got(1)
      expect(stream!.write({ n: 2, s: 'two' })).toBe(true)
      expect(await client.got(2)).toEqual(['{"n":1}', '{"n":2,"s":"two"}'])

      client.close()
      await endOf(stream!)
      expect(stream!.write({ n: 3 })).toBe(false)
    })

    it('a second stream of the type ends the first with a last line {"replaced":true} and closes its connection; the second goes on', async () => {
      const live = streamHandler()
      const other = streamHandler()
      const { path } = await open({ live: live.handler, other: other.handler })
      const elsewhere = await asked(path, '{"type":"other"}')
      const first = await asked(path, LIVE)
      const second = await asked(path, LIVE)
      const [one, two] = live.opened
      expect(one!.ended.aborted).toBe(true)
      await first.closed
      expect(one!.write({ n: 1 })).toBe(false)
      expect(two!.write({ n: 2 })).toBe(true)
      expect(await second.got(1)).toEqual(['{"n":2}'])
      expect(first.lines()).toEqual([REPLACED])
      // A stream of another type is its own.
      expect(other.opened[0]!.write({ n: 3 })).toBe(true)
      expect(await elsewhere.got(1)).toEqual(['{"n":3}'])
    })

    it('a replaced stream whose client reads its last line leaves no timer; one whose client does not is closed 2 s on', async () => {
      const live = streamHandler()
      const { path } = await open({ live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const reading = await asked(path, LIVE)
      const stopped = bare(path, post(LIVE))
      await reading.closed
      expect(reading.lines()).toEqual([REPLACED])
      // Its connection gone, its 2 s with it.
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(0))

      // A line waiting to drain: the last line waits behind it, and the connection goes 2 s after the newer stream opened.
      stopped.socket.pause()
      const [, older] = live.opened
      expect(older!.write(UNDRAINABLE)).toBe(true)
      const newer = await asked(path, LIVE)
      expect(older!.ended.aborted).toBe(true)
      vi.advanceTimersByTime(1_999)
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(1)
      expect(vi.getTimerCount()).toBe(0)
      stopped.socket.resume()
      expect(await stopped.read).not.toContain('replaced')
      expect(live.opened[2]!.write({ n: 1 })).toBe(true)
      expect(await newer.got(1)).toEqual(['{"n":1}'])
    })

    it('a standby open is 409 while a stream of the type is open, and leaves it open; with none open it is a stream', async () => {
      const live = streamHandler()
      const { path, lines } = await open({ live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const kept = await asked(path, LIVE)
      const refused = await asked(path, '{"type":"live","standby":true}')
      expect(refused.status).toBe(409)
      await refused.closed
      expect(refused.lines()).toEqual([])
      // standby is a boolean or nothing.
      const sender = connection(path)
      for (const standby of ['1', '"true"', 'null', '{}']) {
        expect((await sender.send(`{"type":"live","standby":${standby}}`)).status, standby).toBe(400)
      }
      // None of them reached the handler, and the open stream goes on.
      expect(live.opened).toHaveLength(1)
      expect(live.opened[0]!.ended.aborted).toBe(false)
      expect(live.opened[0]!.write({ n: 1 })).toBe(true)
      expect(await kept.got(1)).toEqual(['{"n":1}'])

      kept.close()
      await endOf(live.opened[0]!)
      const standing = await asked(path, '{"type":"live","standby":true}')
      expect(standing).toMatchObject({ status: 200, type: 'application/x-ndjson' })
      expect(live.opened[1]!.write({ n: 2 })).toBe(true)
      expect(await standing.got(1)).toEqual(['{"n":2}'])
      // standby false is an open like any other: it replaces the open one.
      const normal = await asked(path, '{"type":"live","standby":false}')
      await standing.closed
      expect(standing.lines()).toEqual(['{"n":2}', REPLACED])
      expect(live.opened[2]!.write({ n: 3 })).toBe(true)
      expect(await normal.got(1)).toEqual(['{"n":3}'])
      // The 409 is the answer a standing watch waits on, not a message dropped: only the four refused are counted.
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 4 refused, 0 failed')
    })

    // Every end destroys its connection: a client that pools connections must not send a tell on one.
    it('a stream\'s head closes its connection, though its client asked to keep it alive', async () => {
      const live = streamHandler()
      const { path } = await open({ live: live.handler })
      const kept = bare(path, post(LIVE))
      const head = await new Promise<string>((resolve) => {
        let got = ''
        kept.socket.on('data', (chunk: string) => { if ((got += chunk).includes('\r\n\r\n')) resolve(got) })
      })
      expect(head).toMatch(/^HTTP\/1\.1 200 /)
      expect(head).toMatch(/\r\nConnection: close\r\n/)
    })

    it('a stream outlives the 2 s deadline, and still counts as one of the 16', async () => {
      const live = streamHandler()
      const { path } = await open({ front: frontHandler(() => {}), live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const client = await asked(path, LIVE)
      const [stream] = live.opened
      expect(stream!.write({ n: 1 })).toBe(true)
      await client.got(1)
      // Past its connection's deadline, and past the 2 s its line had to drain.
      vi.advanceTimersByTime(5_000)
      expect(stream!.ended.aborted).toBe(false)
      expect(stream!.write({ n: 2 })).toBe(true)
      expect(await client.got(2)).toEqual(['{"n":1}', '{"n":2}'])

      // Silent, so only the faked deadline could free their slots: a kept-alive answer's real 2 s timer would.
      const fifteen = Array.from({ length: LISTENER_MAX_CONNECTIONS - 1 }, () => bare(path, ''))
      await Promise.all(fifteen.map(({ socket }) => new Promise((connected) => socket.once('connect', connected))))
      expect(await bare(path, '').read).toBe('')
      for (const { socket } of fifteen) expect(socket.destroyed).toBe(false)
      expect(stream!.ended.aborted).toBe(false)
    })

    it('a client that stops reading: a line not drained in 2 s ends the stream and closes its connection, and a line while one waits is not written', async () => {
      const live = streamHandler()
      const { path } = await open({ live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const stopped = bare(path, post(LIVE))
      stopped.socket.pause()
      await live.handed(1)
      const [stream] = live.opened
      expect(stream!.write(UNDRAINABLE)).toBe(true)
      expect(stream!.write({ n: 2 })).toBe(false)
      vi.advanceTimersByTime(1_999)
      expect(stream!.ended.aborted).toBe(false)
      vi.advanceTimersByTime(1)
      expect(stream!.ended.aborted).toBe(true)
      stopped.socket.resume()
      expect(await stopped.read).not.toContain('"n":2')
    })

    it('a socket that errors ends the stream at once', async () => {
      const live = streamHandler()
      const { path } = await open({ live: live.handler })
      // No timer runs: the end cannot be a deadline's.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const broken = bare(path, post(LIVE))
      await live.handed(1)
      // Bytes no HTTP parser takes: the listener's side of the socket errors.
      broken.socket.write('NOT HTTP\r\n\r\n')
      await endOf(live.opened[0]!)
      await broken.read
    })

    it('a second message on a connection that holds a stream closes it, counted refused', async () => {
      const fronts: string[] = []
      const live = streamHandler()
      const { path, lines } = await open({ front: frontHandler((app) => fronts.push(app)), live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      // Once the stream is open.
      const later = bare(path, post(LIVE))
      await live.handed(1)
      later.socket.write(post(frontBody('ghostty')))
      await later.read
      // In the same write as the message that opened it: it came before the stream was open.
      const together = bare(path, post(LIVE) + post(frontBody('vscode')))
      expect(await together.read).toMatch(/^HTTP\/1\.1 200 /)
      expect(live.opened.map(({ ended }) => ended.aborted)).toEqual([true, true])
      expect(fronts).toEqual([])
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 2 refused, 0 failed')
    })

    it('the third open in a second on one connection is 429, and the open stream stays', async () => {
      const live = streamHandler((message) => message.bad ? REFUSED : undefined, TABS_PER_SECOND)
      const { path } = await open({ live: live.handler }, { now: () => 0 })
      const kept = await asked(path, LIVE)
      const sender = connection(path)
      expect((await sender.send('{"type":"live","bad":1}')).status).toBe(400)
      expect((await sender.send('{"type":"live","bad":2}')).status).toBe(400)
      expect((await sender.send(LIVE)).status).toBe(429)
      // The kept stream and the two refused: the third never reached the handler.
      expect(live.opened).toHaveLength(3)
      expect(live.opened[0]!.ended.aborted).toBe(false)
      expect(live.opened[0]!.write({ n: 1 })).toBe(true)
      expect(await kept.got(1)).toEqual(['{"n":1}'])
    })

    it('a stream handler that refuses is 400 and opens nothing; one that throws is 500, counted failed', async () => {
      const live = streamHandler((message) => {
        if (message.boom) throw new Error('secret-9b1d')
        return message.bad ? REFUSED : undefined
      })
      const { path, lines } = await open({ live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const kept = await asked(path, LIVE)
      const sender = connection(path)
      expect(await sender.send('{"type":"live","bad":1}')).toMatchObject({ status: 400, body: '' })
      expect(await sender.send('{"type":"live","boom":1}')).toMatchObject({ status: 500, body: '' })
      const [stream, refused, thrown] = live.opened
      for (const each of [refused!, thrown!]) {
        expect(each.ended.aborted).toBe(true)
        expect(each.write({ n: 1 })).toBe(false)
      }
      // The open stream of the type is not ended by a message that opened nothing.
      expect(stream!.ended.aborted).toBe(false)
      expect(stream!.write({ n: 2 })).toBe(true)
      expect(await kept.got(1)).toEqual(['{"n":2}'])
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 1 refused, 1 failed')
    })

    it('a writable listener runs once the stream has opened, and a line it writes is the stream\'s first line', async () => {
      const early: boolean[] = []
      const live = streamHandler((_message, stream) => {
        // Inside open the stream takes no line yet.
        early.push(stream.write({ early: true }))
        let runs = 0
        stream.onWritable(() => { if (runs++ === 0) stream.write({ first: true }) })
      })
      const { path } = await open({ live: live.handler })
      const client = await asked(path, LIVE)
      expect(client.status).toBe(200)
      expect(await client.got(1)).toEqual(['{"first":true}'])
      expect(early).toEqual([false])
    })

    it('the writable listener runs again each time a line has drained, and not while one waits', async () => {
      let runs = 0
      const live = streamHandler((_message, stream) => stream.onWritable(() => { runs++ }))
      const { path } = await open({ live: live.handler })
      const client = await asked(path, LIVE)
      expect(runs).toBe(1)
      const [stream] = live.opened
      expect(stream!.write({ n: 1 })).toBe(true)
      expect(stream!.write({ n: 2 })).toBe(false)
      expect(runs).toBe(1)
      await client.got(1)
      await vi.waitFor(() => expect(runs).toBe(2))
      expect(stream!.write({ n: 3 })).toBe(true)
      expect(await client.got(2)).toEqual(['{"n":1}', '{"n":3}'])
      await vi.waitFor(() => expect(runs).toBe(3))
    })

    it('a later onWritable replaces the listener', async () => {
      const calls: string[] = []
      const live = streamHandler((_message, stream) => {
        stream.onWritable(() => calls.push('first'))
        stream.onWritable(() => calls.push('second'))
      })
      const { path } = await open({ live: live.handler })
      const client = await asked(path, LIVE)
      expect(calls).toEqual(['second'])
      const [stream] = live.opened
      stream!.onWritable(() => calls.push('third'))
      expect(stream!.write({ n: 1 })).toBe(true)
      await client.got(1)
      await vi.waitFor(() => expect(calls).toEqual(['second', 'third']))
    })

    it('no writable call comes after the stream ended', async () => {
      let runs = 0
      const live = streamHandler((_message, stream) => stream.onWritable(() => { runs++ }))
      const { path } = await open({ live: live.handler })
      const stopped = bare(path, post(LIVE))
      stopped.socket.pause()
      await live.handed(1)
      const [stream] = live.opened
      expect(runs).toBe(1)
      // The client closes while a line waits: the line's callback comes with an error, not as a drain.
      expect(stream!.write(UNDRAINABLE)).toBe(true)
      stopped.socket.destroy()
      await endOf(stream!)
      await stopped.read
      expect(runs).toBe(1)
      stream!.onWritable(() => { runs++ })
      expect(stream!.write({ n: 1 })).toBe(false)
      expect(runs).toBe(1)
    })

    it('a writable listener that throws ends the stream as closed, counted failed, and the next message is taken', async () => {
      const fronts: string[] = []
      // One throws as its stream opens, the other once its first line has drained, inside the socket's callback.
      const opening = streamHandler((_message, stream) => stream.onWritable(() => { throw new Error('secret-9b1d') }))
      const draining = streamHandler((_message, stream) => {
        let runs = 0
        stream.onWritable(() => {
          if (runs++ > 0) throw new Error('secret-9b1d')
          stream.write({ n: 1 })
        })
      })
      const { path, lines } = await open({ front: frontHandler((app) => fronts.push(app)), live: opening.handler, other: draining.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

      const thrown = bare(path, post(LIVE))
      expect(await thrown.read).toMatch(/^HTTP\/1\.1 200 /)
      expect(opening.opened[0]!.ended.reason).toBe('closed')
      expect((await connection(path).front('vscode')).status).toBe(204)
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 0 refused, 1 failed')

      const drained = bare(path, post('{"type":"other"}'))
      expect(await drained.read).toContain('{"n":1}')
      expect(draining.opened[0]!.ended.reason).toBe('closed')
      expect((await connection(path).front('ghostty')).status).toBe(204)
      vi.advanceTimersByTime(MINUTE)
      expect(lines.at(-1)).toBe('[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 0 refused, 1 failed')
      expect(fronts).toEqual(['vscode', 'ghostty'])
      expect(lines.join('\n')).not.toContain('secret-9b1d')
    })

    it('ended says why', async () => {
      const live = streamHandler()
      const { path, listener } = await open({ front: frontHandler(() => {}), live: live.handler })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const reasons = (): unknown[] => live.opened.map(({ ended }) => ended.reason)

      // gone: the client closes, its socket errors, or a second message on its connection closes it.
      const client = await asked(path, LIVE)
      client.close()
      await endOf(live.opened[0]!)
      const broken = bare(path, post(LIVE))
      await live.handed(2)
      broken.socket.write('NOT HTTP\r\n\r\n')
      await endOf(live.opened[1]!)
      const twice = bare(path, post(LIVE))
      await live.handed(3)
      twice.socket.write(post(frontBody('ghostty')))
      await endOf(live.opened[2]!)
      await Promise.all([broken.read, twice.read])
      expect(reasons()).toEqual(['gone', 'gone', 'gone'])

      // stalled: a line not drained in 2 s. Its connection closing after is not a second reason.
      const stopped = bare(path, post(LIVE))
      stopped.socket.pause()
      await live.handed(4)
      expect(live.opened[3]!.write(UNDRAINABLE)).toBe(true)
      vi.advanceTimersByTime(2_000)
      stopped.socket.resume()
      await stopped.read
      expect(live.opened[3]!.ended.reason).toBe('stalled')

      // replaced: a newer stream of its type.
      const older = await asked(path, LIVE)
      const newer = await asked(path, LIVE)
      await older.closed
      expect(live.opened[4]!.ended.reason).toBe('replaced')

      // closed: the listener closes.
      await listener!.close()
      await newer.closed
      expect(reasons()).toEqual(['gone', 'gone', 'gone', 'stalled', 'replaced', 'closed'])
    })

    it('a stream whose open refused or threw is aborted as closed', async () => {
      let runs = 0
      const live = streamHandler((message, stream) => {
        stream.onWritable(() => { runs++ })
        if (message.boom) throw new Error('secret-9b1d')
        return REFUSED
      })
      const { path } = await open({ live: live.handler })
      const sender = connection(path)
      expect((await sender.send('{"type":"live","bad":1}')).status).toBe(400)
      expect((await sender.send('{"type":"live","boom":1}')).status).toBe(500)
      expect(live.opened.map(({ ended }) => [ended.aborted, ended.reason])).toEqual([[true, 'closed'], [true, 'closed']])
      expect(runs).toBe(0)
    })
  })

  describe('tab and tabs', () => {
    it('a 97-byte tab is 413; the 11th tab in a second on a connection is 429', async () => {
      const reported: Tab[] = []
      const { path } = await open({ tab: tabHandler((tab) => reported.push(tab)) }, { now: () => 0 })
      expect((await connection(path).send(tabOfBytes(TAB_MAX_BYTES))).status).toBe(204)
      expect((await connection(path).send(tabOfBytes(TAB_MAX_BYTES + 1))).status).toBe(413)
      const sender = connection(path)
      for (let i = 0; i < TAB_PER_SECOND; i++) expect((await sender.send(JSON.stringify({ type: 'tab', ...TAB }))).status).toBe(204)
      expect((await sender.send(JSON.stringify({ type: 'tab', ...TAB }))).status).toBe(429)
      expect(reported).toStrictEqual(Array(1 + TAB_PER_SECOND).fill(TAB))
    })

    it('tabs is open only while a stream is; select writes one {"app","tty"} line; with no stream it is false', async () => {
      const tabs = tabsStream()
      const opened = vi.spyOn(tabs.handler, 'open')
      const { path } = await open({ tabs: tabs.handler })
      expect(tabs.isOpen()).toBe(false)
      expect(tabs.select(TAB, false)).toBe(false)

      const watch = await asked(path)
      expect(watch).toMatchObject({ status: 200, type: 'application/x-ndjson' })
      expect(tabs.isOpen()).toBe(true)
      // Only app and tty go on the line, whatever else the tab holds.
      expect(tabs.select({ ...TAB, title: 'marker-5f3a' } as Tab, false)).toBe(true)
      expect(await watch.got(1)).toEqual(['{"app":"terminal-app","tty":"/dev/ttys023"}'])

      watch.close()
      await endOf(opened.mock.calls[0]![1])
      expect(tabs.isOpen()).toBe(false)
      expect(tabs.select(TAB, false)).toBe(false)
    })

    it('a select that raises writes "raise":true after app and tty; one that does not has no raise key', async () => {
      const tabs = tabsStream()
      const { path } = await open({ tabs: tabs.handler })
      const watch = await asked(path)
      expect(tabs.select({ app: 'iterm', tty: '/dev/ttys001' }, true)).toBe(true)
      await watch.got(1)
      expect(tabs.select({ app: 'ghostty', tty: '/dev/ttys002' }, false)).toBe(true)
      // The text itself: its keys' order, and no raise key at all on a swipe's.
      expect(await watch.got(2)).toEqual(['{"app":"iterm","tty":"/dev/ttys001","raise":true}', '{"app":"ghostty","tty":"/dev/ttys002"}'])
    })

    it('a newer tabs stream is the one written to', async () => {
      const tabs = tabsStream()
      const opened = vi.spyOn(tabs.handler, 'open')
      const { path } = await open({ tabs: tabs.handler })
      const older = await asked(path)
      const newer = await asked(path)
      await older.closed
      expect(tabs.isOpen()).toBe(true)
      expect(tabs.select(TAB, false)).toBe(true)
      expect(await newer.got(1)).toEqual(['{"app":"terminal-app","tty":"/dev/ttys023"}'])
      expect(older.lines()).toEqual([REPLACED])

      newer.close()
      await endOf(opened.mock.calls[1]![1])
      expect(tabs.isOpen()).toBe(false)
    })

    it('a standby tabs request is 409 while a watch holds the stream; once that ends, the standby one is written to', async () => {
      const tabs = tabsStream()
      const opened = vi.spyOn(tabs.handler, 'open')
      const { path } = await open({ tabs: tabs.handler })
      const alive = await asked(path)
      expect((await asked(path, STANDBY)).status).toBe(409)
      expect(opened).toHaveBeenCalledOnce()
      expect(tabs.select(TAB, false)).toBe(true)
      expect(await alive.got(1)).toEqual(['{"app":"terminal-app","tty":"/dev/ttys023"}'])

      alive.close()
      await endOf(opened.mock.calls[0]![1])
      const standing = await asked(path, STANDBY)
      expect(standing.status).toBe(200)
      expect(tabs.select(TAB, true)).toBe(true)
      expect(await standing.got(1)).toEqual(['{"app":"terminal-app","tty":"/dev/ttys023","raise":true}'])
    })

    it('nothing logs or echoes a tty', async () => {
      const reported: Tab[] = []
      const tabs = tabsStream()
      const { path, lines } = await open({ tab: tabHandler((tab) => reported.push(tab)), tabs: tabs.handler }, { now: () => 0 })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const watch = await asked(path)
      const answers: string[] = []
      const said = async (answer: Promise<Answer>, status: number) => {
        const { status: got, body } = await answer
        expect(got).toBe(status)
        answers.push(body)
      }

      const burst = connection(path)
      for (let i = 0; i < TAB_PER_SECOND; i++) await said(burst.send(JSON.stringify({ type: 'tab', ...TAB })), 204)
      await said(burst.send(JSON.stringify({ type: 'tab', ...TAB })), 429)
      await said(connection(path).send(JSON.stringify({ type: 'tab', app: 'iterm', tty: '/dev/ttys0231' + '5f3a' })), 400)
      await said(connection(path).send(tabOfBytes(TAB_MAX_BYTES + 1)), 413)
      // The stream is where a tty goes, and nowhere else.
      expect(tabs.select(TAB, true)).toBe(true)
      await watch.got(1)

      vi.advanceTimersByTime(MINUTE)
      expect(lines).toEqual(['[devices] listener open', '[devices] listener in the last minute: 0 unknown, 1 oversized, 1 over rate, 1 refused, 0 failed'])
      for (const text of [...lines, ...answers]) expect(text).not.toMatch(/ttys|5f3a|terminal-app|iterm/)
      expect(reported).toHaveLength(TAB_PER_SECOND)
    })
  })
})

describe('the devices listener on every computer', () => {
  const noPath = (platform: NodeJS.Platform, log: (line: string) => void) => {
    const options = { path: null, handlers: { front: frontHandler(() => {}) }, log, platform }
    return openDevicesListener(options)
  }

  it('with no path on Windows, where there is no listener yet, nothing is opened and nothing is logged', async () => {
    const log = vi.fn()
    expect(await noPath('win32', log)).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })

  it('with no path elsewhere (a data folder and a home both too long) nothing is opened, and it says so', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const lines: string[] = []
      expect(await noPath(platform, (line) => lines.push(line))).toBeNull()
      expect(lines, platform).toEqual(['[devices] listener not opened · no path'])
    }
  })
})

describe('front', () => {
  const gone = new AbortController().signal

  it('front takes every app id and none', () => {
    const fronts: string[] = []
    const handler = frontHandler((app) => fronts.push(app))
    for (const app of [...APP_IDS, FRONT_NONE]) expect(handler.handle({ type: 'front', app }, gone), app).toBeUndefined()
    expect(fronts).toEqual([...APP_IDS, FRONT_NONE])
    expect(fronts).toContain('terminal')
    expect(fronts).toHaveLength(18)
  })

  it('front refuses an unknown app id', () => {
    const front = vi.fn()
    const handler = frontHandler(front)
    for (const app of [undefined, 7, '', 'Ghostty', 'com.mitchellh.ghostty', 'other', 'Other', '__proto__']) {
      const message: Record<string, unknown> = app === undefined ? { type: 'front' } : { type: 'front', app }
      expect(handler.handle(message, gone), String(app)).toBe(REFUSED)
    }
    expect(front).not.toHaveBeenCalled()
  })

  it('the front handler holds nothing: it is its two limits and handle', () => {
    const handler = frontHandler(() => {})
    expect(Object.keys(handler).sort()).toEqual(['handle', 'maxBytes', 'perSecond'])
    expect(handler).toMatchObject({ maxBytes: FRONT_MAX_BYTES, perSecond: FRONT_PER_SECOND })
    expect([FRONT_MAX_BYTES, FRONT_PER_SECOND]).toEqual([64, 10])
    // Every message front takes fits its limit: the longest is 37 bytes.
    const longest = Math.max(...[...APP_IDS, FRONT_NONE].map((app) => Buffer.byteLength(JSON.stringify({ type: 'front', app }))))
    expect(longest).toBe(37)
    expect(longest).toBeLessThanOrEqual(FRONT_MAX_BYTES)
  })
})

describe('attach', () => {
  const gone = new AbortController().signal
  const ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const attachBody = (sessionId: unknown): string => JSON.stringify({ type: 'attach', sessionId })

  it('attach takes a UUID sessionId and hands it on', () => {
    const attached: string[] = []
    const handler = attachHandler((sessionId) => attached.push(sessionId))
    expect(handler.handle({ type: 'attach', sessionId: ID }, gone)).toBeUndefined()
    expect(attached).toEqual([ID])
  })

  // Claude Code's ids are lower case, and the agent's id is hashed from the string as given: an upper-case one names
  // no session.
  it('attach refuses an upper-case UUID', () => {
    const attach = vi.fn()
    expect(attachHandler(attach).handle({ type: 'attach', sessionId: ID.toUpperCase() }, gone)).toBe(REFUSED)
    expect(attach).not.toHaveBeenCalled()
  })

  it('attach refuses any other body', () => {
    const attach = vi.fn()
    const handler = attachHandler(attach)
    for (const sessionId of [undefined, 7, '', 'session-1', 'local_0f8fad5b-d9cb-469f', `${ID} `, `${ID}\n`, `${ID}0`, [ID], '__proto__']) {
      const message: Record<string, unknown> = sessionId === undefined ? { type: 'attach' } : { type: 'attach', sessionId }
      expect(handler.handle(message, gone), String(sessionId)).toBe(REFUSED)
    }
    expect(attach).not.toHaveBeenCalled()
  })

  it('the attach handler holds nothing: it is its two limits and handle', () => {
    const handler = attachHandler(() => {})
    expect(Object.keys(handler).sort()).toEqual(['handle', 'maxBytes', 'perSecond'])
    expect(handler).toMatchObject({ maxBytes: ATTACH_MAX_BYTES, perSecond: ATTACH_PER_SECOND })
    expect([ATTACH_MAX_BYTES, ATTACH_PER_SECOND]).toEqual([96, 10])
    expect(Buffer.byteLength(attachBody(ID))).toBe(68)
  })

  describe.skipIf(process.platform === 'win32')('on a real listener', () => {
    /** An attach of ID padded to exactly `bytes`. */
    function attachOf(bytes: number): string {
      const unpadded = Buffer.byteLength(JSON.stringify({ type: 'attach', sessionId: ID, pad: '' }))
      const body = JSON.stringify({ type: 'attach', sessionId: ID, pad: 'x'.repeat(bytes - unpadded) })
      expect(Buffer.byteLength(body)).toBe(bytes)
      return body
    }

    it('an attach of 97 bytes is 413 and the handler never runs', async () => {
      const attached: string[] = []
      const { path } = await open({ attach: attachHandler((sessionId) => attached.push(sessionId)) })
      expect((await connection(path).send(attachOf(ATTACH_MAX_BYTES))).status).toBe(204)
      expect((await connection(path).send(attachOf(ATTACH_MAX_BYTES + 1))).status).toBe(413)
      expect(attached).toEqual([ID])
    })

    it('the 11th attach within a second on one connection is 429', async () => {
      const attached: string[] = []
      const { path } = await open({ attach: attachHandler((sessionId) => attached.push(sessionId)) }, { now: () => 0 })
      const sender = connection(path)
      for (let i = 0; i < ATTACH_PER_SECOND; i++) expect((await sender.send(attachBody(ID))).status).toBe(204)
      expect((await sender.send(attachBody(ID))).status).toBe(429)
      expect(attached).toEqual(Array(10).fill(ID))
    })

    it('a refused attach is 400, counted in the minute line, and no line or answer holds the id', async () => {
      const attach = vi.fn()
      const { path, lines } = await open({ attach: attachHandler(attach) }, { now: () => 0 })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const sender = connection(path)
      const answers: string[] = []
      for (const sessionId of [`${ID}\n`, 'local_0f8fad5b-d9cb-469f']) {
        const { status, body } = await sender.send(attachBody(sessionId))
        expect(status).toBe(400)
        answers.push(body)
      }
      expect(attach).not.toHaveBeenCalled()
      expect(answers).toEqual(['', ''])
      vi.advanceTimersByTime(MINUTE)
      expect(lines).toEqual(['[devices] listener open', '[devices] listener in the last minute: 0 unknown, 0 oversized, 0 over rate, 2 refused, 0 failed'])
      for (const text of [...lines, ...answers]) expect(text).not.toMatch(/0f8fad5b/)
    })
  })
})

describe('tab', () => {
  const gone = new AbortController().signal

  it('tab takes each of the three apps with a tty, and hands on only app and tty', () => {
    const reported: Tab[] = []
    const handler = tabHandler((tab) => reported.push(tab))
    for (const app of TAB_APPS) {
      expect(handler.handle({ type: 'tab', app, tty: '/dev/ttys023', raise: true, title: 'x' }, gone), app).toBeUndefined()
    }
    expect(reported).toStrictEqual(TAB_APPS.map((app) => ({ app, tty: '/dev/ttys023' })))
  })

  it('tab refuses another app id, none and a bad tty', () => {
    const report = vi.fn()
    const handler = tabHandler(report)
    const bad: Record<string, unknown>[] = [
      { app: 'terminal', tty: '/dev/ttys023' }, { app: 'orca', tty: '/dev/ttys023' }, { app: FRONT_NONE, tty: '/dev/ttys023' },
      { app: 'Terminal', tty: '/dev/ttys023' }, { app: 'com.apple.Terminal', tty: '/dev/ttys023' }, { tty: '/dev/ttys023' },
      { app: 'terminal-app' }, { app: 'iterm', tty: '/dev/pts/3' }, { app: 'ghostty', tty: '/dev/ttys12345' }, { app: 'iterm', tty: 23 },
    ]
    for (const fields of bad) expect(handler.handle({ type: 'tab', ...fields }, gone), JSON.stringify(fields)).toBe(REFUSED)
    expect(report).not.toHaveBeenCalled()
  })

  it('the tab handler holds nothing: it is its two limits and handle; the longest tab fits', () => {
    const handler = tabHandler(() => {})
    expect(Object.keys(handler).sort()).toEqual(['handle', 'maxBytes', 'perSecond'])
    expect(handler).toMatchObject({ maxBytes: TAB_MAX_BYTES, perSecond: TAB_PER_SECOND })
    expect([TAB_MAX_BYTES, TAB_PER_SECOND]).toEqual([96, 10])
    const longest = Math.max(...TAB_APPS.map((app) => Buffer.byteLength(JSON.stringify({ type: 'tab', app, tty: '/dev/ttys9999' }))))
    expect(longest).toBe(57)
    expect(longest).toBeLessThanOrEqual(TAB_MAX_BYTES)
  })
})

describe('tabs', () => {
  it('the tabs stream is two a second on a connection, and its longest message, a standby false, fits', () => {
    const { handler } = tabsStream()
    expect(Object.keys(handler).sort()).toEqual(['maxBytes', 'open', 'perSecond'])
    expect(handler).toMatchObject({ maxBytes: TABS_MAX_BYTES, perSecond: TABS_PER_SECOND })
    expect([TABS_MAX_BYTES, TABS_PER_SECOND]).toEqual([32, 2])
    const longest = Buffer.byteLength('{"type":"tabs","standby":false}')
    expect(longest).toBe(31)
    expect(longest).toBeLessThanOrEqual(TABS_MAX_BYTES)
  })
})

describe('the dial stream', () => {
  const DIAL = '{"type":"dial","standby":true}'
  const UNPLUGGED = '{"attached":false}'
  const NO_AGENT = '{"attached":true,"agent":null}'
  const API = { name: 'api', app: 'Orca' }
  const API_LINE = '{"attached":true,"agent":{"name":"api","app":"Orca"}}'
  const OPEN = '[devices] dial stream · open'

  /** A dial stream, every line it logged, and each minute's timer it asked for, run by hand. */
  function dialed() {
    const logged: string[] = []
    const timers: Array<{ ms: number; run: () => void }> = []
    const dial = dialStream({ log: (line) => logged.push(line), after: (ms, run) => { timers.push({ ms, run }); return () => {} } })
    return { dial, logged, timers }
  }

  /** A stream of the test's own, as the listener hands one to open: it takes every line, and the test says when it is
   *  writable and when it ends. */
  function handMade() {
    const ended = new AbortController()
    const lines: unknown[] = []
    let run = (): void => {}
    const stream: ListenerStream = {
      write: (line) => { lines.push(line); return true },
      onWritable: (listener) => { run = listener },
      ended: ended.signal,
    }
    return { stream, lines, writable: () => run(), end: (reason: StreamEnd) => ended.abort(reason) }
  }

  const agentOf = (line: string): unknown => (JSON.parse(line) as { agent: { name: string } }).agent.name

  it('the dial handler is its two limits and open', () => {
    const { handler } = dialStream({ log: () => {}, after: () => () => {} })
    expect(Object.keys(handler).sort()).toEqual(['maxBytes', 'open', 'perSecond'])
    expect(handler).toMatchObject({ maxBytes: DIAL_MAX_BYTES, perSecond: DIAL_PER_SECOND })
    expect([DIAL_MAX_BYTES, DIAL_PER_SECOND, DIAL_NAME_MAX]).toEqual([64, 1, 64])
    expect(Buffer.byteLength(DIAL)).toBe(30)
  })

  it('after the stream ended, attached and shows write nothing and throw nothing; the next stream says the state they kept', () => {
    const { dial } = dialed()
    const ended = handMade()
    expect(dial.handler.open({ type: 'dial', standby: true }, ended.stream)).toBeUndefined()
    ended.writable()
    expect(ended.lines).toEqual([{ attached: false }])
    ended.end('gone')
    expect(() => { dial.attached(true); dial.shows(API) }).not.toThrow()
    expect(ended.lines).toEqual([{ attached: false }])

    const next = handMade()
    dial.handler.open({ type: 'dial', standby: true }, next.stream)
    next.writable()
    expect(next.lines.map((line) => JSON.stringify(line))).toEqual([API_LINE])
  })

  it('an older stream ending after a newer one opened leaves the newer one written to', () => {
    const { dial } = dialed()
    const older = handMade()
    const newer = handMade()
    dial.handler.open({ type: 'dial', standby: true }, older.stream)
    dial.handler.open({ type: 'dial', standby: true }, newer.stream)
    newer.writable()
    older.end('replaced')
    dial.attached(true)
    expect(newer.lines.map((line) => JSON.stringify(line))).toEqual([UNPLUGGED, NO_AGENT])
  })

  describe.skipIf(process.platform === 'win32')('on a real listener', () => {
    it('the first line is the state as the stream opens', async () => {
      const unplugged = dialed()
      const one = await open({ dial: unplugged.dial.handler })
      expect(await (await asked(one.path, DIAL)).got(1)).toEqual([UNPLUGGED])

      const plugged = dialed()
      plugged.dial.attached(true)
      const other = await open({ dial: plugged.dial.handler })
      expect(await (await asked(other.path, DIAL)).got(1)).toEqual([NO_AGENT])
    })

    it('a dial attaching and the agent it shows are a line each, byte for byte', async () => {
      const { dial } = dialed()
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      expect(client).toMatchObject({ status: 200, type: 'application/x-ndjson' })
      await client.got(1)
      dial.attached(true)
      await client.got(2)
      // The line's keys are in its own order, and hold only the name and the app, whatever else the caller hands on.
      dial.shows({ app: 'Orca', id: 'agent-5f3a', name: 'api' } as typeof API)
      expect(await client.got(3)).toEqual([UNPLUGGED, NO_AGENT, API_LINE])
    })

    it('a state that does not change writes nothing', async () => {
      const { dial } = dialed()
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      dial.attached(true)
      dial.attached(true)
      await client.got(2)
      dial.attached(true)
      dial.shows(API)
      await client.got(3)
      dial.shows({ ...API })
      dial.shows({ name: 'web', app: 'Harness' })
      expect(await client.got(4)).toEqual([UNPLUGGED, NO_AGENT, API_LINE, '{"attached":true,"agent":{"name":"web","app":"Harness"}}'])
    })

    it('a removal reaches the reader', async () => {
      const { dial } = dialed()
      dial.attached(true)
      dial.shows(API)
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      expect(await client.got(1)).toEqual([API_LINE])
      dial.shows(null)
      expect(await client.got(2)).toEqual([API_LINE, NO_AGENT])
      dial.attached(false)
      expect(await client.got(3)).toEqual([API_LINE, NO_AGENT, UNPLUGGED])
    })

    it('while detached an agent is not said', async () => {
      const { dial } = dialed()
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      dial.shows(API)
      dial.attached(true)
      expect(await client.got(2)).toEqual([UNPLUGGED, API_LINE])
    })

    it('ten changes in one turn of the loop are two lines, the first and the last', async () => {
      const { dial } = dialed()
      dial.attached(true)
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      for (let i = 1; i <= 10; i++) dial.shows({ name: `agent-${i}`, app: 'Orca' })
      const lines = await client.got(3)
      expect(lines.slice(1).map(agentOf)).toEqual(['agent-1', 'agent-10'])
    })

    it('a change back to the line last written, while it drains, writes nothing more', async () => {
      const { dial } = dialed()
      dial.attached(true)
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      dial.shows({ name: 'a', app: 'Orca' })
      dial.shows({ name: 'b', app: 'Orca' })
      dial.shows({ name: 'a', app: 'Orca' })
      await client.got(2)
      // The next line after a is the next change: a was not written twice, and b never.
      dial.shows({ name: 'c', app: 'Orca' })
      const lines = await client.got(3)
      expect(lines.slice(1).map(agentOf)).toEqual(['a', 'c'])
    })

    it('a name over 64 characters is cut to 64 code points, and a pair is not split', async () => {
      const { dial } = dialed()
      dial.attached(true)
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      const names: Array<[string, string]> = [
        ['😀'.repeat(70), '😀'.repeat(64)],
        [`${'a'.repeat(63)}😀b`, `${'a'.repeat(63)}😀`],
        ['x'.repeat(65), 'x'.repeat(64)],
        ['y'.repeat(64), 'y'.repeat(64)],
      ]
      for (const [i, [name, cut]] of names.entries()) {
        dial.shows({ name, app: 'Orca' })
        const line = (await client.got(i + 2)).at(-1)!
        expect(agentOf(line)).toBe(cut)
        expect(Buffer.byteLength(line)).toBeLessThan(400)
      }
    })

    it('a name of quotes, control characters or lone surrogates is one JSON line under 1 KiB', async () => {
      const { dial } = dialed()
      dial.attached(true)
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      for (const [i, name] of ['"'.repeat(64), '\u0000'.repeat(64), '\n'.repeat(64), '\ud800'.repeat(64)].entries()) {
        dial.shows({ name, app: 'Orca' })
        const lines = await client.got(i + 2)
        // A raw newline would have made it two.
        expect(lines).toHaveLength(i + 2)
        const line = lines.at(-1)!
        expect(JSON.parse(line)).toEqual({ attached: true, agent: { name, app: 'Orca' } })
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024)
      }
    })

    it('a second open is 409 while one is open, and the first is still written to; once it ends, the next open is a stream', async () => {
      const { dial } = dialed()
      const opened = vi.spyOn(dial.handler, 'open')
      const { path } = await open({ dial: dial.handler })
      const first = await asked(path, DIAL)
      await first.got(1)
      const second = await asked(path, DIAL)
      expect(second.status).toBe(409)
      await second.closed
      expect(second.lines()).toEqual([])
      expect(opened).toHaveBeenCalledOnce()
      dial.attached(true)
      expect(await first.got(2)).toEqual([UNPLUGGED, NO_AGENT])

      first.close()
      await endOf(opened.mock.calls[0]![1])
      const next = await asked(path, DIAL)
      expect(next.status).toBe(200)
      expect(await next.got(1)).toEqual([NO_AGENT])
    })

    it('an open with no standby, or standby false, is 400 and opens nothing', async () => {
      const { dial, logged } = dialed()
      const opened = vi.spyOn(dial.handler, 'open')
      const { path } = await open({ dial: dial.handler })
      expect(await once(path, '{"type":"dial"}')).toBe(400)
      expect(await once(path, '{"type":"dial","standby":false}')).toBe(400)
      expect(opened.mock.results.map(({ value }) => value)).toEqual([REFUSED, REFUSED])
      expect(logged).toEqual([])
      // Nothing holds the stream.
      const client = await asked(path, DIAL)
      expect(client.status).toBe(200)
      expect(await client.got(1)).toEqual([UNPLUGGED])
    })

    it('a 65-byte open is 413; while another connection holds the stream, a connection\'s first open is 409 and its second within a second is 429', async () => {
      /** A dial open padded to exactly `bytes`. */
      const dialOfBytes = (bytes: number): string => {
        const unpadded = Buffer.byteLength(JSON.stringify({ type: 'dial', standby: true, pad: '' }))
        const body = JSON.stringify({ type: 'dial', standby: true, pad: 'x'.repeat(bytes - unpadded) })
        expect(Buffer.byteLength(body)).toBe(bytes)
        return body
      }
      const { dial } = dialed()
      const { path } = await open({ dial: dial.handler }, { now: () => 0 })
      expect(await once(path, dialOfBytes(DIAL_MAX_BYTES + 1))).toBe(413)
      const holder = await asked(path, dialOfBytes(DIAL_MAX_BYTES))
      expect(holder.status).toBe(200)
      const sender = connection(path)
      expect((await sender.send(DIAL)).status).toBe(409)
      expect((await sender.send(DIAL)).status).toBe(429)
      expect(await holder.got(1)).toEqual([UNPLUGGED])
    })

    it('the stream opening and ending are a log line each', async () => {
      const { dial, logged } = dialed()
      const opened = vi.spyOn(dial.handler, 'open')
      const { path, listener } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      expect(logged).toEqual([OPEN])
      client.close()
      await endOf(opened.mock.calls[0]![1])
      expect(logged).toEqual([OPEN, '[devices] dial stream · ended · gone'])

      await asked(path, DIAL)
      await listener!.close()
      expect(logged.slice(2)).toEqual([OPEN, '[devices] dial stream · ended · closed'])

      // A line that does not drain: no name is long enough to stall a real one.
      const stalled = handMade()
      dial.handler.open({ type: 'dial', standby: true }, stalled.stream)
      stalled.end('stalled')
      expect(logged.slice(4)).toEqual([OPEN, '[devices] dial stream · ended · stalled'])
    })

    it('the lines written are counted once a minute, and a minute with none says nothing', async () => {
      const { dial, logged, timers } = dialed()
      const { path } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      expect(timers.map(({ ms }) => ms)).toEqual([60_000])
      // The agent waits behind the attach: its write that answered false is not a line.
      dial.attached(true)
      dial.shows(API)
      await client.got(3)
      expect(timers).toHaveLength(1)
      timers[0]!.run()
      expect(logged.at(-1)).toBe('[devices] dial stream · lines in the last minute: 3')
      // A minute with no line sets no timer, so it logs nothing.
      expect(timers).toHaveLength(1)

      dial.shows(null)
      await client.got(4)
      expect(timers.map(({ ms }) => ms)).toEqual([60_000, 60_000])
      timers[1]!.run()
      expect(logged.at(-1)).toBe('[devices] dial stream · lines in the last minute: 1')
    })

    it('no log line holds a name or an app', async () => {
      const { dial, logged, timers } = dialed()
      const opened = vi.spyOn(dial.handler, 'open')
      const { path, lines } = await open({ dial: dial.handler })
      const client = await asked(path, DIAL)
      await client.got(1)
      dial.attached(true)
      await client.got(2)
      dial.shows({ name: 'marker-5f3a', app: 'WezTerm' })
      await client.got(3)
      client.close()
      await endOf(opened.mock.calls[0]![1])
      for (const { run } of timers) run()
      expect(logged).toHaveLength(3)
      for (const text of [...logged, ...lines]) expect(text).not.toMatch(/marker-5f3a|WezTerm/)
    })
  })
})
