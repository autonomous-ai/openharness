import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Author, Conversation, SuperTabState, WorkStatus } from './model.js'
import type { ContributedMachine } from './machines.js'
import { stableId } from './model.js'
import { morningCards, recapCard, standupCard } from './morning.js'

const HOUR = 60 * 60_000
const DAY = 24 * HOUR
/** Tuesday 27 October, 08:00 in Vietnam: the project's digest time. */
const TUESDAY = Date.UTC(2026, 9, 27, 1, 0)
const LAST = TUESDAY - DAY
/** Monday 2 November, 08:00 in Vietnam: the recap covers the week from Monday 26 October 00:00 UTC. */
const MONDAY = Date.UTC(2026, 10, 2, 1, 0)
const WEEK = Date.UTC(2026, 9, 26)

const agent = (id: string, name: string): Agent => ({ id, name, displayName: name, contributorId: 'owner', membershipGeneration: 'g', machineId: 'mac',
  harnessId: `h-${id}`, machineOwnerId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent)
const work = (agentId: string, status: WorkStatus, over: Partial<Assignment> = {}): Assignment => ({ id: `w-${agentId}-${status}`, agentId, status,
  configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null },
  execution: { machineId: 'mac', harnessId: `h-${agentId}`, machineOwnerId: 'owner' }, result: null, ...over })
const group = (number: number, title: string, assignment: Assignment | null, over: Partial<Conversation> = {}): Conversation => ({ id: `g${number}`,
  projectId: 'p1', number, title, leadId: 'lead', agentIds: ['lead', ...assignment ? [assignment.agentId] : []], archived: false, brief: 'Do it.', checks: [],
  assignment, lastMessageSequence: 1, lastActivityAt: new Date(LAST + HOUR).toISOString(), ...over })

/** lampOS: Dee's request shipped and reviewed overnight, another shipped with nobody named as asking, one shipped the week
 *  before, two running, two held up, one waiting on Dee, a private chat and another project's work. */
function fixture(): SuperTabState {
  return {
    version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [],
    people: [{ id: 'owner', email: 'owner@example.com', role: 'owner', generation: 'g' }, { id: 'dee', email: 'dee@example.com', role: 'collaborator', generation: 'g' }],
    agents: [agent('lead', 'River'), agent('nico', 'Nico'), agent('ana', 'Ana'), agent('bo', 'Bo'), agent('cy', 'Cy'), agent('di', 'Di'), agent('ed', 'Ed'),
      agent('rev', 'Rae')],
    projects: [
      { id: 'p1', name: 'lampOS', ownerId: 'owner', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5,
        digest: { time: '08:00', timeZone: 'Asia/Ho_Chi_Minh', lastAt: LAST, lastOn: '2026-10-26' } },
      { id: 'p2', name: 'Firmware', ownerId: 'owner', leadConversationId: 'lead-p2', visibility: 'public', members: [], updateMinutes: 5 },
    ],
    conversations: [
      { ...group(0, 'Lead', null), id: 'lead-p1', number: undefined },
      { ...group(0, 'Lead', null, { projectId: 'p2', leadId: 'lead-2' }), id: 'lead-p2', number: undefined },
      group(1, 'Night shift', work('nico', 'done'), { requesterId: 'dee', pullRequestUrls: ['https://github.com/example/lampos/pull/12'],
        ledger: { askedAt: LAST - 3 * HOUR, shippedAt: LAST + HOUR } }),
      group(11, 'Review: Night shift', work('rev', 'done'), { reviewOf: 'g1', ledger: { shippedAt: LAST + HOUR } }),
      group(10, 'Release notes', work('bo', 'done'), { archived: true, dormant: true, pullRequestUrls: ['https://github.com/example/lampos/pull/15'],
        ledger: { shippedAt: LAST + 2 * HOUR } }),
      group(2, 'Old parser', work('ana', 'done'), { requesterId: 'owner', lastActivityAt: new Date(WEEK - 6 * DAY).toISOString(),
        pullRequestUrls: ['https://github.com/example/lampos/pull/3'], ledger: { askedAt: WEEK - 6 * DAY - 10 * HOUR, shippedAt: WEEK - 6 * DAY } }),
      group(3, 'Lexer', work('ana', 'working')),
      group(4, 'Docs', work('bo', 'review'), { pullRequestUrls: ['https://github.com/example/lampos/pull/14'] }),
      group(5, 'Deploy', work('cy', 'blocked', { result: 'No access to staging.' })),
      group(6, 'Cache', work('di', 'lost', { lost: { reason: 'its machine Studio has been offline for 2 minutes', at: LAST + 2 * HOUR } })),
      group(7, 'Pricing', work('ed', 'needs_human', { result: 'Which plan do we launch with?' }), { requesterId: 'dee',
        ledger: { unblocks: [{ personId: 'owner', at: LAST + 3 * HOUR, waitedMs: HOUR }] } }),
      // Never on a card: a private chat's work, archived work still open, and another project's work.
      group(12, 'Secret', work('ed', 'done'), { audience: { people: [{ id: 'dee', generation: 'g' }] },
        ledger: { askedAt: LAST, shippedAt: LAST + HOUR } }),
      group(8, 'Archived spike', work('ed', 'working'), { archived: true }),
      group(9, 'Bootloader', work('nico', 'done'), { projectId: 'p2', leadId: 'lead-2', ledger: { shippedAt: LAST + HOUR } }),
    ],
  } as SuperTabState
}
const lampOS = (state: SuperTabState) => state.projects!.find(p => p.id === 'p1')!
const river: Author = { kind: 'agent', id: 'lead', name: 'Lead', displayName: 'River', membershipGeneration: 'g' }

describe('the morning stand-up card', () => {
  it('lists what shipped since the last digest with who asked, built and reviewed it, and what is moving, blocked or waiting on people', () => {
    expect(standupCard(fixture(), lampOS(fixture()), '2026-10-27', LAST)).toEqual({
      kind: 'standup', on: '2026-10-27',
      shipped: [
        { number: 1, title: 'Night shift', pullRequestUrl: 'https://github.com/example/lampos/pull/12', askedBy: 'dee', builtBy: 'nico', reviewedBy: ['rev'] },
        { number: 10, title: 'Release notes', pullRequestUrl: 'https://github.com/example/lampos/pull/15', askedBy: null, builtBy: 'bo', reviewedBy: [] },
      ],
      inProgress: [
        { number: 3, title: 'Lexer', status: 'working', agentId: 'ana', note: null },
        { number: 4, title: 'Docs', status: 'review', agentId: 'bo', note: null },
      ],
      blocked: [
        { number: 5, title: 'Deploy', status: 'blocked', agentId: 'cy', note: 'No access to staging.' },
        { number: 6, title: 'Cache', status: 'lost', agentId: 'di', note: 'its machine Studio has been offline for 2 minutes' },
      ],
      waiting: [{ number: 7, title: 'Pricing', status: 'needs_human', agentId: 'ed', note: 'Which plan do we launch with?', personId: 'dee' }],
    })
  })

  it('counts work done before the leaderboard recorded ships by its last activity', () => {
    const state = fixture()
    delete state.conversations.find(c => c.id === 'g10')!.ledger
    expect(standupCard(state, lampOS(state), '2026-10-27', LAST).shipped.map(s => s.number)).toEqual([1, 10])
    expect(standupCard(state, lampOS(state), '2026-10-27', LAST + 2 * HOUR).shipped.map(s => s.number)).toEqual([])
  })
})

describe('the weekly shipped-together recap', () => {
  it('sums last week from the leaderboard: what shipped, ask-to-shipped against the week before, medals, and everyone who helped', () => {
    expect(recapCard(fixture(), lampOS(fixture()), '2026-11-02', MONDAY)).toEqual({
      kind: 'recap', week: WEEK,
      shipped: [
        { number: 1, title: 'Night shift', pullRequestUrl: 'https://github.com/example/lampos/pull/12', askedBy: 'dee', builtBy: 'nico', reviewedBy: ['rev'] },
        { number: 10, title: 'Release notes', pullRequestUrl: 'https://github.com/example/lampos/pull/15', askedBy: null, builtBy: 'bo', reviewedBy: [] },
      ],
      askToShipMs: { lastWeek: 4 * HOUR, weekBefore: 10 * HOUR },
      top: [{ personId: 'dee', medal: 'gold', points: 3 }, { personId: 'owner', medal: 'silver', points: 1 }],
      thanks: { personIds: ['dee', 'owner'], agentIds: ['nico', 'rev', 'bo'] },
    })
  })
})

describe('Lent on the recap, read by everyone in the project chat', () => {
  const machine = (machineId: string, agentHours: number, scope?: 'swarm'): ContributedMachine => ({ machineId, name: machineId, contributorId: 'dee',
    membershipGeneration: 'g', generation: 'g1', cwd: '/repo', ...scope ? { scope } : {}, engines: ['claude'], maxAgents: 2, paused: false,
    lent: [{ week: WEEK, agentMs: agentHours * HOUR }] })
  const deePoints = (state: SuperTabState) => recapCard(state, lampOS(state), '2026-11-02', MONDAY).top.find(t => t.personId === 'dee')!.points

  it('counts only machines every reader of the chat may see: a machine given to the Lead project alone is not', () => {
    const state = fixture()
    state.machines = [machine('swarm-mac', 10, 'swarm'), machine('lead-mac', 30)]
    // 3 for the shipped request and 1 for 10 hours lent on the swarm machine; the Lead project's own machine adds nothing.
    expect(deePoints(state)).toBe(4)
  })

  it('leaves a public Lead project\'s machine off another project\'s recap: that project\'s agents read the card but not the Lead project', () => {
    const state = fixture()
    state.machines = [machine('swarm-mac', 10, 'swarm'), machine('lead-mac', 30)]
    state.projects!.push({ id: 'lead', name: 'Swarm', ownerId: 'owner', leadConversationId: 'lead', visibility: 'public', members: [], updateMinutes: 5 })
    expect(deePoints(state)).toBe(4)
  })

  it('counts the Lead project\'s machines on the Lead project\'s own recap, where every reader reads that project', () => {
    const state = fixture()
    state.machines = [machine('swarm-mac', 10, 'swarm'), machine('lead-mac', 30)]
    // lampOS is the Lead project here: its chat, its work and its agents.
    state.projects = state.projects!.map(p => p.id === 'p1' ? { ...p, id: 'lead' } : p)
    state.conversations = state.conversations.map(c => c.projectId === 'p1' ? { ...c, projectId: 'lead' } : c)
    const lead = state.projects.find(p => p.id === 'lead')!
    // 3 for the shipped request, 1 for the swarm machine's 10 hours and 3 for the Lead project's 30.
    expect(recapCard(state, lead, '2026-11-02', MONDAY).top.find(t => t.personId === 'dee')!.points).toBe(7)
  })
})

describe('the cards posted with the morning digest', () => {
  it('posts one stand-up card a day into the project chat, for the people only', () => {
    const cards = morningCards(fixture(), lampOS(fixture()), river, '2026-10-27', LAST, TUESDAY)
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ id: stableId('standup', 'tab', 'p1', '2026-10-27'), conversationId: 'lead-p1', author: river, recipients: [], replyTo: null,
      source: { kind: 'standup', projectId: 'p1', on: '2026-10-27', card: { kind: 'standup', on: '2026-10-27' } } })
    expect(cards[0]!.text).toBe('Stand-up for 2026-10-27: 2 shipped, 2 in progress, 2 blocked, 1 waiting on people.')
  })

  it('adds the recap card on Monday, once for that week, thanking everyone by name', () => {
    const cards = morningCards(fixture(), lampOS(fixture()), river, '2026-11-02', MONDAY - DAY, MONDAY)
    expect(cards.map(c => c.source!.kind)).toEqual(['standup', 'recap'])
    expect(cards[1]).toMatchObject({ id: stableId('recap', 'tab', 'p1', '2026-11-02'), conversationId: 'lead-p1', recipients: [],
      source: { kind: 'recap', projectId: 'p1', on: '2026-11-02', card: { kind: 'recap', week: WEEK } } })
    expect(cards[1]!.text).toBe('Shipped together, week of 2026-10-26: 2 shipped. Thank you, dee, owner, Nico, Rae and Bo!')
  })

  it('recaps the week before the project\'s own Monday, though that Monday is still Sunday in UTC', () => {
    // Monday 2 November, 08:00 in Auckland, is Sunday 1 November, 19:00 UTC: last week is still the one from 26 October.
    const state = fixture()
    lampOS(state).digest = { time: '08:00', timeZone: 'Pacific/Auckland', lastAt: MONDAY - 2 * DAY, lastOn: '2026-11-01' }
    const auckland = Date.UTC(2026, 10, 1, 19, 0)
    const recap = morningCards(state, lampOS(state), river, '2026-11-02', auckland - DAY, auckland)[1]!
    expect(recap.source).toMatchObject({ card: { kind: 'recap', week: WEEK } })
    expect(recap.text).toMatch(/^Shipped together, week of 2026-10-26: 2 shipped\./)
  })
})
