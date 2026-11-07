import { describe, expect, it } from 'vitest'
import type { Conversation } from '../model.js'
import { DAY_MS } from '../leaderboard/week.js'
import { projectActivity } from './projectActivity.js'
import { NOW, owner, peer, richSwarm } from './fixture.test-support.js'

// NOW is Monday 2026-10-26 10:20 UTC: the 28 days run from Tuesday 2026-09-29 through it, oldest first.
const TODAY = Math.floor(NOW / DAY_MS) * DAY_MS, FIRST = TODAY - 27 * DAY_MS
const iso = (at: number) => new Date(at).toISOString()

/** richSwarm (the public first project "lead", and "Secret", private to the owner) with tasks shipped across the window. */
function scene() {
  const s = richSwarm(NOW)
  const two = s.group('Two'), first = s.group('First day'), before = s.group('Before the window'), step = s.group('Review')
  const chat = s.state.projects!.find(p => p.id === s.secret)!.leadConversationId
  const generation = s.state.people.find(p => p.id === owner.userId)!.generation
  const shipped = (id: string, shippedAt: number, extra: Partial<Conversation> = {}) =>
    Object.assign(s.state.conversations.find(c => c.id === id)!, { ledger: { shippedAt }, lastActivityAt: iso(shippedAt), ...extra })
  s.edit(() => {
    shipped(s.web, NOW - 1_000)
    shipped(s.done, TODAY - 3 * DAY_MS + 1)
    shipped(two, TODAY - 2 * DAY_MS - 1)
    shipped(first, FIRST)
    shipped(before, FIRST - 1)
    shipped(s.secretGroup, TODAY - DAY_MS)
    // Never a task: a step, a project's own chat, a Buddy chat, and the owner's private conversation peer cannot read.
    shipped(step, NOW - 2_000, { reviewOf: s.web })
    shipped('lead', NOW - 3_000)
    shipped(chat, NOW - 4_000)
  })
  const buddyChat: Conversation = { id: 'buddy-chat', kind: 'buddy', projectId: 'lead', title: 'Buddy', leadId: null, agentIds: [], archived: false,
    brief: '', checks: [], assignment: null, lastMessageSequence: 0, ledger: { shippedAt: NOW - 5_000 }, lastActivityAt: iso(NOW - 500),
    audience: { people: [{ id: owner.userId, generation }] } }
  const hidden: Conversation = { ...buddyChat, id: 'hidden', kind: undefined, title: 'Hidden', lastActivityAt: iso(NOW - 600) }
  return { ...s, groups: [...s.state.conversations, buddyChat, hidden] }
}

const row = (answer: ReturnType<typeof projectActivity>, projectId: string) => answer.projects.find(p => p.projectId === projectId)
const days = (counts: Record<number, number>) => Array.from({ length: 28 }, (_, i) => counts[i] ?? 0)

describe('a project\'s activity: tasks shipped per UTC day for 28 days, and when it last moved', () => {
  it('counts each shipped task on its day, oldest first through today, never one shipped before the window', () => {
    const s = scene()
    const answer = projectActivity(s.state, owner, s.groups, NOW)
    expect(answer.through).toBe('2026-10-26')
    // The owner reads "hidden" (it is theirs): it counts with web today.
    expect(row(answer, 'lead')!.shipped).toEqual(days({ 0: 1, 24: 1, 25: 1, 27: 2 }))
    expect(row(answer, s.secret)!.shipped).toEqual(days({ 26: 1 }))
  })

  it('skips steps, a project\'s chat, Buddy chats and conversations the reader cannot read', () => {
    const s = scene()
    expect(row(projectActivity(s.state, peer, s.groups, NOW), 'lead')!.shipped).toEqual(days({ 0: 1, 24: 1, 25: 1, 27: 1 }))
  })

  it('gives the newest activity of the project\'s readable conversations, a dormant one and its chat included', () => {
    const s = scene()
    expect(row(projectActivity(s.state, peer, s.groups, NOW), 'lead')!.updatedAt).toBe(NOW - 1_000)
    const quiet = { id: 'quiet', projectId: 'lead', title: 'Quiet', archived: true, dormant: true, lastActivityAt: iso(NOW - 100) } as Conversation
    expect(row(projectActivity(s.state, peer, [...s.groups, quiet], NOW), 'lead')!.updatedAt).toBe(NOW - 100)
    // The owner reads their private "hidden"; their Buddy chat, newer still, is no project's work.
    expect(row(projectActivity(s.state, owner, s.groups, NOW), 'lead')!.updatedAt).toBe(NOW - 600)
    // Secret's newest is its chat's, after its task shipped.
    expect(row(projectActivity(s.state, owner, s.groups, NOW), s.secret)!.updatedAt).toBe(NOW - 4_000)
  })

  it('has no activity yet for a project nobody wrote in', () => {
    const s = scene()
    const fresh = s.run({ type: 'project.create', name: 'Fresh', visibility: 'public', brief: '' }).projectId as string
    const groups = s.groups.filter(g => g.id !== s.state.projects!.find(p => p.id === fresh)!.leadConversationId)
    expect(row(projectActivity(s.state, owner, groups, NOW), fresh)).toEqual({ projectId: fresh, shipped: days({}), updatedAt: null })
  })

  it('lists only the projects the reader reads, in the Swarm\'s order', () => {
    const s = scene()
    expect(projectActivity(s.state, owner, s.groups, NOW).projects.map(p => p.projectId)).toEqual(['lead', s.secret])
    expect(projectActivity(s.state, peer, s.groups, NOW).projects.map(p => p.projectId)).toEqual(['lead'])
  })
})
