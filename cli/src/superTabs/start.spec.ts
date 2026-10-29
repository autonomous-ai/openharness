import { describe, expect, it, vi } from 'vitest'
import { inspectCapacity, startAgent } from './start.js'
import { buildEngineCommandArgv } from '../lib/engineLaunch.js'
const where = { port: 14001, machineId: 'lead-machine', dataDir: '/fixture' }
/** A queued start is watched before the Lead moves on (startAgent); these tests read the queued answer at once. */
const noPause = async () => {}
function fixture(options: { state?: Record<string, unknown> | Error; githubApp?: boolean; refuse?: string; loseCancel?: boolean; loseFailure?: boolean; launchModel?: string[]; acceptedLaunchModel?: { model: string | null; effort: string | null }; refuseModel?: string; frame?: string; guest?: boolean; identity?: { sessionId: string; createdAt: string } } = {}) {
  const start = { creationId: 'super-native-receipt', error: null as string | null, request: { machineId: 'target', conversationId: 'group', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
    requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: [], quotaRequired: false } }, dispatched: false }
  let nativeState = 'missing', lostJoin = false
  const scoped = vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (payload.action === 'startStatus') return { ok: true, value: structuredClone(start) }
    if (payload.action === 'status') {
      if (options.state instanceof Error) throw options.state
      return { ok: true, value: { revision: 1, state: options.state ?? { conversations: [{ id: 'group' }] }, ...(options.githubApp ? { githubApp: true } : {}) } }
    }
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
    if (type === 'agent_create_status') return { creationId: start.creationId, state: nativeState, ...(nativeState === 'created' ? { agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high', ...options.identity }, ...(options.acceptedLaunchModel ? { launchModel: options.acceptedLaunchModel } : {}) } : {}) }
    if (type === 'agents_list' && options.frame) return { agents: [{ id: 'native', engine: 'claude', selectedModel: options.frame }] }
    if (type === 'engines_probe') return { engines: [{ engine: (payload.engines as string[])[0], installed: true }] }
    if (type === 'usage_read') return { providers: [] }
    if (type === 'super_tabs') {
      if (options.guest) return { error: 'GUEST_NOT_ALLOWED' }
      if (payload.action === 'reserveCapacity') return { ok: true, reservationId: start.creationId }
      if (payload.action === 'observeCapacity') return { ok: true, reservationId: start.creationId, harnessId: 'native', released: nativeState === 'cancelled' }
      return { ok: true, resources: { cpuPercent: 20, memoryTotalBytes: 1000, memoryUsedBytes: 100, projectDiskFreeBytes: 1000 }, tools: { git: true }, devices: {},
        ...(options.launchModel ? { launchModel: options.launchModel } : {}) }
    }
    if (type === 'agent_create') {
      if (options.refuseModel && payload.model !== undefined) return { error: options.refuseModel, detail: 'This daemon cannot launch with a model.' }
      if (options.refuse) return { error: options.refuse, detail: 'This agent does not support that permission mode.' }
      nativeState = 'created'; return { creationId: start.creationId, state: 'created', agent: { id: 'native', engine: 'claude', selectedModel: 'runtime-v1:native:claude:fixture-model@high', ...options.identity } }
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

describe('Swarm permission mode', () => {
  it('admits installed Claude when an API environment is opaque to the vendor login probe', async () => {
    const f = fixture(), request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (type, payload, ms) => type === 'engines_probe'
      ? { engines: [{ engine: 'claude', installed: true, signedIn: false }] }
      : request(type, payload, ms))
    expect(await inspectCapacity(await f.open() as never, f.start.request)).toMatchObject({ allowed: true, engine: { installed: true, signedIn: false } })
  })
  it.each(['claude', 'codex'] as const)('starts %s in full mode on direct and contributed hosts', async engine => {
    for (const hostDispatch of [false, true]) {
      const f = fixture()
      Object.assign(f.start.request, { engine, permissionMode: 'ask' })
      if (hostDispatch) Object.assign(f.start, { poolGeneration: 'pool' })
      const result = await startAgent({ action: 'resume', tabId: 'tab', startId: 'start', hostDispatch }, f.scoped, where, f.open)
      expect(result).toMatchObject({ ok: true })
      const payload = f.request.mock.calls.find(c => c[0] === 'agent_create')![1]!
      expect(payload).toMatchObject({ permissionMode: 'full', bypassPermission: true, swarmRole: 'dev' })
      const argv = buildEngineCommandArgv(engine, { permissionMode: String(payload.permissionMode) })
      expect(argv).toContain(engine === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox')
    }
  })

  it.each(['opencode', 'kilo'])('fails a pending legacy %s Swarm start before native creation', async engine => {
    const f = fixture()
    Object.assign(f.start.request, { engine })
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ error: 'SWARM_ENGINE' })
    expect(f.start.error).toContain('Claude Code or Codex')
    expect(f.open).not.toHaveBeenCalled()
  })

  it.each(['opencode', 'kilo'])('keeps a dispatched legacy %s start uncertain without marking it failed', async engine => {
    const f = fixture()
    Object.assign(f.start.request, { engine })
    f.start.dispatched = true
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open))
      .toMatchObject({ error: 'START_UNCERTAIN', creationId: f.start.creationId })
    expect(f.start.error).toBeNull()
    expect(f.scoped.mock.calls.some(c => (c[0].command as any)?.type === 'agent.startFailed')).toBe(false)
    expect(f.request.mock.calls.map(c => c[0])).toEqual(['agent_create_status'])
  })

  it('reconciles an already-created legacy OpenCode agent instead of orphaning it', async () => {
    const f = fixture(), request = f.request.getMockImplementation()!
    Object.assign(f.start.request, { engine: 'opencode' })
    f.start.dispatched = true
    f.request.mockImplementation(async (type, payload, ms) => type === 'agent_create_status'
      ? { creationId: f.start.creationId, state: 'created', agent: { id: 'native', engine: 'opencode' } }
      : request(type, payload, ms))
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open))
      .toMatchObject({ ok: true, harnessId: 'native' })
    expect(f.start.error).toBeNull()
    const commands = f.scoped.mock.calls.map(c => c[0].command as Record<string, any> | undefined)
    expect(commands.find(c => c?.type === 'agent.started')).toMatchObject({ configuration: { engine: 'opencode' } })
    expect(commands.some(c => c?.type === 'agent.startFailed')).toBe(false)
    expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
  })

  it('recovers the same legacy start after its accepted reply is lost', async () => {
    const f = fixture(), scoped = f.scoped.getMockImplementation()!
    Object.assign(f.start, { poolGeneration: 'pool' })
    let recorded: string | undefined, accepted = 0
    f.scoped.mockImplementation(async payload => {
      const command = payload.command as Record<string, any> | undefined
      if (command?.type !== 'agent.start') return scoped(payload)
      const hash = JSON.stringify(command)
      if (recorded) return recorded === hash ? scoped(payload) : { error: 'OPERATION_REUSED', detail: 'Use a new operation ID for a different request.' }
      if (command.request.permissionMode) return { error: 'OUTSIDE_CONTRIBUTION', detail: 'Refused: permissionMode (it runs with its own default account settings, so leave it out).' }
      recorded = hash; accepted++
      throw new Error('Accepted reply lost')
    })
    const input = { action: 'start', tabId: 'tab', operationId: 'same-op', request: f.start.request }
    await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Accepted reply lost')
    expect(await startAgent(input, f.scoped, where, f.open, noPause)).toMatchObject({ ok: true, queued: true, startId: 'start' })
    expect(accepted).toBe(1)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('tells the Lead a contributed start is still being prepared on its machine, so it waits rather than starting another', async () => {
    const f = fixture()
    Object.assign(f.start, { poolGeneration: 'pool', dispatched: true, preparing: true })
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toEqual({ ok: true, queued: true,
      preparing: true, startId: 'start', machineId: f.start.request.machineId,
      detail: 'Its machine is still preparing it (fetching the project, checking its worktree out); that can take up to 15 minutes. Resume this start ID to read its receipt; do not start another.' })
    // One its machine has not said it is preparing (an older machine, or not launched yet) reads as queued, as before.
    delete (f.start as { preparing?: boolean }).preparing
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toEqual({ ok: true, queued: true,
      startId: 'start', machineId: f.start.request.machineId, detail: 'Queued on the contributed machine. Resume this start ID to read its receipt.' })
    expect(f.open).not.toHaveBeenCalled()
  })

  it('asks the backend for full mode even when the caller asks for another mode', async () => {
    const f = fixture()
    await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: { ...f.start.request, permissionMode: 'ask' } }, f.scoped, where, f.open)
    const command = f.scoped.mock.calls[0]![0].command as Record<string, any>
    expect(command.request.permissionMode).toBe('full')
  })

  it.each([false, true])('recovers an older CLI start without warning that the backend is old (settled=%s)', async settled => {
    const f = fixture()
    Object.assign(f.start, { poolGeneration: 'pool', ...(settled ? { harnessId: 'existing', poolSettled: true } : {}) })
    f.scoped.mockResolvedValueOnce({ error: 'OPERATION_REUSED', detail: 'Use a new operation ID for a different request.' })
    const result = await startAgent({ action: 'start', tabId: 'tab', operationId: 'same-op', request: f.start.request }, f.scoped, where, f.open, noPause)
    expect(result).toMatchObject({ ok: true, ...(settled ? { harnessId: 'existing' } : { queued: true }) })
    expect(result).not.toHaveProperty('permissionWarning')
    const attempts = f.scoped.mock.calls.map(c => c[0]).filter(c => (c.command as any)?.type === 'agent.start')
    expect(attempts).toHaveLength(2)
    expect(attempts.map(a => a.operationId)).toEqual(['same-op', 'same-op'])
    expect(f.open).not.toHaveBeenCalled()
  })

  it.each([false, true])('retries an older backend permission refusal once and warns (settled=%s)', async settled => {
    const f = fixture(), scoped = f.scoped.getMockImplementation()!
    Object.assign(f.start, { poolGeneration: 'pool', ...(settled ? { harnessId: 'existing', poolSettled: true } : {}) })
    f.scoped.mockImplementation(async payload => {
      const command = payload.command as Record<string, any> | undefined
      if (command?.type === 'agent.start' && command.request.permissionMode) return {
        error: 'OUTSIDE_CONTRIBUTION', detail: 'Studio Mac accepts only its contributed project folder, engines and default account settings. Refused: permissionMode (it runs with its own default account settings, so leave it out).',
      }
      return scoped(payload)
    })
    const result = await startAgent({ action: 'start', tabId: 'tab', operationId: 'same-op', request: f.start.request }, f.scoped, where, f.open, noPause)
    expect(result).toMatchObject({ ok: true, ...(settled ? { harnessId: 'existing' } : { queued: true }), permissionWarning: expect.stringContaining("machine's default") })
    const attempts = f.scoped.mock.calls.map(c => c[0]).filter(c => (c.command as any)?.type === 'agent.start')
    expect(attempts).toHaveLength(2)
    expect(attempts.map(a => a.operationId)).toEqual(['same-op', 'same-op'])
    expect((attempts[0]!.command as any).request.permissionMode).toBe('full')
    expect((attempts[1]!.command as any).request).not.toHaveProperty('permissionMode')
    expect(f.open).not.toHaveBeenCalled()
  })

  it('does not retry an uncertain backend reply', async () => {
    const f = fixture(); f.scoped.mockRejectedValue(new Error('Reply lost'))
    await expect(startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).rejects.toThrow('Reply lost')
    expect(f.scoped).toHaveBeenCalledOnce()
    expect(f.open).not.toHaveBeenCalled()
  })

  it('ends after the single legacy retry fails', async () => {
    const f = fixture()
    f.scoped.mockResolvedValueOnce({ error: 'OUTSIDE_CONTRIBUTION', detail: 'Refused: permissionMode (it runs with its own default account settings, so leave it out).' })
      .mockResolvedValueOnce({ error: 'MACHINE_OFFLINE', detail: 'Wait for the machine.' })
    await expect(startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).rejects.toThrow('Wait for the machine.')
    expect(f.scoped).toHaveBeenCalledTimes(2)
    expect(f.open).not.toHaveBeenCalled()
  })

  it('reads an existing native receipt without updating its permission mode', async () => {
    const f = fixture(), request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (type, payload) => type === 'agent_create_status'
      ? { creationId: f.start.creationId, state: 'created', agent: { id: 'native', engine: 'claude', permissionMode: 'ask' } }
      : request(type, payload))
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ ok: true })
    expect(f.request.mock.calls.some(c => c[0] === 'agent_create' || c[0] === 'agent_update')).toBe(false)
  })

  it.each([
    { error: 'OUTSIDE_CONTRIBUTION', detail: 'Refused: codexHome, permissionMode (leave them out).' },
    { error: 'OUTSIDE_CONTRIBUTION', detail: 'Refused: cwd (wrong folder); permissionMode (leave it out).' },
    { error: 'FORBIDDEN', detail: 'permissionMode is forbidden' },
  ])('does not retry an unrelated refusal: $detail', async refusal => {
    const f = fixture(); f.scoped.mockResolvedValue(refusal)
    await expect(startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)).rejects.toThrow(refusal.detail)
    expect(f.scoped).toHaveBeenCalledOnce()
    expect(f.open).not.toHaveBeenCalled()
  })
})
const expectSwitchTo = (f: Parameters<typeof switchCall>[0], selectedModel: string) => {
  const call = switchCall(f)!
  expect(call[1]).toEqual({ agentId: 'native', selectedModel })
  // What is left of the 60 s budget, which a millisecond of delay takes from.
  expect(call[2]).toBeGreaterThan(50_000)
  expect(call[2]).toBeLessThanOrEqual(60_000)
}
it.each(['claude', 'codex'])('tells supported %s workers to use their built-in skill', async engine => {
  const f = fixture()
  f.start.request.engine = engine
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'role-prompt', request: f.start.request }, f.scoped, where, f.open)
  const payload = f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
  expect(payload.prompt).toContain('swarm-dev')
  expect(payload.swarmRole).toBe('dev')
})

it.each(['claude', 'codex'])('starts a %s Reviewer with the built-in swarm-review skill', async engine => {
  const f = fixture()
  f.start.request = { ...f.start.request, engine, role: 'reviewer' } as typeof f.start.request
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'reviewer-prompt', request: f.start.request }, f.scoped, where, f.open)
  const payload = f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
  expect(payload.swarmRole).toBe('review')
  expect(payload.prompt).toContain('swarm-review skill')
  expect(payload.prompt).not.toContain('swarm-dev')
})

it.each(['claude', 'codex'])('starts a %s Buddy with the built-in swarm-buddy skill, talking in its owner\'s chat and waiting for no assignment', async engine => {
  const f = fixture()
  f.start.request = { ...f.start.request, engine, buddyOf: { personId: 'peer', generation: 'g' } } as typeof f.start.request
  await startAgent({ action: 'start', tabId: 'tab', operationId: 'buddy-prompt', request: f.start.request }, f.scoped, where, f.open)
  const payload = f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
  expect(payload.swarmRole).toBe('buddy')
  expect(payload.prompt).toContain('Use the built-in swarm-buddy skill for this session.')
  expect(payload.prompt).toContain(`harness super-tab --tab tab messages ${f.start.request.conversationId}`)
  expect(payload.prompt).not.toContain('assign')
  expect(payload.prompt).not.toContain('swarm-dev')
})

it('starts a Claude Buddy in asking mode, never with full permissions, and no Buddy with the GitHub App\'s token', async () => {
  for (const [engine, mode, bypass] of [['claude', 'ask', false], ['codex', 'full', true]] as const) {
    const f = fixture()
    f.start.request = { ...f.start.request, engine, buddyOf: { personId: 'peer', generation: 'g' } } as typeof f.start.request
    await startAgent({ action: 'start', tabId: 'tab', operationId: `buddy-${engine}`, request: f.start.request, hostDispatch: true, github: { requester: 'peer' } } as never,
      f.scoped, where, f.open)
    const payload = f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
    expect([engine, payload.permissionMode, payload.bypassPermission, payload.swarmGitHub]).toEqual([engine, mode, bypass, undefined])
    expect(payload.prompt).not.toContain('GitHub')
  }
})

describe('the skills of the project the agent joins', () => {
  const projects = (skillMode?: string) => ({ conversations: [{ id: 'other', projectId: 'p1' }, { id: 'group', projectId: 'p2' }],
    projects: [{ id: 'p1', skillMode: 'default' }, { id: 'p2', ...(skillMode ? { skillMode } : {}) }] })
  const started = async (state: Record<string, unknown> | Error, role?: string) => {
    const f = fixture({ state })
    if (role) f.start.request = { ...f.start.request, role } as typeof f.start.request
    expect(await startAgent({ action: 'start', tabId: 'tab', operationId: 'mode', request: f.start.request }, f.scoped, where, f.open)).toMatchObject({ ok: true })
    return f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
  }
  it.each([undefined, 'reviewer'])('starts a Default project\'s agent (role %s) with the Default text and a prompt line that fits it', async role => {
    const payload = await started(projects('default'), role), skill = role ? 'review' : 'dev'
    expect(payload).toMatchObject({ swarmRole: skill, swarmSkillMode: 'default' })
    expect(payload.prompt).toContain(`Use the swarm-${skill} skill for this session: the team process; otherwise work your usual way. Run harness`)
    expect(payload.prompt).not.toContain('built-in')
  })
  it('starts a Harness orchestration project\'s agent with the built-in text', async () => {
    const payload = await started(projects('orchestration'))
    expect(payload).toMatchObject({ swarmRole: 'dev', swarmSkillMode: 'orchestration' })
    expect(payload.prompt).toContain('Use the built-in swarm-dev skill for this session. Run harness')
  })
  it.each([
    ['a project from before modes', projects()],
    ['a Swarm from before projects', { conversations: [{ id: 'group' }] }],
    ['a group it cannot see', { conversations: [], projects: [{ id: 'lead', skillMode: 'default' }] }],
    ['a state it cannot read', new Error('offline')],
  ])('reads %s as Harness orchestration', async (_name, state) => {
    expect(await started(state)).toMatchObject({ swarmSkillMode: 'orchestration' })
  })

  // Prod logs 2026-10-28: a contributed machine's host asked for a Swarm read it may not make (a 400 at every start) and
  // launched every agent on Harness orchestration. Its start read names the project's skills instead.
  const hosted = async (skillMode?: string) => {
    const f = fixture({ state: projects('orchestration') })
    Object.assign(f.start, { poolGeneration: 'pool-1', ...(skillMode ? { skillMode } : {}) })
    expect(await startAgent({ tabId: 'tab', startId: 'start', hostDispatch: true }, f.scoped, where, f.open)).toMatchObject({ ok: true })
    expect(f.scoped.mock.calls.map(c => c[0].action)).not.toContain('status')
    return f.request.mock.calls.find(call => call[0] === 'agent_create')![1]!
  }
  it('starts a contributed machine\'s agent with the skills its start read names, without reading the Swarm', async () => {
    const payload = await hosted('default')
    expect(payload).toMatchObject({ swarmRole: 'dev', swarmSkillMode: 'default' })
    expect(payload.prompt).toContain('Use the swarm-dev skill for this session: the team process; otherwise work your usual way.')
  })
  it('starts a contributed machine\'s agent on Harness orchestration when an older backend\'s start read names no skills', async () => {
    expect(await hosted()).toMatchObject({ swarmRole: 'dev', swarmSkillMode: 'orchestration' })
  })
  it('takes the start read\'s skills for a Lead\'s own start too', async () => {
    const f = fixture({ state: projects('orchestration') })
    Object.assign(f.start, { skillMode: 'default' })
    await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)
    expect(f.request.mock.calls.find(call => call[0] === 'agent_create')![1]).toMatchObject({ swarmSkillMode: 'default' })
  })
})

it('asks for an owner contribution instead of widening a guest machine connection', async () => {
  const f = fixture({ guest: true })
  expect(await startAgent({ action: 'start', tabId: 'tab', operationId: 'guest-start', request: f.start.request }, f.scoped, where, f.open))
    .toMatchObject({ error: 'CONTRIBUTION_REQUIRED', detail: expect.stringContaining('Add machine') })
  expect(f.request.mock.calls.some(c => c[0] === 'agent_create')).toBe(false)
  expect(f.close).toHaveBeenCalledOnce()
})

it('uses one native creation receipt and joins its captured group after a lost join reply', async () => {
  const f = fixture(); f.loseJoin()
  const input = { action: 'start', tabId: 'tab', operationId: 'user-intent', request: f.start.request }
  await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Join interrupted')
  expect(f.close).toHaveBeenCalledOnce()
  expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ ok: true, harnessId: 'native', agentId: 'worker' })
  const launches = f.request.mock.calls.filter(c => c[0] === 'agent_create')
  expect(launches).toHaveLength(1)
  expect(launches[0][1]).toMatchObject({ swarmRole: 'dev' })
  expect(f.open).toHaveBeenCalledWith(where, 'target')
  const commands = f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).filter(Boolean)
  expect(commands.find(c => c.type === 'agent.started')).toMatchObject({ startId: 'start', harnessId: 'native', configuration: { engine: 'claude', model: 'fixture-model', effort: 'high' } })
  expect(commands.some(c => c.type === 'work.assign')).toBe(false)
})
describe('which branch a worktree starts from', () => {
  const created = async (change: (request: Record<string, unknown>) => void) => {
    const f = fixture(); change(f.start.request)
    await startAgent({ action: 'start', tabId: 'tab', operationId: 'op', request: f.start.request }, f.scoped, where, f.open)
    return f.request.mock.calls.filter(c => c[0] === 'agent_create').map(c => c[1])
  }
  it('is the repository\'s default branch when the start names none', async () => {
    const [payload] = await created(() => {})
    expect(payload).toMatchObject({ projectSource: 'worktree', gitSource: '/repo', branchName: 'super-tab/start', branchBase: 'default' })
    expect(payload).not.toHaveProperty('branchRef')
  })
  it('is the branch the start names, unchanged', async () => {
    const [payload] = await created(request => { request.branchRef = 'refs/remotes/origin/feat/mobile' })
    expect(payload).toMatchObject({ projectSource: 'worktree', branchRef: 'refs/remotes/origin/feat/mobile' })
    expect(payload).not.toHaveProperty('branchBase')
  })
  it('is not asked for when the agent works in the folder itself', async () => {
    const [payload] = await created(request => { request.worktree = false })
    expect(payload).toMatchObject({ cwd: '/repo' })
    expect(payload).not.toHaveProperty('branchBase')
    expect(payload).not.toHaveProperty('projectSource')
  })
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
  // The Lead is told the machine's own reason, so it can start the work elsewhere.
  expect(f.start.error).toBe('This agent does not support that permission mode.')
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

it('fails the start after a lost acknowledgement of its refusal, with only the fenced receipt left to say why', async () => {
  const f = fixture({ refuse: 'INVALID_PERMISSION_MODE', loseFailure: true })
  const input = { action: 'resume', tabId: 'tab', startId: 'start' }
  await expect(startAgent(input, f.scoped, where, f.open)).rejects.toThrow('Failure receipt interrupted')
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ error: 'START_FAILED' })
  const failures = f.scoped.mock.calls.map(c => c[0]).filter(p => (p.command as any)?.type === 'agent.startFailed')
  // Each under its own operation: the refusal is known only to the invocation that saw it.
  expect(failures.map(p => [p.operationId, (p.command as any).error])).toEqual([
    ['refused-start', 'This agent does not support that permission mode.'],
    ['failed-start', 'The machine cancelled this request before starting an agent. Review its settings and create a new start request.']])
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

  // Builders started with opus and effort high read as effort 'auto' (Dee, 2026-10-27): Claude Code does not report an
  // effort it was launched with, so the frame says auto, and the start stored that.
  const launchedAsAuto = (f: ReturnType<typeof fixture>) => {
    const request = f.request.getMockImplementation()!
    f.request.mockImplementation(async (type, payload, ms) => {
      const answer = await request(type, payload, ms)
      const agent = answer.agent as Record<string, unknown> | undefined
      return agent ? { ...answer, agent: { ...agent, selectedModel: 'runtime-v1:native:claude:opus@auto' } } : answer
    })
  }
  const started = (f: ReturnType<typeof fixture>) => f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).find(c => c?.type === 'agent.started')

  it('records the effort it launched with when the engine reads it as auto', async () => {
    const f = fixture({ launchModel: ['claude'] }); launchedAsAuto(f)
    await begin(f)
    expect(started(f)).toMatchObject({ configuration: { engine: 'claude', model: 'opus', effort: 'high' } })
  })

  it('records the effort the machine accepted at launch when a resumed start reads it as auto', async () => {
    const f = fixture({ launchModel: ['claude'], acceptedLaunchModel: { model: 'opus', effort: 'high' } }); launchedAsAuto(f)
    Object.assign(f.start.request, routed)
    await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)
    expect(started(f)).toMatchObject({ configuration: { model: 'opus', effort: 'high' } })
  })

  it('keeps auto when nothing was launched with an effort', async () => {
    const f = fixture({ launchModel: ['claude'] }); launchedAsAuto(f)
    await begin(f, { model: 'default', effort: 'default' })
    expect(started(f)).toMatchObject({ configuration: { model: 'opus', effort: 'auto' } })
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

    it('does not type an effort command when the accepted launch flag precedes runtime effort detection', async () => {
      const f = fixture({ launchModel: ['claude'], acceptedLaunchModel: { model: 'opus', effort: 'high' }, frame: 'runtime-v1:native:claude:opus@auto' })
      expect(await resume(f)).toMatchObject({ ok: true })
      expect(created(f)).toHaveLength(1)
      expect(switched(f)).toBe(false)
    })

    it('still switches when runtime settles on a concrete effort different from the launch flag', async () => {
      const f = fixture({ launchModel: ['claude'], acceptedLaunchModel: { model: 'opus', effort: 'high' }, frame: 'runtime-v1:native:claude:opus@low' })
      expect(await resume(f)).toMatchObject({ ok: true })
      expectSwitchTo(f, 'runtime-v1:native:claude:opus@high')
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


it('records the original launch identity and retries without it only for an older backend', async () => {
  const identity = { sessionId: 'original-session', createdAt: '2026-10-22T00:00:00.000Z' }
  const f = fixture({ identity })
  const input = { action: 'start', tabId: 'tab', operationId: 'identity-start', request: f.start.request }
  expect(await startAgent(input, f.scoped, where, f.open)).toMatchObject({ ok: true })
  const joined = f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).find(c => c?.type === 'agent.started')!
  expect(joined).toMatchObject({ startedSession: identity })
  const old = fixture({ identity })
  const scoped = async (payload: Record<string, unknown>) => {
    const command = payload.command as Record<string, unknown> | undefined
    return command?.startedSession ? { error: 'VALIDATION_ERROR' } : old.scoped(payload)
  }
  expect(await startAgent({ ...input, request: old.start.request }, scoped, where, old.open)).toMatchObject({ ok: true })
  expect(old.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).find(c => c?.type === 'agent.started')).not.toHaveProperty('startedSession')
})

it('waits for the initial engine binding before recording a timed launch identity', async () => {
  const f = fixture({ identity: { sessionId: '', createdAt: '2026-10-22T00:00:00.000Z' } })
  expect(await startAgent({ action: 'start', tabId: 'tab', operationId: 'binding-start', request: f.start.request }, f.scoped, where, f.open)).toMatchObject({ error: 'START_PENDING' })
  expect(f.scoped.mock.calls.map(c => c[0].command as Record<string, unknown>).some(c => c?.type === 'agent.started')).toBe(false)
})

describe('Swarm starts for another person\'s project', () => {
  const state = { ownerId: 'owner-1', people: [{ id: 'owner-1', email: 'owner@example.com' }, { id: 'host-1', email: 'host@example.com' }],
    projects: [{ id: 'lead', ownerId: 'host-1' }, { id: 'p1', ownerId: 'owner-1', skillMode: 'default' }], conversations: [{ id: 'group', projectId: 'p1' }] }
  const started = async (options: Parameters<typeof fixture>[0], machineOwnerId = 'host-1') => {
    const f = fixture(options)
    Object.assign(f.start, { machineOwnerId })
    expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start' }, f.scoped, where, f.open)).toMatchObject({ ok: true })
    return f.request.mock.calls.find(c => c[0] === 'agent_create')![1]!
  }

  it('wires the Harness GitHub App and says whom the work is for when the project\'s owner is not the machine\'s', async () => {
    const payload = await started({ state, githubApp: true })
    expect(payload).toMatchObject({ swarmRole: 'dev', swarmSkillMode: 'default', swarmGitHub: true })
    expect(String(payload.prompt)).toMatch(/not this computer's own GitHub login\. Start each pull request body with: Requested by owner@example\.com through Harness\.$/)
  })

  it('reads a Swarm from before projects as its owner\'s', async () => {
    const legacy = { ownerId: 'owner-1', people: state.people, conversations: [{ id: 'group' }] }
    expect(await started({ state: legacy, githubApp: true })).toMatchObject({ swarmGitHub: true })
  })

  it('on a contributed machine, goes by what its host readied: the app for whom it named, nothing when it named no one', async () => {
    const hosted = async (github: unknown) => {
      const f = fixture({ state, githubApp: true })
      Object.assign(f.start, { machineOwnerId: 'host-1' })
      expect(await startAgent({ action: 'resume', tabId: 'tab', startId: 'start', hostDispatch: true, ...(github === undefined ? {} : { github }) }, f.scoped, where, f.open)).toMatchObject({ ok: true })
      return f.request.mock.calls.find(c => c[0] === 'agent_create')![1]!
    }
    const payload = await hosted({ requester: 'olive@example.com' })
    expect(payload).toMatchObject({ swarmRole: 'dev', swarmGitHub: true })
    expect(String(payload.prompt)).toContain('Requested by olive@example.com through Harness.')
    for (const github of [undefined, null, {}, { requester: '' }]) expect(await hosted(github)).not.toHaveProperty('swarmGitHub')
  })

  it('launches as before for the machine owner\'s own project, on a server without the app, or when the Swarm cannot be read', async () => {
    for (const [options, owner] of [[{ state, githubApp: true }, 'owner-1'], [{ state }, 'host-1'], [{ state: new Error('offline'), githubApp: true }, 'host-1'],
      [{ state: { ...state, conversations: [{ id: 'other' }] }, githubApp: true }, 'host-1'], [{ state: { ...state, people: [] }, githubApp: true }, 'host-1']] as const) {
      const payload = await started(options, owner)
      expect(payload).not.toHaveProperty('swarmGitHub')
      expect(String(payload.prompt)).not.toContain('GitHub App')
    }
  })
})

describe('a Lead\'s start that fails before its agent exists', () => {
  const requirements = { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: ['git'], devices: ['round'], quotaRequired: false }
  const candidate = (id: string, machineId: string, kind = 'new') => ({ id, kind, ...(kind === 'member' ? { agentId: `agent-${machineId}` } : {}), machineId,
    engine: 'claude', model: 'opus', effort: 'high', quality: 3, cost: 10, title: `Builder · Claude opus high · ${machineId}`, label: machineId })
  const decision = (candidates: ReturnType<typeof candidate>[], override: unknown = null) => ({ id: 'decision-1', conversationId: 'group', outcome: 'failed', final: null, override,
    record: { assessment: { difficulty: 'medium', risk: 'low', why: 'Queued Lead routing.', size: 'medium' }, candidates, excluded: [],
      floor: 2, notes: false, pick: candidates[0]!.id, via: 'order', p: null, belowFloor: false, why: 'Policy order.' } })
  const swarm = (rules: unknown[] = [], requires?: unknown) => ({
    conversations: [{ id: 'group', projectId: 'project', leadId: 'lead', requesterId: 'person-1', ...(requires ? { task: { goal: 'Check the round.', requires } } : {}) }],
    projects: [{ id: 'project', ownerId: 'owner-1', repository: { machineId: 'repo-mac', cwd: '/repo' } }],
    machines: [{ machineId: 'mac-one', name: 'Mac One', scope: 'swarm', cwd: '/one/swarm' }, { machineId: 'mac-two', name: 'Mac Two', scope: 'swarm', cwd: '/two/swarm/' }],
    rules,
  })
  const TOKEN = 'The Harness GitHub App token is not in the form GitHub gives.'
  /** A backend with contributed machines whose hosts fail a start in preparation, as the round-device group saw. */
  function backend(options: { candidates?: ReturnType<typeof candidate>[]; rules?: unknown[]; fails?: string[]; override?: unknown
    /** The group's task requirement, as the Lead reads it (backend model.ts TaskRequirement). */
    requires?: unknown
    /** What happens to the retry's start: the backend refuses it, or its reply is lost after or before the backend recorded it. */
    retry?: 'refused' | 'lost' | 'lostUnrecorded'
    /** Machines off the contributed list: the Lead's own start launches there, and this one refuses for its owner's sharing. */
    direct?: string[]
    /** Why a failing machine's host fails the start; the app token problem unless set. */
    error?: string } = {}) {
    const starts = new Map<string, Record<string, unknown>>()
    const fails = new Set(options.fails ?? ['mac-one'])
    const commands: Record<string, unknown>[] = []
    const scoped = vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (payload.action === 'startStatus') {
        const start = starts.get(String(payload.startId))
        if (!start) return { error: 'NOT_FOUND', detail: 'This agent start is unavailable.' }
        // The host readies a queued start on its next pass: a machine whose app token cannot be had fails it there.
        const request = start.request as Record<string, unknown>
        if (start.read && fails.has(String(request.machineId))) start.error = options.error ?? TOKEN
        start.read = true
        return { ok: true, value: structuredClone(start) }
      }
      if (payload.action === 'routeDecision') return { ok: true, value: decision(options.candidates ?? [candidate('c0', 'mac-one'), candidate('c1', 'mac-one', 'member'), candidate('c2', 'mac-two')], options.override) }
      if (payload.action === 'status') return { ok: true, value: { state: swarm(options.rules, options.requires) } }
      const cmd = payload.command as Record<string, unknown>
      commands.push({ operationId: payload.operationId, ...cmd })
      if (cmd.type === 'agent.start') {
        const retry = payload.operationId !== 'first-start' ? options.retry : undefined
        if (retry === 'refused') return { error: 'MACHINE_NOT_LISTED', detail: 'Add this machine to the Swarm first.' }
        if (retry === 'lostUnrecorded') { options.retry = undefined; throw new Error('The reply was lost.') }
        const machineId = String((cmd.request as Record<string, unknown>).machineId)
        starts.set(String(payload.operationId), { id: payload.operationId, creationId: `super-${String(payload.operationId)}`,
          ...(options.direct?.includes(machineId) ? {} : { poolGeneration: 'pool' }),
          routeDecisionId: cmd.routeDecisionId, request: cmd.request, harnessId: null, dispatched: false, error: null })
        if (retry === 'lost') { options.retry = undefined; throw new Error('The reply was lost.') }
        return { ok: true, value: { result: { startId: payload.operationId } } }
      }
      if (cmd.type === 'agent.startFailed') starts.get(String(cmd.startId))!.error = cmd.error
      if (cmd.type === 'route.record') return { ok: true, value: { result: { routeDecisionId: payload.operationId } } }
      return { ok: true, value: { result: { messageId: payload.operationId } } }
    })
    const daemon = { request: vi.fn(async (type: string): Promise<Record<string, unknown>> => type === 'agent_create_status'
      ? { creationId: `super-${derived}`, state: 'missing' } : type === 'super_tabs' ? { error: 'GUEST_NOT_ALLOWED' } : {}), close: vi.fn() }
    let derived = ''
    const open = vi.fn(async (_where: unknown, machineId?: string) => {
      if (!options.direct?.includes(String(machineId))) throw new Error('A queued start is dispatched by its host, not the Lead.')
      derived = [...starts.keys()].at(-1)!
      return daemon as never
    })
    const pause = vi.fn(async () => {})
    const lead = (input: Record<string, unknown>) => startAgent(input, scoped, where, open, pause)
    const first = { action: 'start', tabId: 'tab', operationId: 'first-start', request: { conversationId: 'group', machineId: 'mac-one', engine: 'claude',
      model: 'opus', effort: 'high', name: 'Builder', cwd: '/one/swarm/project', worktree: true, requirements, routeDecisionId: 'decision-1' } }
    return { starts, commands, scoped, pause, lead, first, of: (type: string) => commands.filter(c => c.type === type) }
  }

  it('starts once on the route\'s next machine when the first machine fails it in preparation', async () => {
    const b = backend()
    const result = await b.lead(b.first)
    const [, retry] = b.of('agent.start')
    const [rerouted] = b.of('route.record')
    // The retry is routed again from the stored decision: without the failed machine, picking the next new agent.
    expect(rerouted).toMatchObject({ conversationId: 'group', decision: { pick: 'c2', via: 'order', candidates: [candidate('c2', 'mac-two')],
      excluded: [{ title: 'Builder · Claude opus high · mac-one', reason: 'Its machine could not start this task.' }, { title: 'Builder · Claude opus high · mac-one', reason: 'Its machine could not start this task.' }] } })
    expect(retry).toMatchObject({ routeDecisionId: rerouted!.operationId, request: { machineId: 'mac-two', cwd: '/two/swarm/project', engine: 'claude',
      model: 'opus', effort: 'high', name: 'Builder', worktree: true, requirements, conversationId: 'group' } })
    expect(b.of('agent.start')).toHaveLength(2)
    expect(result).toMatchObject({ ok: true, queued: true, startId: retry!.operationId, retriedFrom: 'first-start' })
    expect(b.of('message.send')).toEqual([])
  })

  it('counts a Mac\'s Harness Team account as that Mac, and leaves the failed machine\'s own settings behind', async () => {
    const b = backend({ fails: ['team-one'] })
    const answer = b.scoped.getMockImplementation()!
    b.scoped.mockImplementation(async payload => {
      if (payload.action !== 'status') return answer(payload)
      const state = swarm()
      state.machines.push({ machineId: 'team-one', name: 'Mac One (Team)', scope: 'swarm', cwd: '/team/swarm', hostMachineId: 'mac-one' } as never)
      return { ok: true, value: { state } }
    })
    // The backend moved the Lead's start on Mac One to its team account (machines.ts teamStartRequest).
    const result = await b.lead({ ...b.first, request: { ...b.first.request, machineId: 'team-one', codexHome: '/one/.codex' } })
    expect(b.of('route.record')[0]).toMatchObject({ decision: { pick: 'c2', candidates: [candidate('c2', 'mac-two')] } })
    expect(b.of('agent.start')[1]!.request).toMatchObject({ machineId: 'mac-two' })
    expect(b.of('agent.start')[1]!.request).not.toHaveProperty('codexHome')
    expect(result).toMatchObject({ queued: true, retriedFrom: 'first-start' })
  })
  it('reports when the backend refuses the retry\'s start after its route was recorded', async () => {
    const b = backend({ retry: 'refused' })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED', startId: expect.stringMatching(/^retry-/) })
    expect(b.of('route.record')).toHaveLength(1)
    expect(b.of('agent.start')).toHaveLength(2)
    expect(b.of('message.send')).toMatchObject([{ text: expect.stringMatching(/^Builder could not start on Mac Two, and no other machine/) }])
  })
  it('reconciles the retry\'s own start when its reply is lost after the backend recorded it, never making another', async () => {
    const b = backend({ retry: 'lost' })
    expect(await b.lead(b.first)).toMatchObject({ ok: true, queued: true, startId: b.of('agent.start')[1]!.operationId, retriedFrom: 'first-start' })
    expect(b.of('agent.start')).toHaveLength(2)
    expect(b.of('message.send')).toEqual([])
  })
  it('says the retry is unconfirmed when its reply is lost before it was recorded, and a resume sends the same one', async () => {
    const b = backend({ retry: 'lostUnrecorded' })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_UNCERTAIN', retriedFrom: 'first-start' })
    expect(b.of('message.send')).toEqual([])
    expect(await b.lead({ action: 'resume', tabId: 'tab', startId: 'first-start' })).toMatchObject({ ok: true, queued: true, retriedFrom: 'first-start' })
    const retries = b.of('agent.start').slice(1)
    expect(retries).toHaveLength(2)
    expect(retries[1]!.operationId).toBe(retries[0]!.operationId)
  })
  it('fails and reports a retry its machine refuses before launching it', async () => {
    const b = backend({ direct: ['mac-two'] })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED' })
    const retryId = b.of('agent.start')[1]!.operationId
    expect(b.of('agent.startFailed')).toMatchObject([{ startId: retryId, error: expect.stringContaining('machine owner') }])
    expect(b.of('message.send')).toHaveLength(1)
  })
  it('never moves to the candidate a Lead\'s override moved the task away from, and keeps what it chose to run', async () => {
    const overridden = { by: 'lead', actorKey: 'agent:lead', reason: 'Spread off the Mac Studio.' }
    // The policy put the Mac Studio first; the Lead started opus on Mac One instead, which failed.
    const studio = { ...candidate('c0', 'mac-studio'), model: 'sonnet', effort: 'medium' }
    const b = backend({ override: overridden, candidates: [studio, { ...candidate('c1', 'mac-two'), model: 'sonnet', effort: 'medium' }, candidate('c2', 'mac-one'), candidate('c3', 'mac-two')] })
    await b.lead(b.first)
    expect(b.of('route.record')[0]).toMatchObject({ decision: { pick: 'c3' } })
    expect(b.of('agent.start')[1]!.request).toMatchObject({ machineId: 'mac-two', model: 'opus', effort: 'high' })
    const none = backend({ override: overridden, candidates: [studio, candidate('c2', 'mac-one')] })
    expect(await none.lead(none.first)).toMatchObject({ error: 'START_BLOCKED' })
    expect(none.of('route.record')).toEqual([])
  })
  it('reports instead of moving a task a person chose the machine for', async () => {
    const b = backend({ override: { by: 'person', actorKey: 'person:owner', candidateId: 'c0', reason: 'Mine.' } })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED' })
    expect(b.of('route.record')).toEqual([])
  })
  it('a resumed failed start is retried the same way, once, under the same operations', async () => {
    const b = backend()
    await b.lead(b.first)
    const before = b.commands.length
    // The Lead, woken by the failure, resumes the first start: the retry already exists, so nothing new is sent.
    expect(await b.lead({ action: 'resume', tabId: 'tab', startId: 'first-start' })).toMatchObject({ queued: true, retriedFrom: 'first-start' })
    expect(b.commands.slice(before).map(c => c.operationId)).toEqual(b.commands.slice(before - 2, before).map(c => c.operationId))
  })

  it('with no other machine, tells the group and its requester that the task has no worker, without the raw error', async () => {
    const b = backend({ candidates: [candidate('c0', 'mac-one'), candidate('c1', 'mac-one', 'member')] })
    const result = await b.lead(b.first)
    expect(b.of('agent.start')).toHaveLength(1)
    const [notice] = b.of('message.send')
    expect(notice).toMatchObject({ conversationId: 'group', mentions: ['person-1'], recipientIds: [],
      text: 'Builder could not start on Mac One, and no other machine allowed for this task could take it. This task has no worker until that machine is fixed or another one is added.' })
    expect(String(notice!.text)).not.toContain('token')
    expect(result).toMatchObject({ error: 'START_BLOCKED', startId: 'first-start', detail: expect.stringContaining(TOKEN) })
  })

  // Ken's MacBook Pro, 2026-10-28: the group read "until that machine is fixed" when the machine was only short of memory.
  it('names a memory shortage and the machine in the notice, and leaves out the rest of the raw reason', async () => {
    const reason = 'Not enough free memory: 1.8 GiB free, 2 GiB needed. 6 GiB more is set aside for agents still starting.'
    const b = backend({ candidates: [candidate('c0', 'mac-one')], error: reason })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED', detail: expect.stringContaining(reason) })
    expect(b.of('message.send')).toMatchObject([{ text: 'Builder could not start on Mac One: not enough free memory (1.8 GiB free, 2 GiB needed), '
      + 'and no other machine allowed for this task could take it. This task has no worker until memory frees up on that machine or another one is added.' }])
  })

  it('reports instead of trying a third machine when the retry fails as well', async () => {
    const b = backend({ fails: ['mac-one', 'mac-two'] })
    const result = await b.lead(b.first)
    expect(b.of('agent.start')).toHaveLength(2)
    expect(b.of('message.send')).toHaveLength(1)
    expect(b.of('message.send')[0]!.text).toMatch(/^Builder could not start on Mac Two, and no other machine/)
    expect(result).toMatchObject({ error: 'START_BLOCKED' })
    // Resuming the failed retry later reports the same notice again, never a further start.
    const retryId = String(b.of('agent.start')[1]!.operationId)
    expect(await b.lead({ action: 'resume', tabId: 'tab', startId: retryId })).toMatchObject({ error: 'START_BLOCKED' })
    expect(b.of('agent.start')).toHaveLength(2)
    expect(new Set(b.of('message.send').map(c => c.operationId)).size).toBe(1)
  })

  it('keeps a task bound by a hard rule this client does not know where it is, and reports it', async () => {
    const b = backend({ rules: [{ id: 'rule-1', projectId: 'project', rule: { kind: 'machines', machineIds: ['mac-one', 'mac-two'] } },
      { id: 'rule-2', projectId: 'project', rule: { kind: 'requiresMachine', machineId: 'mac-one' } }] })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED' })
    expect(b.of('route.record')).toEqual([])
    expect(b.of('agent.start')).toHaveLength(1)
  })

  const STAYS = 'Builder could not start. This task needs a particular machine or device, so it was not moved to another machine. It has no worker until a machine that has what it needs can start it.'
  it('keeps a task that requires its machine or device where it is, and tells the group and its requester', async () => {
    // As each Lead reads it: a machine it sees, one it does not (only counted), a device.
    for (const requires of [{ machines: ['mac-one'] }, { machines: [], unseenMachines: 1 }, { devices: ['/dev/cu.round'] }]) {
      const b = backend({ requires })
      expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED', startId: 'first-start', detail: expect.stringContaining(TOKEN) })
      expect(b.of('route.record')).toEqual([])
      expect(b.of('agent.start')).toHaveLength(1)
      expect(b.of('message.send')).toMatchObject([{ conversationId: 'group', mentions: ['person-1'], recipientIds: [], text: STAYS }])
      // A group reader may not see the machine (backend model.ts withSeenRequirement): the post names none, nor the raw error.
      for (const hidden of ['mac-one', 'Mac One', TOKEN, 'token']) expect(String(b.of('message.send')[0]!.text)).not.toContain(hidden)
    }
  })
  it('reports the requirement when the backend refuses the new pick for it', async () => {
    // The requirement was set after the Lead read the group: the backend holds the pick to it.
    const b = backend()
    const answer = b.scoped.getMockImplementation()!
    b.scoped.mockImplementation(async payload => (payload.command as Record<string, unknown> | undefined)?.type === 'route.record'
      ? { error: 'REQUIREMENT_UNMET', detail: 'This task runs only on the machine it requires, and this is another machine.' } : answer(payload))
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED', startId: 'first-start' })
    expect(b.of('agent.start')).toHaveLength(1)
    expect(b.of('message.send')).toMatchObject([{ text: STAYS }])
  })
  it('reports the requirement when the backend refuses the retry\'s start for it', async () => {
    const b = backend()
    const answer = b.scoped.getMockImplementation()!
    b.scoped.mockImplementation(async payload => {
      const command = payload.command as Record<string, unknown> | undefined
      if (command?.type !== 'agent.start' || payload.operationId === 'first-start') return answer(payload)
      b.commands.push({ operationId: payload.operationId, ...command })
      return { error: 'REQUIREMENT_UNMET', detail: 'This task needs /dev/cu.round.' }
    })
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED', startId: 'first-start' })
    expect(b.of('agent.start')).toHaveLength(2)
    expect(b.of('message.send')).toMatchObject([{ text: STAYS }])
  })

  it('a rule of another project does not hold the task back', async () => {
    const b = backend({ rules: [{ id: 'rule-2', projectId: 'other', rule: { kind: 'requiresMachine', machineId: 'mac-one' } }] })
    expect(await b.lead(b.first)).toMatchObject({ ok: true, queued: true })
  })

  it('reports when the backend refuses the new pick, for a hard rule it knows', async () => {
    const b = backend()
    const answer = b.scoped.getMockImplementation()!
    b.scoped.mockImplementation(async payload => (payload.command as Record<string, unknown> | undefined)?.type === 'route.record'
      ? { error: 'RULE_BROKEN', detail: 'Only these machines.' } : answer(payload))
    expect(await b.lead(b.first)).toMatchObject({ error: 'START_BLOCKED' })
    expect(b.of('agent.start')).toHaveLength(1)
  })

  it('returns a start still queued after the watch as before, without retrying it', async () => {
    const b = backend({ fails: [] })
    expect(await b.lead(b.first)).toMatchObject({ ok: true, queued: true, startId: 'first-start' })
    expect(b.pause).toHaveBeenCalledTimes(10)
    expect(b.of('route.record')).toEqual([])
  })

  it('never retries on the host side, nor a start that was not routed', async () => {
    const b = backend()
    await b.lead(b.first)
    const hosted = await startAgent({ action: 'resume', tabId: 'tab', startId: 'first-start', hostDispatch: true }, b.scoped, where, vi.fn(), b.pause)
    expect(hosted).toMatchObject({ error: 'START_FAILED' })
    const unrouted = backend()
    const { routeDecisionId: _id, ...request } = unrouted.first.request
    expect(await unrouted.lead({ ...unrouted.first, request })).toMatchObject({ error: 'START_FAILED', detail: TOKEN })
    expect(unrouted.of('route.record')).toEqual([])
  })
})
