import { afterEach, expect, it, vi } from 'vitest'
import { createEngineStorage } from './storage.js'
import { STORAGE_CAPABILITIES, STORAGE_EXPORT, STORAGE_LIFETIME } from '../../engines/worker/storageProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'

const source = { path: '/private-fixture/state.db', key: '2:3', database: '/private-fixture/state.db' }
const lifetime = { pid: 42, nonce: 'a'.repeat(36) }
const stage = { path: '/private-fixture/stage', key: '1:2' }
const receipt = { bytes: 7, sha256: 'b'.repeat(64) }
const session = { engine: 'hermes', agentId: 'fixture', sessionId: 'fixture-session', hermesHome: '/private-fixture', processIdentity: null } as RegisteredSession
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
function setup(attested = true) {
  const events: string[] = []
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>) => {
    if (method === STORAGE_CAPABILITIES) return { version: 1, engine: 'hermes', storage: 1 }
    if (method === STORAGE_LIFETIME) { events.push('lifetime'); return { version: 1, answer: lifetime } }
    if (method === STORAGE_EXPORT) { events.push('export'); return { version: 1, answer: receipt } }
    throw new Error('unexpected request')
  })
  const serviceProcess = vi.fn(async () => { events.push('attest'); return attested })
  const storage = createEngineStorage({ isolated: true, call, serviceProcess }); storage.connected('engine-others')
  const deadline = performance.now() + 30_000
  const settled = vi.fn(async () => { events.push('settled') })
  const lease = { stage, deadline, settled }
  const acquire = vi.fn(async (_pid: number) => { events.push('acquire'); return lease })
  return { storage, events, call, serviceProcess, lease, reserve: { deadline, acquire } }
}

it('attests the writer before acquiring its durable lease and dispatches that same lifetime', async () => {
  const t = setup()
  expect(await t.storage.exportDatabase(session, source, t.reserve)).toEqual(receipt)
  expect(t.events).toEqual(['lifetime', 'attest', 'acquire', 'export', 'settled'])
  expect(t.reserve.acquire).toHaveBeenCalledExactlyOnceWith(lifetime.pid)
  const sent = t.call.mock.calls.find(([, method]) => method === STORAGE_EXPORT)![2]
  expect(sent).toMatchObject({ stage, source, lifetime })
})

it('does not allocate when the master cannot attest the writer', async () => {
  const t = setup(false)
  await expect(t.storage.exportDatabase(session, source, t.reserve)).rejects.toThrow('writer unavailable')
  expect(t.reserve.acquire).not.toHaveBeenCalled()
  expect(t.call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
})

it('does not dispatch while the reservation is still becoming durable', async () => {
  const t = setup(); let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), admitted = new Promise<void>(resolve => { entered = resolve })
  t.reserve.acquire.mockImplementation(async () => { entered(); await held; return t.lease })
  const pending = t.storage.exportDatabase(session, source, t.reserve)
  const observed = pending.then(() => undefined, () => undefined)
  try {
    await Promise.race([admitted, observed])
    expect(t.reserve.acquire).toHaveBeenCalledOnce()
    expect(t.call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
  } finally { release(); await observed }
  expect(await pending).toEqual(receipt)
})

it('does not retry allocation or dispatch after allocation fails', async () => {
  const t = setup(), failure = Object.assign(new Error('slots full'), { code: 'CHECKPOINT_STAGES_BUSY' })
  t.reserve.acquire.mockRejectedValue(failure)
  await expect(t.storage.exportDatabase(session, source, t.reserve)).rejects.toBe(failure)
  expect(t.reserve.acquire).toHaveBeenCalledOnce()
  expect(t.call.mock.calls.filter(([, method]) => method === STORAGE_LIFETIME)).toHaveLength(1)
  expect(t.call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
})
