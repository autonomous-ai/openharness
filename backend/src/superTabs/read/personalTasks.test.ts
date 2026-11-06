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
    expect(personalTasksFor([row], s.view(), peer)!.upserts).toEqual([expect.objectContaining({ id: row.key, canApprove })])
  })
  it.each(['foreign', 'stale'])('never exposes an actionable pending approval for a %s membership', kind => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!, data = row.data!
    data.assignment = null
    data.taskApproval = { ...data.taskApproval!, state: 'proposal',
      ...kind === 'foreign' ? { personId: owner.userId } : { generation: 'previous-membership' } }
    expect(personalTasksFor([row], s.view(), peer)).toMatchObject({ upserts: [], removed: [row.key] })
  })
  it('includes only my visible requested tasks and proposals, with project, assigned identity and execution status', () => {
    const s = scene(), feed = personalTasksFor(s.stored.groups, s.view(), peer)!
    expect(feed).toMatchObject({ approvalMode: 'review', reset: false })
    expect(feed.upserts.map(r => r.id)).toEqual(expect.arrayContaining([s.f.web, s.f.secretGroup]))
    expect(feed.upserts.find(r => r.id === s.f.web)).toMatchObject({ version: 7, at: NOW, projectId: 'lead', projectName: 'Pilot',
      title: 'Web', status: 'working', suggested: false, agent: { id: s.f.worker, name: expect.any(String) } })
    expect(feed.upserts.some(r => r.id === s.f.done || r.id === s.f.buddyChat)).toBe(false)
    expect(personalTasksFor(s.stored.groups, s.view(outsider), outsider)!.upserts).toEqual([])
    const agent: Actor = { kind: 'agent', agentId: s.f.lead, machineOwnerId: `${owner.userId}-machine` }
    expect(personalTasksFor(s.stored.groups, s.view(agent), agent)).toBeUndefined()
  })
  it('shows proposal/rejected, suggested identity and reason, newest first with stable id ties', () => {
    const s = scene(), group = s.stored.groups.find(g => g.key === s.f.web)!
    const data = group.data!
    data.assignment = null
    data.taskApproval = { ...data.taskApproval!, state: 'proposal', suggestedAgentId: s.f.worker }
    const proposal = { ...structuredClone(group), key: 'proposal', changedAt: NOW + 1,
      data: { ...structuredClone(data), id: 'proposal', lastActivityAt: new Date(NOW + 1).toISOString(), taskApproval: { ...data.taskApproval!, state: 'rejected' as const, reason: 'Too much scope' } } }
    const feed = personalTasksFor([group, proposal], s.view(), peer)!
    expect(feed.upserts.map(r => [r.id, r.status])).toEqual([['proposal', 'rejected'], [s.f.web, 'proposal']])
    expect(feed.upserts[0]).toMatchObject({ reason: 'Too much scope', suggested: true, agent: { id: s.f.worker } })
  })
  it('returns one changed summary or idle empty output; keeps archived and dormant history; removes reassigned, merged and deleted cards', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!
    expect(personalTasksFor([], s.view(), peer)!.upserts).toEqual([])
    expect(personalTasksFor([row], s.view(), peer)!.upserts.map(r => r.id)).toEqual([row.key])
    for (const change of [{ archived: true }, { dormant: true }, { archived: true, dormant: true }])
      expect(personalTasksFor([{ ...row, dormant: true as const, data: { ...row.data!, ...change } }], s.view(), peer))
        .toMatchObject({ upserts: [{ id: row.key, status: 'working' }], removed: [] })
    expect(personalTasksFor([{ ...row, data: { ...row.data!, requesterId: owner.userId, taskApproval: undefined } }], s.view(), peer))
      .toMatchObject({ upserts: [], removed: [row.key] })
    expect(personalTasksFor([{ ...row, deleted: true }], s.view(), peer)).toMatchObject({ upserts: [], removed: [row.key] })
    expect(personalTasksFor([{ ...row, data: { ...row.data!, proposal: { mergedInto: 'other' } as never } }], s.view(), peer))
      .toMatchObject({ upserts: [], removed: [row.key] })
  })

  it('lists what my own agents did, do or are about to do for anyone, by the login they run under, never by machine owner', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.done)!
    const mine = { ...s.f.state.agents.find(a => a.id === s.f.worker)!, id: 'peer-agent', harnessId: 'peer-harness', contributorId: peer.userId }
    const lent = { ...mine, id: 'lent-agent', harnessId: 'lent-harness', contributorId: owner.userId, machineOwnerId: peer.userId }
    const stored = parts.split({ ...s.f.state, agents: [...s.f.state.agents, mine, lent] }, { tabId: 'tab', version: 7, now: NOW })
    const view = readerView(stored, peer, NOW, { teamMachines: [] })
    const work = (agentId: string) => ({ ...s.f.state.conversations.find(c => c.id === s.f.web)!.assignment!, agentId, status: 'done' as const })
    const did = { ...row, dormant: true as const, data: { ...row.data!, requesterId: owner.userId, archived: true, dormant: true, assignment: work(mine.id) } }
    expect(personalTasksFor([did], view, peer)!.upserts).toEqual([expect.objectContaining({ id: row.key, status: 'done', agent: expect.objectContaining({ id: mine.id }) })])
    expect(personalTasksFor([did], view, owner)!.upserts.map(r => r.id)).toEqual([row.key])
    const soon = { ...did, data: { ...did.data, assignment: null, taskApproval: { personId: owner.userId, generation: 'any', state: 'proposal' as const, createdAt: NOW, suggestedAgentId: mine.id } } }
    expect(personalTasksFor([soon], view, peer)!.upserts).toEqual([expect.objectContaining({ id: row.key, suggested: true, canApprove: true })])
    expect(personalTasksFor([{ ...did, data: { ...did.data, assignment: work(lent.id) } }], view, peer)).toMatchObject({ upserts: [], removed: [row.key] })
  })

  it('carries who asked and the newest linked pull request', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!
    row.data!.pullRequestUrls = ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']
    const [task] = personalTasksFor([row], s.view(), peer)!.upserts
    expect(task).toMatchObject({ requester: { id: peer.userId }, pullRequestUrl: 'https://github.com/o/r/pull/2' })
    s.stored.members.find(m => m.key === peer.userId)!.data!.name = 'Peer Person'
    expect(personalTasksFor([row], s.view(), peer)!.upserts[0]!.requester).toEqual({ id: peer.userId, name: 'Peer Person' })
    delete row.data!.pullRequestUrls
    expect(personalTasksFor([row], s.view(), peer)!.upserts[0]).not.toHaveProperty('pullRequestUrl')
  })
  it('never leaks a hidden project, private chat, hidden agent or stale membership proposal', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.secretGroup)!
    const hidden = s.f.state.agents.find(a => a.projectId === s.f.secret)
    s.stored.head.data!.projects!.find(p => p.id === s.f.secret)!.members = []
    expect(personalTasksFor([row], s.view(), peer)).toMatchObject({ upserts: [], removed: [] })
    const web = s.stored.groups.find(g => g.key === s.f.web)!
    web.data!.assignment!.agentId = hidden?.id ?? 'hidden-agent'
    expect(personalTasksFor([web], s.view(), peer)!.upserts[0]!.agent).toBeNull()
    web.data!.taskApproval!.generation = 'old-membership'
    expect(personalTasksFor([web], s.view(), peer)!.upserts).toEqual([])
  })
  it('shows legacy or Board proposals before a task exists, without duplicate merged mirrors', () => {
    const s = scene(), row = s.stored.groups.find(g => g.key === s.f.web)!
    delete row.data!.taskApproval
    row.data!.assignment = null
    row.data!.proposal = { version: 1, text: 'Keep drafts', goal: 'Drafts', why: 'Loss', doneWhen: 'Returns', evidence: ['Repro'], priority: 'P2',
      createdAt: NOW, questions: [], senders: [{ personId: peer.userId, generation: s.f.state.people.find(p => p.id === peer.userId)!.generation }] }
    expect(personalTasksFor([row], s.view(), peer)!.upserts[0]!.status).toBe('proposal')
    row.data!.proposal.mergedInto = 'prepared-task'
    expect(personalTasksFor([row], s.view(), peer)!.removed).toEqual([row.key])
  })
})
