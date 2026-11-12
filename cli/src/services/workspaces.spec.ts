import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type WorkspacesPort } from '../core/api.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import type { RegisteredSession } from '../lib/registry.js'
import { sweepWorktrees, type Swept } from '../lib/worktreeSweep.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWorkspaces } from './workspaces.js'

// Nothing here may touch a real folder or a real repository: the sweep and the rename are fakes.
vi.mock('../lib/worktreeSweep.js', () => ({
  sweepWorktrees: vi.fn(async () => ({ removed: [], freed: [], failed: [], left: 0 })),
  WORKTREE_IDLE_MS: 7 * 24 * 3600_000,
}))
vi.mock('../lib/branchNaming.js', () => ({ nameBranchAfterSession: vi.fn(async () => null) }))
vi.mock('../lib/agentProject.js', () => ({ forgetAgentProject: vi.fn() }))
vi.mock('../lib/registry.js', async (real) => ({
  ...await real<object>(),
  sessionDisplayTitle: vi.fn((s: { title?: string }) => s.title ?? null),
}))

const agent = (over: Partial<RegisteredSession>) => ({ agentId: 'a1', sessionId: 's1', cwd: '/work/tree', title: 'Fix login', ...over }) as RegisteredSession
const settle = () => new Promise((resolve) => setImmediate(resolve))

function setup(live: RegisteredSession[] = [], all: RegisteredSession[] = live, current: RegisteredSession | null = live[0] ?? null) {
  const core = fakeCore({
    agents: { live: vi.fn(() => live), all: vi.fn(() => all), byAgent: vi.fn(() => current ?? undefined), sync: vi.fn() },
  })
  const ports = emptyPorts()
  startWorkspaces(core, ports)
  return { core, port: ports.workspaces as WorkspacesPort }
}

describe('the workspaces service', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  describe('naming made-up branches after their sessions', () => {
    it('renames once per agent, then forgets the cached project and re-sends the agent\'s frame', async () => {
      vi.mocked(nameBranchAfterSession).mockResolvedValueOnce('fix-login')
      const { core, port } = setup([agent({})])
      port.nameBranches()
      await settle()
      expect(nameBranchAfterSession).toHaveBeenCalledWith('/work/tree', 'Fix login')
      expect(console.log).toHaveBeenCalledWith('[worktrees] agent a1 branch named fix-login')
      expect(forgetAgentProject).toHaveBeenCalledWith('/work/tree')
      expect(core.agents.sync).toHaveBeenCalledWith(agent({}))
      port.nameBranches()
      expect(nameBranchAfterSession).toHaveBeenCalledTimes(1)
    })

    it('leaves alone a branch that keeps its name, and an agent that left meanwhile', async () => {
      const kept = setup([agent({})])
      kept.port.nameBranches()
      await settle()
      expect(forgetAgentProject).not.toHaveBeenCalled()
      vi.mocked(nameBranchAfterSession).mockResolvedValueOnce('fix-login')
      const gone = setup([agent({})], [], null)
      gone.port.nameBranches()
      await settle()
      expect(forgetAgentProject).toHaveBeenCalled()
      expect(gone.core.agents.sync).not.toHaveBeenCalled()
    })

    it('waits for a title and a folder, and survives a rename that fails', async () => {
      vi.mocked(nameBranchAfterSession).mockRejectedValueOnce(new Error('not a git repo'))
      const { port } = setup([agent({ agentId: 'untitled', title: undefined }), agent({ agentId: 'nowhere', cwd: undefined }), agent({})])
      port.nameBranches()
      await settle()
      expect(nameBranchAfterSession).toHaveBeenCalledTimes(1)
      expect(nameBranchAfterSession).toHaveBeenCalledWith('/work/tree', 'Fix login')
    })
  })

  describe('sweeping unused worktrees', () => {
    const DAY = 24 * 3600_000
    /** What the service asked the sweep, the last time. */
    const asked = () => vi.mocked(sweepWorktrees).mock.calls.at(-1)![0] as unknown as { root: string; inUse: unknown[]; busy: () => unknown[] }

    it('keeps every folder a live or stopped harness uses, and says how many it removed', async () => {
      vi.mocked(sweepWorktrees).mockResolvedValueOnce({ removed: ['/h/old-1', '/h/old-2'], freed: [], failed: [], left: 0 })
      const { port } = setup([agent({ cwd: '/h/live' })], [agent({ cwd: '/h/live' }), agent({ agentId: 'stopped', cwd: null as never })])
      port.sweepUnused()
      await settle()
      expect(asked()).toMatchObject({ root: join(homedir(), 'harnesses'), inUse: ['/h/live', null] })
      expect(console.log).toHaveBeenCalledWith('[worktrees] removed 2 unused worktree(s)')
      expect(console.log).toHaveBeenCalledTimes(1)
      expect(console.warn).not.toHaveBeenCalled()
    })

    // Review of package 6, 11-12: a harness that worked in a folder yesterday and stopped without a commit left its work in the
    // folder alone, and it may be resumed there. A stopped harness's record was last written when it stopped.
    it('keeps build output where a harness runs, and where one stopped within the week', () => {
      const now = Date.now()
      const live = agent({ agentId: 'live', cwd: '/h/live', touchedAt: now - 30 * DAY })
      const { port } = setup([live], [live,
        agent({ agentId: 'yesterday', cwd: '/h/yesterday', touchedAt: now - DAY }),
        agent({ agentId: 'last-month', cwd: '/h/last-month', touchedAt: now - 30 * DAY }),
        agent({ agentId: 'unknown', cwd: '/h/unknown', touchedAt: undefined as never })])
      port.sweepUnused()
      expect(asked().inUse).toEqual(['/h/live', '/h/yesterday', '/h/last-month', '/h/unknown'])
      expect(asked().busy()).toEqual(['/h/live', '/h/yesterday', '/h/unknown', '/h/live'])
    })

    // Review of package 6, 11-12: a sweep takes minutes, and a harness may start meanwhile where it has not been yet.
    it('names the running harnesses again each time the sweep asks, and keeps those that ran when it began', () => {
      const first = agent({ agentId: 'first', cwd: '/h/first', touchedAt: 0 })
      const { core, port } = setup([first], [first])
      port.sweepUnused()
      vi.mocked(core.agents.live).mockReturnValue([agent({ agentId: 'started', cwd: '/h/started' })])
      expect(asked().busy()).toEqual(['/h/first', '/h/started'])
      vi.mocked(core.agents.live).mockImplementation(() => { throw new Error('registry not loaded') })
      expect(() => asked().busy()).toThrow('registry not loaded')
    })

    it('says how many build folders it freed, each failure by its code, and how many wait for the next sweep, without a path', async () => {
      vi.mocked(sweepWorktrees).mockResolvedValueOnce({ removed: [], freed: ['/h/idle/node_modules', '/h/idle/app/.dart_tool', '/h/other/node_modules'],
        failed: ['BUILD_OUTPUT_STUCK:EBUSY', 'WORKTREE_NOT_REMOVED', 'BUILD_OUTPUT_STUCK:EBUSY'], left: 2 })
      const { port } = setup()
      port.sweepUnused()
      await settle()
      expect(vi.mocked(console.log).mock.calls).toEqual([
        ['[worktrees] freed 3 build folder(s) in idle worktrees'],
        ['[worktrees] stopped at its limit: 2 worktree(s) wait for the next sweep'],
      ])
      expect(vi.mocked(console.warn).mock.calls).toEqual([['[worktrees] left as they were: BUILD_OUTPUT_STUCK:EBUSY 2, WORKTREE_NOT_REMOVED 1']])
    })

    it('says nothing when it did nothing, and says so when the sweep failed', async () => {
      const { port } = setup()
      port.sweepUnused()
      await settle()
      expect(console.log).not.toHaveBeenCalled()
      expect(console.warn).not.toHaveBeenCalled()
      vi.mocked(sweepWorktrees).mockRejectedValueOnce(new Error('EACCES'))
      port.sweepUnused()
      await settle()
      expect(sweepWorktrees).toHaveBeenCalledTimes(2)
      expect(console.log).not.toHaveBeenCalled()
      expect(vi.mocked(console.warn).mock.calls).toEqual([['[worktrees] SWEEP_FAILED']])
    })

    it('never runs a second sweep beside one still going, and sweeps again once it is done', async () => {
      let finish: (swept: Swept) => void = () => {}
      vi.mocked(sweepWorktrees).mockImplementationOnce(() => new Promise((done) => { finish = done }))
      const { core, port } = setup([agent({ cwd: '/h/live' })])
      port.sweepUnused()
      port.sweepUnused()
      expect(sweepWorktrees).toHaveBeenCalledTimes(1)
      // Not even asked what is in use: the sweep going on already knows.
      expect(core.agents.all).toHaveBeenCalledTimes(1)
      finish({ removed: [], freed: [], failed: [], left: 0 })
      await settle()
      port.sweepUnused()
      expect(sweepWorktrees).toHaveBeenCalledTimes(2)
    })

    it('sweeps again after a sweep that failed', async () => {
      vi.mocked(sweepWorktrees).mockRejectedValueOnce(new Error('EACCES'))
      const { port } = setup()
      port.sweepUnused()
      await settle()
      port.sweepUnused()
      expect(sweepWorktrees).toHaveBeenCalledTimes(2)
    })

    it('does not sweep at all when it cannot list what is in use, or which of it is live', () => {
      const { core, port } = setup()
      vi.mocked(core.agents.all).mockImplementationOnce(() => { throw new Error('registry not loaded') })
      port.sweepUnused()
      vi.mocked(core.agents.live).mockImplementationOnce(() => { throw new Error('registry not loaded') })
      port.sweepUnused()
      expect(sweepWorktrees).not.toHaveBeenCalled()
    })
  })
})
