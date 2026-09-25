import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AutonomousDeviceRelay } from './relay.js'
import { AutonomousDeviceService } from './service.js'
import { randomUUID } from 'node:crypto'
function fixture(store?: import('./store.js').AutonomousDeviceStore) {
  let role = 'device', identity: string | null = 'trusted-device'
  const submit = vi.fn(), cancel = vi.fn(() => true), send = vi.fn()
  const crypto = { sessionRole: () => role as 'device' | 'web', sessionIdentity: () => identity,
    unwrapDown: (_c: string, frame: Record<string, unknown>) => ({ ...frame, payload: (frame.payload as { __e2e: unknown }).__e2e }),
    wrapTarget: (_c: string, type: string, payload: Record<string, unknown>) => ({ type, payload: { __e2e: payload } }) }
  const service = new AutonomousDeviceService({ store, now: () => 0, machineId: 'machine', agents: () => [{ agentId: 'agent', name: 'Agent', engine: 'codex', state: 'idle' }], submit, cancelDelivery: cancel, stop: async () => true, answer: async () => true, recent: () => [] })
  const remoteRevoke = vi.fn()
  const relay = new AutonomousDeviceRelay(crypto, send, service, 'machine', undefined, remoteRevoke)
  const request = (payload: Record<string, unknown>) => relay.handle('conn', { type: 'autonomous_device_request', payload: { __e2e: payload } })
  return { relay, request, send, submit, service, cancel, remoteRevoke, setRole: (r: string) => { role = r }, setIdentity: (id: string) => { identity = id }, revoke: () => { identity = null } }
}
describe('Autonomous device existing E2EE relay seam', () => {
  it('requires existing device-role trust and encrypted payload before calling the service', async () => {
    const f = fixture(); f.setRole('web')
    await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    expect(f.send).not.toHaveBeenCalled()
    f.setRole('device'); await f.relay.handle('conn', { type: 'autonomous_device_request', payload: { type: 'hello' } })
    expect(f.send).not.toHaveBeenCalled()
    await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    expect(f.send.mock.calls[0][1]).toMatchObject({ type: 'autonomous_device_result', payload: { __e2e: { type: 'hello_result', proto: 1 } } })
  })
  it('uses pinned identity for dedupe and drops revoked queued work', async () => {
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
  it('removes a device pairing only after its authenticated revoke request', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    await f.request({ type: 'pair.revoke', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({
      type: 'autonomous_device_result', payload: { __e2e: { type: 'pair.revoke_result', revoked: true } },
    })
    expect(f.remoteRevoke).toHaveBeenCalledWith('trusted-device')
  })
  it('app-side revoke sends exactly one sealed pair.revoke to the connected device, then drops it', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    f.send.mockClear()
    f.relay.revoke('trusted-device')
    const revokes = f.send.mock.calls.filter(([, frame]) => (frame as { payload: { __e2e: { type: string } } }).payload.__e2e.type === 'pair.revoke')
    expect(revokes).toHaveLength(1)
    expect(revokes[0][1]).toEqual({ type: 'autonomous_device_event', payload: { __e2e: { type: 'pair.revoke', machineId: 'machine' } } })
    // Client state is gone: the next request needs a fresh application hello.
    await f.request({ type: 'turn.send', requestId: randomUUID() })
    expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { __e2e: { error: { code: 'HELLO_REQUIRED' } } } })
  })
  it('does not revoke when the request is malformed', async () => {
    const f = fixture(); await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
    await f.request({ type: 'pair.revoke', requestId: randomUUID(), extra: true })
    expect(f.remoteRevoke).not.toHaveBeenCalled()
  })
})

it('Store uses the same device-only encrypted hello gate and never exposes generic app operations', async () => {
  const call = vi.fn(async (_identity: string, _req: Record<string, unknown>) => ({ packages: [], nextOffset: null, machineId: 'machine' }))
  const store = { request: call } as unknown as import('./store.js').AutonomousDeviceStore
  const f = fixture(store)
  await f.request({ type: 'store.list', requestId: randomUUID() })
  expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { __e2e: { error: { code: 'HELLO_REQUIRED' } } } })
  expect(call).not.toHaveBeenCalled()
  f.setRole('web')
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  await f.request({ type: 'store.list', requestId: randomUUID() })
  expect(call).not.toHaveBeenCalled()
  f.setRole('device')
  await f.relay.handle('conn', { type: 'autonomous_device_request', payload: { type: 'store.list' } })
  expect(call).not.toHaveBeenCalled()
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  expect(f.send.mock.calls.some(([, frame]) => frame.payload.__e2e.capabilities?.includes('agent.prepare'))).toBe(true)
  await f.request({ type: 'store.list', requestId: randomUUID() })
  expect(call).toHaveBeenCalledOnce()
  expect(call.mock.calls[0]?.[0]).toBe('trusted-device')
  await f.request({ type: 'agent_create', requestId: randomUUID(), cwd: '/tmp', engine: 'claude' })
  expect(f.send.mock.calls.at(-1)?.[1]).toMatchObject({ payload: { __e2e: { error: { code: 'UNSUPPORTED_CAPABILITY' } } } })
  expect(call).toHaveBeenCalledOnce()
})


it('delivers correlated summaries by default only to the originating identity, including replay', async () => {
  const f = fixture()
  const capture = JSON.parse(readFileSync(new URL('../../../../docs/contracts/device-summary-correlation/codex-steering.json', import.meta.url), 'utf8'))
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() }) // unchanged application hello
  for (const [i, text] of capture.inputs.entries()) {
    await f.request({ type: 'turn.send', requestId: randomUUID(), machineId: 'machine', agentId: 'agent', idempotencyKey: `key-${i}`, text })
    f.service.inputDispatched('agent', f.service.receipt('trusted-device', `key-${i}`)!.deliveryId, text)
  }
  for (const row of capture.records) f.service.observeTranscript('agent', 'session', 'codex', JSON.stringify(row))
  const frames: any[] = []
  f.service.replay(undefined, e => frames.push(e))
  const result = frames.find(e => e.kind === 'turn.summary')
  expect(result).toBeDefined()
  const results = () => f.send.mock.calls.map(([, frame]) => frame.payload.__e2e).filter(e => e.kind === 'turn.summary')
  f.send.mockClear(); f.relay.emit(result)
  expect(results()).toHaveLength(1)
  f.send.mockClear()
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  expect(results()).toHaveLength(1)
  f.send.mockClear(); f.setIdentity('other-device')
  await f.request({ type: 'hello', proto: 1, requestId: randomUUID() })
  f.relay.emit(result); expect(results()).toHaveLength(0)
})
