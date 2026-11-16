import { describe, expect, it, vi } from 'vitest'
import { agentFrame } from './agentFrame.js'
import type { RegisteredSession } from './registry.js'

const probes = vi.hoisted(() => ({ git: vi.fn(), history: vi.fn(), scm: vi.fn() }))
vi.mock('./agentProject.js', () => ({ agentProject: probes.git }))
vi.mock('../scm/scmProjects.js', () => ({ describeScmProject: probes.scm }))
vi.mock('./sessionGitHistory.js', () => ({ sessionGitHistory: { get: probes.history, observe: probes.history } }))
vi.mock('./transcriptActivity.js', () => ({ transcriptActivityAt: async () => null }))

const session = (active: boolean) => ({
  schemaVersion: 2, agentId: 'a', sessionId: 's', engine: 'claude', active, registeredAt: 1,
  cwd: '/fixture/repository', tmuxPane: active ? '%1' : '', runtimes: [], primaryRuntimeKey: '',
  transcriptPath: null, title: null, model: null, lastHookAt: 0,
}) as unknown as RegisteredSession

describe('frames before workspaces reports', () => {
  it.each([true, false])('retains a valid launch cwd without inspecting Git, active=%s', async active => {
    const frame = await agentFrame(session(active), { selectedModel: null, terminalAvailable: active })
    expect(frame.project).toEqual({ kind: 'none', name: 'repository', cwd: '/fixture/repository', root: null, remote: null, branch: null })
    expect(frame.gitContext).toEqual({ state: 'unavailable', current: null, observedAt: null, locations: [], pullRequests: [], truncated: false })
    expect(probes.git).not.toHaveBeenCalled()
    expect(probes.history).not.toHaveBeenCalled()
    expect(probes.scm).not.toHaveBeenCalled()
  })

  it('uses a captured service projection without changing the public fields', async () => {
    const project = { kind: 'git', name: 'repository', cwd: '/fixture/repository', root: '/fixture/repository', remote: 'github.com/example/repo', branch: 'main' }
    const gitContext = { state: 'workspace', current: project, observedAt: null, locations: [], pullRequests: [], truncated: false, history: { branches: [], pullRequests: [] } }
    const frame = await agentFrame(session(true), { selectedModel: null, terminalAvailable: true, parts: () => ({ project, gitContext }) })
    expect(JSON.stringify({ project: frame.project, gitContext: frame.gitContext })).toBe(JSON.stringify({ project, gitContext }))
  })
})
