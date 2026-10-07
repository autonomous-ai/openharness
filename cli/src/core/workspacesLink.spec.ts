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
  const lines: string[] = []
  const link = createWorkspacesLink(core, notify, forgetProject, (line) => lines.push(line))
  return { core, notify, forgetProject, lines, link, port: link.port, live, stopped }
}

describe('workspaces in their own process, as the core tells them', () => {
  afterEach(() => vi.restoreAllMocks())

  it('tells the process to name branches with the live agents on each pass, and holds nothing it misses', () => {
    const { notify, port, live } = setup(false)
    port.nameBranches()
    // Not held: the next title pass says it again, with the agents as they are then.
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'nameBranches', agents: live } }]])
  })

  it('tells the process to sweep now, with nothing that could go stale: it asks for the folders in use as it starts', () => {
    const { notify, port, lines, core } = setup()
    port.sweepUnused()
    expect(notify.mock.calls).toEqual([[{ type: 'service_event', payload: { kind: 'sweep' } }]])
    expect(core.agents.all).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })

  it('skips a sweep it decides while the process is not running, and says so: never held for later', () => {
    const { notify, port, lines } = setup(false)
    port.sweepUnused()
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0]).toHaveLength(1)
    expect(lines).toEqual(['[worktrees] sweep skipped: the workspaces process is not running; the next one is on its timer'])
  })

  it('answers the process every agent, live then stopped, when it starts a sweep', () => {
    const { link, live, stopped } = setup()
    expect(link.answer('agents', {})).toEqual({ agents: [...live, stopped] })
  })

  it('lets a failure to list the agents fail the question, so nothing is swept', () => {
    const { link, core } = setup()
    vi.mocked(core.agents.all).mockImplementationOnce(() => { throw new Error('a stopped agent could not be read') })
    expect(() => link.answer('agents', {})).toThrow('a stopped agent could not be read')
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

  it('logs on the console by default', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    createWorkspacesLink(fakeCore(), () => false, vi.fn()).port.sweepUnused()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sweep skipped'))
  })
})
