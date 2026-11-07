import { describe, expect, it } from 'vitest'
import { personalTasksFor } from './personalTasks.js'
import { readerView } from './views.js'
import { fullSwarm, NOW, owner, peer, outsider } from './fixture.test-support.js'
import * as parts from '../parts/index.js'
import type { Actor } from '../model.js'

function scene() {
  const f = fullSwarm()
  f.edit(s => {
    const member = s.people.find(p => p.id === peer.userId)!
    member.approvalMode = 'review'
    s.people.find(p => p.id === owner.userId)!.approvalMode = 'review'
    Object.assign(s.conversations.find(c => c.id === f.web)!, { requesterId: member.id,
      taskApproval: { personId: member.id, generation: member.generation, state: 'approved', createdAt: NOW - 50 } })
    Object.assign(s.conversations.find(c => c.id === f.secretGroup)!, { requesterId: member.id })
  })
  const stored = parts.split(f.state, { tabId: 'tab', version: 7, now: NOW })
  const view = (actor: Actor = peer) => readerView(stored, actor, NOW, { teamMachines: [] })
  return { f, stored, view }
}

describe('personal Tasks summaries', () => {
  it.each([
    [undefined, false, false],
    [undefined, true, false],
    ['proposal', false, true],
    ['proposal', true, true],
    ['approved', false, false],
    ['rejected', false, false],
  ] as const)('exposes approval capability for decision %s with Buddy proposal %s as %s', (decision, proposal, canApprove) => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!, data = row.data!
    data.assignment = null
    if (decision) data.taskApproval = { ...data.taskApproval!, state: decision }
    else delete data.taskApproval
    if (proposal) data.proposal = { version: 1, text: 'Keep drafts', goal: 'Drafts', why: 'Loss', doneWhen: 'Returns', evidence: ['Repro'], priority: 'P2',
      createdAt: NOW, questions: [], senders: [{ personId: peer.userId, generation: s.f.state.people.find(p => p.id === peer.userId)!.generation }] }
    for (const reset of [true, false])
      expect(personalTasksFor([row], s.view(), peer, reset)!.upserts).toEqual([expect.objectContaining({ id: row.key, canApprove })])
  })
  it.each(['foreign', 'stale'])('never exposes an actionable pending approval for a %s membership', kind => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!, data = row.data!
    data.assignment = null
    data.taskApproval = { ...data.taskApproval!, state: 'proposal',
      ...kind === 'foreign' ? { personId: owner.userId } : { generation: 'previous-membership' } }
    expect(personalTasksFor([row], s.view(), peer, true)!.upserts).toEqual([])
    expect(personalTasksFor([row], s.view(), peer, false)).toMatchObject({ upserts: [], removed: [row.key] })
  })
  it('includes only my visible requested tasks and proposals, with project, assigned identity and execution status', () => {
    const s = scene(), feed = personalTasksFor(s.stored.groups, s.view(), peer, true)!
    expect(feed).toMatchObject({ approvalMode: 'review', reset: true, removed: [] })
    expect(feed.upserts.map(r => r.id)).toEqual(expect.arrayContaining([s.f.web, s.f.secretGroup]))
    expect(feed.upserts.find(r => r.id === s.f.web)).toMatchObject({ version: 7, at: NOW, projectId: 'lead', projectName: 'Pilot',
      title: 'Web', status: 'working', suggested: false, agent: { id: s.f.worker, name: expect.any(String) } })
    expect(feed.upserts.some(r => r.id === s.f.done || r.id === s.f.buddyChat)).toBe(false)
    expect(personalTasksFor(s.stored.groups, s.view(outsider), outsider, true)!.upserts).toEqual([])
    const agent: Actor = { kind: 'agent', agentId: s.f.lead, machineOwnerId: `${owner.userId}-machine` }
    expect(personalTasksFor(s.stored.groups, s.view(agent), agent, true)).toBeUndefined()
  })
  it('shows proposal/rejected, suggested identity and reason, newest first with stable id ties', () => {
    const s = scene(), group = s.stored.groups.find(g => g.key === s.f.web)!
    const data = group.data!
    data.assignment = null
    data.taskApproval = { ...data.taskApproval!, state: 'proposal', suggestedAgentId: s.f.worker }
    const proposal = { ...structuredClone(group), key: 'proposal', changedAt: NOW + 1,
      data: { ...structuredClone(data), id: 'proposal', taskApproval: { ...data.taskApproval!, state: 'rejected' as const, reason: 'Too much scope' } } }
    const feed = personalTasksFor([group, proposal], s.view(), peer, true)!
    expect(feed.upserts.map(r => [r.id, r.status])).toEqual([['proposal', 'rejected'], [s.f.web, 'proposal']])
    expect(feed.upserts[0]).toMatchObject({ reason: 'Too much scope', suggested: true, agent: { id: s.f.worker } })
  })
  it('returns one changed summary or idle empty output; removes archived, reassigned, merged and deleted cards', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!
    expect(personalTasksFor([], s.view(), peer, false)!.upserts).toEqual([])
    expect(personalTasksFor([row], s.view(), peer, false)!.upserts.map(r => r.id)).toEqual([row.key])
    for (const change of [{ archived: true }, { requesterId: owner.userId, taskApproval: undefined }, { dormant: true }]) {
      const changed = { ...row, data: { ...row.data!, ...change } }
      expect(personalTasksFor([changed], s.view(), peer, false)).toMatchObject({ upserts: [], removed: [row.key] })
    }
    expect(personalTasksFor([{ ...row, deleted: true }], s.view(), peer, false)).toMatchObject({ upserts: [], removed: [row.key] })
    expect(personalTasksFor([{ ...row, data: { ...row.data!, proposal: { mergedInto: 'other' } as never } }], s.view(), peer, false))
      .toMatchObject({ upserts: [], removed: [row.key] })
  })
  it('never leaks a hidden project, private chat, hidden agent or stale membership proposal', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.secretGroup)!
    const hidden = s.f.state.agents.find(a => a.projectId === s.f.secret)
    s.stored.head.data!.projects!.find(p => p.id === s.f.secret)!.members = []
    expect(personalTasksFor([row], s.view(), peer, false)).toMatchObject({ upserts: [], removed: [] })
    const web = s.stored.groups.find(g => g.key === s.f.web)!
    web.data!.assignment!.agentId = hidden?.id ?? 'hidden-agent'
    expect(personalTasksFor([web], s.view(), peer, true)!.upserts[0]!.agent).toBeNull()
    web.data!.taskApproval!.generation = 'old-membership'
    expect(personalTasksFor([web], s.view(), peer, true)!.upserts).toEqual([])
  })
  it('shows legacy or Board proposals before a task exists, without duplicate merged mirrors', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!
    delete row.data!.taskApproval
    row.data!.assignment = null
    row.data!.proposal = { version: 1, text: 'Keep drafts', goal: 'Drafts', why: 'Loss', doneWhen: 'Returns', evidence: ['Repro'], priority: 'P2',
      createdAt: NOW, questions: [], senders: [{ personId: peer.userId, generation: s.f.state.people.find(p => p.id === peer.userId)!.generation }] }
    expect(personalTasksFor([row], s.view(), peer, true)!.upserts[0]!.status).toBe('proposal')
    row.data!.proposal.mergedInto = 'prepared-task'
    expect(personalTasksFor([row], s.view(), peer, false)!.removed).toEqual([row.key])
  })
})
