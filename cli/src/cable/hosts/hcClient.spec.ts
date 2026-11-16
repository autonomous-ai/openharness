import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHc, RECORDED, type FakeHc } from '../../testing/fakeHc.js'
import {
  createHcClient, hcClientDeps, hcKind, hcSocketPath, hcTerminal,
  type HcClientDeps, type HcSubscriber,
} from './hcClient.js'
import { MAX_LINE_BYTES } from './herdrClient.js'
import { connectLines } from './unixSocket.js'

const lines = (recorded: readonly string[]) => `${recorded.join('\n')}\n`
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
/** Lets what the socket has already said be told, with the timers faked or not. */
const turn = () => new Promise((resolve) => setImmediate(resolve))
const methods = (server: FakeHc) => server.requests.map(({ request }) => (request as { method: string }).method)

/** The recording's agent and its hidden worker, as the client tells them. */
const agentIs = (status: string) => ({ address: 't1', live: true, space: true, status, kind: 'claude', cwd: '/work/hh' })
const WORKER = { address: 't2', live: true, space: false, cwd: '/work/hh' }

/** A subscriber that records each call, and `told(n)` once n have come. */
function subscriber() {
  const calls: unknown[][] = []
  const waits: Array<{ n: number; resolve(): void }> = []
  const push = (call: unknown[]) => {
    calls.push(call)
    for (const wait of waits.filter(({ n }) => calls.length >= n)) wait.resolve()
  }
  const to: HcSubscriber = {
    snapshot: (terminals) => push(['snapshot', terminals]),
    changed: (terminal) => push(['changed', terminal]),
    closed: (reason) => push(['closed', reason]),
  }
  const told = (n: number) => new Promise<void>((resolve) => {
    if (calls.length >= n) resolve()
    else waits.push({ n, resolve })
  })
  return { calls, to, told }
}

describe.skipIf(process.platform === 'win32')('the hc client (docs/plans/2026-11-16-herdr-app-design.md)', () => {
  let server: FakeHc
  const client = (over: Partial<HcClientDeps> = {}) =>
    createHcClient({ socketPath: server.path, home: dirname(server.path), uid: process.getuid!(), platform: 'darwin', ...over })
  /** Once a request has gone to the server and back, the subscription has read what the server wrote before it: its
   *  socket was readable before the request's connection opened. A line that tells nothing has nothing else to wait on. */
  const fence = () => client().request('terminal.list', {})

  /** A connection of the spec's own that writes `out` and keeps each line the fake writes back, parsed: the fake checked
   *  as hc, with no client between. */
  const raw = (out: string) => {
    const got: Array<Record<string, unknown>> = []
    const checks = new Set<() => boolean>()
    const settle = () => { for (const check of checks) if (check()) checks.delete(check) }
    const socket = connectLines(server.path, out, MAX_LINE_BYTES, (text) => {
      got.push(JSON.parse(text) as Record<string, unknown>)
      settle()
    }, () => {})
    const until = (check: () => boolean) => new Promise<void>((resolve) => {
      const done = () => {
        if (!check()) return false
        resolve()
        return true
      }
      if (!done()) checks.add(done)
    })
    return {
      got,
      socket,
      lines: (n: number) => until(() => got.length >= n),
      /** Once the fake's heartbeat has come: every line it wrote before it has too. */
      heartbeat: () => until(() => got.some(({ method }) => method === 'heartbeat')),
    }
  }
  const subscribeRaw = async () => {
    const subscription = raw(`${rpc(1, 'hello', { generation: 1 })}${rpc(2, 'events.subscribe')}`)
    await subscription.lines(2)
    return subscription
  }

  beforeEach(async () => { server = await fakeHc() })
  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await server.stop()
  })

  it('the socket is HC_SOCKET when absolute; else <XDG_RUNTIME_DIR>/herdr-core/<session>.sock when that is absolute; else <XDG_STATE_HOME or ~/.local/state>/herdr-core/<session>/<session>.sock', () => {
    const fallback = '/h/.local/state/herdr-core/default/default.sock'
    expect(hcSocketPath({ HC_SOCKET: '/tmp/x/c.sock', HC_SESSION: 'side', XDG_RUNTIME_DIR: '/run/me', XDG_STATE_HOME: '/s' }, '/h'))
      .toBe('/tmp/x/c.sock')
    expect(hcSocketPath({ XDG_RUNTIME_DIR: '/run/me', XDG_STATE_HOME: '/s', HC_SESSION: 'side' }, '/h')).toBe('/run/me/herdr-core/side.sock')
    expect(hcSocketPath({ XDG_STATE_HOME: '/s', HC_SESSION: 'side' }, '/h')).toBe('/s/herdr-core/side/side.sock')
    expect(hcSocketPath({}, '/h')).toBe(fallback)
    // A relative or empty one would be the daemon's own folder, not hc's: each counts as unset.
    expect(hcSocketPath({ HC_SOCKET: 'c.sock', XDG_RUNTIME_DIR: 'run', XDG_STATE_HOME: 's' }, '/h')).toBe(fallback)
    expect(hcSocketPath({ HC_SOCKET: '', XDG_RUNTIME_DIR: '', XDG_STATE_HOME: '' }, '/h')).toBe(fallback)
    for (const session of ['../x', 'a/b', '.', '..', '-a', '', 'x'.repeat(65)]) {
      expect(hcSocketPath({ HC_SESSION: session }, '/h'), session).toBe(fallback)
    }
    const long = 'x'.repeat(64)
    expect(hcSocketPath({ HC_SESSION: long }, '/h')).toBe(`/h/.local/state/herdr-core/${long}/${long}.sock`)
    expect(hcSocketPath({ HC_SESSION: 'harness-a1.B_2' }, '/h')).toBe('/h/.local/state/herdr-core/harness-a1.B_2/harness-a1.B_2.sock')
  })

  it('hcClientDeps reads the devices process\'s own environment', () => {
    vi.stubEnv('XDG_RUNTIME_DIR', undefined)
    vi.stubEnv('HC_SOCKET', '/tmp/hc-own/c.sock')
    expect(hcClientDeps()).toEqual({ socketPath: '/tmp/hc-own/c.sock', home: homedir(), uid: process.getuid!(), platform: process.platform })
    vi.stubEnv('HC_SOCKET', undefined)
    vi.stubEnv('HC_SESSION', 'side')
    // The suite's home is a throwaway one, and its XDG_STATE_HOME is unset (vitest.setup.ts).
    expect(hcClientDeps().socketPath).toBe(join(homedir(), '.local', 'state', 'herdr-core', 'side', 'side.sock'))
  })

  it('hcKind: claude-code is claude; another app keeps its own word when it fits', () => {
    expect(hcKind('claude-code')).toBe('claude')
    expect(hcKind('codex')).toBe('codex')
    expect(hcKind('pi')).toBe('pi')
    for (const app of ['Claude Code', '', '__proto__', 7, undefined, null]) expect(hcKind(app), String(app)).toBeUndefined()
    // The table is read by its own keys only.
    expect(hcKind('constructor')).toBe('constructor')
  })

  it('hcTerminal reads each field, checked; another machine\'s terminal, or an address not in its form, is none', () => {
    expect(hcTerminal({
      address: 't7', state: 'live', labels: { 'herdr.space': 's1', other: 'x' }, status: { app: 'codex', state: 'working' },
      name: 'api', cwd: '/work', foreground: { cwd: '/work/api' },
    })).toEqual({ address: 't7', live: true, space: true, status: 'working', kind: 'codex', name: 'api', cwd: '/work/api' })
    expect(hcTerminal({
      address: 't7', state: 'finished', labels: { 'herdr.space': '' }, status: { app: 'Weird App', state: 'paused' }, name: null,
      cwd: '/work', foreground: { cwd: 7 },
    })).toEqual({ address: 't7', live: false, space: false, cwd: '/work' })
    const longest = `t${'1'.repeat(16)}`
    expect(hcTerminal({ address: longest })).toEqual({ address: longest, live: false, space: false })
    for (const value of [undefined, null, 't7', [], {}, { address: 7 }, { address: 'vps/t7' }, { address: 'T7' }, { address: 't' },
      { address: `t${'1'.repeat(17)}` }]) {
      expect(hcTerminal(value), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('request writes one JSON-RPC line and answers the result under its own id', async () => {
    server.terminals = [{ address: 't7', cwd: '/work/api' }]
    expect(await client().request('terminal.get', { terminal: 't7' }))
      .toEqual({ ok: true, result: expect.objectContaining({ address: 't7', cwd: '/work/api', state: 'live' }) })
    expect(server.requests).toEqual([
      { connection: 1, request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.get', params: { terminal: 't7' } } },
    ])
  })

  it('each request is a connection of its own', async () => {
    const hc = client()
    await hc.request('terminal.get', { terminal: 't7' })
    await hc.request('terminal.get', { terminal: 't7' })
    expect(server.requests.map(({ connection }) => connection)).toEqual([1, 2])
    const [first, second] = server.requests.map(({ request }) => (request as { id: string }).id)
    expect(first).not.toBe(second)
    await server.ended(1)
    await server.ended(2)
  })

  it('an error is rejected with its data.kind, never its message; a kind not in its form is bad_answer', async () => {
    const hc = client()
    expect(await hc.request('terminal.get', { terminal: 't99' })).toEqual({ ok: false, fault: 'rejected', kind: 'not_found' })
    // hc's kinds and the client's own words are apart: a core that answers `no_socket` has a socket.
    for (const kind of ['no_socket', 'timeout', 'a'.repeat(64)]) {
      server.answer('terminal.get', { error: kind })
      expect(await hc.request('terminal.get', { terminal: 't7' }), kind).toEqual({ ok: false, fault: 'rejected', kind })
    }
    for (const answer of [
      { raw: '{"error":{"code":-32000,"message":"not_found"},"id":1,"jsonrpc":"2.0"}\n' },
      { error: 'Bad Kind!' },
      { error: 'a'.repeat(65) },
      { error: '' },
    ]) {
      server.answer('terminal.get', answer)
      expect(await hc.request('terminal.get', { terminal: 't7' }), JSON.stringify(answer)).toEqual({ ok: false, fault: 'bad_answer' })
    }
  })

  it('an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 1 MiB is oversize', async () => {
    const hc = client()
    for (const [raw, fault] of [
      ['{"id":"another","jsonrpc":"2.0","result":{}}\n', 'bad_answer'],
      // hc's answer to a line it could not read is under null.
      ['{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"data":{"kind":"parse_error"},"message":"x"}}\n', 'bad_answer'],
      ['{"id":1,"jsonrpc":"2.0"}\n', 'bad_answer'],
      ['{"id":1,"jsonrpc":"2.0","result":"t7"}\n', 'bad_answer'],
      ['not json\n', 'bad_json'],
      ['[]\n', 'bad_json'],
      [`{"pad":"${'x'.repeat(MAX_LINE_BYTES)}"}\n`, 'oversize'],
    ] as const) {
      server.answer('terminal.get', { raw })
      expect(await hc.request('terminal.get', { terminal: 't7' }), raw.slice(0, 80)).toEqual({ ok: false, fault })
    }
  })

  it('no socket, a file that is no socket, another user\'s socket, and any platform but macOS are no_socket, and nothing connects', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    for (const hc of [
      client({ socketPath: join(dirname(server.path), 'none.sock') }),
      client({ socketPath: file }),
      client({ uid: process.getuid!() + 1 }),
      client({ platform: 'linux' }),
      client({ platform: 'win32' }),
    ]) {
      expect(await hc.request('terminal.get', { terminal: 't7' })).toEqual({ ok: false, fault: 'no_socket' })
      expect(await hc.prompt('t7', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'no_socket' })
      const { calls, to, told } = subscriber()
      hc.subscribe(to)
      await told(1)
      expect(calls).toEqual([['closed', 'no_socket']])
    }
    expect(server.connections).toBe(0)
  })

  it('a stale socket is refused; a connection that ends before its answer is ended; none in 10 s is timeout, and its connection closes', async () => {
    const hc = client()
    server.answer('terminal.get', 'close')
    expect(await hc.request('terminal.get', { terminal: 't7' })).toEqual({ ok: false, fault: 'ended' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('terminal.get', 'hold')
    let answered = false
    const answer = hc.request('terminal.get', { terminal: 't7' }).finally(() => { answered = true })
    await server.got('terminal.get', 2)
    vi.advanceTimersByTime(9_999)
    await turn()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await answer).toEqual({ ok: false, fault: 'timeout' })
    await server.ended(2)
    vi.useRealTimers()

    await server.stale()
    expect(await hc.request('terminal.get', { terminal: 't7' })).toEqual({ ok: false, fault: 'refused' })
  })

  it('subscribe writes hello then events.subscribe on one connection, and tells the snapshot once both answered', async () => {
    server.answer('events.subscribe', { raw: lines(RECORDED.subscription.slice(0, 1)) })
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    expect(server.requests).toEqual([
      { connection: 1, request: { jsonrpc: '2.0', id: expect.any(String), method: 'hello', params: { generation: 1 } } },
      { connection: 1, request: { jsonrpc: '2.0', id: expect.any(String), method: 'events.subscribe', params: {} } },
    ])
    const [hello, subscribe] = server.requests.map(({ request }) => (request as { id: string }).id)
    expect(hello).not.toBe(subscribe)
    expect(calls).toEqual([['snapshot', [agentIs('idle'), WORKER]]])
    subscription.close()
    await server.ended(1)
  })

  it('a name hc gave is told', async () => {
    server.terminals = [{ address: 't7', name: 'api', cwd: '/work/api' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    subscription.close()
    expect(calls).toEqual([['snapshot', [
      { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', name: 'api', cwd: '/work/api' },
    ]]])
  })

  it('hc\'s own lines, in order, tell each change', async () => {
    server.answer('events.subscribe', { raw: lines(RECORDED.subscription) })
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(15)
    subscription.close()
    const worker = (live: boolean, space: boolean) => ({ address: 't2', live, space, cwd: '/work/hh' })
    const created = (live: boolean) => ({ address: 't3', live, space: true, cwd: '/work/hh' })
    // The foreground lines name the folder each already had, and the turn, title, keep, doc and heartbeat lines change
    // nothing told: each tells nothing.
    expect(calls).toEqual([
      ['snapshot', [agentIs('idle'), WORKER]],
      ['changed', agentIs('working')],
      ['changed', agentIs('blocked')],
      ['changed', agentIs('working')],
      ['changed', agentIs('done')],
      ['changed', agentIs('idle')],
      ['changed', agentIs('error')],
      ['changed', agentIs('idle')],
      ['changed', worker(true, true)],
      ['changed', worker(true, false)],
      ['changed', created(true)],
      ['changed', worker(false, false)],
      ['changed', worker(false, false)],
      ['changed', created(false)],
      ['changed', created(false)],
    ])
  })

  it('a hello answered with another generation, or unsupported_generation, is closed bad_answer, and no snapshot is told; another refusal is rejected', async () => {
    let connection = 0
    for (const [answer, reason] of [
      [{ result: { generation: 2 } }, 'bad_answer'],
      [{ result: {} }, 'bad_answer'],
      [{ raw: `${RECORDED.helloRefused}\n` }, 'bad_answer'],
      [{ error: 'unavailable' }, 'rejected'],
    ] as const) {
      server.answer('hello', answer)
      const { calls, to, told } = subscriber()
      client().subscribe(to)
      await told(1)
      await server.ended(++connection)
      await turn()
      expect(calls, JSON.stringify(answer)).toEqual([['closed', reason]])
    }
  })

  it('events.subscribe refused, or answered with no snapshot, is closed; neither answer in 10 s is closed timeout', async () => {
    let connection = 0
    for (const [answer, reason] of [
      [{ error: 'invalid_params' }, 'rejected'],
      [{ error: 'Bad Kind!' }, 'bad_answer'],
      [{ result: { seq: 1 } }, 'bad_answer'],
      [{ result: { seq: '1', terminals: [] } }, 'bad_answer'],
      [{ result: { terminals: [] } }, 'bad_answer'],
    ] as const) {
      server.answer('events.subscribe', answer)
      const { calls, to, told } = subscriber()
      client().subscribe(to)
      await told(1)
      await server.ended(++connection)
      expect(calls, JSON.stringify(answer)).toEqual([['closed', reason]])
    }

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('events.subscribe', 'hold')
    const { calls, to, told } = subscriber()
    client().subscribe(to)
    await server.got('events.subscribe', connection + 1)
    vi.advanceTimersByTime(9_999)
    await turn()
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    await told(1)
    await server.ended(connection + 1)
    expect(calls).toEqual([['closed', 'timeout']])
  })

  it('an event that names one fact tells the whole terminal', async () => {
    server.terminals = [{ address: 't7', cwd: '/work/api' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('t7', { status: { state: 'working', app: 'claude-code' } })
    await told(2)
    server.change('t7', { labels: {} })
    await told(3)
    subscription.close()
    expect(calls.slice(1)).toEqual([
      ['changed', { address: 't7', live: true, space: true, status: 'working', kind: 'claude', cwd: '/work/api' }],
      ['changed', { address: 't7', live: true, space: false, status: 'working', kind: 'claude', cwd: '/work/api' }],
    ])
  })

  it('a foreground\'s folder is the terminal\'s once hc tells it; one that changes nothing told tells nothing', async () => {
    server.terminals = [{ address: 't7', cwd: '/work/api' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    const foreground = (cwd: string) => ({ data: { argv: ['/usr/local/bin/node'], cwd, name: 'node', pid: 4242 }, terminal: 't7' })
    server.event('foreground', foreground('/work/api/web'))
    await told(2)
    server.event('foreground', foreground('/work/api/web'))
    server.change('t7', { status: { state: 'idle', app: 'claude-code' } })
    server.change('t7', { status: { state: 'done', app: 'claude-code' } })
    await told(3)
    subscription.close()
    expect(calls.slice(1)).toEqual([
      ['changed', { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/api/web' }],
      ['changed', { address: 't7', live: true, space: true, status: 'done', kind: 'claude', cwd: '/work/api/web' }],
    ])
  })

  it('a terminal of another machine is never told', async () => {
    server.terminals = [{ address: 'vps/t3' }, { address: 't7' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('vps/t3', { status: { state: 'working', app: 'claude-code' } })
    server.change('vps/t4', {})
    server.change('t7', { status: { state: 'working', app: 'claude-code' } })
    await told(2)
    subscription.close()
    expect(calls).toEqual([
      ['snapshot', [{ ...agentIs('idle'), address: 't7' }]],
      ['changed', { ...agentIs('working'), address: 't7' }],
    ])
  })

  it('missed brings a fresh snapshot, and an event whose seq is not above it is dropped', async () => {
    server.terminals = [{ address: 't7' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    const [missed, ...after] = RECORDED.missed
    const working = RECORDED.subscription[2]
    server.send(lines([
      missed,
      // At the snapshot's own seq, and from before it.
      working.replace('"seq":13', '"seq":30040'),
      working,
      // t7 was not in the fresh snapshot.
      working.replace('"seq":13', '"seq":30041').replace('"terminal":"t1"', '"terminal":"t7"'),
      // hc's own: its idle again, which changes nothing told, its status cleared, its exit and its removal.
      ...after,
    ]))
    await told(5)
    subscription.close()
    const ended = { address: 't1', live: false, space: true, cwd: '/work/hh' }
    expect(calls).toEqual([
      ['snapshot', [{ ...agentIs('idle'), address: 't7' }]],
      ['snapshot', [agentIs('idle')]],
      ['changed', { address: 't1', live: true, space: true, cwd: '/work/hh' }],
      ['changed', ended],
      ['changed', ended],
    ])
  })

  it('a missed line with no snapshot in it is closed bad_answer', async () => {
    const { calls, to, told } = subscriber()
    client().subscribe(to)
    await told(1)
    server.send('{"jsonrpc":"2.0","method":"missed","params":{"seq":30040}}\n')
    await told(2)
    await server.ended(1)
    expect(calls).toEqual([['snapshot', []], ['closed', 'bad_answer']])
  })

  it('a subscription that hears nothing for 45 s is closed timeout; a heartbeat puts it off', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { calls, to, told } = subscriber()
    client().subscribe(to)
    await told(1)
    vi.advanceTimersByTime(44_999)
    await fence()
    expect(calls).toHaveLength(1)
    server.heartbeat()
    await fence()
    vi.advanceTimersByTime(44_999)
    await fence()
    expect(calls).toHaveLength(1)
    vi.advanceTimersByTime(1)
    await told(2)
    await server.ended(1)
    expect(calls).toEqual([['snapshot', []], ['closed', 'timeout']])
  })

  it('a doc line tells nothing and the next event is still told; a line over 1 MiB closes the subscription oversize', async () => {
    server.terminals = [{ address: 't7' }]
    const { calls, to, told } = subscriber()
    client().subscribe(to)
    await told(1)
    server.event('doc')
    server.event('doc', { data: { name: 'herdr-app', version: 9 } })
    server.change('t7', { status: { state: 'working', app: 'claude-code' } })
    await told(2)
    server.send(`{"pad":"${'x'.repeat(MAX_LINE_BYTES)}"}\n`)
    server.change('t7', { status: { state: 'idle', app: 'claude-code' } })
    await told(3)
    await server.ended(1)
    await turn()
    expect(calls).toEqual([
      ['snapshot', [{ ...agentIs('idle'), address: 't7' }]],
      ['changed', { ...agentIs('working'), address: 't7' }],
      ['closed', 'oversize'],
    ])
  })

  it('events in the chunk that holds the snapshot, and a line split across two chunks, are each told once', async () => {
    const [answer, , working, blocked] = RECORDED.subscription
    const cut = 40
    server.answer('events.subscribe', { raw: `${answer}\n${working}\n${blocked.slice(0, cut)}` })
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    // A chunk has been read once its whole lines are told, so the rest of its split line comes in a chunk of its own.
    await told(2)
    server.send(`${blocked.slice(cut)}\n`)
    await told(3)
    subscription.close()
    expect(calls).toEqual([
      ['snapshot', [agentIs('idle'), WORKER]],
      ['changed', agentIs('working')],
      ['changed', agentIs('blocked')],
    ])
  })

  it('past 1,024 terminals a new one is neither kept nor told', async () => {
    server.terminals = Array.from({ length: 1025 }, (_, at) => ({ address: `t${at + 1}` }))
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('t2000', {})
    server.change('t1025', { status: { state: 'working', app: 'claude-code' } })
    server.remove('t1')
    server.change('t2001', {})
    await told(3)
    subscription.close()
    const idle = (address: string) => ({ ...agentIs('idle'), address })
    expect(calls).toEqual([
      ['snapshot', Array.from({ length: 1024 }, (_, at) => idle(`t${at + 1}`))],
      ['changed', { ...idle('t1'), live: false }],
      ['changed', idle('t2001')],
    ])
  })

  describe('closed is told once, and nothing after it', () => {
    // An event follows each bad line, and is never told.
    const thenEvent = (chunk: string) => `${chunk}${RECORDED.subscription[2]}\n`
    it.each([
      ['ended', 'a dropped connection', () => server.drop()],
      ['oversize', 'a line over 1 MiB', () => server.send(thenEvent(`${'x'.repeat(MAX_LINE_BYTES + 1)}\n`))],
      ['bad_json', 'a line that is no JSON', () => server.send(thenEvent('nope\n'))],
      ['bad_json', 'a line that is no object', () => server.send(thenEvent('[]\n'))],
    ] as const)('%s: %s', async (reason, _what, after) => {
      server.answer('events.subscribe', { raw: lines(RECORDED.subscription.slice(0, 1)) })
      const { calls, to, told } = subscriber()
      const subscription = client().subscribe(to)
      await told(1)
      after()
      await told(2)
      await server.ended(1)
      await turn()
      subscription.close()
      await turn()
      expect(calls).toEqual([['snapshot', [agentIs('idle'), WORKER]], ['closed', reason]])
    })
  })

  it('close() ends the connection and tells nothing', async () => {
    const live = subscriber()
    const first = client().subscribe(live.to)
    await live.told(1)
    first.close()
    await server.ended(1)
    await turn()
    expect(live.calls).toEqual([['snapshot', []]])

    server.answer('hello', 'hold')
    const waiting = subscriber()
    const second = client().subscribe(waiting.to)
    await server.got('hello', 2)
    second.close()
    await server.ended(2)
    await turn()
    expect(waiting.calls).toEqual([])

    const none = subscriber()
    client({ socketPath: join(dirname(server.path), 'none.sock') }).subscribe(none.to).close()
    await turn()
    expect(none.calls).toEqual([])
  })

  it('the fake server, as hc, refuses a send to a blocked terminal, and one whose if is not its status', async () => {
    server.terminals = [
      { address: 't7', status: { state: 'blocked', app: 'claude-code' } },
      { address: 't8', status: { state: 'working', app: 'claude-code' } },
    ]
    const hc = client()
    expect(await hc.request('terminal.send', { terminal: 't7', text: 'go' })).toEqual({ ok: false, fault: 'rejected', kind: 'blocked' })
    expect(await hc.request('terminal.send', { terminal: 't8', text: 'go', if: 'idle' }))
      .toEqual({ ok: false, fault: 'rejected', kind: 'status_mismatch' })
  })

  it('the fake server, as hc, writes a status line for each report, one that repeats the last word too (F5)', async () => {
    server.terminals = [{ address: 't7' }]
    const subscription = await subscribeRaw()
    server.change('t7', { status: { state: 'idle', app: 'claude-code' } })
    server.change('t7', { status: { state: 'idle', app: 'claude-code' } })
    server.heartbeat()
    await subscription.heartbeat()
    subscription.socket.destroy()
    const idle = (seq: number) => ({
      data: { records: {}, reported: true, status: { app: 'claude-code', state: 'idle' } }, seq, terminal: 't7', type: 'status',
    })
    expect(subscription.got.slice(2).map(({ params }) => params)).toEqual([idle(1), idle(2), { seq: 2 }])
  })

  it('the fake server, as hc, tells a new terminal whole before its program reports, then its foreground, then its status (F5)', async () => {
    const subscription = await subscribeRaw()
    server.change('t9', { status: { state: 'working', app: 'codex' } })
    server.heartbeat()
    await subscription.heartbeat()
    subscription.socket.destroy()
    type Event = { data: Record<string, unknown>; type: string }
    const events = subscription.got.slice(2, -1).map(({ params }) => params as Event)
    expect(events.map(({ type }) => type)).toEqual(['created', 'foreground', 'status'])
    const [created, , status] = events
    // The recording's own created line: its keys, and no foreground yet.
    const recorded = (JSON.parse(RECORDED.subscription[16]) as { params: Event }).params
    expect(recorded.type).toBe('created')
    expect(Object.keys(created.data)).toEqual(Object.keys(recorded.data))
    expect(created.data).toMatchObject({ address: 't9', reported: false, status: null, status_ms: null })
    expect(status.data).toEqual({ records: {}, reported: true, status: { app: 'codex', state: 'working' } })
  })

  it('prompt reads the terminal, then sends the line: if idle when it was idle, no if when it was done, never force', async () => {
    server.terminals = [{ address: 't7' }, { address: 't8', status: { state: 'done', app: 'claude-code' } }]
    const hc = client()
    expect(await hc.prompt('t7', 'claude', 'run the tests')).toEqual({ outcome: 'sent' })
    expect(await hc.prompt('t8', 'claude', 'run the tests')).toEqual({ outcome: 'sent' })
    expect(server.requests).toEqual([
      { connection: 1, request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.get', params: { terminal: 't7' } } },
      {
        connection: 2,
        request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.send', params: { terminal: 't7', text: 'run the tests', if: 'idle' } },
      },
      { connection: 3, request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.get', params: { terminal: 't8' } } },
      { connection: 4, request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.send', params: { terminal: 't8', text: 'run the tests' } } },
    ])
  })

  it('working, blocked, error and a word hc does not have are busy, and nothing is sent; hc\'s status_mismatch is busy', async () => {
    const hc = client()
    for (const state of ['working', 'blocked', 'error', 'paused']) {
      server.terminals = [{ address: 't7', status: { state, app: 'claude-code' } }]
      expect(await hc.prompt('t7', 'claude', 'go'), state).toEqual({ outcome: 'busy' })
    }
    expect(methods(server)).toEqual(['terminal.get', 'terminal.get', 'terminal.get', 'terminal.get'])

    // It went working between the read and the send.
    server.terminals = [{ address: 't7' }]
    server.answer('terminal.send', { raw: `${RECORDED.mismatch}\n` })
    expect(await hc.prompt('t7', 'claude', 'go')).toEqual({ outcome: 'busy' })
    expect(methods(server).slice(4)).toEqual(['terminal.get', 'terminal.send'])
  })

  it('a terminal that finished, holds another kind, or reports no app is failed, not_that_agent; one hc does not know is failed, rejected, not_found', async () => {
    server.terminals = [
      { address: 't7', state: 'finished' },
      { address: 't8', status: { state: 'idle', app: 'codex' } },
      { address: 't9', status: { state: 'idle' } },
      { address: 't10', status: null },
    ]
    const hc = client()
    for (const address of ['t7', 't8', 't9', 't10']) {
      expect(await hc.prompt(address, 'claude', 'go'), address).toEqual({ outcome: 'failed', fault: 'not_that_agent' })
    }
    expect(await hc.prompt('t99', 'claude', 'go')).toEqual({ outcome: 'failed', fault: 'rejected', kind: 'not_found' })
    expect(methods(server)).toEqual(['terminal.get', 'terminal.get', 'terminal.get', 'terminal.get', 'terminal.get'])
  })

  it('the engine\'s kind is hc\'s app through the table', async () => {
    server.terminals = [
      { address: 't7', status: { state: 'idle', app: 'claude-code' } },
      { address: 't8', status: { state: 'idle', app: 'codex' } },
      { address: 't9', status: { state: 'idle', app: 'pi' } },
    ]
    const hc = client()
    expect(await hc.prompt('t7', 'claude', 'go')).toEqual({ outcome: 'sent' })
    expect(await hc.prompt('t8', 'codex', 'go')).toEqual({ outcome: 'sent' })
    expect(await hc.prompt('t9', 'pi', 'go')).toEqual({ outcome: 'sent' })
    expect(await hc.prompt('t7', 'claude-code', 'go')).toEqual({ outcome: 'failed', fault: 'not_that_agent' })
  })

  it('hc\'s refusals of the send come back with their kind, and nothing is sent twice', async () => {
    server.terminals = [{ address: 't7' }]
    const hc = client()
    const kinds = ['blocked', 'finished', 'unavailable', 'cancelled', 'config', 'invalid_params']
    for (const kind of kinds) {
      server.answer('terminal.send', { error: kind })
      expect(await hc.prompt('t7', 'claude', 'go'), kind).toEqual({ outcome: 'failed', fault: 'rejected', kind })
    }
    expect(methods(server)).toEqual(kinds.flatMap(() => ['terminal.get', 'terminal.send']))
  })

  it('a send with no answer in 75 s is failed, timeout, its connection closes, and nothing is sent again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.terminals = [{ address: 't7' }]
    server.answer('terminal.send', 'hold')
    let answered = false
    const sent = client().prompt('t7', 'claude', 'go').finally(() => { answered = true })
    await server.got('terminal.send', 1)
    vi.advanceTimersByTime(74_999)
    await turn()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await sent).toEqual({ outcome: 'failed', fault: 'timeout' })
    await server.ended(2)
    expect(methods(server)).toEqual(['terminal.get', 'terminal.send'])
  })

  it('a read that is no terminal, or another terminal\'s, is failed, bad_answer, and nothing is sent', async () => {
    server.terminals = [{ address: 't7' }]
    const hc = client()
    const read = (address?: string) => ({
      result: { ...(address ? { address } : {}), state: 'live', labels: { 'herdr.space': 's1' }, status: { state: 'idle', app: 'claude-code' } },
    })
    for (const answer of [read('t8'), read('vps/t7'), read()]) {
      server.answer('terminal.get', answer)
      expect(await hc.prompt('t7', 'claude', 'go'), JSON.stringify(answer)).toEqual({ outcome: 'failed', fault: 'bad_answer' })
    }
    expect(methods(server)).toEqual(['terminal.get', 'terminal.get', 'terminal.get'])
  })

  it('control characters become spaces', async () => {
    server.terminals = [{ address: 't7' }]
    expect(await client().prompt('t7', 'claude', 'fix it\nrm -rf /\u001b[2J')).toEqual({ outcome: 'sent' })
    expect((await server.got('terminal.send', 1)).request)
      .toMatchObject({ params: { terminal: 't7', text: 'fix it rm -rf / [2J', if: 'idle' } })
  })

  it('an empty text, one blank once its control characters are spaces, one over 2000 characters, an address or a kind not in its form: failed, bad_request, and nothing connects', async () => {
    server.terminals = [{ address: 't7' }]
    const hc = client()
    for (const [address, kind, text] of [
      ['t7', 'claude', ''],
      ['t7', 'claude', '\n\t'],
      ['t7', 'claude', 'x'.repeat(2001)],
      ['t', 'claude', 'go'],
      ['T7', 'claude', 'go'],
      ['vps/t7', 'claude', 'go'],
      ['--help', 'claude', 'go'],
      ['t7; rm -rf /', 'claude', 'go'],
      [`t${'1'.repeat(17)}`, 'claude', 'go'],
      ['t7', 'Claude', 'go'],
    ]) {
      expect(await hc.prompt(address, kind, text), `${address} ${kind} ${text.length}`).toEqual({ outcome: 'failed', fault: 'bad_request' })
    }
    expect(server.connections).toBe(0)
    expect(await hc.prompt('t7', 'claude', 'x'.repeat(2000))).toEqual({ outcome: 'sent' })
  })

  it('socketStamp is none without a socket of this user\'s on macOS', async () => {
    const file = join(dirname(server.path), 'file.sock')
    await writeFile(file, '')
    expect(client().socketStamp()).toEqual(expect.stringMatching(/^\d+:\d+$/))
    expect(client({ uid: process.getuid!() + 1 }).socketStamp()).toBeUndefined()
    expect(client({ platform: 'linux' }).socketStamp()).toBeUndefined()
    expect(client({ platform: 'win32' }).socketStamp()).toBeUndefined()
    expect(client({ socketPath: file }).socketStamp()).toBeUndefined()
    await server.stop()
    expect(client().socketStamp()).toBeUndefined()
  })
})
