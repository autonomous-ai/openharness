// The devices in a process of their own (services/devicesProcess.ts): the core API they run on across their
// link, what the core tells them reaching the devices' port, and what the core asks answered from it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, CorePorts, DevicesPort, ServiceRequests } from '../core/api.js'
import { createDeviceHookCalls } from '../core/deviceHookCalls.js'
import { createDevicesLink, type DevicesState } from '../core/devicesLink.js'
import { devicesListenerPath } from '../devices/listenerPath.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fixtureRead, snapshotRecords, snapshotFixture, snapshotRow } from '../testing/sessionSnapshot.js'
import type { SessionSnapshot } from '../testing/sessionSnapshot.js'
import type { DevicesCore, DevicesDeps } from './devices.js'
import type { ListenerHandler } from './devicesListener.js'
import { runDevicesService, type DevicesServiceOptions } from './devicesProcess.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import { deviceDeskFor, type DeviceDesk } from './deviceDesk.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'

vi.mock('../lib/boundedJsonBytes.js', async original => {
  const actual = await original<typeof import('../lib/boundedJsonBytes.js')>()
  return { ...actual, boundedJsonBytes: vi.fn(actual.boundedJsonBytes) }
})

// The real devices and the real link, as a process started by the master runs them: stood in for here.
const real = vi.hoisted(() => ({ started: [] as unknown[], linked: [] as unknown[], listened: [] as unknown[] }))
vi.mock('./devices.js', () => ({
  startDevices: (_core: unknown, ports: { devices: unknown }) => { real.started.push(ports); ports.devices = { stop: async () => {} }; return {} },
}))
vi.mock('./process.js', () => ({
  runServiceProcess: (options: unknown) => { real.linked.push(options); return { stop: () => {} } },
}))
vi.mock('./devicesListener.js', () => ({
  openDevicesListener: async (options: unknown) => { real.listened.push(options); return null },
}))

/** A devices' port that records what reached it. */
function devicesPort() {
  const calls: Array<[string, unknown[]]> = []
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, args]) }
  const port = {
    card: record('card'), observed: (...args: unknown[]) => { calls.push(['observed', args]); return true }, desk: record('desk'), swarms: record('swarms'), unread: record('unread'), appFocus: record('appFocus'),
    seen: record('seen'), settings: record('settings'), windowFocus: record('windowFocus'), windowReply: record('windowReply'),
    windowGone: record('windowGone'), engines: record('engines'),
    commanders: record('commanders'),
    inboxPoll: vi.fn(async (_poll: unknown): Promise<{ text?: string; off?: true }> => ({ text: 'run the tests' })),
    inboxGone: record('inboxGone'),
    stop: vi.fn(async () => {}),
  } satisfies DevicesPort
  return { port, calls }
}

function setup(over: { processEnv?: NodeJS.ProcessEnv; openListener?: DevicesServiceOptions['openListener'] } = {}) {
  const { port, calls } = devicesPort()
  let api!: DevicesCore
  let deps!: DevicesDeps
  const legacy = { routeTask: vi.fn(async () => ({ agentId: 'a1' })), routeSend: vi.fn(async () => ({ ok: true })) }
  const tab = { harness_devices_list: vi.fn(async () => ({ protocol: 1 })), devices_ws: vi.fn(async () => ({ ok: true })) }
  const start = vi.fn((core: DevicesCore, ports: CorePorts, given: DevicesDeps): ServiceRequests => {
    api = core
    deps = given
    given.onLegacyCommands?.(legacy)
    ports.devices = port
    return tab
  })
  let options!: ServiceProcessOptions
  const stop = vi.fn()
  const run = vi.fn((given: ServiceProcessOptions) => { options = given; return { stop } })
  const service = runDevicesService({
    dataDir: '/data', socketPath: '/sock', machineId: 'computer-9', token: 't',
    start, run, processEnv: over.processEnv ?? {}, openListener: over.openListener,
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
    read: vi.fn(fixtureRead((query, payload) => connection.query(query, payload))),
    notice: (kind, payload) => { notices.push([kind, payload]) },
  }
  return {
    service, port, calls, api: () => api, deps: () => deps, options: () => options, stop, tab, legacy, queries, notices, connection,
    answer: (query: string, value: unknown) => { answers = { ...answers, [query]: value } },
    connect: () => options.onConnected!(connection),
    event: (payload: Record<string, unknown>) => options.onEvent!(payload),
  }
}

afterEach(() => vi.restoreAllMocks())

describe('the devices in their own process', () => {
  it('reads compact session records through the actual Devices refresh with every retained field', async () => {
    const f = setup()
    vi.mocked(f.connection.read!).mockImplementation(async (_query, _payload, receive) => {
      receive({ type: 'begin', payload: { count: 2, header: { version: 2,
        machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' }, signedIn: true, environment: 'prod', hasWindow: true } } })
      receive({ type: 'row', payload: { index: 0, value: ['registered', 'compact', 'session', 'claude', 7, '/history/transcript', 9,
        true, '/work', 'stored', ['failed', 'FAILED', 'detail'], 'Current name', true, 'selected', false, 'published'] } })
      receive({ type: 'row', payload: { index: 1, value: ['service', 'remote', 'remote-session', 'fo', 8, null, 10, 'Cloud name', 'remote-model'] } })
      receive({ type: 'end', payload: { count: 2 } })
    })
    f.connect()
    await expect(f.deps().refresh!()).resolves.toBe(true)
    expect(f.api().agents.advertised()).toEqual([
      { agentId: 'compact', sessionId: 'session', engine: 'claude', registeredAt: 7, transcriptPath: '/history/transcript', lastHookAt: 9,
        active: true, cwd: '/work', dsh: 'stored', launch: { state: 'failed', error: 'FAILED', detail: 'detail' },
        displayName: 'Current name', runtimeProfile: 'selected' },
      { agentId: 'remote', sessionId: 'remote-session', engine: 'fo', registeredAt: 8, transcriptPath: null, lastHookAt: 10,
        displayName: 'Cloud name', selectedModel: 'remote-model', runtimeProfile: 'remote-model' },
    ])
    expect(f.api().clients.hasWindow()).toBe(true)
    await f.service.stop()
  })

  it.each([
    { launch: null, stored: false, fields: {} },
    { launch: ['starting'], stored: null, fields: { dsh: null, launch: { state: 'starting' } } },
    { launch: ['ready'], stored: '', fields: { dsh: '', launch: { state: 'ready' } } },
    { launch: ['failed', 'FAILED', false], stored: false, fields: { launch: { state: 'failed', error: 'FAILED' } } },
    { launch: ['failed', 'FAILED', ''], stored: 'stored', fields: { dsh: 'stored', launch: { state: 'failed', error: 'FAILED', detail: '' } } },
    { launch: ['held', 'engine', 'Wait'], stored: false, fields: { launch: { state: 'held', service: 'engine', detail: 'Wait' } } },
  ])('preserves absent/empty stored fields and launch $launch through actual refresh', async ({ launch, stored, fields }) => {
    const f = setup()
    vi.mocked(f.connection.read!).mockImplementation(async (_query, _payload, receive) => {
      receive({ type: 'begin', payload: { count: 1, header: { version: 2,
        machine: { id: 'machine-1', computerId: 'computer-9', name: 'This machine' }, signedIn: true, environment: 'prod', hasWindow: true } } })
      receive({ type: 'row', payload: { index: 0, value: ['registered', 'compact', 'session', 'claude', 7, '/history/transcript', 9,
        true, '/work', stored, launch, 'Current name', true, 'selected', false, false] } })
      receive({ type: 'end', payload: { count: 1 } })
    })
    f.connect(); await expect(f.deps().refresh!()).resolves.toBe(true)
    expect(f.api().agents.advertised()).toStrictEqual([
      { agentId: 'compact', sessionId: 'session', engine: 'claude', registeredAt: 7, transcriptPath: '/history/transcript', lastHookAt: 9,
        active: true, cwd: '/work', ...fields, displayName: 'Current name', runtimeProfile: 'selected' },
    ])
    await f.service.stop()
  })

  it('reports failed desk refresh without discarding the display and recovers on the same binding', async () => {
    const f = setup()
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('retained')] }))
    f.connect(); await f.deps().refresh!()
    f.answer('session_read_advertised', new Error('unavailable'))
    await expect(f.deps().refresh!()).resolves.toBe(false)
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['retained'])
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('current')] }))
    await expect(f.deps().refresh!()).resolves.toBe(true)
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['current'])
    await f.service.stop()
  })
  it('never reports successful desk refresh from a replaced connection', async () => {
    const f = setup()
    let finish!: () => void
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      for (const record of snapshotRecords(snapshotFixture({ registered: [snapshotRow('old')] }))) receive(record)
      await new Promise<void>(resolve => { finish = resolve })
    })
    f.connect(); const old = f.deps().refresh!()
    f.options().onDisconnected!()
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('replacement')] }))
    f.connect(); await f.deps().refresh!()
    finish()
    await expect(old).resolves.toBe(false)
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['replacement'])
    await f.service.stop()
  })
  it('validates each external record once in its actual advertised refresh', async () => {
    const f = setup()
    const row = snapshotRow('once')
    row.session.transcriptPath = '/history/retained'
    row.session.launch = { state: 'held', service: 'engine', detail: 'Waiting' }
    f.answer('session_read_advertised', snapshotFixture({ registered: [row] }))
    vi.mocked(boundedJsonBytes).mockClear()
    f.connect(); await f.deps().refresh!()
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['once'])
    const validations = vi.mocked(boundedJsonBytes).mock.calls.filter(([value]) => value && typeof value === 'object'
      && ['begin', 'row', 'end'].includes((value as { type?: string }).type ?? ''))
    expect(validations).toHaveLength(3)
    const retained = f.api().agents.advertised()[0]
    expect(retained).toMatchObject({ transcriptPath: '/history/retained', launch: { state: 'held', service: 'engine', detail: 'Waiting' } })
    expect(vi.mocked(boundedJsonBytes).mock.calls.some(([value]) => value === retained)).toBe(true)
    await f.service.stop()
  })
  it.each(['row', 'completion'] as const)('drops an old read at its %s seam after reconnecting the same wrapper', async seam => {
    const f = setup()
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('fresh')] }))
    let send!: Parameters<NonNullable<CoreConnection['read']>>[2], finish!: () => void
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      send = receive; await new Promise<void>(resolve => { finish = resolve })
    })
    f.connect(); const old = f.deps().refresh!()
    const records = snapshotRecords(snapshotFixture({ registered: [snapshotRow('old')] }))
    send(records[0])
    if (seam === 'completion') { send(records[1]); send(records[2]) }
    f.options().onDisconnected!(); f.connect(); await f.deps().refresh!()
    if (seam === 'row') expect(() => send(records[1])).toThrow('SESSION_READ_UNAVAILABLE')
    finish(); await old
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['fresh'])
    await f.service.stop()
  })

  it('commits an explicitly gone member without exposing a phantom dial row', async () => {
    const f = setup()
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      receive({ type: 'begin', payload: { header: snapshotFixture(), count: 1 } })
      receive({ type: 'row', payload: { index: 0, value: ['gone', 'registered', 'deleted'] } })
      receive({ type: 'end', payload: { count: 1 } })
    })
    f.connect(); await f.deps().refresh!()
    expect(f.api().agents.advertised()).toEqual([])
    expect(f.api().machine.id()).toBe('machine-1')
    await f.service.stop()
  })

  it('commits only a complete new dial projection and keeps the prior view on a partial failure', async () => {
    const f = setup()
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('old')] }))
    f.connect(); await f.deps().refresh!()
    let send!: Parameters<NonNullable<CoreConnection['read']>>[2], finish!: () => void, fail!: (error: Error) => void
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      send = receive; await new Promise<void>((resolve, reject) => { finish = resolve; fail = reject })
    })
    const pending = f.deps().refresh!()
    const records = snapshotRecords(snapshotFixture({ registered: [snapshotRow('partial')] }))
    send(records[0]); send(records[1])
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['old'])
    fail(new Error('READ_UNAVAILABLE')); await pending
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['old'])
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      send = receive; await new Promise<void>(resolve => { finish = resolve })
    })
    const fresh = f.deps().refresh!()
    for (const record of records) send(record)
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['old'])
    finish(); await fresh
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['partial'])
    await f.service.stop()
  })

  it('reads the shared session snapshot and keeps hidden rows out of the actual dial list', async () => {
    const f = setup()
    const row = (agentId: string, available: boolean) => ({
      session: { agentId, sessionId: `s-${agentId}`, engine: 'claude', registeredAt: 1, transcriptPath: '/history', lastHookAt: 2,
        active: true, cwd: '/work', dsh: null },
      facts: { displayName: `Shown ${agentId}`, terminalAvailable: available, parts: {} }, selectedModel: 'runtime-v1:s:claude:opus', turnRunning: false,
    })
    f.answer('session_read_advertised', { version: 2, registered: [row('hidden', false), row('shown', true)], cloud: [],
      machine: { id: 'm1', computerId: 'c1', name: 'Desk' }, signedIn: true, environment: 'prod', hasWindow: true })
    f.connect()
    await f.deps().refresh!()
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['shown'])
    const shown = f.api().agents.advertised()[0]
    expect(f.api().agents.displayName(shown)).toBe('Shown shown')
    expect(shown.transcriptPath).toBe('/history')
    expect(f.queries.map(([query]) => query)).toEqual(['session_read_advertised'])
    await f.service.stop()
  })

  it('start the devices on a link of their own, with what their process\'s environment says', () => {
    const f = setup({ processEnv: { HARNESS_DIAL_SERIALS: ' AA, ,BB ', HARNESSD_TEST_DIAL_PORT: '/dev/ttys042', HARNESSD_TEST_FAULTS: 'dial, fleet.knows ,' } })
    expect(f.options()).toMatchObject({ name: 'devices', socketPath: '/sock', machineId: 'computer-9', token: 't' })
    expect(f.deps()).toMatchObject({ dialSerials: ['AA', 'BB'], testDialPort: '/dev/ttys042' })
    // No credential and no E2EE identity: the account is asked of the core.
    expect(Object.keys(f.deps())).not.toContain('identity')
    expect([...f.deps().faults!]).toEqual(['dial', 'fleet.knows'])
    // The Devices tab's requests are the devices' own, beside what only the core asks.
    expect(Object.keys(f.options().requests).sort()).toEqual(['devices_ws', 'harness_devices_list', 'inboxPoll', 'routeSend', 'routeTask'])
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

  it('run what the devices registered for a core that goes, each time one does', () => {
    const f = setup()
    const gone = vi.fn()
    f.deps().onCoreGone!(gone)
    f.connect()
    expect(gone).not.toHaveBeenCalled()
    f.options().onDisconnected!()
    f.connect()
    f.options().onDisconnected!()
    expect(gone).toHaveBeenCalledTimes(2)
  })

  it('run the devices and their link as the master starts them', () => {
    runDevicesService({ dataDir: '/data', socketPath: '/sock', machineId: 'c', token: 't' })
    expect(real.started).toHaveLength(1)
    expect(real.linked).toEqual([expect.objectContaining({ name: 'devices', socketPath: '/sock', token: 't' })])
  })

  it('the devices process gives the devices its listener, on the data folder\'s devices socket', async () => {
    const opened: unknown[] = []
    const listener = { close: async () => {} }
    const f = setup({ openListener: async (options) => { opened.push(options); return listener } })
    const handlers: Record<string, ListenerHandler> = { front: { maxBytes: 64, perSecond: 10, handle: () => {} } }
    const log = vi.fn()
    expect(await f.deps().listen!(handlers, log)).toBe(listener)
    expect(opened).toEqual([{ path: devicesListenerPath('/data'), handlers, log }])
    // The real listener when no test stands in for it.
    await setup().deps().listen!(handlers, log)
    expect(real.listened).toEqual([{ path: devicesListenerPath('/data'), handlers, log }])
  })

  it('stop their link, then the devices, serial ports first', async () => {
    const f = setup()
    await f.service.stop()
    expect(f.stop).toHaveBeenCalled()
    expect(f.port.stop).toHaveBeenCalled()
  })
})

describe('the core\'s view, read in line by the dial', () => {
  const agent = { ...snapshotRow('a1').session, sessionId: 's1', displayName: 'api', runtimeProfile: 'runtime-v1:s1:claude:opus@high' }
  const capture = (over: { agents: typeof agent[]; machine?: Partial<SessionSnapshot['machine']>; hasWindow?: boolean; signedIn?: boolean; environment?: string }) => snapshotFixture({
    ...over, registered: over.agents.map(row => snapshotRow(row.agentId, { session: row, facts: { displayName: row.displayName, terminalAvailable: true, parts: {} }, selectedModel: row.runtimeProfile })),
    machine: { ...snapshotFixture().machine, ...over.machine },
  })

  it.each([false, true])('refreshes a cohosted focus step from cached window=%s before authorizing its effect', async cached => {
    const f = setup(), effects: string[] = []
    f.deps().onDesk!({
      stepFocus: async (_direction, _agent, current) => {
        if (!current()) return 'no_agents'
        effects.push('focus')
        return { machineId: 'machine-1', agentId: 'a1' }
      },
      scroll: vi.fn(),
    })
    f.answer('session_read_advertised', capture({ agents: [agent], hasWindow: cached }))
    f.connect(); await f.deps().refresh!()
    const peer = deviceDeskFor('/data', 'machine-1')!
    f.answer('session_read_advertised', capture({ agents: [agent], hasWindow: !cached }))
    const before = f.queries.length
    expect(await peer.stepFocus('next', 'a1', () => true)).toEqual(cached ? 'no_app' : { machineId: 'machine-1', agentId: 'a1' })
    expect(f.queries.length - before).toBe(1)
    expect(effects).toEqual(cached ? [] : ['focus'])
    await f.service.stop()
  })

  it('refuses a cohosted step when its view cannot be read and permits a later fresh read', async () => {
    const f = setup(), step = vi.fn(async () => ({ machineId: 'machine-1', agentId: 'a1' }))
    f.deps().onDesk!({ stepFocus: step, scroll: vi.fn() })
    const snapshot = capture({ agents: [agent], hasWindow: true })
    f.answer('session_read_advertised', snapshot)
    f.connect(); await f.deps().refresh!()
    const peer = deviceDeskFor('/data', 'machine-1')!
    f.answer('session_read_advertised', new Error('read failed'))
    expect(await peer.stepFocus('next', 'a1', () => true)).toBe('no_agents')
    expect(step).not.toHaveBeenCalled()
    f.answer('session_read_advertised', snapshot)
    expect(await peer.stepFocus('next', 'a1', () => true)).toEqual({ machineId: 'machine-1', agentId: 'a1' })
    expect(step).toHaveBeenCalledOnce()
    await f.service.stop()
  })

  it.each(['caller', 'disconnect', 'stop', 'timeout'] as const)('revokes a cohosted effect while refreshing after %s', async ending => {
    vi.useFakeTimers()
    const f = setup(), effects: string[] = []
    try {
      f.deps().onDesk!({ stepFocus: async (_direction, _agent, current) => {
        if (current()) effects.push('focus')
        return { machineId: 'machine-1', agentId: 'a1' }
      }, scroll: vi.fn() })
      const snapshot = capture({ agents: [agent], hasWindow: true })
      f.answer('session_read_advertised', snapshot)
      f.connect(); await f.deps().refresh!()
      let finish!: (value: Record<string, unknown>) => void, current = true
      vi.mocked(f.connection.query).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      const result = deviceDeskFor('/data', 'machine-1')!.stepFocus('next', 'a1', () => current)
      expect(finish).toBeTypeOf('function')
      if (ending === 'caller') current = false
      if (ending === 'disconnect') f.options().onDisconnected!()
      if (ending === 'stop') await f.service.stop()
      if (ending === 'timeout') { await vi.advanceTimersByTimeAsync(5000); expect(await result).toBe('no_agents') }
      finish({ ...snapshot })
      await f.deps().refresh!()
      expect(await result).toBe('no_agents')
      expect(effects).toEqual([])
    } finally { await f.service.stop(); vi.useRealTimers() }
  })

  it('publishes a desk only after a verified view and keeps its in-flight effects on that exact connection', async () => {
    const f = setup(), effects: string[] = []
    let release!: () => void
    const desk: DeviceDesk = {
      stepFocus: async (_direction, _agent, current) => {
        await new Promise<void>(resolve => { release = resolve })
        if (current()) { effects.push('focus'); f.api().clients.sendWindow({ target: { kind: 'all' }, frame: { type: 'dial_focus', payload: {} } }) }
        return { machineId: 'machine-1', agentId: 'a1' }
      },
      scroll: (_phase, _dy, _velocity, current) => { if (current()) effects.push('scroll') },
    }
    f.deps().onDesk!(desk)
    expect(deviceDeskFor('/data', 'machine-1')).toBeNull()
    f.answer('session_read_advertised', capture({ agents: [agent], machine: { id: 'machine-1', computerId: 'computer-9' }, hasWindow: true }))
    f.connect(); await f.deps().refresh!()
    const peer = deviceDeskFor('/data', 'machine-1')!
    const first = peer.stepFocus('next', 'a0', () => true)
    // The step's list refresh must not revoke its own component endpoint.
    await f.deps().refresh!(); release()
    expect(await first).toEqual({ machineId: 'machine-1', agentId: 'a1' })
    const old = peer.stepFocus('next', 'a0', () => true)
    f.options().onDisconnected!()
    expect(deviceDeskFor('/data', 'machine-1')).toBeNull()
    f.connect(); await f.deps().refresh!()
    release()
    expect(await old).toBe('no_agents')
    expect(effects).toEqual(['focus'])
    expect(f.notices).toHaveLength(1)
    expect(deviceDeskFor('/data', 'machine-1')!.scroll('move', 2, 3, () => true)).toBe(true)
    expect(effects).toEqual(['focus', 'scroll'])
    f.answer('session_read_advertised', capture({ agents: [], machine: { id: 'machine-2', computerId: 'not-this-computer' } }))
    await f.deps().refresh!()
    expect(deviceDeskFor('/data', 'machine-2')).toBeNull()
    await f.service.stop()
    expect(deviceDeskFor('/data', 'machine-1')).toBeNull()
  })

  it.each(['disconnect', 'replacement'] as const)('reads a fresh view after same-facade %s without waiting for or adopting the old reply', async ending => {
    const f = setup()
    let release!: (answer: Record<string, unknown>) => void
    vi.mocked(f.connection.query).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    f.connect()
    const old = f.deps().refresh!()
    if (ending === 'disconnect') f.options().onDisconnected!()
    f.answer('session_read_advertised', capture({ agents: [{ ...agent, agentId: 'fresh' }], machine: { id: 'machine-2' }, hasWindow: true }))
    f.connect()
    expect(f.connection.query).toHaveBeenCalledTimes(2)
    await f.deps().refresh!()
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['fresh'])
    release({ ...capture({ agents: [agent], machine: { id: 'machine-1' }, hasWindow: false }) })
    await old
    expect(f.api().agents.advertised().map(row => row.agentId)).toEqual(['fresh'])
    expect(f.api().machine.id()).toBe('machine-2')
    expect(f.api().clients.hasWindow()).toBe(true)
    await f.service.stop()
    const queries = vi.mocked(f.connection.query).mock.calls.length
    f.connect()
    expect(f.connection.query).toHaveBeenCalledTimes(queries)
  })

  it('revokes the cached window and agents before disconnect callbacks or stop can act', async () => {
    const f = setup()
    f.answer('session_read_advertised', capture({ agents: [agent], machine: { id: 'machine-1' }, hasWindow: true }))
    f.connect(); await f.deps().refresh!()
    const gone = vi.fn(() => {
      expect(f.api().clients.hasWindow()).toBe(false)
      expect(f.api().agents.advertised()).toEqual([])
    })
    f.deps().onCoreGone!(gone)
    f.options().onDisconnected!()
    expect(gone).toHaveBeenCalledOnce()
    f.connect(); await f.deps().refresh!()
    await f.service.stop()
    expect(f.api().clients.hasWindow()).toBe(false)
    expect(f.api().agents.advertised()).toEqual([])
  })

  it('keeps cloud display/profile/path facts after local rows and preserves empty machine label fallbacks', async () => {
    const f = setup()
    f.answer('session_read_advertised', snapshotFixture({ registered: [snapshotRow('local')],
      cloud: [{ agentId: 'cloud', sessionId: 'remote', engine: 'fo', registeredAt: 2, transcriptPath: '/remote/history', lastHookAt: 3, displayName: 'Cloud name', selectedModel: 'cloud-profile' }],
      machine: { id: 'machine-1', computerId: '', name: '' } }))
    f.connect(); await f.deps().refresh!()
    const rows = f.api().agents.advertised()
    expect(rows.map(row => row.agentId)).toEqual(['local', 'cloud'])
    expect(f.api().agents.displayName(rows[1])).toBe('Cloud name')
    expect(f.api().agents.runtimeProfile(rows[1])).toBe('cloud-profile')
    expect(rows[1].transcriptPath).toBe('/remote/history')
    expect(f.api().machine.computerId()).toBe('computer-9'); expect(f.api().machine.name()).toBe('This machine')
    await f.service.stop()
  })

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
    f.answer('session_read_advertised', capture({ agents: [agent], machine: { id: 'machine-1', computerId: 'computer-1', name: 'Studio' }, signedIn: true, environment: 'prod', hasWindow: true }))
    f.connect()
    await vi.waitFor(() => expect(f.api().agents.advertised()).toHaveLength(1))
    const api = f.api()
    const session = api.agents.advertised()[0]
    expect(api.agents.advertised()).toEqual([agent])
    expect(api.agents.displayName(session)).toBe('api')
    expect(api.agents.displayName({ agentId: 'x' } as RegisteredSession)).toBe('')
    expect(api.agents.runtimeProfile(session)).toBe('runtime-v1:s1:claude:opus@high')
    expect(api.agents.runtimeProfile({ agentId: 'x' } as RegisteredSession)).toBeNull()
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['machine-1', 'computer-1', 'Studio'])
    expect(api.account.signedIn()).toBe(true)
    expect(api.account.environment()).toBe('prod')
    expect(api.clients.hasWindow()).toBe(true)
    // Asked twice at once: one ask.
    const before = f.queries.length
    await Promise.all([f.deps().refresh!(), f.deps().refresh!()])
    expect(f.queries.length).toBe(before + 1)
    // An answer that is not a view changes nothing; one that is missing names keeps the defaults.
    f.answer('session_read_advertised', { error: 'QUERY_FAILED' })
    await f.deps().refresh!()
    expect(api.agents.advertised()).toHaveLength(1)
    f.answer('session_read_advertised', { agents: [], machine: 'nothing' })
    await f.deps().refresh!()
    expect([api.machine.id(), api.machine.computerId(), api.machine.name()]).toEqual(['machine-1', 'computer-1', 'Studio'])
    // An ask the core never answers (it went away) leaves the last view.
    f.answer('session_read_advertised', new Error('the core went away'))
    await f.deps().refresh!()
    expect(api.machine.computerId()).toBe('computer-1')
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
    f.answer('usageFresh', { usage: { totalTokens: 5, inputTokens: 3, updatedAt: '2026-10-12T00:00:00.000Z' } })
    expect(await api.usageFresh!('a1')).toMatchObject({ inputTokens: 3 })
    f.answer('usageFresh', { usage: 'junk' })
    expect(await api.usageFresh!('a1')).toBeNull()
    f.answer('usageFresh', new Error('the core went away'))
    expect(await api.usageFresh!('a1')).toBeNull()
    f.answer('activitySnapshot', { activity: { text: 'Working', elapsedSeconds: 931 } })
    expect(await api.agents.activitySnapshot!('a1')).toEqual({ text: 'Working', elapsedSeconds: 931 })
    // An older core does not know the query, or has no timer to give: the footer alone is still the footer.
    f.answer('activityText', { text: 'Reading' })
    f.answer('activitySnapshot', { error: 'UNKNOWN_QUERY' })
    expect(await api.agents.activitySnapshot!('a1')).toEqual({ text: 'Reading' })
    f.answer('activitySnapshot', new Error('the core went away'))
    expect(await api.agents.activitySnapshot!('a1')).toEqual({ text: 'Reading' })
    f.answer('activitySnapshot', { activity: null })
    expect(await api.agents.activitySnapshot!('a1')).toEqual({ text: 'Reading' })
    f.answer('activityText', { text: null })
    expect(await api.agents.activitySnapshot!('a1')).toBeNull()
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
    api.clients.sendWindow({ target: { kind: 'all' }, frame: { type: 'dial_focus', payload: {} } })
    expect(api.clients.sendWindow({ target: { kind: 'connection', connId: 'w1' }, frame: { type: 'dial_form', payload: {} } })).toBe(true)
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
      ['window', { target: { kind: 'all' }, frame: { type: 'dial_focus', payload: {} } }],
      ['window', { target: { kind: 'connection', connId: 'w1' }, frame: { type: 'dial_form', payload: {} } }],
      ['devicesChanged', { revision: 1 }],
      ['dialWatching', { watching: true }],
    ])
    // What the devices never ask answers as every other service's does.
    expect(api.transcripts.databaseHistory({} as RegisteredSession)).toBeUndefined()
    await expect(api.account.mintGridName()).resolves.toBeNull()
    // Gone from the core: told nothing, and a bridge's ask says it did not go.
    f.options().onDisconnected!()
    api.turns.send('a1', 'lost')
    expect(api.clients.sendWindow({ target: { kind: 'connection', connId: 'w1' }, frame: { type: 'dial_form', payload: {} } })).toBe(false)
    expect(f.notices).toHaveLength(8)
  })

  // A dial says hello before its process is connected to a core that just started (2026-10-09, a user's
  // log: hello at 14:22:54.141, connected at 14:22:54.525): the core must still hear that it watches, or it
  // makes no cards for it and the dial shows Working for turns that ended, and no recaps.
  it('tell a core that connects whether a dial is watching, as they last said it', () => {
    const f = setup()
    const api = f.api()
    api.clients.dialWatching(true)
    expect(f.notices).toEqual([])
    f.connect()
    expect(f.notices).toEqual([['dialWatching', { watching: true }]])
    // A core that restarts while the dial stays is told again.
    f.options().onDisconnected!()
    f.connect()
    expect(f.notices).toEqual([['dialWatching', { watching: true }], ['dialWatching', { watching: true }]])
    // No dial any more: a new core starts out knowing that, and is told nothing.
    api.clients.dialWatching(false)
    f.options().onDisconnected!()
    f.connect()
    expect(f.notices).toHaveLength(3)
  })
})

describe('what the core tells the devices, reaching their port', () => {
  // Final review of spec 2026-11-02 poll cost: the fleet reads the machine list on `machines_changed` and only every
  // 5 minutes otherwise, so the account's notices the core forwards must reach it here too.
  it('hands the account notices the core forwards to its listeners', () => {
    const h = setup()
    const heard: unknown[] = []
    const stop = h.api().account.onNotice((notice) => heard.push(notice))
    h.event({ kind: 'notice', notice: { type: 'machines_changed', reason: 'renamed' } })
    expect(heard).toEqual([{ type: 'machines_changed', reason: 'renamed' }])
    stop()
    h.event({ kind: 'notice', notice: { type: 'machines_changed', reason: 'renamed' } })
    expect(heard).toHaveLength(1)
    // A notice that is not an object is nothing to hand on, not a listener's to explain.
    for (const notice of [null, 'renamed', 7]) h.event({ kind: 'notice', notice })
    expect(heard).toHaveLength(1)
  })

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
      { kind: 'windowGone', connId: 'w1' },
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
      ['windowGone', ['w1']],
      ['engines', [['claude']]],
      ['commanders', [true]],
    ])
  })

  it('is a paneless agent\'s hook event, handed to the devices as the core checked it', () => {
    const f = setup()
    const event = { engine: 'claude', sessionId: 's1', event: 'turn-stop', cwd: '/work/api', callerPid: 42, transcriptPath: '/t/s1.jsonl',
      hostHints: { TERM_PROGRAM: 'ghostty' }, at: 7 }
    f.event({ ...event, kind: 'observed' })
    expect(f.calls).toEqual([['observed', [event]]])
  })

  // The mod's poll, told when its client went first (core/deviceHookCalls.ts): the poll ends. No approval is held to end.
  it('is inbox.gone, reaching the port; approval.gone reaches nothing', () => {
    const f = setup()
    f.event({ kind: 'approval.gone', id: 'r1' })
    f.event({ kind: 'inbox.gone', pollId: 'p1' })
    f.event({ kind: 'inbox.gone', pollId: 7 })
    expect(f.calls).toEqual([['inboxGone', ['p1']], ['inboxGone', ['']]])
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
  it('keeps the old private send success and failure objects whole', async () => {
    let options!: ServiceProcessOptions
    let result: Record<string, unknown> = { ok: true, machine: 'remote-fixture', receipt: 'old-result' }
    const service = runDevicesService({ dataDir: '/data', socketPath: '/sock', machineId: 'fixture', token: 't', processEnv: {},
      start: (_core, ports, deps) => {
        ports.devices = devicesPort().port
        ;(deps as DevicesDeps & { onLegacyCommands?: (handlers: ServiceRequests) => void }).onLegacyCommands?.({
          routeTask: async () => result, routeSend: async () => result,
        })
        return { devices_ws: async () => result.ok ? { ok: true } : { ok: false, machine: result.machine, reason: result.reason } }
      }, run: given => { options = given; return { stop: vi.fn() } } })
    try {
      expect(await options.requests.routeSend({ agentId: 'a', text: 'go' }, { local: true, owner: true })).toEqual(result)
      result = { ok: false, machine: 'remote-fixture', reason: 'offline', receipt: 'old-refusal' }
      expect(await options.requests.routeSend({ agentId: 'a', text: 'go' }, { local: true, owner: true })).toEqual(result)
    } finally { service.stop() }
  })

  it('keeps the old core private aliases in the process, forwarding to service-owned direct handlers', async () => {
    const f = setup()
    const asker = { local: true, owner: true }
    const closed = new AbortController().signal
    for (const [type, frame, payload] of [['routeTask', 'route_task', { text: 'fixture' }], ['routeSend', 'route_send', { agentId: 'a1', text: 'go' }]] as const) {
      await f.options().requests[type](payload, asker, closed)
      expect(f.legacy[type]).toHaveBeenLastCalledWith(payload, asker, closed)
    }
  })
  it('has no private desk request', () => {
    const f = setup(); expect(f.options().requests).not.toHaveProperty('stepFocus')
  })

  it('is the mod\'s poll, answered { text } from the devices\' port; an approval is no request', async () => {
    const f = setup()
    const asker = { local: true, owner: true }
    const { requests } = f.options()
    expect(requests.approval).toBeUndefined()
    // The link's own request id rides along, and is not the poll's.
    expect(await requests.inboxPoll({ pollId: 'p1', sessionId: 's1', requestId: 'q10' }, asker)).toEqual({ text: 'run the tests' })
    expect(f.port.inboxPoll).toHaveBeenLastCalledWith({ pollId: 'p1', sessionId: 's1' })
    f.port.inboxPoll.mockResolvedValueOnce({})
    expect(await requests.inboxPoll({ pollId: 'p2', sessionId: 's1' }, asker)).toEqual({})
    // Their inbox failed: said as such, so the core answers no device.
    f.port.inboxPoll.mockResolvedValueOnce({ off: true })
    expect(await requests.inboxPoll({ pollId: 'p3', sessionId: 's1' }, asker)).toEqual({ off: true })
  })

  // The core's checked call (core/deviceHookCalls.ts) on the link as the core sends it (core/devicesLink.ts), to the port.
  it('is the mod\'s poll from the core\'s route to the devices\' port, and its client going told', async () => {
    const f = setup()
    const asker = { local: true, owner: true }
    const link = createDevicesLink({
      core: {} as CoreApi,
      notify: (frame) => { f.event(frame.payload ?? {}); return true },
      call: async (type, payload) => f.options().requests[type](payload, asker),
      state: (): DevicesState => ({ desk: [], foreground: true, swarms: null, unread: [], focus: { voice: null, form: null }, engines: [], commanders: false }),
    })
    let n = 0
    const calls = createDeviceHookCalls({ ready: () => true, devices: () => link.port, newId: () => `p${++n}` })
    expect(await calls.onInbox({ sessionId: 's1' }, new AbortController().signal)).toEqual({ text: 'run the tests' })
    expect(f.port.inboxPoll).toHaveBeenLastCalledWith({ pollId: 'p1', sessionId: 's1' })

    f.port.inboxPoll.mockImplementationOnce(() => new Promise<{ text?: string }>(() => {}))
    const client = new AbortController()
    const left = calls.onInbox({ sessionId: 's1' }, client.signal)
    client.abort()
    expect(await left).toBe('off')
    expect(f.calls).toEqual([['inboxGone', ['p2']]])
  })
})
