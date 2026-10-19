import { describe, expect, it, vi } from 'vitest'
import { startAgent } from './start.js'
const where = { port: 14001, machineId: 'lead-machine', dataDir: '/fixture' }
function fixture(options: { refuse?: string; loseCancel?: boolean; loseFailure?: boolean; launchModel?: string[]; refuseModel?: string; frame?: string } = {}) {
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
  const request = vi.fn(async (type: string, payload: Record<string, unknown> = {}, _ms?: number): Promise<Record<string, unknown>> => {
    if (type === 'agent_create_status') return { creationId: start.creationId, state: nativeState, ...(nativeState === 'created' ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high' } } : {}) }
    if (type === 'agents_list' && options.frame) return { agents: [{ id: 'native', engine: 'claude', selectedModel: options.frame }] }
    if (type === 'engines_probe') return { engines: [{ engine: (payload.engines as string[])[0], installed: true }] }
    if (type === 'usage_read') return { providers: [] }
    if (type === 'super_tabs') {
      if (payload.action === 'reserveCapacity') return { ok: true, reservationId: start.creationId }
      if (payload.action === 'observeCapacity') return { ok: true, reservationId: start.creationId, harnessId: 'native', released: nativeState === 'cancelled' }
      return { ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 100, projectDiskFreeBytes: 1000 }, tools: { git: true }, devices: {},
        ...(options.launchModel ? { launchModel: options.launchModel } : {}) }
    }
    if (type === 'agent_create') {
      if (options.refuseModel && payload.model !== undefined) return { error: options.refuseModel, detail: 'This daemon cannot launch with a model.' }
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
const switchCall = (f: { request: { mock: { calls: unknown[][] } } }) => f.request.mock.calls.find(c => c[0] === 'agent_update')
const expectSwitchTo = (f: Parameters<typeof switchCall>[0], selectedModel: string) => {
  const call = switchCall(f)!
  expect(call[1]).toEqual({ agentId: 'native', selectedModel })
  // What is left of the 60 s budget, which a millisecond of delay takes from.
  expect(call[2]).toBeGreaterThan(50_000)
  expect(call[2]).toBeLessThanOrEqual(60_000)
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

it('sends the routing decision at the command level, not inside the machine request', async () => {
  const f = fixture()
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: { ...f.start.request, routeDecisionId: 'd1', overrideReason: 'Needs the Mac.' } }, f.scoped, where, f.open)
  const sent = f.scoped.mock.calls.map(c => c[0].command as Record<string, any>).find(c => c?.type === 'agent.start')!
  expect(sent).toMatchObject({ routeDecisionId: 'd1', overrideReason: 'Needs the Mac.' })
  expect(sent.request).not.toHaveProperty('routeDecisionId')
  expect(sent.request).not.toHaveProperty('overrideReason')
  const plain = fixture()
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: plain.start.request }, plain.scoped, where, plain.open)
  const bare = plain.scoped.mock.calls.map(c => c[0].command as Record<string, any>).find(c => c?.type === 'agent.start')!
  expect(bare).not.toHaveProperty('routeDecisionId')
  expect(bare).not.toHaveProperty('overrideReason')
})

it('applies a routed model and effort to the created agent through the ordinary runtime switch', async () => {
  const f = fixture(), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => type === 'agent_update'
    ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:opus@high' } }
    : request(type, payload))
  // The backend keeps the model and effort in the stored request, which the machine side reads back.
  Object.assign(f.start.request, { model: 'opus', effort: 'high' })
  const input = { action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ ok: true, harnessId: 'native' })
  expectSwitchTo(f, 'runtime-v1:native:claude:opus@high')
})

it('joins the roster before the model switch, so the join prompt can finish', async () => {
  const f = fixture(), order: string[] = [], request = f.request.getMockImplementation()!, scoped = f.scoped.getMockImplementation()!
  f.scoped.mockImplementation(async payload => {
    const type = (payload.command as Record<string, unknown> | undefined)?.type
    if (type === 'agent.started') order.push('agent.started')
    return scoped(payload)
  })
  f.request.mockImplementation(async (type, payload) => {
    if (type !== 'agent_update') return request(type, payload)
    order.push('agent_update')
    return { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:opus@high' } }
  })
  Object.assign(f.start.request, { model: 'opus', effort: 'high' })
  expect(await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).toMatchObject({ ok: true })
  expect(order).toEqual(['agent.started', 'agent_update'])
})

it('makes no model switch when the agent could not join the roster', async () => {
  const f = fixture(); f.loseJoin()
  Object.assign(f.start.request, { model: 'opus', effort: 'high' })
  await expect(startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).rejects.toThrow('Join interrupted')
  expect(f.request.mock.calls.some(c => c[0] === 'agent_update')).toBe(false)
})

it('leaves the engine on its own model for default, or when no model is routed', async () => {
  for (const extra of [{ model: 'default', effort: 'default' }, { model: 'opus' }, {}]) {
    const f = fixture(); Object.assign(f.start.request, extra)
    expect(await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).toMatchObject({ ok: true })
    expect(f.request.mock.calls.some(c => c[0] === 'agent_update')).toBe(false)
  }
})

it.each([{ error: 'INVALID_RUNTIME_PROFILE' }, 'lost'])('still starts the agent and warns when the model switch fails: %j', async failure => {
  const f = fixture(), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => {
    if (type !== 'agent_update') return request(type, payload)
    if (typeof failure === 'string') throw new Error(failure)
    return failure
  })
  Object.assign(f.start.request, { model: 'opus', effort: 'high' })
  const result = await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
  expect(result).toMatchObject({ ok: true, harnessId: 'native' })
  expect(result.modelWarning).toMatch(/Started with the engine's own model; switching to opus high failed/)
})

// agent_create submits the first prompt, so the pane is still working when the switch is first tried.
async function busySwitch(busyFor: number) {
  vi.useFakeTimers()
  try {
    const f = fixture(), request = f.request.getMockImplementation()!
    let tries = 0
    f.request.mockImplementation(async (type, payload) => {
      if (type !== 'agent_update') return request(type, payload)
      return ++tries <= busyFor ? { error: 'BUSY' } : { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:opus@high' } }
    })
    Object.assign(f.start.request, { model: 'opus', effort: 'high' })
    const run = startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
    await vi.advanceTimersByTimeAsync(70_000)
    return { result: await run, tries: () => tries, f }
  } finally { vi.useRealTimers() }
}
it('retries the model switch while the new agent is still busy with its first prompt', async () => {
  const { result, tries } = await busySwitch(3)
  expect(result).toMatchObject({ ok: true, harnessId: 'native' })
  expect(result.modelWarning).toBeUndefined()
  expect(tries()).toBe(4)
})
it('stops at the first error that is not BUSY', async () => {
  const f = fixture(), request = f.request.getMockImplementation()!
  f.request.mockImplementation(async (type, payload) => type === 'agent_update' ? { error: 'INVALID_RUNTIME_PROFILE' } : request(type, payload))
  Object.assign(f.start.request, { model: 'opus', effort: 'high' })
  const result = await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
  expect(f.request.mock.calls.filter(c => c[0] === 'agent_update')).toHaveLength(1)
  expect(result.modelWarning).toMatch(/failed \(INVALID_RUNTIME_PROFILE\)/)
})
it('gives up on the model switch after at most 60 seconds of BUSY and warns', async () => {
  const { result, tries } = await busySwitch(Infinity)
  expect(result).toMatchObject({ ok: true, harnessId: 'native' })
  expect(result.modelWarning).toMatch(/switching to opus high failed \(BUSY\)/)
  expect(tries()).toBeGreaterThan(30)
  expect(tries()).toBeLessThanOrEqual(61)
})
it('bounds the whole model switch by the budget when the daemon hangs on agent_update', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture(), request = f.request.getMockImplementation()!
    const timeouts: number[] = []
    f.request.mockImplementation(async (type, payload, ms) => {
      if (type !== 'agent_update') return request(type, payload)
      timeouts.push(ms as number)
      // The first try is slow and BUSY; the second hangs until its own timeout.
      if (timeouts.length === 1) { await new Promise(resolve => setTimeout(resolve, 30_000)); return { error: 'BUSY' } }
      return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms as number))
    })
    Object.assign(f.start.request, { model: 'opus', effort: 'high' })
    const begun = Date.now()
    let elapsed = -1
    const run = startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
      .then(result => { elapsed = Date.now() - begun; return result })
    await vi.advanceTimersByTimeAsync(130_000)
    const result = await run
    expect(result.modelWarning).toMatch(/switching to opus high failed \(MODEL_UNAVAILABLE\)/)
    expect(timeouts).toEqual([60_000, 29_000])
    expect(elapsed).toBeLessThanOrEqual(60_000)
  } finally { vi.useRealTimers() }
})

it('retries UNSUPPORTED_CLI_VERSION like BUSY: a fresh Claude learns its version only from its first transcript records', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture(), request = f.request.getMockImplementation()!
    let tries = 0
    f.request.mockImplementation(async (type, payload) => {
      if (type !== 'agent_update') return request(type, payload)
      return ++tries <= 2 ? { error: 'UNSUPPORTED_CLI_VERSION' } : { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:opus@high' } }
    })
    Object.assign(f.start.request, { model: 'opus', effort: 'high' })
    const run = startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await run
    expect(result).toMatchObject({ ok: true, harnessId: 'native' })
    expect(result.modelWarning).toBeUndefined()
    expect(tries).toBe(3)
  } finally { vi.useRealTimers() }
})

// The routed switch never succeeds; the agent's frame (agents_list) says what it runs instead.
async function failedSwitch(options: { routeDecisionId?: string; ran?: string | null; send?: 'fails'; listFails?: boolean; error?: string; engine?: string } = {}) {
  vi.useFakeTimers()
  try {
    const f = fixture(), request = f.request.getMockImplementation()!, scoped = f.scoped.getMockImplementation()!
    f.request.mockImplementation(async (type, payload) => {
      if (type === 'agent_update') return { error: options.error ?? 'INVALID_RUNTIME_PROFILE' }
      if (type === 'agents_list') {
        if (options.listFails) throw new Error('timeout')
        return { agents: [{ id: 'other', selectedModel: 'runtime-v1:other:claude:opus@high' },
          { id: 'native', engine: 'claude', selectedModel: options.ran === null ? null : `runtime-v1:native:claude:${options.ran ?? 'sonnet@auto'}` }] }
      }
      return request(type, payload)
    })
    f.scoped.mockImplementation(async payload => {
      if ((payload.command as Record<string, unknown> | undefined)?.type === 'route.modelResult' && options.send === 'fails') throw new Error('backend down')
      return scoped(payload)
    })
    Object.assign(f.start.request, { model: 'haiku', effort: 'auto' })
    if (options.engine) f.start.request.engine = options.engine
    const run = startAgent({ action: 'start', tabId: 'tab', operationId: 'op',
      request: { ...f.start.request, ...(options.routeDecisionId ? { routeDecisionId: options.routeDecisionId } : {}) } }, f.scoped, where, f.open)
    await vi.advanceTimersByTimeAsync(70_000)
    const sent = f.scoped.mock.calls.map(c => c[0]).filter(c => (c.command as Record<string, unknown> | undefined)?.type === 'route.modelResult')
    const updates = f.request.mock.calls.filter(c => c[0] === 'agent_update').length
    return { result: await run, sent, updates }
  } finally { vi.useRealTimers() }
}
it('corrects the decision log to the model the agent runs when the routed switch failed', async () => {
  const { result, sent } = await failedSwitch({ routeDecisionId: 'd1' })
  expect(result).toMatchObject({ ok: true, harnessId: 'native' })
  expect(result.modelWarning).toBe("Started with the engine's own model; switching to haiku auto failed (INVALID_RUNTIME_PROFILE).")
  expect(sent).toEqual([expect.objectContaining({ action: 'command', operationId: 'model-result-start',
    command: { type: 'route.modelResult', decisionId: 'd1', startId: 'start', model: 'sonnet', effort: 'auto' } })])
})
it('sends no correction when the switch worked, or when the start was not routed', async () => {
  const worked = fixture(), request = worked.request.getMockImplementation()!
  worked.request.mockImplementation(async (type, payload) => type === 'agent_update'
    ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:haiku@auto' } } : request(type, payload))
  Object.assign(worked.start.request, { model: 'haiku', effort: 'auto' })
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: { ...worked.start.request, routeDecisionId: 'd1' } }, worked.scoped, where, worked.open)
  expect(worked.scoped.mock.calls.some(c => (c[0].command as Record<string, unknown> | undefined)?.type === 'route.modelResult')).toBe(false)
  expect((await failedSwitch()).sent).toEqual([])
})
it('keeps the start ok and says so when the log could not be corrected', async () => {
  for (const options of [{ send: 'fails' as const }, { listFails: true }, { ran: null }]) {
    const { result, sent } = await failedSwitch({ routeDecisionId: 'd1', ...options })
    expect(result).toMatchObject({ ok: true, harnessId: 'native' })
    expect(result.modelWarning).toBe("Started with the engine's own model; switching to haiku auto failed (INVALID_RUNTIME_PROFILE). The routing decision log could not be corrected to the model that ran.")
    expect(sent).toHaveLength(options.send ? 1 : 0)
  }
})
it('also corrects the log when the switch ran out of its budget on a version the daemon never learned', async () => {
  const { result, sent } = await failedSwitch({ routeDecisionId: 'd1', error: 'UNSUPPORTED_CLI_VERSION' })
  expect(result.modelWarning).toMatch(/failed \(UNSUPPORTED_CLI_VERSION\)\.$/)
  expect(sent).toHaveLength(1)
})
it('stops at the first UNSUPPORTED_CLI_VERSION of an engine other than Claude: waiting does not load its driver', async () => {
  const { result, updates } = await failedSwitch({ error: 'UNSUPPORTED_CLI_VERSION', engine: 'codex' })
  expect(updates).toBe(1)
  expect(result.modelWarning).toMatch(/failed \(UNSUPPORTED_CLI_VERSION\)/)
})
it('drops the warning and the correction when the frame shows the routed model after a failed reply', async () => {
  const { result, sent, updates } = await failedSwitch({ routeDecisionId: 'd1', ran: 'haiku@auto', error: 'MODEL_UNAVAILABLE' })
  expect(updates).toBe(1)
  expect(result).toMatchObject({ ok: true, harnessId: 'native' })
  expect(result).not.toHaveProperty('modelWarning')
  expect(sent).toEqual([])
})

describe('a routed Claude start launches with the model instead of switching it after the start', () => {
  const routed = { model: 'opus', effort: 'high' }
  const begin = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = routed) => {
    Object.assign(f.start.request, extra)
    return startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
  }
  const created = (f: ReturnType<typeof fixture>) => f.request.mock.calls.filter(c => c[0] === 'agent_create').map(c => c[1] as Record<string, unknown>)
  const switched = (f: ReturnType<typeof fixture>) => f.request.mock.calls.some(c => c[0] === 'agent_update')

  it('sends the model and effort in agent_create and types nothing into the pane afterwards', async () => {
    const f = fixture({ launchModel: ['claude'] })
    expect(await begin(f)).toMatchObject({ ok: true, harnessId: 'native' })
    expect(created(f)).toHaveLength(1)
    expect(created(f)[0]).toMatchObject({ engine: 'claude', creationId: 'super-native-receipt', model: 'opus', effort: 'high' })
    expect(switched(f)).toBe(false)
  })

  it('still reports the engine configuration and the join', async () => {
    const f = fixture({ launchModel: ['claude'] })
    await begin(f)
    const commands = f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).filter(Boolean)
    expect(commands.find(c => c.type === 'agent.started')).toMatchObject({ startId: 'start', harnessId: 'native', configuration: { engine: 'claude' } })
  })

  it('sends neither for default and default', async () => {
    const f = fixture({ launchModel: ['claude'] })
    await begin(f, { model: 'default', effort: 'default' })
    expect(created(f)[0]).not.toHaveProperty('model')
    expect(created(f)[0]).not.toHaveProperty('effort')
    expect(switched(f)).toBe(false)
  })

  it.each([{ model: 'opus' }, {}])('sends neither when no complete model is routed: %j', async (extra) => {
    const f = fixture({ launchModel: ['claude'] })
    await begin(f, extra)
    expect(created(f)[0]).not.toHaveProperty('model')
    expect(switched(f)).toBe(false)
  })

  it('keeps the switch for a daemon that does not say it launches with a model', async () => {
    const f = fixture()
    await begin(f)
    expect(created(f)[0]).not.toHaveProperty('model')
    expect(created(f)[0]).not.toHaveProperty('effort')
    expectSwitchTo(f, 'runtime-v1:native:claude:opus@high')
  })

  it('keeps the switch for an engine the daemon does not launch with a model', async () => {
    const f = fixture({ launchModel: ['claude'] })
    await begin(f, { ...routed, engine: 'codex' })
    expect(created(f)[0]).not.toHaveProperty('model')
    expect(switched(f)).toBe(true)
  })

  it('keeps the switch for an agent on a grid model, which chooses its own', async () => {
    const f = fixture({ launchModel: ['claude'] })
    await begin(f, { ...routed, gridModel: 'm', gridName: 'g' })
    expect(created(f)[0]).not.toHaveProperty('model')
    expect(switched(f)).toBe(true)
  })

  it.each(['LAUNCH_MODEL_UNSUPPORTED', 'INVALID_LAUNCH_MODEL'])('creates again without them under the same receipt when the daemon answers %s, then switches', async (refuseModel) => {
    // A daemon older than the launch flags, or one that cannot take this value, refuses before it makes a receipt.
    const f = fixture({ launchModel: ['claude'], refuseModel })
    expect(await begin(f)).toMatchObject({ ok: true, harnessId: 'native' })
    const sent = created(f)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ creationId: 'super-native-receipt' })
    expect(sent[1]).not.toHaveProperty('model')
    expect(sent[1]).not.toHaveProperty('effort')
    expect(f.request.mock.calls.some(c => c[0] === 'agent_create_cancel')).toBe(false)
    expectSwitchTo(f, 'runtime-v1:native:claude:opus@high')
  })

  describe('a start resumed after the create was sent decides from what the agent runs', () => {
    const resume = async (f: ReturnType<typeof fixture>) => {
      f.loseJoin()
      await expect(begin(f)).rejects.toThrow('Join interrupted')
      return startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)
    }

    it('does nothing when the frame shows the routed pair', async () => {
      const f = fixture({ launchModel: ['claude'], frame: 'runtime-v1:native:claude:opus@high' })
      const result = await resume(f)
      expect(result).toMatchObject({ ok: true })
      expect(result).not.toHaveProperty('modelWarning')
      expect(created(f)).toHaveLength(1)
      expect(switched(f)).toBe(false)
    })

    it('does not count default or an automatic effort as a difference', async () => {
      const f = fixture({ launchModel: ['claude'], frame: 'runtime-v1:native:claude:opus@high' })
      const result = await resume(f)
      expect(result).not.toHaveProperty('modelWarning')
      for (const wanted of [{ model: 'default', effort: 'high' }, { model: 'opus', effort: 'auto' }]) {
        const g = fixture({ launchModel: ['claude'], frame: 'runtime-v1:native:claude:opus@high' }); Object.assign(g.start.request, wanted); g.loseJoin()
        await expect(startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: g.start.request }, g.scoped, where, g.open)).rejects.toThrow('Join interrupted')
        expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, g.scoped, where, g.open)).toMatchObject({ ok: true })
        expect(switched(g)).toBe(false)
      }
    })

    it('switches when the frame shows something else, even for a machine that launches with a model', async () => {
      // The create fell back after INVALID_LAUNCH_MODEL (an effort the flag does not take), then the join reply was lost.
      const f = fixture({ launchModel: ['claude'], refuseModel: 'INVALID_LAUNCH_MODEL', frame: 'runtime-v1:native:claude:sonnet@medium' })
      expect(await resume(f)).toMatchObject({ ok: true })
      expect(created(f)).toHaveLength(2)
      expectSwitchTo(f, 'runtime-v1:native:claude:opus@high')
    })

    it('does not type /model when the frame cannot be read, and warns', async () => {
      for (const f of [fixture({ launchModel: ['claude'] }), fixture()]) {
        const result = await resume(f)
        expect(result).toMatchObject({ ok: true, modelWarning: expect.stringContaining('opus high') })
        expect(switched(f)).toBe(false)
      }
    })
  })
})
