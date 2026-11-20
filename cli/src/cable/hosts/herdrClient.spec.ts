import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessRow } from '../../lib/processTable.js'
import { fakeHerdr, RECORDED, type FakeHerdr } from '../../testing/fakeHerdr.js'
import {
  createHerdrClient, HERDR_PANE, herdrClientDeps, herdrPipeOf, herdrSocketPath, MAX_LINE_BYTES,
  type HerdrClientDeps, type HerdrEntry, type HerdrSubscriber,
} from './herdrClient.js'
import { MAX_TEXT } from './orca.js'
import { markerStampOf } from './unixSocket.js'

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

describe('herdr\'s pane id', () => {
  it('takes herdr\'s own base-32 digits, 1-9 a side: a workspace\'s tenth pane is pA', () => {
    for (const id of ['w1:p1', 'w2:pE', 'wA:p10', 'w0:pZ', 'w123456789:pZZZZZZZZZ']) expect(HERDR_PANE.test(id), id).toBe(true)
  })

  it('refuses letters herdr never writes (I, L, O, U), lower case, an empty side, a tail, and over 9 a side', () => {
    for (const id of ['w1:pI', 'w1:pL', 'w1:pO', 'w1:pU', 'w1:pe', 'w1:p', 'w:p1', 'w1:p1:x', 'w1234567891:p1', 'w1:p1234567891']) {
      expect(HERDR_PANE.test(id), id).toBe(false)
    }
  })
})

describe('herdr on Windows: its marker and its pipe (docs/plans/2026-11-19-dial-windows-vm-notes.md, Task 1 §7)', () => {
  const profile = 'C:\\Users\\me'
  const roaming = 'C:\\Users\\me\\AppData\\Roaming'

  it('the marker is %XDG_CONFIG_HOME%\\herdr\\herdr.sock, else %APPDATA%\\herdr\\herdr.sock, else the profile\'s; a relative one counts as unset', () => {
    expect(herdrSocketPath({ APPDATA: roaming }, profile, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
    expect(herdrSocketPath({ XDG_CONFIG_HOME: 'D:\\cfg', APPDATA: roaming }, profile, 'win32')).toBe('D:\\cfg\\herdr\\herdr.sock')
    expect(herdrSocketPath({ XDG_CONFIG_HOME: 'cfg', APPDATA: roaming }, profile, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
    expect(herdrSocketPath({ APPDATA: 'Roaming' }, profile, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
    expect(herdrSocketPath({}, profile, 'win32')).toBe('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
  })

  it('the pipe is \\\\.\\pipe\\ and the marker\'s whole path, unchanged', () => {
    expect(herdrPipeOf('C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock'))
      .toBe('\\\\.\\pipe\\C:\\Users\\me\\AppData\\Roaming\\herdr\\herdr.sock')
    expect(herdrPipeOf('D:\\cfg\\herdr\\herdr.sock')).toBe('\\\\.\\pipe\\D:\\cfg\\herdr\\herdr.sock')
  })

  it('herdrClientDeps dials the marker\'s pipe there', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    vi.stubEnv('APPDATA', roaming)
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
      const deps = herdrClientDeps()
      expect(deps.socketPath).toBe(herdrSocketPath(process.env, homedir(), 'win32'))
      expect(deps.endpoint).toBe(herdrPipeOf(deps.socketPath))
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
    }
  })
})

describe.skipIf(process.platform === 'win32')('the herdr client (docs/specs/2026-11-16-device-herdr.md)', () => {
  let server: FakeHerdr
  const client = (over: Partial<HerdrClientDeps> = {}) => createHerdrClient({
    socketPath: server.path, endpoint: server.path, home: dirname(server.path), uid: process.getuid!(), platform: process.platform, ...over,
  })

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
      socketPath: join(homedir(), '.config', 'herdr', 'herdr.sock'), endpoint: join(homedir(), '.config', 'herdr', 'herdr.sock'),
      home: homedir(), uid: process.getuid!(), platform: process.platform, rows: expect.any(Function),
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

  it('an error is rejected with its code, under its own id or ""; a code not in herdr\'s form is bad_answer', async () => {
    const herdr = client()
    expect(await herdr.request('agent.get', { target: 'w1:p1' })).toEqual({ ok: false, fault: 'rejected', code: 'agent_not_found' })
    server.answer('agent.list', { line: { id: '', error: { code: 'invalid_request', message: 'invalid request' } } })
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'rejected', code: 'invalid_request' })
    server.answer('agent.list', refusal('Bad Code!'))
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'bad_answer' })
  })

  // herdr's codes and the client's own words are apart: a herdr that answers `no_socket` has a socket.
  it('an error whose code is one of the client\'s own words is still rejected, with its code', async () => {
    const herdr = client()
    for (const code of ['no_socket', 'timeout', 'refused', 'bad_answer']) {
      server.answer('agent.list', refusal(code))
      expect(await herdr.request('agent.list', {}), code).toEqual({ ok: false, fault: 'rejected', code })
    }
  })

  it('an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 1 MiB is oversize', async () => {
    const herdr = client()
    for (const [answer, fault] of [
      [{ line: { id: 'another', result: { type: 'agent_list', agents: [] } } }, 'bad_answer'],
      [{ line: { id: 'another', error: { code: 'agent_not_found', message: '' } } }, 'bad_answer'],
      [{ line: {} }, 'bad_answer'],
      [{ line: { result: 'agent_list' } }, 'bad_answer'],
      [{ raw: 'not json\n' }, 'bad_json'],
      [{ raw: '[]\n' }, 'bad_json'],
      [{ raw: `{"pad":"${'x'.repeat(MAX_LINE_BYTES)}"}\n` }, 'oversize'],
    ] as const) {
      server.answer('agent.list', answer)
      expect(await herdr.request('agent.list', {}), JSON.stringify(answer).slice(0, 80)).toEqual({ ok: false, fault })
    }
  })

  it('no socket, a file that is no socket, and another user\'s socket are no_socket, and nothing connects', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    for (const herdr of [
      client({ socketPath: join(dirname(server.path), 'none.sock') }),
      client({ socketPath: file }),
      client({ uid: process.getuid!() + 1 }),
    ]) {
      expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'no_socket' })
      expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'no_socket' })
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
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'ended' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('agent.list', 'hold')
    let answered = false
    const answer = herdr.request('agent.list', {}).finally(() => { answered = true })
    await server.got('agent.list', 2)
    vi.advanceTimersByTime(9_999)
    await turn()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await answer).toEqual({ ok: false, fault: 'timeout' })
    await server.ended(2)
    vi.useRealTimers()

    await server.stale()
    expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'refused' })
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

  it('events in the chunk that holds subscription_started, and a line split across two chunks, even inside a character, are each told once', async () => {
    const { calls, to, told } = subscriber()
    const [started, first, second] = RECORDED.replay
    const cut = 40
    // A folder whose name's last character is two bytes, cut between them.
    const created = { pane: { pane_id: 'w3:p1', cwd: '/work/café' }, type: 'pane_created' }
    const third = Buffer.from(`${JSON.stringify({ data: created, event: 'pane_created' })}\n`)
    const inside = third.indexOf('é') + 1
    server.answer('events.subscribe', { raw: `${started}\n${first}\n${second.slice(0, cut)}` })
    const subscription = client().subscribe(ENTRIES, to)
    // A chunk has been read once its whole lines are told, so the rest of its split line comes in a chunk of its own.
    await told(2)
    server.send(Buffer.concat([Buffer.from(`${second.slice(cut)}\n`), third.subarray(0, inside)]))
    await told(3)
    server.send(third.subarray(inside))
    await told(4)
    subscription.close()
    await server.ended(1)
    expect(calls).toEqual([
      ['started'],
      ['event', 'pane_agent_detected', JSON.parse(first).data],
      ['event', 'pane_agent_detected', JSON.parse(second).data],
      ['event', 'pane_created', created],
    ])
  })

  describe('a subscription is closed once: rejected, timeout, ended, oversize, bad_json', () => {
    // An event follows each bad line, and is never told.
    const thenEvent = (chunk: string) => `${chunk}${RECORDED.replay[1]}\n`
    it.each([
      ['rejected', 'an error answer', refusal('invalid_request'), undefined],
      ['rejected', 'an error under ""', { line: { id: '', error: { code: 'invalid_request', message: 'invalid request' } } }, undefined],
      ['rejected', 'an error whose code is one of the client\'s own words', refusal('bad_answer'), undefined],
      ['bad_answer', 'a first line that is neither started nor an error', { line: { result: { type: 'agent_list' } } }, undefined],
      ['bad_answer', 'subscription_started under another id', { line: { id: 'another', result: { type: 'subscription_started' } } }, undefined],
      ['bad_answer', 'an error under another id', { line: { id: 'another', error: { code: 'invalid_request', message: '' } } }, undefined],
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

  it('the fake server, as herdr, refuses an empty prompt', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    expect(await client().request('agent.prompt', { target: 'w1:p1', text: '' })).toEqual({ ok: false, fault: 'rejected', code: 'empty_agent_prompt' })
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
    expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'not_that_agent' })
    expect(await herdr.prompt('w2:p1', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'rejected', code: 'agent_not_found' })
    expect(server.requests.map(({ request }) => (request as { method: string }).method)).toEqual(['agent.get', 'agent.get'])
  })

  it('a read of the pane that is no agent_info, or is another pane\'s, is failed, bad_answer, and nothing is sent', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    const herdr = client()
    for (const result of [
      { type: 'agent_list', agent: agent('w1:p1', 'claude', 'idle') },
      { type: 'agent_info', agent: agent('w2:p1', 'claude', 'idle') },
    ]) {
      server.answer('agent.get', { line: { result } })
      expect(await herdr.prompt('w1:p1', 'claude', 'go'), result.type).toEqual({ outcome: 'failed', fault: 'bad_answer' })
    }
    expect(server.requests.map(({ request }) => (request as { method: string }).method)).toEqual(['agent.get', 'agent.get'])
  })

  it('herdr\'s refusals of the prompt come back with their code', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    const herdr = client()
    for (const code of ['agent_not_ready', 'agent_not_found', 'empty_agent_prompt']) {
      server.answer('agent.prompt', refusal(code))
      expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'rejected', code })
    }
    // Nothing is sent twice.
    expect(server.requests.map(({ request }) => (request as { method: string }).method))
      .toEqual(['agent.get', 'agent.prompt', 'agent.get', 'agent.prompt', 'agent.get', 'agent.prompt'])

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('agent.get', 'hold')
    const read = herdr.prompt('w1:p1', 'claude', 'go')
    await server.got('agent.get', 4)
    vi.advanceTimersByTime(10_000)
    expect(await read).toEqual({ outcome: 'failed', fault: 'timeout' })
    server.answer('agent.get')
    server.answer('agent.prompt', 'hold')
    const sent = herdr.prompt('w1:p1', 'claude', 'go')
    await server.got('agent.prompt', 4)
    vi.advanceTimersByTime(10_000)
    expect(await sent).toEqual({ outcome: 'failed', fault: 'timeout' })
  })

  it('control characters become spaces', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    expect(await client().prompt('w1:p1', 'claude', 'fix it\nrm -rf /\u001b[2J')).toEqual({ outcome: 'sent' })
    expect((await server.got('agent.prompt', 1)).request).toMatchObject({ params: { target: 'w1:p1', text: 'fix it rm -rf / [2J' } })
  })

  it('an empty text, one blank once its control characters are spaces, one over MAX_TEXT characters, a pane id or a kind not in its form: failed, bad_request, and nothing connects', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    const herdr = client()
    for (const [pane, kind, text] of [
      ['w1:p1', 'claude', ''],
      ['w1:p1', 'claude', '\n\t'],
      ['w1:p1', 'claude', 'x'.repeat(MAX_TEXT + 1)],
      ['w1', 'claude', 'go'],
      ['--help', 'claude', 'go'],
      ['w1:p1; rm -rf /', 'claude', 'go'],
      ['w1:p1', 'Claude', 'go'],
    ]) {
      expect(await herdr.prompt(pane, kind, text), `${pane} ${kind} ${text.length}`).toEqual({ outcome: 'failed', fault: 'bad_request' })
    }
    expect(server.connections).toBe(0)
  })

  it('a text of 20,000 characters is sent whole', async () => {
    server.agents = [agent('w1:p1', 'claude', 'idle')]
    expect(await client().prompt('w1:p1', 'claude', 'x'.repeat(20_000))).toEqual({ outcome: 'sent' })
    expect((await server.got('agent.prompt', 1)).request).toMatchObject({ params: { target: 'w1:p1', text: 'x'.repeat(20_000) } })
  })

  it('socketStamp is none without a socket of this user\'s, and another once a server starts again at the same path', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    const stamp = client().socketStamp()
    expect(stamp).toEqual(expect.any(String))
    expect(client().socketStamp()).toBe(stamp)
    expect(client({ uid: process.getuid!() + 1 }).socketStamp()).toBeUndefined()
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

  // The fake herdr listens on a Unix socket, which a Windows client is handed as its endpoint: the marker and what is
  // dialled are apart there.
  describe('on Windows, over the pipe the marker names', () => {
    // The suite's home is a throwaway one (vitest.setup.ts): the profile the marker must be inside.
    const folder = join(homedir(), 'AppData', 'Roaming', 'herdr')
    const marker = join(folder, 'herdr.sock')
    /** The herdr that wrote the marker, as the process table lists it: a minute before the marker's time
     *  (1763600000000000000 ns since 1970, the FILETIME 134080736000000000). */
    const herdrRow = (over: Partial<ProcessRow> = {}): ProcessRow =>
      ({ pid: process.pid, parentPid: 1, executable: 'herdr.exe', startMarker: 'w:134080735400000000', args: 'herdr server', ...over })
    const windows = (over: Partial<HerdrClientDeps> = {}) => client({
      platform: 'win32', socketPath: marker, endpoint: server.path, home: homedir(), uid: -1, rows: async () => [herdrRow()], ...over,
    })

    beforeEach(async () => {
      await mkdir(folder, { recursive: true })
      await writeFile(marker, `${process.pid}:1763600000000000000`)
    })
    afterEach(async () => { await rm(folder, { recursive: true, force: true }) })

    it('agent.list, agent.prompt and events.subscribe go to the endpoint', async () => {
      server.agents = [agent('w1:p1', 'claude', 'idle')]
      const herdr = windows()
      expect(await herdr.request('agent.list', {})).toEqual({ ok: true, result: { type: 'agent_list', agents: server.agents } })
      expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'sent' })
      expect((await server.got('agent.prompt', 1)).request).toMatchObject({ params: { target: 'w1:p1', text: 'go' } })
      const { calls, to, told } = subscriber()
      const subscription = herdr.subscribe(ENTRIES, to)
      await told(2)
      expect(calls).toEqual([['started'], ['event', 'pane_agent_detected', expect.objectContaining({ pane_id: 'w1:p1' })]])
      subscription.close()
    })

    it('the stamp is the marker\'s', () => {
      expect(windows().socketStamp()).toMatch(/^\d+:\d+$/)
      expect(windows().socketStamp()).toBe(markerStampOf(marker))
    })

    it('no marker, or one outside the profile, is no_socket, and nothing connects', async () => {
      const outside = join(dirname(server.path), 'herdr-marker')
      await writeFile(outside, `${process.pid}:1763600000000000000`)
      for (const herdr of [windows({ socketPath: join(folder, 'none.sock') }), windows({ socketPath: outside })]) {
        expect(herdr.socketStamp()).toBeUndefined()
        expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'no_socket' })
        expect(await herdr.prompt('w1:p1', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'no_socket' })
        const { calls, to, told } = subscriber()
        herdr.subscribe(ENTRIES, to)
        await told(1)
        expect(calls).toEqual([['closed', 'no_socket']])
      }
      expect(server.connections).toBe(0)
    })

    // The pipe is a name any account can take once herdr is gone: only the marker's own herdr is dialled.
    it("a marker whose herdr is gone, another program, another account's or one started after it is no stamp, and nothing connects", async () => {
      for (const table of [
        null,
        // Gone, or another account's: the table leaves out a process this account may not open.
        [],
        [herdrRow({ executable: 'node.exe' })],
        // Started after herdr wrote the marker: Windows gave herdr's pid to it.
        [herdrRow({ startMarker: 'w:134080736600000000' })],
      ]) {
        const herdr = windows({ rows: async () => table })
        expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'no_socket' })
        expect(herdr.socketStamp()).toBeUndefined()
        const { calls, to, told } = subscriber()
        herdr.subscribe(ENTRIES, to)
        await told(1)
        expect(calls).toEqual([['closed', 'no_socket']])
      }
      await writeFile(marker, 'not a marker')
      expect(await windows().request('agent.list', {})).toEqual({ ok: false, fault: 'no_socket' })
      expect(server.connections).toBe(0)
    })

    it('herdr is looked for once a marker, and again after a connection that failed: herdr may be gone, and its pipe another account\'s', async () => {
      let reads = 0
      const herdr = windows({ rows: async () => { reads++; return [herdrRow()] } })
      expect(await herdr.request('agent.list', {})).toMatchObject({ ok: true })
      expect(await herdr.request('agent.list', {})).toMatchObject({ ok: true })
      expect(reads).toBe(1)
      // herdr started again, and wrote its marker anew.
      await utimes(marker, new Date(2030, 0, 1), new Date(2030, 0, 1))
      expect(await herdr.request('agent.list', {})).toMatchObject({ ok: true })
      expect(reads).toBe(2)

      server.answer('agent.list', 'close')
      expect(await herdr.request('agent.list', {})).toEqual({ ok: false, fault: 'ended' })
      server.answer('agent.list')
      expect(await herdr.request('agent.list', {})).toMatchObject({ ok: true })
      expect(reads).toBe(3)
      const { to, told } = subscriber()
      herdr.subscribe(ENTRIES, to)
      await told(1)
      server.drop()
      await told(2)
      expect(await herdr.request('agent.list', {})).toMatchObject({ ok: true })
      expect(reads).toBe(4)
    })
  })
})
