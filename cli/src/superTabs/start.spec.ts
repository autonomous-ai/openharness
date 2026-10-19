import { expect, it, vi } from 'vitest'
import { startAgent } from './start.js'
const where = { port: 14001, machineId: 'lead-machine', dataDir: '/fixture' }
function fixture(options: { refuse?: string; loseCancel?: boolean; loseFailure?: boolean } = {}) {
  const start = { creationId: 'super-native-receipt', error: null as string | null, request: { machineId: 'target', conversationId: 'group', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }, dispatched: false }
  let nativeState = 'missing', lostJoin = false
  const scoped = vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload.action === 'startStatus') return { ok: true, value: structuredClone(start) }
    const cmd = payload.command as Record<string, unknown>
    if (cmd.type === 'agent.startDispatch') start.dispatched = true
    if (cmd.type === 'agent.startFailed') {
      if (options.loseFailure) { options.loseFailure = false; throw new Error('Failure receipt interrupted') }
      start.error = String(cmd.error)
    }
    if (cmd.type === 'agent.started' && lostJoin) { lostJoin = false; throw new Error('Join interrupted') }
    return { ok: true, value: { result: cmd.type === 'agent.start' ? { startId: 'start' } : { agentId: 'worker' } } }
  })
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    if (type === 'agent_create_status') return { creationId: start.creationId, state: nativeState, ...(nativeState === 'created' ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high' } } : {}) }
    if (type === 'engines_probe') return { engines: [{ engine: 'claude', installed: true }] }
    if (type === 'usage_read') return { providers: [] }
    if (type === 'super_tabs') {
      if (payload.action === 'reserveCapacity') return { ok: true, reservationId: start.creationId }
      if (payload.action === 'observeCapacity') return { ok: true, reservationId: start.creationId, harnessId: 'native', released: nativeState === 'cancelled' }
      return { ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 100, projectDiskFreeBytes: 1000 }, tools: { git: true }, devices: {} }
    }
    if (type === 'agent_create') {
      if (options.refuse) return { error: options.refuse, detail: 'This agent does not support that permission mode.' }
      nativeState = 'created'; return { creationId: start.creationId, state: 'created', agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high' } }
    }
    if (type === 'agent_create_cancel') {
      nativeState = 'cancelled'
      if (options.loseCancel) { options.loseCancel = false; throw new Error('Cancellation reply interrupted') }
      return { creationId: start.creationId, state: nativeState }
    }
    throw new Error(type)
  })
  const close = vi.fn(), open = vi.fn(async () => ({ machineId: 'target', request, close }))
  return { scoped, start, request, open, close, loseJoin: () => { lostJoin = true }, forget: () => { nativeState = 'missing' } }
}
it('uses one native creation receipt and joins its captured group after a lost join reply', async () => {
  const f = fixture(); f.loseJoin()
  const input = { action: 'start', tabId: 'tab', operationId: 'user-intent', request: f.start.request }
  await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Join interrupted')
  expect(f.close).toHaveBeenCalledOnce()
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ ok: true, harnessId: 'native', agentId: 'worker' })
  const launches = f.request.mock.calls.filter(c => c[0] === 'agent_create')
  expect(launches).toHaveLength(1)
  expect(f.open).toHaveBeenCalledWith(where, 'target')
  const commands = f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).filter(Boolean)
  expect(commands.find(c => c.type === 'agent.started')).toMatchObject({ startId: 'start', harnessId: 'native', configuration: { engine: 'claude', model: 'fixture-model', effort: 'high' } })
  expect(commands.some(c => c.type === 'work.assign')).toBe(false)
})
it('does not recreate when a previously dispatched start loses its native receipt', async () => {
  const f = fixture(); f.start.dispatched = true
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN', creationId: 'super-native-receipt' })
  expect(f.request.mock.calls.map(c => c[0])).toEqual(['agent_create_status'])
})
it('withholds native creation when capacity or authority cannot be verified', async () => {
  const f = fixture()
  f.start.request.requirements.diskBytes = 2000
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'CAPACITY_UNAVAILABLE', allowed: false })
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
  f.scoped.mockResolvedValueOnce({ error: 'FORBIDDEN', detail: 'Machine sharing was withdrawn.' })
  await expect(startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).rejects.toThrow('withdrawn')
  expect(f.open).toHaveBeenCalledOnce()
})

it('closes a refused start only after the machine durably fences its creation receipt', async () => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE' })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_FAILED', detail: 'This agent does not support that permission mode.' })
  expect(f.request.mock.calls.map(c => c[0]).filter(type => type.startsWith('agent_create'))).toEqual(['agent_create_status', 'agent_create', 'agent_create_cancel'])
  expect(f.start.error).toContain('before starting an agent')
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_FAILED' })
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.scoped.mock.calls.some(c => (c[0].command as any)?.type === 'agent.started')).toBe(false)
})

it('recovers a lost cancellation reply without dispatching another start', async () => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE', loseCancel: true })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN' })
  expect(f.start.error).toBeNull()
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_FAILED' })
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_create')).toHaveLength(1)
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('retries the exact shared failure command after a lost acknowledgement', async () => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE', loseFailure: true })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Failure receipt interrupted')
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_FAILED' })
  const failures = f.scoped.mock.calls.map(c => c[0]).filter(p => (p.command as any)?.type === 'agent.startFailed')
  expect(failures).toHaveLength(2)
  expect(failures[0]).toEqual(failures[1])
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_create')).toHaveLength(1)
})

it.each(['CREATION_CONFLICT', 'CREATION_STORAGE_FAILED', 'INTERNAL', 'NEW_UNKNOWN_ERROR'])('keeps %s uncertain without cancelling a potentially dispatched intent', async (error) => {
  const f = fixture({ refuse: error })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_REFUSED' })
  expect(f.start.error).toBeNull()
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create_cancel')).toBe(false)
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN' })
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_create')).toHaveLength(1)
})

it.each([
  { creationId: 'different', state: 'cancelled' },
  { error: 'UNSUPPORTED' },
])('requires the exact cancellation receipt: %j', async (answer) => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE' }), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => type === 'agent_create_cancel' ? answer : request(type, payload))
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN' })
  expect(f.start.error).toBeNull()
})

it.each(['pending', 'unconfirmed', 'created'])('preserves native %s evidence when cancellation does not win', async (state) => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE' }), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => type === 'agent_create_cancel'
    ? { creationId: f.start.creationId, state, agent: { id: 'native', engine: 'claude' } }
    : request(type, payload))
  const result = await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)
  expect(result).toMatchObject(state === 'created' ? { ok: true, harnessId: 'native' } : { error: 'START_PENDING', state })
  expect(f.start.error).toBeNull()
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_create')).toHaveLength(1)
})

it.each([
  { error: 'CAPACITY_UNAVAILABLE', detail: 'Memory was reserved by another start.' },
  { error: 'UNSUPPORTED' },
  { ok: true, reservationId: 'different-creation' },
  null,
])('requires an exact durable capacity reservation before claiming/dispatching a start: %j', async answer => {
  const f = fixture(), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => {
    if (type === 'super_tabs' && payload?.action === 'reserveCapacity') {
      if (answer === null) throw new Error('Lost reservation reply')
      return answer
    }
    return request(type, payload)
  })
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toHaveProperty('error')
  expect(f.start.dispatched).toBe(false)
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
  expect(f.close).toHaveBeenCalledOnce()
})

it('retains a created agent when recording its reservation is interrupted, then joins it once', async () => {
  const f = fixture(), request = f.request.getMockImplementation()!
  let interrupted = true
  f.request.mockImplementation(async (type, payload) => {
    if (interrupted && type === 'super_tabs' && payload?.action === 'observeCapacity') {
      interrupted = false; throw new Error('Lost receipt reply')
    }
    return request(type, payload)
  })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_UNCERTAIN' })
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ ok: true, harnessId: 'native' })
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_create')).toHaveLength(1)
  expect(f.scoped.mock.calls.filter(c => (c[0].command as any)?.type === 'agent.started')).toHaveLength(1)
})

it.each([true, false])('reconciles a previously created but unavailable harness only with stop proof (%s)', async released => {
  const f = fixture(), request = f.request.getMockImplementation()!
  f.start.dispatched = true
  f.request.mockImplementation(async (type, payload) => {
    if (type === 'agent_create_status') return { creationId: f.start.creationId, state: 'unavailable', createdAgentId: 'native' }
    if (type === 'super_tabs' && payload?.action === 'observeCapacity') return { ok: true, reservationId: f.start.creationId, harnessId: 'native', released }
    return request(type, payload)
  })
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open))
    .toMatchObject({ error: released ? 'START_FAILED' : 'START_UNCERTAIN' })
  expect(f.start.error === null).toBe(!released)
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
})
