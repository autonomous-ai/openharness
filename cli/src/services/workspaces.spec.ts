import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type WorkspacesPort } from '../core/api.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import type { RegisteredSession } from '../lib/registry.js'
import { sweepWorktrees } from '../lib/worktreeSweep.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWorkspaces } from './workspaces.js'

// Nothing here may touch a real folder or a real repository: the sweep and the rename are fakes.
vi.mock('../lib/worktreeSweep.js', () => ({ sweepWorktrees: vi.fn(async () => []) }))
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
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
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
    it('keeps every folder a live or stopped harness uses, and says how many it removed', async () => {
      vi.mocked(sweepWorktrees).mockResolvedValueOnce(['/h/old-1', '/h/old-2'] as never)
      const { port } = setup([agent({ cwd: '/h/live' })], [agent({ cwd: '/h/live' }), agent({ agentId: 'stopped', cwd: null as never })])
      port.sweepUnused()
      await settle()
      expect(sweepWorktrees).toHaveBeenCalledWith({ root: join(homedir(), 'harnesses'), inUse: ['/h/live', null] })
      expect(console.log).toHaveBeenCalledWith('[worktrees] removed 2 unused worktree(s)')
    })

    it('says nothing when it removed nothing, and nothing when the sweep fails', async () => {
      const { port } = setup()
      port.sweepUnused()
      await settle()
      vi.mocked(sweepWorktrees).mockRejectedValueOnce(new Error('EACCES'))
      port.sweepUnused()
      await settle()
      expect(sweepWorktrees).toHaveBeenCalledTimes(2)
      expect(console.log).not.toHaveBeenCalled()
    })

    it('never runs a second sweep beside one still going, and sweeps again once it is done', async () => {
      let finish: (removed: string[]) => void = () => {}
      vi.mocked(sweepWorktrees).mockImplementationOnce(() => new Promise((done) => { finish = done }))
      const { core, port } = setup([agent({ cwd: '/h/live' })])
      port.sweepUnused()
      port.sweepUnused()
      expect(sweepWorktrees).toHaveBeenCalledTimes(1)
      // Not even asked what is in use: the sweep going on already knows.
      expect(core.agents.all).toHaveBeenCalledTimes(1)
      finish([])
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

    it('does not sweep at all when it cannot list what is in use', () => {
      const { core, port } = setup()
      vi.mocked(core.agents.all).mockImplementationOnce(() => { throw new Error('registry not loaded') })
      port.sweepUnused()
      expect(sweepWorktrees).not.toHaveBeenCalled()
    })
  })
})
