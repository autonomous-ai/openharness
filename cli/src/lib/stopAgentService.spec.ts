import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { captureResumeIdentity } from './captureResumeIdentity.js'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'
import { createForgetSession } from '../core/agents/forget.js'
import { env } from '../config/env.js'
import { controlTranscriptEvidence } from '../engines/transcriptBindings.js'
vi.mock('./captureResumeIdentity.js', () => ({ captureResumeIdentity: vi.fn(async session => session) }))
vi.mock('../engines/transcriptBindings.js', async original => ({ ...await original<object>(),
  controlTranscriptEvidence: vi.fn(),
}))
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))
vi.mock('../core/engines/cursorTasks.js', () => ({ removePendingCursorTasks: vi.fn(async () => {}) }))
let row: RegisteredSession
let deps: StopAgentServiceDeps
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(controlTranscriptEvidence).mockReset().mockImplementation((_engine, _id, path) => ({ path, verify: vi.fn() }))
  vi.mocked(captureResumeIdentity).mockReset().mockImplementation(async session => session)
  row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%44' }], cwd: '/tmp' })!
  Object.assign(row, { sessionId: 'saved', processIdentity: { pid: 77, executable: 'codex', startMarker: 'fixture' } })
  deps = { registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    tmuxBackend: { kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })) },
    agentReconciler: { suppress: vi.fn(), holdRoute: vi.fn(), releaseRoute: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: vi.fn(id => registry.removeAgent(id)), markDeleted: vi.fn(), clearDeleted: vi.fn(),
    stopNative: vi.fn(async () => {}),
  }
  vi.mocked(terminateDeletedAgent).mockResolvedValue('gone')
})
afterEach(() => { vi.restoreAllMocks(); for (const entry of registry.list()) registry.removeAgent(entry.agentId) })

it('saves history before removing the runtime, joins concurrent stops, and clears confirmed reservations', async () => {
  const token = stoppedAgents.beginResume(row.agentId); expect(token).toBeTruthy()
  const original = row.agentId
  vi.mocked(deps.forgetSession).mockImplementation(id => { expect(stoppedAgents.get(id)?.sessionId).toBe('saved'); registry.removeAgent(id) })
  const stop = createStopAgentService(deps); const one = stop(original); expect(stop(original)).toBe(one); await one
  expect(stoppedAgents.get(original)).toMatchObject({ active: false, sessionId: 'saved' })
  expect(registry.byAgent(original)).toBeUndefined(); expect(deps.stopJobs.size).toBe(0)
  expect(stoppedAgents.beginResume(original)).not.toBeNull(); expect(deps.agentReconciler.suppress).toHaveBeenCalledWith(row)
})
it('missing identities are harmless and never allocate or signal anything', async () => {
  await createStopAgentService(deps)('missing'); expect(deps.forgetSession).not.toHaveBeenCalled(); expect(terminateDeletedAgent).not.toHaveBeenCalled()
})
it.each(['forget', 'checkpoint'] as const)('retains a captured Pi resume path through a pathless %s save', async stage => {
  Object.assign(row, { engine: 'pi', transcriptPath: null,
    processIdentity: { pid: 77, executable: 'pi', startMarker: 'fixture' } })
  vi.mocked(captureResumeIdentity).mockImplementation(async session => ({ ...session,
    transcriptPath: '/fixture/native.jsonl', source: 'stop-repair' }))
  deps.forgetSession = createForgetSession({
    registry, stoppedAgents, syncRecapPool: vi.fn(), normalizers: { forget: vi.fn() },
    forgetAttach: vi.fn(), turnStartedAt: new Map(), neverFoldedHistory: new Set(), replayedFirstTurn: new Set(),
    clearAgyIdleWatch: vi.fn(), cursorDiscovery: { remove: vi.fn() }, cursorSubagents: { forget: vi.fn() },
    runtimeProfiles: { forget: vi.fn() }, watcher: { removeSession: vi.fn(async () => {}) },
    stopHeartbeat: vi.fn(), teams: { forget: vi.fn() }, input: { forget: vi.fn() }, deviceInput: { forget: vi.fn() },
    detachDsh: vi.fn(), mirror: { forget: vi.fn() }, clients: { send: vi.fn(), sendCommander: vi.fn() },
    dataDir: env.ADAPTER_DATA_DIR,
  })
  await createStopAgentService(deps)(row.agentId, { checkpoint: async (_session, phase) => {
    if (stage === 'checkpoint' && phase === 'before') {
      // A hook can save the same live row while Close awaits its checkpoint, before tombstones exist.
      expect(row.transcriptPath).toBeNull()
      stoppedAgents.save({ ...row, title: 'Hook arrived' })
      expect(stoppedAgents.get(row.agentId)?.transcriptPath).toBe('/fixture/native.jsonl')
    }
  } })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ sessionId: row.sessionId,
    transcriptPath: '/fixture/native.jsonl', active: false })
})
it('cancels immediately, then joins the core pane commit before capturing the runtime to stop', async () => {
  let committed!: () => void
  deps.settlePane = vi.fn(() => new Promise<void>(done => { committed = done }))
  const stopping = createStopAgentService(deps)(row.agentId)
  expect(deps.stopJobs.has(row.agentId)).toBe(true)
  await vi.waitFor(() => expect(deps.settlePane).toHaveBeenCalledWith(row.agentId))
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  row.runtimes = [{ backend: 'tmux', paneId: '%90' }]
  committed()
  await stopping
  expect(deps.tmuxBackend!.kill).toHaveBeenCalledWith({ backend: 'tmux', paneId: '%90' })
})
it('storage failure leaves the live process and registry untouched', async () => {
  vi.spyOn(stoppedAgents, 'save').mockImplementation(() => { throw new Error('disk full') })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('disk full')
  expect(registry.byAgent(row.agentId)).toBe(row); expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled(); expect(deps.markDeleted).not.toHaveBeenCalled()
})
it('preserves an unexpected evidence failure without signalling or hiding its cause', async () => {
  row.transcriptPath = '/fixture/history.jsonl'
  vi.mocked(controlTranscriptEvidence).mockReturnValue({ path: row.transcriptPath,
    verify: () => { throw new Error('Evidence implementation unavailable') } })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Evidence implementation unavailable')
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
it.each(['before', 'after'] as const)('honors cancellation at the %s checkpoint before retiring the terminal', async phase => {
  let current = true
  await expect(createStopAgentService(deps)(row.agentId, {
    current: () => current,
    checkpoint: async (_, at) => { if (at === phase) current = false },
  })).rejects.toThrow('changed')
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
  if (phase === 'before') expect(terminateDeletedAgent).not.toHaveBeenCalled()
})
it('backs up final flushed history after graceful exit and before closing the pane', async () => {
  const order: string[] = []
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => { order.push('exit'); return 'terminated' })
  vi.mocked(deps.tmuxBackend!.kill).mockImplementation(async () => { order.push('pane'); return { state: 'succeeded', dispatch: 'executed' } })
  await createStopAgentService(deps)(row.agentId, { checkpoint: async (_, phase) => { order.push(phase) } })
  expect(order).toEqual(['before', 'exit', 'after', 'pane'])
})
it.each(['terminal', 'without tmux', 'failed process', 'failed tmux'] as const)('retains work when stopping %s', async mode => {
  stoppedAgents.beginResume(row.agentId)
  if (mode === 'terminal') Object.assign(row, { engine: 'terminal', sessionId: '', processIdentity: null })
  if (mode === 'without tmux') { deps.tmuxBackend = null; row.runtimes = [{ backend: 'unknown', endpointId: 'fixture', paneId: '1' } as any] }
  if (mode === 'failed process') vi.mocked(terminateDeletedAgent).mockResolvedValue('failed')
  if (mode === 'failed tmux') vi.mocked(deps.tmuxBackend!.kill).mockResolvedValue({ state: 'unknown', dispatch: 'possibly_executed', reason: 'fixture' })
  const stopping = createStopAgentService(deps)(row.agentId)
  if (mode === 'failed process' || mode === 'failed tmux') {
    await expect(stopping).rejects.toThrow('Could not confirm')
    expect(registry.byAgent(row.agentId)).toBe(row)
    expect(deps.forgetSession).not.toHaveBeenCalled()
    expect(deps.agentReconciler.suppress).not.toHaveBeenCalled()
  } else await stopping
  expect(stoppedAgents.get(row.agentId)).not.toBeNull(); expect(deps.agentReconciler.trigger).toHaveBeenCalledOnce()
  expect(stoppedAgents.beginResume(row.agentId) === null).toBe(mode === 'failed process' || mode === 'failed tmux')
})

it('does not publish a stopped row until the exact process and terminal have both stopped', async () => {
  let finishProcess!: () => void
  let finishPane!: () => void
  vi.mocked(terminateDeletedAgent).mockImplementation(() => new Promise(resolve => { finishProcess = () => resolve('terminated') }))
  vi.mocked(deps.tmuxBackend!.kill).mockImplementation(() => new Promise(resolve => { finishPane = () => resolve({ state: 'succeeded', dispatch: 'executed' }) }))
  const stop = createStopAgentService(deps)
  const stopping = stop(row.agentId)
  await vi.waitFor(() => expect(finishProcess).toBeTypeOf('function'))
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  finishProcess()
  await vi.waitFor(() => expect(finishPane).toBeTypeOf('function'))
  expect(deps.forgetSession).not.toHaveBeenCalled()
  expect(stop(row.agentId)).toBe(stopping)
  finishPane()
  await stopping
  expect(deps.forgetSession).toHaveBeenCalledOnce()
  expect(deps.agentReconciler.holdRoute).toHaveBeenCalledOnce()
  expect(deps.agentReconciler.releaseRoute).toHaveBeenCalledOnce()
})

it.each(['process', 'pane'] as const)('a rejected %s check retains history, releases its route and permits a safe retry', async side => {
  if (side === 'process') vi.mocked(terminateDeletedAgent).mockRejectedValueOnce(new Error('probe failed'))
  else vi.mocked(deps.tmuxBackend!.kill).mockRejectedValueOnce(new Error('transport failed'))
  const stop = createStopAgentService(deps)
  await expect(stop(row.agentId)).rejects.toThrow('Could not confirm')
  expect(deps.stopJobs.size).toBe(0)
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.agentReconciler.releaseRoute).toHaveBeenCalledOnce()
  expect(deps.clearDeleted).toHaveBeenCalledWith(row.agentId)
  await stop(row.agentId)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
})

it.each(['no backend', 'no tmux route'] as const)('cannot confirm stopping a shell with %s', async mode => {
  row.engine = 'terminal'
  if (mode === 'no backend') deps.tmuxBackend = null
  else row.runtimes = [{ backend: 'unknown', endpointId: 'fixture', paneId: '1' } as any]
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm')
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it.each(['removed', 'replaced', 'conversation', 'route'] as const)('does not remove a target %s during termination', async mode => {
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => {
    if (mode === 'removed') registry.removeAgent(row.agentId)
    else if (mode === 'conversation') row.sessionId = 'different-conversation'
    else if (mode === 'route') row.runtimes = [{ backend: 'tmux', paneId: '%88' }]
    else row.processIdentity = { ...row.processIdentity!, pid: 88 }
    return 'terminated'
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
it.each(['capture', 'termination'] as const)('stops an agent still starting when its engine is identified during %s', async stage => {
  // Created, not yet bound to a process: the stop's snapshot has none.
  row.processIdentity = null
  const launched = { pid: 91, executable: 'codex', startMarker: 'launched' }
  if (stage === 'capture') vi.mocked(captureResumeIdentity).mockImplementation(async session => { row.processIdentity = launched; return session })
  else vi.mocked(terminateDeletedAgent).mockImplementation(async () => { row.processIdentity = launched; return 'terminated' })
  await createStopAgentService(deps)(row.agentId)
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(deps.tmuxBackend!.kill).toHaveBeenCalledOnce()
  // Identified before termination: that exact process is the one checked and signalled.
  if (stage === 'capture') expect(vi.mocked(terminateDeletedAgent).mock.calls[0][0].processIdentity).toEqual(launched)
})
it('still refuses a starting agent whose pane or conversation changed under the stop', async () => {
  row.processIdentity = null
  vi.mocked(terminateDeletedAgent).mockImplementation(async () => { row.runtimes = [{ backend: 'tmux', paneId: '%89' }]; return 'gone' })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
})
it.each(['capture', 'termination'] as const)('accepts a hook rebuilding the same process during %s', async stage => {
  const replacement = { ...row, title: 'Updated title',
    processIdentity: { startMarker: 'fixture', executable: 'codex', pid: 77 },
    runtimes: row.runtimes.map(runtime => ({ ...runtime })),
  }
  const rebuild = () => { vi.spyOn(registry, 'resolve').mockReturnValue(replacement) }
  if (stage === 'capture') vi.mocked(captureResumeIdentity).mockImplementation(async session => { rebuild(); return session })
  else vi.mocked(terminateDeletedAgent).mockImplementation(async () => { rebuild(); return 'terminated' })
  await createStopAgentService(deps)(row.agentId)
  expect(deps.forgetSession).toHaveBeenCalledExactlyOnceWith(row.agentId, { force: true, captured: expect.objectContaining({ sessionId: 'saved' }) })
  expect(registry.byAgent(row.agentId)).toBeUndefined()
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('saved')
})
it('only signals through the validated process deleter and does not erase a newer stop job', async () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(terminateDeletedAgent).mockImplementation(async (entry, actions) => {
    await actions.checkRuntime(entry); actions.kill(77, 'SIGTERM'); await actions.sleep(1); actions.log('fixture stop')
    deps.stopJobs.set(row.agentId, Promise.resolve()); return 'terminated'
  })
  row.runtimes.push({ backend: 'unknown', endpointId: 'fixture', paneId: '2' } as any)
  await createStopAgentService(deps)(row.agentId)
  expect(signal).toHaveBeenCalledExactlyOnceWith(77, 'SIGTERM'); expect(deps.stopJobs.has(row.agentId)).toBe(true)
  expect(deps.tmuxBackend!.kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%44' })
})

it.each(['claude', 'codex'] as const)('captures an unbound %s conversation before deleting its process', async engine => {
  Object.assign(row, { engine, sessionId: '', transcriptPath: null })
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    expect(registry.byAgent(row.agentId)).toBe(row)
    expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
    return { ...session, sessionId: 'recovered', transcriptPath: '/history.jsonl', boundAt: 1, source: 'stop-repair' }
  })
  await createStopAgentService(deps)(row.agentId)
  expect(stoppedAgents.get(row.agentId)).toMatchObject({ engine, sessionId: 'recovered', transcriptPath: '/history.jsonl' })
  expect(deps.markDeleted).toHaveBeenCalledWith('recovered')
})
it.each(['removed', 'replaced'] as const)('does not stop a process that was %s during identity capture', async mode => {
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    if (mode === 'removed') registry.removeAgent(row.agentId)
    else row.processIdentity = { ...row.processIdentity!, pid: 88 }
    return session
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Harness changed')
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(stoppedAgents.get(row.agentId)).toBeNull()
})
it('keeps the newer hook binding that arrives during capture', async () => {
  row.sessionId = ''
  vi.mocked(captureResumeIdentity).mockImplementation(async session => {
    row.sessionId = 'latest'
    return { ...session, sessionId: 'older' }
  })
  await createStopAgentService(deps)(row.agentId)
  expect(stoppedAgents.get(row.agentId)?.sessionId).toBe('latest')
})

it('checks cancellation at the shared-server boundary and never signals after a failure there', async () => {
  let current = true
  vi.mocked(deps.stopNative).mockImplementationOnce(async (_row, guard) => {
    expect(guard()).toBe(true); current = false; expect(guard()).toBe(false)
    throw new Error('shared server could not stop')
  })
  await expect(createStopAgentService(deps)(row.agentId, { current: () => current })).rejects.toThrow('shared server')
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(deps.clearDeleted).toHaveBeenCalledWith(row.agentId)
})
it('does not signal a process replaced at the actual kill boundary', async () => {
  vi.mocked(terminateDeletedAgent).mockImplementationOnce(async (_row, actions) => {
    row.processIdentity!.startMarker = 'replacement'
    actions.kill(77, 'SIGTERM')
    return 'gone'
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('Could not confirm')
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
})
it('does not forget a new agent published while its old pane was being retired', async () => {
  vi.mocked(deps.tmuxBackend!.kill).mockImplementationOnce(async () => {
    row.processIdentity!.startMarker = 'replacement'
    return { state: 'succeeded', dispatch: 'executed' }
  })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('changed while pausing')
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it('cancels an external intent through core without archiving, signalling or waiting for search', async () => {
  Object.assign(row, { sessionId: '', processIdentity: null, launch: { state: 'held', service: 'search', detail: 'Reader unavailable' },
    externalResume: { phase: 'waiting' } })
  deps.cancelExternal = vi.fn(async (entry, current) => { expect(entry).toBe(row); expect(current()).toBe(true); return true })
  const save = vi.spyOn(stoppedAgents, 'save')
  await createStopAgentService(deps)(row.agentId)
  expect(deps.cancelExternal).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled()
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})

it.each(['missing', 'refused', 'error', 'unknown', 'cancelled'] as const)('keeps an external intent intact when cancellation is %s', async failure => {
  Object.assign(row, { sessionId: '', processIdentity: null, launch: { state: 'held', service: 'search', detail: 'Reader unavailable' },
    externalResume: { phase: 'waiting' } })
  if (failure !== 'missing') deps.cancelExternal = vi.fn(async (_entry, current) => {
    if (failure === 'error') throw new Error('Journal is unavailable')
    if (failure === 'unknown') throw 'unavailable'
    if (failure === 'cancelled') { expect(current()).toBe(false); return current() }
    return false
  })
  const save = vi.spyOn(stoppedAgents, 'save')
  await expect(createStopAgentService(deps)(row.agentId, { current: () => failure !== 'cancelled' }))
    .rejects.toMatchObject({ code: 'STOP_UNCONFIRMED', message: failure === 'error' ? 'Journal is unavailable'
      : failure === 'unknown' ? 'Adoption could not be cancelled.' : 'Adoption cancellation is unavailable.' })
  expect(registry.byAgent(row.agentId)).toBe(row)
  expect(deps.stopJobs.size).toBe(0)
  expect(save).not.toHaveBeenCalled()
  expect(captureResumeIdentity).not.toHaveBeenCalled()
  expect(terminateDeletedAgent).not.toHaveBeenCalled()
  expect(deps.stopNative).not.toHaveBeenCalled()
  expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled()
  expect(deps.forgetSession).not.toHaveBeenCalled()
})
