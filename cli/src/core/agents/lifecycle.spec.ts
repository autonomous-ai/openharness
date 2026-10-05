import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PurgeDeps } from '../../lib/purgeAgentService.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createResumeAgentService } from '../../lib/resumeAgentService.js'
import { AgentStopError, createStopAgentService } from '../../lib/stopAgentService.js'
import { createAgentLifecycle, createPurgeRequest, createStopRequest, type LifecycleDeps } from './lifecycle.js'

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
    attachSession: vi.fn(async () => true),
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
      attachSession: deps.attachSession,
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

describe('agent_delete', () => {
  const agents = new Map([['a1', { agentId: 'a1', sessionId: 's1' }], ['pending', { agentId: 'pending', sessionId: '' }]]) as unknown as Map<string, RegisteredSession>
  const request = (stop: (agentId: string) => Promise<void>) => createStopRequest({ byAgent: (id) => agents.get(id), stop })

  it('stops the agent the frame names, by agent id or session id, and says so', async () => {
    const stop = vi.fn(async () => {})
    expect(await request(stop)({ agentId: 'a1' })).toStrictEqual({ deleted: true })
    expect(await request(stop)({ sessionId: 's9' })).toStrictEqual({ deleted: true })
    expect(stop.mock.calls).toEqual([['a1'], ['s9']])
    expect(await request(stop)({})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    expect(stop).toHaveBeenCalledTimes(2)
  })

  it('refuses a stop for a conversation that changed since it was reviewed', async () => {
    const stop = vi.fn(async () => {})
    const changed = await request(stop)({ agentId: 'a1', expectedSessionId: 's0' })
    expect(changed).toStrictEqual({ error: 'SESSION_CHANGED', detail: 'This conversation changed. Refresh and review it before stopping.' })
    expect(Object.keys(changed)).toEqual(['error', 'detail'])
    expect(await request(stop)({ agentId: 'gone', expectedSessionId: 's1' })).toMatchObject({ error: 'SESSION_CHANGED' })
    expect(stop).not.toHaveBeenCalled()
    // The conversation it reviewed: none yet, or the same one.
    expect(await request(stop)({ agentId: 'pending', expectedSessionId: null })).toStrictEqual({ deleted: true })
    expect(await request(stop)({ agentId: 'a1', expectedSessionId: 's1' })).toStrictEqual({ deleted: true })
  })

  it('says a stop it could not confirm was not confirmed, and lets any other failure through', async () => {
    const unconfirmed = await request(async () => { throw new AgentStopError('The process could not be verified.') })({ agentId: 'a1' })
    expect(unconfirmed).toStrictEqual({ error: 'STOP_UNCONFIRMED', detail: 'The process could not be verified.' })
    expect(Object.keys(unconfirmed)).toEqual(['error', 'detail'])
    await expect(request(async () => { throw new Error('tmux gone') })({ agentId: 'a1' })).rejects.toThrow('tmux gone')
  })
})

describe('agent_purge and agent_worktree_delete', () => {
  const OWNER = { owner: true }
  const reviewed = { agentId: 'a1', sessionId: 's1', createdAt: 1234, mode: 'inspect' }
  function setup(service: { request: ReturnType<typeof vi.fn>; worktreeRequest: ReturnType<typeof vi.fn> } | null = {
    request: vi.fn(async () => ({ reviewId: 'review' })), worktreeRequest: vi.fn(async () => ({ reviewId: 'review' })),
  }) {
    const invalidateStorage = vi.fn()
    const replies: Array<Record<string, unknown>> = []
    const purge = createPurgeRequest({ purgeAgentService: () => service as never, invalidateStorage })
    const ask = (type: string, payload: Record<string, unknown>, asker = OWNER) => purge(type, payload, asker, (result) => { replies.push(result) })
    return { service, invalidateStorage, replies, ask }
  }

  it('is the owner\'s alone, and needs a purge service to ask', () => {
    const { service, replies, ask } = setup()
    ask('agent_purge', reviewed, { owner: false })
    expect(replies).toStrictEqual([{ error: 'OWNER_REQUIRED' }])
    expect(service!.request).not.toHaveBeenCalled()
    const none = setup(null)
    none.ask('agent_purge', reviewed)
    expect(none.replies).toStrictEqual([{ error: 'UNSUPPORTED' }])
  })

  it('refuses a request that does not name what was reviewed, or a deletion without its review', () => {
    const { service, replies, ask } = setup()
    for (const wrong of [
      { ...reviewed, agentId: 7 }, { ...reviewed, sessionId: undefined }, { ...reviewed, createdAt: '1234' },
      { ...reviewed, createdAt: Number.NaN }, { ...reviewed, mode: 'erase' }, { ...reviewed, mode: 'describe' },
      { ...reviewed, mode: 'delete' }, { ...reviewed, choices: 'all' }, { ...reviewed, choices: null },
      { ...reviewed, choices: { sessionData: true, worktreeData: 'yes' } }, { ...reviewed, choices: { sessionData: 1, worktreeData: true } },
    ]) ask('agent_purge', wrong)
    expect(replies).toStrictEqual(Array.from({ length: 11 }, () => ({ error: 'INVALID_DELETE_REQUEST' })))
    expect(service!.request).not.toHaveBeenCalled()
  })

  it('hands the purge service exactly what was reviewed and chosen, and answers once it is done', async () => {
    let done!: (result: Record<string, unknown>) => void
    const { service, invalidateStorage, replies, ask } = setup({ request: vi.fn(() => new Promise((resolve) => { done = resolve })), worktreeRequest: vi.fn() })
    ask('agent_purge', { ...reviewed, sessionId: null, mode: 'delete', reviewId: 'review', path: '/reviewed', discardChanges: true,
      includeWorktree: true, choices: { sessionData: false, worktreeData: true }, requestId: 'r' })
    const deletion = service!.request.mock.calls[0][0]
    expect(deletion).toStrictEqual({ agentId: 'a1', sessionId: null, createdAt: 1234, mode: 'delete', reviewId: 'review', path: '/reviewed',
      discardChanges: true, includeWorktree: true, choices: { sessionData: false, worktreeData: true } })
    expect(Object.keys(deletion)).toEqual(['agentId', 'sessionId', 'createdAt', 'mode', 'reviewId', 'path', 'discardChanges', 'includeWorktree', 'choices'])
    expect(replies).toEqual([])
    done({ deleted: true })
    await vi.waitFor(() => expect(replies).toStrictEqual([{ deleted: true }]))
    expect(invalidateStorage).toHaveBeenCalledOnce()
    ask('agent_purge', { ...reviewed, discardChanges: 'yes' })
    expect(service!.request).toHaveBeenLastCalledWith({ ...reviewed, discardChanges: false, includeWorktree: false })
  })

  it('describes, inspects and deletes a worktree through the worktree request, and forgets storage only once something went', async () => {
    const results = [{ worktreeDeleted: true }, { reviewId: 'review' }]
    const { service, invalidateStorage, replies, ask } = setup({ request: vi.fn(), worktreeRequest: vi.fn(async () => results.shift()) })
    ask('agent_worktree_delete', { ...reviewed, mode: 'describe' })
    ask('agent_worktree_delete', reviewed)
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(service!.worktreeRequest.mock.calls.map(([request]) => request.mode)).toEqual(['describe', 'inspect'])
    expect(service!.request).not.toHaveBeenCalled()
    expect(invalidateStorage).toHaveBeenCalledOnce()
  })

  it('says a deletion that failed failed', async () => {
    const { replies, ask } = setup({ request: vi.fn(async () => { throw new Error('disk full') }), worktreeRequest: vi.fn() })
    ask('agent_purge', reviewed)
    await vi.waitFor(() => expect(replies).toStrictEqual([{ error: 'DELETE_FAILED' }]))
  })
})
