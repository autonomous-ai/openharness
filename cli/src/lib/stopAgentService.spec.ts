import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createStopAgentService, type StopAgentServiceDeps } from './stopAgentService.js'
import { registry, type RegisteredSession } from './registry.js'
import { stoppedAgents } from './stoppedAgents.js'
import { AgentRestartCoordinator } from './restartAgent.js'
import { checkPidRuntime, terminateDeletedAgent } from './deleteAgentFallback.js'
vi.mock('./deleteAgentFallback.js', () => ({ checkPidRuntime: vi.fn(), terminateDeletedAgent: vi.fn() }))
let row: RegisteredSession
let deps: StopAgentServiceDeps
beforeEach(() => {
  vi.clearAllMocks()
  row = registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%44' }], cwd: '/tmp' })!
  Object.assign(row, { sessionId: 'saved', processIdentity: { pid: 77, executable: 'codex', startMarker: 'fixture' } })
  deps = { registry, stoppedAgents, restartJobs: new AgentRestartCoordinator(), stopJobs: new Map(),
    tmuxBackend: { kill: vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })) },
    agentReconciler: { suppress: vi.fn(), trigger: vi.fn(async () => {}) },
    forgetSession: vi.fn(id => registry.removeAgent(id)), markDeleted: vi.fn(), clearDeleted: vi.fn(),
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
it('storage failure leaves the live process and registry untouched', async () => {
  vi.spyOn(stoppedAgents, 'save').mockImplementation(() => { throw new Error('disk full') })
  await expect(createStopAgentService(deps)(row.agentId)).rejects.toThrow('disk full')
  expect(registry.byAgent(row.agentId)).toBe(row); expect(deps.tmuxBackend!.kill).not.toHaveBeenCalled(); expect(deps.markDeleted).not.toHaveBeenCalled()
})
it.each(['terminal', 'without tmux', 'failed process', 'failed tmux'] as const)('retains work when stopping %s', async mode => {
  stoppedAgents.beginResume(row.agentId)
  if (mode === 'terminal') Object.assign(row, { engine: 'terminal', sessionId: '', processIdentity: null })
  if (mode === 'without tmux') { deps.tmuxBackend = null; row.runtimes = [{ backend: 'herdr', endpointId: 'fixture', paneId: '1' } as any] }
  if (mode === 'failed process') vi.mocked(terminateDeletedAgent).mockResolvedValue('failed')
  if (mode === 'failed tmux') vi.mocked(deps.tmuxBackend!.kill).mockResolvedValue({ state: 'unknown', dispatch: 'possibly_executed', reason: 'fixture' })
  await createStopAgentService(deps)(row.agentId)
  expect(stoppedAgents.get(row.agentId)).not.toBeNull(); expect(deps.agentReconciler.trigger).toHaveBeenCalledOnce()
  expect(stoppedAgents.beginResume(row.agentId) === null).toBe(mode === 'failed process' || mode === 'failed tmux')
})
it('only signals through the validated process deleter and does not erase a newer stop job', async () => {
  const signal = vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.mocked(terminateDeletedAgent).mockImplementation(async (entry, actions) => {
    await actions.checkRuntime(entry); actions.kill(77, 'SIGTERM'); await actions.sleep(1); actions.log('fixture stop')
    deps.stopJobs.set(row.agentId, Promise.resolve()); return 'terminated'
  })
  row.runtimes.push({ backend: 'herdr', endpointId: 'fixture', paneId: '2' } as any)
  await createStopAgentService(deps)(row.agentId)
  expect(signal).toHaveBeenCalledExactlyOnceWith(77, 'SIGTERM'); expect(deps.stopJobs.has(row.agentId)).toBe(true)
  expect(deps.tmuxBackend!.kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%44' })
})
