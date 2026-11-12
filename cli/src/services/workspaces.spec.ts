import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type WorkspacesPort } from '../core/api.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { nameBranchAfterSession } from '../lib/branchNaming.js'
import type { RegisteredSession } from '../lib/registry.js'
import { cleanWorktrees, listLeftoverWorktrees } from '../lib/leftoverWorktrees.js'
import { systemTrash } from '../lib/trash.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CLEAN_MAX, startWorkspaces, WORKSPACES_REQUESTS } from './workspaces.js'

// Nothing here may touch a real folder or a real repository: the rename, the list and the clean are fakes.
vi.mock('../lib/branchNaming.js', () => ({ nameBranchAfterSession: vi.fn(async () => null) }))
vi.mock('../lib/agentProject.js', () => ({ forgetAgentProject: vi.fn() }))
vi.mock('../lib/leftoverWorktrees.js', () => ({ listLeftoverWorktrees: vi.fn(async () => ({ worktrees: [], more: false })), cleanWorktrees: vi.fn(async () => []) }))
// Never the person's real Trash.
const theTrash = vi.hoisted(() => async () => {})
vi.mock('../lib/trash.js', () => ({ systemTrash: vi.fn(() => theTrash) }))
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
  const requests = startWorkspaces(core, ports)
  return { core, port: ports.workspaces as WorkspacesPort, requests }
}

const OWNER = { local: true, owner: true }

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

  // #4166: it swept clean, week-idle worktrees twice a day when the core said, the ones their person chose to keep too.
  it('removes no worktree: its one call names branches', () => {
    const { core, port } = setup([agent({ cwd: '/h/live' })])
    expect(Object.keys(port)).toEqual(['nameBranches'])
    expect(core.agents.all).not.toHaveBeenCalled()
  })

  describe('the leftover worktrees, for the person to choose from', () => {
    const root = join(homedir(), 'harnesses')

    it('answers exactly the requests it declares, and only for the owner', async () => {
      const { requests } = setup()
      expect(Object.keys(requests)).toEqual([...WORKSPACES_REQUESTS])
      for (const type of WORKSPACES_REQUESTS) expect(await requests[type]({ paths: ['/x'] }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(listLeftoverWorktrees).not.toHaveBeenCalled()
      expect(cleanWorktrees).not.toHaveBeenCalled()
    })

    it('lists the worktrees no live or stopped harness uses, read as the request arrives', async () => {
      const listed = { worktrees: [{ path: '/h/w/app/old' }], more: false }
      vi.mocked(listLeftoverWorktrees).mockResolvedValueOnce(listed as never)
      const { requests } = setup([agent({ cwd: '/h/live' })], [agent({ cwd: '/h/live' }), agent({ agentId: 'stopped', cwd: null as never })])
      expect(await requests.worktrees_list({}, OWNER)).toEqual(listed)
      expect(listLeftoverWorktrees).toHaveBeenCalledWith({ root, inUse: ['/h/live', null] })
    })

    it('moves the chosen ones to the system\'s Trash, and says what became of each', async () => {
      const results = [{ path: '/h/w/app/a', state: 'trashed', pruned: true }, { path: '/h/w/app/b', state: 'in_use' }, { path: '/h/w/app/c', state: 'failed', reason: 'TRASH_DECLINED' }]
      vi.mocked(cleanWorktrees).mockResolvedValueOnce(results as never)
      const { requests } = setup([agent({ cwd: '/h/w/app/b' })])
      const paths = ['/h/w/app/a', '/h/w/app/b', '/h/w/app/c']
      expect(await requests.worktrees_clean({ paths }, OWNER)).toEqual({ results })
      expect(cleanWorktrees).toHaveBeenCalledWith({ root, inUse: ['/h/w/app/b'], paths, trash: theTrash })
      expect(systemTrash).toHaveBeenCalledWith()
      expect(console.log).toHaveBeenCalledWith('[worktrees] 1 of 3 moved to the Trash · kept: in_use, TRASH_DECLINED')
      vi.mocked(cleanWorktrees).mockResolvedValueOnce([results[0]] as never)
      await requests.worktrees_clean({ paths: ['/h/w/app/a'] }, OWNER)
      expect(console.log).toHaveBeenLastCalledWith('[worktrees] 1 of 1 moved to the Trash')
    })

    it('refuses a clean that names no worktree, too many, or something that is not a path', async () => {
      const { requests } = setup()
      for (const paths of [undefined, 'one', [], Array.from({ length: CLEAN_MAX + 1 }, (_, n) => `/h/${n}`), ['/h/a', 7]]) {
        expect(await requests.worktrees_clean({ paths }, OWNER)).toEqual({ error: 'INVALID_PATHS' })
      }
      expect(cleanWorktrees).not.toHaveBeenCalled()
    })

    it('acts on none when it cannot list the folders in use', async () => {
      const { core, requests } = setup()
      vi.mocked(core.agents.all).mockImplementation(() => { throw new Error('registry not loaded') })
      expect(await requests.worktrees_list({}, OWNER)).toEqual({ error: 'WORKTREES_UNAVAILABLE' })
      expect(await requests.worktrees_clean({ paths: ['/h/a'] }, OWNER)).toEqual({ error: 'WORKTREES_UNAVAILABLE' })
      expect(listLeftoverWorktrees).not.toHaveBeenCalled()
      expect(cleanWorktrees).not.toHaveBeenCalled()
    })
  })
})
