/** Caller proofs for replacing the ordered core feed with component-owned evidence and app events. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type AgentView, type WifiPort } from '../core/api.js'
import { AutonomousDeviceService, type AutonomousDeviceFrame } from '../lib/autonomous-device/service.js'
import { GatewayDeviceFixture } from '../testing/devicePeer.js'
import { snapshotFixture, snapshotRow } from '../testing/sessionSnapshot.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWifi, type WifiDeps } from './wifi.js'
import type { DeviceSessionFeedOptions } from '../lib/autonomous-device/sessionFeed.js'
import { observeDeviceSessions } from '../lib/autonomous-device/sessionFeed.js'
import { EventEmitter } from 'node:events'
import type { ClientSocket } from '../agentClient/daemon.js'
import { BackendSocket } from '../backendSocket.js'
import { dispatchDown } from '../testing/relaySocket.js'
import { funnelFor } from '../core/turns/funnel.js'

const peers: GatewayDeviceFixture[] = []

vi.mock('../agentClient/questions.js', () => ({ observeQuestions: vi.fn(() => ({ ready: Promise.resolve(), answer: vi.fn(async () => false), close: vi.fn() })) }))
vi.mock('../lib/autonomous-device/peerConnection.js', () => ({ devicePeerConnection: vi.fn(options => {
  const peer = new GatewayDeviceFixture(options); peers.push(peer); return peer
}) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

interface EvidenceSink {
  pool: unknown
  observe(agentId: string, sessionId: string, engine: string, line: string): void
  gap(agentId: string, code: string): void
}

const running: WifiPort[] = [], homes: string[] = []
afterEach(async () => {
  for (const port of running.splice(0)) await port.stop()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.useRealTimers(); vi.restoreAllMocks()
})

async function fixture(over: { unbound?: boolean; actualFile?: boolean; arm?: Promise<void>; drain?: Promise<void>; engine?: string; actualFeed?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wifi-feed-')); homes.push(dataDir)
  const agent = { agentId: 'agent', sessionId: over.unbound ? '' : 's1', engine: over.engine ?? 'claude', active: true,
    transcriptPath: over.unbound ? null : join(dataDir, 's1.jsonl'), boundAt: over.unbound ? null : 500,
    processIdentity: { pid: 42, startMarker: '1970-01-01T00:00:00.100Z' }, evidenceRevision: 1 } as AgentView
  const core = fakeCore({ dataDir,
    conversations: { resolve: vi.fn(async () => structuredClone(agent)) },
    agents: { snapshot: vi.fn(async () => snapshotFixture({ registered: [snapshotRow('agent', { session: { ...snapshotRow().session, engine: agent.engine } })], hasWindow: false })) },
  })
  let sink: EvidenceSink | undefined, service!: AutonomousDeviceService, feedOptions: DeviceSessionFeedOptions | undefined
  const events: AutonomousDeviceFrame[] = []
  let serviceOptions!: ConstructorParameters<typeof AutonomousDeviceService>[0]
  let feed = { ready: Promise.resolve(), close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async (_agentId: string) => {}) }
  let nextReady = Promise.resolve()
  const observations: Array<{ options: DeviceSessionFeedOptions; feed: typeof feed }> = []
  const backend = new BackendSocket('machine-1')
  backend.agentRecentProvider = async () => ({ turns: [] })
  const reader = {
    arm: vi.fn(async (_agent: AgentView, _deliveryId: string) => { await over.arm }),
    input: vi.fn(),
    flush: vi.fn(async (_agentId: string) => { await over.drain }),
    changed: vi.fn(), forget: vi.fn(), stop: vi.fn(async () => {}),
    settled: vi.fn(), disconnected: vi.fn(), connected: vi.fn(),
  }
  const ports = emptyPorts()
  // This is the proposed production dependency seam, like the existing service/store factories.
  // Until the caller uses it, the behavioral assertions expose the missing pre-input/drain boundary.
  startWifi(core, ports, {
    service: options => { serviceOptions = options; return service = new AutonomousDeviceService({ ...options, now: () => 1_000,
      emit: (frame, deviceId) => { events.push(frame); options.emit?.(frame, deviceId) },
    }) },
    ...(over.actualFile ? {} : { evidence: (given: EvidenceSink) => { sink = given; return reader } }),
    observeSessions: (given: DeviceSessionFeedOptions) => {
      feedOptions = given
      if (!over.actualFeed) {
        feed = { ready: nextReady, close: vi.fn(), stop: vi.fn(async () => {}), barrier: vi.fn(async (_agentId: string) => {}) }
        observations.push({ options: given, feed })
        return feed
      }
      const socket = new EventEmitter() as EventEmitter & ClientSocket
      const message = (frame: unknown) => socket.emit('message', Buffer.from(JSON.stringify(frame)), false)
      socket.close = () => { void backend.unregisterLocalClient('local:observer'); socket.emit('close', 1000) }
      socket.send = wire => {
        const frame = JSON.parse(wire)
        if (frame.type === 'machine_select') {
          backend.registerLocalClient('local:observer', { sendFrame: frame => { message(frame); return true }, sendBinary: () => true, close: () => socket.close() },
            { tool: true, eventsProtocol: 1 })
          message({ type: 'connected', payload: { eventsProtocol: 1 } })
        } else void dispatchDown(backend, frame, 'local:observer')
      }
      const own = observeDeviceSessions({ port: 1, dataDir, machineId: 'machine-1' }, given, () => socket)
      feed = { ready: own.ready, close: vi.fn(own.close), stop: vi.fn(own.stop), barrier: vi.fn(own.barrier) }
      queueMicrotask(() => socket.emit('open'))
      return feed
    },
  } as WifiDeps)
  const port = ports.wifi!; running.push(port)
  await port.resume({ focus: null })
  const send = (key = 'input-A') => service.request('device', { type: 'turn.send', requestId: randomUUID(), machineId: 'machine-1',
    agentId: 'agent', idempotencyKey: key, text: 'hello' })
  const dispatched = (revision?: number, key = 'input-A'): void => {
    const receipt = service.receipt('device', key)!
    port.input!({ agentId: 'agent', deliveryId: receipt.deliveryId, when: 'composer', phase: 'dispatching',
      sessionId: agent.sessionId, content: 'hello', ...(revision === undefined ? {} : { activity: { epoch: 'boot', revision } }) })
    service.delivery({ sessionId: 'agent', deliveryId: receipt.deliveryId, state: 'started' })
  }
  const prove = (): void => {
    const captured = sink!
    captured.observe('agent', 's1', 'claude', JSON.stringify({ type: 'user', uuid: 'input', timestamp: '1970-01-01T00:00:01.001Z', message: { content: 'hello' } }))
    captured.observe('agent', 's1', 'claude', JSON.stringify({ type: 'assistant', uuid: 'result', parentUuid: 'input',
      message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'finished' }] } }))
  }
  return { core, port, agent, reader, service, serviceOptions, events, send, dispatched, prove, sink: () => sink, feed, feedOptions: () => feedOptions, observations,
    readyNext: (ready: Promise<void>) => { nextReady = ready }, backend, peer: peers.at(-1)! }
}

describe('component evidence and normalized-feed ordering', () => {
  it('bounds observer retries, ignores old-generation failures, and cancels a pending retry on stop', async () => {
    const t = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    const old = t.observations[0]
    for (let attempt = 0; attempt < 6; attempt++) {
      const own = t.observations.at(-1)!
      own.options.unavailable('SESSION_EVENTS_GAP')
      expect(own.feed.close).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(t.observations).toHaveLength(Math.min(attempt + 2, 6))
    }
    expect(warn).toHaveBeenCalledTimes(6)
    old.options.unavailable('SESSION_EVENTS_GAP')
    await old.options.receive('agent', [{ type: 'agent_deleted', payload: {} }], () => true)
    expect(warn).toHaveBeenCalledTimes(6)
    await t.port.resume({ focus: null })
    const fresh = t.observations.at(-1)!
    fresh.options.unavailable('SESSION_EVENTS_GAP')
    await t.port.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.observations).toHaveLength(7)
    vi.useRealTimers()
  })

  it('handles an observation retry whose handshake rejects without an unhandled promise', async () => {
    const t = await fixture(), failed = deferred<void>()
    const ready = failed.promise.then(() => { throw new Error('SESSION_EVENTS_PROTOCOL') })
    t.readyNext(ready)
    vi.useFakeTimers()
    t.feedOptions()!.unavailable('SESSION_EVENTS_GAP')
    await vi.advanceTimersByTimeAsync(1_000)
    failed.resolve()
    await expect(t.observations.at(-1)!.feed.ready).rejects.toThrow('SESSION_EVENTS_PROTOCOL')
    await vi.advanceTimersByTimeAsync(0)
    await t.port.stop(); vi.useRealTimers()
  })

  it('rejects admitted input when observation readiness completes after the core connection ends', async () => {
    const t = await fixture(), held = deferred<void>()
    t.feed.ready = held.promise
    const sending = t.send()
    expect(t.service.receipt('device', 'input-A')?.state).toBe('queued')
    t.port.disconnected(); held.resolve(); await sending
    expect(t.reader.arm).not.toHaveBeenCalled()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('revokes an original component submit callback after stop', async () => {
    const t = await fixture(), submit = t.serviceOptions.submit
    await t.port.stop()
    await submit('agent', 'late', 'delivery')
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    expect(t.reader.arm).not.toHaveBeenCalled()
  })

  it.each(['text_delta', 'turn_started', 'tool_start', 'tool_end'])('rejects invalid consumed %s fields before applying a batch', async type => {
    const t = await fixture(), stream = vi.spyOn(t.service, 'stream')
    await expect(t.feedOptions()!.receive('agent', [{ type, payload: {} }], () => true)).rejects.toThrow('SESSION_EVENTS_PROTOCOL')
    expect(stream).not.toHaveBeenCalled()
  })

  it.each(['disconnect', 'stop', 'replacement'] as const)('refuses a normalized end whose service-link barrier completes after %s', async kind => {
    const t = await fixture(), held = deferred<AgentView | null>(), entered = deferred<void>()
    await t.send(); t.dispatched(10)
    vi.mocked(t.core.conversations.resolve).mockImplementationOnce(() => { entered.resolve(); return held.promise })
    const ended = vi.spyOn(t.service, 'turnEnded')
    const applying = t.feedOptions()!.receive('agent', [{ type: 'turn_ended', payload: {} }], () => true)
    await entered.promise
    if (kind === 'stop') await t.port.stop()
    else { t.port.disconnected(); if (kind === 'replacement') await t.port.resume({ focus: null }) }
    held.resolve(t.agent); await applying
    expect(t.reader.flush).not.toHaveBeenCalled()
    expect(ended).not.toHaveBeenCalled()
  })

  it('refuses input before submission when the current observer readiness fails', async () => {
    const t = await fixture()
    const failed = Promise.reject(new Error('SESSION_EVENTS_PROTOCOL')); void failed.catch(() => {})
    t.feed.ready = failed
    await t.send()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    expect(t.service.receipt('device', 'input-A')?.state).toBe('rejected')
  })

  it('applies binding-change notices through the existing view refresh and exposes a failed refresh', async () => {
    const t = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(t.core.agents.snapshot).mockRejectedValueOnce(new Error('view failed'))
    await t.feedOptions()!.receive('agent', [{ type: 'agent_synced', payload: {} }], () => true)
    expect(t.reader.changed).toHaveBeenCalledExactlyOnceWith('agent')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith('[wifi] CORE_VIEW_UNAVAILABLE'))
    await t.feedOptions()!.receive('agent', [{ type: 'agent_synced', payload: {} }], () => true)
    await t.port.appFocus('machine-1', 'agent', 'window')
    expect(t.core.agents.snapshot).toHaveBeenCalledTimes(3)
  })

  it('shares one failed changed-view read and rejects focus waiting on that same core revision', async () => {
    const t = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let reject!: (error: Error) => void
    vi.mocked(t.core.agents.snapshot).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail }))
    const synced = () => t.feedOptions()!.receive('agent', [{ type: 'agent_synced', payload: {} }], () => true)
    await synced(); await synced()
    const moving = t.port.appFocus('machine-1', 'agent', 'window')
    const failed = expect(moving).rejects.toThrow('changed view failed')
    await Promise.resolve()
    reject(new Error('changed view failed')); await failed
    expect(t.core.agents.snapshot).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith('[wifi] CORE_VIEW_UNAVAILABLE')
  })

  it('ignores ordinary activity and validates all fields of a consumed tool end', async () => {
    const t = await fixture(), stream = vi.spyOn(t.service, 'stream')
    await t.feedOptions()!.receive('agent', [{ type: 'agent_activity', payload: {} }], () => true)
    expect(stream).not.toHaveBeenCalled()
    for (const payload of [{ id: 'tool' }, { id: 'tool', tool: 'Read' }]) {
      await expect(t.feedOptions()!.receive('agent', [{ type: 'tool_end', payload }], () => true)).rejects.toThrow('SESSION_EVENTS_PROTOCOL')
    }
  })

  it.each(['turn_ended', 'agent_activity'] as const)('revokes a %s after the raw boundary waits through core loss', async type => {
    const held = deferred<void>(), t = await fixture({ drain: held.promise })
    await t.send(); t.dispatched(10)
    const ended = vi.spyOn(t.service, 'turnEnded'), stream = vi.spyOn(t.service, 'stream')
    const applying = t.feedOptions()!.receive('agent', [{ type, payload: type === 'agent_activity' ? { cause: 'cancel' } : {} }], () => true)
    await vi.waitFor(() => expect(t.reader.flush).toHaveBeenCalledOnce())
    t.port.disconnected(); held.resolve(); await applying
    expect(ended).not.toHaveBeenCalled(); expect(stream).not.toHaveBeenCalled()
  })

  it('rejects a direct summary visibly when its observation barrier cannot drain', async () => {
    const t = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const commander = vi.spyOn(t.service, 'commander')
    t.feed.barrier.mockRejectedValueOnce(new Error('SESSION_EVENTS_GAP'))
    await t.peer.card({ type: 'commander_event', agentId: 'agent', dbSessionId: 's1', payload: { kind: 'summary', text: 'answer' } }, 'full')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[wifi] SESSION_SUMMARY_UNAVAILABLE'))
    expect(commander).not.toHaveBeenCalled()
  })

  it.each(['peer', 'feed', 'core'] as const)('refuses a direct summary whose %s is replaced during its observation barrier', async kind => {
    const t = await fixture(), held = deferred<void>(), commander = vi.spyOn(t.service, 'commander')
    const frame = { type: 'commander_event' as const, agentId: 'agent', dbSessionId: 's1', payload: { kind: 'summary', text: 'old' } }
    t.feed.barrier.mockImplementationOnce(() => held.promise)
    await t.peer.card(frame, 'old full')
    await vi.waitFor(() => expect(t.feed.barrier).toHaveBeenCalledOnce())
    if (kind === 'peer') { await t.peer.stop(); t.peer.start() }
    else if (kind === 'core') { t.port.disconnected(); await t.port.resume({ focus: null }) }
    else await t.port.resume({ focus: null })
    held.resolve()
    const fresh = { ...frame, payload: { kind: 'summary', text: 'fresh' } }
    await t.peer.card(fresh, 'fresh full')
    await vi.waitFor(() => expect(commander).toHaveBeenCalledExactlyOnceWith(fresh))
  })

  it('publishes an ordinary direct card without a summary barrier', async () => {
    const t = await fixture(), commander = vi.spyOn(t.service, 'commander')
    const frame = { type: 'commander_event' as const, agentId: 'agent', dbSessionId: 's1', payload: { kind: 'error', text: 'failed' } }
    await t.peer.card(frame, null)
    await vi.waitFor(() => expect(commander).toHaveBeenCalledExactlyOnceWith(frame))
    expect(t.feed.barrier).not.toHaveBeenCalled()
  })

  it('ignores direct cards while its observer is unavailable and resumes with fresh cards', async () => {
    const t = await fixture(), commander = vi.spyOn(t.service, 'commander')
    t.feedOptions()!.unavailable('SESSION_EVENTS_GAP')
    await t.peer.card({ type: 'commander_event', agentId: 'agent', dbSessionId: 's1', payload: { kind: 'error', text: 'old' } }, null)
    await t.port.resume({ focus: null })
    const fresh = { type: 'commander_event' as const, agentId: 'agent', dbSessionId: 's1', payload: { kind: 'error', text: 'fresh' } }
    await t.peer.card(fresh, null)
    await vi.waitFor(() => expect(commander).toHaveBeenCalledExactlyOnceWith(fresh))
  })

  it('settles evidence reservations on final delivery and refuses focus while disconnected', async () => {
    const t = await fixture()
    t.port.delivery({ sessionId: 'agent', deliveryId: 'done', state: 'completed' })
    t.port.delivery({ sessionId: 'agent', deliveryId: 'refused', state: 'rejected' })
    expect(t.reader.settled.mock.calls).toEqual([['agent', 'done'], ['agent', 'refused']])
    t.port.disconnected()
    await expect(t.port.appFocus('machine-1', 'agent', 'window')).rejects.toThrow('CORE_VIEW_UNAVAILABLE')
  })

  it('does not apply focus when draining the refreshed view synchronously revokes its connection', async () => {
    const t = await fixture(), held = deferred<Awaited<ReturnType<typeof t.core.agents.snapshot>>>()
    t.peer.session('conn', { role: 'device', identity: 'device', direct: true })
    await t.peer.request('conn', { type: 'hello', proto: 1, requestId: 'hello' })
    await vi.waitFor(() => expect(t.peer.replies().some(frame => frame.type === 'hello_result')).toBe(true))
    vi.mocked(t.core.agents.snapshot).mockReturnValueOnce(held.promise)
    const focus = vi.spyOn(t.service, 'appFocus'), moving = t.port.appFocus('machine-1', 'agent', 'window')
    await vi.waitFor(() => expect(t.core.agents.snapshot).toHaveBeenCalledTimes(2))
    await t.feedOptions()!.receive('agent', [{ type: 'agent_synced', payload: {} }], () => true)
    t.service.commander({ type: 'commander_event', agentId: 'agent', payload: { kind: 'error', text: 'queued' } })
    t.peer.changed.once('frame', () => t.port.disconnected())
    held.resolve(snapshotFixture({ registered: [snapshotRow()], hasWindow: false }))
    await moving
    expect(focus).not.toHaveBeenCalled()
  })
  it('keeps physical read and event accounting across inline component reconstruction', async () => {
    const old = await fixture()
    const reads = old.sink()!.pool, events = old.feedOptions()!.pool
    await old.port.stop()
    const fresh = await fixture()
    expect(fresh.sink()!.pool).toBe(reads)
    expect(fresh.feedOptions()!.pool).toBe(events)
  })
  it('keeps a peer summary after the preceding real funnel end while the actual observer drains slowly', async () => {
    const wait = deferred<void>(), t = await fixture({ engine: 'opencode', actualFeed: true, drain: wait.promise })
    await t.send(); t.dispatched(10)
    const card = { type: 'commander_event' as const, agentId: 'agent', dbSessionId: 's1', payload: { kind: 'summary', text: 'short' } }
    const commander = vi.spyOn(t.service, 'commander')
    const funnel = funnelFor({ bySession: () => ({ ...t.agent, engine: 'opencode' }) as never,
      tokenUsage: { changed: vi.fn() }, agentIdFor: () => 'agent', isSubagentSession: () => false,
      turnActivity: { observe: vi.fn(), snapshot: () => ({ epoch: 'boot', revision: 11, state: 'idle', validForMs: 0 }) },
      clients: t.backend, search: null, turnStartedAt: new Map(), input: { onTurnStarted: vi.fn(), onTurnEnded: vi.fn() },
      startHeartbeat: vi.fn(), questionWatcher: { start: vi.fn(), stop: vi.fn(), noteTurnStart: vi.fn() },
      mirror: { ingest: () => { void t.peer.card(card, 'captured full text') } },
    })
    funnel('s1', [{ type: 'turn_ended', payload: {} }])
    await vi.waitFor(() => expect(t.feed.barrier).toHaveBeenCalledExactlyOnceWith('agent'))
    expect(commander).not.toHaveBeenCalled()
    expect(t.service.receipt('device', 'input-A')?.state).toBe('started')
    wait.resolve()
    await vi.waitFor(() => expect(commander).toHaveBeenCalledExactlyOnceWith(card))
    expect(t.service.receipt('device', 'input-A')?.state).toBe('completed')
  })
  it('consumes core/cloud cards once and ignores the observed duplicate of direct recaps cards', async () => {
    const t = await fixture(), commander = vi.spyOn(t.service, 'commander')
    const frame = { type: 'commander_event', agentId: 'agent', dbSessionId: 'cloud-agent', payload: { kind: 'summary', text: 'cloud answer' } }
    const receive = t.feedOptions()!.receive as (...args: unknown[]) => Promise<void>
    await receive('agent', [frame], () => true, 'core')
    expect(commander).toHaveBeenCalledExactlyOnceWith(frame)
    await receive('agent', [frame], () => true, 'recaps')
    expect(commander).toHaveBeenCalledOnce()
    const error = { ...frame, payload: { kind: 'error', text: 'engine failed' } }
    await receive('agent', [error], () => true, 'core')
    expect(commander).toHaveBeenLastCalledWith(error)
    expect(commander).toHaveBeenCalledTimes(2)
    expect(t.feed.barrier).not.toHaveBeenCalled()
  })

  it('preserves the component card policy for local-only and cable-only content on shared app events', async () => {
    const t = await fixture(), commander = vi.spyOn(t.service, 'commander')
    const receive = t.feedOptions()!.receive
    for (const kind of ['tool_end', 'turn_started', 'reply_text']) await receive('agent', [
      { type: 'commander_event', agentId: 'agent', payload: { kind, text: 'local' } },
    ], () => true, 'core')
    const processing = { type: 'commander_event', agentId: 'agent', payload: { kind: 'processing', text: 'Working', update: 'cable only' } }
    await receive('agent', [processing], () => true, 'core')
    expect(commander).toHaveBeenCalledExactlyOnceWith({ ...processing, payload: { kind: 'processing', text: 'Working' } })
  })
  it('applies an earlier non-native dispatch notice before an end that arrives on the faster app socket', async () => {
    const t = await fixture({ engine: 'opencode' })
    await t.send()
    const barrier = deferred<AgentView | null>()
    const admitted = deferred<void>()
    vi.mocked(t.core.conversations.resolve).mockImplementationOnce(() => { admitted.resolve(); return barrier.promise })
    const end = t.feedOptions()!.receive('agent', [{ type: 'turn_ended', dbSessionId: 's1',
      payload: { activity: { epoch: 'boot', revision: 11, state: 'idle', validForMs: 0 } } }], () => true)
    void Promise.resolve(end).then(() => admitted.resolve())
    await admitted.promise
    t.dispatched(10)
    barrier.resolve(t.agent)
    await end
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
    expect(t.core.conversations.resolve).toHaveBeenCalledTimes(2)
  })

  it.each(['session', 'epoch', 'absent'] as const)('does not complete a non-native input from an end with %s proof', async different => {
    const t = await fixture({ engine: 'opencode' })
    await t.send(); t.dispatched(different === 'absent' ? undefined : 10)
    await t.feedOptions()!.receive('agent', [{ type: 'turn_ended', dbSessionId: different === 'session' ? 'old' : 's1',
      payload: { activity: { epoch: different === 'epoch' ? 'old' : 'boot', revision: 11, state: 'idle', validForMs: 0 } } }], () => true)
    expect(t.service.receipt('device', 'input-A')?.state).not.toBe('completed')
    if (different === 'absent') expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: 'RESULT_EVIDENCE_MISSING' } })
  })

  it.each(['claude', 'opencode'])('refuses an old cancel after a newer %s dispatch, and applies the current cancel', async engine => {
    const t = await fixture({ engine })
    await t.send(); t.dispatched(10)
    const cancel = (revision: number) => t.feedOptions()!.receive('agent', [{ type: 'agent_activity', dbSessionId: 's1',
      payload: { cause: 'cancel', activity: { epoch: 'boot', revision, state: 'idle', validForMs: 0 } } }], () => true)
    await cancel(9)
    expect(t.service.receipt('device', 'input-A')?.state).toBe('started')
    expect(t.events.filter(event => event.kind === 'turn.error')).toEqual([])
    await cancel(11)
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: 'TURN_INTERRUPTED' } })
    expect(t.events.filter(event => event.kind === 'turn.error')).toHaveLength(1)
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
  })

  it.each(['cancel', 'end'] as const)('updates an older native receipt without broadcasting its %s as the newer input\'s end', async kind => {
    const t = await fixture()
    await t.send(); t.dispatched(10)
    await t.send('input-B'); t.dispatched(20, 'input-B')
    await t.feedOptions()!.receive('agent', [{ type: kind === 'cancel' ? 'agent_activity' : 'turn_ended', dbSessionId: 's1', payload: {
      ...(kind === 'cancel' ? { cause: 'cancel' } : {}), activity: { epoch: 'boot', revision: 15, state: 'idle', validForMs: 0 },
    } }], () => true)
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: kind === 'cancel' ? 'TURN_INTERRUPTED' : 'RESULT_EVIDENCE_MISSING' } })
    expect(t.service.receipt('device', 'input-B')?.state).toBe('started')
    expect(t.events.filter(event => event.kind === 'turn.error' || event.kind === 'turn.done')).toEqual([])
    expect(t.core.turns.deliver).toHaveBeenCalledTimes(2)
  })

  it('does not consume a newer input start from a delayed older normalized start', async () => {
    const t = await fixture({ engine: 'opencode' })
    await t.send(); t.dispatched(10)
    const start = (revision: number) => t.feedOptions()!.receive('agent', [{ type: 'turn_started', dbSessionId: 's1',
      payload: { userMessage: 'hello', activity: { epoch: 'boot', revision } } }], () => true)
    await start(9)
    await start(11)
    await t.feedOptions()!.receive('agent', [{ type: 'turn_ended', dbSessionId: 's1',
      payload: { activity: { epoch: 'boot', revision: 12 } } }], () => true)
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
  })

  it('owns the normalized observer while enabled without a device hello and releases it on core loss', async () => {
    const t = await fixture()
    expect(t.feedOptions()).toBeDefined()
    expect(t.feed.close).not.toHaveBeenCalled()
    t.port.disconnected()
    expect(t.feed.close).toHaveBeenCalledOnce()
  })

  it('drains the captured file at the actual negotiated event caller before applying its end', async () => {
    const t = await fixture({ actualFile: true })
    writeFileSync(t.agent.transcriptPath!, '')
    vi.mocked(t.core.turns.deliver).mockImplementation(() => t.dispatched())
    await t.send()
    appendFileSync(t.agent.transcriptPath!, [
      { type: 'user', uuid: 'input', timestamp: '1970-01-01T00:00:01.001Z', message: { content: 'hello' } },
      { type: 'assistant', uuid: 'result', parentUuid: 'input', message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'read before the app end' }] } },
    ].map(row => JSON.stringify(row) + '\n').join(''))
    expect(t.feedOptions()).toBeDefined()
    await t.feedOptions()!.receive('agent', [{ type: 'turn_ended', payload: {} }], () => true)
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
  })

  it('does not force a file drain or core read for token and tool-only batches', async () => {
    const t = await fixture()
    await t.send(); t.dispatched(10)
    const reads = vi.mocked(t.core.conversations.resolve).mock.calls.length
    for (let n = 0; n < 10; n++) await t.feedOptions()!.receive('agent', [
      { type: 'text_delta', payload: { content: 'a token' } },
      { type: 'tool_start', payload: { id: 'tool', tool: 'Read' } },
    ], () => true)
    expect(t.reader.flush).not.toHaveBeenCalled()
    expect(t.core.conversations.resolve).toHaveBeenCalledTimes(reads)
  })

  it('marks a lost normalized generation visibly unknown without discarding independent native proof or retrying input', async () => {
    const t = await fixture()
    await t.send(); t.dispatched()
    expect(t.feedOptions()).toBeDefined()
    t.feedOptions()!.unavailable('SESSION_EVENTS_GAP')
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: 'SESSION_EVENTS_UNAVAILABLE' } })
    t.prove()
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
  })
  it.each(['bound', 'partial', 'first-binding'] as const)('proves a complete %s turn from the actual file before a faster app end', async kind => {
    const t = await fixture({ actualFile: true, unbound: kind === 'first-binding' })
    const file = join(t.core.dataDir, 's1.jsonl')
    if (kind !== 'first-binding') writeFileSync(file, kind === 'partial' ? '{"type":"system","message":"old' : '')
    let applying: void | Promise<void>
    vi.mocked(t.core.turns.deliver).mockImplementation(() => {
      t.dispatched()
      if (kind === 'first-binding') {
        t.agent.sessionId = 's1'; t.agent.transcriptPath = file; t.agent.boundAt = 1_001; t.agent.evidenceRevision = 2
      }
      const rows = [
        { type: 'user', uuid: 'input', timestamp: '1970-01-01T00:00:01.001Z', message: { content: 'hello' } },
        { type: 'assistant', uuid: 'result', parentUuid: 'input',
          message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'finished from the file' }] } },
      ]
      appendFileSync(file, (kind === 'partial' ? ' context"}\n' : '') + rows.map(row => JSON.stringify(row) + '\n').join(''))
      // The app can finish before fs.watch notifies. The component's app-end drain must read the
      // already-written file, including a first complete turn before any binding announcement.
      applying = t.feedOptions()!.receive('agent', [{ type: 'turn_ended', payload: {} }], () => true)
    })
    await t.send(); await applying!
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
  })

  it('refuses a symlink capture before any input is written', async () => {
    const t = await fixture({ actualFile: true })
    const target = join(t.core.dataDir, 'other.jsonl')
    writeFileSync(target, '')
    symlinkSync(target, t.agent.transcriptPath!)
    await t.send()
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'rejected' })
  })

  it.each(['current', 'process', 'path', 'session', 'boundary'] as const)(
    'reauthorizes a %s capture after core replacement without repeating input', async kind => {
      const t = await fixture({ actualFile: true })
      const original = t.agent.transcriptPath!
      writeFileSync(original, '{"type":"system","value":"before"}\n')
      vi.mocked(t.core.turns.deliver).mockImplementation(() => t.dispatched())
      await t.send()
      await t.feedOptions()!.receive('agent', [], () => true)
      t.port.disconnected()
      expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: 'CORE_DISCONNECTED' } })
      t.agent.evidenceRevision = 0 // Registry revisions belong to one core boot.
      if (kind === 'process') t.agent.processIdentity = { ...t.agent.processIdentity!, startMarker: 'new-process' }
      if (kind === 'path') t.agent.transcriptPath = join(t.core.dataDir, 'other.jsonl')
      if (kind === 'session') t.agent.sessionId = 'replacement'
      if (kind === 'boundary') writeFileSync(original, '{"type":"system","value":"edited"}\n')
      const rows = [
        { type: 'user', uuid: 'input', timestamp: '1970-01-01T00:00:01.001Z', message: { content: 'hello' } },
        { type: 'assistant', uuid: 'result', parentUuid: 'input',
          message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'finished after restart' }] } },
      ].map(row => JSON.stringify(row) + '\n').join('')
      appendFileSync(t.agent.transcriptPath!, rows)
      const resolving = vi.mocked(t.core.conversations.resolve)
      resolving.mockClear()
      await t.port.resume({ focus: null })
      await t.feedOptions()!.receive('agent', [{ type: 'turn_ended', payload: {} }], () => true)
      expect(resolving).toHaveBeenCalledWith('agent')
      expect(t.service.receipt('device', 'input-A')).toMatchObject(kind === 'current'
        ? { state: 'completed', error: null }
        : { state: 'unknown', error: { code: 'RESULT_EVIDENCE_MISSING' } })
      expect(t.core.turns.deliver).toHaveBeenCalledOnce()
    },
  )

  it('arms the captured authoritative file before the actual shared input invocation', async () => {
    const armed = deferred<void>(), t = await fixture({ arm: armed.promise })
    const sending = t.send()
    try {
      await vi.waitFor(() => expect(t.core.conversations.resolve).toHaveBeenCalledWith('agent'))
      expect(t.core.turns.deliver).not.toHaveBeenCalled()
      expect(t.reader.arm).toHaveBeenCalledWith(t.agent, expect.any(String))
    } finally { armed.resolve(); await sending }
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
  })

  it.each(['disabled', 'replacement'] as const)('refuses an inline input whose evidence capture finishes after the component is %s', async kind => {
    const armed = deferred<void>(), t = await fixture({ arm: armed.promise })
    const sending = t.send()
    await vi.waitFor(() => expect(t.reader.arm).toHaveBeenCalledOnce())
    if (kind === 'disabled') await t.port.stop()
    else { t.port.disconnected(); await t.port.resume({ focus: null }) }
    armed.resolve(); await sending
    expect(t.core.turns.deliver).not.toHaveBeenCalled()
  })

  it('drains raw evidence before applying an app turn end that arrived first', async () => {
    const drained = deferred<void>(), t = await fixture({ drain: drained.promise })
    await t.send(); t.dispatched()
    const ended = vi.spyOn(t.service, 'turnEnded')
    const applying = t.feedOptions()!.receive('agent', [{ type: 'turn_ended', payload: {} }], () => true)
    try {
      expect(ended).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(t.reader.flush).toHaveBeenCalledWith('agent'))
      t.prove()
      expect(t.service.receipt('device', 'input-A')?.state).toBe('completed')
    } finally { drained.resolve(); await applying }
    expect(ended).toHaveBeenCalledOnce()
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'completed', error: null })
  })

  it('arms an unbound original process before its first input without guessing a transcript path', async () => {
    const t = await fixture({ unbound: true })
    let captures: Array<[AgentView, string]> = []
    const atInput = vi.fn(() => { captures = [...t.reader.arm.mock.calls] })
    vi.mocked(t.core.turns.deliver).mockImplementation(atInput)
    await t.send()
    expect(atInput).toHaveBeenCalledOnce()
    expect(captures).toEqual([[expect.objectContaining({
      agentId: 'agent', sessionId: '', transcriptPath: null, processIdentity: t.agent.processIdentity,
    }), expect.any(String)]])
    expect(t.service.receipt('device', 'input-A')?.state).toBe('queued')
    t.dispatched()
    t.agent.sessionId = 's1'; t.agent.transcriptPath = join(t.core.dataDir, 's1.jsonl'); t.agent.boundAt = 1_001
    t.prove()
    expect(t.service.receipt('device', 'input-A')?.state).toBe('completed')
  })

  it('keeps end-to-start adjacency in the original batch while raw evidence drains', async () => {
    const drained = deferred<void>(), t = await fixture({ drain: drained.promise })
    await t.send(); t.dispatched()
    const ended = vi.spyOn(t.service, 'turnEnded'), started = vi.spyOn(t.service, 'turnStarted')
    const applying = t.feedOptions()!.receive('agent', [
      { type: 'turn_ended', payload: {} }, { type: 'turn_started', payload: { userMessage: 'next' } },
    ], () => true)
    try {
      expect(started).not.toHaveBeenCalled()
      expect(ended).not.toHaveBeenCalled()
    } finally { drained.resolve(); await applying }
    expect(ended).not.toHaveBeenCalled()
    expect(started).toHaveBeenCalledOnce()
  })

  it.each(['EVIDENCE_BINDING_LOST', 'EVIDENCE_GAP', 'EVIDENCE_TOO_LARGE'])('keeps a %s read unknown without retrying input', async code => {
    const t = await fixture()
    await t.send(); t.dispatched()
    expect(t.sink()).toBeDefined()
    t.sink()!.gap('agent', code)
    expect(t.service.receipt('device', 'input-A')).toMatchObject({ state: 'unknown', error: { code: 'RESULT_EVIDENCE_MISSING' } })
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
    await t.send()
    expect(t.core.turns.deliver).toHaveBeenCalledOnce()
  })
})
