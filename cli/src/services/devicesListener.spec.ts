import { Agent, request } from 'node:http'
import { connect, type Socket } from 'node:net'
import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_IDS } from '../cable/hosts/hostDetect.js'
import { FRONT_NONE } from '../cable/hosts/frontApp.js'
import { listenLocalSocket } from '../lib/localSocket.js'
import {
  FRONT_MAX_BYTES, FRONT_PER_SECOND, frontHandler, LISTENER_DROPPED_PER_SECOND, LISTENER_MAX_CONNECTIONS, openDevicesListener, REFUSED, type DevicesListener,
  type ListenerHandler,
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
async function open(handlers: Record<string, ListenerHandler>, options: { path?: string; now?: () => number } = {}) {
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
      expect(vi.getTimerCount()).toBe(1)
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
    expect(fronts).toHaveLength(16)
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
