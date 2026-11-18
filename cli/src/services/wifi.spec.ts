import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type CoreApi, type CorePorts, type RemoteClient, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'
import type { LiveEvent } from '../lib/normalize.js'
import { snapshotFixture, snapshotRow } from '../testing/sessionSnapshot.js'
import type { SessionSnapshot } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi as startWifiService, type WifiDeps } from './wifi.js'
import { devicePeerConnection } from '../lib/autonomous-device/peerConnection.js'
import { devicePeerKey } from '../lib/autonomous-device/peerEndpoint.js'
import { GatewayDeviceFixture } from '../testing/devicePeer.js'
import { observeQuestions, type QuestionListener } from '../agentClient/questions.js'
import type { ClientSocket } from '../agentClient/daemon.js'
import type { DeviceSessionFeedOptions } from '../lib/autonomous-device/sessionFeed.js'
import type { createDeviceEvidence } from '../lib/autonomous-device/evidenceReader.js'

vi.mock('../agentClient/questions.js', () => ({ observeQuestions: vi.fn((_where, listener: QuestionListener) => ({
  ready: Promise.resolve().then(() => { listener.begin('fixture'); listener.end('fixture') }), answer: vi.fn(async () => true), close: vi.fn(),
})) }))

const peers: GatewayDeviceFixture[] = []
const peerByCore = new WeakMap<CoreApi, GatewayDeviceFixture>()
const feedByCore = new WeakMap<CoreApi, DeviceSessionFeedOptions>()
const evidenceByCore = new WeakMap<CoreApi, Parameters<typeof createDeviceEvidence>[0]>()
const running: WifiPort[] = []
vi.mock('../lib/autonomous-device/peerConnection.js', () => ({ devicePeerConnection: vi.fn(options => {
  const peer = new GatewayDeviceFixture(options)
  peers.push(peer)
  return peer
}) }))
let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'wifi-service-')) })
afterEach(async () => {
  for (const port of running.splice(0)) await port.stop()
  peers.length = 0
  rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers()
})
const peerFor = (core: CoreApi) => peerByCore.get(core)!
const client: RemoteClient = { role: 'device', label: 'Desk', identity: 'device-1', direct: true }
const agent = { agentId: 'agent', name: 'Agent', engine: 'claude', state: 'idle' }
const snapshotFor = (view: { agents: Array<{ agentId: string; name?: string; engine?: string; state?: string }>; store?: Array<{ agentId: string }>; hasWindow: boolean }): SessionSnapshot => {
  const rows = view.agents.map(agent => snapshotRow(agent.agentId, {
    session: { ...snapshotRow(agent.agentId).session, engine: (agent.engine ?? 'claude') as 'claude' },
    facts: { displayName: agent.name ?? '', terminalAvailable: true, parts: {} }, turnRunning: agent.state === 'running',
  }))
  for (const stored of view.store ?? []) if (!rows.some(row => row.session.agentId === stored.agentId)) rows.push(snapshotRow(stored.agentId,
    { facts: { displayName: '', terminalAvailable: false, parts: {} } }))
  return snapshotFixture({ registered: rows, hasWindow: view.hasWindow })
}
const sent = (core: CoreApi): Array<Record<string, any>> => peerFor(core).replies()
function startWifi(core: CoreApi, ports: ReturnType<typeof emptyPorts>, deps: WifiDeps = {}) {
  const requests = startWifiService(core, ports, {
    evidence: options => {
      evidenceByCore.set(core, options)
      return { arm: vi.fn(async () => {}), input: vi.fn(), flush: vi.fn(async () => {}), changed: vi.fn(),
        forget: vi.fn(), stop: vi.fn(async () => {}), settled: vi.fn(), disconnected: vi.fn(), connected: vi.fn() }
    },
    observeSessions: options => {
      feedByCore.set(core, options)
      return { ready: Promise.resolve(), close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async () => {}) }
    },
    ...deps,
  })
  peerByCore.set(core, peers.at(-1)!)
  running.push(ports.wifi!)
  void ports.wifi!.resume({ focus: null }).catch(() => {})
  return requests
}

const observed = (core: CoreApi, frames: Parameters<DeviceSessionFeedOptions['receive']>[1], source?: string) =>
  feedByCore.get(core)!.receive('agent', frames, () => true, source)

function started(over: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({
    dataDir,
    ...over,
    conversations: { resolve: vi.fn(async () => ({ ...agent, sessionId: 's1' } as never)), ...over.conversations },
    agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })), ...over.agents },
  })
  const ports = emptyPorts()
  const requests = startWifi(core, ports)
  const port = ports.wifi as WifiPort
  /** One of its routes of the door, as the core hands it on: this computer's owner's. */
  const http = async (method: string, target: string, body?: unknown): Promise<Record<string, any>> =>
    requests.wifi_http!({ method, target, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { local: true, owner: true })
  const ask = async (req: Record<string, unknown>, connId = 'c1') => {
    const payload = { requestId: randomUUID(), ...req }
    await peerFor(core).request(connId, payload)
    // Answered once the service's own wait (a stop, an answer) is over.
    await vi.waitFor(() => expect(sent(core).some((m) => m.frame === 'autonomous_device_result' && m.requestId === payload.requestId)).toBe(true))
    return sent(core).find((m) => m.requestId === payload.requestId)!
  }
  const hello = async (connId = 'c1') => {
    peerFor(core).session(connId, client)
    return ask({ type: 'hello', proto: 1 }, connId)
  }
  return { core, port, peer: peerFor(core), ask, hello, http }
}

async function joinDevice(core: CoreApi, connId = 'c1'): Promise<void> {
  const requestId = randomUUID()
  peerFor(core).session(connId, client)
  await peerFor(core).request(connId, { type: 'hello', proto: 1, requestId })
  await vi.waitFor(() => expect(sent(core).some(frame => frame.requestId === requestId)).toBe(true))
}

/** A device's identity as `harness device receipt` names it: a key, as its pairing made it. */
const KEY = Buffer.alloc(32, 7).toString('base64')

describe('the Wi-Fi device, with the dials', () => {
  it('derives the actual device list and Store preparation evidence from shared session facts', async () => {
    const row = (agentId: string, terminalAvailable: boolean) => ({
      session: { agentId, sessionId: '', engine: 'claude', registeredAt: 1, transcriptPath: null, lastHookAt: 0,
        active: true, cwd: dataDir, dsh: null },
      facts: { displayName: `Shown ${agentId}`, terminalAvailable, parts: { dsh: 'service-package' } },
      selectedModel: null, turnRunning: true,
    })
    const snapshot = vi.fn(async () => ({ version: 1, registered: [row('shown', true), row('hidden', false)], cloud: [],
      machine: { id: 'machine-1', computerId: 'c1', name: 'Desk' }, signedIn: true, environment: 'prod', hasWindow: true }))
    const core = fakeCore({ dataDir })
    Object.assign(core.agents, { snapshot })
    let storeOptions!: Parameters<typeof createDeviceStore>[0]
    const ports = emptyPorts()
    startWifi(core, ports, { store: options => { storeOptions = options; return createDeviceStore(options) } })
    await joinDevice(core)
    const requestId = randomUUID()
    await peerFor(core).request('c1', { type: 'agents.list', requestId })
    await vi.waitFor(() => expect(sent(core).some(frame => frame.requestId === requestId)).toBe(true))
    const answer = sent(core).find(frame => frame.requestId === requestId)!
    expect(answer.agents).toEqual([{ agentId: 'shown', machineId: 'machine-1', name: 'Shown shown', engine: 'claude',
      packageId: 'service-package', workspace: realpathSync(dataDir), runtime: 'starting', state: 'running' }])
    expect(storeOptions.agents().map(agent => [agent.agentId, agent.runtime])).toEqual([['shown', 'starting'], ['hidden', 'unavailable']])
    expect(snapshot).toHaveBeenCalled()
  })

  it('builds first-window focus and reveal frames in the component with its verified machine', async () => {
    const sendWindow = vi.fn(() => false)
    const core = fakeCore({ dataDir, machine: { id: () => 'verified-machine' }, clients: { sendWindow } })
    let device!: ConstructorParameters<typeof AutonomousDeviceService>[0]
    let store!: Parameters<typeof createDeviceStore>[0]
    startWifi(core, emptyPorts(), {
      service: options => { device = options; return new AutonomousDeviceService(options) },
      store: options => { store = options; return createDeviceStore(options) },
    })
    expect(device.requestAppFocus!('agent', 123, 'revision')).toBe(false)
    store.reveal!('operation', 'agent')
    expect(sendWindow.mock.calls).toEqual([
      [{ target: { kind: 'first' }, frame: { type: 'device_focus', payload: { machineId: 'verified-machine', agentId: 'agent', expiresAt: 123, focusRevision: 'revision' } } }],
      [{ target: { kind: 'first' }, frame: { type: 'device_prepare_open', payload: { operationId: 'operation', machineId: 'verified-machine', agentId: 'agent' } } }],
    ])
  })

  it('binds a cohost gesture to this component until its result settles', async () => {
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const ports = emptyPorts()
    let given!: ConstructorParameters<typeof AutonomousDeviceService>[0], current!: () => boolean
    let release!: (value: { machineId: string; agentId: string }) => void
    const stepFocus = vi.fn<NonNullable<WifiDeps['desk']>['stepFocus']>((_direction, _agent, active) => {
      current = active; return new Promise<{ machineId: string; agentId: string }>(resolve => { release = resolve })
    })
    const scroll = vi.fn<NonNullable<WifiDeps['desk']>['scroll']>((_phase, _dy, _velocity, active) => active())
    startWifi(core, ports, { service: options => { given = options; return new AutonomousDeviceService(options) }, desk: { stepFocus, scroll } })
    await joinDevice(core)
    expect(given.scroll!('move', 2, 3)).toBe(true)
    stepFocus.mockResolvedValueOnce({ machineId: core.machine.id(), agentId: 'next' })
    expect(await given.stepFocus!('next', 'agent')).toEqual({ machineId: core.machine.id(), agentId: 'next' })
    const step = given.stepFocus!('next', 'agent')
    expect(current()).toBe(true)
    ports.wifi!.disconnected()
    expect(current()).toBe(false)
    release({ machineId: core.machine.id(), agentId: 'next' })
    expect(await step).toBe('no_agents')
    expect(given.scroll!('move', 2, 3)).toBe(false)
    expect(await given.stepFocus!('next', 'agent')).toBe('no_agents')
    expect(core.wifi.stepFocus).not.toHaveBeenCalled()
    expect(core.wifi.scroll).not.toHaveBeenCalled()
  })

  it('uses the supplied guarded devices port inline with a current window and withdraws late results', async () => {
    let hasWindow = false
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow })) } })
    const ports = emptyPorts(), scroll = vi.fn(), stepFocus = vi.fn(async () => ({ machineId: core.machine.id(), agentId: 'next' }))
    ports.devices = { stepFocus, scroll } as unknown as NonNullable<CorePorts['devices']>
    let given!: ConstructorParameters<typeof AutonomousDeviceService>[0]
    startWifi(core, ports, { service: options => { given = options; return new AutonomousDeviceService(options) } })
    await joinDevice(core)
    expect(await given.stepFocus!('next', 'agent')).toBe('no_app')
    expect(given.scroll!('move', 2, 3)).toBe(false)
    expect(stepFocus).not.toHaveBeenCalled(); expect(scroll).not.toHaveBeenCalled()
    hasWindow = true; await ports.wifi!.resume({ focus: null })
    expect(await given.stepFocus!('next', 'agent')).toEqual({ machineId: core.machine.id(), agentId: 'next' })
    expect(given.scroll!('move', 2, 3)).toBe(true)
    let release!: (value: { machineId: string; agentId: string }) => void
    stepFocus.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = given.stepFocus!('next', 'agent')
    ports.wifi!.disconnected(); release({ machineId: core.machine.id(), agentId: 'next' })
    expect(await pending).toBe('no_agents')
    expect(core.wifi.stepFocus).not.toHaveBeenCalled()
    expect(core.wifi.scroll).not.toHaveBeenCalled()
  })

  it('answers on its existing owner-tool question socket with the question id and no permission authority', async () => {
    const actual = await vi.importActual<typeof import('../agentClient/questions.js')>('../agentClient/questions.js')
    const socket = new EventEmitter() as EventEmitter & ClientSocket
    const wire: Array<{ type: string; payload: Record<string, unknown> }> = []
    const frame = (type: string, payload: Record<string, unknown>) => socket.emit('message', { toString: () => JSON.stringify({ type, payload }) }, false)
    socket.close = vi.fn(() => { socket.emit('close', 1000) })
    socket.send = text => {
      const sent = JSON.parse(text); wire.push(sent)
      if (sent.type === 'machine_select') queueMicrotask(() => frame('connected', { questionProtocol: 1 }))
      if (sent.type === 'questions_observe') queueMicrotask(() => {
        frame('questions_observe_result', { requestId: sent.payload.requestId, ok: true, generation: 'g' })
        frame('questions_begin', { generation: 'g' }); frame('questions_end', { generation: 'g' })
      })
    }
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    let given!: ConstructorParameters<typeof AutonomousDeviceService>[0]
    startWifi(core, emptyPorts(), {
      service: options => { given = options; return new AutonomousDeviceService(options) },
      observeQuestions: (listener, budget) => actual.observeQuestions({ dataDir, port: 1, machineId: 'machine-1' }, listener,
        () => { queueMicrotask(() => queueMicrotask(() => socket.emit('open'))); return socket }, budget),
    })
    await joinDevice(core)
    const answer = given.answer('agent', 'the-question-id', { q: 'yes' })
    await Promise.resolve()
    expect(wire.filter(frame => frame.type === 'question_response')).toEqual([{ type: 'question_response', payload: {
      agentId: 'agent', requestId: 'the-question-id', answers: { q: 'yes' }, allowPermissions: false,
    } }])
    frame('question_response_result', { requestId: 'the-question-id', ok: true })
    expect(await answer).toBe(true)
    expect(wire.filter(frame => frame.type === 'machine_select')).toHaveLength(1)
  })

  it('does not confirm an answer after its original core or question observation ended', async () => {
    for (const lost of ['core', 'observation', 'resume', 'stop'] as const) {
      let listener!: QuestionListener, settle!: (ok: boolean) => void, current!: () => boolean
      const answer = vi.fn((_agent: string, _id: string, _answers: Record<string, string>, active: () => boolean) => {
        current = active; return new Promise<boolean>(resolve => { settle = resolve })
      })
      const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
      const ports = emptyPorts(); let given!: ConstructorParameters<typeof AutonomousDeviceService>[0]
      startWifi(core, ports, { service: options => { given = options; return new AutonomousDeviceService(options) },
        observeQuestions: heard => { listener = heard; return { ready: Promise.resolve().then(() => { heard.begin('g'); heard.end('g') }), answer, close: vi.fn() } } })
      await joinDevice(core)
      answer.mockResolvedValueOnce(false)
      expect(await given.answer('agent', 'negative', { q: 'yes' })).toBe(false)
      const pending = given.answer('agent', 'q', { q: 'yes' })
      expect(current()).toBe(true)
      if (lost === 'core') ports.wifi!.disconnected()
      else if (lost === 'observation') listener.unavailable('QUESTION_ANSWER_TIMEOUT')
      else if (lost === 'resume') await ports.wifi!.resume({ focus: null })
      else await ports.wifi!.stop()
      expect(current()).toBe(false)
      settle(true)
      expect(await pending).toBe(false)
      if (lost !== 'resume') expect(await given.answer('agent', 'q', { q: 'yes' })).toBe(false)
      expect(answer).toHaveBeenCalledTimes(2)
      await ports.wifi!.stop()
    }
  })

  it('bounds the existing focus chain and retains its actual charge through disconnect and replacement', async () => {
    const f = started(); await f.hello()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release!: (value: SessionSnapshot) => void
    vi.mocked(f.core.agents.snapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const pending = [f.port.appFocus('machine-1', 'agent', 'w').catch(() => {})]
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    for (let n = 1; n < 100; n++) pending.push(f.port.appFocus('machine-1', 'agent', 'w').catch(() => {}))
    let refused = false
    pending.push(f.port.appFocus('machine-1', 'agent', 'w').catch(() => { refused = true }))
    try {
      await Promise.resolve(); await Promise.resolve()
      expect(refused).toBe(true)
      expect(warn).toHaveBeenCalledWith('[wifi] WIFI_FOCUS_BACKPRESSURE')
      f.port.disconnected()
      const next = started(); await next.hello()
      await expect(next.port.appFocus('machine-1', 'agent', 'w')).rejects.toThrow('WIFI_FOCUS_BACKPRESSURE')
      release(snapshotFor({ agents: [agent], store: [], hasWindow: true })); await Promise.all(pending)
      await next.port.resume({ focus: null })
      await expect(next.port.appFocus('machine-1', 'agent', 'w')).resolves.toBeUndefined()
    } finally { release(snapshotFor({ agents: [agent], store: [], hasWindow: true })); await Promise.all(pending); warn.mockRestore() }
  })

  it('expires a held focus visibly without authorizing its queued moves or freeing actual work', async () => {
    const f = started(); await f.hello()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release!: (value: SessionSnapshot) => void
    vi.mocked(f.core.agents.snapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    vi.useFakeTimers()
    let failed = ''
    const moving = f.port.appFocus('machine-1', 'agent', 'w').catch(error => { failed = error.message })
    await vi.advanceTimersByTimeAsync(0)
    try {
      await vi.advanceTimersByTimeAsync(15_000)
      expect(failed).toBe('WIFI_FOCUS_TIMEOUT')
      expect(warn).toHaveBeenCalledWith('[wifi] WIFI_FOCUS_TIMEOUT')
    } finally { release(snapshotFor({ agents: [agent], store: [], hasWindow: true })); await moving; vi.useRealTimers(); warn.mockRestore() }
  })

  it('does not let an old focus deadline disconnect a replacement core generation', async () => {
    const f = started(); await f.hello()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let release!: (value: SessionSnapshot) => void
    vi.mocked(f.core.agents.snapshot).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    vi.useFakeTimers()
    const moving = f.port.appFocus('machine-1', 'agent', 'old').catch(error => error.message)
    await vi.advanceTimersByTimeAsync(0)
    f.port.disconnected()
    const resuming = f.port.resume({ focus: null })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await moving).toBe('WIFI_FOCUS_TIMEOUT')
    expect(warn).not.toHaveBeenCalled()
    release(snapshotFor({ agents: [agent], store: [], hasWindow: true }))
    await vi.advanceTimersByTimeAsync(0); await resuming
    vi.useRealTimers(); warn.mockRestore()
  })

  it.each(['stopped', 'disconnected', 'replaced'] as const)('revokes a resume still waiting for observation readiness when %s', async change => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const observe = vi.fn(() => ({ ready: held, close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async () => {}) }))
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifiService(core, ports, { observeSessions: observe })
    const port = ports.wifi!; running.push(port)
    const start = vi.spyOn(peers.at(-1)!, 'start')
    const resuming = port.resume({ focus: null })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
    if (change === 'stopped') await port.stop()
    else {
      port.disconnected()
      if (change === 'replaced') {
        observe.mockReturnValueOnce({ ready: Promise.resolve(), close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async () => {}) })
        await port.resume({ focus: null })
      }
    }
    const currentStarts = start.mock.calls.length
    release(); await resuming
    expect(start).toHaveBeenCalledTimes(currentStarts)
  })

  it('reports serving only while the optional component has its core connection', async () => {
    const core = fakeCore({ dataDir }), ports = emptyPorts(), requests = startWifi(core, ports)
    const wake = () => requests.wifi_serving!({}, { local: true, owner: true })
    expect(await wake()).toEqual({ serving: true })
    await ports.wifi!.resume({ focus: null })
    ports.wifi!.disconnected()
    expect(await wake()).toEqual({ serving: false })
    await ports.wifi!.resume({ focus: null })
    expect(await wake()).toEqual({ serving: true })
    await ports.wifi!.stop()
    expect(await wake()).toEqual({ serving: false })
  })

  it('starts only the latest resume when a second core resume arrives after the first view is read', async () => {
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports)
    await ports.wifi!.resume({ focus: null })
    ports.wifi!.disconnected()
    const start = vi.spyOn(peerFor(core), 'start')
    const first = ports.wifi!.resume({ focus: null })
    const second = Promise.resolve().then(() => ports.wifi!.resume({ focus: null }))
    await Promise.all([first, second])
    expect(start).toHaveBeenCalledOnce()
  })

  it('checks conditional focus only after preceding window moves and rejects malformed revisions', async () => {
    let service!: AutonomousDeviceService
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const ports = emptyPorts()
    const requests = startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    const revision = service.focusSnapshot().focusRevision
    const check = (revision: unknown) => requests.wifi_focus_current!({ revision }, { local: true, owner: true })
    expect(await check(revision)).toEqual({ current: true })
    for (const value of [undefined, '', 'x'.repeat(129), 42, revision + 'stale']) expect(await check(value)).toEqual({ current: false })
    let finish!: (value: SessionSnapshot) => void
    vi.mocked(core.agents.snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const moving = ports.wifi!.appFocus('machine-1', 'agent', 'window')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    let settled = false
    const checking = Promise.resolve(check(revision)).then(answer => { settled = true; return answer })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(snapshotFor({ agents: [agent], store: [], hasWindow: true }))
    await moving
    expect(await checking).toEqual({ current: false })
    expect(await check(service.focusSnapshot().focusRevision)).toEqual({ current: true })
  })

  it('does not apply a queued old focus after a new resume supplies the current epoch', async () => {
    let service!: AutonomousDeviceService
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    const token = 'fixture-token-for-service-authority-32-bytes'
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options),
      peer: { composition: 'services', port: 18474, token } })
    await ports.wifi!.resume({ focus: null })
    expect(vi.mocked(devicePeerConnection).mock.calls.at(-1)?.[0]).toMatchObject({
      port: 18474, key: devicePeerKey('services', { HARNESSD_SERVICE_TOKEN: token }),
    })
    const moved = vi.spyOn(service, 'appFocus')
    const old = ports.wifi!.appFocus('machine-1', null, 'old-window')
    const resumed = ports.wifi!.resume({ focus: null })
    await Promise.all([old, resumed])
    expect(moved).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'resume', 'stop'] as const)('revokes a pending focus check on %s and never blesses its old completion', async change => {
    let service!: AutonomousDeviceService
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const ports = emptyPorts()
    const requests = startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    let finish!: (value: SessionSnapshot) => void
    vi.mocked(core.agents.snapshot).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const moving = ports.wifi!.appFocus('machine-1', null, 'window').catch(() => {})
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const checking = requests.wifi_focus_current!({ revision: service.focusSnapshot().focusRevision }, { local: true, owner: true })
    let resumed: Promise<void> | undefined
    if (change === 'stop') await ports.wifi!.stop()
    else { ports.wifi!.disconnected(); if (change === 'resume') resumed = ports.wifi!.resume({ focus: null }) }
    finish(snapshotFor({ agents: [agent], store: [], hasWindow: true }))
    await moving; await resumed
    expect(await checking).toEqual({ current: false })
  })

  it('bounds failed observation reconnects and never retries input effects', async () => {
    vi.useFakeTimers()
    const listeners: QuestionListener[] = []
    const observe = vi.fn((listener: QuestionListener) => {
      listeners.push(listener)
      if (listeners.length > 1) return { ready: Promise.reject(new Error('connection lost')), answer: vi.fn(async () => false), close: vi.fn() }
      listener.begin('initial'); listener.end('initial')
      return { ready: Promise.resolve(), answer: vi.fn(async () => true), close: vi.fn() }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    await joinDevice(core)
    listeners[0].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(250 + 500 + 1_000 + 2_000 + 5_000)
    expect(observe).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(observe).toHaveBeenCalledTimes(6)
    expect(core.turns.deliver).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it('cancels a pending reconnect on last departure and lets a real reconnect replace its timer', async () => {
    vi.useFakeTimers()
    const listeners: QuestionListener[] = [], close = vi.fn()
    let service!: AutonomousDeviceService
    const observe = vi.fn((listener: QuestionListener) => {
      listeners.push(listener)
      listener.begin(`g${listeners.length}`); listener.end(`g${listeners.length}`)
      return { ready: Promise.resolve(), answer: vi.fn(async () => true), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe, service: options => service = new AutonomousDeviceService(options) })
    await joinDevice(core)
    listeners[0].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    peerFor(core).drop('c1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(1)
    const begin = vi.spyOn(service, 'beginQuestions'), question = vi.spyOn(service, 'observeQuestion'), end = vi.spyOn(service, 'endQuestions')
    listeners[0].begin('stale'); listeners[0].question('stale', {}); listeners[0].end('stale'); listeners[0].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    expect(begin).not.toHaveBeenCalled(); expect(question).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
    await joinDevice(core)
    listeners[1].unavailable('QUESTION_OBSERVATION_BACKPRESSURE')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(2)
    await joinDevice(core)
    listeners[2].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    await joinDevice(core)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(4)
    await ports.wifi!.stop()
  })

  it('shares pending readiness across clients and ignores completion after the component stops', async () => {
    let done!: () => void, listener!: QuestionListener, service!: AutonomousDeviceService
    const close = vi.fn(), observe = vi.fn((heard: QuestionListener) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), answer: vi.fn(async () => true), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe, service: options => service = new AutonomousDeviceService(options) })
    for (const connId of ['c1', 'c2']) {
      peerFor(core).session(connId, client)
      await peerFor(core).request(connId, { type: 'hello', proto: 1, requestId: connId })
    }
    expect(observe).toHaveBeenCalledOnce()
    await ports.wifi!.stop()
    const end = vi.spyOn(service, 'endQuestions')
    listener.end('late'); done()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(sent(core)).toEqual([])
    expect(end).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    await expect(ports.wifi!.resume({ focus: null })).rejects.toThrow('CORE_VIEW_UNAVAILABLE')
  })

  it('closes observation when its only pending hello leaves and never restores that departed audience', async () => {
    let done!: () => void, listener!: QuestionListener
    const close = vi.fn(), observe = vi.fn((heard: QuestionListener) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), answer: vi.fn(async () => true), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    peerFor(core).session('pending', client)
    await peerFor(core).request('pending', { type: 'hello', proto: 1, requestId: 'pending' })
    expect(observe).toHaveBeenCalledOnce()
    peerFor(core).drop('pending')
    expect(close).toHaveBeenCalledOnce()
    listener.begin('late'); listener.end('late'); done()
    // All promise continuations from this completed fake transport run before the next turn.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(peerFor(core).sent.some(frame => frame.type === 'joined')).toBe(false)
    expect(sent(core)).toEqual([])
    await ports.wifi!.stop()
  })

  it('closes a fresh restore observer when its last snapshot hello leaves before readiness', async () => {
    let done!: () => void, listener!: QuestionListener
    const close = vi.fn(), observe = vi.fn((heard: QuestionListener) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), answer: vi.fn(async () => true), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    const peer = peerFor(core)
    peer.sessions.set('restored', { connId: 'restored', identity: client.identity, incarnation: 'original', direct: true, hello: true })
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce())
    peer.drop('restored')
    expect(close).toHaveBeenCalledOnce()
    listener.begin('late'); listener.end('late'); done()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(peer.sent.some(frame => frame.type === 'joined')).toBe(false)
    expect(peer.replies()).toEqual([])
  })

  it('refuses observation while core is absent and closes a synchronously refused observer before hello succeeds', async () => {
    const close = vi.fn(), observe = vi.fn((listener: QuestionListener) => {
      listener.unavailable('QUESTION_OBSERVATION_UNSUPPORTED')
      return { ready: Promise.reject(new Error('unsupported')), answer: vi.fn(async () => false), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    await ports.wifi!.resume({ focus: null })
    ports.wifi!.disconnected()
    peerFor(core).session('c1', client)
    await peerFor(core).request('c1', { type: 'hello', proto: 1, requestId: 'absent' })
    expect(observe).not.toHaveBeenCalled()
    expect(sent(core)).toEqual([])
    await ports.wifi!.resume({ focus: null })
    await joinDevice(core)
    expect(sent(core).at(-1)?.error?.code).toBe('QUESTION_STATE_UNAVAILABLE')
    expect(close).toHaveBeenCalledOnce()
    await ports.wifi!.stop()
  })

  it('owns one question observer for a real device, waits for its snapshot and replaces the former question card route', async () => {
    let listener!: QuestionListener, done!: () => void
    const close = vi.fn()
    const observing = vi.mocked(observeQuestions).mockImplementationOnce((_where, heard) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), answer: vi.fn(async () => true), close }
    })
    const before = observing.mock.calls.length
    const f = started({ agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent, { ...agent, agentId: 'unfocused' }], store: [], hasWindow: false })) } })
    const hello = f.hello()
    await vi.waitFor(() => expect(observing.mock.calls.length).toBe(before + 1))
    expect(sent(f.core).some(frame => frame.type === 'hello_result')).toBe(false)
    listener.begin('g')
    const question = { type: 'commander_question', agentId: 'unfocused', payload: { requestId: 'q', questions: [{ q: 'Continue?' }] } }
    listener.question('g', question)
    listener.end('g'); done()
    expect(await hello).toMatchObject({ type: 'hello_result', proto: 1 })
    const status = await f.ask({ type: 'status', machineId: 'machine-1', agentId: 'unfocused' })
    expect(status.openQuestion).toMatchObject({ requestId: 'q' })
    expect((await f.ask({ type: 'status', machineId: 'machine-1', agentId: 'unfocused' })).openQuestion).toMatchObject({ requestId: 'q' })
    f.peer.drop('c1')
    expect(close).toHaveBeenCalledOnce()
    await f.port.stop()
  })

  it.each([null, { agentId: 'other', sessionId: 's1', engine: 'claude' }])('refuses input when the fresh agent read is %j', async resolved => {
    const { core, port, hello, ask } = started({ conversations: { resolve: vi.fn(async () => resolved as never) } })
    await hello()
    const reply = await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'missing', text: 'hello' })
    expect(reply.receipt).toMatchObject({ state: 'rejected' })
    expect(core.turns.deliver).not.toHaveBeenCalled()
    await port.stop()
  })

  it('feeds inline input, delivery, and agent lifecycle facts to the receipt owner and releases subscriptions on stop', async () => {
    const core = fakeCore({ dataDir, conversations: { resolve: vi.fn(async () => ({ ...agent, sessionId: 's1' } as never)) },
      agents: { follow: vi.fn(() => () => {}), snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const stopInput = vi.fn(), stopDelivery = vi.fn(), stopAgents = vi.fn()
    vi.mocked(core.turns.onInput!).mockReturnValue(stopInput)
    vi.mocked(core.turns.onDelivery).mockReturnValue(stopDelivery)
    vi.mocked(core.agents.follow!).mockReturnValue(stopAgents)
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    const request = { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'shared-facts', text: 'hello' }
    const reply = await service.request('device', request)
    expect(reply).toMatchObject({ receipt: { state: 'queued' } })
    const deliveryId = vi.mocked(core.turns.deliver).mock.calls[0][2]
    const input = vi.mocked(core.turns.onInput!).mock.calls[0][0]
    const fact = { agentId: 'agent', deliveryId, sessionId: 's1', when: 'composer' as const, phase: 'dispatching' as const, content: 'hello' }
    input(fact)
    expect(service.needsTranscript('agent', 's1', 'claude')).toBe(true)
    input(fact)
    input({ ...fact, content: undefined })
    input({ ...fact, deliveryId: undefined })
    input({ ...fact, phase: 'written' })
    vi.mocked(core.turns.onDelivery).mock.calls[0][0]({ sessionId: 'agent', deliveryId, state: 'unknown' })
    ports.wifi!.disconnected()
    expect(await service.request('device', request)).toMatchObject({ receipt: { state: 'unknown', error: { code: 'CORE_DISCONNECTED' } } })
    vi.mocked(core.agents.follow!).mock.calls[0][0]({ kind: 'ended', agentId: 'agent' })
    expect(service.needsTranscript('agent', 's1', 'claude')).toBe(false)
    await ports.wifi!.stop()
    expect(stopInput).toHaveBeenCalledOnce()
    expect(stopDelivery).toHaveBeenCalledOnce()
    expect(stopAgents).toHaveBeenCalledOnce()
  })

  it('submits and cancels through the process adapter, with the same bound context and live receipt authority', async () => {
    const core = fakeCore({ dataDir, conversations: { resolve: vi.fn(async () => null) },
      agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    let service!: AutonomousDeviceService
    const ports = emptyPorts(), cancel = vi.fn()
    const submit = vi.fn(async (_agentId: string, _text: string, _deliveryId: string, context: (agent: never) => void, current?: () => boolean) => {
      expect(current!()).toBe(true)
      context({ ...agent, sessionId: 's1' } as never)
    })
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options), submit, cancel })
    await ports.wifi!.resume({ focus: null })
    await service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'adapter', text: 'hello' })
    const deliveryId = submit.mock.calls[0][2]
    expect(core.conversations.resolve).not.toHaveBeenCalled()
    expect(core.turns.onInput).not.toHaveBeenCalled()
    expect(core.turns.onDelivery).not.toHaveBeenCalled()
    ports.wifi!.input({ agentId: 'agent', sessionId: 's1', deliveryId, when: 'composer', phase: 'dispatching', content: 'hello' })
    expect(service.needsTranscript('agent', 's1', 'claude')).toBe(true)
    service.revoke('device')
    expect(cancel).toHaveBeenCalledWith(deliveryId)
    expect(core.turns.cancelDelivery).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it('withdraws an input revoked while its fresh agent read is pending', async () => {
    let release!: (value: never) => void
    const core = fakeCore({ dataDir,
      conversations: { resolve: vi.fn(() => new Promise<never>(done => { release = done })) },
      agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) },
    })
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    const sending = service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'revoked', text: 'hello' })
    await vi.waitFor(() => expect(core.conversations.resolve).toHaveBeenCalledWith('agent'))
    service.revoke('device')
    release({ ...agent, sessionId: 's1' } as never)
    expect(await sending).toMatchObject({ receipt: { state: 'unknown', error: { code: 'REVOKED' } } })
    expect(core.turns.deliver).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it.each(['claude', 'codex', 'commandcode'])('interprets %s native boundaries in its own component', async engine => {
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [{ ...agent, engine }], store: [], hasWindow: true })) } })
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    const end = vi.spyOn(service, 'turnEnded'), start = vi.spyOn(service, 'turnStarted'), stream = vi.spyOn(service, 'stream')
    const events = [{ type: 'turn_ended', payload: {} }, { type: 'turn_started', payload: { userMessage: 'next' } }] as never
    await observed(core, events)
    expect(end).toHaveBeenCalledTimes(engine === 'commandcode' ? 1 : 0)
    expect(start).toHaveBeenCalledWith('agent', null)
    expect(stream).toHaveBeenCalledWith('agent', events)
    await ports.wifi!.stop()
  })

  it('answers a device hello over its current authenticated peer and announces that exact session', async () => {
    const { core, hello } = started()
    const answer = await hello()
    expect(answer).toMatchObject({ connId: 'c1', identity: 'device-1', frame: 'autonomous_device_result', type: 'hello_result', proto: 1, machineId: 'machine-1' })
    expect(peerFor(core).sent).toContainEqual(expect.objectContaining({ type: 'hello', connId: 'c1', identity: 'device-1', hello: true }))
    expect(peerFor(core).sent).toContainEqual(expect.objectContaining({ type: 'joined', connId: 'c1', identity: 'device-1' }))
  })

  it('lists the agents as the core lists them now, each with its last recap', async () => {
    const { core, hello, ask } = started()
    vi.mocked(core.turns.recent).mockResolvedValue([{ recap: '  Fixed   the build ' }] as never)
    await hello()
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1', recap: 'Fixed the build', packageId: null, workspace: null, runtime: 'ready' }])
    expect(core.agents.snapshot).toHaveBeenCalled()
    expect((await ask({ type: 'recap', machineId: 'machine-1', agentId: 'agent', n: 2 })).turns).toEqual([{ recap: '  Fixed   the build ' }])
    expect(core.turns.recent).toHaveBeenLastCalledWith('agent', 2)
  })

  it('types a prompt through the core, follows its transcript, and says when it no longer needs it', async () => {
    const { core, port, hello, ask } = started()
    await hello()
    const reply = await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k1', text: 'hello' })
    expect(reply).toMatchObject({ status: 'accepted', receipt: { state: 'queued' } })
    const deliveryId = vi.mocked(core.turns.deliver).mock.calls[0][2]
    expect(core.turns.deliver).toHaveBeenCalledWith('agent', 'hello', deliveryId, { when: 'composer', current: expect.any(Function) })
    // The core typed it: the service reads the agent's transcript until the turn is proven.
    port.input({ agentId: 'agent', deliveryId, content: 'hello', sessionId: 's1', when: 'composer', phase: 'dispatching' })
    evidenceByCore.get(core)!.observe('agent', 's1', 'claude', '{"type":"user","message":{"content":"not ours"},"timestamp":"2026-10-06T00:00:00Z"}')
    port.input({ agentId: 'other', deliveryId: 'unknown-delivery', content: 'hi', when: 'composer', phase: 'dispatching' })
    await observed(core, [{ type: 'agent_deleted', agentId: 'agent', payload: {} }])
    await observed(core, [{ type: 'agent_deleted', agentId: 'never-told', payload: {} }])
    expect(await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k1', text: 'hello' }))
      .toMatchObject({ receipt: { state: 'unknown' } })
  })

  it('reads the turn\'s whole answer off a summary card, and passes the agents\' turns and live events on', async () => {
    const { core, port, hello } = started()
    await hello()
    peerFor(core).sent.length = 0
    await peerFor(core).card({ type: 'commander_event', agentId: 'agent', dbSessionId: 's1', payload: { kind: 'summary', text: 'short' } }, 'the whole answer')
    await vi.waitFor(() => expect(sent(core).at(-1)).toMatchObject({ frame: 'autonomous_device_event', kind: 'turn.summary', payload: { text: 'short', fullText: 'the whole answer' } }))
    await observed(core, [{ type: 'commander_event', agentId: 'agent', payload: { kind: 'tool', text: 'Read' } }], 'core')
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.tool' })
    await observed(core, [{ type: 'turn_started', payload: { userMessage: 'hello' } }])
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.started' })
    await observed(core, [{ type: 'agent_activity', dbSessionId: 's1', payload: { cause: 'cancel', activity: { epoch: 'core', revision: 1 } } }])
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.error' })
    port.delivery({ deliveryId: 'nobody', sessionId: 'agent', state: 'delivered' })
    port.input({ deliveryId: 'nobody', agentId: 'agent', when: 'composer', phase: 'waiting_for_turn' })
    port.revealed('op', 'agent')
  })

  it('applies window moves in order and keeps their revision in the component', async () => {
    let service!: AutonomousDeviceService
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    const first = ports.wifi!.appFocus('machine-1', 'agent', 'w1')
    const second = ports.wifi!.appFocus('machine-1', null, 'w1')
    await Promise.all([first, second])
    expect(service.focusSnapshot()).toMatchObject({ focus: null, focusRevision: expect.stringMatching(/:2$/) })
    expect(core.agents.snapshot).toHaveBeenCalled()
  })

  it('lets a failed focus move cost that move alone and applies the next one', async () => {
    let service!: AutonomousDeviceService
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true })) } })
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ focus: null })
    vi.spyOn(service, 'appFocus').mockImplementationOnce(() => { throw new Error('focus unavailable') })
    await expect(ports.wifi!.appFocus('machine-1', 'agent', 'w1')).rejects.toThrow('focus unavailable')
    await ports.wifi!.appFocus('machine-1', 'agent', 'w1')
    expect(service.focusSnapshot().focus?.agentId).toBe('agent')
    vi.spyOn(service, 'appFocus').mockImplementationOnce(() => { throw new Error('focus unavailable') })
    await ports.wifi!.resume({ focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w2' } })
    expect(peerFor(core).sent.some(frame => frame.type === 'ready')).toBe(true)
  })

  it('restores only current gateway hello sessions after a component connection restarts', async () => {
    const { core, port, peer, hello } = started()
    await hello('stale')
    port.disconnected()
    peer.sessions.clear()
    peer.session('c9', client)
    peer.sessions.set('c9', { ...peer.sessions.get('c9')!, hello: true })
    peer.sent.length = 0
    await port.resume({ focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w' } })
    await vi.waitFor(() => expect(peer.sent.some(frame => frame.type === 'ready')).toBe(true))
    expect(sent(core)).toContainEqual(expect.objectContaining({ connId: 'c9', frame: 'autonomous_device_event', type: 'resync', reason: 'instance_changed' }))
    expect(peer.sent).toContainEqual(expect.objectContaining({ type: 'hello', connId: 'c9', hello: true }))
    peer.sent.length = 0
    await port.resume({ focus: null })
    expect(sent(core).filter(frame => frame.type === 'resync')).toEqual([])
    port.disconnected()
    peer.sessions.clear()
    await port.resume({ focus: null })
    await vi.waitFor(() => expect(peer.sent.some(frame => frame.type === 'ready')).toBe(true))
    expect(peer.sent.some(frame => frame.type === 'hello' || frame.type === 'joined')).toBe(false)
  })

  it('carries device add-ons end to end: what the device publishes, an agent\'s proposal sealed to it, and its decision', async () => {
    const { core, port, hello, ask, http } = started()
    expect(await http('POST', '/api/autonomous-device/addon/propose', { addon: 'glow', idempotencyKey: 'k', act: 'light', holdsMs: 5000 }))
      .toEqual({ status: 409, body: { error: { code: 'MISSING_TARGET', message: 'No connected device offers add-ons' } } })
    await hello()
    expect(await ask({ type: 'addon.publish', values: [{ topic: 'room/presence', value: { someone: true } }] })).toMatchObject({ type: 'addon.publish_result', topics: 1 })
    expect(await http('GET', '/api/autonomous-device/addon/state'))
      .toMatchObject({ status: 200, body: { devices: [{ deviceId: 'device-1', online: true, topics: { 'room/presence': { value: { someone: true } } } }] } })
    peerFor(core).sent.length = 0
    const proposed = await http('POST', '/api/autonomous-device/addon/propose', { addon: 'glow', idempotencyKey: 'k', act: 'light', holdsMs: 5000, params: { colour: 'warm' } })
    const proposalId = proposed.body.proposal.proposalId as string
    expect(sent(core)).toEqual([expect.objectContaining({ connId: 'c1', identity: 'device-1', frame: 'autonomous_device_event', kind: 'addon.proposal',
      payload: expect.objectContaining({ proposalId, addon: 'glow', act: 'light', params: { colour: 'warm' } }) })])
    expect(await ask({ type: 'addon.decision', proposalId, decision: 'dropped', reason: 'someone is talking' })).toMatchObject({ state: 'dropped' })
    expect(await http('GET', `/api/autonomous-device/addon/proposal?proposalId=${proposalId}`))
      .toMatchObject({ status: 200, body: { proposal: { proposalId, state: 'dropped', reason: 'someone is talking' } } })
    peerFor(core).revoke('device-1')
    expect(await http('GET', '/api/autonomous-device/addon/state')).toEqual({ status: 200, body: { devices: [] } })
    // Not its routes: the pairings are the gateway's.
    expect((await http('GET', '/api/autonomous-device/list')).status).toBe(404)
    await port.stop()
  })

  it('forgets a closed connection and an unpaired device, and answers a receipt', async () => {
    const { core, port, hello, ask, http } = started()
    peerFor(core).session('c1', { ...client, identity: KEY })
    await ask({ type: 'hello', proto: 1 })
    await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k2', text: 'hi' })
    const receipt = (key: string) => http('GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(KEY)}&idempotencyKey=${key}`)
    expect(await receipt('k2')).toMatchObject({ status: 200, body: { receipt: { idempotencyKey: 'k2', state: 'queued' } } })
    expect(await receipt('nope')).toEqual({ status: 200, body: { receipt: null } })
    peerFor(core).revoke(KEY)
    expect(core.turns.cancelDelivery).toHaveBeenCalled()
    expect(await receipt('k2')).toEqual({ status: 200, body: { receipt: null } })
    await hello('c2')
    peerFor(core).drop('c2')
    expect(peerFor(core).sessions.has('c2')).toBe(false)
    // A session the gateway no longer holds is sent nothing.
    peerFor(core).session('c3', client)
    peerFor(core).session('c3', null)
    peerFor(core).sent.length = 0
    await peerFor(core).request('c3', { type: 'hello', proto: 1, requestId: randomUUID() })
    expect(sent(core)).toEqual([])
    await port.stop()
  })

  it('answers a request with the agents it last had when the core cannot be asked', async () => {
    const view = vi.fn(async () => snapshotFor({ agents: [agent], store: [], hasWindow: true }))
    const { hello, ask } = started({ agents: { snapshot: view } })
    await hello()
    view.mockRejectedValueOnce(new Error('the core went away'))
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1', packageId: null, workspace: null, runtime: 'ready' }])
  })

  it('reaches the core for a stop, an answer, a step along the desk, a stroke and the window\'s focus', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'turn.stop', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 's1' })).toMatchObject({ receipt: { state: 'completed' } })
    expect(core.wifi.stop).toHaveBeenCalledWith('agent')
    expect(await ask({ type: 'focus.ensure', machineId: 'untrusted-other-machine' })).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    expect(core.clients.sendWindow).not.toHaveBeenCalled()
    // No window took the ask: said at once.
    vi.mocked(core.clients.sendWindow).mockReturnValueOnce(false)
    expect(await ask({ type: 'focus.ensure' })).toMatchObject({ error: { code: 'FOCUS_UNAVAILABLE' } })
    expect(core.clients.sendWindow).toHaveBeenCalledWith({ target: { kind: 'first' }, frame: { type: 'device_focus', payload: { machineId: 'machine-1', agentId: 'agent', expiresAt: expect.any(Number), focusRevision: expect.any(String) } } })
    expect(await ask({ type: 'scroll', phase: 'down', dy: 1, velocity: 2 })).not.toHaveProperty('error')
    expect(core.wifi.scroll).toHaveBeenCalledWith('down', 1, 2)
    const focus = (await ask({ type: 'focus.get' })).focusRevision
    expect(await ask({ type: 'focus.step', direction: 'next', idempotencyKey: 'f1', focusRevision: focus })).toMatchObject({ error: { code: 'NO_AGENTS' } })
    expect(core.wifi.stepFocus).toHaveBeenCalledWith('next', undefined)
  })

  it('gives the Store the agents the core listed, and makes and shows its agents through the core', async () => {
    const core = fakeCore({ dataDir, agents: { snapshot: vi.fn(async () => snapshotFor({ agents: [], store: [{ agentId: 'a' } as never], hasWindow: true })) } })
    let given: Parameters<typeof createDeviceStore>[0] | undefined
    const ports = emptyPorts()
    startWifi(core, ports, { store: (options) => { given = options; return createDeviceStore(options) } })
    expect(given!.agents()).toEqual([])
    await ports.wifi!.appFocus('machine-1', null, 'w')
    expect(given!.agents()).toEqual([{ agentId: 'a', machineId: 'machine-1', engine: 'claude', packageId: null, workspace: null, state: 'active', runtime: 'unavailable' }])
    await given!.create('autonomous/robot', 'claude', '/w')
    expect(core.wifi.create).toHaveBeenCalledWith('autonomous/robot', 'claude', '/w')
    given!.reveal!('op', 'a')
    expect(core.clients.sendWindow).toHaveBeenCalledWith({ target: { kind: 'first' }, frame: { type: 'device_prepare_open', payload: { operationId: 'op', machineId: 'machine-1', agentId: 'a' } } })
  })

  it('keeps transcript receipt evidence in the component and refuses an answer before its observation exists', async () => {
    const core = fakeCore({ dataDir })
    let given: ConstructorParameters<typeof AutonomousDeviceService>[0] | undefined
    startWifi(core, emptyPorts(), { service: (options) => { given = options; return new AutonomousDeviceService(options) } })
    expect(given!.inputConsumed).toBeUndefined()
    expect(await given!.answer('agent', 'r', { q: 'yes' })).toBe(false)
  })

  it('gives up a pairing the device asked to give up, over its own session', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'pair.revoke' })).toMatchObject({ revoked: true })
    expect(peerFor(core).sent.at(-1)).toMatchObject({ type: 'revoke', identity: 'device-1', connId: 'c1' })
  })

  it('leaves the Wi-Fi device off, and the devices on, when its journal cannot be read', () => {
    writeFileSync(join(dataDir, 'device-results.json'), '{"version": 1, "entries": [', { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ports = emptyPorts()
    expect(() => startWifi(fakeCore({ dataDir }), ports)).toThrow('the Wi-Fi device service could not be started')
    expect(ports.wifi).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the Wi-Fi device service could not be started'))
    warn.mockRestore()
  })

  it('reads add-on state for one device, a proposal never sent as none, and lets an unexpected failure through', async () => {
    const { port, hello, ask, http } = started()
    await hello()
    await ask({ type: 'addon.publish', values: [{ topic: 'mood/state', value: { energy: 0.5 } }] })
    expect(await http('GET', '/api/autonomous-device/addon/state?deviceId=device-1')).toMatchObject({ status: 200, body: { devices: [{ deviceId: 'device-1' }] } })
    expect(await http('GET', '/api/autonomous-device/addon/state?deviceId=nobody')).toEqual({ status: 200, body: { devices: [] } })
    expect(await http('GET', `/api/autonomous-device/addon/proposal?proposalId=${randomUUID()}`))
      .toEqual({ status: 404, body: { error: { code: 'PROPOSAL_UNKNOWN', message: 'No such proposal: never sent, or aged out after ten minutes' } } })
    await port.stop()
    // A failure that is no refusal fails the request: its route answers for it as for a service that is down.
    const requests = startWifi(fakeCore({ dataDir }), emptyPorts(), {
      service: options => { const service = new AutonomousDeviceService(options); vi.spyOn(service.addons, 'state').mockImplementation(() => { throw new Error('broken') }); return service },
    })
    await expect(requests.wifi_http!({ method: 'GET', target: '/api/autonomous-device/addon/state' }, { local: true, owner: true })).rejects.toThrow('broken')
  })

})
