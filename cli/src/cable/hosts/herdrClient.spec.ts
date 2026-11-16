import { watch } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHerdr, RECORDED, type FakeHerdr } from '../../testing/fakeHerdr.js'
import {
  createHerdrClient, herdrClientDeps, herdrSocketPath, MAX_LINE_BYTES, watchHerdrSocket,
  type HerdrClientDeps, type HerdrEntry, type HerdrSubscriber,
} from './herdrClient.js'

const ENTRIES: HerdrEntry[] = [{ type: 'pane.agent_detected' }, { type: 'pane.closed' }, { type: 'pane.exited' }]

const agent = (pane: string, kind: string, status: string) => ({ pane_id: pane, agent: kind, agent_status: status, cwd: '/work/hh' })
const lines = (recorded: string[]) => `${recorded.join('\n')}\n`
const refusal = (code: string) => ({ line: { error: { code, message: code } } })
/** Lets what the socket has already said be told, with the timers faked or not. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** A subscriber that records each call, and `told(n)` once n have come. */
function subscriber() {
  const calls: unknown[][] = []
  const waits: Array<{ n: number; resolve(): void }> = []
  const push = (call: unknown[]) => {
    calls.push(call)
    for (const wait of waits.filter(({ n }) => calls.length >= n)) wait.resolve()
  }
  const to: HerdrSubscriber = {
    started: () => push(['started']),
    event: (name, data) => push(['event', name, data]),
    closed: (reason) => push(['closed', reason]),
  }
  const told = (n: number) => new Promise<void>((resolve) => {
    if (calls.length >= n) resolve()
    else waits.push({ n, resolve })
  })
  return { calls, to, told }
}

/** Makes a change once every watch started so far is live, then waits until `count` grows. On macOS fs.watch starts its
 *  stream on another thread, one stream for every folder the process watches (libuv's FSEvents), so a change made at
 *  once can go untold: a watch started after, once it has told of a change of its own, says the stream holds the rest. */
async function toldOf(count: () => number, change: () => Promise<unknown>): Promise<void> {
  const folder = await mkdtemp(join(tmpdir(), 'ws-'))
  let live = false
  const sentinel = watch(folder, () => { live = true })
  try {
    let n = 0
    await vi.waitFor(async () => {
      await mkdir(join(folder, String(n++)))
      expect(live).toBe(true)
    }, { timeout: 10_000 })
    const before = count()
    await change()
    await vi.waitFor(() => expect(count()).toBeGreaterThan(before), { timeout: 10_000 })
  } finally {
    sentinel.close()
  }
}

describe.skipIf(process.platform === 'win32')('the herdr client (docs/specs/2026-11-16-device-herdr.md)', () => {
  let server: FakeHerdr
  const client = (over: Partial<HerdrClientDeps> = {}) =>
    createHerdrClient({ socketPath: server.path, home: dirname(server.path), uid: process.getuid!(), platform: process.platform, ...over })

  beforeEach(async () => { server = await fakeHerdr() })
  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('the socket is $XDG_CONFIG_HOME/herdr/herdr.sock, else ~/.config/herdr/herdr.sock; a relative XDG_CONFIG_HOME counts as unset', () => {
    expect(herdrSocketPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/me')).toBe('/cfg/herdr/herdr.sock')
    expect(herdrSocketPath({}, '/home/me')).toBe('/home/me/.config/herdr/herdr.sock')
    expect(herdrSocketPath({ XDG_CONFIG_HOME: '' }, '/home/me')).toBe('/home/me/.config/herdr/herdr.sock')
    expect(herdrSocketPath({ XDG_CONFIG_HOME: 'cfg' }, '/home/me')).toBe('/home/me/.config/herdr/herdr.sock')
    // The suite's home is a throwaway one, and its XDG_CONFIG_HOME is unset (vitest.setup.ts).
    expect(herdrClientDeps()).toEqual({
      socketPath: join(homedir(), '.config', 'herdr', 'herdr.sock'), home: homedir(), uid: process.getuid!(), platform: process.platform,
    })
  })

  it('request writes one line and answers the result', async () => {
    expect(await client().request('agent.list', {})).toEqual({ ok: true, result: { type: 'agent_list', agents: [] } })
    expect(server.requests).toEqual([{ connection: 1, request: { id: expect.any(String), method: 'agent.list', params: {} } }])
  })

  it('each request is a connection of its own', async () => {
    const herdr = client()
    await herdr.request('agent.list', {})
    await herdr.request('agent.list', {})
    expect(server.requests.map(({ connection }) => connection)).toEqual([1, 2])
    const [first, second] = server.requests.map(({ request }) => (request as { id: string }).id)
    expect(first).not.toBe(second)
    await server.ended(1)
    await server.ended(2)
  })

  it('an error answers its code, under its own id or ""; a code not in herdr\'s form is bad_answer', async () => {
    const herdr = client()
    expect(await herdr.request('agent.get', { target: 'w1:p1' })).toEqual({ ok: false, code: 'agent_not_found' })
    server.answer('agent.list', { line: { id: '', error: { code: 'invalid_request', message: 'invalid request' } } })
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, code: 'invalid_request' })
    server.answer('agent.list', refusal('Bad Code!'))
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, code: 'bad_answer' })
  })

  it('an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 1 MiB is oversize', async () => {
    const herdr = client()
    for (const [answer, code] of [
      [{ line: { id: 'another', result: { type: 'agent_list', agents: [] } } }, 'bad_answer'],
      [{ line: { id: 'another', error: { code: 'agent_not_found', message: '' } } }, 'bad_answer'],
      [{ line: {} }, 'bad_answer'],
      [{ line: { result: 'agent_list' } }, 'bad_answer'],
      [{ raw: 'not json\n' }, 'bad_json'],
      [{ raw: '[]\n' }, 'bad_json'],
      [{ raw: `{"pad":"${'x'.repeat(MAX_LINE_BYTES)}"}\n` }, 'oversize'],
    ] as const) {
      server.answer('agent.list', answer)
      expect(await herdr.request('agent.list', {}), JSON.stringify(answer).slice(0, 80)).toEqual({ ok: false, code })
    }
  })

  it('no socket, a file that is no socket, and another user\'s socket are no_socket, and nothing connects', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    for (const herdr of [
      client({ socketPath: join(dirname(server.path), 'none.sock') }),
      client({ socketPath: file }),
      client({ uid: process.getuid!() + 1 }),
      // herdr's socket there is a named pipe, which this client does not speak.
      client({ platform: 'win32' }),
    ]) {
      expect(await herdr.request('agent.list', {})).toEqual({ ok: false, code: 'no_socket' })
      expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', code: 'no_socket' })
      const { calls, to, told } = subscriber()
      herdr.subscribe(ENTRIES, to)
      await told(1)
      expect(calls).toEqual([['closed', 'no_socket']])
    }
    expect(server.connections).toBe(0)
  })

  it('a stale socket is refused; a connection that ends before its answer is ended; none in 10 s is timeout, and its connection closes', async () => {
    const herdr = client()
    server.answer('agent.list', 'close')
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, code: 'ended' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('agent.list', 'hold')
    let answered = false
    const answer = herdr.request('agent.list', {}).finally(() => { answered = true })
    await server.got('agent.list', 2)
    vi.advanceTimersByTime(9_999)
    await turn()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await answer).toEqual({ ok: false, code: 'timeout' })
    await server.ended(2)
    vi.useRealTimers()

    await server.stale()
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, code: 'refused' })
  })

  it('subscribe writes one line, calls started, then each event with its name and data', async () => {
    const replay = subscriber()
    server.answer('events.subscribe', { raw: lines(RECORDED.replay) })
    const first = client().subscribe(ENTRIES, replay.to)
    await replay.told(3)
    expect(server.requests).toEqual([
      { connection: 1, request: { id: expect.any(String), method: 'events.subscribe', params: { subscriptions: ENTRIES } } },
    ])
    expect(replay.calls).toEqual([
      ['started'],
      ['event', 'pane_agent_detected', { agent: 'claude', pane_id: 'w1:p1', type: 'pane_agent_detected', workspace_id: 'w1' }],
      ['event', 'pane_agent_detected', { agent: 'claude', pane_id: 'w2:p1', type: 'pane_agent_detected', workspace_id: 'w2' }],
    ])
    first.close()

    const released = subscriber()
    server.answer('events.subscribe', { raw: lines(RECORDED.released) })
    const second = client().subscribe(ENTRIES, released.to)
    await released.told(6)
    expect(released.calls).toEqual([
      ['started'],
      ...RECORDED.released.slice(1).map((line) => JSON.parse(line) as { event: string; data: unknown }).map(({ event, data }) => ['event', event, data]),
    ])
    expect(released.calls.map((call) => call[1])).toEqual([
      undefined, 'pane_agent_detected', 'pane_agent_detected', 'pane_agent_detected', 'pane.agent_status_changed', 'pane_closed',
    ])
    second.close()
  })

  it('events in the chunk that holds subscription_started, and a line split across two chunks, are each told once', async () => {
    const { calls, to, told } = subscriber()
    const [started, first, second] = RECORDED.replay
    const cut = 40
    server.answer('events.subscribe', { raw: `${started}\n${first}\n${second.slice(0, cut)}` })
    const subscription = client().subscribe(ENTRIES, to)
    // The first chunk has been read once its whole lines are told, so the rest of the split line comes in a chunk of its own.
    await told(2)
    server.send(`${second.slice(cut)}\n`)
    await told(3)
    subscription.close()
    await server.ended(1)
    expect(calls).toEqual([
      ['started'],
      ['event', 'pane_agent_detected', JSON.parse(first).data],
      ['event', 'pane_agent_detected', JSON.parse(second).data],
    ])
  })

  describe('a subscription is closed once: rejected, timeout, ended, oversize, bad_json', () => {
    // An event follows each bad line, and is never told.
    const thenEvent = (chunk: string) => `${chunk}${RECORDED.replay[1]}\n`
    it.each([
      ['rejected', 'an error answer', refusal('invalid_request'), undefined],
      ['bad_answer', 'a first line that is neither started nor an error', { raw: '{"id":"r1","result":{"type":"agent_list"}}\n' }, undefined],
      ['ended', 'a dropped connection', undefined, () => server.drop()],
      ['oversize', 'a line over 1 MiB', undefined, () => server.send(thenEvent(`${'x'.repeat(MAX_LINE_BYTES + 1)}\n`))],
      ['bad_json', 'a line that is no JSON', undefined, () => server.send(thenEvent('nope\n'))],
      ['bad_json', 'a line that is no object', undefined, () => server.send(thenEvent('[]\n'))],
    ] as const)('%s: %s', async (reason, _what, answer, afterStarted) => {
      if (answer) server.answer('events.subscribe', answer)
      const { calls, to, told } = subscriber()
      const subscription = client().subscribe(ENTRIES, to)
      if (afterStarted) {
        await told(1)
        afterStarted()
      }
      await told(afterStarted ? 2 : 1)
      await server.ended(1)
      await turn()
      subscription.close()
      await turn()
      expect(calls).toEqual(afterStarted ? [['started'], ['closed', reason]] : [['closed', reason]])
    })

    it('timeout: no answer in 10 s, and its connection closes', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      server.answer('events.subscribe', 'hold')
      const { calls, to, told } = subscriber()
      client().subscribe(ENTRIES, to)
      await server.got('events.subscribe', 1)
      vi.advanceTimersByTime(9_999)
      await turn()
      expect(calls).toEqual([])
      vi.advanceTimersByTime(1)
      await told(1)
      await server.ended(1)
      expect(calls).toEqual([['closed', 'timeout']])
    })

    it('a started subscription has no deadline', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { calls, to, told } = subscriber()
      const subscription = client().subscribe(ENTRIES, to)
      await told(1)
      vi.advanceTimersByTime(60_000)
      server.event('pane_agent_detected', { agent: 'claude', pane_id: 'w1:p1' })
      await told(2)
      subscription.close()
      expect(calls).toEqual([['started'], ['event', 'pane_agent_detected', { agent: 'claude', pane_id: 'w1:p1' }]])
    })
  })

  it('close() ends the connection and calls nothing', async () => {
    const live = subscriber()
    const first = client().subscribe(ENTRIES, live.to)
    await live.told(1)
    first.close()
    await server.ended(1)
    await turn()
    expect(live.calls).toEqual([['started']])

    server.answer('events.subscribe', 'hold')
    const waiting = subscriber()
    const second = client().subscribe(ENTRIES, waiting.to)
    await server.got('events.subscribe', 2)
    second.close()
    await server.ended(2)
    await turn()
    expect(waiting.calls).toEqual([])

    const none = subscriber()
    client({ socketPath: join(dirname(server.path), 'none.sock') }).subscribe(ENTRIES, none.to).close()
    await turn()
    expect(none.calls).toEqual([])
  })

  it('a subscription\'s connection is written to once', async () => {
    const { to, told } = subscriber()
    const subscription = client().subscribe(ENTRIES, to)
    await told(1)
    server.event('pane_agent_detected', { agent: 'claude', pane_id: 'w1:p1' })
    await told(2)
    subscription.close()
    await server.ended(1)
    expect(server.requests).toHaveLength(1)
  })

  it('the fake server, as herdr, closes a subscription sent a second request', async () => {
    const socket = connect(server.path)
    socket.on('error', () => {})
    // Read, so the end herdr sends is seen.
    socket.resume()
    socket.write(`${JSON.stringify({ id: 'a', method: 'events.subscribe', params: { subscriptions: ENTRIES } })}\n`)
    await server.got('events.subscribe', 1)
    socket.write(`${JSON.stringify({ id: 'b', method: 'agent.list', params: {} })}\n`)
    await once(socket, 'close')
    await server.ended(1)
    expect(server.requests.map(({ connection }) => connection)).toEqual([1, 1])
  })

  it.each(['idle', 'done'])('prompt reads the pane again, then sends the line (%s)', async (status) => {
    server.agents = [agent('w1:p1', 'claude', status)]
    expect(await client().prompt('w1:p1', 'claude', 'run the tests')).toEqual({ outcome: 'sent' })
    expect(server.requests).toEqual([
      { connection: 1, request: { id: expect.any(String), method: 'agent.get', params: { target: 'w1:p1' } } },
      { connection: 2, request: { id: expect.any(String), method: 'agent.prompt', params: { target: 'w1:p1', text: 'run the tests' } } },
    ])
  })

  it.each(['working', 'blocked', 'unknown'])('prompt to a working, blocked or unknown agent is busy, and nothing is sent (%s)', async (status) => {
    server.agents = [agent('w1:p1', 'claude', status)]
    expect(await client().prompt('w1:p1', 'claude', 'run the tests')).toEqual({ outcome: 'busy' })
    expect(server.requests.map(({ request }) => (request as { method: string }).method)).toEqual(['agent.get'])
  })

  it('a pane that holds another kind is failed, not_that_agent; a pane with no agent is failed, agent_not_found', async () => {
    server.agents = [agent('w1:p1', 'codex', 'idle')]
    const herdr = client()
    expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', code: 'not_that_agent' })
    expect(await herdr.prompt('w2:p1', 'claude', 'go')).toEqual({ outcome: 'failed', code: 'agent_not_found' })
    expect(server.requests.map(({ request }) => (request as { method: string }).method)).toEqual(['agent.get', 'agent.get'])
  })

  it('herdr\'s refusals of the prompt come back with their code', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    const herdr = client()
    for (const code of ['agent_not_ready', 'agent_not_found', 'empty_agent_prompt']) {
      server.answer('agent.prompt', refusal(code))
      expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', code })
    }
    // Nothing is sent twice.
    expect(server.requests.map(({ request }) => (request as { method: string }).method))
      .toEqual(['agent.get', 'agent.prompt', 'agent.get', 'agent.prompt', 'agent.get', 'agent.prompt'])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('agent.get', 'hold')
    const read = herdr.prompt('w1:p1', 'claude', 'go')
    await server.got('agent.get', 4)
    vi.advanceTimersByTime(10_000)
    expect(await read).toEqual({ outcome: 'failed', code: 'timeout' })
    server.answer('agent.get')
    server.answer('agent.prompt', 'hold')
    const sent = herdr.prompt('w1:p1', 'claude', 'go')
    await server.got('agent.prompt', 4)
    vi.advanceTimersByTime(10_000)
    expect(await sent).toEqual({ outcome: 'failed', code: 'timeout' })
  })

  it('control characters become spaces', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    expect(await client().prompt('w1:p1', 'claude', 'fix it\nrm -rf /\u001b[2J')).toEqual({ outcome: 'sent' })
    expect((await server.got('agent.prompt', 1)).request).toMatchObject({ params: { target: 'w1:p1', text: 'fix it rm -rf / [2J' } })
  })

  it('an empty text, one blank once its control characters are spaces, one over 2000 characters, a pane id or a kind not in its form: failed, bad_request, and nothing connects', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    const herdr = client()
    for (const [pane, kind, text] of [
      ['w1:p1', 'claude', ''],
      ['w1:p1', 'claude', '\n\t'],
      ['w1:p1', 'claude', 'x'.repeat(2001)],
      ['w1', 'claude', 'go'],
      ['--help', 'claude', 'go'],
      ['w1:p1; rm -rf /', 'claude', 'go'],
      ['w1:p1', 'Claude', 'go'],
    ]) {
      expect(await herdr.prompt(pane, kind, text), `${pane} ${kind} ${text.length}`).toEqual({ outcome: 'failed', code: 'bad_request' })
    }
    expect(server.connections).toBe(0)
    expect(await herdr.prompt('w1:p1', 'claude', 'x'.repeat(2000))).toEqual({ outcome: 'sent' })
  })

  it('socketStamp is none without a socket of this user\'s, and another once a server starts again at the same path', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    const stamp = client().socketStamp()
    expect(stamp).toEqual(expect.any(String))
    expect(client().socketStamp()).toBe(stamp)
    expect(client({ uid: process.getuid!() + 1 }).socketStamp()).toBeUndefined()
    expect(client({ platform: 'win32' }).socketStamp()).toBeUndefined()
    expect(client({ socketPath: file }).socketStamp()).toBeUndefined()

    await server.stop()
    expect(client().socketStamp()).toBeUndefined()
    await server.start()
    const again = client().socketStamp()
    expect(again).toEqual(expect.any(String))
    expect(again).not.toBe(stamp)

    // A herdr that died leaves its socket, and one that starts again replaces it.
    await server.stale()
    const left = client().socketStamp()
    expect(left).toEqual(expect.any(String))
    await server.start()
    expect(client().socketStamp()).not.toBe(left)
  })

  it('the watch tells of the nearest existing folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hw-'))
    const config = join(home, '.config')
    const folder = join(config, 'herdr')
    const deps = { socketPath: join(folder, 'herdr.sock'), home }
    let told = 0
    const stop = watchHerdrSocket(deps, () => { told++ })
    const count = () => told
    try {
      // With no <config>, a change in home is told.
      await toldOf(count, () => mkdir(join(home, 'a')))
      // <config> appears in home, and the watch moves there: a change in it is told.
      await toldOf(count, () => mkdir(config))
      await toldOf(count, () => mkdir(join(config, 'b')))
      // So does <config>/herdr.
      await toldOf(count, () => mkdir(folder))
      await toldOf(count, () => mkdir(join(folder, 'c')))
    } finally {
      stop()
    }
    // After its stop nothing is: another watch of the same folder tells of the change.
    const stopped = told
    let seen = 0
    const other = watchHerdrSocket(deps, () => { seen++ })
    try {
      await toldOf(() => seen, () => mkdir(join(folder, 'd')))
    } finally {
      other()
    }
    expect(told).toBe(stopped)
    // A watch that cannot be held tells nothing, and throws nothing.
    expect(() => watchHerdrSocket({ socketPath: join(home, 'none', 'herdr', 'herdr.sock'), home: join(home, 'none') }, () => {})()).not.toThrow()
  })
})
