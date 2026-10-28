import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { isLeads, type Agent, type SuperTabState } from './model.js'
import { revokeConditions } from './native.js'
import { canReadAgent, canReadGroup, ownSession, projectsOf, watchClosed } from './projects.js'
import { outsider, owner, peer, richSwarm } from './read/fixture.test-support.js'

/** The revocations as main computed them before item 7 (Diego, 2026-10-28), every check rebuilt on every command: the
 *  reference the shortcut must match exactly. */
function everyCheck(before: SuperTabState, after: SuperTabState): Prisma.SuperTabNativeContextWhereInput[] {
  const conditions: Prisma.SuperTabNativeContextWhereInput[] = []
  for (const member of before.people) {
    const current = after.people.find(p => p.id === member.id)
    if (!current || current.generation !== member.generation || (current.role === 'viewer' && member.role !== 'viewer')) conditions.push({ userId: member.id })
  }
  for (const target of before.agents) {
    const current = after.agents.find(a => a.id === target.id)
    if (!current || current.harnessId !== target.harnessId) conditions.push({ agentId: target.id })
  }
  const session = (a: Agent) => `${a.machineId}\n${a.harnessId}\n${a.machineOwnerId}`
  const now = new Map(after.agents.map(a => [session(a), a]))
  const watchers = (state: SuperTabState, target: Agent) => state.people.map(p => ({ kind: 'person' as const, userId: p.id, email: p.email }))
    .filter(actor => canReadAgent(state, actor, target) && (!watchClosed(state, target) || ownSession(actor, target)))
  for (const target of before.agents) {
    const still = now.get(session(target))
    const is = new Set(still ? watchers(after, still).map(actor => actor.userId) : [])
    const lost = watchers(before, target).filter(actor => !is.has(actor.userId)).map(actor => actor.userId)
    if (lost.length) conditions.push({ agentId: target.id, userId: { in: lost } })
  }
  for (const group of before.conversations) {
    const current = after.conversations.find(c => c.id === group.id)
    if (!current || (current.archived && !group.archived)) conditions.push({ conversationId: group.id })
    else if (!isLeads(current)) {
      for (const member of after.people) {
        const reader = { kind: 'person' as const, userId: member.id, email: member.email }
        if (canReadGroup(before, reader, group) && !canReadGroup(after, reader, current)) conditions.push({ conversationId: group.id, userId: member.id })
      }
      const removed = group.agentIds.filter(id => !current.agentIds.includes(id))
      if (removed.length) conditions.push({ conversationId: group.id, agentId: { in: removed } })
    }
  }
  return conditions
}

describe('which terminals a commit revokes (item 7: only what changed access is checked)', () => {
  // Peer reads the Swarm's public project and is listed on Secret, so every change below takes something from someone.
  function swarm() {
    const s = richSwarm()
    s.edit(state => { project(state, s.secret).members.push({ id: peer.userId, generation: person(state, peer.userId).generation }) })
    const before = structuredClone(s.state)
    return { s, before, revokes: (change: (after: SuperTabState) => void) => {
      const after = structuredClone(before)
      change(after)
      return { got: revokeConditions(before, after), expected: everyCheck(before, after) }
    } }
  }
  const project = (state: SuperTabState, id: string) => projectsOf(state).find(p => p.id === id)!
  const group = (state: SuperTabState, id: string) => state.conversations.find(c => c.id === id)!
  const target = (state: SuperTabState, id: string) => state.agents.find(a => a.id === id)!
  const person = (state: SuperTabState, id: string) => state.people.find(p => p.id === id)!

  it('revokes nothing for a command that changes no access, such as a message', () => {
    const { s, before } = swarm()
    expect(revokeConditions(before, structuredClone(before))).toEqual({ conditions: [], watchersLost: [] })
    const posted = structuredClone(before)
    const web = group(posted, s.web)
    web.messageSeq = (web.messageSeq ?? 0) + 1
    web.lastMessageSequence = web.messageSeq
    web.lastActivityAt = new Date(0).toISOString()
    project(posted, 'lead').progress = { ...project(posted, 'lead').progress!, since: 2 }
    expect(revokeConditions(before, posted).conditions).toEqual([])
  })

  const changes: Array<[string, (after: SuperTabState, ids: ReturnType<typeof swarm>) => void]> = [
    ['a person leaves', after => { after.people = after.people.filter(p => p.id !== peer.userId) }],
    ['a person rejoins (a new generation)', after => { person(after, peer.userId).generation = 'again' }],
    ['a person becomes a viewer', after => { person(after, outsider.userId).role = 'viewer' }],
    ['an agent leaves', (after, { s }) => { after.agents = after.agents.filter(a => a.id !== s.worker) }],
    ['an agent gets a replacement terminal', (after, { s }) => { target(after, s.worker).harnessId = 'replacement' }],
    ['an agent moves to another machine', (after, { s }) => { target(after, s.worker).machineId = 'elsewhere' }],
    ['an agent\'s machine changes hands', (after, { s }) => { target(after, s.worker).machineOwnerId = 'someone-else' }],
    ['an agent turns confidential', (after, { s }) => { target(after, s.worker).confidential = true }],
    ['an agent moves project', (after, { s }) => { target(after, s.worker).projectId = s.secret }],
    ['a project turns private', after => { project(after, 'lead').visibility = 'private' }],
    ['a project drops a member', (after, { s }) => { project(after, s.secret).members = [] }],
    ['a project changes owner', (after, { s }) => { project(after, s.secret).ownerId = outsider.userId }],
    ['a project\'s Lead conversation changes', after => { project(after, 'lead').leadConversationId = 'gone' }],
    ['a Lead is replaced', after => { group(after, 'lead').leadId = null }],
    ['a group is archived', (after, { s }) => { group(after, s.web).archived = true }],
    ['a group is deleted', (after, { s }) => { after.conversations = after.conversations.filter(c => c.id !== s.web) }],
    ['a group turns private', (after, { s }) => { group(after, s.web).audience = { people: [] } }],
    ['an agent leaves a group', (after, { s }) => { group(after, s.web).agentIds = [] }],
    ['a group moves project', (after, { s }) => { group(after, s.web).projectId = s.secret }],
  ]
  it.each(changes)('revokes exactly what every check revokes when %s', (_, change) => {
    const ids = swarm()
    const { got, expected } = ids.revokes(after => change(after, ids))
    expect(expected.length).toBeGreaterThan(0)
    expect(got.conditions).toEqual(expected)
  })

  it('names those who lost an agent, once, for the observers too', () => {
    const ids = swarm()
    const { got } = ids.revokes(after => { target(after, ids.s.worker).confidential = true })
    expect(got.watchersLost).toEqual([{ agentId: ids.s.worker, personIds: [owner.userId, peer.userId, outsider.userId] }])
  })
})
