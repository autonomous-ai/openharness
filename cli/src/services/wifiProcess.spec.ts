// The Wi-Fi device in the devices' process (services/wifiProcess.ts): the core API it runs on across its link,
// built once the core names the machine, what the core tells it reaching its port in order, and the receipt
// the core asks of it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, WifiPort } from '../core/api.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
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
    turnStarted: record('turnStarted'), turnEnded: record('turnEnded'), stream: record('stream'), transcript: record('transcript'),
    delivery: record('delivery'), dispatched: record('dispatched'), inputStatus: record('inputStatus'), agentGone: record('agentGone'),
    revealed: record('revealed'),
    // A request is taken only once the agents are listed: what the core says after it waits.
    request: vi.fn(async (...args: unknown[]) => { await new Promise((resolve) => setTimeout(resolve, 5)); record('request')(...args) }),
    appFocus: vi.fn(async (...args: unknown[]) => { record('appFocus')(...args) }),
    resume: vi.fn(async (...args: unknown[]) => { record('resume')(...args) }),
    receipt: vi.fn(async () => ({ receipt: null })),
    stop: vi.fn(async () => { log.push(`${machineId} stop`) }),
  }
  return port
}

function setup(over: { startThrows?: boolean; leavesOff?: boolean } = {}) {
  const log: string[] = []
  const ports: WifiPort[] = []
  let api!: CoreApi
  const start = vi.fn((core: CoreApi, given: CorePorts) => {
    if (over.startThrows) throw new Error('journal unreadable')
    api = core
    if (over.leavesOff) return
    const port = wifiPort(core.machine.id(), log)
    ports.push(port)
    given.wifi = port
  })
  let options!: ServiceProcessOptions
  const stop = vi.fn()
  const run = vi.fn((given: ServiceProcessOptions) => { options = given; return { stop } })
  const service = runWifiService({ dataDir: '/data', socketPath: '/sock', machineId: 'computer-9', token: 't', start, run })
  const notices: Array<[string, Record<string, unknown> | undefined]> = []
  let answers: Record<string, unknown> = { machine: { id: 'machine-1' } }
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
    service, start, log, ports, api: () => api, options: () => options, stop, notices, connection, settled,
    answer: (query: string, value: unknown) => { answers = { ...answers, [query]: value } },
    connect: () => options.onConnected!(connection),
    disconnect: () => options.onDisconnected!(),
    event: (payload: Record<string, unknown>) => options.onEvent!(payload),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the Wi-Fi device in the devices\' process', () => {
  it('runs on a link of its own, and builds its service once the core names the machine', async () => {
    const f = setup()
    expect(f.options()).toMatchObject({ name: 'wifi', socketPath: '/sock', machineId: 'computer-9', token: 't' })
    // Nothing the core says reaches a service that is not built yet.
    f.event({ kind: 'turnStarted', agentId: 'a' })
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
      'machine-1 turnStarted ["a"]',
      'machine-1 turnEnded ["a",true]',
      'machine-1 turnEnded ["a",false]',
      'machine-1 stream ["a",[{"type":"text_delta"}]]',
      'machine-1 stream ["a",[]]',
      'machine-1 transcript ["a","s","claude","{}"]',
      'machine-1 delivery [{"deliveryId":"d"}]',
      'machine-1 dispatched ["a","d","hi","s"]',
      'machine-1 dispatched ["a","d","hi",null]',
      'machine-1 inputStatus [{"deliveryId":"d"}]',
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
    await wifi.submit('a', 'hi', 'd')
    expect(f.connection.query).toHaveBeenCalledWith('submit', { agentId: 'a', text: 'hi', deliveryId: 'd' })
    wifi.cancel('d')
    wifi.started('a', 'hi')
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
    expect(f.notices.map(([kind]) => kind)).toEqual(['scroll', 'focusApp', 'cancel', 'started', 'reveal', 'send', 'hello', 'joined',
      'ready', 'unpaired', 'focus', 'transcripts', 'watching', 'streams'])
    expect(f.notices[0][1]).toEqual({ phase: 'move', dy: 2, velocity: 3 })
    expect(f.notices.find(([kind]) => kind === 'send')![1]).toEqual({ connId: 'c', identity: 'i', type: 'autonomous_device_result', payload: { ok: true } })
    // The core gone: asked, it says so; told, nothing goes.
    f.disconnect()
    await expect(wifi.stop('a')).rejects.toThrow('the Wi-Fi device is not connected to the core')
    wifi.joined()
    expect(f.notices).toHaveLength(14)
  })

  it('answers the core\'s receipt question once what it said before is heard, and says unavailable with no service', async () => {
    const f = setup()
    const receipt = f.options().requests!.receipt
    expect(await receipt({ deviceId: 'd', idempotencyKey: 'k' }, { local: false, owner: false })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    f.connect()
    f.event({ kind: 'resume' })
    expect(await receipt({ deviceId: 'd', idempotencyKey: 'k' }, { local: false, owner: false })).toEqual({ receipt: null })
    expect(f.ports[0].receipt).toHaveBeenCalledWith('d', 'k')
  })

  it('leaves the Wi-Fi device off when its service does not start, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup({ startThrows: true })
    f.connect()
    f.event({ kind: 'resume' })
    f.event({ kind: 'turnStarted', agentId: 'a' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] did not start · journal unreadable')
    expect(await f.options().requests!.receipt({ deviceId: 'd', idempotencyKey: 'k' }, { local: false, owner: false })).toEqual({ error: 'SERVICE_UNAVAILABLE' })
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
    f.event({ kind: 'turnStarted', agentId: 'a' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] not an error')
    expect(f.log.at(-1)).toBe('machine-1 turnStarted ["a"]')
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
