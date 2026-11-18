// The Wi-Fi device in the devices' process (services/wifiProcess.ts): the core API it runs on across its link,
// built once the core names the machine, what the core tells it reaching its port in order, and its routes of the
// door, which the core hands on.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureRead, snapshotRecords, snapshotFixture, snapshotRow } from '../testing/sessionSnapshot.js'
import type { AgentCreateRequest, CoreApi, CorePorts, ServiceRequests, WifiPort } from '../core/api.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import type { WifiDeps } from './wifi.js'
import { runWifiService } from './wifiProcess.js'
import { cancelTurn } from '../agentClient/cancel.js'
import { observeQuestions } from '../agentClient/questions.js'
import { env } from '../config/env.js'
import http from 'node:http'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { unixSocketPath } from '../lib/localSocket.js'
import { DeviceFeedPool, type DeviceSessionFeed } from '../lib/autonomous-device/sessionFeed.js'
import { AutonomousDeviceStore, type StoreAgent } from '../lib/autonomous-device/store.js'
import { publishDeviceDesk } from './deviceDesk.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'

vi.mock('../lib/boundedJsonBytes.js', async original => {
  const actual = await original<typeof import('../lib/boundedJsonBytes.js')>()
  return { ...actual, boundedJsonBytes: vi.fn(actual.boundedJsonBytes) }
})

const createRequest = (dsh = 'package', cwd = '/workspace'): AgentCreateRequest => ({ dsh, cwd, engine: 'claude',
  prompt: null, name: null, bypassPermission: false, requireUnusedWorkspace: true })

// The real service and the real link, as a process started by the master runs them: stood in for here.
const real = vi.hoisted(() => ({ started: 0, options: null as ServiceProcessOptions | null }))
vi.mock('./wifi.js', () => ({ startWifi: () => { real.started++ } }))
vi.mock('./process.js', () => ({ runServiceProcess: (options: ServiceProcessOptions) => { real.options = options; return { stop: () => {} } } }))
vi.mock('../agentClient/cancel.js', () => ({ cancelTurn: vi.fn(async () => true) }))
vi.mock('../agentClient/questions.js', () => ({ observeQuestions: vi.fn(() => ({ ready: Promise.resolve(), answer: vi.fn(async () => true), close: vi.fn() })) }))

/** A Wi-Fi port that records what reached it, in order. */
function wifiPort(machineId: string, log: string[]) {
  const record = (name: string) => (...args: unknown[]) => { log.push(`${machineId} ${name} ${JSON.stringify(args)}`) }
  const port: WifiPort = {
    delivery: record('delivery'),
    revealed: record('revealed'), input: record('input'), disconnected: vi.fn(),
    appFocus: vi.fn(async (...args: unknown[]) => { record('appFocus')(...args) }),
    resume: vi.fn(async (...args: unknown[]) => { record('resume')(...args) }),
    stop: vi.fn(async () => { log.push(`${machineId} stop`) }),
  }
  return port
}

const focusWindow = (core: CoreApi, agentId: string, expiresAt: number, focusRevision: string): boolean =>
  core.clients.sendWindow({ target: { kind: 'first' }, frame: { type: 'device_focus', payload: { machineId: core.machine.id(), agentId, expiresAt, focusRevision } } })
const revealWindow = (core: CoreApi, operationId: string, agentId: string): boolean =>
  core.clients.sendWindow({ target: { kind: 'first' }, frame: { type: 'device_prepare_open', payload: { operationId, machineId: core.machine.id(), agentId } } })

function setup(over: { startThrows?: boolean; leavesOff?: boolean; dataDir?: string } = {}) {
  const log: string[] = []
  const ports: WifiPort[] = []
  let api!: CoreApi
  let adapter!: WifiDeps
  /** Its routes of the door, as each start returned them. */
  const routes = vi.fn(async (payload: Record<string, unknown>) => ({ status: 200, body: { asked: payload.target } }))
  const focusCurrent = vi.fn(async (_payload: Record<string, unknown>) => ({ current: true }))
  const start = vi.fn((core: CoreApi, given: CorePorts, deps?: WifiDeps): ServiceRequests => {
    adapter = deps!
    if (over.startThrows) throw new Error('journal unreadable')
    api = core
    if (over.leavesOff) return {}
    const port = wifiPort(core.machine.id(), log)
    ports.push(port)
    given.wifi = port
    return { wifi_http: routes, wifi_focus_current: focusCurrent }
  })
  let options!: ServiceProcessOptions
  const stop = vi.fn()
  const run = vi.fn((given: ServiceProcessOptions) => { options = given; return { stop } })
  const service = runWifiService({ dataDir: over.dataDir ?? '/data', socketPath: '/sock', machineId: 'computer-9', token: 't', start, run })
  const notices: Array<[string, Record<string, unknown> | undefined]> = []
  let answers: Record<string, unknown> = { machine: { id: 'machine-1' }, input_contract: { version: 1 }, follow_agents: { agents: [] }, resolve: { value: { agentId: 'a', sessionId: 's', engine: 'claude' } } }
  const connection: CoreConnection = {
    query: vi.fn(async (query: string) => {
      const answer = answers[query]
      if (answer instanceof Error) throw answer
      return (answer ?? {}) as Record<string, unknown>
    }),
    read: vi.fn(fixtureRead((query, payload) => connection.query(query, payload))),
    notice: (kind, payload) => { notices.push([kind, payload]) },
  }
  const settled = () => new Promise((resolve) => setTimeout(resolve, 30))
  return {
    service, start, routes, focusCurrent, log, ports, api: () => api, adapter: () => adapter, options: () => options, stop, notices, connection, settled,
    answer: (query: string, value: unknown) => { answers = { ...answers, [query]: value } },
    connect: () => options.onConnected!(connection),
    disconnect: () => options.onDisconnected!(),
    event: (payload: Record<string, unknown>) => options.onEvent!(payload),
  }
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('the Wi-Fi device in the devices\' process', () => {
  it('validates each external record once before its actual WiFi view projection', async () => {
    const f = setup()
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, { local: true, owner: true })
    const snapshot = snapshotFixture({ registered: [snapshotRow('once')] })
    f.answer('session_read_registered', snapshot)
    vi.mocked(boundedJsonBytes).mockClear()
    expect(await f.adapter().readView!()).toMatchObject({ store: [{ agentId: 'once' }] })
    const validations = vi.mocked(boundedJsonBytes).mock.calls.filter(([value]) => value && typeof value === 'object'
      && ['begin', 'row', 'end'].includes((value as { type?: string }).type ?? ''))
    expect(validations).toHaveLength(3)
    await f.service.stop()
  })
  it('keeps window permission provisional until the matching read completes', async () => {
    const f = setup()
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, { local: true, owner: true })
    f.answer('session_read_registered', snapshotFixture({ hasWindow: false })); await f.adapter().readView!()
    let send!: Parameters<NonNullable<CoreConnection['read']>>[2], finish!: () => void
    vi.mocked(f.connection.read!).mockImplementationOnce(async (_query, _payload, receive) => {
      send = receive; await new Promise<void>(resolve => { finish = resolve })
    })
    const pending = f.adapter().readView!()
    const records = snapshotRecords(snapshotFixture({ hasWindow: true }))
    send(records[0])
    expect(focusWindow(f.api(), 'a', 9, 'current')).toBe(false)
    send(records[1])
    expect(focusWindow(f.api(), 'a', 9, 'current')).toBe(false)
    finish(); await pending
    expect(focusWindow(f.api(), 'a', 9, 'current')).toBe(true)
    await f.service.stop()
  })

  it.each(['disconnect', 'reconnect', 'machine', 'stop', 'caller'] as const)('fences public cancellation through %s without replay', async change => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    const adapter = f.adapter(), controller = new AbortController()
    let release!: (ok: boolean) => void, current!: () => boolean, caller = true
    vi.mocked(cancelTurn).mockClear().mockImplementationOnce(async (where, agentId, predicate, signal, budget) => {
      expect(where).toEqual({ dataDir: '/data', port: env.PORT, machineId: 'machine-1' })
      expect(agentId).toBe('a'); expect(signal).toBe(controller.signal); expect(budget).toBe(adapter.answerWork)
      current = predicate; return new Promise(done => { release = done })
    })
    const pending = adapter.stop!('a', () => caller, controller.signal)
    expect(current()).toBe(true)
    if (change === 'caller') caller = false
    else if (change === 'stop') await f.service.stop()
    else {
      f.disconnect()
      if (change !== 'disconnect') {
        f.connect(); if (change === 'machine') f.answer('machine', { id: 'machine-2' })
        f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
      }
    }
    expect(current()).toBe(false); release(true); expect(await pending).toBe(false)
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(f.connection.query).not.toHaveBeenCalledWith('stop', expect.anything())
    await f.service.stop()
  })

  it('does not open a public cancel socket for an already revoked caller', async () => {
    const f = setup(); f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, { local: true, owner: true })
    vi.mocked(cancelTurn).mockClear()
    expect(await f.adapter().stop!('a', () => false, new AbortController().signal)).toBe(false)
    expect(cancelTurn).not.toHaveBeenCalled(); await f.service.stop()
  })

  it('calls its same-machine cohost desk directly and never falls back after direct dispatch', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    const stepFocus = vi.fn(async () => ({ machineId: 'machine-1', agentId: 'next' })), scroll = vi.fn()
    const revoke = publishDeviceDesk({ dataDir: '/data', machineId: 'machine-1', current: () => true, hasWindow: () => true,
      desk: { stepFocus, scroll } })
    try {
      vi.mocked(f.connection.query).mockClear()
      expect(await f.api().wifi.stepFocus('next', 'a')).toEqual({ machineId: 'machine-1', agentId: 'next' })
      expect(f.api().wifi.scroll('move', 2, 3)).toBe(true)
      expect(stepFocus).toHaveBeenCalledWith('next', 'a', expect.any(Function))
      expect(scroll).toHaveBeenCalledWith('move', 2, 3, expect.any(Function))
      expect(f.connection.query).not.toHaveBeenCalled()
      expect(f.notices).toEqual([])
      expect(await f.adapter().desk!.stepFocus('next', 'a', () => false)).toBe('no_agents')
      expect(f.adapter().desk!.scroll('move', 2, 3, () => false)).toBe(false)
      expect(await f.adapter().desk!.stepFocus('next', 'a', () => true)).toEqual({ machineId: 'machine-1', agentId: 'next' })
      expect(f.adapter().desk!.scroll('move', 2, 3, () => true)).toBe(true)
      f.answer('session_read_registered', snapshotFixture({ hasWindow: false })); await f.adapter().readView!()
      expect(await f.api().wifi.stepFocus('next', 'a')).toBe('no_app')
      f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
      vi.mocked(f.connection.query).mockClear()
      stepFocus.mockRejectedValueOnce(new Error('private content must not be logged'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await f.api().wifi.stepFocus('next', 'a')).toBe('no_agents')
      expect(warn).toHaveBeenCalledWith('[devices] DESK_FAILED')
      expect(f.connection.query).not.toHaveBeenCalled()
    } finally { revoke(); await f.service.stop() }
  })

  it('uses the explicit mixed-host fallback once and does not confirm it after its caller departs', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    const foreign = vi.fn(async () => ({ machineId: 'other-machine', agentId: 'private' }))
    const revoke = publishDeviceDesk({ dataDir: '/data', machineId: 'other-machine', current: () => true, hasWindow: () => true,
      desk: { stepFocus: foreign, scroll: () => {} } })
    try {
      let release!: (answer: Record<string, unknown>) => void, current = true
      vi.mocked(f.connection.query).mockClear().mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      const step = f.adapter().desk!.stepFocus('next', 'a', () => current)
      expect(f.connection.query).toHaveBeenCalledExactlyOnceWith('stepFocus', { direction: 'next', currentAgentId: 'a' })
      current = false; release({ machineId: 'machine-1', agentId: 'next' })
      expect(await step).toBe('no_agents')
      expect(foreign).not.toHaveBeenCalled()
      expect(f.connection.query).toHaveBeenCalledOnce()
      expect(f.api().wifi.scroll('move', 2, 3)).toBe(true)
      expect(f.notices).toEqual([['scroll', { phase: 'move', dy: 2, velocity: 3 }]])
    } finally { revoke(); await f.service.stop() }
  })

  it('revokes every old component API and input callback after machine rebinding', async () => {
    const f = setup(), asker = { local: true, owner: true }
    const drain = () => f.options().requests!.wifi_http({}, asker)
    f.connect(); f.event({ kind: 'resume' }); await drain()
    const old = f.api(), adapter = f.adapter()
    f.answer('machine', { id: 'machine-2' }); f.event({ kind: 'resume' }); await drain()
    f.answer('session_read_registered', snapshotFixture({ machine: { id: 'machine-2', computerId: 'computer-9', name: 'Desk' } })); await f.adapter().readView!()
    vi.mocked(f.connection.query).mockClear()
    for (const read of [() => old.agents.create(createRequest()),
      () => old.wifi.stepFocus('next', 'a'), () => old.turns.recent('a', 1),
      () => old.conversations.resolve('a'), () => adapter.readView!(),
      () => adapter.submit!('a', 'old input', 'old-delivery', () => {})]) await expect(read()).rejects.toThrow()
    expect(await adapter.stop!('a', () => true, new AbortController().signal)).toBe(false)
    adapter.cancel!('old-delivery')
    revealWindow(old, 'old-operation', 'a')
    expect(old.wifi.scroll('move', 2, 3)).toBe(false)
    expect(focusWindow(old, 'a', 9, 'revision')).toBe(false)
    const oldRows = vi.fn(); old.agents.follow!(oldRows)()
    expect(oldRows).not.toHaveBeenCalled()
    expect(f.connection.query).not.toHaveBeenCalled()
    expect(f.notices).toEqual([])
    // Returning to the old identity makes a new component; it cannot revive the retained API.
    f.answer('machine', { id: 'machine-1' }); f.event({ kind: 'resume' }); await drain()
    vi.mocked(f.connection.query).mockClear()
    await expect(old.agents.create(createRequest())).rejects.toThrow()
    expect(f.connection.query).not.toHaveBeenCalled()
    await f.service.stop()
  })

  it('clears old private follow rows and callbacks before a different machine is built', async () => {
    const f = setup(), asker = { local: true, owner: true }, oldRows = vi.fn(), newRows = vi.fn()
    f.answer('follow_agents', { agents: [{ agentId: 'old-private-agent' }] })
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.api().agents.follow!(oldRows); oldRows.mockClear()
    const original = f.start.getMockImplementation()!
    f.start.mockImplementationOnce((...args) => {
      const routes = original(...args)
      args[0].agents.follow!(newRows)
      return routes
    })
    f.answer('machine', { id: 'machine-2' })
    f.answer('follow_agents', { agents: [{ agentId: 'new-private-agent' }] })
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    expect(oldRows).not.toHaveBeenCalled()
    expect(newRows.mock.calls.map(([event]) => event)).toEqual([{ kind: 'running', session: { agentId: 'new-private-agent' } }])
    await f.service.stop()
  })

  it.each(['same', 'different'] as const)('waits for a future identity handshake before durable create: %s machine', async identity => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    const old = f.api(), oldRead = f.adapter().readView!
    f.disconnect(); f.connect() // No resume has arrived yet.
    vi.mocked(f.connection.query).mockClear()
    f.answer('create', { ok: true, agentId: 'created' })
    const creating = old.agents.create(createRequest())
    const result = identity === 'same' ? expect(creating).resolves.toEqual({ ok: true, agentId: 'created' }) : expect(creating).rejects.toThrow()
    void result.catch(() => {}) // An earlier RED assertion must not leave its expected rejection unhandled.
    expect(f.connection.query).not.toHaveBeenCalled()
    expect(await f.adapter().stop!('a', () => true, new AbortController().signal)).toBe(false)
    await expect(old.turns.recent('a', 1)).rejects.toThrow()
    await expect(old.conversations.resolve('a')).rejects.toThrow()
    await expect(oldRead()).rejects.toThrow()
    revealWindow(old, 'old-operation', 'a')
    expect(f.notices).toEqual([])
    f.answer('machine', { id: identity === 'same' ? 'machine-1' : 'machine-2' })
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    await result
    expect(vi.mocked(f.connection.query).mock.calls.filter(([query]) => query === 'create')).toHaveLength(identity === 'same' ? 1 : 0)
    await f.service.stop()
  })

  it('does not wait on its own resume when durable recovery creates after identity confirmation', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    const old = f.api()
    f.answer('create', { ok: true, agentId: 'created' })
    vi.mocked(f.ports[0].resume).mockImplementationOnce(async () => {
      expect(await old.agents.create(createRequest())).toEqual({ ok: true, agentId: 'created' })
    })
    f.disconnect(); f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, asker)
    expect(vi.mocked(f.connection.query).mock.calls.filter(([query]) => query === 'create')).toHaveLength(1)
    await f.service.stop()
  })

  it.each(['timeout', 'disconnect', 'replacement', 'stop'] as const)('settles unsent durable creation when identity readiness ends by %s', async end => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      f.disconnect(); f.connect()
      vi.mocked(f.connection.query).mockClear()
      const creating = f.api().agents.create(createRequest())
      const refused = expect(creating).rejects.toThrow('WIFI_IDENTITY_UNAVAILABLE')
      if (end === 'timeout') await vi.advanceTimersByTimeAsync(15_000)
      else if (end === 'disconnect') f.disconnect()
      else if (end === 'replacement') f.connect()
      else await f.service.stop()
      await refused
      expect(f.connection.query).not.toHaveBeenCalled()
      if (end === 'timeout') expect(warn).toHaveBeenCalledWith('[wifi] WIFI_IDENTITY_TIMEOUT')
      await f.service.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('does not let an already queued old identity deadline revoke the replacement connection', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout'), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup(), asker = { local: true, owner: true }
    try {
      f.connect()
      const oldDeadline = timers.mock.calls.find(([, ms]) => ms === 15_000)![0] as () => void
      f.connect()
      oldDeadline()
      f.event({ kind: 'resume' })
      expect(await f.options().requests!.wifi_http({}, asker)).toMatchObject({ status: 200 })
      expect(warn).not.toHaveBeenCalled()
      await f.service.stop()
    } finally { timers.mockRestore() }
  })

  it('withholds cached follow rows until the same component has a verified connection', async () => {
    const f = setup(), asker = { local: true, owner: true }, rows = vi.fn()
    f.answer('follow_agents', { agents: [{ agentId: 'private-agent' }] })
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.disconnect(); f.connect()
    const stop = f.api().agents.follow!(rows)
    expect(rows).not.toHaveBeenCalled()
    stop()
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.api().agents.follow!(rows)()
    expect(rows).toHaveBeenCalledExactlyOnceWith({ kind: 'running', session: { agentId: 'private-agent' } })
    await f.service.stop()
  })

  it.each([undefined, '', 7])('never authorizes an invalid machine identity: %s', async id => {
    const f = setup(), asker = { local: true, owner: true }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.answer('machine', { id })
    f.connect(); f.event({ kind: 'resume' })
    expect(await f.options().requests!.wifi_http({}, asker)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    expect(f.start).not.toHaveBeenCalled()
    await f.service.stop()
  })

  it('refuses a private reply after a different machine rebuild on the same core socket', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: (answer: Record<string, unknown>) => void
    vi.mocked(f.connection.query).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const read = f.api().turns.recent('old-private-agent', 1)
    const refused = expect(read).rejects.toThrow('the original core connection ended')
    f.answer('machine', { id: 'machine-2' }); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, asker)
    release({ turns: [{ recap: 'old private content' }] })
    await refused
    await f.service.stop()
  })

  it.each(['same', 'different'] as const)('binds actual durable Store preparation to its component after a %s-machine reconnect', async identity => {
    const directory = mkdtempSync(join(tmpdir(), 'wifi-store-owner-'))
    const f = setup({ dataDir: directory }), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    const old = f.api(), agents: StoreAgent[] = []
    let release!: () => void, entered!: () => void
    const workspace = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const store = new AutonomousDeviceStore({
      directory: join(directory, 'preparations'), machineId: 'machine-1',
      packages: async () => [{ packageId: 'owner/package', name: 'Package', description: '', category: null, engine: 'claude',
        installed: true, catalog: true, verified: true, viewerPackageId: null, installAllowed: true, version: 'one', broken: null }],
      install: async () => ({ ok: true }), doctor: async () => ({ ok: true, checked: true, lines: [] }),
      workspace: async () => { entered(); await workspace; return '/workspace' },
      create: async (packageId, cwd) => {
        const answer = await old.agents.create(createRequest(packageId, cwd))
        if (!answer.ok) return { state: 'failed', error: answer.error }
        agents.push({ agentId: answer.agentId, machineId: 'machine-1', packageId, workspace: cwd, engine: 'claude', state: 'active', runtime: 'ready' })
        return { state: 'created', agentId: answer.agentId }
      },
      agents: () => agents,
    })
    try {
      const result = await store.request('paired-device', { type: 'agent.prepare', requestId: 'b69e1f7c-a82c-4ca0-a782-d870b7b153f9',
        machineId: 'machine-1', packageId: 'owner/package', idempotencyKey: 'durable-owner', workspace: { kind: 'new', name: 'project' } })
      const id = (result.operation as { operationId: string }).operationId
      await waiting
      f.disconnect(); f.connect()
      f.answer('machine', { id: identity === 'same' ? 'machine-1' : 'machine-2' })
      f.answer('create', { ok: true, agentId: 'created' })
      f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
      vi.mocked(f.connection.query).mockClear()
      release()
      await vi.waitFor(() => expect(store.get('paired-device', id).state).toBe(identity === 'same' ? 'ready' : 'needs_user_action'))
      expect(vi.mocked(f.connection.query).mock.calls.filter(([query]) => query === 'create')).toHaveLength(identity === 'same' ? 1 : 0)
      if (identity === 'different') expect(store.get('paired-device', id).error?.code).toBe('CREATION_UNCONFIRMED')
    } finally { release(); store.stopUiDelivery(); await f.service.stop(); rmSync(directory, { recursive: true, force: true }) }
  })

  it.each(['recent', 'create', 'stepFocus'] as const)('rejects a late %s completion when the same connection facade reconnects', async operation => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: (answer: Record<string, unknown>) => void
    let sent!: () => void
    const entered = new Promise<void>(done => { sent = done })
    vi.mocked(f.connection.query).mockClear().mockImplementationOnce(() => { sent(); return new Promise(resolve => { release = resolve }) })
    const api = f.api()
    const request = operation === 'recent' ? api.turns.recent('a', 1)
      : operation === 'create' ? api.agents.create(createRequest())
      : api.wifi.stepFocus('next', 'a')
    const rejected = expect(request).rejects.toThrow('the original core connection ended')
    await entered
    // The socket read the reply before closing, but its continuation has not run yet.
    release({ ok: true, agentId: 'created', machineId: 'machine-1', turns: [{ recap: 'old' }] })
    f.disconnect(); f.connect()
    await rejected
    expect(f.connection.query).toHaveBeenCalledTimes(1)
    await f.service.stop()
  })

  it('delivers durable reveal after verified identity without requiring a transient view or replaying across reconnect', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    const owner = f.api()
    expect(focusWindow(owner, 'a', 9, 'revision')).toBe(false)
    expect(revealWindow(owner, 'durable-operation', 'a')).toBe(true)
    expect(f.notices).toEqual([['window', { target: { kind: 'first' }, frame: { type: 'device_prepare_open',
      payload: { operationId: 'durable-operation', machineId: 'machine-1', agentId: 'a' } } }]])
    f.disconnect()
    expect(revealWindow(owner, 'while-disconnected', 'a')).toBe(false)
    f.connect()
    expect(revealWindow(owner, 'before-handshake', 'a')).toBe(false)
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    expect(f.notices).toHaveLength(1)
    expect(revealWindow(owner, 'durable-operation', 'a')).toBe(true)
    expect(f.notices).toHaveLength(2)
    expect(focusWindow(owner, 'a', 9, 'revision')).toBe(false)
    await f.service.stop()
    expect(revealWindow(owner, 'after-stop', 'a')).toBe(false)
    expect(f.notices).toHaveLength(2)
  })

  it('keeps optional notice transport unavailable without throwing or queueing work', async () => {
    const f = setup(), asker = { local: true, owner: true }
    delete f.connection.notice
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    expect(revealWindow(f.api(), 'op', 'a')).toBe(true)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    expect(focusWindow(f.api(), 'a', 9, 'r')).toBe(true)
    expect(f.api().wifi.scroll('move', 1, 2)).toBe(true)
    expect(f.notices).toEqual([])
    await f.service.stop()
  })

  it('revokes cached window notices until a fresh view on the replacement connection', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.answer('session_read_registered', snapshotFixture())
    const owner = f.api(), wifi = owner.wifi
    await f.adapter().readView!()
    f.disconnect()
    for (const reconnect of [false, true]) {
      if (reconnect) f.connect() // runServiceProcess reuses this same facade.
      expect(wifi.scroll('move', 2, 3)).toBe(false)
      expect(focusWindow(owner, 'a', 9, 'revision')).toBe(false)
      revealWindow(owner, 'old-operation', 'a')
      expect(f.notices).toEqual([])
    }
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    await f.adapter().readView!()
    expect(wifi.scroll('move', 2, 3)).toBe(true)
    expect(focusWindow(owner, 'a', 9, 'revision')).toBe(true)
    revealWindow(owner, 'durable-operation', 'a')
    expect(f.notices.map(([kind]) => kind)).toEqual(['scroll', 'window', 'window'])
    await f.service.stop()
  })

  it('refuses a resolved evidence read after its captured core is replaced', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: (value: Record<string, unknown>) => void
    const entered = new Promise<void>(done => vi.mocked(f.connection.query).mockImplementationOnce(() => {
      done(); return new Promise(resolve => { release = resolve })
    }))
    const read = f.api().conversations.resolve('a')
    const refused = expect(read).rejects.toThrow('CORE_EVIDENCE_UNAVAILABLE')
    await entered
    f.connect() // A new connection callback revokes the prior one even without a separate close callback.
    release({ value: { agentId: 'a', sessionId: 's', engine: 'claude' } }); await refused
    f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.answer('resolve', { value: { agentId: 'wrong', sessionId: 's', engine: 'claude' } })
    expect(await f.api().conversations.resolve('a')).toBeNull()
    f.answer('resolve', { value: null })
    expect(await f.api().conversations.resolve('a')).toBeNull()
    await f.service.stop()
  })

  it('rejects pre-connection ordinary notices and reports unavailable wake after disconnect', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.event({ kind: 'revealed', operationId: 'unbound', agentId: 'a' })
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    expect(f.log.some(line => line.includes(' revealed '))).toBe(false)
    f.disconnect()
    expect(await f.options().requests!.wifi_serving({}, asker)).toEqual({ serving: false })
    await f.service.stop()
  })

  it('keeps an old handler rejection from revoking a replacement notice owner', async () => {
    const f = setup(), asker = { local: true, owner: true }, warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let reject!: (error: Error) => void
    const entered = new Promise<void>(done => vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => {
      done(); return new Promise((_resolve, fail) => { reject = fail })
    }))
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'a', connId: 'w' }); await entered
    f.disconnect(); f.connect(); f.event({ kind: 'resume' })
    reject(new Error('old failure'))
    expect(await f.options().requests!.wifi_http({}, asker)).toMatchObject({ status: 200 })
    expect(warn).not.toHaveBeenCalled()
    await f.service.stop()
  })
  it('bounds notices behind a held handler, revokes their effects, and retains debt across reconnect', async () => {
    const f = setup(), asker = { local: true, owner: true }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: () => void
    const entered = new Promise<void>(done => vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => {
      done(); return new Promise(resolve => { release = resolve })
    }))
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'a', connId: 'w' }); await entered
    for (let n = 1; n <= 100; n++) f.event({ kind: 'revealed', operationId: 'op', agentId: 'a' })
    try {
      expect(warn).toHaveBeenCalledWith('[wifi] WIFI_NOTICE_BACKPRESSURE')
      expect(f.ports[0].disconnected).toHaveBeenCalled()
      f.disconnect(); f.connect(); f.event({ kind: 'resume' })
      expect(await f.options().requests!.wifi_http({}, asker)).toEqual({ error: 'SERVICE_UNAVAILABLE' })
      release()
      await vi.waitFor(async () => {
        f.connect(); f.event({ kind: 'resume' })
        expect(await f.options().requests!.wifi_http({}, asker)).toMatchObject({ status: 200 })
      })
      expect(f.log.some(line => line.includes(' revealed '))).toBe(false)
      f.event({ kind: 'revealed', operationId: 'fresh', agentId: 'a' })
      await f.options().requests!.wifi_http({}, asker)
      expect(f.log.at(-1)).toBe('machine-1 revealed ["fresh","a"]')
    } finally { release(); await f.service.stop(); warn.mockRestore() }
  })

  it('does not let an old resume waiting for its link attach to a later connection', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.event({ kind: 'resume', focus: { machineId: 'old', agentId: 'old', connId: 'old' } })
    await Promise.resolve()
    f.disconnect(); f.connect()
    f.event({ kind: 'resume', focus: { machineId: 'machine-1', agentId: 'a', connId: 'fresh' } })
    await f.options().requests!.wifi_http({}, asker)
    expect(f.log.filter(line => line.includes(' resume '))).toEqual([
      'machine-1 resume [{"focus":{"machineId":"machine-1","agentId":"a","connId":"fresh"}}]',
    ])
    await f.service.stop()
  })

  it('admits only the replacement resume before connected while the prior notice handler still owns its place', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: () => void
    const entered = new Promise<void>(done => vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => {
      done(); return new Promise(resolve => { release = resolve })
    }))
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'old', connId: 'old' }); await entered
    f.event({ kind: 'revealed', operationId: 'stale', agentId: 'old' })
    f.disconnect()
    f.event({ kind: 'resume', focus: { machineId: 'machine-1', agentId: 'fresh', connId: 'new' } })
    f.event({ kind: 'revealed', operationId: 'unbound', agentId: 'old' })
    f.connect()
    const applied = f.options().requests!.wifi_http({}, asker)
    expect(f.log.filter(line => line.includes(' resume '))).toHaveLength(1)
    release(); await applied
    expect(f.log.filter(line => line.includes(' resume '))).toEqual([
      'machine-1 resume [{"focus":null}]',
      'machine-1 resume [{"focus":{"machineId":"machine-1","agentId":"fresh","connId":"new"}}]',
    ])
    expect(f.log.some(line => line.includes(' revealed '))).toBe(false)
    await f.service.stop()
  })

  it('expires a notice prefix visibly while retaining the handler until it actually settles', async () => {
    const f = setup(), asker = { local: true, owner: true }, warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    let release!: () => void
    const entered = new Promise<void>(done => vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => {
      done(); return new Promise(resolve => { release = resolve })
    }))
    vi.useFakeTimers()
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'a', connId: 'w' }); await entered
    f.event({ kind: 'revealed', operationId: 'stale', agentId: 'a' })
    const pending = f.options().requests!.wifi_http({}, asker)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ error: 'SERVICE_UNAVAILABLE' })
    expect(warn).toHaveBeenCalledWith('[wifi] WIFI_NOTICE_TIMEOUT')
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(f.log.some(line => line.includes(' revealed '))).toBe(false)
    await f.service.stop(); vi.useRealTimers(); warn.mockRestore()
  })

  it('resolves on the captured connection only after the response\'s earlier notice prefix has applied', async () => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, asker)
    let release!: () => void
    const entered = new Promise<void>(done => vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => {
      done(); return new Promise(resolve => { release = resolve })
    }))
    const query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    query.mockImplementation(async (name, payload) => {
      if (name === 'resolve') {
        f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'a', connId: 'window' })
        f.event({ kind: 'input', event: { agentId: 'a', deliveryId: 'd', when: 'composer', phase: 'dispatching', sessionId: 's', content: 'hello' } })
      }
      return original(name, payload)
    })
    let returned = false
    const read = f.api().conversations.resolve('a').then(value => { returned = true; return value })
    // A missing adapter returns null without querying; it must fail instead of hanging the test.
    await Promise.race([entered, read])
    expect(release).toBeTypeOf('function')
    expect(returned).toBe(false)
    release()
    expect(await read).toMatchObject({ agentId: 'a', sessionId: 's' })
    expect(f.log.some(line => line.includes(' input '))).toBe(true)
    f.disconnect()
    await expect(f.api().conversations.resolve('a')).rejects.toThrow('CORE_EVIDENCE_UNAVAILABLE')
  })

  it('keeps focus validation behind prior notices and bound to the original connection before and after its answer', async () => {
    const f = setup(), asker = { local: true, owner: true }, payload = { revision: 'revision' }
    const check = () => f.options().requests!.wifi_focus_current(payload, asker)
    expect(await check()).toEqual({ current: false })
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, asker)
    let moved!: () => void
    vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => new Promise(resolve => { moved = resolve }))
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: 'a', connId: 'window' })
    await vi.waitFor(() => expect(moved).toBeTypeOf('function'))
    const waiting = check()
    expect(f.focusCurrent).not.toHaveBeenCalled()
    moved()
    expect(await waiting).toEqual({ current: true })
    expect(f.focusCurrent).toHaveBeenCalledWith(payload, asker, undefined)

    let answered!: (value: { current: boolean }) => void
    f.focusCurrent.mockImplementationOnce(() => new Promise(resolve => { answered = resolve }))
    const stale = check()
    await vi.waitFor(() => expect(answered).toBeTypeOf('function'))
    f.disconnect(); f.connect(); f.event({ kind: 'resume' })
    answered({ current: true })
    expect(await stale).toEqual({ current: false })
    await f.options().requests!.wifi_http({}, asker)

    vi.mocked(f.ports[0].appFocus).mockImplementationOnce(() => new Promise(resolve => { moved = resolve }))
    moved = undefined as never
    f.event({ kind: 'appFocus', machineId: 'machine-1', agentId: null, connId: 'window' })
    await vi.waitFor(() => expect(moved).toBeTypeOf('function'))
    const old = check(), calls = f.focusCurrent.mock.calls.length
    f.disconnect(); moved()
    expect(await old).toEqual({ current: false })
    expect(f.focusCurrent).toHaveBeenCalledTimes(calls)
  })

  it.each(['malformed', 'wrong-machine', 'failed'] as const)('revokes owned window permission when a new snapshot is %s', async failure => {
    const f = setup(), asker = { local: true, owner: true }
    f.connect(); f.event({ kind: 'resume' }); await f.options().requests!.wifi_http({}, asker)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    expect(focusWindow(f.api(), 'a', 9, 'before')).toBe(true)
    f.answer('session_read_registered', failure === 'malformed' ? {} : failure === 'failed' ? new Error('QUERY_FAILED') : snapshotFixture({ machine: { id: 'other', computerId: 'computer-9', name: 'Other' } }))
    await expect(f.adapter().readView!()).rejects.toThrow(failure === 'malformed' ? 'SESSION_READ_UNAVAILABLE' : failure === 'failed' ? 'QUERY_FAILED' : 'WIFI_IDENTITY_UNAVAILABLE')
    expect(focusWindow(f.api(), 'a', 9, 'failed')).toBe(false)
    expect(f.api().wifi.scroll('move', 1, 2)).toBe(false)
    expect(revealWindow(f.api(), 'durable-operation', 'a')).toBe(true)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    expect(focusWindow(f.api(), 'a', 9, 'fresh')).toBe(true)
    await f.service.stop()
  })

  it.each(['reconnect', 'machine-ABA'] as const)('does not let a late snapshot failure revoke a fresh %s window', async change => {
    const f = setup(), asker = { local: true, owner: true }
    const drain = () => f.options().requests!.wifi_http({}, asker)
    f.connect(); f.event({ kind: 'resume' }); await drain()
    let finish!: (value: Record<string, unknown>) => void
    const query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    query.mockImplementation((name, payload) => name === 'session_read_registered' ? new Promise(resolve => { finish = resolve }) : original(name, payload))
    const old = f.adapter().readView!(), failed = expect(old).rejects.toThrow('the original core connection ended')
    if (change === 'reconnect') { f.disconnect(); f.connect(); f.event({ kind: 'resume' }); await drain() }
    else {
      f.answer('machine', { id: 'machine-2' }); f.event({ kind: 'resume' }); await drain()
      f.answer('machine', { id: 'machine-1' }); f.event({ kind: 'resume' }); await drain()
    }
    query.mockImplementation(original)
    f.answer('session_read_registered', snapshotFixture()); await f.adapter().readView!()
    finish({}); await failed
    expect(focusWindow(f.api(), 'a', 9, 'current')).toBe(true)
    expect(f.api().wifi.scroll('move', 1, 2)).toBe(true)
    await f.service.stop()
  })

  it('keeps a pending view bound to its original connection and refuses reads while disconnected', async () => {
    const f = setup()
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    let finish!: (view: Record<string, unknown>) => void
    const query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    query.mockImplementation((name, payload) => name === 'session_read_registered' ? new Promise(resolve => { finish = resolve }) : original(name, payload))
    const reading = f.adapter().readView!()
    const failed = expect(reading).rejects.toThrow('the original core connection ended')
    f.disconnect(); f.connect()
    finish({ ...snapshotFixture() })
    await failed
    expect(f.api().wifi.scroll('down', 0, 0)).toBe(false)
    f.disconnect()
    await expect(f.adapter().readView!()).rejects.toThrow('the Wi-Fi device is not connected to the core')
  })

  it('answers the bounded wake after ordered resume and as unavailable when there is no serving handler', async () => {
    const f = setup()
    const wake = f.options().requests!.wifi_serving
    expect(await wake({}, { local: true, owner: true })).toEqual({ serving: false })
    f.connect(); f.event({ kind: 'resume' })
    expect(await wake({}, { local: true, owner: true })).toEqual({ serving: false })
    const original = f.start.getMockImplementation()!
    f.start.mockImplementationOnce((...args) => ({ ...original(...args), wifi_serving: () => ({ serving: true }) }))
    f.answer('machine', { id: 'replacement' })
    f.event({ kind: 'resume' })
    expect(await wake({}, { local: true, owner: true })).toEqual({ serving: true })
    await f.service.stop()
  })

  it('opens the ordinary observation socket with the selected account machine and existing startup address', async () => {
    const f = setup()
    f.connect(); f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
    const listener = { begin: vi.fn(), question: vi.fn(), end: vi.fn(), unavailable: vi.fn() }
    const budget = f.adapter().answerWork!
    const observation = f.adapter().observeQuestions!(listener, budget)
    await observation.ready
    expect(observeQuestions).toHaveBeenCalledWith({ dataDir: '/data', port: env.PORT, machineId: 'machine-1' }, listener, undefined, budget)
    observation.close()
  })

  it.skipIf(process.platform === 'win32')('binds the real session observer to this process configured daemon socket', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wifi-observer-'))
    const socketPath = unixSocketPath(dataDir, env.PORT)!
    const server = http.createServer(), sockets = new WebSocketServer({ server, path: '/api/local-ws' })
    const f = setup({ dataDir }), handshakes: unknown[] = []
    let peer: WebSocket | undefined, feed: DeviceSessionFeed | undefined
    sockets.on('connection', socket => {
      peer = socket
      socket.on('message', raw => {
        const frame = JSON.parse(raw.toString())
        if (frame.type === 'machine_select') {
          handshakes.push(frame.payload)
          socket.send(JSON.stringify({ type: 'connected', payload: { eventsProtocol: 1 } }))
        } else if (frame.type === 'events_observe') socket.send(JSON.stringify({ type: 'events_observe_result', payload: {
          requestId: frame.payload.requestId, ok: true, generation: 'fixture-generation',
        } }))
      })
    })
    try {
      const listening = once(server, 'listening', { signal: AbortSignal.timeout(5_000) })
      server.listen(socketPath); await listening
      f.connect(); f.event({ kind: 'resume' })
      await f.options().requests!.wifi_http({}, { local: true, owner: true })
      // The lightweight process API intentionally has no daemon view. Its zero port is not this process's address.
      expect(f.api().daemon.port).toBe(0)
      expect(f.adapter().observeSessions).toBeTypeOf('function')
      const delivery = new EventEmitter()
      const receive = vi.fn(async () => { delivery.emit('received') }), unavailable = vi.fn(), pool = new DeviceFeedPool()
      feed = f.adapter().observeSessions!({ pool, receive, unavailable })
      await feed.ready
      expect(handshakes).toEqual([{ machineId: 'machine-1', localProtocolVersion: 1, tool: true, eventsProtocol: 1, questionProtocol: 1 }])
      const frame = { type: 'agent_activity', agentId: 'a', payload: { activity: { state: 'idle' } } }
      const delivered = once(delivery, 'received', { signal: AbortSignal.timeout(5_000) })
      peer!.send(JSON.stringify({ type: 'session_event', payload: { generation: 'fixture-generation', frame } }))
      await delivered
      expect(receive).toHaveBeenCalledWith('a', [frame], expect.any(Function), undefined)
      expect(unavailable).not.toHaveBeenCalled()
    } finally {
      await feed?.stop(); await f.service.stop()
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(dataDir, { recursive: true, force: true })
    }
  })

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
    f.event({ kind: 'resume' })
    await f.options().requests!.wifi_http({}, { local: true, owner: true })
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
    const query = vi.mocked(f.connection.query), original = query.getMockImplementation()!
    let release!: (value: Record<string, unknown>) => void, current = true
    const held = new Promise<Record<string, unknown>>(resolve => { release = resolve })
    query.mockClear().mockImplementation((name, payload) => name === blocked ? held : original(name, payload))
    const writing = f.adapter().submit!('a', 'hello', 'd', () => {}, () => current)
    if (blocked === 'input_contract') {
      // Identity negotiation already confirmed this contract. Revocation still wins at its await.
      current = false; await writing
      expect(query).not.toHaveBeenCalled()
      return
    }
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
    expect(f.log).toEqual([`machine-1 resume [{"focus":{"machineId":"m","agentId":"a","connId":"w"}}]`])
    // The same machine on the next connection: the same service, resumed.
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    expect(f.log.at(-1)).toBe('machine-1 resume [{"focus":null}]')
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

  it('hands input and window notices to its port in order and ignores obsolete feature feed notices', async () => {
    const f = setup()
    f.connect()
    f.event({ kind: 'resume' })
    f.event({ kind: 'session', connId: 'c', client: { role: 'device', identity: 'i' } })
    f.event({ kind: 'session', connId: 'c', client: 'gone' })
    f.event({ kind: 'request', connId: 'c', frame: { type: 'autonomous_device_request' }, opened: { payload: { type: 'hello' } } })
    f.event({ kind: 'request', connId: 'c', frame: 'x', opened: 'y' })
    f.event({ kind: 'card', frame: { type: 'commander_event' }, fullText: 'whole' })
    f.event({ kind: 'card', frame: { type: 'commander_event' }, fullText: 3 })
    f.event({ kind: 'card', frame: null })
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
      'machine-1 delivery [{"deliveryId":"d"}]',
      'machine-1 appFocus ["m","a","w"]',
      'machine-1 appFocus ["m",null,"w"]',
      'machine-1 revealed ["op","a"]',
    ])
  })

  it('reaches the core through its Wi-Fi doors: asked, or told', async () => {
    const f = setup()
    f.connect()
    f.event({ kind: 'resume' })
    await f.settled()
    const owner = f.api(), wifi = owner.wifi
    f.answer('session_read_registered', snapshotFixture())
    expect(await f.adapter().readView!()).toEqual({ agents: [], store: [], hasWindow: true })
    expect(wifi.scroll('move', 2, 3)).toBe(true)
    expect(focusWindow(owner, 'a', 9, 'r')).toBe(true)
    f.answer('session_read_registered', snapshotFixture({ hasWindow: false }))
    await f.adapter().readView!()
    // Without a window in the view the request being answered asked for, nothing is sent to one.
    expect(wifi.scroll('down', 0, 0)).toBe(false)
    expect(focusWindow(owner, 'a', 9, 'r')).toBe(false)
    f.answer('recent', { turns: [{ recap: 'x' }] })
    expect(await f.api().turns.recent('a', 2)).toEqual([{ recap: 'x' }])
    f.answer('recent', {}); expect(await f.api().turns.recent('a', 2)).toEqual([])
    expect(await f.adapter().stop!('a', () => true, new AbortController().signal)).toBe(true)
    f.answer('create', { requestId: 'x', ok: true, agentId: 'made' })
    expect(await owner.agents.create(createRequest('p', '/w'))).toEqual({ ok: true, agentId: 'made' })
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
    revealWindow(owner, 'op', 'a')
    expect(f.notices.map(([kind]) => kind)).toEqual(['scroll', 'window', 'window'])
    expect(f.notices[0][1]).toEqual({ phase: 'move', dy: 2, velocity: 3 })
    expect(f.notices.slice(1)).toEqual([
      ['window', { target: { kind: 'first' }, frame: { type: 'device_focus', payload: { machineId: 'machine-1', agentId: 'a', expiresAt: 9, focusRevision: 'r' } } }],
      ['window', { target: { kind: 'first' }, frame: { type: 'device_prepare_open', payload: { operationId: 'op', machineId: 'machine-1', agentId: 'a' } } }],
    ])
    // The core gone: asked, it says so; told, nothing goes.
    f.disconnect()
    expect(await f.adapter().stop!('a', () => true, new AbortController().signal)).toBe(false)
    revealWindow(owner, 'late', 'a')
    expect(f.notices).toHaveLength(3)
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
    f.event({ kind: 'revealed', agentId: 'a', operationId: 'unavailable' })
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

  it('names a failed notice without content and recovers on the next connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup()
    f.connect()
    f.answer('machine', new Error('the core went away'))
    f.event({ kind: 'resume' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] WIFI_NOTICE_FAILED')
    f.answer('machine', { id: 'machine-1' })
    f.event({ kind: 'resume' })
    f.connect()
    await f.settled()
    expect(f.start).toHaveBeenCalledTimes(1)
    vi.mocked(f.ports[0].appFocus).mockRejectedValueOnce('not an error')
    f.event({ kind: 'appFocus', machineId: 'm', agentId: 'a', connId: 'w' })
    f.event({ kind: 'turnEnded', agentId: 'a' })
    await f.settled()
    expect(warn).toHaveBeenCalledWith('[wifi] WIFI_NOTICE_FAILED')
  })

  it('stops its link and its service', async () => {
    const f = setup()
    await f.service.stop()
    expect(f.stop).toHaveBeenCalled()
    f.connect()
    f.event({ kind: 'resume' })
    await f.settled()
    expect(f.start).not.toHaveBeenCalled()
    const active = setup()
    active.connect(); active.event({ kind: 'resume' })
    await active.options().requests!.wifi_http({}, { local: true, owner: true })
    await active.service.stop()
    expect(active.log.at(-1)).toBe('machine-1 stop')
  })

  it('runs the real service and link by default', async () => {
    runWifiService({ dataDir: '/data', socketPath: '/sock', machineId: 'c', token: 't' })
    real.options!.onConnected!({ query: async () => ({ id: 'machine-1' }) })
    real.options!.onEvent!({ kind: 'resume' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(real.started).toBe(1)
  })
})
