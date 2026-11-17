import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeOpencode, type FakeAnswer, type FakeOpencode, type FakeOpencodeOptions } from '../../testing/fakeOpencode.js'
import {
  createOpencodeClient, EVENT_TYPES, MAX_BODY_BYTES, MAX_SERVICE_BYTES, OPENCODE_MESSAGE, opencodeClientDeps, opencodeMessageId,
  opencodeServicePath, SILENCE_MS, type OpencodeClient, type OpencodeClientDeps, type OpencodeFault,
} from './opencodeClient.js'
import { RUN_TIMEOUT_MS } from './orca.js'

const CONNECTED = { type: 'server.connected', data: {} }
const UNAUTHORIZED: FakeAnswer = { status: 401, json: { _tag: 'UnauthorizedError', message: 'Unauthorized' } }
const NOT_FOUND: FakeAnswer = { status: 404, json: { _tag: 'SessionNotFoundError', sessionID: 'ses_a1', message: 'Session not found' } }
const ACTIVE = 'GET /api/session/active'
const POST = 'POST /api/session/ses_a1/prompt'

const made: FakeOpencode[] = []
const start = async (options?: FakeOpencodeOptions) => {
  const server = await fakeOpencode(options)
  made.push(server)
  return server
}
afterEach(async () => {
  vi.useRealTimers()
  for (const server of made.splice(0)) await server.stop()
})

const client = (server: FakeOpencode, over: Partial<OpencodeClientDeps> = {}) =>
  createOpencodeClient({ servicePath: server.servicePath, uid: process.getuid?.() ?? -1, platform: process.platform, ...over })
/** A client that has found the server. */
const found = async (server: FakeOpencode) => {
  const opencode = client(server)
  expect(await opencode.find()).toEqual({ stamp: expect.any(String) })
  return opencode
}
const routes = (server: FakeOpencode) => server.requests.map(({ method, path }) => `${method} ${path}`)
/** A round trip on a connection of its own: every byte the server wrote before it has come too. */
const fence = (opencode: OpencodeClient) => opencode.request('GET', '/api/info')
/** service.json by hand: the fake's own fields with these over them, undefined leaving one out. */
const write = (server: FakeOpencode, over: Record<string, unknown>) => {
  server.register()
  const fields: unknown = { ...JSON.parse(readFileSync(server.servicePath, 'utf8')) as object, ...over }
  writeFileSync(server.servicePath, JSON.stringify(fields), { mode: 0o600 })
}

/** An event stream's calls in order, each event as told and each close as `{ closed }`; `told(n)` once n have come. */
function stream(opencode: OpencodeClient) {
  const calls: unknown[] = []
  const waits = new Set<() => boolean>()
  const push = (call: unknown) => {
    calls.push(call)
    for (const done of waits) if (done()) waits.delete(done)
  }
  const handle = opencode.events((event) => push(event), (reason) => push({ closed: reason }))
  const told = (n: number) => new Promise<void>((resolve) => {
    const done = () => {
      if (calls.length < n) return false
      resolve()
      return true
    }
    if (!done()) waits.add(done)
  })
  return { calls, told, close: () => handle.close() }
}

describe('the opencode client (docs/plans/2026-11-17-dial-opencode-design.md)', () => {
  it('the file is $XDG_STATE_HOME/opencode/service.json, else ~/.local/state/opencode/service.json; a relative or empty XDG_STATE_HOME counts as unset', () => {
    const fallback = join('/home/me', '.local', 'state', 'opencode', 'service.json')
    expect(opencodeServicePath({ XDG_STATE_HOME: '/state' }, '/home/me')).toBe(join('/state', 'opencode', 'service.json'))
    expect(opencodeServicePath({}, '/home/me')).toBe(fallback)
    expect(opencodeServicePath({ XDG_STATE_HOME: '' }, '/home/me')).toBe(fallback)
    expect(opencodeServicePath({ XDG_STATE_HOME: 'state' }, '/home/me')).toBe(fallback)
    // The suite's home is a throwaway one, and its XDG_STATE_HOME is unset (vitest.setup.ts).
    expect(opencodeClientDeps()).toEqual({
      servicePath: join(homedir(), '.local', 'state', 'opencode', 'service.json'), uid: process.getuid?.() ?? -1, platform: process.platform,
    })
  })

  it('registration reads a usable file and sends nothing; its stamp is another when the id, the pid or the url is', async () => {
    const server = await start()
    const opencode = client(server)
    const first = opencode.registration()
    expect(first).toEqual({ stamp: expect.any(String) })
    expect(opencode.registration()).toEqual(first)
    // The stamp is the source's to hold and compare: the password is never in it.
    expect(JSON.stringify(first)).not.toContain('e2e-word')
    const stamps = [first]
    for (const over of [{ id: 'svc_other' }, { pid: process.pid + 1 }, { url: 'http://127.0.0.1:1' }]) {
      server.register(over)
      stamps.push(opencode.registration())
    }
    expect(new Set(stamps.map((stamp) => JSON.stringify(stamp))).size).toBe(4)
    expect(server.requests).toEqual([])
  })

  it('no file, a folder, a file over 4096 bytes, another user\'s file, bad JSON, half a file, no url, a pid of 0, 1.5 or "7", and a version, id or password that is no string are no_service', async () => {
    const server = await start()
    const opencode = client(server)
    const none = { fault: 'no_service' }

    rmSync(server.servicePath)
    expect(opencode.registration()).toEqual(none)
    expect(await opencode.find()).toEqual(none)
    mkdirSync(server.servicePath)
    expect(opencode.registration()).toEqual(none)
    rmSync(server.servicePath, { recursive: true })

    // 4096 bytes is the bound, and a file of it is read.
    server.register()
    const fields = JSON.parse(readFileSync(server.servicePath, 'utf8')) as Record<string, unknown>
    const padded = (extra: number) => {
      const pad = 'x'.repeat(MAX_SERVICE_BYTES - JSON.stringify({ ...fields, pad: '' }).length + extra)
      writeFileSync(server.servicePath, JSON.stringify({ ...fields, pad }), { mode: 0o600 })
    }
    padded(0)
    expect(opencode.registration()).toEqual({ stamp: expect.any(String) })
    padded(1)
    expect(opencode.registration()).toEqual(none)

    server.register()
    if (process.platform !== 'win32') expect(client(server, { uid: process.getuid!() + 1 }).registration()).toEqual(none)

    writeFileSync(server.servicePath, 'not json', { mode: 0o600 })
    expect(opencode.registration()).toEqual(none)
    server.register()
    const whole = readFileSync(server.servicePath, 'utf8')
    writeFileSync(server.servicePath, whole.slice(0, whole.length / 2), { mode: 0o600 })
    expect(opencode.registration()).toEqual(none)

    for (const over of [{ url: undefined }, { url: 7 }, { pid: 0 }, { pid: 1.5 }, { pid: '7' }, { pid: undefined }, { version: 2 }, { id: 5 }, { password: true }]) {
      write(server, over)
      expect(opencode.registration()).toEqual(none)
    }
    expect(server.requests).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('a symlink to a usable file is no_service', async () => {
    const server = await start()
    const usable = join(dirname(server.servicePath), 'usable.json')
    writeFileSync(usable, readFileSync(server.servicePath), { mode: 0o600 })
    rmSync(server.servicePath)
    symlinkSync(usable, server.servicePath)
    expect(client(server).registration()).toEqual({ fault: 'no_service' })
  })

  it('on Windows the owner is not checked', async () => {
    const server = await start()
    expect(client(server, { platform: 'win32', uid: -1 }).registration()).toEqual({ stamp: expect.any(String) })
  })

  it('a url off loopback is not_local, and nothing connects', async () => {
    const server = await start()
    const opencode = client(server)
    const port = new URL(server.url).port
    for (const url of [
      `https://127.0.0.1:${port}`, 'http://192.168.1.5:4096', 'http://example.com', 'http://127.0.0.1.example.com',
      `http://user:pw@127.0.0.1:${port}`, 'file:///x', 'not a url',
    ]) {
      server.register({ url })
      expect(opencode.registration()).toEqual({ fault: 'not_local' })
      expect(await opencode.find()).toEqual({ fault: 'not_local' })
    }
    expect(server.requests).toEqual([])
    for (const url of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      server.register({ url })
      expect(opencode.registration()).toEqual({ stamp: expect.any(String) })
    }
  })

  it('find asks /api/info with Basic opencode:<password>, and no header for a service with none', async () => {
    const server = await start()
    const opencode = client(server)
    const stamp = await opencode.find()
    expect(stamp).toEqual(opencode.registration())
    // The fake holds a request authorized only under 'Basic ' + base64('opencode:e2e-word').
    expect(await server.got('GET /api/info')).toMatchObject({ authorized: true })

    const open = await start({ password: null })
    expect(await client(open).find()).toEqual({ stamp: expect.any(String) })
    // A service with none: authorized only with no header at all.
    expect(await open.got('GET /api/info')).toMatchObject({ authorized: true })
  })

  it('a pid or a version that is not the file\'s is not_ours; a version of 1.18.33, one that is no version, and a 404 are old_version; a 401 is unauthorized; after each, request is no_service and the server saw /api/info alone', async () => {
    const server = await start()
    const opencode = client(server)
    const refused = async (fault: OpencodeFault) => {
      expect(await opencode.find()).toEqual({ fault })
      expect(await opencode.request('GET', '/api/session/active')).toEqual({ ok: false, fault: 'no_service' })
    }
    // Found first: a fault after leaves no service held.
    expect(await opencode.find()).toEqual({ stamp: expect.any(String) })
    server.register({ pid: process.pid + 1 })
    await refused('not_ours')
    server.register({ version: '2.3.1' })
    await refused('not_ours')
    server.register({ password: 'other' })
    await refused('unauthorized')
    server.register()
    server.answer('GET /api/info', { status: 404, json: { _tag: 'RouteNotFound', message: 'Not found' } })
    await refused('old_version')
    expect(new Set(routes(server))).toEqual(new Set(['GET /api/info']))

    // The version is checked against the file's only when the file has one.
    server.answer('GET /api/info')
    server.register({ version: null })
    expect(await opencode.find()).toEqual({ stamp: expect.any(String) })

    for (const version of ['1.18.33', 'dev']) {
      const old = await start({ version })
      const its = client(old)
      expect(await its.find()).toEqual({ fault: 'old_version' })
      expect(await its.request('GET', '/api/session/active')).toEqual({ ok: false, fault: 'no_service' })
      expect(routes(old)).toEqual(['GET /api/info'])
    }
  })

  it('only the latest find holds a service: an earlier one that answers after it holds nothing and is no_service', async () => {
    const server = await start()
    const opencode = client(server)
    const first = opencode.find()
    // Its answer is on its way when opencode's file goes, and the next find finds none.
    await server.got('GET /api/info')
    rmSync(server.servicePath)
    expect(await opencode.find()).toEqual({ fault: 'no_service' })
    expect(await first).toEqual({ fault: 'no_service' })
    expect(await opencode.request('GET', '/api/session/active')).toEqual({ ok: false, fault: 'no_service' })
    expect(routes(server)).toEqual(['GET /api/info'])
  })

  it('request answers the JSON; before any find it is no_service and nothing connects', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    server.start('ses_a1')
    const opencode = client(server)
    expect(await opencode.request('GET', '/api/session/active')).toEqual({ ok: false, fault: 'no_service' })
    expect(server.requests).toEqual([])

    expect(await opencode.find()).toEqual({ stamp: expect.any(String) })
    expect(await opencode.request('GET', '/api/session/active')).toEqual({ ok: true, json: { data: { ses_a1: { type: 'running' } } } })
    const words = { text: 'run the tests', id: opencodeMessageId(), delivery: 'queue' }
    expect(await opencode.request('POST', '/api/session/ses_a1/prompt', words)).toMatchObject({ ok: true, json: { data: { id: words.id } } })
    expect(server.requests.slice(1)).toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/session/active', authorized: true }),
      expect.objectContaining({ method: 'POST', path: '/api/session/ses_a1/prompt', authorized: true, body: words }),
    ])
  })

  it('401, 404, 409 and 500 are unauthorized, not_found, conflict and http_500; a redirect is http_302 and is not followed', async () => {
    const server = await start()
    const other = await start()
    const opencode = await found(server)
    const answers: Array<[FakeAnswer, OpencodeFault]> = [
      [UNAUTHORIZED, 'unauthorized'],
      [NOT_FOUND, 'not_found'],
      [{ status: 409, json: { _tag: 'ConflictError', message: 'Conflict' } }, 'conflict'],
      [{ status: 500, json: { message: 'no' } }, 'http_500'],
      [{ status: 302, headers: { location: `${other.url}/api/session/active` } }, 'http_302'],
    ]
    for (const [answer, fault] of answers) {
      server.answer(ACTIVE, answer)
      expect(await opencode.request('GET', '/api/session/active')).toEqual({ ok: false, fault })
    }
    expect(other.requests).toEqual([])
  })

  it('an answer over 1 MiB is oversize; one that is no JSON is bad_json; none in 10 s is timeout and its connection closes; nothing listening is refused', async () => {
    const server = await start()
    const opencode = await found(server)
    const active = () => opencode.request('GET', '/api/session/active')
    const most = 'x'.repeat(MAX_BODY_BYTES - 2)
    server.answer(ACTIVE, { raw: JSON.stringify(most) })
    expect(await active()).toEqual({ ok: true, json: most })
    server.answer(ACTIVE, { raw: JSON.stringify(`${most}x`) })
    expect(await active()).toEqual({ ok: false, fault: 'oversize' })
    for (const raw of ['not json', '']) {
      server.answer(ACTIVE, { raw })
      expect(await active()).toEqual({ ok: false, fault: 'bad_json' })
    }

    // The event route's answer starts and never ends: no whole answer.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let settled = false
    const endless = opencode.request('GET', '/api/event').finally(() => { settled = true })
    await server.stream(1)
    vi.advanceTimersByTime(RUN_TIMEOUT_MS - 1)
    await fence(opencode)
    expect(settled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await endless).toEqual({ ok: false, fault: 'timeout' })
    await vi.waitFor(() => expect(server.streams).toBe(0))

    await server.crash()
    expect(await active()).toEqual({ ok: false, fault: 'refused' })
  })

  it('a path http will not send is refused, sends nothing, and nothing throws at its deadline', async () => {
    const server = await start()
    const opencode = await found(server)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    expect(await opencode.request('GET', '/api/session/a b')).toEqual({ ok: false, fault: 'refused' })
    expect(() => vi.advanceTimersByTime(RUN_TIMEOUT_MS)).not.toThrow()
    expect(routes(server)).toEqual(['GET /api/info'])
  })

  it('events asks for each kind as a types key, and tells server.connected then each event once, in order', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const events = stream(opencode)
    await events.told(1)
    const asked = await server.got('GET /api/event')
    expect(asked.query.getAll('types')).toEqual([...EVENT_TYPES])
    expect(asked.authorized).toBe(true)

    server.start('ses_a1')
    const permission = server.ask('ses_a1')
    server.reply('ses_a1', permission)
    server.end('ses_a1', 'succeeded', 'All 12 tests pass.')
    server.event('session.renamed', { sessionID: 'ses_a1', title: 'Fix the login test' })
    await events.told(6)
    await fence(opencode)
    expect(events.calls).toEqual([
      CONNECTED,
      { type: 'session.execution.started', data: { sessionID: 'ses_a1' } },
      { type: 'permission.asked', data: { id: permission, sessionID: 'ses_a1', action: 'bash', resources: ['npm test'] } },
      { type: 'permission.replied', data: { sessionID: 'ses_a1', requestID: permission, reply: 'once' } },
      { type: 'session.execution.succeeded', data: { sessionID: 'ses_a1' } },
      { type: 'session.renamed', data: { sessionID: 'ses_a1', title: 'Fix the login test' } },
    ])
    events.close()
  })

  it('a frame split across chunks, two frames in one chunk, a comment, CRLF line ends and a data field of two lines are read as SSE reads them', async () => {
    const server = await start()
    const opencode = await found(server)
    const events = stream(opencode)
    await events.told(1)
    const idle = (sessionID: string) => ({ type: 'session.idle', data: { sessionID } })

    // Split inside a character of four bytes.
    const split = Buffer.from('data: {"type":"session.renamed","data":{"sessionID":"ses_a1","title":"Sửa lỗi 🎉"}}\n\n')
    const cut = split.indexOf(Buffer.from('🎉')) + 2
    server.send(split.subarray(0, cut))
    await fence(opencode)
    server.send(split.subarray(cut))
    server.send(`data: ${JSON.stringify(idle('ses_b1'))}\n\ndata: ${JSON.stringify(idle('ses_c1'))}\n\n`)
    server.send(': a comment\n\ndata: {"type":"session.idle",\n: a comment inside a frame\ndata: "data":{"sessionID":"ses_d1"}}\n\n')
    server.send(`data: ${JSON.stringify(idle('ses_e1'))}\r\n\r\n`)
    server.send('data: {"type":"session.renamed",\ndata: "data":{"sessionID":"ses_f1","title":"Two lines"}}\n\n')
    // Only data is read; a value with no space after its colon is whole; a data that is no object is {}.
    server.send('event: other\nid: 7\nretry: 1\ndata:{"type":"session.idle"}\n\n')
    server.send('data: {"type":"session.idle","data":[1]}\n\n')
    await events.told(9)
    expect(events.calls).toEqual([
      CONNECTED,
      { type: 'session.renamed', data: { sessionID: 'ses_a1', title: 'Sửa lỗi 🎉' } },
      idle('ses_b1'),
      idle('ses_c1'),
      idle('ses_d1'),
      idle('ses_e1'),
      { type: 'session.renamed', data: { sessionID: 'ses_f1', title: 'Two lines' } },
      { type: 'session.idle', data: {} },
      { type: 'session.idle', data: {} },
    ])
    events.close()
  })

  it('a kind it did not ask for is dropped', async () => {
    const server = await start()
    const opencode = await found(server)
    const events = stream(opencode)
    await events.told(1)
    server.send('data: {"type":"message.part.updated","data":{"sessionID":"ses_a1"}}\n\n')
    server.event('session.idle', { sessionID: 'ses_a1' })
    await events.told(2)
    await fence(opencode)
    expect(events.calls).toEqual([CONNECTED, { type: 'session.idle', data: { sessionID: 'ses_a1' } }])
    events.close()
  })

  it('a frame over 1 MiB closes oversize; one that is no JSON object with a type closes bad_json; the server ending closes ended: onClose once, and nothing after', async () => {
    const server = await start()
    const opencode = await found(server)
    // Each with an event behind it that is never told; the server's own end has nothing behind it.
    const ends: Array<[string | 'drop', OpencodeFault | 'ended']> = [
      // Closed as soon as it is past, with no end of the frame.
      [`data: "${'x'.repeat(MAX_BODY_BYTES)}`, 'oversize'],
      ['data: not json\n\n', 'bad_json'],
      ['data: [1]\n\n', 'bad_json'],
      ['data: "session.idle"\n\n', 'bad_json'],
      ['data: {"type":7}\n\n', 'bad_json'],
      ['drop', 'ended'],
    ]
    for (const [raw, reason] of ends) {
      const events = stream(opencode)
      await events.told(1)
      if (raw === 'drop') server.drop()
      else {
        server.send(raw)
        server.event('session.idle', { sessionID: 'ses_a1' })
      }
      await events.told(2)
      await vi.waitFor(() => expect(server.streams).toBe(0))
      await fence(opencode)
      expect(events.calls).toEqual([CONNECTED, { closed: reason }])
    }
  })

  it('no server.connected in 10 s closes timeout; 45 s with no byte closes timeout; a heartbeat every 15 s keeps it open', async () => {
    const server = await start()
    const opencode = await found(server)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    server.answer('GET /api/event', 'hold')
    const unanswered = stream(opencode)
    await server.got('GET /api/event')
    vi.advanceTimersByTime(RUN_TIMEOUT_MS - 1)
    expect(unanswered.calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(unanswered.calls).toEqual([{ closed: 'timeout' }])
    server.answer('GET /api/event')

    const silent = stream(opencode)
    await silent.told(1)
    // In one step the fake's heartbeats are written but none is read: 45 s with no byte.
    vi.advanceTimersByTime(SILENCE_MS - 1)
    expect(silent.calls).toEqual([CONNECTED])
    vi.advanceTimersByTime(1)
    expect(silent.calls).toEqual([CONNECTED, { closed: 'timeout' }])

    const kept = stream(opencode)
    await kept.told(1)
    for (let beat = 1; beat <= 4; beat++) {
      vi.advanceTimersByTime(15_000)
      await fence(opencode)
    }
    expect(kept.calls).toEqual([CONNECTED])
    kept.close()
  })

  it('a stream answered 401 closes unauthorized; nothing listening closes refused', async () => {
    const server = await start()
    const opencode = await found(server)
    server.answer('GET /api/event', UNAUTHORIZED)
    const unauthorized = stream(opencode)
    await unauthorized.told(1)
    expect(unauthorized.calls).toEqual([{ closed: 'unauthorized' }])

    server.answer('GET /api/event')
    await server.crash()
    const refused = stream(opencode)
    await refused.told(1)
    expect(refused.calls).toEqual([{ closed: 'refused' }])
  })

  it('close() ends the connection and calls nothing', async () => {
    const server = await start()
    const opencode = await found(server)
    const events = stream(opencode)
    await events.told(1)
    events.close()
    await vi.waitFor(() => expect(server.streams).toBe(0))
    await fence(opencode)
    expect(events.calls).toEqual([CONNECTED])

    // Closed before any answer.
    server.answer('GET /api/event', 'hold')
    const atOnce = stream(opencode)
    atOnce.close()
    await fence(opencode)
    expect(atOnce.calls).toEqual([])
  })

  it('with no service held, a stream closes no_service in a later turn and sends nothing', async () => {
    const server = await start()
    const events = stream(client(server))
    expect(events.calls).toEqual([])
    await events.told(1)
    expect(events.calls).toEqual([{ closed: 'no_service' }])
    expect(server.requests).toEqual([])
  })

  it('prompt reads the active sessions, then the pending permissions, then posts the words queued under the id', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const id = opencodeMessageId()
    expect(await opencode.prompt('ses_a1', 'run the tests', id)).toBe('sent')
    expect(routes(server)).toEqual(['GET /api/info', ACTIVE, 'GET /api/session/ses_a1/permission', POST])
    expect(server.requests.every(({ authorized }) => authorized)).toBe(true)
    expect((await server.got(POST)).body).toEqual({ text: 'run the tests', id, delivery: 'queue' })
  })

  it('a prompt posts to the service it read: a find in the middle of it moves none of its steps', async () => {
    const other = await start()
    other.session({ id: 'ses_a1' })
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const sent = opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())
    // Its first read's answer is on its way when the file names another service.
    await server.got(ACTIVE)
    server.register({ url: other.url })
    const moved = opencode.find()
    expect(await sent).toBe('sent')
    expect(await moved).toEqual({ stamp: expect.any(String) })
    expect(routes(server)).toEqual(['GET /api/info', ACTIVE, 'GET /api/session/ses_a1/permission', POST])
    expect(routes(other)).toEqual(['GET /api/info'])
  })

  it('a running session is busy and a pending permission is waiting: nothing is posted', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    server.session({ id: 'ses_b1' })
    const opencode = await found(server)
    server.start('ses_a1')
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('busy')
    server.end('ses_a1', 'succeeded')
    const asked = server.ask('ses_a1')
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('waiting')
    expect(routes(server).filter((route) => route.startsWith('POST'))).toEqual([])
    // Another session's turn and its permission are not this one's.
    server.reply('ses_a1', asked)
    server.start('ses_b1')
    server.ask('ses_b1')
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('sent')
  })

  it('a 409 is sent; a 404 at any of the three steps is gone; a 500 is failed', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const id = opencodeMessageId()
    expect(await opencode.prompt('ses_a1', 'run the tests', id)).toBe('sent')
    expect(await opencode.prompt('ses_a1', 'run the tests', id)).toBe('sent')
    expect(routes(server).filter((route) => route === POST)).toHaveLength(2)

    server.answer(ACTIVE, NOT_FOUND)
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('gone')
    server.answer(ACTIVE)
    expect(await opencode.prompt('ses_x1', 'run the tests', opencodeMessageId())).toBe('gone')
    server.answer(POST, NOT_FOUND)
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('gone')
    server.answer(POST, { status: 500, json: { message: 'no' } })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')
  })

  it('an answer of another shape at either read is failed, and nothing is posted', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    server.answer(ACTIVE, { status: 200, json: { data: [] } })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')
    server.answer(ACTIVE)
    server.answer('GET /api/session/ses_a1/permission', { status: 200, json: { data: {} } })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')
    expect(routes(server).filter((route) => route === POST)).toEqual([])
  })

  it('a post with no answer is posted once more under the same id: a 409 then is sent, a 200 is sent, a second loss is failed; a 500 is not posted again', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const posts = () => server.requests.filter(({ method }) => method === 'POST')
    const words = (id: string) => ({ text: 'run the tests', id, delivery: 'queue' })

    // The connection drops; the second post finds the first one's record.
    let id = opencodeMessageId()
    server.answer(POST, 'close')
    let sent = opencode.prompt('ses_a1', 'run the tests', id)
    await server.got(POST, 1)
    server.answer(POST, { status: 409, json: { _tag: 'ConflictError', message: 'Prompt message ID conflicts with an existing durable record' } })
    expect(await sent).toBe('sent')
    expect(posts().map(({ body }) => body)).toEqual([words(id), words(id)])

    // No answer in 10 s.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    id = opencodeMessageId()
    server.answer(POST, 'hold')
    sent = opencode.prompt('ses_a1', 'run the tests', id)
    await server.got(POST, 3)
    server.answer(POST)
    vi.advanceTimersByTime(RUN_TIMEOUT_MS)
    expect(await sent).toBe('sent')
    expect(posts().slice(2).map(({ body }) => body)).toEqual([words(id), words(id)])
    vi.useRealTimers()

    server.answer(POST, 'close')
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')
    expect(posts()).toHaveLength(6)
    server.answer(POST, { status: 500, json: { message: 'no' } })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')
    expect(posts()).toHaveLength(7)
  })

  it('a 2xx to the post is sent and never posted again, its body whole JSON or not', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const posts = () => routes(server).filter((route) => route === POST)
    server.answer(POST, { raw: 'ok' })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('sent')
    expect(posts()).toHaveLength(1)

    // Its status has come, and its connection closes before the body's end.
    server.answer(POST, { status: 200, headers: { 'content-length': '100' }, json: {} })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('sent')
    expect(posts()).toHaveLength(2)
  })

  it('control characters become spaces', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    expect(await opencode.prompt('ses_a1', 'fix it\nrm -rf /\u001b[2J', opencodeMessageId())).toBe('sent')
    expect((await server.got(POST)).body).toMatchObject({ text: 'fix it rm -rf / [2J' })
  })

  it('an empty text, one blank once its control characters are spaces, one of 2001 characters, a session id or a message id not in its form: failed, and nothing connects', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    const id = opencodeMessageId()
    for (const [session, text, message] of [
      ['ses_a1', '', id], ['ses_a1', '\n\t', id], ['ses_a1', 'x'.repeat(2001), id],
      ['ses', 'run the tests', id], ['ses_a1/../x', 'run the tests', id], ['ses_a1?x=1', 'run the tests', id],
      ['ses_a1', 'run the tests', 'msg_1'],
    ]) {
      expect(await opencode.prompt(session, text, message)).toBe('failed')
    }
    expect(routes(server)).toEqual(['GET /api/info'])
    expect(await opencode.prompt('ses_a1', 'x'.repeat(2000), id)).toBe('sent')
  })

  it('opencodeMessageId is msg_, 12 hex characters of the time and 14 of [0-9A-Za-z]; two made in one millisecond differ and the second sorts after the first', () => {
    const now = 1_790_000_000_000
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const first = opencodeMessageId()
    const second = opencodeMessageId()
    expect(first).toMatch(OPENCODE_MESSAGE)
    expect(second).toMatch(OPENCODE_MESSAGE)
    // opencode's own form: the time in ms × 4096 and a counter, its low 48 bits.
    expect(BigInt(`0x${first.slice(4, 16)}`) >> 12n).toBe(BigInt(now) & 0xf_ffff_ffffn)
    expect(second).not.toBe(first)
    expect(second > first).toBe(true)
    vi.setSystemTime(now + 1)
    expect(opencodeMessageId() > second).toBe(true)
  })

  it('no member throws: a file removed between two calls, a server that resets in the middle of an answer', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const opencode = await found(server)
    rmSync(server.servicePath)
    expect(opencode.registration()).toEqual({ fault: 'no_service' })
    expect(await opencode.find()).toEqual({ fault: 'no_service' })
    expect(await opencode.prompt('ses_a1', 'run the tests', opencodeMessageId())).toBe('failed')

    server.register()
    expect(await opencode.find()).toEqual({ stamp: expect.any(String) })
    const events = stream(opencode)
    await events.told(1)
    // The event route's answer has begun when the server goes.
    const answer = opencode.request('GET', '/api/event')
    await server.stream(2)
    await server.crash()
    expect(await answer).toEqual({ ok: false, fault: 'refused' })
    await events.told(2)
    expect(events.calls).toEqual([CONNECTED, { closed: 'ended' }])
  })
})
