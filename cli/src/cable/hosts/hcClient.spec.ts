import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeHc, RECORDED, type FakeHc } from '../../testing/fakeHc.js'
import {
  createHcClient, hcClientDeps, hcKind, hcSocketPath, hcTerminal,
  type HcClientDeps, type HcSubscriber,
} from './hcClient.js'
import { MAX_TEXT } from './orca.js'
import { connectLines } from './unixSocket.js'

/** hc's longest line, the bound of every connection to it: its snapshot is one line with every terminal of the core. */
const LINE_BYTES = 8 * 1024 * 1024
/** A 2 MiB line: a snapshot of many terminals, or one terminal with a long command line. */
const ARGV_2MIB = { more: { argv: ['x'.repeat(2 * 1024 * 1024)] } }
const lines = (recorded: readonly string[]) => `${recorded.join('\n')}\n`
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`
/** Lets what the socket has already said be told, with the timers faked or not. */
const turn = () => new Promise((resolve) => setImmediate(resolve))
const methods = (server: FakeHc) => server.requests.map(({ request }) => (request as { method: string }).method)

/** The recording's agent, at the turn its snapshot gave, and its hidden worker, as the client tells them: the worker's
 *  snapshot has no foreground yet. */
const agentIs = (status: string, turn = 2) =>
  ({ address: RECORDED.agent, live: true, space: true, status, kind: 'claude', cwd: '/work/hh', turn, foregroundPid: 4242 })
const WORKER = { address: RECORDED.worker, live: true, space: false, cwd: '/work/hh', turn: 0 }
/** A terminal of the fake's, Claude Code in its folder, as the client tells it: the fake counts turns from 0, and gives
 *  each terminal the next pid from 4242 as it first writes it. */
const fakeIs = (address: string, status: string, foregroundPid = 4242) => ({ ...agentIs(status, 0), address, foregroundPid })

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
    over: (count) => push(['over', count]),
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
    let closed = false
    const socket = connectLines(server.path, out, LINE_BYTES, (text) => {
      got.push(JSON.parse(text) as Record<string, unknown>)
      settle()
    }, () => {
      closed = true
      settle()
    })
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
      /** Once the connection has closed: every line written before the close has come. */
      ended: () => until(() => closed),
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
      name: 'api', cwd: '/work', foreground: { cwd: '/work/api' }, turn: 3,
    })).toEqual({ address: 't7', live: true, space: true, status: 'working', kind: 'codex', name: 'api', cwd: '/work/api', turn: 3 })
    expect(hcTerminal({
      address: 't7', state: 'finished', labels: { 'herdr.space': '' }, status: { app: 'Weird App', state: 'paused' }, name: null,
      cwd: '/work', foreground: { cwd: 7 }, turn: 0,
    })).toEqual({ address: 't7', live: false, space: false, cwd: '/work', turn: 0 })
    for (const turn of [-1, 1.5, '3', null, 2 ** 53]) {
      expect(hcTerminal({ address: 't7', turn }), String(turn)).toEqual({ address: 't7', live: false, space: false })
    }
    const longest = `t${'1'.repeat(16)}`
    expect(hcTerminal({ address: longest })).toEqual({ address: longest, live: false, space: false })
    for (const value of [undefined, null, 't7', [], {}, { address: 7 }, { address: 'vps/t7' }, { address: 'T7' }, { address: 't' },
      { address: `t${'1'.repeat(17)}` }]) {
      expect(hcTerminal(value), JSON.stringify(value)).toBeUndefined()
    }
  })

  it('hcTerminal reads its foreground\'s pid when it is a positive safe integer, and nothing else of its foreground', () => {
    expect(hcTerminal({ address: 't7', state: 'live', foreground: { argv: ['node'], cwd: '/w', name: 'node', pid: 4242 } }))
      .toEqual({ address: 't7', live: true, space: false, cwd: '/w', foregroundPid: 4242 })
  })

  // The terminal's own pid is its shell's: only the foreground is the program running now.
  it.each([
    ...[0, -1, 1.5, '4242', 2 ** 53, null].map((pid) => [`pid ${String(pid)}`, { foreground: { argv: ['node'], cwd: '/w', name: 'node', pid } }] as const),
    ['a foreground that is no object', { foreground: 7 }],
    ['no foreground, the terminal\'s own pid', { pid: 4242 }],
  ] as const)('hcTerminal reads no foreground pid of %s', (_what, fields) => {
    expect(hcTerminal({ address: 't7', state: 'live', ...fields })).not.toHaveProperty('foregroundPid')
  })

  // Herdr's window labels each terminal it holds with its tab, the id `herdr-app status` names for the tab on screen.
  it('hcTerminal reads the herdr.tab label as its tab; a missing, empty or other label is none', () => {
    const labeled = (labels: unknown) => hcTerminal({ address: 't7', state: 'live', labels })
    expect(labeled({ 'herdr.space': 'sp0123', 'herdr.tab': 'tbaaaa' })).toEqual({ address: 't7', live: true, space: true, tab: 'tbaaaa' })
    for (const labels of [{ 'herdr.space': 'sp0123' }, { 'herdr.tab': '' }, { 'herdr.tab': 7 }, { 'herdr.tab': null }, 'tbaaaa', null]) {
      expect(labeled(labels), JSON.stringify(labels)).not.toHaveProperty('tab')
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

  it('an answer under another id, or with neither result nor error, is bad_answer; a line that is no object is bad_json; one over 8 MiB is oversize', async () => {
    const hc = client()
    for (const [raw, fault] of [
      ['{"id":"another","jsonrpc":"2.0","result":{}}\n', 'bad_answer'],
      // hc's answer to a line it could not read is under null.
      ['{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"data":{"kind":"parse_error"},"message":"x"}}\n', 'bad_answer'],
      ['{"id":1,"jsonrpc":"2.0"}\n', 'bad_answer'],
      ['{"id":1,"jsonrpc":"2.0","result":"t7"}\n', 'bad_answer'],
      ['not json\n', 'bad_json'],
      ['[]\n', 'bad_json'],
      [`{"pad":"${'x'.repeat(LINE_BYTES)}"}\n`, 'oversize'],
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
      { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', name: 'api', cwd: '/work/api', turn: 0, foregroundPid: 4242 },
    ]]])
  })

  it('a subscription tells the foreground\'s pid and keeps nothing else new of it', async () => {
    server.answer('events.subscribe', { raw: lines(RECORDED.subscription.slice(0, 1)) })
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    subscription.close()
    const [, [agent]] = calls[0] as [string, Array<Record<string, unknown>>]
    expect(agent).toMatchObject({ address: RECORDED.agent, foregroundPid: 4242 })
    // No command line, no title, and the foreground's name is not the terminal's.
    expect(Object.keys(agent).sort()).toEqual(['address', 'cwd', 'foregroundPid', 'kind', 'live', 'space', 'status', 'turn'])
  })

  it('hc\'s own lines, in order, tell each change', async () => {
    server.answer('events.subscribe', { raw: lines(RECORDED.subscription) })
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    await fence()
    subscription.close()
    const worker = (live: boolean, space: boolean) => ({ ...WORKER, live, space, foregroundPid: 4243 })
    const created = (live: boolean, foregroundPid?: number) =>
      ({ address: 't3', live, space: true, cwd: '/work/hh', turn: 0, ...(foregroundPid ? { foregroundPid } : {}) })
    // The foreground lines name the folder each already had and tell the pid each brings; the title, keep, doc and
    // heartbeat lines change nothing told: each tells nothing. A turn line tells hc's count, which went up as the status
    // left working.
    expect(calls).toEqual([
      ['snapshot', [agentIs('idle'), WORKER]],
      ['changed', worker(true, false)],
      ['changed', agentIs('working')],
      ['changed', agentIs('blocked')],
      ['changed', agentIs('blocked', 3)],
      ['changed', agentIs('working', 3)],
      ['changed', agentIs('done', 3)],
      ['changed', agentIs('done', 4)],
      ['changed', agentIs('idle', 4)],
      ['changed', agentIs('error', 4)],
      ['changed', agentIs('idle', 4)],
      ['changed', worker(true, true)],
      ['changed', worker(true, false)],
      ['changed', created(true)],
      ['changed', created(true, 4244)],
      ['changed', worker(false, false)],
      ['changed', worker(false, false)],
      ['changed', created(false, 4244)],
      ['changed', created(false, 4244)],
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
      ['changed', { address: 't7', live: true, space: true, status: 'working', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 4242 }],
      ['changed', { address: 't7', live: true, space: false, status: 'working', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 4242 }],
    ])
  })

  // A terminal moved to another tab is matched there (dial-herdr-scroll-design.md §3).
  it('the herdr.tab label is kept, and a labels event that changes it alone tells the terminal', async () => {
    const labels = (tab?: string) => ({ 'herdr.space': 'sp0123', ...(tab ? { 'herdr.tab': tab } : {}) })
    server.terminals = [{ address: 't7', cwd: '/work/api', labels: labels('tbaaaa') }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('t7', { labels: labels('tbbbbb') })
    server.change('t7', { labels: labels() })
    // A change every build tells, so the test ends on what was told of those before it.
    server.change('t7', { status: { state: 'working', app: 'claude-code' } })
    await vi.waitFor(() => expect(calls.at(-1)).toEqual(['changed', expect.objectContaining({ status: 'working' })]))
    subscription.close()
    const t7 = { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 4242 }
    expect(calls).toEqual([
      ['snapshot', [{ ...t7, tab: 'tbaaaa' }]],
      ['changed', { ...t7, tab: 'tbbbbb' }],
      ['changed', t7],
      ['changed', { ...t7, status: 'working' }],
    ])
  })

  describe('lost and restarted, which Task 1 could not record (F8), are read as the whole terminal they carry, as created is', () => {
    /** The kind's line, its data the terminal the fake holds, whole, with `over` on it; and what the client told of it. */
    async function told(kind: string, over: Record<string, unknown>) {
      server.terminals = [{ address: 't7', cwd: '/work/api', status: { state: 'working', app: 'claude-code' } }]
      const read = await client().request('terminal.get', { terminal: 't7' })
      const { calls, to, told: until } = subscriber()
      const subscription = client().subscribe(to)
      await until(1)
      server.event(kind, { data: { ...(read.ok ? read.result : {}), ...over }, terminal: 't7' })
      await until(2)
      subscription.close()
      return calls[1]
    }

    it('lost: a terminal whose holder was lost, no longer live', async () => {
      expect(await told('lost', { state: 'lost' }))
        .toEqual(['changed', { address: 't7', live: false, space: true, status: 'working', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 4242 }])
    })

    it('restarted: a terminal started again, its program not yet reporting', async () => {
      expect(await told('restarted', { name: 'api', reported: false, status: null }))
        .toEqual(['changed', { address: 't7', live: true, space: true, name: 'api', cwd: '/work/api', turn: 0, foregroundPid: 4242 }])
    })
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
      ['changed', { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/api/web', turn: 0, foregroundPid: 4242 }],
      ['changed', { address: 't7', live: true, space: true, status: 'done', kind: 'claude', cwd: '/work/api/web', turn: 0, foregroundPid: 4242 }],
    ])
  })

  it('a foreground line that changes only its pid is told; the same pid again tells nothing', async () => {
    server.terminals = [{ address: 't7', cwd: '/work/api' }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    const foreground = { data: { argv: ['/usr/local/bin/node'], cwd: '/work/api', name: 'node', pid: 5000 }, terminal: 't7' }
    server.event('foreground', foreground)
    server.event('foreground', foreground)
    server.change('t7', { status: { state: 'done', app: 'claude-code' } })
    await told(3)
    subscription.close()
    expect(calls.slice(1)).toEqual([
      ['changed', { address: 't7', live: true, space: true, status: 'idle', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 5000 }],
      ['changed', { address: 't7', live: true, space: true, status: 'done', kind: 'claude', cwd: '/work/api', turn: 0, foregroundPid: 5000 }],
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
    // The fake wrote vps/t3 first, with 4242.
    expect(calls).toEqual([
      ['snapshot', [fakeIs('t7', 'idle', 4243)]],
      ['changed', fakeIs('t7', 'working', 4243)],
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
    const ended = { address: RECORDED.agent, live: false, space: true, cwd: '/work/hh', turn: 10005, foregroundPid: 4242 }
    expect(calls).toEqual([
      ['snapshot', [fakeIs('t7', 'idle')]],
      ['snapshot', [agentIs('idle', 10005)]],
      ['changed', { address: RECORDED.agent, live: true, space: true, cwd: '/work/hh', turn: 10005, foregroundPid: 4242 }],
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

  it('a doc line tells nothing and the next event is still told; a line over 8 MiB closes the subscription oversize', async () => {
    server.terminals = [{ address: 't7' }]
    const { calls, to, told } = subscriber()
    client().subscribe(to)
    await told(1)
    server.event('doc')
    server.event('doc', { data: { name: 'herdr-app', version: 9 } })
    server.change('t7', { status: { state: 'working', app: 'claude-code' } })
    await told(2)
    server.send(`{"pad":"${'x'.repeat(LINE_BYTES)}"}\n`)
    server.change('t7', { status: { state: 'idle', app: 'claude-code' } })
    await told(3)
    await server.ended(1)
    await turn()
    expect(calls).toEqual([
      ['snapshot', [fakeIs('t7', 'idle')]],
      ['changed', fakeIs('t7', 'working')],
      ['closed', 'oversize'],
    ])
  })

  it('a 2 MiB snapshot is told, and a 2 MiB terminal.get read', async () => {
    server.terminals = [{ address: 't7', ...ARGV_2MIB }]
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    subscription.close()
    expect(calls).toEqual([['snapshot', [fakeIs('t7', 'idle')]]])
    expect(await client().request('terminal.get', { terminal: 't7' }))
      .toEqual({ ok: true, result: expect.objectContaining({ address: 't7', argv: ARGV_2MIB.more.argv }) })
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

  it('past 1,024 terminals a new one is neither kept nor told; how many were left out is told as it changes', async () => {
    server.terminals = Array.from({ length: 1025 }, (_, at) => ({ address: `t${at + 1}` }))
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('t2000', {})
    server.change('t1025', { status: { state: 'working', app: 'claude-code' } })
    server.remove('t1')
    server.change('t2001', {})
    // A fresh snapshot counts again.
    server.terminals = server.terminals.slice(0, 2)
    server.missed()
    await fence()
    subscription.close()
    const idle = (address: string, pid: number) => fakeIs(address, 'idle', pid)
    const t2001 = { address: 't2001', live: true, space: true, cwd: '/work/hh', turn: 0 }
    expect(calls).toEqual([
      ['snapshot', Array.from({ length: 1024 }, (_, at) => idle(`t${at + 1}`, 4242 + at))],
      ['over', 1],
      // Created past the bound; a line of a terminal left out counts nothing more.
      ['over', 2],
      ['changed', { ...idle('t1', 4242), live: false }],
      // Created before its program reports, then its foreground (t2000 took the pid before it), then its first status.
      ['changed', t2001],
      ['changed', { ...t2001, foregroundPid: 5268 }],
      ['changed', idle('t2001', 5268)],
      ['snapshot', [idle('t2', 4243), idle('t3', 4244)]],
      ['over', 0],
    ])
  })

  it('a terminal left out past 1,024 that is removed is one fewer left out, created past the bound or in the snapshot', async () => {
    server.terminals = Array.from({ length: 1025 }, (_, at) => ({ address: `t${at + 1}` }))
    const { calls, to, told } = subscriber()
    const subscription = client().subscribe(to)
    await told(1)
    server.change('t2000', {})
    server.remove('t2000')
    server.remove('t1025')
    await fence()
    subscription.close()
    expect(calls.slice(1)).toEqual([['over', 1], ['over', 2], ['over', 1], ['over', 0]])
  })

  describe('closed is told once, and nothing after it', () => {
    // An event follows each bad line, and is never told.
    const thenEvent = (chunk: string) => `${chunk}${RECORDED.subscription[2]}\n`
    it.each([
      ['ended', 'a dropped connection', () => server.drop()],
      ['oversize', 'a line over 8 MiB', () => server.send(thenEvent(`${'x'.repeat(LINE_BYTES + 1)}\n`))],
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

  it('the fake server answers as hc did in the recording, under the recording\'s own id', async () => {
    // The recording's agent, with the fields its read held that the fake writes no default for.
    server.terminals = [{ address: RECORDED.agent, more: { status_ms: 1_700_000_071_953, title: 'fake title', turn: 4 } }]
    const asked = async (method: string, params: Record<string, unknown>) => {
      const connection = raw(rpc(1, method, params))
      await connection.lines(1)
      connection.socket.destroy()
      return connection.got[0]
    }
    const send = (more: Record<string, unknown> = {}) => asked('terminal.send', { terminal: RECORDED.agent, text: 'go', ...more })
    expect(await asked('hello', { generation: 2 })).toEqual(JSON.parse(RECORDED.helloRefused))
    expect(await asked('terminal.get', { terminal: RECORDED.agent })).toEqual(JSON.parse(RECORDED.get))
    expect(await asked('terminal.get', { terminal: 't99' })).toEqual(JSON.parse(RECORDED.getUnknown))
    expect(await send({ if: 'idle' })).toEqual(JSON.parse(RECORDED.sent))
    server.terminals[0].status = { state: 'working', app: 'claude-code' }
    expect(await send({ if: 'idle' })).toEqual(JSON.parse(RECORDED.mismatch))
    server.terminals[0].status = { state: 'blocked', app: 'claude-code' }
    expect(await send()).toEqual(JSON.parse(RECORDED.blocked))
    server.terminals[0].state = 'finished'
    expect(await send()).toEqual(JSON.parse(RECORDED.finished))
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

  it('the fake server, as hc, answers a connection\'s requests in order: after one it holds, nothing more there (F4)', async () => {
    server.terminals = [{ address: 't7' }]
    server.answer('hello', 'hold')
    const connection = raw(`${rpc(1, 'hello', { generation: 1 })}${rpc(2, 'terminal.get', { terminal: 't7' })}`)
    await server.got('terminal.get', 1)
    await server.stop()
    await connection.ended()
    expect(connection.got).toEqual([])
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

  it('an empty text, one blank once its control characters are spaces, one over MAX_TEXT characters, an address or a kind not in its form: failed, bad_request, and nothing connects', async () => {
    server.terminals = [{ address: 't7' }]
    const hc = client()
    for (const [address, kind, text] of [
      ['t7', 'claude', ''],
      ['t7', 'claude', '\n\t'],
      ['t7', 'claude', 'x'.repeat(MAX_TEXT + 1)],
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
  })

  it('a text of 20,000 characters is sent whole', async () => {
    server.terminals = [{ address: 't7' }]
    expect(await client().prompt('t7', 'claude', 'x'.repeat(20_000))).toEqual({ outcome: 'sent' })
    expect((await server.got('terminal.send', 1)).request).toMatchObject({ params: { terminal: 't7', text: 'x'.repeat(20_000) } })
  })

  // A Claude Code terminal draws on the alternate screen, so the dial's scroll presses its own page keys
  // (docs/plans/2026-11-17-dial-herdr-scroll-design.md §3).
  it('keys sends terminal.keys with the terminal and exactly those names, and is true only for hc\'s result', async () => {
    const hc = client()
    server.answer('terminal.keys', { result: { status: 'idle', turn: 0 } })
    expect(await hc.keys('t7', ['pageup', 'pageup'], 2_000)).toBe(true)
    expect(server.requests).toEqual([
      { connection: 1, request: { jsonrpc: '2.0', id: expect.any(String), method: 'terminal.keys', params: { terminal: 't7', keys: ['pageup', 'pageup'] } } },
    ])
    for (const answer of [{ error: 'not_found' }, { raw: 'not json\n' }, { raw: '{"id":1,"jsonrpc":"2.0"}\n' }, 'close'] as const) {
      server.answer('terminal.keys', answer)
      expect(await hc.keys('t7', ['pagedown'], 2_000), JSON.stringify(answer)).toBe(false)
    }
  })

  it('keys with no answer within the deadline it is given is false, and its connection closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    server.answer('terminal.keys', 'hold')
    let answered = false
    const pressed = client().keys('t7', ['pageup'], 2_000).finally(() => { answered = true })
    await server.got('terminal.keys', 1)
    vi.advanceTimersByTime(1_999)
    await turn()
    expect(answered).toBe(false)
    vi.advanceTimersByTime(1)
    expect(await pressed).toBe(false)
    await server.ended(1)
  })

  it('keys to an address not in its form is false, and nothing connects', async () => {
    const hc = client()
    for (const address of ['t', 'T7', 'vps/t7', '--help', 't7; rm -rf /', `t${'1'.repeat(17)}`]) {
      expect(await hc.keys(address, ['pageup'], 2_000), address).toBe(false)
    }
    expect(server.connections).toBe(0)
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
