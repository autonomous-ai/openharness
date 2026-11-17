// The Wi-Fi device in the devices' process (services/wifiProcess.ts): the core API it runs on across its link,
// built once the core names the machine, what the core tells it reaching its port in order, and its routes of the
// door, which the core hands on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, ServiceRequests, WifiPort } from '../core/api.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import type { WifiDeps } from './wifi.js'
import { runWifiService } from './wifiProcess.js'

// The real service and the real link, as a process started by the master runs them: stood in for here.
const real = vi.hoisted(() => ({ started: 0, options: null as ServiceProcessOptions | null }))
vi.mock('./wifi.js', () => ({ startWifi: () => { real.started++ } }))
vi.mock('./process.js', () => ({ runServiceProcess: (options: ServiceProcessOptions) => { real.options = options; return { stop: () => {} } } }))

/** A Wi-Fi port that records what reached it, in order. */
function wifiPort(machineId: string, log: string[]) {
  const record = (name: string) => (...args: unknown[]) => { log.push(`${machineId} ${name} ${JSON.stringify(args)}`) }
  const port: WifiPort = {
    session: record('session'), dropped: record('dropped'), revoked: record('revoked'), card: record('card'),
    turnEnded: record('turnEnded'), stream: record('stream'), transcript: record('transcript'),
    delivery: record('delivery'), agentGone: record('agentGone'),
    revealed: record('revealed'), events: record('events'), input: record('input'), disconnected: vi.fn(),
    // A request is taken only once the agents are listed: what the core says after it waits.
    request: vi.fn(async (...args: unknown[]) => { await new Promise((resolve) => setTimeout(resolve, 5)); record('request')(...args) }),
    appFocus: vi.fn(async (...args: unknown[]) => { record('appFocus')(...args) }),
    resume: vi.fn(async (...args: unknown[]) => { record('resume')(...args) }),
    stop: vi.fn(async () => { log.push(`${machineId} stop`) }),
  }
  return port
}

function setup(over: { startThrows?: boolean; leavesOff?: boolean } = {}) {
  const log: string[] = []
  const ports: WifiPort[] = []
  let api!: CoreApi
  let adapter!: WifiDeps
  /** Its routes of the door, as each start returned them. */
  const routes = vi.fn(async (payload: Record<string, unknown>) => ({ status: 200, body: { asked: payload.target } }))
  const start = vi.fn((core: CoreApi, given: CorePorts, deps?: WifiDeps): ServiceRequests => {
    adapter = deps!
    if (over.startThrows) throw new Error('journal unreadable')
    api = core
    if (over.leavesOff) return {}
    const port = wifiPort(core.machine.id(), log)
    ports.push(port)
    given.wifi = port
    return { wifi_http: routes }
  })
  let options!: ServiceProcessOptions
  const stop = vi.fn()
  const run = vi.fn((given: ServiceProcessOptions) => { options = given; return { stop } })
  const service = runWifiService({ dataDir: '/data', socketPath: '/sock', machineId: 'computer-9', token: 't', start, run })
  const notices: Array<[string, Record<string, unknown> | undefined]> = []
  let answers: Record<string, unknown> = { machine: { id: 'machine-1' }, input_contract: { version: 1 }, follow_agents: { agents: [] }, resolve: { value: { agentId: 'a', sessionId: 's', engine: 'claude' } } }
  const connection: CoreConnection = {
    query: vi.fn(async (query: string) => {
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    }),
    notice: (kind, payload) => { notices.push([kind, payload]) },
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30))
  return {
    service, start, routes, log, ports, api: () => api, adapter: () => adapter, options: () => options, stop, notices, connection, settled,
    answer: (query: string, value: unknown) => { answers = { ...answers, [query]: value } },
    connect: () => options.onConnected!(connection),
    disconnect: () => options.onDisconnected!(),
    event: (payload: Record<string, unknown>) => options.onEvent!(payload),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the Wi-Fi device in the devices\' process', () => {
  it('delivers only validated shared input facts and current agent lifecycle notices', async () => {
    const f = setup()
    f.answer('input_contract', { version: 1 }); f.answer('follow_agents', { agents: [] })
    f.connect(); f.event({ kind: 'resume' })
    const drain = () => f.options().requests!.wifi_http({}, { local: true, owner: true })
    await drain()
    const follow = vi.fn(), stop = f.api().agents.follow!(follow)
    const event = { agentId: 'a', deliveryId: 'd', when: 'composer', phase: 'written' }
    f.event({ kind: 'agent', event: { kind: 'ended', agentId: 'a' } })
    f.event({ kind: 'input', event: { ...event, phase: 'invented' } })
    f.event({ kind: 'input', event })
    f.event({ kind: 'dispatched', agentId: 'a', deliveryId: 'd', text: 'duplicate' })
    f.event({ kind: 'inputStatus', event: {} })
    f.event({ kind: 'disconnected' })
    await drain()
    expect(follow).toHaveBeenCalledExactlyOnceWith({ kind: 'ended', agentId: 'a' })
    expect(f.log.filter(line => line.includes(' input '))).toEqual([`machine-1 input [${JSON.stringify(event)}]`])
    expect(f.log.some(line => line.includes('dispatched') || line.includes('inputStatus'))).toBe(false)
    expect(f.ports[0].disconnected).toHaveBeenCalledOnce()
    expect(f.notices).toEqual([])
    f.event({ kind: 'input', event })
    f.event({ kind: 'agent', event: { kind: 'ended', agentId: 'b' } })
    f.disconnect(); f.connect()
    await drain()
    expect(follow).toHaveBeenCalledOnce()
    expect(f.log.filter(line => line.includes(' input '))).toHaveLength(1)
    stop()
  })

  it.each(['input_contract', 'machine', 'follow_agents'])('abandons a resume whose original connection ends during %s', async blocked => {
    const f = setup(), query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    f.answer('input_contract', { version: 1 })
    let release!: (answer: Record<string, unknown>) => void
    const held = new Promise<Record<string, unknown>>(resolve => { release = resolve })
    query.mockImplementation((name, payload) => name === blocked ? held : original(name, payload))
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(blocked, expect.any(Object)))
    f.disconnect()
    release(blocked === 'input_contract' ? { version: 1 } : blocked === 'machine' ? { id: 'machine-1' } : { agents: [] })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    expect(f.ports.every(port => vi.mocked(port.resume).mock.calls.length === 0)).toBe(true)
    expect(f.start).toHaveBeenCalledTimes(blocked === 'follow_agents' ? 1 : 0)
  })

  it('abandons a resume when the socket closes immediately after opening', async () => {
    const f = setup()
    f.connect(); f.event({ kind: 'resume' })
    // Let the resume reach its already-open socket before that socket closes.
    await Promise.resolve()
    f.disconnect()
    expect(await f.options().requests!.wifi_http({}, { local: true, owner: true })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    expect(f.connection.query).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'reconnected'])('does not send after context binding leaves the caller %s', async boundary => {
    const f = setup()
    f.answer('input_contract', { version: 1 }); f.answer('follow_agents', { agents: [] })
    f.answer('resolve', { value: { agentId: 'a', sessionId: 's', engine: 'claude' } })
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    let current = true
    const writing = f.adapter().submit!('a', 'hello', 'd', () => {
      if (boundary === 'revoked') current = false
      else { f.disconnect(); f.connect() }
    }, () => current)
    if (boundary === 'revoked') await writing
    else await expect(writing).rejects.toThrow('original core connection ended')
    expect(vi.mocked(f.connection.query).mock.calls.filter(([name]) => name === 'input')).toEqual([])
  })

  it('refuses disconnected input, and cancels only through the original shared contract', async () => {
    const f = setup()
    f.answer('input_contract', { version: 1 }); f.answer('follow_agents', { agents: [] })
    f.answer('resolve', { value: { agentId: 'a', sessionId: 's', engine: 'claude' } })
    f.answer('input', { error: 'SERVICE_UNAVAILABLE' })
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    await f.adapter().submit!('a', 'hello', 'd', () => {})
    expect(f.log).toContain('machine-1 delivery [{"sessionId":"a","deliveryId":"d","state":"unknown","reason":"NOT_CONFIRMED"}]')
    f.adapter().cancel!('d')
    await vi.waitFor(() => expect(f.connection.query).toHaveBeenCalledWith('cancel_delivery', { deliveryId: 'd' }))
    vi.mocked(f.connection.query).mockClear()
    const writing = f.adapter().submit!('a', 'hello', 'not-started', () => {})
    f.adapter().cancel!('cancel-after-disconnect')
    f.disconnect()
    await expect(writing).rejects.toThrow('original core connection ended')
    await expect(f.adapter().submit!('a', 'hello', 'offline', () => {})).rejects.toThrow('not connected to the core')
    f.adapter().cancel!('offline')
    expect(f.connection.query).not.toHaveBeenCalled()
    f.connect()
    f.answer('input_contract', new Error('connection failed'))
    f.adapter().cancel!('failed-contract')
    await vi.waitFor(() => expect(f.connection.query).toHaveBeenCalledWith('input_contract', {}))
    // A failed contract is consumed by the cancel path and never turns into a legacy notice.
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    expect(f.notices).toEqual([])
  })

  it('probes before input, reads one agent, and submits through the shared operation', async () => {
    const f = setup(), context = vi.fn()
    f.answer('input_contract', { version: 1 })
    f.answer('resolve', { value: { agentId: 'a', sessionId: 's', engine: 'codex', cliVersion: '0.106.0' } })
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    await f.adapter().submit!('a', 'hello', 'd', context)
    expect(context).toHaveBeenCalledWith({ agentId: 'a', sessionId: 's', engine: 'codex', cliVersion: '0.106.0' })
    const calls = vi.mocked(f.connection.query).mock.calls
    expect(calls.findIndex(([query]) => query === 'input_contract')).toBeLessThan(calls.findIndex(([query]) => query === 'resolve'))
    expect(f.connection.query).toHaveBeenCalledWith('resolve', { id: 'a' })
    expect(f.connection.query).toHaveBeenCalledWith('input', { agentId: 'a', text: 'hello', deliveryId: 'd', version: 1, when: 'composer' })
    expect(calls.filter(([query]) => query === 'submit')).toEqual([])
  })

  it('consumes a new batch once, its later stream, and an explicit cancel outside the legacy translation', async () => {
    const f = setup()
    f.answer('input_contract', { version: 1 }); f.answer('follow_agents', { agents: [] })
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.ports[0]?.resume).toHaveBeenCalledOnce())
    f.event({ kind: 'input_events', agentId: 'a', events: [] })
    f.event({ kind: 'turnStarted', agentId: 'a', legacy: true })
    f.event({ kind: 'stream', agentId: 'a', events: [] })
    f.event({ kind: 'turnEnded', agentId: 'a', aborted: true })
    await vi.waitFor(() => expect(f.log.at(-1)).toBe('machine-1 turnEnded ["a",true]'))
    expect(f.log.slice(1)).toEqual(['machine-1 events ["a",[]]', 'machine-1 stream ["a",[]]', 'machine-1 turnEnded ["a",true]'])
    f.disconnect()
    expect(f.ports[0].disconnected).toHaveBeenCalledOnce()
  })

  it.each(['resolve', 'input'])('does not carry a pending %s across a reconnect that reuses the query facade', async blocked => {
    const f = setup()
    f.answer('input_contract', { version: 1 })
    f.answer('resolve', { value: { agentId: 'a', sessionId: 's', engine: 'claude' } })
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    let release!: (value: Record<string, unknown>) => void
    const held = new Promise<Record<string, unknown>>(resolve => { release = resolve })
    const query = f.connection.query
    const original = vi.mocked(query).getMockImplementation()!
    vi.mocked(query).mockImplementation((name, payload) => name === blocked ? held : original(name, payload))
    const writing = f.adapter().submit!('a', 'hello', 'd', () => {})
    const rejected = expect(writing).rejects.toThrow('original core connection ended')
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(blocked, expect.any(Object)))
    f.disconnect(); f.connect()
    release(blocked === 'resolve' ? { value: { agentId: 'a', sessionId: 's', engine: 'claude' } } : {})
    await rejected
    const writes = vi.mocked(query).mock.calls.filter(([name]) => name === 'input' || name === 'submit')
    expect(writes).toHaveLength(blocked === 'resolve' ? 0 : 1)
  })

  it.each(['input_contract', 'resolve'])('does not submit a component reservation revoked during %s', async blocked => {
    const f = setup()
    f.answer('input_contract', { version: 1 })
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    if (blocked === 'input_contract') { f.disconnect(); f.connect() }
    const query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    let release!: (value: Record<string, unknown>) => void, current = true
    const held = new Promise<Record<string, unknown>>(resolve => { release = resolve })
    query.mockClear().mockImplementation((name, payload) => name === blocked ? held : original(name, payload))
    const writing = f.adapter().submit!('a', 'hello', 'd', () => {}, () => current)
    await vi.waitFor(() => expect(query).toHaveBeenCalledWith(blocked, expect.any(Object)))
    current = false
    release(blocked === 'input_contract' ? { version: 1 } : { value: { agentId: 'a', sessionId: 's', engine: 'claude' } })
    await writing
    expect(query.mock.calls.filter(([name]) => name === 'input' || name === 'submit')).toEqual([])
  })

  it.each([{}, { version: 2 }, { error: 'UNKNOWN_QUERY' }, { error: 'SERVICE_UNAVAILABLE' }, new Error('timeout')])('never falls back after an unconfirmed contract: %j', async answer => {
    const f = setup()
    f.answer('input_contract', answer)
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    await expect(f.adapter().submit!('a', 'hello', 'd', () => {})).rejects.toThrow()
    expect(vi.mocked(f.connection.query).mock.calls.filter(([query]) => ['resolve', 'submit', 'input'].includes(query))).toEqual([])
    f.event({ kind: 'input_events', agentId: 'a', events: [] })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    expect(f.log.some(line => line.includes(' events '))).toBe(false)
  })

  it('rejects a resolved different agent before any input and surfaces a safe shared refusal', async () => {
    const f = setup()
    f.answer('input_contract', { version: 1 })
    f.answer('resolve', { value: { agentId: 'other', sessionId: 's', engine: 'claude' } })
    f.connect(); f.event({ kind: 'resume' })
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce())
    const context = vi.fn()
    await f.adapter().submit!('a', 'hello', 'd', context)
    expect(context).not.toHaveBeenCalled()
    expect(f.log).toContain('machine-1 delivery [{"sessionId":"a","deliveryId":"d","state":"rejected","reason":"agent_gone"}]')
    f.answer('resolve', { value: { agentId: 'a', sessionId: 's', engine: 'claude' } })
    f.answer('input', { error: 'NOT_DELIVERY_OWNER' })
    await f.adapter().submit!('a', 'hello', 'next', context)
    expect(f.log).toContain('machine-1 delivery [{"sessionId":"a","deliveryId":"next","state":"rejected","reason":"NOT_DELIVERY_OWNER"}]')
    expect(vi.mocked(f.connection.query).mock.calls.filter(([query]) => query === 'submit')).toEqual([])
  })

  it('runs on a link of its own, and builds its service once the core names the machine', async () => {
    const f = setup()
    expect(f.options()).toMatchObject({ name: 'wifi', socketPath: '/sock', machineId: 'computer-9', token: 't' })
    // Nothing the core says reaches a service that is not built yet.
    f.event({ kind: 'turnEnded', agentId: 'a' })
    f.connect()
    f.event({ kind: 'resume', sessions: [{ connId: 'c', client: { role: 'device' } }], helloed: 'nope', focus: { machineId: 'm', agentId: 'a', connId: 'w' } })
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.api().machine.id()).toBe('machine-1')
    expect(f.api().machine.computerId()).toBe('computer-9')
    expect(f.api().machine.name()).toBe('')
    expect(f.log).toEqual([`machine-1 resume [{"sessions":[{"connId":"c","client":{"role":"device"}}],"helloed":[],"focus":{"machineId":"m","agentId":"a","connId":"w"}}]`])
    // The same machine on the next connection: the same service, resumed.
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.log.at(-1)).toBe('machine-1 resume [{"sessions":[],"helloed":[],"focus":null}]')
  })

  it('waits for its link to open before it answers the core\'s resume, which comes a moment before', async () => {
    const f = setup()
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).not.toHaveBeenCalled()
    f.connect()
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    // Gone and back: the next resume waits for the next link.
    f.disconnect()
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.log.filter((line) => line.includes('resume'))).toHaveLength(1)
    f.connect()
    await f.settled()
    expect(f.log.filter((line) => line.includes('resume'))).toHaveLength(2)
  })

  it('builds it again for another machine, and stops the old one', async () => {
    const f = setup()
    f.connect()
    f.event({ kind: 'resume' })
    await f.settled()
    f.answer('machine', { id: 'machine-2' })
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(2)
    expect(f.log).toContain('machine-1 stop')
    expect(f.api().machine.id()).toBe('machine-2')
  })

  it('hands everything the core says to the service in the order it was said, a request taken before what follows it', async () => {
    const f = setup()
    f.connect()
    f.event({ kind: 'resume' })
    f.event({ kind: 'session', connId: 'c', client: { role: 'device', identity: 'i' } })
    f.event({ kind: 'session', connId: 'c', client: 'gone' })
    f.event({ kind: 'request', connId: 'c', frame: { type: 'autonomous_device_request' }, opened: { payload: { type: 'hello' } } })
    f.event({ kind: 'request', connId: 'c', frame: 'x', opened: 'y' })
    f.event({ kind: 'card', frame: { type: 'commander_event' }, fullText: 'whole' })
    f.event({ kind: 'card', frame: { type: 'commander_event' }, fullText: 3 })
    f.event({ kind: 'turnStarted', agentId: 'a' })
    f.event({ kind: 'turnEnded', agentId: 'a', aborted: true })
    f.event({ kind: 'turnEnded', agentId: 'a' })
    f.event({ kind: 'stream', agentId: 'a', events: [{ type: 'text_delta' }] })
    f.event({ kind: 'stream', agentId: 'a', events: 'none' })
    f.event({ kind: 'input_events', agentId: 'a', events: [] })
    f.event({ kind: 'transcript', agentId: 'a', sessionId: 's', engine: 'claude', line: '{}' })
    f.event({ kind: 'delivery', event: { deliveryId: 'd' } })
    f.event({ kind: 'dispatched', agentId: 'a', deliveryId: 'd', text: 'hi', sessionId: 's' })
    f.event({ kind: 'dispatched', agentId: 'a', deliveryId: 'd', text: 'hi' })
    f.event({ kind: 'inputStatus', event: { deliveryId: 'd' } })
    f.event({ kind: 'agentGone', agentId: 'a' })
    f.event({ kind: 'appFocus', machineId: 'm', agentId: 'a', connId: 'w' })
    f.event({ kind: 'appFocus', machineId: 'm', agentId: null, connId: 'w' })
    f.event({ kind: 'revealed', operationId: 'op', agentId: 'a' })
    f.event({ kind: 'dropped', connId: 'c' })
    f.event({ kind: 'revoked', identity: 'i' })
    f.event({ kind: 'toString' })
    f.event({})
    await f.settled()
    expect(f.log.slice(1)).toEqual([
      'machine-1 session ["c",{"role":"device","identity":"i"}]',
      'machine-1 session ["c",null]',
      'machine-1 request ["c",{"type":"autonomous_device_request"},{"payload":{"type":"hello"}}]',
      'machine-1 request ["c",{},null]',
      'machine-1 card [{"type":"commander_event"},"whole"]',
      'machine-1 card [{"type":"commander_event"},null]',
      'machine-1 turnEnded ["a",true]',
      'machine-1 turnEnded ["a",false]',
      'machine-1 stream ["a",[{"type":"text_delta"}]]',
      'machine-1 stream ["a",[]]',
      'machine-1 events ["a",[]]',
      'machine-1 transcript ["a","s","claude","{}"]',
      'machine-1 delivery [{"deliveryId":"d"}]',
      'machine-1 agentGone ["a"]',
      'machine-1 appFocus ["m","a","w"]',
      'machine-1 appFocus ["m",null,"w"]',
      'machine-1 revealed ["op","a"]',
      'machine-1 dropped ["c"]',
      'machine-1 revoked ["i"]',
    ])
  })

  it('reaches the core through its Wi-Fi doors: asked, or told', async () => {
    const f = setup()
    f.connect()
    f.event({ kind: 'resume' })
    await f.settled()
    const wifi = f.api().wifi
    f.answer('view', { agents: [{ agentId: 'a' }], store: 'no', hasWindow: true })
    expect(await wifi.view()).toEqual({ agents: [{ agentId: 'a' }], store: [], hasWindow: true })
    expect(wifi.scroll('move', 2, 3)).toBe(true)
    expect(wifi.focusApp('a', 9, 'r')).toBe(true)
    f.answer('view', {})
    await wifi.view()
    // Without a window in the view the request being answered asked for, nothing is sent to one.
    expect(wifi.scroll('down', 0, 0)).toBe(false)
    expect(wifi.focusApp('a', 9, 'r')).toBe(false)
    f.answer('recent', { turns: [{ recap: 'x' }] })
    expect(await f.api().turns.recent('a', 2)).toEqual([{ recap: 'x' }])
    f.answer('stop', { ok: true })
    expect(await wifi.stop('a')).toBe(true)
    f.answer('answer', { ok: 'yes' })
    expect(await wifi.answer('a', 'r', { q: '1' })).toBe(false)
    // The question's id under a name of its own: the link's query has a `requestId` of its own.
    expect(f.connection.query).toHaveBeenCalledWith('answer', { agentId: 'a', questionRequestId: 'r', answers: { q: '1' } })
    f.answer('create', { requestId: 'x', ok: true, agentId: 'made' })
    expect(await wifi.create('p', 'claude', '/w')).toEqual({ ok: true, agentId: 'made' })
    f.answer('stepFocus', { step: 'no_app' })
    expect(await wifi.stepFocus('next')).toBe('no_app')
    f.answer('stepFocus', { step: 'no_agents' })
    expect(await wifi.stepFocus('previous', 'a')).toBe('no_agents')
    f.answer('stepFocus', { machineId: 'm', agentId: 'b' })
    expect(await wifi.stepFocus('next', 'a')).toEqual({ machineId: 'm', agentId: 'b' })
    f.answer('stepFocus', { machineId: 7 })
    expect(await wifi.stepFocus('next')).toEqual({ machineId: '', agentId: '' })
    await f.adapter().submit!('a', 'hi', 'd', () => {})
    expect(f.connection.query).toHaveBeenCalledWith('input', { version: 1, agentId: 'a', text: 'hi', deliveryId: 'd', when: 'composer' })
    f.adapter().cancel!('d')
    await Promise.resolve()
    wifi.reveal('op', 'a')
    wifi.send('c', 'i', 'autonomous_device_result', { ok: true })
    wifi.hello('c', 'i')
    wifi.joined()
    wifi.ready()
    wifi.unpaired('i')
    wifi.focus('r')
    wifi.transcripts('a', 1)
    wifi.watching(['a'])
    wifi.streams(['a'])
    expect(f.notices.map(([kind]) => kind)).toEqual(['scroll', 'focusApp', 'reveal', 'send', 'hello', 'joined',
      'ready', 'unpaired', 'focus', 'transcripts', 'watching', 'streams'])
    expect(f.notices[0][1]).toEqual({ phase: 'move', dy: 2, velocity: 3 })
    expect(f.notices.find(([kind]) => kind === 'send')![1]).toEqual({ connId: 'c', identity: 'i', type: 'autonomous_device_result', payload: { ok: true } })
    // The core gone: asked, it says so; told, nothing goes.
    f.disconnect()
    await expect(wifi.stop('a')).rejects.toThrow('the Wi-Fi device is not connected to the core')
    wifi.joined()
    expect(f.notices).toHaveLength(12)
  })

  it('answers its routes of the door once what the core said before is heard, and as down while it is not built', async () => {
    const f = setup()
    const route = f.options().requests!.wifi_http
    const asker = { local: true, owner: true }
    const receipt = { method: 'GET', target: '/api/autonomous-device/receipt?deviceId=d&idempotencyKey=k' }
    // Not answered: the core says what the route says while its service is down (core/api.ts `SERVICE_HTTP_ROUTES`).
    expect(await route(receipt, asker)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    f.connect()
    f.event({ kind: 'resume' })
    expect(await route(receipt, asker)).toEqual({ status: 200, body: { asked: receipt.target } })
    expect(f.routes).toHaveBeenCalledWith(receipt, asker, undefined)
  })

  it('leaves the Wi-Fi device off when its service does not start, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup({ startThrows: true })
    f.connect()
    f.event({ kind: 'resume' })
    f.event({ kind: 'turnEnded', agentId: 'a' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] did not start · journal unreadable')
    expect(await f.options().requests!.wifi_http({ method: 'GET', target: '/api/autonomous-device/addon/state' }, { local: true, owner: true })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    // A start that leaves its port empty is off too, and is tried again on the next connection.
    const g = setup({ leavesOff: true })
    g.connect()
    g.event({ kind: 'resume' })
    await g.settled()
    g.event({ kind: 'resume' })
    await g.settled()
    expect(g.start).toHaveBeenCalledTimes(2)
    // A start that throws something that is not an Error.
    const h = setup()
    h.start.mockImplementationOnce(() => { throw 'no' })
    h.connect()
    h.event({ kind: 'resume' })
    await h.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] did not start · no')
  })

  it('logs what fails while it hears the core, and goes on with what follows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup()
    f.connect()
    f.answer('machine', new Error('the core went away'))
    f.event({ kind: 'resume' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] the core went away')
    f.answer('machine', { id: 'machine-1' })
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    vi.mocked(f.ports[0].appFocus).mockRejectedValueOnce('not an error')
    f.event({ kind: 'appFocus', machineId: 'm', agentId: 'a', connId: 'w' })
    f.event({ kind: 'turnEnded', agentId: 'a' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] not an error')
    expect(f.log.at(-1)).toBe('machine-1 turnEnded ["a",false]')
  })

  it('stops its link and its service', async () => {
    const f = setup()
    await f.service.stop()
    expect(f.stop).toHaveBeenCalled()
    f.connect()
    f.event({ kind: 'resume' })
    await f.settled()
    await f.service.stop()
    expect(f.log.at(-1)).toBe('machine-1 stop')
  })

  it('runs the real service and link by default', async () => {
    runWifiService({ dataDir: '/data', socketPath: '/sock', machineId: 'c', token: 't' })
    real.options!.onConnected!({ query: async () => ({ id: 'machine-1' }) })
    real.options!.onEvent!({ kind: 'resume' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(real.started).toBe(1)
  })
})
