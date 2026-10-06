import { describe, expect, it, vi } from 'vitest'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createAgentList, deviceAgentListItem, deviceAgentRow, type AgentListDeps } from './list.js'

/**
 * `agents_list`, answered by the core: the frames the socket builds, in one order every surface shares,
 * the stopped agents only for a window that asks, a device's rows trimmed to what it draws, and the
 * monitor's readings read outside the connection's ordered requests.
 */
const session = (agentId: string, over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `${agentId}-session`, engine: 'claude', ...over }) as RegisteredSession
/** A frame names its agent, its engine and when it was made: what the list sorts and trims by. */
const frame = (s: RegisteredSession, createdAt: string, status = 'active') =>
  ({ id: s.agentId, name: `${s.agentId} name`, engine: s.engine, createdAt, status, selectedModel: null, userId: 'u' }) as unknown as AgentFrame

function setup(live: RegisteredSession[], saved: RegisteredSession[] = [], over: Partial<AgentListDeps> = {}) {
  const created = new Map<string, string>()
  const deps: AgentListDeps = {
    registry: { advertised: vi.fn(() => live) },
    stoppedAgents: { available: vi.fn(() => saved) },
    toProject: vi.fn(async (s) => frame(s, created.get(s.agentId) ?? '2026-10-05T10:00:00.000Z')),
    toStoppedProject: vi.fn(async (s) => frame(s, created.get(s.agentId) ?? '2026-10-05T10:00:00.000Z', 'stopped')),
    harnessResourcesReader: vi.fn(async () => ({ sampledAt: '2026-10-05T12:00:00.000Z', agents: [] })),
    harnessStorageReader: vi.fn(async () => new Map()),
    monitorActivityProvider: null,
    monitorCompletions: { state: vi.fn(() => 'idle' as const) },
    ...over,
  }
  const replies: Array<Record<string, any>> = []
  const ask = (payload: Record<string, unknown>, role: string | null = 'web') =>
    createAgentList(deps).agentsList(payload, () => role, (result) => { replies.push(result) })
  return { deps, created, replies, ask }
}

describe('the agents a window asks for', () => {
  it('every live agent\'s frame, oldest first, an id breaking a tie, and nothing stopped unless asked for', async () => {
    const [a, b, c] = [session('b-agent'), session('a-agent'), session('c-agent')]
    const { created, replies, ask, deps } = setup([a, b, c], [session('saved')])
    created.set('b-agent', '2026-10-05T10:00:00.000Z')
    created.set('a-agent', '2026-10-05T10:00:00.000Z')
    created.set('c-agent', '2026-10-05T09:00:00.000Z')
    await ask({})
    expect(replies).toHaveLength(1)
    expect(Object.keys(replies[0])).toEqual(['agents'])
    expect(replies[0].agents.map((agent: AgentFrame) => agent.id)).toEqual(['c-agent', 'a-agent', 'b-agent'])
    expect(deps.stoppedAgents.available).not.toHaveBeenCalled()
    expect(deps.toStoppedProject).not.toHaveBeenCalled()
    await ask({ includeStopped: 'yes' })
    expect(deps.stoppedAgents.available).not.toHaveBeenCalled()
  })

  it('the stopped agents a person can resume, when a window asks, beside the live ones', async () => {
    const live = [session('live')]
    const { created, replies, ask, deps } = setup(live, [session('saved')])
    created.set('saved', '2026-10-05T08:00:00.000Z')
    await ask({ includeStopped: true })
    expect(deps.stoppedAgents.available).toHaveBeenCalledWith(live)
    expect(replies[0].agents.map((agent: AgentFrame) => [agent.id, agent.status])).toEqual([['saved', 'stopped'], ['live', 'active']])
  })
})

describe('the agents a device asks for', () => {
  it('only the rows it drives, at most a hundred, each with only what its firmware reads, and never a stopped one', async () => {
    const live = [session('shell', { engine: 'terminal' }), ...Array.from({ length: 105 }, (_, i) => session(`agent-${String(i).padStart(3, '0')}`))]
    const { replies, ask, deps } = setup(live, [session('saved')])
    await ask({ includeStopped: true, monitor: true }, 'device')
    expect(deps.stoppedAgents.available).not.toHaveBeenCalled()
    expect(deps.harnessResourcesReader).not.toHaveBeenCalled()
    expect(replies).toHaveLength(1)
    expect(Object.keys(replies[0])).toEqual(['agents'])
    expect(replies[0].agents).toHaveLength(100)
    expect(replies[0].agents[0]).toStrictEqual({ id: 'agent-000', name: 'agent-000 name', engine: 'claude', selectedModel: null })
    expect(replies[0].agents.some((agent: { id: string }) => agent.id === 'shell')).toBe(false)
  })
})

describe('the monitor\'s readings', () => {
  it('are read after the list is answered for, so they never hold the connection\'s next request', async () => {
    let read!: (value: { sampledAt: string; agents: [] }) => void
    const { replies, ask } = setup([session('live')], [], {
      harnessResourcesReader: vi.fn(() => new Promise<{ sampledAt: string; agents: [] }>((resolve) => { read = resolve })),
    })
    await ask({ monitor: true })
    expect(replies).toEqual([])
    read({ sampledAt: '2026-10-05T12:00:00.000Z', agents: [] })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(Object.keys(replies[0])).toEqual(['agents', 'sharedResources', 'sampledAt'])
  })

  it('each agent\'s activity, processes and storage, in the order they always went out', async () => {
    const working = session('working', { processIdentity: { pid: 4242 } as RegisteredSession['processIdentity'] })
    const finished = session('finished')
    const unread = session('unread')
    const saved = session('saved')
    const activity: Record<string, 'working' | 'idle'> = { 'working-session': 'working', 'finished-session': 'idle', 'unread-session': 'idle' }
    const { created, replies, ask, deps } = setup([working, finished, unread], [saved], {
      harnessResourcesReader: vi.fn(async () => ({
        sampledAt: '2026-10-05T12:00:00.000Z',
        agents: [
          { agentId: 'working', memoryBytes: 123, cpuPercent: 2, processCount: 3, gpuMemoryBytes: 4, gpuPercent: 5,
            diskReadBytesPerSecond: 6, diskWriteBytesPerSecond: 7, processes: [{ pid: 4242, parent: 1, memoryBytes: 123, cpuPercent: 2 }] },
          { agentId: 'finished', memoryBytes: 9, cpuPercent: null, processCount: 1 },
          { agentId: 'saved', memoryBytes: 999, cpuPercent: 99, processCount: null },
        ],
        shared: [{ kind: 'codex' as const, agentIds: ['working'], memoryBytes: 1, cpuPercent: 1, processCount: 1 }],
      })),
      harnessStorageReader: vi.fn(async () => new Map([['working', { workspaceBytes: 10, transcriptBytes: 11 }]]) as never),
      monitorActivityProvider: (sessionId) => activity[sessionId],
      monitorCompletions: { state: vi.fn((s: RegisteredSession) => (s.agentId === 'finished' ? 'done' as const : 'idle' as const)) },
    })
    created.set('working', '2026-10-05T09:00:00.000Z')
    created.set('finished', '2026-10-05T09:01:00.000Z')
    created.set('unread', '2026-10-05T09:02:00.000Z')
    created.set('saved', '2026-10-05T09:03:00.000Z')
    await ask({ monitor: true, includeStopped: true })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(deps.harnessStorageReader).toHaveBeenCalledWith([working, finished, unread, saved])
    const monitor = (id: string) => replies[0].agents.find((agent: AgentFrame) => agent.id === id).monitor
    expect(Object.keys(monitor('working'))).toEqual([
      'activity', 'activityKnown', 'rssBytes', 'cpu', 'pid', 'sampledAt', 'processCount', 'gpuMemoryBytes', 'gpuPercent',
      'diskReadBytesPerSecond', 'diskWriteBytesPerSecond', 'processes', 'workspaceBytes', 'transcriptBytes',
    ])
    expect(monitor('working')).toStrictEqual({
      activity: 'working', activityKnown: true, rssBytes: 123, cpu: 2, pid: 4242, sampledAt: '2026-10-05T12:00:00.000Z',
      processCount: 3, gpuMemoryBytes: 4, gpuPercent: 5, diskReadBytesPerSecond: 6, diskWriteBytesPerSecond: 7,
      processes: [{ pid: 4242, parent: 1, memoryBytes: 123, cpuPercent: 2 }], workspaceBytes: 10, transcriptBytes: 11,
    })
    // Idle by its turns and questions: how its last turn ended. Counted processes, but no process of its own on record.
    expect(monitor('finished')).toMatchObject({ activity: 'done', rssBytes: 9, cpu: null, pid: null, processCount: 1, gpuMemoryBytes: null, processes: [] })
    // Nothing read for it at all.
    expect(monitor('unread')).toMatchObject({ activity: 'idle', rssBytes: null, cpu: null, pid: null, processCount: null })
    // A stopped agent uses nothing, whatever a reading says, and has no turn to report.
    expect(monitor('saved')).toMatchObject({ activity: 'idle', rssBytes: 0, cpu: 0, pid: null })
    expect(replies[0].sharedResources).toEqual([{ kind: 'codex', agentIds: ['working'], memoryBytes: 1, cpuPercent: 1, processCount: 1 }])
    expect(replies[0].sampledAt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('readings that fail read as none, and an activity no one knows reads from the last turn alone', async () => {
    const live = session('live')
    const { replies, ask } = setup([live], [], {
      harnessResourcesReader: vi.fn(async () => { throw new Error('ps failed') }),
      harnessStorageReader: vi.fn(async () => { throw new Error('du failed') }),
      monitorCompletions: { state: vi.fn(() => 'failed' as const) },
    })
    await ask({ monitor: true })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].sharedResources).toEqual([])
    expect(replies[0].sampledAt).toBeNull()
    expect(replies[0].agents[0].monitor).toMatchObject({ activity: 'failed', activityKnown: false, rssBytes: null, sampledAt: null })
  })

  it('a monitor that cannot be put together is answered UNAVAILABLE', async () => {
    const { replies, ask } = setup([session('live')], [], {
      monitorCompletions: { state: vi.fn(() => { throw new Error('broken') }) },
    })
    await ask({ monitor: true })
    await vi.waitFor(() => expect(replies).toEqual([{ error: 'UNAVAILABLE' }]))
  })
})

describe('the device\'s rows', () => {
  it('a name the firmware cannot hold is clipped, by characters and by bytes, with an ellipsis', () => {
    expect(deviceAgentListItem({ id: 'a', name: 'Short name' }).name).toBe('Short name')
    expect(deviceAgentListItem({ id: 'a', name: 'A name far too long for the dial' }).name).toBe('A name far too …')
    // Fifteen characters, but more bytes than the firmware's forty: cut where the bytes run out.
    expect(deviceAgentListItem({ id: 'a', name: '漢字漢字漢字漢字漢字漢字漢字漢' }).name).toBe('漢字漢字漢字漢字漢字漢字…')
  })

  it('keeps the id, a process engine and the model profile, and nothing else', () => {
    expect(deviceAgentListItem(null)).toStrictEqual({ id: undefined })
    expect(deviceAgentListItem({ id: 'a', name: 7, engine: 'terminal', selectedModel: 3, userId: 'secret' })).toStrictEqual({ id: 'a' })
    expect(deviceAgentListItem({ id: 'a', engine: 'codex', selectedModel: 'runtime-v1:s:codex:gpt@high' }))
      .toStrictEqual({ id: 'a', engine: 'codex', selectedModel: 'runtime-v1:s:codex:gpt@high' })
    expect(deviceAgentListItem({ id: 'a', engine: 42, selectedModel: null })).toStrictEqual({ id: 'a', selectedModel: null })
  })

  it('a terminal is no row of a device\'s; anything else is', () => {
    expect(deviceAgentRow({ engine: 'terminal' })).toBe(false)
    expect(deviceAgentRow({ engine: 'claude' })).toBe(true)
    expect(deviceAgentRow(undefined)).toBe(true)
    expect(deviceAgentRow({ engine: 5 })).toBe(true)
  })
})
