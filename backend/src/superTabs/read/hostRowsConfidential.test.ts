import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../../lib/ssoAuth.js'
import type { Actor, Conversation, SuperTabState } from '../model.js'
import { canWatchAgent, isConfidential, watchClosed, watchersLost } from '../projects.js'
import { hostTab, type HostLookups } from './hostRows.js'
import { owner, swarm } from './fixture.test-support.js'

// Task #4504 (Ken's prod scan, 11-07 16:20 VN): the host roster asked canWatchAgent for each person on each agent, and every
// call built confidentialSets with a pass over all the Swarm's conversations, so a read cost agents x people x conversations
// (1.6 s of self time per 30 s profile at 16h, and growing with tab data). A read now builds the sets once.

const user = { sub: owner.userId, email: owner.email } as AuthUser
const personId = (i: number) => `2000000000000000000${String(i).padStart(5, '0')}`

/** A Swarm of [people] people, [agents] agents on the owner's machine `host` and [conversations] conversations, with every kind
 *  of confidential session: the Lead, members of private conversations, a marked one, a Team account's, and a private project
 *  only some people read. */
function seeded({ people, agents, conversations }: { people: number; agents: number; conversations: number }) {
  const s = swarm()
  const persons = Array.from({ length: people }, (_, i) => ({ kind: 'person' as const, userId: personId(i), email: `p${i}@example.com` }))
  for (const person of persons) s.join(person)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  s.run({ type: 'project.sharing', projectId: secret, visibility: 'private', memberIds: persons.filter((_, i) => i % 3 === 0).map(p => p.userId) })
  const web = s.group('Web'), hidden = s.group('Hidden', secret)
  const ids = [s.add('lead-harness', 'lead', true, owner, 'host', owner.userId)]
  for (let i = 1; i < agents; i++) ids.push(s.add(`h${i}`, i % 4 === 0 ? hidden : web, false, owner, 'host', owner.userId))
  s.edit(state => {
    const template = state.conversations.find(c => c.id === web)!
    for (let i = state.conversations.length; i < conversations; i++) {
      const members = [ids[(i * 7) % ids.length]!, ids[(i * 11) % ids.length]!]
      const row: Conversation = { ...structuredClone(template), id: `bulk-${i}`, number: 1000 + i, title: `Task ${i}`, agentIds: members, assignment: null }
      // Every tenth one private, with an audience of two people.
      if (i % 10 === 0) row.audience = { people: [persons[i % people]!, persons[(i + 1) % people]!].map(p => ({ id: p.userId, generation: 'g' })) }
      state.conversations.push(row)
    }
    state.agents.find(a => a.id === ids[2 % ids.length])!.confidential = true
    state.agents.find(a => a.id === ids[3 % ids.length])!.teamAccount = true
  })
  const lookups = (confidential: string[] = []): HostLookups => ({
    people: [{ id: owner.userId, email: owner.email }, ...persons.map(p => ({ id: p.userId, email: p.email }))],
    confidential: new Set(confidential), agentGrant: async () => {}, teams: [], githubApp: false,
  })
  return { state: s.state, persons, ids, lookups }
}

/** How often a read looks at whether a conversation is private: once per conversation for one build of the sets. */
function countingAudienceReads(state: SuperTabState): { state: SuperTabState; reads: () => number } {
  let reads = 0
  const conversations = state.conversations.map(c => new Proxy(c, {
    get: (target, key, receiver) => { if (key === 'audience') reads++; return Reflect.get(target, key, receiver) },
  }))
  return { state: { ...state, conversations }, reads: () => reads }
}

describe('the host roster\'s confidential sets (task #4504)', () => {
  it('are built once per read: the passes over conversations do not grow with agents or people', async () => {
    const passes = async (people: number, agents: number) => {
      const { state, lookups } = seeded({ people, agents, conversations: 200 })
      const counted = countingAudienceReads(state)
      await hostTab('tab', counted.state, 'host', user, null, lookups())
      return counted.reads() / counted.state.conversations.length
    }
    const small = await passes(1, 2)
    expect(small).toBeLessThanOrEqual(1)
    expect(await passes(20, 2)).toBe(small)
    expect(await passes(1, 20)).toBe(small)
    expect(await passes(20, 20)).toBe(small)
  })

  it('give every reader exactly the answers each check gave on its own', async () => {
    const { state, ids, lookups } = seeded({ people: 12, agents: 16, conversations: 120 })
    const elsewhere = [ids[5]!]
    const rows = (await hostTab('tab', state, 'host', user, null, lookups(elsewhere))).roster.flatMap(r => 'agent' in r && 'observers' in r ? [r] : [])
    expect(rows.length).toBe(ids.length)
    const people = lookups().people
    for (const row of rows) {
      const target = state.agents.find(a => a.id === row.agent.id)!
      const closed = elsewhere.includes(target.id)
      expect(row.observers, target.id).toEqual(people.filter(p => p.id !== user.sub
        && canWatchAgent(state, { kind: 'person', userId: p.id, email: p.email }, target, closed)).map(p => ({ email: p.email, userId: p.id })))
      expect(row.confidential, target.id).toBe(isConfidential(state, target, closed))
      expect(row.membersWatch, target.id).toBe(isConfidential(state, target, closed) && !watchClosed(state, target, closed))
    }
    // The seeded store holds both answers, so the comparison means something.
    expect(rows.some(r => r.confidential) && rows.some(r => !r.confidential)).toBe(true)
    expect(rows.some(r => r.observers.length > 0) && rows.some(r => r.observers.length < people.length - 1)).toBe(true)
  })
})

describe('who loses the watch of an agent after a commit (task #4504)', () => {
  /** watchersLost as it read before: canWatchAgent for each person on each agent, each building its own sets. */
  function naiveLost(before: SuperTabState, after: SuperTabState) {
    const session = (a: SuperTabState['agents'][number]) => `${a.machineId}\n${a.harnessId}\n${a.machineOwnerId}`
    const now = new Map(after.agents.map(a => [session(a), a]))
    const watchers = (state: SuperTabState, target: SuperTabState['agents'][number]) =>
      state.people.map((p): Actor => ({ kind: 'person', userId: p.id, email: p.email })).filter(actor => canWatchAgent(state, actor, target))
    return before.agents.flatMap(target => {
      const was = watchers(before, target)
      if (!was.length) return []
      const still = now.get(session(target))
      const is = new Set(still ? watchers(after, still).map(a => (a as Extract<Actor, { kind: 'person' }>).userId) : [])
      const personIds = was.map(a => (a as Extract<Actor, { kind: 'person' }>).userId).filter(id => !is.has(id))
      return personIds.length ? [{ agentId: target.id, personIds }] : []
    })
  }

  it('gives the same answer, with one pass over each state\'s conversations however many agents and people', () => {
    const { state: before, ids } = seeded({ people: 12, agents: 16, conversations: 120 })
    const after = structuredClone(before)
    // A worker joins a private conversation, which makes it confidential: its readers lose its screen.
    after.conversations.find(c => c.audience)!.agentIds.push(ids[6]!)
    after.agents.find(a => a.id === ids[7])!.confidential = true
    expect(watchersLost(before, after)).toEqual(naiveLost(before, after))
    expect(watchersLost(before, after).length).toBeGreaterThan(0)

    const passes = (people: number, agents: number) => {
      const { state } = seeded({ people, agents, conversations: 200 })
      const a = countingAudienceReads(state), b = countingAudienceReads(structuredClone(state))
      watchersLost(a.state, b.state)
      return (a.reads() + b.reads()) / (2 * a.state.conversations.length)
    }
    const small = passes(1, 2)
    expect(small).toBeLessThanOrEqual(1)
    expect(passes(20, 20)).toBe(small)
  })
})
