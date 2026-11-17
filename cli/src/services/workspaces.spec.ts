import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type WorkspacesPort } from '../core/api.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import { gitFolderAnswer } from '../lib/gitProjectFolder.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWorkspaces } from './workspaces.js'

// Nothing here may touch a real folder or a real repository: the rename is a fake.
vi.mock('../lib/branchNaming.js', () => ({ nameBranchAfterSession: vi.fn(async () => null) }))
vi.mock('../lib/agentProject.js', () => ({ forgetAgentProject: vi.fn() }))
vi.mock('../lib/gitProjectFolder.js', () => ({ gitFolderAnswer: vi.fn(async () => ({ ok: true, cwd: '/h/harnesses/app' })) }))
const worktrees = vi.hoisted(() => ({
  describeWorkspace: vi.fn(async () => ({ kind: 'folder' as const, path: '/work/tree', canDelete: false, reason: 'Not a worktree.' })),
  reviewWorktree: vi.fn(async () => ({ ok: false as const, reason: 'No separate worktree.' })),
  removeWorktree: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('../lib/worktreeDeletion.js', () => ({ worktreeAnswers: () => worktrees }))
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
    it('a completed rename cannot act after stop or after its session moves', async () => {
      let renamed!: (branch: string) => void
      vi.mocked(nameBranchAfterSession).mockReturnValueOnce(new Promise(resolve => { renamed = resolve }))
      const stopped = setup([agent({})])
      stopped.port.nameBranches()
      stopped.port.stop()
      stopped.port.nameBranches()
      renamed('renamed')
      await settle()
      expect(stopped.core.agents.sync).not.toHaveBeenCalled()
      for (const change of [{ cwd: '/work/other' }, { sessionId: 'other' }]) {
        vi.mocked(nameBranchAfterSession).mockResolvedValueOnce('renamed')
        const moved = setup([agent({})], [], agent(change))
        moved.port.nameBranches()
        await settle()
        expect(moved.core.agents.sync).not.toHaveBeenCalled()
        moved.port.stop()
      }
    })
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

  it('stopping workspaces refuses later instruction preparation', async () => {
    const { port } = setup()
    port.stop()
    expect(await port.prepareInstructions('/work', 'claude')).toBe(false)
  })

  // #4166: it swept clean, week-idle worktrees twice a day when the core said, the ones their person chose to keep too.
  it('removes no worktree on its own: only a purge the core asks for removes one', () => {
    const { core, port } = setup([agent({ cwd: '/h/live' })])
    expect(Object.keys(port)).toEqual(['stop', 'nameBranches', 'ready', 'prepareFolder', 'prepareInstructions', 'describeWorkspace', 'reviewWorktree', 'removeWorktree'])
    expect(core.agents.all).not.toHaveBeenCalled()
    expect(worktrees.removeWorktree).not.toHaveBeenCalled()
  })

  // The audit of 2026-11-12: a clone ran git, ssh and their helpers as children of the core.
  it('does the git of a create and a purge for the core, at once and always', async () => {
    const { port } = setup()
    expect(port.ready()).toBe(true)
    const project = { source: 'worktree' as const, gitSource: '/work/repo' }
    expect(await port.prepareFolder(project, { cloneFallback: true })).toEqual({ ok: true, cwd: '/h/harnesses/app' })
    expect(gitFolderAnswer).toHaveBeenCalledWith(project, { cloneFallback: true })
    const target = { cwd: '/work/tree' }
    expect(await port.describeWorkspace(target, ['/work/other'])).toEqual({ kind: 'folder', path: '/work/tree', canDelete: false, reason: 'Not a worktree.' })
    expect(worktrees.describeWorkspace).toHaveBeenCalledWith(target, ['/work/other'])
    expect(await port.reviewWorktree(target, [])).toEqual({ ok: false, reason: 'No separate worktree.' })
    expect(worktrees.reviewWorktree).toHaveBeenCalledWith(target, [])
    const review = { path: '/work/tree' } as never
    expect(await port.removeWorktree(review, target, [], true)).toEqual({ ok: true })
    expect(worktrees.removeWorktree).toHaveBeenCalledWith(review, target, [], true)
  })

})
