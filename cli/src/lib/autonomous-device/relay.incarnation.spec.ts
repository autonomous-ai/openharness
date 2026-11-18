import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceRelay } from './relay.js'
import { AutonomousDeviceService } from './service.js'

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(beforeReady?: () => Promise<void>, recent: () => Promise<unknown[]> = async () => [], beforeRequest?: () => Promise<void>) {
  let incarnation = 'original-session'
  let peerEpoch = 'original-peer'
  const send = vi.fn(), joined = vi.fn(), client = vi.fn(), revoke = vi.fn()
  const session = () => ({ identity: 'same-paired-identity', incarnation, peerEpoch })
  const service = new AutonomousDeviceService({ machineId: 'machine',
    agents: () => [{ agentId: 'agent', name: 'Agent', engine: 'claude', state: 'idle' }],
    submit: () => {}, cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent,
  })
  const relay = new AutonomousDeviceRelay(session, send, service, 'machine', (connId, proof, frames, allowed, hello) => () => {
    if (hello) send(connId, { type: 'autonomous_device_result', payload: structuredClone(hello) }, proof)
    for (const frame of frames) if (allowed(frame)) send(connId, { type: 'autonomous_device_event', payload: structuredClone(frame) }, proof)
  }, joined, revoke, client, beforeReady, beforeRequest)
  const request = (body: Record<string, unknown>) => relay.handle('reused-connection', session(), body)
  const hello = () => request({ type: 'hello', proto: 1, requestId: randomUUID() })
  return { relay, request, hello, send, joined, client, revoke,
    replace: () => { incarnation = 'replacement-session' },
    replacePeer: () => { peerEpoch = 'replacement-peer'; relay.restore('reused-connection', session()) },
  }
}

describe('device replies belong to their original E2EE session', () => {
  it('does not finish an old hello after the same identity replaces its session', async () => {
    const observation = pending<void>()
    const f = fixture(() => observation.promise)
    const opening = f.hello()
    f.replace()
    observation.resolve()
    await opening
    expect(f.send).not.toHaveBeenCalled()
    expect(f.joined).not.toHaveBeenCalled()
    expect(f.client.mock.calls.some(([, , hello]) => hello === true)).toBe(false)
    expect(f.relay.connected()).toBe(false)
  })

  it('does not reject a replacement peer when the old hello readiness fails later', async () => {
    let reject!: (error: Error) => void
    const f = fixture(() => new Promise<void>((_, fail) => { reject = fail }))
    const opening = f.hello()
    f.replacePeer(); f.send.mockClear()
    reject(new Error('unavailable')); await opening
    expect(f.send).not.toHaveBeenCalled()
    expect(f.relay.helloed()).toEqual(['reused-connection'])
  })

  it('does not send an old async result into a replacement that has completed its own hello', async () => {
    const reading = pending<unknown[]>()
    const f = fixture(undefined, () => reading.promise)
    await f.hello()
    const oldRequest = randomUUID()
    const answer = f.request({ type: 'recap', requestId: oldRequest, machineId: 'machine', agentId: 'agent' })
    f.replace()
    await f.hello()
    f.send.mockClear()
    reading.resolve([])
    await answer
    expect(f.send).not.toHaveBeenCalled()
    expect(f.relay.connected()).toBe(true)
  })

  it('does not reuse the previous hello for events or a revoke on a new session', async () => {
    const f = fixture()
    await f.hello()
    f.replace()
    f.send.mockClear()
    f.relay.emit({ type: 'event', kind: 'focus.changed', payload: { focusRevision: 'one' } })
    expect(f.send).not.toHaveBeenCalled()
    expect(f.relay.connected()).toBe(false)
    await f.request({ type: 'pair.revoke', requestId: randomUUID() })
    expect(f.revoke).not.toHaveBeenCalled()
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { error: { code: 'HELLO_REQUIRED' } } })
  })

  it('captures proof values before awaiting instead of trusting a caller-owned mutable object', async () => {
    const reading = pending<unknown[]>()
    const f = fixture(undefined, () => reading.promise)
    await f.hello()
    const proof = { identity: 'same-paired-identity', incarnation: 'original-session', peerEpoch: 'original-peer' }
    const answer = f.relay.handle('reused-connection', proof, {
      type: 'recap', requestId: randomUUID(), machineId: 'machine', agentId: 'agent',
    })
    f.replace()
    proof.incarnation = 'replacement-session'
    await f.hello()
    f.send.mockClear()
    reading.resolve([])
    await answer
    expect(f.send).not.toHaveBeenCalled()
  })

  it('publishes the joined transition with the hello’s captured incarnation', async () => {
    const f = fixture()
    await f.hello()
    expect(f.joined).toHaveBeenCalledWith('reused-connection', {
      identity: 'same-paired-identity', incarnation: 'original-session', peerEpoch: 'original-peer',
    })
  })

  it('admits only four requests before a shared view refresh can stall them', async () => {
    const reading = pending<void>(), prepare = vi.fn(() => reading.promise)
    const f = fixture(undefined, async () => [], prepare)
    await f.hello()
    f.send.mockClear()
    const active = Array.from({ length: 4 }, () => f.request({ type: 'agents.list', requestId: randomUUID(), machineId: 'machine' }))
    expect(prepare).toHaveBeenCalledTimes(4)
    expect(f.send).not.toHaveBeenCalled()
    await f.request({ type: 'agents.list', requestId: 'fifth', machineId: 'machine' })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { requestId: 'fifth', error: { code: 'BACKPRESSURE' } } })
    reading.resolve()
    await Promise.all(active)
    expect(f.send).toHaveBeenCalledTimes(5)
  })

  it('keeps four actual handlers admitted across a peer replacement and sends new events on the new route', async () => {
    const reading = pending<unknown[]>()
    const f = fixture(undefined, () => reading.promise)
    await f.hello()
    const active = Array.from({ length: 4 }, () => f.request({ type: 'recap', requestId: randomUUID(), machineId: 'machine', agentId: 'agent' }))
    f.replacePeer()
    f.send.mockClear()
    await f.request({ type: 'agents.list', requestId: 'fifth' })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { requestId: 'fifth', error: { code: 'BACKPRESSURE' } } })
    f.relay.emit({ type: 'event', kind: 'focus.changed', payload: { focusRevision: 'new' } })
    expect(f.send.mock.calls.at(-1)?.[2]).toEqual({ identity: 'same-paired-identity', incarnation: 'original-session', peerEpoch: 'replacement-peer' })
    f.send.mockClear()
    reading.resolve([])
    await Promise.all(active)
    expect(f.send).not.toHaveBeenCalled()
    await f.request({ type: 'agents.list', requestId: randomUUID() })
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]![1]).toMatchObject({ payload: { type: 'agents.list_result' } })
  })
})
