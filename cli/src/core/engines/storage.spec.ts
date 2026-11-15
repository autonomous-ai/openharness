import { afterEach, expect, it, vi } from 'vitest'
import { createEngineStorage } from './storage.js'
import { STORAGE_BACKGROUND, STORAGE_BACKGROUND_WAIT_MS, STORAGE_CAPABILITIES, STORAGE_LIFETIME, STORAGE_EXPORT, STORAGE_EXPORT_WAIT_MS } from '../../engines/worker/storageProtocol.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { EngineReadError } from '../../engines/worker/protocol.js'

const source = { path: '/profile/state.db', key: '2:3', database: '/profile/state.db' }
const lifetime = { pid: 42, nonce: 'a'.repeat(36) }
const ownership = () => ({ deadline: performance.now() + STORAGE_EXPORT_WAIT_MS, writer: vi.fn(async () => {}), settled: vi.fn() })
const session = { engine: 'hermes', agentId: 'a', sessionId: '20261112_100000_bbbbbb', hermesHome: '/profile', processIdentity: null } as const
function setup(answer: unknown = 3) {
  const call = vi.fn(async (_service: string, method: string, _payload: Record<string, unknown>) => method === STORAGE_CAPABILITIES
    ? { version: 1, engine: 'hermes', storage: 1 } : { version: 1, answer: method === STORAGE_LIFETIME ? lifetime : answer })
  const inline = vi.fn(async () => 2)
  const storage = createEngineStorage({ call, isolated: true, inline, serviceProcess: async () => true })
  storage.connected('engine-others')
  return { storage, call, inline }
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each(['ENGINE_UNAVAILABLE', 'ENGINE_STALE_REPLY'] as const)('waits once for a replacement before assigning a checkpoint writer after %s', async code => {
  const receipt = { bytes: 17, sha256: 'b'.repeat(64) }, stage = { path: '/stage', key: '1:2' }, owner = ownership()
  let reconnect!: () => void
  const linked = new Promise<void>(resolve => { reconnect = resolve })
  const ready = vi.fn(() => linked)
  let lifetimes = 0
  const call = vi.fn(async (_service: string, method: string) => {
    if (method === STORAGE_CAPABILITIES) return { version: 1, engine: 'hermes', storage: 1 }
    if (method === STORAGE_LIFETIME && ++lifetimes === 1) throw new EngineReadError(code)
    return { version: 1, answer: method === STORAGE_LIFETIME ? lifetime : receipt }
  })
  const storage = createEngineStorage({ isolated: true, call, ready, serviceProcess: async () => true })
  storage.connected('engine-others')
  const pending = storage.exportDatabase(session as RegisteredSession, stage, owner, source)
  void pending.catch(() => {})
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  expect(owner.writer).not.toHaveBeenCalled()
  expect(call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
  storage.disconnected('engine-others'); storage.connected('engine-others'); reconnect()
  expect(await pending).toEqual(receipt)
  expect(ready).toHaveBeenCalledWith('hermes', expect.any(Number))
  expect(owner.writer).toHaveBeenCalledExactlyOnceWith(lifetime.pid)
  expect(call.mock.calls.filter(([, method]) => method === STORAGE_EXPORT)).toHaveLength(1)
  expect(owner.settled).toHaveBeenCalledOnce()
})

it('keeps reconnect waits inside the original deadline and admission until actual settlement', async () => {
  vi.useFakeTimers()
  let reconnect!: () => void
  const linked = new Promise<void>(resolve => { reconnect = resolve }), ready = vi.fn(() => linked)
  const call = vi.fn(async () => ({ error: 'SERVICE_UNAVAILABLE' }))
  const storage = createEngineStorage({ isolated: true, call, ready, serviceProcess: async () => true })
  const owners = Array.from({ length: 4 }, ownership)
  const pending = owners.map(owner => storage.exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, owner, source).catch(error => error))
  await vi.advanceTimersByTimeAsync(0)
  expect(ready).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(STORAGE_EXPORT_WAIT_MS)
  expect((await Promise.all(pending)).every(error => error.message === 'checkpoint unavailable')).toBe(true)
  await expect(storage.exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, ownership(), source)).rejects.toThrow('busy')
  const before = call.mock.calls.length
  reconnect(); await vi.advanceTimersByTimeAsync(0)
  expect(call).toHaveBeenCalledTimes(before)
  expect(owners.every(owner => owner.writer.mock.calls.length === 0 && owner.settled.mock.calls.length === 0)).toBe(true)
})

it.each(['malformed', 'export', 'repeat'] as const)('never replays %s failure after the one observational recovery', async phase => {
  const ready = vi.fn(async () => {}), owner = ownership()
  const call = vi.fn(async (_service: string, method: string) => {
    if (method === STORAGE_CAPABILITIES) return { version: 1, engine: 'hermes', storage: 1 }
    if (phase === 'malformed') return { version: 1, answer: {} }
    if (phase === 'repeat' || method === STORAGE_EXPORT) throw new EngineReadError('ENGINE_UNAVAILABLE')
    return { version: 1, answer: lifetime }
  })
  const storage = createEngineStorage({ isolated: true, call, ready, serviceProcess: async () => true })
  storage.connected('engine-others')
  await expect(storage.exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, owner, source)).rejects.toThrow()
  expect(ready).toHaveBeenCalledTimes(phase === 'repeat' ? 1 : 0)
  expect(call.mock.calls.filter(([, method]) => method === STORAGE_LIFETIME)).toHaveLength(phase === 'repeat' ? 2 : 1)
  expect(call.mock.calls.filter(([, method]) => method === STORAGE_EXPORT)).toHaveLength(phase === 'export' ? 1 : 0)
  expect(owner.settled).not.toHaveBeenCalled()
})

it('does not wait for a replacement when the failed observation consumed the deadline', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(0), ready = vi.fn(), owner = ownership()
  const call = vi.fn(async (_service: string, method: string) => {
    if (method === STORAGE_CAPABILITIES) return { version: 1, engine: 'hermes', storage: 1 }
    now.mockReturnValue(STORAGE_EXPORT_WAIT_MS)
    throw new EngineReadError('ENGINE_UNAVAILABLE')
  })
  const storage = createEngineStorage({ isolated: true, call, ready })
  storage.connected('engine-others')
  await expect(storage.exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, owner, source)).rejects.toThrow('checkpoint unavailable')
  expect(ready).not.toHaveBeenCalled()
  expect(owner.writer).not.toHaveBeenCalled()
})

it('sends only captured Hermes identity and returns the worker count', async () => {
  const t = setup()
  expect(await t.storage.background(session)).toBe(3)
  expect(t.call).toHaveBeenLastCalledWith('engine-others', STORAGE_BACKGROUND,
    { version: 1, engine: 'hermes', session: { sessionId: session.sessionId, hermesHome: '/profile' } }, expect.any(Number))
  expect(t.inline).not.toHaveBeenCalled()
  expect(await t.storage.background({ ...session, engine: 'codex' })).toBeNull()
  expect(await t.storage.background({ ...session, sessionId: '' })).toBeNull()
})

it('keeps missing, malformed and disconnected answers unknown without falling back', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await setup(null).storage.background(session)).toBeNull()
  for (const answer of [-1, 1.5, 1_025, '3', {}]) expect(await setup(answer).storage.background(session)).toBeNull()
  const t = setup()
  t.storage.disconnected('engine-others')
  t.call.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' } as never)
  expect(await t.storage.background(session)).toBeNull()
  expect(t.inline).not.toHaveBeenCalled()
  expect(log.mock.calls.every(([line]) => line === '[engine-others] STORAGE_BACKGROUND_UNAVAILABLE')).toBe(true)
})

it('bounds a frozen worker and an explicit inline reader', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const t = setup()
  t.call.mockImplementation(() => new Promise(() => {}))
  const remote = t.storage.background(session)
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await remote).toBeNull()
  const inline = createEngineStorage({ call: t.call, isolated: false, inline: () => new Promise(() => {}) })
  const local = inline.background(session)
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await local).toBeNull()
})

it('uses only explicit compatibility composition, including an absent reader', async () => {
  const call = vi.fn()
  expect(await createEngineStorage({ call, isolated: false, inline: async () => 2 }).background(session)).toBe(2)
  expect(await createEngineStorage({ call, isolated: false }).background(session)).toBeNull()
  expect(call).not.toHaveBeenCalled()
})

it('exports a captured database into the exact stage and fences a replaced connection', async () => {
  const receipt = { bytes: 17, sha256: 'a'.repeat(64) }, stage = { path: '/stage', key: '1:2' }
  const t = setup(receipt)
  expect(await t.storage.exportDatabase(session as RegisteredSession, stage, ownership(), source)).toEqual(receipt)
  expect(t.call).toHaveBeenLastCalledWith('engine-others', STORAGE_EXPORT, { version: 1, engine: 'hermes', stage, source, lifetime,
    session: { sessionId: session.sessionId, hermesHome: '/profile', openclawStateDir: undefined, pid: 0 } }, expect.any(Number))
  await expect(t.storage.exportDatabase({ ...session, engine: 'claude' } as RegisteredSession, stage, ownership(), source)).rejects.toThrow('unsupported')
  await expect(t.storage.exportDatabase({ ...session, sessionId: '' } as RegisteredSession, stage, ownership(), source)).rejects.toThrow('unsupported')
  let finish!: (answer: Record<string, unknown>) => void
  t.call.mockImplementation(() => new Promise(resolve => { finish = resolve as never }))
  const late = t.storage.exportDatabase(session as RegisteredSession, stage, ownership(), source)
  t.storage.disconnected('engine-others')
  finish({ version: 1, answer: lifetime })
  await expect(late).rejects.toThrow('STALE')
})

it('bounds compatibility exports and revokes their late writers without fallback', async () => {
  vi.useFakeTimers()
  const receipt = { bytes: 17, sha256: 'a'.repeat(64) }, stage = { path: '/stage', key: '1:2' }, call = vi.fn()
  const saved = { ...session, processIdentity: { pid: 42 } } as RegisteredSession
  const available = createEngineStorage({ call, isolated: false, inlineExport: async (_engine, snapshot, _stage, selected, current) => {
    expect(selected).toEqual(source); expect(snapshot.pid).toBe(42); expect(current()).toBe(true); return receipt
  } })
  expect(await available.exportDatabase(saved, stage, ownership(), source)).toEqual(receipt)
  await expect(createEngineStorage({ call, isolated: false }).exportDatabase(saved, stage, ownership(), source)).rejects.toThrow('unavailable')
  let allowed!: () => boolean
  const frozen = createEngineStorage({ call, isolated: false, inlineExport: (_engine, _snapshot, _stage, selected, current) => {
    allowed = current; return new Promise(() => {})
  } })
  const late = expect(frozen.exportDatabase(saved, stage, ownership(), source)).rejects.toThrow('unavailable')
  await vi.advanceTimersByTimeAsync(STORAGE_EXPORT_WAIT_MS)
  await late
  expect(allowed()).toBe(false)
  expect(call).not.toHaveBeenCalled()
})

it('never assigns a stage to a worker without independent master evidence', async () => {
  const stage = { path: '/stage', key: '1:2' }, t = setup(), owner = ownership()
  for (const serviceProcess of [undefined, async () => false]) {
    const storage = createEngineStorage({ call: t.call, isolated: true, serviceProcess })
    storage.connected('engine-others')
    await expect(storage.exportDatabase(session as RegisteredSession, stage, owner, source)).rejects.toThrow('writer unavailable')
  }
  expect(owner.writer).not.toHaveBeenCalled()
  expect(t.call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
})

it('a deadline during attestation or durable assignment cannot dispatch or settle a late writer', async () => {
  vi.useFakeTimers()
  for (const phase of ['attestation', 'assignment'] as const) {
    const t = setup(), owner = ownership(), stage = { path: '/stage', key: '1:2' }
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const storage = createEngineStorage({ call: t.call, isolated: true, serviceProcess: async () => {
      if (phase === 'attestation') await held
      return true
    } })
    if (phase === 'assignment') owner.writer.mockImplementation(() => held)
    storage.connected('engine-others')
    const answer = expect(storage.exportDatabase(session as RegisteredSession, stage, owner, source)).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(STORAGE_EXPORT_WAIT_MS)
    await answer; release(); await vi.advanceTimersByTimeAsync(0)
    expect(t.call.mock.calls.some(([, method]) => method === STORAGE_EXPORT)).toBe(false)
    expect(owner.settled).not.toHaveBeenCalled()
  }
})

it('refuses dispatch when synchronous work consumed the deadline before its timer ran', async () => {
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(STORAGE_EXPORT_WAIT_MS)
  const owner = ownership(), inlineExport = vi.fn()
  await expect(createEngineStorage({ isolated: false, call: vi.fn(), inlineExport })
    .exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, owner, source)).rejects.toThrow('unavailable')
  expect(owner.writer).not.toHaveBeenCalled(); expect(inlineExport).not.toHaveBeenCalled(); now.mockRestore()
})

it('keeps one aggregate inline admission until timed-out underlying reads actually settle', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {})
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const storage = createEngineStorage({ isolated: false, call: vi.fn(), inline: async () => { await held; return 0 } })
  const pending = Array.from({ length: 4 }, () => storage.background(session))
  await vi.advanceTimersByTimeAsync(STORAGE_BACKGROUND_WAIT_MS)
  expect(await Promise.all(pending)).toEqual([null, null, null, null])
  await expect(storage.exportDatabase(session as RegisteredSession, { path: '/stage', key: '1:2' }, ownership(), source)).rejects.toThrow('busy')
  release(); await vi.advanceTimersByTimeAsync(0)
  expect(await storage.background(session)).toBe(0)
})
