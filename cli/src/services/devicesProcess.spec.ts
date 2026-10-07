// The devices in a process of their own (services/devicesProcess.ts): the core API they run on across their
// link, what the core tells them reaching the devices' port, and what the core asks answered from it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, DevicesPort, ServiceRequests } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { DevicesDeps } from './devices.js'
import { runDevicesService } from './devicesProcess.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'

// The real devices and the real link, as a process started by the master runs them: stood in for here.
const real = vi.hoisted(() => ({ started: [] as unknown[], linked: [] as unknown[] }))
vi.mock('./devices.js', () => ({
  startDevices: (_core: unknown, ports: { devices: unknown }) => { real.started.push(ports); ports.devices = { stop: async () => {} }; return {} },
}))
vi.mock('./process.js', () => ({
  runServiceProcess: (options: unknown) => { real.linked.push(options); return { stop: () => {} } },
}))

/** A devices' port that records what reached it. */
function devicesPort() {
  const calls: Array<[string, unknown[]]> = []
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, args]) }
  const port = {
    card: record('card'), desk: record('desk'), swarms: record('swarms'), unread: record('unread'), appFocus: record('appFocus'),
    seen: record('seen'), settings: record('settings'), windowFocus: record('windowFocus'), windowReply: record('windowReply'),
    voiceReply: record('voiceReply'), windowGone: record('windowGone'), scroll: record('scroll'), engines: record('engines'),
    commanders: record('commanders'),
    routeTask: vi.fn(async (text: string) => ({ agentId: 'a1', machineId: 'm1', name: 'api', confidence: 1, reason: text, candidates: [], weighed: 1, machines: 1, via: 'model' })),
    routeSend: vi.fn(async () => ({ ok: true as const })),
    stepFocus: vi.fn(async (): Promise<{ machineId: string; agentId: string } | 'no_agents'> => ({ machineId: 'm1', agentId: 'a2' })),
    stop: vi.fn(async () => {}),
  } satisfies DevicesPort
  return { port, calls }
}

function setup(over: { processEnv?: NodeJS.ProcessEnv } = {}) {
  const { port, calls } = devicesPort()
  let api!: CoreApi
  let deps!: DevicesDeps
  const tab = { harness_devices_list: vi.fn(async () => ({ protocol: 1 })) }
  const start = vi.fn((core: CoreApi, ports: CorePorts, given: DevicesDeps): ServiceRequests => {
    api = core
    deps = given
    ports.devices = port
    return tab
  })
  let options!: ServiceProcessOptions
  const stop = vi.fn()
  const run = vi.fn((given: ServiceProcessOptions) => { options = given; return { stop } })
  const service = runDevicesService({
    dataDir: '/data', socketPath: '/sock', machineId: 'computer-9', token: 't',
    start, run, processEnv: over.processEnv ?? {},
  })
  const queries: Array<[string, Record<string, unknown> | undefined]> = []
  const notices: Array<[string, Record<string, unknown> | undefined]> = []
  let answers: Record<string, unknown> = {}
  const connection: CoreConnection = {
    query: vi.fn(async (query: string, payload?: Record<string, unknown>) => {
      queries.push([query, payload])
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    }),
    notice: (kind, payload) => { notices.push([kind, payload]) },
  }
  return {
    service, port, calls, api: () => api, deps: () => deps, options: () => options, stop, tab, queries, notices, connection,
    answer: (query: string, value: unknown) => { answers = { ...answers, [query]: value } },
    connect: () => options.onConnected!(connection),
    event: (payload: Record<string, unknown>) => options.onEvent!(payload),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the devices in their own process', () => {
  it('start the devices on a link of their own, with what their process\'s environment says', () => {
    const f = setup({ processEnv: { HARNESS_DIAL_SERIALS: ' AA, ,BB ', HARNESSD_TEST_DIAL_PORT: '/dev/ttys042', HARNESSD_TEST_FAULTS: 'dial, fleet.knows ,' } })
    expect(f.options()).toMatchObject({ name: 'devices', socketPath: '/sock', machineId: 'computer-9', token: 't' })
    expect(f.deps()).toMatchObject({ dialSerials: ['AA', 'BB'], testDialPort: '/dev/ttys042' })
    // No credential and no E2EE identity: the account is asked of the core.
    expect(Object.keys(f.deps())).not.toContain('identity')
    expect([...f.deps().faults!]).toEqual(['dial', 'fleet.knows'])
    // The Devices tab's requests are the devices' own, beside what only the core asks.
    expect(Object.keys(f.options().requests).sort()).toEqual(['harness_devices_list', 'routeSend', 'routeTask', 'stepFocus'])
  })

  it('read no serials, dial or faults without them', () => {
    const f = setup({ processEnv: {} })
    expect(f.deps().dialSerials).toBeUndefined()
    expect([...f.deps().faults!]).toEqual([])
    // Their own process's environment by default.
    const was = process.env.HARNESSD_TEST_DIAL_PORT
    process.env.HARNESSD_TEST_DIAL_PORT = '/dev/ttys777'
    try {
      let deps!: DevicesDeps
      runDevicesService({ dataDir: '/data', socketPath: '/sock', machineId: 'c', token: 't',
        start: (_core, ports, given) => { deps = given; ports.devices = devicesPort().port; return {} }, run: () => ({ stop: () => {} }) })
      expect(deps.testDialPort).toBe('/dev/ttys777')
    } finally {
      if (was === undefined) delete process.env.HARNESSD_TEST_DIAL_PORT
      else process.env.HARNESSD_TEST_DIAL_PORT = was
    }
  })

  it('run the devices and their link as the master starts them', () => {
    runDevicesService({ dataDir: '/data', socketPath: '/sock', machineId: 'c', token: 't' })
    expect(real.started).toHaveLength(1)
    expect(real.linked).toEqual([expect.objectContaining({ name: 'devices', socketPath: '/sock', token: 't' })])
  })

  it('stop their link, then the devices, serial ports first', async () => {
    const f = setup()
    await f.service.stop()
    expect(f.stop).toHaveBeenCalled()
    expect(f.port.stop).toHaveBeenCalled()
  })
})

describe('the core\'s view, read in line by the dial', () => {
  const agent = { agentId: 'a1', sessionId: 's1', engine: 'claude', displayName: 'api', runtimeProfile: 'runtime-v1:s1:claude:opus@high' }

  it('is nothing but this computer\'s id before the core is asked', async () => {
    const f = setup()
    const api = f.api()
    expect(api.agents.advertised()).toEqual([])
    expect(api.machine.computerId()).toBe('computer-9')
    expect(api.machine.name()).toBe('This machine')
    expect(api.account.signedIn()).toBe(false)
    // Not connected: refreshing asks nothing, and a question to the core fails at once.
    await f.deps().refresh!()
    expect(f.queries).toEqual([])
    await expect(api.agents.activityText('a1')).rejects.toThrow('the devices are not connected to the core')
  })

  it('is asked as the core connects, and again as the dial\'s tick or ⌘K needs it, one ask at a time', async () => {
    const f = setup()
    f.answer('view', { agents: [agent], machine: { id: 'machine-1', computerId: 'computer-1', name: 'Studio' }, signedIn: true, environment: 'prod', hasWindow: true })
    f.connect()
    await vi.waitFor(() => expect(f.api().agents.advertised()).toHaveLength(1))
    const api = f.api()
    const session = api.agents.advertised()[0]
    expect(api.agents.all()).toEqual([agent])
    expect(api.agents.live()).toEqual([agent])
    expect(api.agents.displayName(session)).toBe('api')
    expect(api.agents.displayName({ agentId: 'x' } as RegisteredSession)).toBe('')
    expect(api.agents.runtimeProfile(session)).toBe('runtime-v1:s1:claude:opus@high')
    expect(api.agents.runtimeProfile({ agentId: 'x' } as RegisteredSession)).toBeNull()
    expect(api.agents.byAgent('a1')).toEqual(agent)
    expect(api.agents.resolve('s1')).toEqual(agent)
    expect(api.agents.terminalAvailable('a1')).toBe(true)
    api.agents.sync(session)
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['machine-1', 'computer-1', 'Studio'])
    expect(api.account.signedIn()).toBe(true)
    expect(api.account.environment()).toBe('prod')
    expect(api.clients.hasWindow()).toBe(true)
    // Asked twice at once: one ask.
    const before = f.queries.length
    await Promise.all([f.deps().refresh!(), f.deps().refresh!()])
    expect(f.queries.length).toBe(before + 1)
    // An answer that is not a view changes nothing; one that is missing names keeps the defaults.
    f.answer('view', { error: 'QUERY_FAILED' })
    await f.deps().refresh!()
    expect(api.agents.advertised()).toHaveLength(1)
    f.answer('view', { agents: [], machine: 'nothing' })
    await f.deps().refresh!()
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['', 'computer-9', 'This machine'])
    // An ask the core never answers (it went away) leaves the last view.
    f.answer('view', new Error('the core went away'))
    await f.deps().refresh!()
    expect(api.machine.computerId()).toBe('computer-9')
  })
})

describe('the core\'s doors, across the link', () => {
  it('ask the core for what needs an answer, and tell it the rest', async () => {
    const f = setup()
    f.connect()
    const api = f.api()
    f.answer('models', { models: [{ id: 'opus' }] })
    expect(await api.agents.runtimeModels('a1')).toEqual([{ id: 'opus' }])
    f.answer('models', {})
    expect(await api.agents.runtimeModels('a1')).toEqual([])
    f.answer('fork', { requestId: 'r', ok: true, agentId: 'a2' })
    expect(await api.agents.fork('a1')).toEqual({ ok: true, agentId: 'a2' })
    f.answer('activityText', { text: 'Reading' })
    expect(await api.agents.activityText('a1')).toBe('Reading')
    f.answer('activityText', { text: null })
    expect(await api.agents.activityText('a1')).toBeNull()
    f.answer('recent', { turns: [{ recap: 'done' }] })
    expect(await api.turns.recent('a1', 2)).toEqual([{ recap: 'done' }])
    f.answer('recent', {})
    expect(await api.turns.recent('a1', 2)).toEqual([])
    f.answer('asks', { asks: ['why?', 7] })
    expect(await api.turns.asks('a1')).toEqual(['why?'])
    f.answer('answerReviewed', { ok: true })
    expect(await api.questions.answerReviewed({ agentId: 'a1' } as never)).toBe(true)
    // The account through the link every service in its own process uses (services/accountLink.ts).
    f.answer('access_token', { token: 'secret' })
    expect(await api.account.accessToken({ force: true })).toBe('secret')
    expect(f.queries.at(-1)).toEqual(['access_token', { force: true }])
    f.answer('lane', { frame: { type: 'message', sealed: true } })
    expect(await api.account.lane.seal('m2', { type: 'message' })).toEqual({ frame: { type: 'message', sealed: true } })
    expect(f.queries.at(-1)).toEqual(['lane', { machineId: 'm2', frame: { type: 'message' }, op: 'seal' }])
    f.answer('machines', { status: 200, body: { data: { machines: [] } } })
    expect(await api.account.machines()).toEqual({ status: 200, body: { data: { machines: [] } } })
    f.answer('machines', { body: 'broken' })
    expect(await api.account.machines()).toEqual({ status: 502, body: {} })
    api.agents.setRuntime('a1', 'opus', 'high')
    api.turns.send('a1', 'hello')
    api.turns.stop('a1')
    api.questions.answer('a1', 'r1', { q: 'Coffee' })
    api.clients.sendLocal({ type: 'dial_focus', payload: {} })
    expect(api.clients.sendToWindow('w1', { type: 'dial_form', payload: {} })).toBe(true)
    api.clients.devicesChanged({ revision: 1 })
    api.clients.dialWatching(true)
    // What an experiment acts on the core through, the devices never do.
    api.clients.windows({ type: 'orchestrator_changed', payload: {} })
    expect(api.daemon.port).toBe(0)
    expect(f.notices).toEqual([
      ['setRuntime', { agentId: 'a1', model: 'opus', effort: 'high' }],
      ['turn', { agentId: 'a1', text: 'hello' }],
      ['stop', { agentId: 'a1' }],
      ['answer', { agentId: 'a1', requestId: 'r1', answers: { q: 'Coffee' } }],
      ['sendLocal', { frame: { type: 'dial_focus', payload: {} } }],
      ['sendToWindow', { connId: 'w1', frame: { type: 'dial_form', payload: {} } }],
      ['devicesChanged', { revision: 1 }],
      ['dialWatching', { watching: true }],
    ])
    // What the devices never ask answers as every other service's does.
    expect(api.transcripts.databaseHistory({} as RegisteredSession)).toBeUndefined()
    expect(api.external.sessions.list()).toEqual([])
    await expect(api.account.mintGridName()).resolves.toBeNull()
    // Gone from the core: told nothing, and a bridge's ask says it did not go.
    f.options().onDisconnected!()
    api.turns.send('a1', 'lost')
    expect(api.clients.sendToWindow('w1', { type: 'dial_form', payload: {} })).toBe(false)
    expect(f.notices).toHaveLength(8)
  })
})

describe('what the core tells the devices, reaching their port', () => {
  it('is each kind of notice, read as the port takes it', () => {
    const f = setup()
    const focus = { voice: { machineId: 'm1', agentId: 'a1', connId: 'w1' }, form: { machineId: 'm1', connId: 'w1' } }
    for (const payload of [
      { kind: 'card', frame: { type: 'commander_event' } },
      { kind: 'card', frame: 'not one' },
      { kind: 'desk', agentIds: ['a1', 7], foreground: false },
      { kind: 'desk', agentIds: 'nonsense' },
      { kind: 'swarms', swarms: { active: 't1', swarms: [], tiles: [] } },
      { kind: 'swarms', swarms: null },
      { kind: 'unread', items: [{ agentId: 'a1' }] },
      { kind: 'unread', items: 'nonsense' },
      { kind: 'appFocus', machineId: 'm1', agentId: 'a1' },
      { kind: 'seen', agentId: 'a1', readToken: 'tok' },
      { kind: 'seen', agentId: 'a1' },
      { kind: 'settings', id: 'usb', patch: { brightness: 3 } },
      { kind: 'settings', id: 'usb', patch: [1] },
      { kind: 'windowFocus', focus },
      { kind: 'windowFocus', focus: { voice: { connId: 'w2' }, form: 'nonsense' } },
      { kind: 'windowReply', which: 'form', connId: 'w1', machineId: 'm1', reply: { ok: true } },
      { kind: 'windowReply', which: 'visit', connId: 'w1', machineId: 'm1', reply: null },
      { kind: 'windowReply', which: 'anything', connId: 'w1', machineId: 'm1', reply: {} },
      { kind: 'voiceReply', voiceId: 'v1', reply: { t: 'taken' } },
      { kind: 'windowGone', connId: 'w1' },
      { kind: 'scroll', phase: 'move', dy: 2, velocity: Infinity },
      { kind: 'scroll', phase: 'sideways', dy: 2, velocity: 1 },
      { kind: 'engines', engines: ['claude'] },
      { kind: 'commanders', connected: true },
      { kind: 'nothing it knows' },
      { kind: 'constructor' },
    ]) f.event(payload)
    expect(f.calls).toEqual([
      ['card', [{ type: 'commander_event' }]],
      ['card', [{}]],
      ['desk', [['a1'], false]],
      ['desk', [[], true]],
      ['swarms', [{ active: 't1', swarms: [], tiles: [] }]],
      ['swarms', [null]],
      ['unread', [[{ agentId: 'a1' }]]],
      ['unread', [[]]],
      ['appFocus', ['m1', 'a1']],
      ['seen', ['a1', 'tok']],
      ['seen', ['a1', undefined]],
      ['settings', ['usb', { brightness: 3 }]],
      ['settings', ['usb', {}]],
      ['windowFocus', [focus]],
      ['windowFocus', [{ voice: { machineId: '', agentId: '', connId: 'w2' }, form: null }]],
      ['windowReply', ['form', 'w1', 'm1', { ok: true }]],
      ['windowReply', ['visit', 'w1', 'm1', {}]],
      ['windowReply', ['selection', 'w1', 'm1', {}]],
      ['voiceReply', ['v1', { t: 'taken' }]],
      ['windowGone', ['w1']],
      ['scroll', ['move', 2, 0]],
      ['engines', [['claude']]],
      ['commanders', [true]],
    ])
  })

  it('is everything the windows said at once when the devices connect, and nothing they did not', () => {
    const f = setup()
    f.event({ kind: 'state', desk: ['a1'], foreground: true, swarms: { active: 't1', swarms: [], tiles: [] }, unread: [{ agentId: 'a1' }], focus: null, engines: ['codex'], commanders: true })
    expect(f.calls).toEqual([
      ['desk', [['a1'], true]],
      ['swarms', [{ active: 't1', swarms: [], tiles: [] }]],
      ['unread', [[{ agentId: 'a1' }]]],
      ['windowFocus', [{ voice: null, form: null }]],
      ['engines', [['codex']]],
      ['commanders', [true]],
    ])
    // No window yet: the dial is told nothing about one.
    f.calls.length = 0
    f.event({ kind: 'state', desk: [], swarms: null, unread: 'nonsense' })
    expect(f.calls.map(([name]) => name)).toEqual(['windowFocus', 'engines', 'commanders'])
  })
})

describe('what the core asks of the devices', () => {
  it('is ⌘K and the Wi-Fi device\'s step, answered from the devices\' port', async () => {
    const f = setup()
    const asker = { local: true, owner: true }
    const { requests } = f.options()
    expect(await requests.routeTask({ text: 'fix it' }, asker)).toMatchObject({ agentId: 'a1', reason: 'fix it' })
    expect(await requests.routeTask({}, asker)).toMatchObject({ reason: '' })
    expect(await requests.routeSend({ agentId: 'a1', text: 'go' }, asker)).toEqual({ ok: true })
    expect(f.port.routeSend).toHaveBeenCalledWith('a1', 'go')
    expect(await requests.stepFocus({ direction: 'previous', currentAgentId: 'a1' }, asker)).toEqual({ machineId: 'm1', agentId: 'a2' })
    expect(f.port.stepFocus).toHaveBeenLastCalledWith('previous', 'a1')
    f.port.stepFocus.mockResolvedValueOnce('no_agents')
    expect(await requests.stepFocus({ direction: 'sideways', currentAgentId: 7 }, asker)).toEqual({ step: 'no_agents' })
    expect(f.port.stepFocus).toHaveBeenLastCalledWith('next', undefined)
    expect(await requests.harness_devices_list({}, asker)).toEqual({ protocol: 1 })
  })
})
