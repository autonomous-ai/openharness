import { describe, expect, it } from 'vitest'
import type { SuperTabState } from '../model.js'
import { reassemble, split, toLegacyState } from './shape.js'

const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }
const agent = (id: string, machineId: string, projectId = 'p1') => ({ id, projectId, machineId, harnessId: `h-${id}`, machineOwnerId: 'u1',
  contributorId: 'u1', membershipGeneration: 'g1', name: id, displayName: id.toUpperCase(), configuration })
const group = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'p1', title: id, leadId: 'a1', agentIds: ['a1'],
  archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0, pullRequestUrls: [], ...extra })

/** A Swarm as `SuperTab.state` holds it before parts, with a record of every kind. */
function legacy(): SuperTabState {
  return {
    version: 1, id: 'tab1', name: 'Pilot', ownerId: 'u1', environment: 'prod', paused: false,
    leadsConversationId: 'leads', overlapAlerts: ['g2:g3'], retiredConversationNumber: 7,
    projects: [{ id: 'p1', name: 'One', ownerId: 'u1', leadConversationId: 'lead1', visibility: 'public', members: [], updateMinutes: 5,
      progress: { dirtyRevision: 95, summarizedRevision: 90, requestedRevision: 80, since: 111, requestedAt: 222, requestMessageId: 'm1' } }],
    people: [{ id: 'u1', email: 'owner@example.com', role: 'owner', generation: 'g1' }, { id: 'u2', email: 'peer@example.com', role: 'viewer', generation: 'g2' }],
    agents: [agent('a1', 'mac'), agent('a2', 'other')],
    conversations: [
      group('lead1', { lastMessageSequence: 40 }),
      group('g2', { number: 3, lastMessageSequence: 100 }),
      group('g3', { number: 5, lastMessageSequence: 92 }),
      { id: 'leads', kind: 'leads', title: 'Leads', leadId: null, agentIds: ['a1'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
    ],
    parkedConversations: [{ ...group('later'), kind: 'later' as never }],
    invitations: [{ id: 'i1', email: 'x@example.com', role: 'viewer', conversationId: 'lead1', expiresAt: 999 }],
    starts: [{ id: 's1', creationId: 'super-s1', actorKey: 'agent:a1', contributorId: 'u1', membershipGeneration: 'g1', machineOwnerId: 'u1',
      hostGrant: null, harnessId: null, dispatched: false, error: null,
      request: { conversationId: 'g2', machineId: 'mac', engine: 'codex', name: 'B', cwd: '/w', worktree: false,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }],
    machines: [{ machineId: 'mac', name: 'Mac', contributorId: 'u1', membershipGeneration: 'g1', generation: 'op1', cwd: '/w', engines: ['codex'], maxAgents: 2, paused: false }],
    harnessReservations: [{ machineId: 'mac', harnessId: 'h-a1', generation: 'op2', renewed: false }, { machineId: 'other', harnessId: 'h-a2', generation: 'op3', renewed: true }],
    releasedHarnesses: [{ machineId: 'other', harnessId: 'old' }],
    closingSessions: [{ agentId: 'gone', machineId: 'third', harnessId: 'h-gone', machineOwnerId: 'u1' }],
    machineCleanups: [{ machineId: 'removed', removalId: 'r1', machineOwnerId: 'u1' }],
  } as SuperTabState
}

describe('splitting a Swarm into parts', () => {
  it('gives every person, agent, conversation, start and project its own part, and keeps every id', () => {
    const parts = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })
    expect(parts.members.map(p => p.key)).toEqual(['u1', 'u2'])
    expect(parts.agents.map(p => p.key)).toEqual(['a1', 'a2'])
    expect(parts.groups.map(p => p.key)).toEqual(['lead1', 'g2', 'g3', 'leads', 'later'])
    expect(parts.starts.map(p => p.key)).toEqual(['s1'])
    expect(parts.progress.map(p => p.key)).toEqual(['p1'])
    expect([parts.head, ...parts.members, ...parts.groups].every(p => p.version === 500 && p.changedAt === 1000)).toBe(true)
  })

  it('keeps a slot ledger for every machine the Swarm references, contributed or not', () => {
    const machines = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 }).machines
    expect(machines.map(p => p.key)).toEqual(['mac', 'other', 'third', 'removed'])
    expect(machines.map(p => p.data!.contribution?.name ?? null)).toEqual(['Mac', null, null, null])
    expect(machines[1]!.data).toEqual({ machineId: 'other', contribution: null,
      reservations: [{ harnessId: 'h-a2', generation: 'op3', renewed: true }], released: ['old'], closingSessions: [], cleanups: [] })
    expect(machines[2]!.data!.closingSessions).toEqual([{ agentId: 'gone', harnessId: 'h-gone', machineOwnerId: 'u1' }])
    expect(machines[3]!.data!.cleanups).toEqual([{ removalId: 'r1', machineOwnerId: 'u1' }])
  })

  it('keeps the progress out of the head and turns it into a watermark: every group carries its report sequence', () => {
    const parts = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })
    expect((parts.head.data!.projects![0] as Record<string, unknown>).progress).toBeUndefined()
    expect(parts.progress[0]!.data).toEqual({ since: 111, summarizedFloor: 90, summarized: {}, requestedFloor: 80, requested: {},
      requestedAt: 222, requestMessageId: 'm1' })
    // A report counts up to the project's dirty revision; a later notice in the group is not a report.
    expect(Object.fromEntries(parts.groups.map(p => [p.key, p.data!.reportSeq]))).toEqual({ lead1: 0, g2: 95, g3: 92, leads: 0, later: 0 })
  })

  it('numbers its messages and workgroups after everything before the split', () => {
    const parts = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })
    expect(parts.groups.every(p => p.data!.messageSeq === 500)).toBe(true)
    expect(parts.sequenceBase).toBe(500)
    expect(parts.groupCounter).toBe(7)
  })
})

describe('reassembling a Swarm from its parts', () => {
  it('gives back the state it was split from, field by field, in the stored shape', () => {
    expect(toLegacyState(reassemble(split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })))).toEqual(legacy())
  })

  it('keeps the part-only fields commands use', () => {
    const state = reassemble(split(legacy(), { tabId: 'tab1', version: 500, now: 1000 }))
    expect(state.conversations.find(c => c.id === 'g2')).toMatchObject({ messageSeq: 500, reportSeq: 95 })
    expect(state.groupCounter).toBe(7)
    expect(state.sequenceBase).toBe(500)
    expect(state.projects![0]!.progress).toMatchObject({ summarizedFloor: 90, summarized: {} })
  })

  it('leaves out removed parts', () => {
    const parts = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })
    parts.agents[1] = { ...parts.agents[1]!, deleted: true }
    parts.groups[2] = { ...parts.groups[2]!, deleted: true }
    const state = reassemble(parts)
    expect(state.agents.map(a => a.id)).toEqual(['a1'])
    expect(state.conversations.map(c => c.id)).not.toContain('g3')
  })

  it('reports a project dirty again after a rollback when a group posted past what was summarized', () => {
    const parts = split(legacy(), { tabId: 'tab1', version: 500, now: 1000 })
    const state = reassemble(parts)
    const g3 = state.conversations.find(c => c.id === 'g3')!
    g3.reportSeq = 503
    const progress = state.projects![0]!.progress as unknown as { summarized: Record<string, number> }
    progress.summarized = { g2: 501 }
    expect(toLegacyState(state).projects![0]!.progress).toEqual({ dirtyRevision: 503, summarizedRevision: 90, requestedRevision: 80,
      since: 111, requestedAt: 222, requestMessageId: 'm1' })
  })
})
