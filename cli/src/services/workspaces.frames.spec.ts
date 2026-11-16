import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type AgentLife, type AgentView } from '../core/api.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startWorkspaces } from './workspaces.js'

const reads = vi.hoisted(() => ({ project: vi.fn(), describe: vi.fn(), context: vi.fn(), get: vi.fn(), observe: vi.fn(), rename: vi.fn(async () => null) }))
vi.mock('../lib/agentProject.js', () => ({ agentProject: reads.project }))
vi.mock('../scm/scmProjects.js', () => ({ describeScmProject: reads.describe, renameScmProject: reads.rename, forgetScmProject: vi.fn() }))
vi.mock('../lib/sessionGitContext.js', async original => ({ ...await original<object>(), sessionGitContext: reads.context }))
vi.mock('../lib/sessionGitHistory.js', () => ({ sessionGitHistory: { get: reads.get, observe: reads.observe } }))
vi.mock('../lib/gitProjectFolder.js', () => ({ gitFolderAnswer: vi.fn() }))
vi.mock('../lib/worktreeDeletion.js', () => ({ worktreeAnswers: () => ({}) }))

const row = (over: Partial<AgentView> = {}): AgentView => ({ agentId: 'a', sessionId: 's', engine: 'claude', cwd: '/fixture/repo', active: true, registeredAt: 1, frameEpoch: 'core:1', ...over }) as AgentView
const project = { name: 'repo', cwd: '/fixture/repo', root: '/fixture/repo', remote: 'github.com/example/repo', branch: 'main' }
const history = { branches: [], pullRequests: [] }
const context = { state: 'workspace', current: project, observedAt: null, locations: [], pullRequests: [], truncated: false }
const stops: Array<() => void> = []
function setup() {
  let hear!: (event: AgentLife) => void
  const live = new Map<string, AgentView>()
  const publish = vi.fn(), usage = vi.fn(async () => ({ totalTokens: 3, updatedAt: '2026-11-16', work: { current: null, uncertain: false, locations: [], pullRequests: [], truncated: false } }))
  const follow = vi.fn((listener: (event: AgentLife) => void) => { hear = listener; return vi.fn() })
  const core = fakeCore({ agents: { follow, publishFrame: publish, live: () => [...live.values()], byAgent: id => live.get(id) } })
  core.usage = usage
  const ports = emptyPorts()
  startWorkspaces(core, ports)
  stops.push(() => ports.workspaces?.stop())
  return { core, ports, publish, usage, follow, live, hear: (event: AgentLife) => {
    if (event.kind === 'running') live.set(event.session.agentId, event.session)
    else if (event.kind === 'ended' || event.kind === 'purged') live.delete(event.agentId)
    hear(event)
  } }
}

beforeEach(() => {
  reads.project.mockResolvedValue(project); reads.describe.mockResolvedValue({ kind: 'git', ...project })
  reads.get.mockResolvedValue(history); reads.observe.mockResolvedValue(history); reads.context.mockImplementation(async () => ({ ...context }))
})
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('workspaces frame facts', () => {
  it('follows captured leases and publishes the existing project, observed work and full history shapes', async () => {
    const service = setup()
    expect(service.follow).toHaveBeenCalledWith(expect.any(Function), { each: true, frames: true })
    const source = row()
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledOnce())
    expect(service.usage).toHaveBeenCalledWith(source)
    expect(reads.context).toHaveBeenCalledWith(project, (await service.usage.mock.results[0]!.value).work, undefined, history)
    expect(service.publish.mock.calls[0]![0]).toEqual(source)
    expect(service.publish.mock.calls[0]![1]).toMatchObject({ project: { kind: 'git', ...project }, gitContext: { ...context, history, version: { epoch: expect.any(String), revision: 1 } } })
  })

  it('coalesces repeated observations and preserves the fifteen-second refresh without a timer', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const service = setup(), source = row()
    service.hear({ kind: 'running', session: source })
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledOnce())
    service.hear({ kind: 'running', session: source })
    expect(reads.project).toHaveBeenCalledOnce()
    now.mockReturnValue(16_000)
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledTimes(2))
    expect(service.publish.mock.calls[1]![1]).toEqual(service.publish.mock.calls[0]![1])
  })

  it.each([{ cwd: '/fixture/other' }, { sessionId: 'next' }, { frameEpoch: 'core:2' }])('revokes older async work after %j changes', async change => {
    const held = deferred<typeof project>()
    reads.project.mockReturnValueOnce(held.promise)
    const service = setup(), source = row()
    service.hear({ kind: 'running', session: source })
    service.hear({ kind: 'running', session: row(change) })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledOnce())
    held.resolve(project)
    await vi.waitFor(() => expect(reads.project).toHaveBeenCalledTimes(2))
    expect(reads.observe).toHaveBeenCalledOnce()
    expect(service.publish.mock.calls[0]![0]).toMatchObject(change)
  })

  it.each(['ended', 'purged', 'stop', 'changed-row'] as const)('revokes pending observations on %s before history writes', async kind => {
    const held = deferred<typeof context>()
    reads.context.mockReturnValueOnce(held.promise)
    const service = setup(), source = row()
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(reads.context).toHaveBeenCalledOnce())
    if (kind === 'stop') service.ports.workspaces!.stop()
    else if (kind === 'changed-row') source.cwd = '/fixture/rebound'
    else service.hear(kind === 'purged' ? { kind, agentId: 'a', sessionIds: ['s'] } : { kind, agentId: 'a' })
    held.resolve({ ...context })
    await held.promise
    await Promise.resolve(); await Promise.resolve()
    expect(reads.observe).not.toHaveBeenCalled()
    expect(service.publish).not.toHaveBeenCalled()
  })

  it('does no Git work for older cores, stopped services or unrelated lifecycle events', () => {
    const service = setup()
    service.hear({ kind: 'running', session: row({ frameEpoch: undefined }) })
    service.hear({ kind: 'stopped', agentId: 'a' })
    service.hear({ kind: 'taken', from: 'a', to: 'b' })
    service.ports.workspaces!.stop()
    service.hear({ kind: 'running', session: row() })
    expect(reads.project).not.toHaveBeenCalled()
  })

  it('reports failures without paths or content and retries on the next freshness interval', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    reads.project.mockRejectedValueOnce(new Error('/private/customer/secret'))
    const service = setup(), source = row()
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('[workspaces] WORKSPACE_FACTS_UNAVAILABLE'))
    now.mockReturnValue(16_000)
    service.hear({ kind: 'running', session: source })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledOnce())
  })

  it('keeps at most four inspections running and 512 pending or cached observations', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const held = deferred<typeof project>()
    reads.project.mockReturnValue(held.promise)
    const service = setup()
    for (let i = 0; i < 514; i++) service.hear({ kind: 'running', session: row({ agentId: `agent-${i}` }) })
    expect(reads.project).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledExactlyOnceWith('[workspaces] WORKSPACE_FACTS_LIMIT')
    held.resolve(project)
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledTimes(512))
    service.hear({ kind: 'running', session: row({ agentId: 'new' }) })
    await vi.waitFor(() => expect(service.publish).toHaveBeenCalledTimes(513))
  })

  it('works without a usage provider and safely retires a service with no publication door', async () => {
    const service = setup()
    service.core.usage = undefined
    service.core.agents.publishFrame = undefined
    service.hear({ kind: 'running', session: row() })
    await vi.waitFor(() => expect(reads.observe).toHaveBeenCalledOnce())
    expect(reads.context).toHaveBeenCalledWith(project, undefined, undefined, history)
    expect(service.publish).not.toHaveBeenCalled()
  })
})
