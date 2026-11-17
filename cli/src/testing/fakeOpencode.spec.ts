import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeOpencode, type FakeOpencode, type FakeOpencodeOptions } from './fakeOpencode.js'

const AUTH = { authorization: `Basic ${Buffer.from('opencode:e2e-word').toString('base64')}` }

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

const get = (server: FakeOpencode, path: string) => fetch(`${server.url}${path}`, { headers: AUTH })
const post = (server: FakeOpencode, path: string, body: unknown) =>
  fetch(`${server.url}${path}`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const json = async (response: Response) => ({ status: response.status, body: await response.json() as unknown })

/** A stream's frames, one at a time as SSE ends them; undefined once it has ended. */
const frames = (response: Response) => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let held = ''
  return async (): Promise<string | undefined> => {
    for (;;) {
      const end = held.indexOf('\n\n')
      if (end !== -1) {
        const frame = held.slice(0, end)
        held = held.slice(end + 2)
        return frame
      }
      const { value, done } = await reader.read()
      if (done) return undefined
      held += value
    }
  }
}
const told = (frame: string | undefined) => JSON.parse(frame!.replace(/^data: /, '')) as Record<string, unknown>

const listen = async (server: FakeOpencode, types: string[]) => {
  const query = types.map((type) => `types=${encodeURIComponent(type)}`).join('&')
  const next = frames(await get(server, `/api/event?${query}`))
  expect(told(await next())).toEqual({ id: expect.stringMatching(/^evt_/), type: 'server.connected', data: {} })
  return next
}

describe('fakeOpencode', () => {
  it('registers itself: a whole service.json of mode 0600 with its url, pid, version, id and password', async () => {
    const server = await start()
    expect(server.servicePath).toBe(join(server.stateDir, 'opencode', 'service.json'))
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(JSON.parse(readFileSync(server.servicePath, 'utf8'))).toEqual({
      id: expect.stringMatching(/^svc_/), version: '2.3.0', url: server.url, pid: process.pid, password: 'e2e-word',
    })
    expect(readdirSync(dirname(server.servicePath))).toEqual(['service.json'])
    if (process.platform !== 'win32') {
      expect(statSync(server.servicePath).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(server.servicePath)).mode & 0o777).toBe(0o700)
    }
    server.register({ pid: 7, password: null })
    expect(JSON.parse(readFileSync(server.servicePath, 'utf8'))).toEqual({
      id: expect.stringMatching(/^svc_/), version: '2.3.0', url: server.url, pid: 7,
    })
  })

  it('/api/info answers the file\'s pid and version; a wrong or missing password is 401, and none is asked of a service with none', async () => {
    const server = await start()
    expect(await json(await get(server, '/api/info'))).toEqual({
      status: 200, body: { version: '2.3.0', pid: process.pid, urls: [server.url], paths: { tmp: '/tmp/opencode' } },
    })
    const unauthorized = { status: 401, body: { _tag: 'UnauthorizedError', message: 'Unauthorized' } }
    expect(await json(await fetch(`${server.url}/api/info`))).toEqual(unauthorized)
    const wrong = `Basic ${Buffer.from('opencode:other').toString('base64')}`
    expect(await json(await fetch(`${server.url}/api/info`, { headers: { authorization: wrong } }))).toEqual(unauthorized)
    expect(server.requests.map(({ authorized }) => authorized)).toEqual([true, false, false])

    const open = await start({ password: null, version: '2.4.1' })
    expect(JSON.parse(readFileSync(open.servicePath, 'utf8'))).not.toHaveProperty('password')
    expect(await json(await fetch(`${open.url}/api/info`))).toMatchObject({ status: 200, body: { version: '2.4.1' } })
    expect((await open.got('GET /api/info')).authorized).toBe(true)
  })

  it('the list keeps roots, drops archived ones, orders by the newest and holds to its limit', async () => {
    const server = await start()
    server.session({ id: 'ses_a1', title: 'Fix the login test', directory: '/work/api', updated: 3000, idle: 2500, viewed: 2000 })
    server.session({ id: 'ses_b1', updated: 1000 })
    server.session({ id: 'ses_c1', parentID: 'ses_a1', updated: 4000 })
    server.session({ id: 'ses_d1', updated: 5000, archived: 5000 })
    server.session({ id: 'ses_e1', updated: 2000 })
    const { status, body } = await json(await get(server, '/api/session?parentID=null&archived=false&order=desc&limit=2'))
    expect(status).toBe(200)
    expect(body).toEqual({
      data: [
        {
          id: 'ses_a1', projectID: 'prj_1', cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 3000, updated: 3000, idle: 2500, viewed: 2000 },
          title: 'Fix the login test', location: { directory: '/work/api' },
        },
        expect.objectContaining({ id: 'ses_e1', location: { directory: '/work' } }),
      ],
      cursor: {},
    })
    const ids = async (query: string) =>
      ((await (await get(server, `/api/session?${query}`)).json()) as { data: Array<{ id: string }> }).data.map(({ id }) => id)
    expect(await ids('parentID=null&archived=false&order=asc')).toEqual(['ses_b1', 'ses_e1', 'ses_a1'])
    expect(await ids('archived=true')).toEqual(['ses_d1'])
    expect(await ids('parentID=ses_a1')).toEqual(['ses_c1'])
    expect(await ids('')).toEqual(['ses_d1', 'ses_c1', 'ses_a1', 'ses_e1', 'ses_b1'])
  })

  it('a turn started is active and told; ended, it is not, its time.idle moved and its answer is the last assistant text', async () => {
    const server = await start()
    server.session({ id: 'ses_a1', updated: 1000, idle: 1000, answer: 'Earlier.' })
    const next = await listen(server, ['session.execution.started', 'session.execution.succeeded',
      'session.execution.failed', 'session.execution.interrupted'])
    const active = async () => (await json(await get(server, '/api/session/active'))).body
    const answer = async () => (await json(await get(server, '/api/session/ses_a1/message?type=assistant&order=desc&limit=1'))).body

    server.start('ses_a1')
    expect(told(await next())).toEqual({
      id: expect.stringMatching(/^evt_/), created: expect.any(Number), type: 'session.execution.started', data: { sessionID: 'ses_a1' },
    })
    expect(await active()).toEqual({ data: { ses_a1: { type: 'running' } } })

    const before = Date.now()
    server.end('ses_a1', 'succeeded', 'All 12 tests pass.')
    expect(told(await next())).toMatchObject({ type: 'session.execution.succeeded', data: { sessionID: 'ses_a1' } })
    expect(await active()).toEqual({ data: {} })
    const listed = (await json(await get(server, '/api/session'))).body as { data: Array<{ time: { idle: number } }> }
    expect(listed.data[0].time.idle).toBeGreaterThanOrEqual(before)
    expect(await answer()).toEqual({
      data: [{
        id: expect.stringMatching(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/), type: 'assistant', time: { created: listed.data[0].time.idle },
        agent: 'build', model: { id: 'm', providerID: 'p' },
        content: [{ type: 'reasoning', text: 'Thinking it over.' }, { type: 'text', text: 'All 12 tests pass.' }],
      }],
      cursor: {},
    })

    server.start('ses_a1')
    server.end('ses_a1', 'interrupted')
    server.end('ses_a1', 'failed')
    await next()
    expect(told(await next())).toMatchObject({ type: 'session.execution.interrupted', data: { sessionID: 'ses_a1', reason: 'user' } })
    expect(told(await next())).toMatchObject({
      type: 'session.execution.failed', data: { sessionID: 'ses_a1', error: { type: 'unknown', message: 'The turn failed.' } },
    })
    expect((await answer() as { data: Array<{ content: unknown[] }> }).data[0].content[1]).toEqual({ type: 'text', text: 'All 12 tests pass.' })

    server.session({ id: 'ses_b1' })
    expect(await json(await get(server, '/api/session/ses_b1/message?type=assistant&order=desc&limit=1'))).toEqual({
      status: 200, body: { data: [], cursor: {} },
    })
  })

  it('a permission asked is pending and told; replied, it is gone and told', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const next = await listen(server, ['permission.asked', 'permission.replied'])
    const pending = async () => (await json(await get(server, '/api/session/ses_a1/permission'))).body

    const id = server.ask('ses_a1')
    expect(id).toMatch(/^per[A-Za-z0-9_-]{1,96}$/)
    const permission = { id, sessionID: 'ses_a1', action: 'bash', resources: ['npm test'] }
    expect(told(await next())).toMatchObject({ type: 'permission.asked', data: permission })
    expect(await pending()).toEqual({ data: [permission] })

    server.reply('ses_a1', id)
    expect(told(await next())).toMatchObject({ type: 'permission.replied', data: { sessionID: 'ses_a1', requestID: id, reply: 'once' } })
    expect(await pending()).toEqual({ data: [] })
  })

  it('a prompt is recorded with its body; the same id again is 409; an unknown session is 404', async () => {
    const server = await start()
    server.session({ id: 'ses_a1' })
    const words = { text: 'run the tests', id: 'msg_000000000001AAAAAAAAAAAAAA', delivery: 'queue' }
    expect(await json(await post(server, '/api/session/ses_a1/prompt', words))).toEqual({
      status: 200,
      body: { data: {
        id: words.id, sessionID: 'ses_a1', time: { created: expect.any(Number) }, type: 'user', payload: { text: 'run the tests' }, delivery: 'queue',
      } },
    })
    expect((await server.got('POST /api/session/ses_a1/prompt')).body).toEqual(words)
    expect(await json(await post(server, '/api/session/ses_a1/prompt', words))).toEqual({
      status: 409, body: { _tag: 'ConflictError', message: 'Prompt message ID conflicts with an existing durable record' },
    })
    expect((await json(await get(server, '/api/session/active'))).body).toEqual({ data: {} })

    const gone = { status: 404, body: { _tag: 'SessionNotFoundError', sessionID: 'ses_x', message: 'Session not found' } }
    expect(await json(await post(server, '/api/session/ses_x/prompt', words))).toEqual(gone)
    expect(await json(await get(server, '/api/session/ses_x/permission'))).toEqual(gone)
    expect(await json(await get(server, '/api/session/ses_x/message'))).toEqual(gone)
  })

  it('a stream starts with server.connected, and hears only the kinds it asked for', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const server = await start()
    const next = await listen(server, ['session.execution.started', 'session.renamed'])
    await server.stream(1)
    expect(server.streams).toBe(1)
    const request = await server.got('GET /api/event')
    expect(request.query.getAll('types')).toEqual(['session.execution.started', 'session.renamed'])

    server.event('session.idle', { sessionID: 'ses_a1' })
    server.event('session.renamed', { sessionID: 'ses_a1', title: 'Fix the login test' })
    expect(told(await next())).toMatchObject({ type: 'session.renamed', data: { sessionID: 'ses_a1', title: 'Fix the login test' } })

    server.heartbeat()
    expect(await next()).toBe(': heartbeat')
    vi.advanceTimersByTime(15_000)
    expect(await next()).toBe(': heartbeat')
    server.send('data: {"type":"other"}\n\n')
    expect(await next()).toBe('data: {"type":"other"}')

    server.drop()
    expect(await next()).toBeUndefined()
    const again = await listen(server, [])
    await server.stream(2)
    server.event('session.idle', { sessionID: 'ses_a1' })
    expect(told(await again())).toMatchObject({ type: 'session.idle' })
  })

  it('answer sets a route\'s status, its bytes, a held connection and a closed one', async () => {
    const server = await start()
    server.answer('GET /api/info', { status: 302, headers: { location: 'http://127.0.0.1:1/api/info' } })
    const moved = await fetch(`${server.url}/api/info`, { headers: AUTH, redirect: 'manual' })
    expect([moved.status, moved.headers.get('location')]).toEqual([302, 'http://127.0.0.1:1/api/info'])
    server.answer('GET /api/info', { status: 500, json: { message: 'no' } })
    expect(await json(await get(server, '/api/info'))).toEqual({ status: 500, body: { message: 'no' } })
    server.answer('GET /api/info', { raw: 'not json' })
    expect(await (await get(server, '/api/info')).text()).toBe('not json')

    server.answer('GET /api/session/active', 'hold')
    let settled = false
    const held = get(server, '/api/session/active').finally(() => { settled = true })
    await server.got('GET /api/session/active')
    server.answer('GET /api/info')
    expect((await get(server, '/api/info')).status).toBe(200)
    expect(settled).toBe(false)

    server.answer('GET /api/session', 'close')
    await expect(get(server, '/api/session')).rejects.toThrow()
    server.answer('GET /api/event', { status: 401, json: { _tag: 'UnauthorizedError', message: 'Unauthorized' } })
    expect((await get(server, '/api/event')).status).toBe(401)
    expect(server.streams).toBe(0)

    await server.crash()
    await expect(held).rejects.toThrow()
  })

  it('stop removes service.json; crash leaves it with nothing listening; restart listens on another port under another id', async () => {
    const stopped = await start()
    await stopped.stop()
    expect(readdirSync(dirname(stopped.servicePath))).toEqual([])
    await expect(get(stopped, '/api/info')).rejects.toThrow()

    const server = await start()
    server.session({ id: 'ses_a1' })
    const before = { url: server.url, file: readFileSync(server.servicePath, 'utf8') }
    await server.crash()
    expect(readFileSync(server.servicePath, 'utf8')).toBe(before.file)
    await expect(fetch(`${before.url}/api/info`, { headers: AUTH })).rejects.toThrow()

    await server.restart()
    expect(server.url).not.toBe(before.url)
    const file = JSON.parse(readFileSync(server.servicePath, 'utf8')) as { id: string; url: string }
    expect(file.url).toBe(server.url)
    expect(file.id).not.toBe((JSON.parse(before.file) as { id: string }).id)
    expect((await get(server, '/api/info')).status).toBe(200)
    expect((await json(await get(server, '/api/session'))).body).toMatchObject({ data: [{ id: 'ses_a1' }] })
  })
})
