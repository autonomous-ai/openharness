import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createWorkspacesLink } from './workspacesLink.js'

const agent = (agentId = 'a1', over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', cwd: `/h/worktrees/repo/${agentId}`, title: 'Fix the login page', ...over }) as RegisteredSession

function setup(connected = true) {
  const live = [agent('a1'), agent('a2')]
  const stopped = agent('old', { active: false })
  const core = fakeCore({
    agents: {
      live: vi.fn(() => live),
      all: vi.fn(() => [...live, stopped]),
      byAgent: vi.fn((agentId: string) => live.find((session) => session.agentId === agentId)),
    },
  })
  const notify = vi.fn(() => connected)
  const forgetProject = vi.fn()
  const link = createWorkspacesLink(core, notify, forgetProject)
  return { core, notify, forgetProject, link, port: link.port, live, stopped }
}

describe('workspaces in their own process, as the core tells them', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tells the process to name branches with the live agents on each pass, and holds nothing it misses', () => {
    const { notify, port, live } = setup(false)
    port.nameBranches()
    // Not held: the next title pass says it again, with the agents as they are then.
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'nameBranches', agents: live } }]])
  })

  // #4166: the daemon swept clean, week-idle worktrees twice a day, the ones their person chose to keep too. The core
  // never asks the process to sweep.
  it('never tells the process to sweep', () => {
    const { port, core } = setup()
    expect(Object.keys(port)).toEqual(['nameBranches'])
    expect(core.agents.all).not.toHaveBeenCalled()
  })

  it('answers every agent, live then stopped, when an app\'s list or clean of the leftover worktrees starts', () => {
    const { link, live, stopped } = setup()
    expect(link.answer('agents', {})).toEqual({ agents: [...live, stopped] })
  })

  it('sends a renamed agent\'s frame again, read fresh', () => {
    const { link, core, forgetProject, live } = setup()
    expect(link.answer('branchNamed', { agentId: 'a2', requestId: 'q1', query: 'branchNamed' })).toEqual({ synced: true })
    expect(forgetProject).toHaveBeenCalledWith(live[1].cwd)
    expect(core.agents.sync).toHaveBeenCalledWith(live[1])
  })

  it('has no frame to send for an agent that is gone, or one it cannot name; one with no folder is only sent again', () => {
    const { link, core, forgetProject, live } = setup()
    expect(link.answer('branchNamed', { agentId: 'gone' })).toEqual({ synced: false })
    expect(link.answer('branchNamed', { agentId: 7 })).toEqual({ synced: false })
    expect(core.agents.sync).not.toHaveBeenCalled()
    live[0].cwd = undefined as never
    expect(link.answer('branchNamed', { agentId: 'a1' })).toEqual({ synced: true })
    expect(forgetProject).not.toHaveBeenCalled()
    expect(core.agents.sync).toHaveBeenCalledWith(live[0])
  })

  it('refuses a question it does not know', () => {
    expect(setup().link.answer('context', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })
})
