import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PurgeDeps } from '../../lib/purgeAgentService.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createResumeAgentService } from '../../lib/resumeAgentService.js'
import { createStopAgentService } from '../../lib/stopAgentService.js'
import { createAgentLifecycle, type LifecycleDeps } from './lifecycle.js'

vi.mock('../../lib/stopAgentService.js', async (real) => ({ ...await real<object>(), createStopAgentService: vi.fn(() => vi.fn(async () => {})) }))
vi.mock('../../lib/resumeAgentService.js', async (real) => ({
  ...await real<object>(),
  createResumeAgentService: vi.fn(() => vi.fn(async () => ({ ok: true }))),
}))
// The real purge service, recording what it was built with so its callbacks can be driven directly.
vi.mock('../../lib/purgeAgentService.js', async (real) => {
  const actual = await real<typeof import('../../lib/purgeAgentService.js')>()
  class RecordingPurgeAgentService extends actual.PurgeAgentService {
    constructor(readonly given: PurgeDeps) { super(given) }
  }
  return { ...actual, PurgeAgentService: RecordingPurgeAgentService }
})

const row = (over: Partial<RegisteredSession> = {}) => ({ agentId: 'a1', sessionId: 's1', cwd: '/work', ...over }) as RegisteredSession

function setup(over: Partial<LifecycleDeps> = {}) {
  const deps: LifecycleDeps = {
    registry: {
      byAgent: vi.fn(() => row()),
      list: vi.fn(() => [row()]),
      deleteSavedNames: vi.fn(),
    } as unknown as LifecycleDeps['registry'],
    stoppedAgents: { list: vi.fn(() => [row({ agentId: 'a2' })]), get: vi.fn(() => undefined) } as unknown as LifecycleDeps['stoppedAgents'],
    restartJobs: { busy: vi.fn(() => false) } as unknown as LifecycleDeps['restartJobs'],
    tmuxBackend: null,
    agentReconciler: {} as never,
    forgetSession: vi.fn(),
    markDeleted: vi.fn(),
    clearDeleted: vi.fn(),
    sessionCheckpoints: {} as never,
    mirror: { deleteHistory: vi.fn() },
    sessionSearch: { deleteHistory: vi.fn() },
    send: vi.fn(),
    pinnedControls: new Set<string>(),
    retainExitedSession: vi.fn(),
    announceSession: vi.fn(),
    relaunchOverrides: vi.fn() as never,
    prepareSessionResume: vi.fn(),
    refreshGridWebSearch: vi.fn(),
    attachDsh: vi.fn(),
    ...over,
  }
  const lifecycle = createAgentLifecycle(deps)
  const purge = (lifecycle.purgeAgentService as unknown as { given: PurgeDeps }).given
  return { deps, lifecycle, purge }
}

describe('stopping, purging and resuming an agent', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('builds stop on one map of stops in flight, which resume and the lifecycle share', () => {
    const { deps, lifecycle } = setup()
    expect(createStopAgentService).toHaveBeenCalledWith({
      registry: deps.registry, stoppedAgents: deps.stoppedAgents, restartJobs: deps.restartJobs, stopJobs: lifecycle.stopJobs,
      tmuxBackend: null, agentReconciler: deps.agentReconciler, forgetSession: deps.forgetSession,
      markDeleted: deps.markDeleted, clearDeleted: deps.clearDeleted,
    })
    expect(lifecycle.stopAgent).toBe(vi.mocked(createStopAgentService).mock.results[0].value)
    expect(createResumeAgentService).toHaveBeenCalledWith({
      registry: deps.registry, stoppedAgents: deps.stoppedAgents, tmuxBackend: null, restartJobs: deps.restartJobs,
      stopJobs: lifecycle.stopJobs, pinnedControls: deps.pinnedControls, retainExitedSession: deps.retainExitedSession,
      announceSession: deps.announceSession, relaunchOverrides: deps.relaunchOverrides, prepareSessionResume: deps.prepareSessionResume,
      refreshGridWebSearch: deps.refreshGridWebSearch, clearDeleted: deps.clearDeleted, attachDsh: deps.attachDsh,
    })
  })

  describe('purge', () => {
    it('sees live and stopped agents, stops through the stop service, and checkpoints where stop does', () => {
      const { deps, lifecycle, purge } = setup()
      expect(purge.live('a1')).toEqual(row())
      expect(deps.registry.byAgent).toHaveBeenCalledWith('a1')
      expect(purge.sessions()).toEqual([row(), row({ agentId: 'a2' })])
      expect(purge.stopped).toBe(deps.stoppedAgents)
      expect(purge.checkpoints).toBe(deps.sessionCheckpoints)
      expect(purge.stop).toBe(lifecycle.stopAgent)
    })

    it('waits on an agent that is restarting or stopping', () => {
      const restarting = setup({ restartJobs: { busy: vi.fn((id: string) => id === 'a1') } as never })
      expect(restarting.purge.restarting('a1')).toBe(true)
      const { lifecycle, purge } = setup()
      expect(purge.restarting('a1')).toBe(false)
      lifecycle.stopJobs.set('a1', Promise.resolve())
      expect(purge.restarting('a1')).toBe(true)
    })

    it('forgets a deleted conversation\'s lines, search entries and names, and tells every window', () => {
      const { deps, purge } = setup()
      purge.deleted(row())
      expect(deps.mirror.deleteHistory).toHaveBeenCalledWith('s1')
      expect(deps.sessionSearch?.deleteHistory).toHaveBeenCalledWith('s1')
      expect(deps.registry.deleteSavedNames).toHaveBeenCalledWith(['a1', 's1'])
      expect(deps.send).toHaveBeenCalledWith({ type: 'agent_deleted', payload: { agentId: 'a1', retained: false } })
    })

    it('with no session yet, or no search index, forgets only what there is', () => {
      const { deps, purge } = setup({ sessionSearch: null })
      purge.deleted(row())
      expect(deps.mirror.deleteHistory).toHaveBeenCalledWith('s1')
      purge.deleted(row({ sessionId: '' }))
      expect(deps.mirror.deleteHistory).toHaveBeenCalledTimes(1)
      expect(deps.registry.deleteSavedNames).toHaveBeenLastCalledWith(['a1'])
    })
  })

  describe('resume', () => {
    it('goes ahead for an agent no purge holds, with the mode asked for', async () => {
      const { deps, lifecycle } = setup()
      expect(await lifecycle.resumeAgent('a1', 'plan')).toEqual({ ok: true })
      const resume = vi.mocked(createResumeAgentService).mock.results[0].value
      expect(resume).toHaveBeenCalledWith('a1', 'plan')
      expect(deps.stoppedAgents.get).toHaveBeenCalledWith('a1')
    })

    it('waits while the agent is being purged, or while a purge holds its folder', async () => {
      const busy = setup()
      vi.spyOn(busy.lifecycle.purgeAgentService, 'busy').mockReturnValue(true)
      expect(await busy.lifecycle.resumeAgent('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })

      const folder = setup({ stoppedAgents: { list: () => [], get: vi.fn(() => row({ cwd: '/work/tree' })) } as never })
      const blocks = vi.spyOn(folder.lifecycle.purgeAgentService, 'blocksFolder').mockReturnValue(true)
      expect(await folder.lifecycle.resumeAgent('a1')).toEqual({ ok: false, error: 'AGENT_BUSY' })
      expect(blocks).toHaveBeenCalledWith('/work/tree')
      expect(vi.mocked(createResumeAgentService).mock.results[1].value).not.toHaveBeenCalled()
    })
  })
})
