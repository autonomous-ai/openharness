import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceRelay, type DeviceRelayReplay } from './relay.js'
import { AutonomousDeviceService } from './service.js'
import { randomUUID } from 'node:crypto'

function replayTo(send: ConstructorParameters<typeof AutonomousDeviceRelay>[1]): DeviceRelayReplay {
  return (connId, proof, frames, allowed, hello) => () => {
    if (hello) send(connId, { type: 'autonomous_device_result', payload: structuredClone(hello) }, proof)
    for (const frame of frames) if (allowed(frame)) send(connId, { type: 'autonomous_device_event', payload: structuredClone(frame) }, proof)
  }
}
function fixture(store?: import('./store.js').AutonomousDeviceStore, beforeReady?: () => Promise<void>) {
  let identity: string | null = 'trusted-device'
  const submit = vi.fn(), cancel = vi.fn(() => true), send = vi.fn(), remoteRevoke = vi.fn(), clients = vi.fn()
  const proof = () => ({ identity: identity ?? 'revoked', incarnation: `session:${identity}`, peerEpoch: 'peer' })
  const service = new AutonomousDeviceService({ store, now: () => 0, machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Agent', engine: 'codex', state: 'idle' }], submit, cancelDelivery: cancel, stop: async () => true, answer: async () => true, recent: () => [] })
  const relay = new AutonomousDeviceRelay(() => identity ? proof() : null, send, service, 'machine', replayTo(send), undefined, remoteRevoke, clients, beforeReady)
  const request = (payload: Record<string, unknown>) => relay.handle('conn', proof(), payload)
  return { relay, request, proof, send, submit, service, cancel, clients, remoteRevoke,
    setIdentity: (id: string) => { identity = id }, revoke: () => { identity = null } }
}
describe('application relay over authenticated opened device requests', () => {
  it('holds one hello until questions are ready, replies first and fences a replaced identity', async () => {
    let ready!: () => void
    const prepare = vi.fn(() => new Promise<void>(resolve => { ready = resolve }))
    const f = fixture(undefined, prepare)
    const hello = (id: string) => f.request({ type: 'hello', proto: 1, requestId: id,
      resume: { serverInstanceId: f.service.serverInstanceId, cursor: 0 } })
    const first = hello('first')
    expect(f.send).not.toHaveBeenCalled()
    await hello('duplicate')
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { requestId: 'duplicate', error: { code: 'HELLO_PENDING' } } })
    expect(prepare).toHaveBeenCalledOnce()
    f.send.mockClear()
    f.service.commander({ type: 'commander_question', agentId: 'agent', payload: { requestId: 'q', questions: [] } })
    ready(); await first
    expect(f.send.mock.calls[0][1]).toMatchObject({ type: 'autonomous_device_result', payload: { type: 'hello_result', requestId: 'first' } })
    expect(f.send.mock.calls[1][1]).toMatchObject({ type: 'autonomous_device_event', payload: { kind: 'question.open' } })
    f.send.mockClear()
    const replaced = hello('replaced')
    f.setIdentity('replacement'); ready(); await replaced
    expect(f.send).not.toHaveBeenCalled()
  })

  it('uses the captured paired identity for dedupe and removes revoked queued work', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    const req = { type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: 'one', text: 'hello' }
    await f.request(req); await f.request({ ...req, requestId: randomUUID() })
    expect(f.submit).toHaveBeenCalledTimes(1)
    expect(f.service.receipt('trusted-device', 'one')?.state).toBe('queued')
    f.relay.revoke('trusted-device'); f.revoke()
    expect(f.cancel).toHaveBeenCalledOnce()
    expect(f.service.receipt('trusted-device', 'one')).toBeNull()
    await f.request(req); expect(f.submit).toHaveBeenCalledTimes(1)
  })

  it('revokes only an authenticated application request, after its reply, and rejects malformed requests', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    await f.request({ type: 'pair.revoke', requestId: randomUUID(), extra: true })
    expect(f.remoteRevoke).not.toHaveBeenCalled()
    await f.request({ type: 'pair.revoke', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ type: 'autonomous_device_result', payload: { type: 'pair.revoke_result', revoked: true } })
    expect(f.remoteRevoke).toHaveBeenCalledExactlyOnceWith('conn', f.proof())
  })

  it('app-side revoke tells the current device once, then requires a fresh application hello', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    f.send.mockClear(); f.relay.revoke('trusted-device')
    const revoked = f.send.mock.calls.filter(([, frame]) => frame.payload.type === 'pair.revoke')
    expect(revoked).toHaveLength(1)
    expect(revoked[0][1]).toEqual({ type: 'autonomous_device_event', payload: { type: 'pair.revoke', machineId: 'machine' } })
    await f.request({ type: 'turn.send', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { error: { code: 'HELLO_REQUIRED' } } })
  })

  it('serves a still-current restored hello once and refuses a different identity', async () => {
    const f = fixture()
    f.relay.restore('conn', { ...f.proof(), identity: 'other' })
    expect(f.send).not.toHaveBeenCalled()
    f.relay.restore('conn', f.proof())
    expect(f.relay.helloed()).toEqual(['conn'])
    expect(f.clients).toHaveBeenCalledWith('conn', f.proof(), true)
    expect(f.send.mock.calls[0][1]).toMatchObject({ payload: { type: 'resync', reason: 'instance_changed' } })
    await f.request({ type: 'agents.list', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { type: 'agents.list_result' } })
    f.send.mockClear(); f.relay.restore('conn', f.proof())
    expect(f.send).not.toHaveBeenCalled()
  })
})

it('Store uses the application hello gate and never exposes generic app operations', async () => {
  const call = vi.fn(async (_identity: string, _req: Record<string, unknown>) => ({ packages: [], nextOffset: null, machineId: 'machine' }))
  const f = fixture({ request: call } as unknown as import('./store.js').AutonomousDeviceStore)
  await f.request({ type: 'store.list', requestId: randomUUID() })
  expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { error: { code: 'HELLO_REQUIRED' } } })
  expect(call).not.toHaveBeenCalled()
  f.revoke(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  expect(call).not.toHaveBeenCalled()
  f.setIdentity('trusted-device')
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  expect(f.send.mock.calls.some(([, frame]) => frame.payload.capabilities?.includes('agent.prepare'))).toBe(true)
  await f.request({ type: 'store.list', requestId: randomUUID() })
  expect(call).toHaveBeenCalledExactlyOnceWith('trusted-device', expect.objectContaining({ type: 'store.list' }))
  await f.request({ type: 'agent_create', requestId: randomUUID(), cwd: '/tmp', engine: 'claude' })
  expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { error: { code: 'UNSUPPORTED_CAPABILITY' } } })
  expect(call).toHaveBeenCalledOnce()
})

it('delivers correlated summaries by default only to the originating identity, including replay', async () => {
  const f = fixture()
  const capture = JSON.parse(readFileSync(new URL('../../../../docs/contracts/autonomous-device-summary-correlation/codex-steering.json', import.meta.url), 'utf8'))
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() }) // unchanged application hello
  for (const [i, text] of capture.inputs.entries()) {
    await f.request({ type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: `key-${i}`, text })
    f.service.inputDispatched('agent', f.service.receipt('trusted-device', `key-${i}`)!.deliveryId, text)
  }
  for (const row of capture.records) f.service.observeTranscript('agent', 'session', 'codex', JSON.stringify(row))
  const frames: any[] = []
  f.service.replay(undefined, retained => () => { frames.push(...structuredClone(retained)) })
  const result = frames.find(e => e.kind === 'turn.summary')
  expect(result).toBeDefined()
  const results = () => f.send.mock.calls.map(([, frame]) => frame.payload).filter(e => e.kind === 'turn.summary')
  f.send.mockClear(); f.relay.emit(result)
  expect(results()).toHaveLength(1)
  f.send.mockClear()
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  expect(results()).toHaveLength(1)
  f.send.mockClear(); f.setIdentity('other-device')
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  f.relay.emit(result); expect(results()).toHaveLength(0)
})

describe('device add-ons over the E2EE relay', () => {
  it('advertises add-ons, keeps what the device publishes, and seals a proposal to that device alone', async () => {
    let crypto: { identity: string } = { identity: 'lamp' }
    const send = vi.fn()
    let relay: AutonomousDeviceRelay | undefined
    const service = new AutonomousDeviceService({ now: () => 0, machineId: 'machine', agents: () => [], submit: vi.fn(), cancelDelivery: () => true,
      stop: async () => true, answer: async () => true, recent: () => [], emit: (frame, deviceId) => relay?.emit(frame, deviceId) })
    const proof = (connId: string) => ({ identity: connId === 'other' ? 'other-device' : crypto.identity, incarnation: 'session', peerEpoch: 'peer' })
    relay = new AutonomousDeviceRelay(proof, send, service, 'machine', replayTo(send))
    const request = (connId: string, payload: Record<string, unknown>) => relay!.handle(connId, proof(connId), payload)
    const opened = (i: number) => send.mock.calls[i][1].payload as Record<string, unknown>

    await request('conn', { type: 'hello', proto: 1, requestId: randomUUID() })
    expect(opened(0).capabilities).toEqual(expect.arrayContaining(['addon.publish', 'addon.decision']))
    await request('other', { type: 'hello', proto: 1, requestId: randomUUID() })
    send.mockClear()

    await request('conn', { type: 'addon.publish', requestId: randomUUID(), values: [{ topic: 'room/presence', value: { someone: true } }] })
    expect(opened(0)).toMatchObject({ type: 'addon.publish_result', topics: 1 })
    expect(service.addons.state()).toMatchObject([{ deviceId: 'lamp', online: true, topics: { 'room/presence': { value: { someone: true } } } }])
    send.mockClear()

    const proposal = service.addons.propose({ addon: 'evening-glow', idempotencyKey: 'k1', act: 'light', holdsMs: 30_000, params: { colour: 'warm', level: 2 } })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0]).toBe('conn')
    expect(opened(0)).toEqual({ type: 'event', serverInstanceId: service.serverInstanceId, machineId: 'machine', kind: 'addon.proposal',
      payload: { proposalId: proposal.proposalId, addon: 'evening-glow', act: 'light', holdsMs: 30_000, params: { colour: 'warm', level: 2 }, expiresAt: 30_000 } })
    send.mockClear()

    // Not in the replay log: a device that reconnects is not handed lapsed proposals.
    await request('conn', { type: 'hello', proto: 1, requestId: randomUUID(), resume: { serverInstanceId: service.serverInstanceId, cursor: 0 } })
    expect(send.mock.calls.map((_, i) => opened(i).kind).filter(Boolean)).not.toContain('addon.proposal')
    send.mockClear()

    await request('other', { type: 'addon.decision', requestId: randomUUID(), proposalId: proposal.proposalId, decision: 'kept' })
    expect(opened(0)).toMatchObject({ type: 'addon.decision_result', error: { code: 'PROPOSAL_UNKNOWN' } })
    await request('conn', { type: 'addon.decision', requestId: randomUUID(), proposalId: proposal.proposalId, decision: 'kept', reason: 'evening, someone here' })
    expect(opened(1)).toMatchObject({ type: 'addon.decision_result', state: 'kept' })
    expect(service.addons.proposal(proposal.proposalId)).toMatchObject({ state: 'kept', reason: 'evening, someone here' })

    // A new hello clears what it published: it publishes its whole set again.
    await request('conn', { type: 'hello', proto: 1, requestId: randomUUID() })
    expect(service.addons.state('lamp')).toEqual([])
    await request('conn', { type: 'addon.publish', requestId: randomUUID(), values: [{ topic: 'room/presence', value: { someone: false } }] })
    send.mockClear()
    // A restored session (the service restarted, no hello) is asked to publish again.
    relay.drop('conn', 'session')
    relay.restore('conn', proof('conn'))
    expect(send.mock.calls.map((_, i) => opened(i).kind)).toContain('addon.republish')
    // The device's last link closing marks it offline; unpairing forgets it.
    relay.drop('conn', 'session')
    expect(service.addons.state('lamp')[0].online).toBe(false)
    relay.revoke('lamp')
    expect(service.addons.state('lamp')).toEqual([])
    crypto = { identity: 'lamp' }
  })
})
