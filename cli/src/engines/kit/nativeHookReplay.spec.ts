import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeHookReplay } from './nativeHookReplay.js'
import { nativeHookAcknowledgement } from './nativeHookClientProtocol.js'
import type { NativeHookClientDelivery } from './nativeHookOutbox.js'
import type { NativeHookClientRequest } from './nativeHookClient.js'
import type { NativeHookStorage } from './nativeHookStorage.js'

type Outbox = NonNullable<Awaited<ReturnType<NativeHookStorage['readOutbox']>>>
const id = (n = 1) => `fixture-delivery-${String(n).padStart(4, '0')}`
const phase = (name: 'registration' | 'stop') => ({ name,
  path: name === 'registration' ? '/api/hook/session-start' as const : '/api/hook/turn-stop' as const,
  body: '{"callerPid":42,"nativeOrigin":{"retained":"unchanged"},"prompt":"é📘"}', acknowledged: false })
const receipt = (request: NativeHookClientRequest) => nativeHookAcknowledgement(request,
  { ...phase(request.path.endsWith('session-start') ? 'registration' : 'stop'), body: request.body }, 'owned')
function fixture(shards = new Map([[0, [id()]]])) {
  const acknowledgements = new Map<string, Set<string>>()
  const proof = vi.fn(), snapshotProof = vi.fn()
  const entry = (id: string): NativeHookClientDelivery => ({ id, fingerprint: 'a'.repeat(64), firedAt: 1234, port: 19400,
    phases: [phase('registration'), phase('stop')].map(value => ({ ...value, acknowledged: acknowledgements.get(id)?.has(value.name) ?? false })),
    verify: proof })
  const boxes: Outbox[] = []
  const open = (shard: number): Outbox => {
    const box: Outbox = {
      snapshot: vi.fn(async () => ({ deliveries: new Map((shards.get(shard) ?? []).map(id => [id, entry(id)])),
        confirm: async () => {}, verify: snapshotProof })),
      acknowledge: vi.fn(async (delivery, phase) => {
        const known = acknowledgements.get(delivery.id) ?? new Set<string>()
        known.add(phase); acknowledgements.set(delivery.id, known)
      }), close: vi.fn(async () => {}),
    }
    boxes.push(box); return box
  }
  const deps = { readOutbox: vi.fn(async (shard: number, _current?: () => boolean) => open(shard)),
    send: vi.fn(async (request: NativeHookClientRequest, _current: () => boolean, _remainingMs: number): Promise<unknown> => receipt(request)),
    onHeld: vi.fn(), intervalMs: 100, timeoutMs: 500 }
  return { deps, open, boxes, proof, snapshotProof, acknowledgements }
}
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('does no work before readiness, starts once, and stops scheduling on shutdown', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  await vi.advanceTimersByTimeAsync(1000)
  expect(f.deps.readOutbox).not.toHaveBeenCalled()
  replay.start(); replay.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.deps.readOutbox.mock.calls.map(([shard]) => shard)).toEqual([0])
  await replay.close(); replay.start(); await vi.advanceTimersByTimeAsync(1000)
  expect(f.deps.readOutbox).toHaveBeenCalledOnce()
  expect(f.boxes.every(box => vi.mocked(box.close).mock.calls.length === 1)).toBe(true)
})

it('replays exact retained bytes, ID, time and route, and confirms registration ACK before Stop', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  f.deps.send.mockImplementation(async request => {
    if (request.path.endsWith('turn-stop')) expect(f.acknowledgements.get(id())?.has('registration')).toBe(true)
    return receipt(request)
  })
  replay.start(); await vi.advanceTimersByTimeAsync(0); await replay.close()
  expect(f.deps.send.mock.calls.map(([request]) => request)).toEqual([
    { port: 19400, path: '/api/native-hook/v1/session-start', id: id(), firedAt: 1234, body: phase('registration').body },
    { port: 19400, path: '/api/native-hook/v1/turn-stop', id: id(), firedAt: 1234, body: phase('stop').body },
  ])
  expect(f.acknowledgements.get(id())).toEqual(new Set(['registration', 'stop']))
  expect(f.deps.onHeld).toHaveBeenCalledWith(0, id(), undefined)
})

it('resumes only the unowned Stop after reconstruction', async () => {
  const f = fixture(), first = createNativeHookReplay(f.deps)
  f.deps.send.mockImplementation(async request => request.path.endsWith('session-start') ? receipt(request) : undefined)
  first.start(); await vi.advanceTimersByTimeAsync(0); await first.close()
  expect(f.acknowledgements.get(id())).toEqual(new Set(['registration']))
  f.deps.send.mockClear(); f.deps.send.mockImplementation(async request => receipt(request))
  const second = createNativeHookReplay(f.deps)
  second.start(); await vi.advanceTimersByTimeAsync(0); await second.close()
  expect(f.deps.send).toHaveBeenCalledOnce()
  expect(f.deps.send.mock.calls[0][0].path).toBe('/api/native-hook/v1/turn-stop')
})

it('gives transport only the original attempt budget remaining after storage and prior phases', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  f.deps.readOutbox.mockImplementation(async shard => {
    await wait(10)
    const box = f.open(shard), acknowledge = vi.mocked(box.acknowledge).getMockImplementation()!
    vi.mocked(box.acknowledge).mockImplementation(async (...args) => { await wait(30); await acknowledge(...args) })
    return box
  })
  f.deps.send.mockImplementation(async request => { await wait(20); return receipt(request) })
  replay.start(); await vi.advanceTimersByTimeAsync(150); await replay.close()
  expect(f.deps.send.mock.calls.map(([, , remaining]) => remaining)).toEqual([490, 440])
  expect(f.acknowledgements.get(id())).toEqual(new Set(['registration', 'stop']))
})

it.each([{ ok: true }, { pending: true }, { ignored: true }, { version: 1, outcome: 'owned' }])('holds an unconfirmed reply %j without ACK or Stop', async response => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  f.deps.send.mockResolvedValue(response)
  replay.start(); await vi.advanceTimersByTimeAsync(0); await replay.close()
  expect(f.deps.send).toHaveBeenCalledOnce()
  expect(f.acknowledgements.size).toBe(0)
  expect(f.deps.onHeld).toHaveBeenCalledWith(0, id(), expect.stringContaining('confirmed core ownership'))
})

it('does not send Stop after an unconfirmed registration ACK write', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  f.deps.readOutbox.mockImplementation(async shard => {
    const box = f.open(shard); vi.mocked(box.acknowledge).mockRejectedValue(Error('fixture disk unavailable')); return box
  })
  replay.start(); await vi.advanceTimersByTimeAsync(0); await replay.close()
  expect(f.deps.send).toHaveBeenCalledOnce(); expect(f.acknowledgements.size).toBe(0)
  expect(f.deps.onHeld).toHaveBeenCalledWith(0, id(), 'fixture disk unavailable')
})

it.each(['snapshot', 'delivery', 'reply'])('rechecks immutable evidence at %s before ownership transfer', async point => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  const fail = () => { throw Error('fixture replaced history') }
  if (point === 'snapshot') f.snapshotProof.mockImplementation(fail)
  if (point === 'delivery') f.proof.mockImplementation(fail)
  if (point === 'reply') f.deps.send.mockImplementation(async request => { f.proof.mockImplementation(fail); return receipt(request) })
  replay.start(); await vi.advanceTimersByTimeAsync(0); await replay.close()
  expect(f.deps.send).toHaveBeenCalledTimes(point === 'reply' ? 1 : 0)
  expect(f.acknowledgements.size).toBe(0)
})

it('rotates shards and IDs past a permanently held predecessor', async () => {
  const f = fixture(new Map([[0, [id(), id(2)]]])), replay = createNativeHookReplay(f.deps)
  f.deps.send.mockImplementation(async request => request.id === id() ? undefined : receipt(request))
  replay.start(); await vi.advanceTimersByTimeAsync(3200); await replay.close()
  expect(f.deps.send.mock.calls.map(([request]) => request.id)).toEqual([id(), id(2), id(2), id()])
  expect(f.acknowledgements.get(id(2))).toEqual(new Set(['registration', 'stop']))
  expect(f.acknowledgements.has(id())).toBe(false)
})

it.each(['transport', 'cleanup'])('keeps four actual %s slots after their deadlines', async stalled => {
  const f = fixture(new Map(Array.from({ length: 16 }, (_, n) => [n, [id(n + 1)]]))), replay = createNativeHookReplay(f.deps)
  const releases: (() => void)[] = []
  if (stalled === 'transport') f.deps.send.mockImplementation(request => new Promise(resolve => { releases.push(() => resolve(receipt(request))) }))
  else f.deps.readOutbox.mockImplementation(async shard => {
    const box = f.open(shard)
    vi.mocked(box.close).mockImplementation(() => new Promise(resolve => { releases.push(resolve) }))
    return box
  })
  replay.start(); await vi.advanceTimersByTimeAsync(2100)
  expect(f.deps.readOutbox).toHaveBeenCalledTimes(4)
  expect(releases).toHaveLength(4)
  releases.splice(0).forEach(release => release())
  await vi.advanceTimersByTimeAsync(stalled === 'transport' ? 2100 : 400)
  expect(f.deps.readOutbox).toHaveBeenCalledTimes(8)
  if (stalled === 'transport') expect(f.acknowledgements.size).toBe(0)
  const closing = replay.close(); releases.splice(0).forEach(release => release()); await closing
  expect(f.deps.readOutbox).toHaveBeenCalledTimes(8)
})

it('serializes live retries while allowing another shard past an expired actual operation', async () => {
  const f = fixture(new Map([[0, [id()]], [1, [id(2)]]])), replay = createNativeHookReplay(f.deps)
  const releases: (() => void)[] = []
  f.deps.send.mockImplementation(request => new Promise(resolve => releases.push(() => resolve(receipt(request)))))
  replay.start(); await vi.advanceTimersByTimeAsync(499)
  expect(f.deps.readOutbox.mock.calls.map(([shard]) => shard)).toEqual([0])
  await vi.advanceTimersByTimeAsync(1)
  expect(f.deps.readOutbox.mock.calls.map(([shard]) => shard)).toEqual([0, 1])
  const closing = replay.close(); releases.forEach(release => release()); await closing
  expect(f.acknowledgements.size).toBe(0)
})

it('revokes a late opener and closes it without reading or sending after shutdown', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps), releases: (() => void)[] = []
  f.deps.readOutbox.mockImplementation(shard => new Promise(resolve => { releases.push(() => resolve(f.open(shard))) }))
  replay.start(); await vi.advanceTimersByTimeAsync(0)
  const closing = replay.close()
  releases.forEach(release => release()); await closing
  expect(f.deps.send).not.toHaveBeenCalled()
  for (const box of f.boxes) { expect(box.snapshot).not.toHaveBeenCalled(); expect(box.close).toHaveBeenCalledOnce() }
})

it('contains failing hold displays and bounds their reason without losing cleanup', async () => {
  const f = fixture(), replay = createNativeHookReplay(f.deps)
  f.deps.send.mockRejectedValue(Error('x'.repeat(2000)))
  f.deps.onHeld.mockImplementation(() => { throw Error('fixture display unavailable') })
  replay.start(); await vi.advanceTimersByTimeAsync(0); await replay.close()
  expect(f.deps.onHeld).toHaveBeenCalledWith(0, id(), 'x'.repeat(1024))
  expect(f.boxes.every(box => vi.mocked(box.close).mock.calls.length === 1)).toBe(true)
})
