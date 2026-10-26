import { describe, expect, it } from 'vitest'
import { parts } from './partsPort.js'
import { NOW, owner, peer, richSwarm } from './fixture.test-support.js'
import type { SuperTabState } from '../model.js'

const DAY = 86_400_000
/** Ledger records only the store writes (reservations, stop receipts, closing sessions, cleanups), set as the store would. */
function withLedger(state: SuperTabState): SuperTabState {
  const s = structuredClone(state)
  s.harnessReservations = [{ machineId: 'host', harnessId: 'worker-harness', generation: 'g1', renewed: false },
    { machineId: 'other', harnessId: 'gone', generation: 'g2', renewed: true }]
  s.releasedHarnesses = [{ machineId: 'host', harnessId: 'old' }]
  s.closingSessions = [{ agentId: 'removed', machineId: 'closing-only', harnessId: 'h9', machineOwnerId: 'owner-machine' }]
  s.machineCleanups = [{ machineId: 'cleaning', removalId: 'r1', machineOwnerId: 'owner-machine' }]
  s.overlapAlerts = ['a:b']
  return s
}

describe('parts split and reassemble (design 6.1.2 step 3, 6.2)', () => {
  it('reassembles a split Swarm into the same state, ledger and parked groups included', () => {
    const s = richSwarm()
    const state = withLedger(s.state)
    state.parkedConversations = [{ id: 'later', kind: 'future' as never, title: 'Later', leadId: null, agentIds: [], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0 }]
    const split = parts.split(state, { version: 500, now: NOW, lastActivity: new Map() })
    expect(parts.reassemble(split)).toEqual(state)
  })

  it('numbers every part at the tab revision and every group from it, with the sequence base on the head', () => {
    const split = parts.split(richSwarm().state, { version: 500, now: NOW, lastActivity: new Map() })
    const all = [split.head, ...split.members, ...split.agents, ...split.groups, ...split.machines, ...split.starts, ...split.progress]
    expect(new Set(all.map(p => p.version))).toEqual(new Set([500]))
    expect(new Set(split.groups.map(g => g.data!.messageSeq))).toEqual(new Set([500]))
    expect(split.sequenceBase).toBe(500)
    expect(split.epoch).toBe(1)
    expect(split.members.map(m => m.key)).toEqual([owner.userId, peer.userId, 'outsider'])
  })

  it('makes archived groups and finished ones idle for 24 hours dormant, never a Lead conversation', () => {
    const s = richSwarm()
    const worker = { kind: 'agent' as const, agentId: s.worker, machineOwnerId: 'owner-machine' }
    const checkId = s.state.conversations.find(c => c.id === s.web)!.checks[0]!.id
    s.run({ type: 'work.check', conversationId: s.web, assignmentId: s.assignmentId, checkId, passed: true, evidence: 'Ran it' }, worker)
    s.run({ type: 'work.status', conversationId: s.web, assignmentId: s.assignmentId, status: 'done', result: 'Shipped' }, worker)
    s.run({ type: 'conversation.archive', conversationId: s.done, archived: true })
    const idle = new Map([[s.web, NOW - DAY - 1], ['lead', NOW - 10 * DAY]])
    const split = parts.split(s.state, { version: 7, now: NOW, lastActivity: idle })
    const dormant = split.groups.filter(g => g.data!.dormant).map(g => g.key)
    expect(dormant.sort()).toEqual([s.web, s.done].sort())
    expect(split.groups.find(g => g.key === s.web)!.data!.lastActivityAt).toBe(new Date(NOW - DAY - 1).toISOString())
  })

  it('keeps project progress as floors and rebuilds the old revisions from the groups', () => {
    const s = richSwarm()
    const state = structuredClone(s.state)
    const web = state.conversations.find(c => c.id === s.web)!
    web.lastMessageSequence = 40
    state.projects![0]!.progress = { dirtyRevision: 40, summarizedRevision: 30, since: 5, requestedRevision: 35, requestedAt: 6, requestMessageId: 'm' }
    const split = parts.split(state, { version: 50, now: NOW, lastActivity: new Map() })
    expect(split.progress).toEqual([expect.objectContaining({ key: 'lead', data: { since: 5, summarizedFloor: 30, summarized: {},
      requestedFloor: 35, requested: {}, requestedAt: 6, requestMessageId: 'm' } })])
    expect(split.groups.find(g => g.key === s.web)!.data!.reportSeq).toBe(40)
    expect(parts.reassemble(split).projects![0]!.progress).toEqual(state.projects![0]!.progress)
  })
})
