import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildSync } from 'esbuild'
import { deliverNativeHookClient, type NativeHookClientRequest } from './nativeHookClient.js'
import { nativeHookAcknowledgement, nativeHookMutationRoute, readNativeHookAcknowledgement } from './nativeHookClientProtocol.js'
import { createNativeHookOutbox, nativeHookOutboxShard, type NativeHookClientInput } from './nativeHookOutbox.js'
import type { NativeHookOrigin } from './nativeHookOrigin.js'
import type { NativeHookStorage } from './nativeHookStorage.js'

const disk = vi.hoisted(() => ({ unavailable: false }))
vi.mock('node:fs', async original => ({ ...await original<object>(),
  fsync: (_fd: number, done: (error: Error | null) => void) => queueMicrotask(() => done(disk.unavailable ? Error('fixture disk unavailable') : null)),
}))
let root: string
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const origin = (): NativeHookOrigin => ({ version: 1, boot: 'linux:aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', callerPid: 43,
  ancestry: [{ pid: 43, parentPid: 42, birth: '12346', identityV1: hash('caller') },
    { pid: 42, parentPid: 1, birth: '12345', identityV1: hash('engine') }] })
const input = (): NativeHookClientInput => ({ id: 'fixture-delivery-0001', firedAt: 1791590400123, port: 19400,
  phases: [
    { name: 'registration', path: '/api/hook/session-start', body: { sessionId: 'fixture-session', prompt: 'é📘', callerPid: 43 } },
    { name: 'stop', path: '/api/hook/turn-stop', body: { sessionId: 'fixture-session', status: 'completed', callerPid: 43 } },
  ] })
const log = (current?: () => boolean) => createNativeHookOutbox({ directory: join(root, 'outbox'), shard: nativeHookOutboxShard(input().id), current })
const ack = (request: NativeHookClientRequest, outcome: 'owned' | 'complete' = 'owned') => nativeHookAcknowledgement(request,
  { name: request.path.endsWith('/session-start') ? 'registration' : 'stop',
    path: request.path.endsWith('/session-start') ? '/api/hook/session-start' : '/api/hook/turn-stop', body: request.body }, outcome)
function fixture() {
  const journals: ReturnType<typeof log>[] = []
  const storage: NativeHookStorage = {
    effects: vi.fn(async () => { throw Error('client cannot open an effects journal') }),
    readEffects: vi.fn(async () => { throw Error('fresh client cannot look up core receipts') }),
    readOutbox: vi.fn(async () => { throw Error('fresh client cannot resume another delivery') }),
    outbox: vi.fn(async (_shard, current) => { const value = log(current); journals.push(value); return value }),
    close: vi.fn(async () => { journals.forEach(journal => journal.close()) }),
  }
  return { captureOrigin: vi.fn(async () => origin()), openStorage: vi.fn(async () => storage), storage,
    send: vi.fn(async (request: NativeHookClientRequest): Promise<unknown> => ack(request)), timeoutMs: 5_000, retryDelayMs: 0 }
}
beforeEach(() => { disk.unavailable = false; root = realpathSync(mkdtempSync(join(tmpdir(), 'native-hook-client-'))) })
afterEach(() => { disk.unavailable = false; rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

it('retains both original phases before first send and never reacquires identity on retry', async () => {
  const deps = fixture(), body = input(), requests: NativeHookClientRequest[] = []
  let capture!: (value: NativeHookOrigin) => void
  deps.captureOrigin.mockImplementationOnce(() => new Promise(resolve => { capture = resolve }))
  deps.send.mockImplementation(async request => {
    requests.push(request)
    const retained = (await log().snapshot()).deliveries.get(body.id)!
    expect(retained.phases).toHaveLength(2)
    expect(retained.phases.every(phase => JSON.parse(phase.body).nativeOrigin.callerPid === 43)).toBe(true)
    if (requests.length === 1) return undefined as any
    return ack(request, request.path.endsWith('turn-stop') ? 'complete' : 'owned')
  })
  const pending = deliverNativeHookClient(body, deps)
  body.port++; body.firedAt++; body.phases[0].body.prompt = 'mutated'; body.phases[1].body.callerPid = 99
  capture(origin())
  expect(await pending).toEqual({ owned: true, completed: ['stop'] })
  expect(deps.captureOrigin).toHaveBeenCalledOnce()
  expect(requests).toHaveLength(3)
  expect(requests[0]).toEqual(requests[1])
  expect(requests.every(request => request.id === input().id && request.firedAt === input().firedAt && request.port === input().port)).toBe(true)
  expect(JSON.parse(requests[0].body).prompt).toBe('é📘')
  expect(requests.map(request => request.path)).toEqual(['/api/native-hook/v1/session-start', '/api/native-hook/v1/session-start', '/api/native-hook/v1/turn-stop'])
  expect((await log().snapshot()).deliveries.get(body.id)!.phases.map(phase => phase.acknowledged)).toEqual([true, true])
  expect(deps.storage.close).toHaveBeenCalledOnce()
})

it.each([{ ok: true }, { pending: true }, { ok: true, duplicate: true }, { ignored: true }])('does not acknowledge a legacy response %j or send its linked Stop', async reply => {
  const deps = fixture()
  deps.send.mockResolvedValue(reply as any)
  expect(await deliverNativeHookClient(input(), deps)).toMatchObject({ owned: false, completed: [], reason: expect.stringContaining('retained') })
  expect(deps.send).toHaveBeenCalledTimes(4)
  expect(deps.send.mock.calls.every(([request]) => request.path === '/api/native-hook/v1/session-start')).toBe(true)
  expect((await log().snapshot()).deliveries.get(input().id)!.phases.map(phase => phase.acknowledged)).toEqual([false, false])
})

it('never sends an old mutation route during an old-core/new-core transition', async () => {
  const deps = fixture()
  let legacyEffects = 0, versionedEffects = 0
  deps.send.mockImplementation(async request => {
    if (request.path.startsWith('/api/hook/')) { legacyEffects++; return undefined as any }
    // The old core returns 404 without running a hook. Only the new core can
    // own this route, even when replacement occurs between consecutive POSTs.
    if (deps.send.mock.calls.length === 1) return undefined as any
    versionedEffects++; return ack(request)
  })
  expect((await deliverNativeHookClient(input(), deps)).owned).toBe(true)
  expect(legacyEffects).toBe(0)
  expect(versionedEffects).toBe(2)
})

it('keeps an owned registration separate from an unconfirmed Stop across reconstruction', async () => {
  const first = fixture()
  first.send.mockImplementation(async request => request.path.endsWith('/session-start') ? ack(request) : undefined as any)
  expect((await deliverNativeHookClient(input(), first)).owned).toBe(false)
  const saved = (await log().snapshot()).deliveries.get(input().id)!
  expect(saved.phases.map(phase => phase.acknowledged)).toEqual([true, false])
  const second = fixture()
  expect(await deliverNativeHookClient(input(), second)).toEqual({ owned: true, completed: [] })
  expect(second.send).toHaveBeenCalledOnce()
  expect(second.send.mock.calls[0][0].body).toBe(saved.phases[1].body)
  expect(second.send.mock.calls[0][0].path).toBe('/api/native-hook/v1/turn-stop')
})

it('does not send when intake cannot be durably confirmed', async () => {
  const deps = fixture(); disk.unavailable = true
  expect(await deliverNativeHookClient(input(), deps)).toMatchObject({ owned: false, reason: expect.stringContaining('fixture disk unavailable') })
  expect(deps.send).not.toHaveBeenCalled()
  expect(deps.storage.close).toHaveBeenCalledOnce()
})

it('closes an opener that finishes after its bounded reply without allocating an outbox', async () => {
  const deps = fixture()
  let open!: (value: NativeHookStorage) => void
  deps.openStorage.mockImplementation(() => new Promise(resolve => { open = resolve }))
  const waiting = deliverNativeHookClient(input(), { ...deps, timeoutMs: 30 })
  await vi.waitFor(() => expect(deps.openStorage).toHaveBeenCalledOnce())
  expect(await waiting).toMatchObject({ owned: false, reason: expect.stringContaining('deadline') })
  expect(deps.storage.close).not.toHaveBeenCalled()
  open(deps.storage)
  await vi.waitFor(() => expect(deps.storage.close).toHaveBeenCalledOnce())
  expect(deps.storage.outbox).not.toHaveBeenCalled()
  expect(deps.send).not.toHaveBeenCalled()
})

it('revokes a late transport receipt before ACK publication and any next phase', async () => {
  const deps = fixture()
  let release!: (value: unknown) => void, request!: NativeHookClientRequest
  deps.send.mockImplementationOnce(async value => { request = value; return new Promise(resolve => { release = resolve }) })
  // The monotonic deadline is crossed after retain, independently of host fsync speed.
  let elapsed = false
  const now = performance.now.bind(performance)
  vi.spyOn(performance, 'now').mockImplementation(() => now() + (elapsed ? 10_000 : 0))
  const waiting = deliverNativeHookClient(input(), deps)
  await vi.waitFor(() => expect(deps.send).toHaveBeenCalledOnce())
  elapsed = true; release(ack(request))
  expect(await waiting).toMatchObject({ owned: false, reason: expect.stringContaining('deadline') })
  vi.restoreAllMocks()
  expect((await log().snapshot()).deliveries.get(input().id)!.phases.map(phase => phase.acknowledged)).toEqual([false, false])
  expect(deps.send).toHaveBeenCalledOnce()
})

it.each(['version', 'id', 'firedAt', 'phase', 'path', 'bodySha256', 'outcome', 'extra'])('requires an exact durable phase receipt: %s', key => {
  const request = { id: input().id, firedAt: input().firedAt },
    phase = { name: 'registration' as const, path: '/api/hook/session-start' as const, body: '{"é":"📘"}' }
  const valid = nativeHookAcknowledgement(request, phase, 'owned')
  expect(readNativeHookAcknowledgement(valid, request, phase)).toEqual(valid)
  expect(readNativeHookAcknowledgement({ ...valid, [key]: 'different' }, request, phase)).toBeUndefined()
  expect(readNativeHookAcknowledgement(valid, request, { ...phase, body: phase.body + ' ' })).toBeUndefined()
})

it('never accepts a receipt for another event endpoint with the same ID, time and bytes', () => {
  const delivery = { id: input().id, firedAt: input().firedAt }
  const endpoints = ['/api/hook/session-end', '/api/hook/turn-start', '/api/hook/tool-start'] as const
  for (const path of endpoints) {
    const phase = { name: 'event' as const, path, body: '{"sessionId":"fixture-session"}' }
    const receipt = nativeHookAcknowledgement(delivery, phase, 'complete')
    for (const other of endpoints) {
      expect(readNativeHookAcknowledgement(receipt, delivery, { ...phase, path: other }))
        .toEqual(other === path ? receipt : undefined)
    }
  }
})

it('refuses unsupported routes and bundles only eager configuration-free client code', () => {
  expect(() => nativeHookMutationRoute('/api/hook/unrecognized')).toThrow('Unsupported')
  const built = buildSync({ entryPoints: ['src/engines/kit/nativeHookClient.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm', metafile: true, logLevel: 'silent' })
  expect(Object.keys(built.metafile!.inputs).some(path => /(?:config|core|services)\/|\/registry\.ts$/.test(path))).toBe(false)
  expect(built.outputFiles[0].text).not.toMatch(/\bimport\s*\(/)
})
