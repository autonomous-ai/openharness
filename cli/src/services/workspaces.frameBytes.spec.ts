import { describe, expect, it, vi } from 'vitest'
import type { AgentLife, AgentView } from '../core/api.js'
import { agentFrame } from '../lib/agentFrame.js'
import type { AgentProject } from '../lib/agentProject.js'
import type { GitHistory } from '../lib/sessionGitHistory.js'
import type { AgentTokenUsage } from '../lib/agentUsageWire.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWorkspaceFrames } from './workspaceFrames.js'

const fixture = vi.hoisted(() => ({ projects: new Map<string, AgentProject>(), history: { branches: [], pullRequests: [], truncated: false } as GitHistory }))
vi.mock('../lib/agentProject.js', () => ({ agentProject: async (cwd: string) => fixture.projects.get(cwd) ?? null }))
vi.mock('../scm/scmProjects.js', () => ({ describeScmProject: async (cwd: string) => {
  const project = fixture.projects.get(cwd)
  return project ? { kind: project.root ? 'git' : 'none', ...project } : null
} }))
vi.mock('../lib/sessionGitContext.js', async original => {
  const actual = await original<typeof import('../lib/sessionGitContext.js')>()
  return { ...actual, sessionGitContext: (home: AgentProject | null, work: AgentTokenUsage['work'], _read: unknown, history: GitHistory) =>
    actual.sessionGitContext(home, work, async cwd => fixture.projects.get(cwd) ?? null, history) }
})
vi.mock('../lib/sessionGitHistory.js', () => ({ sessionGitHistory: {
  get: async () => structuredClone(fixture.history), observe: async () => structuredClone(fixture.history),
} }))
vi.mock('../lib/transcriptActivity.js', () => ({ transcriptActivityAt: async () => null }))

const at = '2026-11-16T00:00:00.000Z'
const project: AgentProject = { name: 'repo', cwd: '/fixture/repo', root: '/fixture/repo', remote: 'github.com/example/repo', branch: 'main' }
const other = { ...project, cwd: '/fixture/topic', root: '/fixture/topic', branch: 'topic', worktree: true as const }
const row = (name: string, cwd: string): AgentView => ({
  schemaVersion: 2, agentId: name, sessionId: `session-${name}`, engine: 'claude', active: true, cwd, frameEpoch: 'core:1',
  registeredAt: 1, lastHookAt: 0, boundAt: 0, transcriptPath: null, tmuxPane: '%1', primaryRuntimeKey: 'tmux/%1',
  runtimes: [{ backend: 'tmux', paneId: '%1' }], projectDir: '', title: null, model: null,
}) as AgentView

async function frame(source: AgentView, usage?: AgentTokenUsage) {
  let heard!: (event: AgentLife) => void
  let published!: (value: Readonly<Record<string, unknown>>) => void
  const result = new Promise<Readonly<Record<string, unknown>>>(resolve => { published = resolve })
  const core = fakeCore({ agents: {
    byAgent: () => source, follow: listener => { heard = listener; return () => {} }, publishFrame: (_source, fields) => published(fields),
  } })
  core.usage = async () => usage ?? null
  const producer = startWorkspaceFrames(core)
  heard({ kind: 'running', session: source })
  const fields = await result
  producer.stop()
  return agentFrame(source, { selectedModel: null, terminalAvailable: true, tokenUsage: usage, parts: () => fields })
}

describe('Git projection frame bytes preserved from 70b1cdb402eb', () => {
  it.each(['plain', 'repository', 'worktree', 'detached', 'ssh-alias', 'observed-work', 'history'] as const)('%s', async name => {
    fixture.projects.clear()
    fixture.history = { branches: [], pullRequests: [], truncated: false }
    const home = name === 'plain' ? { ...project, root: null, remote: null, branch: null }
      : name === 'worktree' ? other : name === 'detached' ? { ...project, branch: 'Detached 0123456' }
        : name === 'ssh-alias' ? { ...project, remote: 'work-alias/example/repo', repository: 'github.com/example/repo' } : project
    fixture.projects.set(home.cwd, home)
    let usage: AgentTokenUsage | undefined
    if (name === 'observed-work' || name === 'history') {
      fixture.projects.set(other.cwd, other)
      if (name === 'observed-work') usage = { totalTokens: 5, updatedAt: at, work: {
        current: [{ cwd: other.cwd, at }], locations: [{ cwd: other.cwd, at }], pullRequests: [], uncertain: false, truncated: false,
      } }
      else fixture.history = { branches: [{ cwd: other.cwd, remote: other.remote, branch: other.branch!, at }],
        pullRequests: [{ url: 'https://github.com/example/repo/pull/1', cwd: other.cwd, at }], truncated: false }
    }
    const value = await frame(row(name, home.cwd), usage)
    // Epochs are process identities; the public byte comparison excludes only that nondeterminism.
    if (value.gitContext.version) value.gitContext.version = { epoch: 'fixture', revision: 1 }
    expect(JSON.stringify(value)).toMatchSnapshot()
  })
})
