import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type CoreApi, type RemoteClient, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { createDeviceStore } from '../lib/autonomous-device/storeRuntime.js'
import type { LiveEvent } from '../lib/normalize.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi } from './wifi.js'
import { observeQuestions, type QuestionListener } from '../agentClient/questions.js'

vi.mock('../agentClient/questions.js', () => ({ observeQuestions: vi.fn((_where, listener: QuestionListener) => ({
  ready: Promise.resolve().then(() => { listener.begin('fixture'); listener.end('fixture') }), close: vi.fn(),
})) }))

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'wifi-service-')) })
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); vi.useRealTimers() })

const client: RemoteClient = { role: 'device', label: 'Desk', identity: 'device-1', direct: true }
const agent = { agentId: 'agent', name: 'Agent', engine: 'claude', state: 'idle' }
/** A request as the gateway hands it on: sealed as it came, and as its session opened it. */
const sealed = (req: Record<string, unknown>) => [{ type: 'autonomous_device_request', payload: { __e2e: true } }, { payload: req }] as const
/** What the service sent the device, in order: the core seals each to its session. */
const sent = (core: CoreApi): Array<Record<string, any>> =>
  vi.mocked(core.wifi.send).mock.calls.map(([connId, identity, frame, payload]) => ({ connId, identity, frame, ...payload }))

function started(over: Parameters<typeof fakeCore>[0] = {}) {
  const core = fakeCore({
    dataDir,
    ...over,
    conversations: { resolve: vi.fn(async () => ({ ...agent, sessionId: 's1' } as never)), ...over.conversations },
    wifi: { view: vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true })), ...over.wifi },
  })
  const ports = emptyPorts()
  const requests = startWifi(core, ports)
  const port = ports.wifi as WifiPort
  /** One of its routes of the door, as the core hands it on: this computer's owner's. */
  const http = async (method: string, target: string, body?: unknown): Promise<Record<string, any>> =>
    requests.wifi_http!({ method, target, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { local: true, owner: true })
  const ask = async (req: Record<string, unknown>, connId = 'c1') => {
    const [frame, opened] = sealed({ requestId: randomUUID(), ...req })
    await port.request(connId, frame, opened)
    // Answered once the service's own wait (a stop, an answer) is over.
    await vi.waitFor(() => expect(sent(core).some((m) => m.frame === 'autonomous_device_result' && m.requestId === opened.payload.requestId)).toBe(true))
    return sent(core).find((m) => m.requestId === opened.payload.requestId)!
  }
  const hello = async (connId = 'c1') => {
    port.session(connId, client)
    return ask({ type: 'hello', proto: 1 }, connId)
  }
  return { core, port, ask, hello, http }
}

/** A device's identity as `harness device receipt` names it: a key, as its pairing made it. */
const KEY = Buffer.alloc(32, 7).toString('base64')

describe('the Wi-Fi device, with the dials', () => {
  it('bounds failed observation reconnects and never retries input effects', async () => {
    vi.useFakeTimers()
    const listeners: QuestionListener[] = []
    const observe = vi.fn((listener: QuestionListener) => {
      listeners.push(listener)
      if (listeners.length > 1) return { ready: Promise.reject(new Error('connection lost')), close: vi.fn() }
      listener.begin('initial'); listener.end('initial')
      return { ready: Promise.resolve(), close: vi.fn() }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    await ports.wifi!.resume({ sessions: [{ connId: 'c1', client }], helloed: [{ connId: 'c1', identity: client.identity }], focus: null })
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
      return { ready: Promise.resolve(), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe, service: options => service = new AutonomousDeviceService(options) })
    const state = { sessions: [{ connId: 'c1', client }], helloed: [{ connId: 'c1', identity: client.identity }], focus: null }
    await ports.wifi!.resume(state)
    listeners[0].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    ports.wifi!.dropped('c1')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(1)
    const begin = vi.spyOn(service, 'beginQuestions'), question = vi.spyOn(service, 'observeQuestion'), end = vi.spyOn(service, 'endQuestions')
    listeners[0].begin('stale'); listeners[0].question('stale', {}); listeners[0].end('stale'); listeners[0].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    expect(begin).not.toHaveBeenCalled(); expect(question).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled()
    await ports.wifi!.resume(state)
    listeners[1].unavailable('QUESTION_OBSERVATION_BACKPRESSURE')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(2)
    await ports.wifi!.resume(state)
    listeners[2].unavailable('QUESTION_OBSERVATION_UNAVAILABLE')
    await ports.wifi!.resume(state)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(observe).toHaveBeenCalledTimes(4)
    await ports.wifi!.stop()
  })

  it('shares pending readiness across clients and ignores completion after the component stops', async () => {
    let done!: () => void, listener!: QuestionListener, service!: AutonomousDeviceService
    const close = vi.fn(), observe = vi.fn((heard: QuestionListener) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe, service: options => service = new AutonomousDeviceService(options) })
    for (const connId of ['c1', 'c2']) {
      ports.wifi!.session(connId, client)
      const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: connId })
      await ports.wifi!.request(connId, frame, opened)
    }
    expect(observe).toHaveBeenCalledOnce()
    await ports.wifi!.stop()
    const end = vi.spyOn(service, 'endQuestions')
    listener.end('late'); done()
    await vi.waitFor(() => expect(sent(core).filter(frame => frame.error?.code === 'QUESTION_STATE_UNAVAILABLE')).toHaveLength(2))
    expect(end).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    await expect(ports.wifi!.resume({ sessions: [{ connId: 'c1', client }], helloed: [{ connId: 'c1', identity: client.identity }], focus: null })).rejects.toThrow('unavailable')
  })

  it('closes observation when its only pending hello leaves and never restores that departed audience', async () => {
    let done!: () => void, listener!: QuestionListener
    const close = vi.fn(), observe = vi.fn((heard: QuestionListener) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    ports.wifi!.session('pending', client)
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: 'pending' })
    await ports.wifi!.request('pending', frame, opened)
    expect(observe).toHaveBeenCalledOnce()
    ports.wifi!.dropped('pending')
    expect(close).toHaveBeenCalledOnce()
    listener.begin('late'); listener.end('late'); done()
    // All promise continuations from this completed fake transport run before the next turn.
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(core.wifi.joined).not.toHaveBeenCalled()
    expect(sent(core)).toEqual([])
    expect(vi.mocked(core.wifi.hello).mock.calls).toEqual([['pending', null]])
    await ports.wifi!.stop()
  })

  it('refuses observation while core is absent and closes a synchronously refused observer before readiness', async () => {
    const close = vi.fn(), observe = vi.fn((listener: QuestionListener) => {
      listener.unavailable('QUESTION_OBSERVATION_UNSUPPORTED')
      return { ready: Promise.reject(new Error('unsupported')), close }
    })
    const core = fakeCore({ dataDir }), ports = emptyPorts()
    startWifi(core, ports, { observeQuestions: observe })
    ports.wifi!.disconnected()
    ports.wifi!.session('c1', client)
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: 'absent' })
    await ports.wifi!.request('c1', frame, opened)
    await vi.waitFor(() => expect(sent(core).some(frame => frame.error?.code === 'QUESTION_STATE_UNAVAILABLE')).toBe(true))
    expect(observe).not.toHaveBeenCalled()
    await expect(ports.wifi!.resume({ sessions: [{ connId: 'c1', client }], helloed: [{ connId: 'c1', identity: client.identity }], focus: null })).rejects.toThrow('unsupported')
    expect(close).toHaveBeenCalledOnce()
    expect(core.wifi.ready).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it('owns one question observer for a real device, waits for its snapshot and replaces the former question card route', async () => {
    let listener!: QuestionListener, done!: () => void
    const close = vi.fn()
    const observing = vi.mocked(observeQuestions).mockImplementationOnce((_where, heard) => {
      listener = heard
      return { ready: new Promise<void>(resolve => { done = resolve }), close }
    })
    const before = observing.mock.calls.length
    const f = started({ wifi: { view: vi.fn(async () => ({ agents: [agent, { ...agent, agentId: 'unfocused' }], store: [], hasWindow: false })) } })
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
    f.port.card({ ...question, payload: { requestId: 'old-route', questions: [] } })
    expect((await f.ask({ type: 'status', machineId: 'machine-1', agentId: 'unfocused' })).openQuestion).toMatchObject({ requestId: 'q' })
    f.port.dropped('c1')
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
      agents: { follow: vi.fn(() => () => {}) },
      wifi: { view: vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true })) } })
    const stopInput = vi.fn(), stopDelivery = vi.fn(), stopAgents = vi.fn()
    vi.mocked(core.turns.onInput!).mockReturnValue(stopInput)
    vi.mocked(core.turns.onDelivery).mockReturnValue(stopDelivery)
    vi.mocked(core.agents.follow!).mockReturnValue(stopAgents)
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ sessions: [], helloed: [], focus: null })
    const request = { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'shared-facts', text: 'hello' }
    const reply = await service.request('device', request)
    expect(reply).toMatchObject({ receipt: { state: 'queued' } })
    const deliveryId = vi.mocked(core.turns.deliver).mock.calls[0][2]
    const input = vi.mocked(core.turns.onInput!).mock.calls[0][0]
    const fact = { agentId: 'agent', deliveryId, sessionId: 's1', when: 'composer' as const, phase: 'dispatching' as const, content: 'hello' }
    input(fact)
    expect(service.watchesTranscript('agent')).toBe(true)
    expect(core.wifi.watching).toHaveBeenLastCalledWith(['agent'])
    const watches = vi.mocked(core.wifi.watching).mock.calls.length
    input(fact)
    input({ ...fact, content: undefined })
    input({ ...fact, deliveryId: undefined })
    input({ ...fact, phase: 'written' })
    expect(core.wifi.watching).toHaveBeenCalledTimes(watches)
    vi.mocked(core.turns.onDelivery).mock.calls[0][0]({ sessionId: 'agent', deliveryId, state: 'unknown' })
    ports.wifi!.disconnected()
    expect(await service.request('device', request)).toMatchObject({ receipt: { state: 'unknown', error: { code: 'CORE_DISCONNECTED' } } })
    vi.mocked(core.agents.follow!).mock.calls[0][0]({ kind: 'ended', agentId: 'agent' })
    expect(service.watchesTranscript('agent')).toBe(false)
    await ports.wifi!.stop()
    expect(stopInput).toHaveBeenCalledOnce()
    expect(stopDelivery).toHaveBeenCalledOnce()
    expect(stopAgents).toHaveBeenCalledOnce()
  })

  it('submits and cancels through the process adapter, with the same bound context and live receipt authority', async () => {
    const core = fakeCore({ dataDir, conversations: { resolve: vi.fn(async () => null) },
      wifi: { view: vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true })) } })
    let service!: AutonomousDeviceService
    const ports = emptyPorts(), cancel = vi.fn()
    const submit = vi.fn(async (_agentId: string, _text: string, _deliveryId: string, context: (agent: never) => void, current?: () => boolean) => {
      expect(current!()).toBe(true)
      context({ ...agent, sessionId: 's1' } as never)
    })
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options), submit, cancel })
    await ports.wifi!.resume({ sessions: [], helloed: [], focus: null })
    await service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'adapter', text: 'hello' })
    const deliveryId = submit.mock.calls[0][2]
    expect(core.conversations.resolve).not.toHaveBeenCalled()
    expect(core.turns.onInput).not.toHaveBeenCalled()
    expect(core.turns.onDelivery).not.toHaveBeenCalled()
    ports.wifi!.input({ agentId: 'agent', sessionId: 's1', deliveryId, when: 'composer', phase: 'dispatching', content: 'hello' })
    expect(service.watchesTranscript('agent')).toBe(true)
    service.revoke('device')
    expect(cancel).toHaveBeenCalledWith(deliveryId)
    expect(core.turns.cancelDelivery).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it('withdraws an input revoked while its fresh agent read is pending', async () => {
    let release!: (value: never) => void
    const core = fakeCore({ dataDir,
      conversations: { resolve: vi.fn(() => new Promise<never>(done => { release = done })) },
      wifi: { view: vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true })) },
    })
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ sessions: [], helloed: [], focus: null })
    const sending = service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'revoked', text: 'hello' })
    await vi.waitFor(() => expect(core.conversations.resolve).toHaveBeenCalledWith('agent'))
    service.revoke('device')
    release({ ...agent, sessionId: 's1' } as never)
    expect(await sending).toMatchObject({ receipt: { state: 'unknown', error: { code: 'REVOKED' } } })
    expect(core.turns.deliver).not.toHaveBeenCalled()
    await ports.wifi!.stop()
  })

  it.each(['claude', 'codex', 'commandcode'])('interprets %s native boundaries in its own component', async engine => {
    const core = fakeCore({ dataDir, wifi: { view: vi.fn(async () => ({ agents: [{ ...agent, engine }], store: [], hasWindow: true })) } })
    let service!: AutonomousDeviceService
    const ports = emptyPorts()
    startWifi(core, ports, { service: options => service = new AutonomousDeviceService(options) })
    await ports.wifi!.resume({ sessions: [], helloed: [], focus: null })
    const end = vi.spyOn(service, 'turnEnded'), start = vi.spyOn(service, 'turnStarted'), stream = vi.spyOn(service, 'stream')
    const events = [{ type: 'turn_ended', payload: {} }, { type: 'turn_started', payload: { userMessage: 'next' } }] as never
    ports.wifi!.events('agent', events)
    expect(end).toHaveBeenCalledTimes(engine === 'commandcode' ? 1 : 0)
    expect(start).toHaveBeenCalledWith('agent')
    expect(stream).not.toHaveBeenCalled()
    ports.wifi!.stream('agent', events)
    expect(stream).toHaveBeenCalledWith('agent', events)
    await ports.wifi!.stop()
  })

  it('answers a device\'s hello through the core, which seals it to the session it came on, and counts it as watching', async () => {
    const { core, hello } = started()
    const answer = await hello()
    expect(answer).toMatchObject({ connId: 'c1', identity: 'device-1', frame: 'autonomous_device_result', type: 'hello_result', proto: 1, machineId: 'machine-1' })
    expect(core.wifi.hello).toHaveBeenCalledWith('c1', 'device-1')
    expect(core.wifi.joined).toHaveBeenCalled()
  })

  it('lists the agents as the core lists them now, each with its last recap', async () => {
    const { core, hello, ask } = started()
    vi.mocked(core.turns.recent).mockResolvedValue([{ recap: '  Fixed   the build ' }] as never)
    await hello()
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1', recap: 'Fixed the build' }])
    expect(core.wifi.view).toHaveBeenCalled()
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
    expect(core.wifi.transcripts).not.toHaveBeenCalled()
    port.transcript('agent', 's1', 'claude', '{"type":"user","message":{"content":"not ours"},"timestamp":"2026-10-06T00:00:00Z"}')
    // An agent it never sent anything to: done with it at once, as of the one prompt the core told of.
    port.input({ agentId: 'other', deliveryId: 'unknown-delivery', content: 'hi', when: 'composer', phase: 'dispatching' })
    expect(core.wifi.transcripts).toHaveBeenCalledWith('other', 1)
    port.transcript('other', 's2', 'claude', '{}')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('other', 1)
    port.agentGone('agent')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('agent', 1)
    port.agentGone('never-told')
    expect(core.wifi.transcripts).toHaveBeenLastCalledWith('never-told', 0)
  })

  it('tells the core which agents a device subscribed to before the subscription\'s answer leaves', async () => {
    const { core, hello, ask } = started()
    await hello()
    vi.mocked(core.wifi.streams).mockClear()
    const order: string[] = []
    vi.mocked(core.wifi.streams).mockImplementation((ids) => { order.push(`streams ${ids.join(',')}`) })
    vi.mocked(core.wifi.send).mockImplementation((_c, _i, _t, payload) => { order.push(String(payload.type)) })
    await ask({ type: 'agent.subscribe', machineId: 'machine-1', agentId: 'agent' }).catch(() => {})
    expect(order.slice(0, 2)).toEqual(['streams agent', 'agent.subscribe_result'])
    // Told once: the next answer finds the same subscriptions.
    await ask({ type: 'focus.get' })
    expect(core.wifi.streams).toHaveBeenCalledTimes(1)
  })

  it('reads the turn\'s whole answer off a summary card, and passes the agents\' turns and live events on', async () => {
    const { core, port, hello } = started()
    await hello()
    vi.mocked(core.wifi.send).mockClear()
    port.card({ type: 'commander_event', agentId: 'agent', payload: { kind: 'summary', text: 'short' } }, 'the whole answer')
    expect(sent(core).at(-1)).toMatchObject({ frame: 'autonomous_device_event', kind: 'turn.summary', payload: { text: 'short', fullText: 'the whole answer' } })
    port.card({ type: 'commander_event', agentId: 'agent', payload: { kind: 'tool', text: 'Read' } })
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.tool' })
    port.events('agent', [{ type: 'turn_started', payload: { userMessage: 'hello' } }])
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.started' })
    port.turnEnded('agent', true)
    expect(sent(core).at(-1)).toMatchObject({ kind: 'turn.error' })
    port.stream('agent', [{ type: 'turn_started', payload: {} } as unknown as LiveEvent])
    port.delivery({ deliveryId: 'nobody', sessionId: 'agent', state: 'delivered' })
    port.input({ deliveryId: 'nobody', agentId: 'agent', when: 'composer', phase: 'waiting_for_turn' })
    port.revealed('op', 'agent')
  })

  it('moves the window\'s focus in order, against the agents as they are, and tells the core the revision before anything carries it', async () => {
    const { core, port } = started()
    const order: string[] = []
    vi.mocked(core.wifi.focus).mockImplementation((revision) => { order.push(`focus ${revision}`) })
    await port.appFocus('machine-1', 'agent', 'w1')
    expect(core.wifi.view).toHaveBeenCalled()
    expect(order).toEqual([expect.stringMatching(/^focus .+:1$/)])
    await port.appFocus('machine-1', null, 'w1')
    expect(order.at(-1)).toMatch(/:2$/)
  })

  it('lets a focus move that fails cost that move alone, and the next one is applied', async () => {
    const { core, port } = started()
    vi.mocked(core.wifi.focus).mockImplementationOnce(() => { throw new Error('the core went away') })
    await expect(port.appFocus('machine-1', 'agent', 'w1')).rejects.toThrow('the core went away')
    await port.appFocus('machine-1', null, 'w1')
    expect(core.wifi.focus).toHaveBeenLastCalledWith(expect.stringMatching(/:2$/))
    // A move the core held for a restarted service fails the same way, and the service resumes.
    vi.mocked(core.wifi.focus).mockImplementation((revision) => { if (revision.endsWith(':3')) throw new Error('not now') })
    await port.resume({ sessions: [], helloed: [], focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w2' } })
    expect(core.wifi.ready).toHaveBeenCalled()
  })

  it('says a device\'s request that fails, and answers the next', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { core, port, hello } = started()
    port.session('c1', client)
    vi.mocked(core.wifi.send).mockImplementationOnce(() => { throw new Error('sealing failed') })
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c1', frame, opened)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[wifi] a device\'s request failed · sealing failed'))
    vi.mocked(core.wifi.send).mockImplementationOnce(() => { throw 'no session' })
    const [again, openedAgain] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c1', again, openedAgain)
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[wifi] a device\'s request failed · no session'))
    expect(await hello()).toMatchObject({ type: 'hello_result' })
    warn.mockRestore()
  })

  it('serves the sessions a previous run served, told to resync, and lets go of those the core no longer holds', async () => {
    const { core, port, hello } = started()
    await hello('stale')
    vi.mocked(core.wifi.send).mockClear()
    vi.mocked(core.wifi.hello).mockClear()
    await port.resume({ sessions: [{ connId: 'c9', client }], helloed: [{ connId: 'c9', identity: 'device-1' }], focus: { machineId: 'machine-1', agentId: 'agent', connId: 'w' } })
    // The stale session is let go of; the one the core holds is served on, and told to resync.
    expect(core.wifi.hello).toHaveBeenCalledWith('stale', null)
    expect(core.wifi.hello).toHaveBeenCalledWith('c9', 'device-1')
    expect(sent(core)).toContainEqual(expect.objectContaining({ connId: 'c9', frame: 'autonomous_device_event', type: 'resync', reason: 'instance_changed' }))
    expect(core.wifi.joined).toHaveBeenCalled()
    expect(core.wifi.ready).toHaveBeenCalled()
    expect(core.wifi.watching).toHaveBeenCalledWith([])
    expect(core.wifi.streams).toHaveBeenCalledWith([])
    expect(core.wifi.focus).toHaveBeenCalled()
    // A session this run already serves is served on as it is: not dropped, not told to resync again.
    vi.mocked(core.wifi.send).mockClear()
    vi.mocked(core.wifi.hello).mockClear()
    await port.resume({ sessions: [{ connId: 'c9', client }], helloed: [{ connId: 'c9', identity: 'device-1' }], focus: null })
    expect(core.wifi.hello).not.toHaveBeenCalled()
    expect(sent(core).filter((m) => m.type === 'resync')).toEqual([])
    // Nothing held, nothing restored, nobody to join.
    vi.mocked(core.wifi.joined).mockClear()
    await port.resume({ sessions: [], helloed: [], focus: null })
    expect(core.wifi.joined).not.toHaveBeenCalled()
  })

  it('carries device add-ons end to end: what the device publishes, an agent\'s proposal sealed to it, and its decision', async () => {
    const { core, port, hello, ask, http } = started()
    expect(await http('POST', '/api/autonomous-device/addon/propose', { addon: 'glow', idempotencyKey: 'k', act: 'light', holdsMs: 5000 }))
      .toEqual({ status: 409, body: { error: { code: 'MISSING_TARGET', message: 'No connected device offers add-ons' } } })
    await hello()
    expect(await ask({ type: 'addon.publish', values: [{ topic: 'room/presence', value: { someone: true } }] })).toMatchObject({ type: 'addon.publish_result', topics: 1 })
    expect(await http('GET', '/api/autonomous-device/addon/state'))
      .toMatchObject({ status: 200, body: { devices: [{ deviceId: 'device-1', online: true, topics: { 'room/presence': { value: { someone: true } } } }] } })
    vi.mocked(core.wifi.send).mockClear()
    const proposed = await http('POST', '/api/autonomous-device/addon/propose', { addon: 'glow', idempotencyKey: 'k', act: 'light', holdsMs: 5000, params: { colour: 'warm' } })
    const proposalId = proposed.body.proposal.proposalId as string
    expect(sent(core)).toEqual([expect.objectContaining({ connId: 'c1', identity: 'device-1', frame: 'autonomous_device_event', kind: 'addon.proposal',
      payload: expect.objectContaining({ proposalId, addon: 'glow', act: 'light', params: { colour: 'warm' } }) })])
    expect(await ask({ type: 'addon.decision', proposalId, decision: 'dropped', reason: 'someone is talking' })).toMatchObject({ state: 'dropped' })
    expect(await http('GET', `/api/autonomous-device/addon/proposal?proposalId=${proposalId}`))
      .toMatchObject({ status: 200, body: { proposal: { proposalId, state: 'dropped', reason: 'someone is talking' } } })
    port.revoked('device-1')
    expect(await http('GET', '/api/autonomous-device/addon/state')).toEqual({ status: 200, body: { devices: [] } })
    // Not its routes: the pairings are the gateway's.
    expect((await http('GET', '/api/autonomous-device/list')).status).toBe(404)
    await port.stop()
  })

  it('forgets a closed connection and an unpaired device, and answers a receipt', async () => {
    const { core, port, hello, ask, http } = started()
    port.session('c1', { ...client, identity: KEY })
    await ask({ type: 'hello', proto: 1 })
    await ask({ type: 'turn.send', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 'k2', text: 'hi' })
    const receipt = (key: string) => http('GET', `/api/autonomous-device/receipt?deviceId=${encodeURIComponent(KEY)}&idempotencyKey=${key}`)
    expect(await receipt('k2')).toMatchObject({ status: 200, body: { receipt: { idempotencyKey: 'k2', state: 'queued' } } })
    expect(await receipt('nope')).toEqual({ status: 200, body: { receipt: null } })
    port.revoked(KEY)
    expect(core.turns.cancelDelivery).toHaveBeenCalled()
    expect(await receipt('k2')).toEqual({ status: 200, body: { receipt: null } })
    await hello('c2')
    port.dropped('c2')
    expect(core.wifi.hello).toHaveBeenLastCalledWith('c2', null)
    // A session the gateway no longer holds is sent nothing.
    port.session('c3', client)
    port.session('c3', null)
    vi.mocked(core.wifi.send).mockClear()
    const [frame, opened] = sealed({ type: 'hello', proto: 1, requestId: randomUUID() })
    await port.request('c3', frame, opened)
    expect(core.wifi.send).not.toHaveBeenCalled()
    await port.stop()
  })

  it('answers a request with the agents it last had when the core cannot be asked', async () => {
    const view = vi.fn(async () => ({ agents: [agent], store: [], hasWindow: true }))
    const { hello, ask } = started({ wifi: { view } })
    await hello()
    view.mockRejectedValueOnce(new Error('the core went away'))
    expect((await ask({ type: 'agents.list' })).agents).toEqual([{ ...agent, machineId: 'machine-1' }])
  })

  it('reaches the core for a stop, an answer, a step along the desk, a stroke and the window\'s focus', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'turn.stop', machineId: 'machine-1', agentId: 'agent', idempotencyKey: 's1' })).toMatchObject({ receipt: { state: 'completed' } })
    expect(core.wifi.stop).toHaveBeenCalledWith('agent')
    // No window took the ask: said at once.
    vi.mocked(core.wifi.focusApp).mockReturnValueOnce(false)
    expect(await ask({ type: 'focus.ensure' })).toMatchObject({ error: { code: 'FOCUS_UNAVAILABLE' } })
    expect(core.wifi.focusApp).toHaveBeenCalledWith('agent', expect.any(Number), expect.any(String))
    expect(await ask({ type: 'scroll', phase: 'down', dy: 1, velocity: 2 })).not.toHaveProperty('error')
    expect(core.wifi.scroll).toHaveBeenCalledWith('down', 1, 2)
    const focus = (await ask({ type: 'focus.get' })).focusRevision
    expect(await ask({ type: 'focus.step', direction: 'next', idempotencyKey: 'f1', focusRevision: focus })).toMatchObject({ error: { code: 'NO_AGENTS' } })
    expect(core.wifi.stepFocus).toHaveBeenCalledWith('next', undefined)
  })

  it('gives the Store the agents the core listed, and makes and shows its agents through the core', async () => {
    const core = fakeCore({ dataDir, wifi: { view: vi.fn(async () => ({ agents: [], store: [{ agentId: 'a' } as never], hasWindow: true })) } })
    let given: Parameters<typeof createDeviceStore>[0] | undefined
    const ports = emptyPorts()
    startWifi(core, ports, { store: (options) => { given = options; return createDeviceStore(options) } })
    expect(given!.agents()).toEqual([])
    await ports.wifi!.appFocus('machine-1', null, 'w')
    expect(given!.agents()).toEqual([{ agentId: 'a' }])
    await given!.create('autonomous/robot', 'claude', '/w')
    expect(core.wifi.create).toHaveBeenCalledWith('autonomous/robot', 'claude', '/w')
    given!.reveal!('op', 'a')
    expect(core.wifi.reveal).toHaveBeenCalledWith('op', 'a')
  })

  it('hands question answers to the core and keeps transcript receipt evidence in the component', async () => {
    const core = fakeCore({ dataDir })
    let given: ConstructorParameters<typeof AutonomousDeviceService>[0] | undefined
    startWifi(core, emptyPorts(), { service: (options) => { given = options; return new AutonomousDeviceService(options) } })
    expect(given!.inputConsumed).toBeUndefined()
    expect(await given!.answer('agent', 'r', { q: 'yes' })).toBe(true)
    expect(core.wifi.answer).toHaveBeenCalledWith('agent', 'r', { q: 'yes' })
  })

  it('gives up a pairing the device asked to give up, over its own session', async () => {
    const { core, hello, ask } = started()
    await hello()
    expect(await ask({ type: 'pair.revoke' })).toMatchObject({ revoked: true })
    expect(core.wifi.unpaired).toHaveBeenCalledWith('device-1')
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
      service: () => ({ addons: { state: () => { throw new Error('broken') } } }) as unknown as AutonomousDeviceService,
    })
    await expect(requests.wifi_http!({ method: 'GET', target: '/api/autonomous-device/addon/state' }, { local: true, owner: true })).rejects.toThrow('broken')
  })

  it('says a focus change that carries no revision to nobody', () => {
    const emits: Array<(frame: Record<string, unknown>) => void> = []
    const core = fakeCore({ dataDir })
    const ports = emptyPorts()
    startWifi(core, ports, {
      service: (options) => {
        emits.push((frame) => options.emit?.(frame as never))
        return { focusSnapshot: () => ({ focus: null, focusRevision: 'x:0' }) } as unknown as AutonomousDeviceService
      },
    })
    emits[0]({ type: 'event', kind: 'focus.changed', payload: {} })
    emits[0]({ type: 'event', kind: 'focus.changed' })
    expect(core.wifi.focus).not.toHaveBeenCalled()
  })
})
