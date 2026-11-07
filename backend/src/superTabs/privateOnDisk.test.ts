import { describe, expect, it } from 'vitest'
import { actorKey, type AgentStart } from './model.js'
import { applyDiskReport, machineObservationSchema, MEMBER_PROJECTS_CAPABILITY, notePrivateOnDisk, readingOnly, type StoredReading } from './machines.js'
import { mate, NOW, own, swarm, type Swarm } from './taskSessions.test-support.js'

// Task #4543 (spec #4489 section 3, Design 7): a Member's task session on a public task, which outside text can steer, runs
// under its person's own login, so it could open any private project's files Harness put on that computer. The server keeps,
// per computer, the private projects whose clone, chat copy or task worktree Harness put there (`privateOnDisk`), from the
// starts it sends and from what the host reports present, and drops one only when the host reports it gone.

/** A start of mate's on mate's computer in [conversationId], queued as a host would find it. */
function queued(f: Swarm, conversationId: string, extra: Partial<AgentStart['request']> = {}): AgentStart {
  const start: AgentStart = { id: `start-${conversationId}`, creationId: `super-start-${conversationId}`, actorKey: actorKey(mate), contributorId: 'mate',
    membershipGeneration: f.state.people.find(p => p.id === 'mate')!.generation, machineOwnerId: 'mate', hostGrant: null, harnessId: null,
    dispatched: false, error: null, requestedAt: NOW, poolGeneration: 'g1',
    request: { conversationId, machineId: 'mate-mac', engine: 'claude', name: 'Worker', cwd: '/swarm/x', worktree: true,
      requirements: { memoryBytes: 1, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }, ...extra } }
  f.state.starts = [...f.state.starts ?? [], start]
  return start
}
const reading = (f: Swarm, projectsOnDisk?: string[]): StoredReading => ({ ...f.machine().observation!, ...(projectsOnDisk ? { projectsOnDisk } : {}) })

describe('the private projects whose files Harness put on a computer', () => {
  it('gains a private project when the server sends that computer a start in it, and never a public one', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), app = f.project('app')
    notePrivateOnDisk(f.state, queued(f, app.task))
    expect(f.machine().privateOnDisk).toBeUndefined()
    const start = queued(f, secret.task)
    notePrivateOnDisk(f.state, start)
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
    // Sent again (a retried dispatch), it is still listed once.
    notePrivateOnDisk(f.state, start)
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
  })

  it('gains the private projects a Buddy start copies into its chat home, as the server sends it', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), app = f.project('app')
    const chat = f.state.conversations.find(c => c.kind === 'swarm-buddy')!.id
    const start = queued(f, chat, { cwd: '/swarm/.buddy-mate', worktree: false, buddyScope: 'swarm', buddyOf: { personId: 'mate', generation: f.agent(f.buddy).membershipGeneration },
      buddyProjects: [{ id: app.projectId, name: 'app', cwd: '/swarm/a' }, { id: secret.projectId, name: 'secret', cwd: '/swarm/s' }] })
    expect(f.machine().privateOnDisk).toBeUndefined()
    f.run({ type: 'agent.startDispatch', startId: start.id }, mate, own('mate'))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
  })

  it('gains a private project its host reports present, which it made itself from a checkout already there', () => {
    const f = swarm()
    const secret = f.project('secret', 'private'), app = f.project('app')
    applyDiskReport(f.state, f.machine(), reading(f, [app.projectId, secret.projectId, 'not-a-project']))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
  })

  it('loses one only when its host\'s list leaves it out and no start to that computer is still on its way', () => {
    const f = swarm()
    const secret = f.project('secret', 'private')
    const start = queued(f, secret.task)
    notePrivateOnDisk(f.state, start)
    // Reported before its clone was made: kept.
    applyDiskReport(f.state, f.machine(), reading(f, []))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
    start.harnessId = 'h-worker'
    applyDiskReport(f.state, f.machine(), reading(f, [secret.projectId]))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
    // A host from before the list says nothing about it: kept.
    applyDiskReport(f.state, f.machine(), reading(f))
    expect(f.machine().privateOnDisk).toEqual([secret.projectId])
    applyDiskReport(f.state, f.machine(), reading(f, []))
    expect(f.machine().privateOnDisk).toBeUndefined()
  })
})

describe('the host\'s report of its disk and its Members\' set-ups', () => {
  const base = { generation: 'g', resources: { cpuPercent: 1, memoryTotalBytes: 1, memoryUsedBytes: 1, diskFreeBytes: 1, diskTotalBytes: 1,
    projectDiskFreeBytes: 1, deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] }

  it('is bounded: 200 projects on disk, 5 set up per Member', () => {
    expect(machineObservationSchema.safeParse({ ...base, projectsOnDisk: Array.from({ length: 200 }, (_, i) => `p${i}`),
      memberSetUp: { h1: ['a', 'b', 'c', 'd', 'e'] }, capabilities: [MEMBER_PROJECTS_CAPABILITY] }).success).toBe(true)
    expect(machineObservationSchema.safeParse({ ...base, projectsOnDisk: Array.from({ length: 201 }, (_, i) => `p${i}`) }).success).toBe(false)
    expect(machineObservationSchema.safeParse({ ...base, memberSetUp: { h1: ['a', 'b', 'c', 'd', 'e', 'f'] } }).success).toBe(false)
  })

  it('is read in full whenever either list changes', () => {
    const f = swarm()
    const before = { ...reading(f, ['a']), memberSetUp: { h1: ['a'] } }
    expect(readingOnly(before, { ...before })).toBe(true)
    expect(readingOnly(before, { ...before, projectsOnDisk: ['a', 'b'] })).toBe(false)
    expect(readingOnly(before, { ...before, memberSetUp: { h1: ['a', 'b'] } })).toBe(false)
    expect(readingOnly(before, { ...before, memberSetUp: { h1: ['a'], h2: [] } })).toBe(false)
  })
})
