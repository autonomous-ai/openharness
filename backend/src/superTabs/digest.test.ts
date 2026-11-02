import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState, WorkStatus } from './model.js'
import { decisionLines, digestDue, digestRequest, projectDigest } from './digest.js'

const HOUR = 60 * 60_000
/** 08:00 on 27 October in Vietnam (UTC+7), the project's digest time. */
const EIGHT = Date.UTC(2026, 9, 27, 1, 0)
const LAST = EIGHT - 24 * HOUR

const agent = (id: string, name: string): Agent => ({ id, name, contributorId: 'owner', membershipGeneration: 'g', machineId: 'mac', harnessId: `h-${id}`,
  machineOwnerId: 'owner', configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent)
const work = (agentId: string, status: WorkStatus, over: Partial<Assignment> = {}): Assignment => ({ id: `w-${agentId}-${status}`, agentId, status,
  configuration: { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null },
  execution: { machineId: 'mac', harnessId: `h-${agentId}`, machineOwnerId: 'owner' }, result: null, ...over })
const group = (number: number, title: string, assignment: Assignment | null, over: Partial<Conversation> = {}): Conversation => ({ id: `g${number}`,
  projectId: 'p1', number, title, leadId: 'lead', agentIds: ['lead', ...assignment ? [assignment.agentId] : []], archived: false, brief: 'Do it.', checks: [],
  assignment, lastMessageSequence: 1, lastActivityAt: new Date(LAST + HOUR).toISOString(), ...over })

/** lampOS overnight: one task merged, one merged before the last digest, two running, three held up, and another project's work. */
function fixture(): SuperTabState {
  return {
    version: 1, id: 'tab', name: 'Swarm', ownerId: 'owner', environment: 'prod', paused: false, invitations: [],
    people: [{ id: 'owner', email: 'owner@example.com', role: 'owner', generation: 'g' }, { id: 'ann', email: 'ann@example.com', role: 'collaborator', generation: 'g' }] as SuperTabState['people'],
    agents: [agent('lead', 'Lead'), agent('nico', 'Nico'), agent('ana', 'Ana'), agent('bo', 'Bo'), agent('cy', 'Cy'), agent('di', 'Di'), agent('ed', 'Ed')],
    projects: [
      { id: 'p1', name: 'lampOS', ownerId: 'owner', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5,
        digest: { time: '08:00', timeZone: 'Asia/Ho_Chi_Minh', lastAt: LAST, lastOn: '2026-10-26' } },
      { id: 'p2', name: 'Firmware', ownerId: 'owner', leadConversationId: 'lead-p2', visibility: 'public', members: [], updateMinutes: 5 },
    ],
    conversations: [
      { ...group(0, 'Lead', null), id: 'lead-p1', number: undefined },
      { ...group(0, 'Lead', null, { projectId: 'p2', leadId: 'lead-2' }), id: 'lead-p2', number: undefined },
      group(1, 'Night shift', work('nico', 'done', { result: 'Merged.' }), { pullRequestUrls: ['https://github.com/example/lampos/pull/12'] }),
      group(2, 'Old parser', work('ana', 'done'), { lastActivityAt: new Date(LAST - HOUR).toISOString(), pullRequestUrls: ['https://github.com/example/lampos/pull/3'] }),
      group(3, 'Lexer', work('ana', 'working')),
      group(4, 'Docs', work('bo', 'review'), { pullRequestUrls: ['https://github.com/example/lampos/pull/14'] }),
      group(5, 'Deploy', work('cy', 'blocked', { result: 'No access to staging.' })),
      group(6, 'Cache', work('di', 'lost', { lost: { reason: 'its machine Studio has been offline for 2 minutes', at: LAST + 2 * HOUR } })),
      group(7, 'Pricing', work('ed', 'needs_human', { result: 'Which plan do we launch with?' })),
      group(8, 'Archived spike', work('ed', 'working'), { archived: true }),
      // Merged and archived overnight: it still shipped (#1757 review, 4).
      group(10, 'Release notes', work('bo', 'done'), { archived: true, dormant: true, pullRequestUrls: ['https://github.com/example/lampos/pull/15'] }),
      group(9, 'Bootloader', work('nico', 'working'), { projectId: 'p2', leadId: 'lead-2' }),
      group(11, 'Salaries', null, { audience: { people: [{ id: 'owner', generation: 'g' }] } as Conversation['audience'] }),
    ],
  } as SuperTabState
}
const lampOS = (state: SuperTabState) => state.projects!.find(p => p.id === 'p1')!

describe('a project\'s morning digest', () => {
  it('lists what shipped since the last digest, what is in progress and what is held up, from the project\'s own state', () => {
    expect(projectDigest(fixture(), lampOS(fixture()), LAST)).toBe([
      'Shipped:',
      '- #1 Night shift: https://github.com/example/lampos/pull/12',
      '- #10 Release notes: https://github.com/example/lampos/pull/15',
      'In progress:',
      '- #3 Lexer: working (Ana)',
      '- #4 Docs: ready for review (Bo), https://github.com/example/lampos/pull/14',
      'Blocked:',
      '- #5 Deploy: stuck (Cy): No access to staging.',
      '- #6 Cache: lost (Di): its machine Studio has been offline for 2 minutes',
      '- #7 Pricing: waits for a person (Ed): Which plan do we launch with?',
    ].join('\n'))
  })

  it('shows the decisions waiting only when there are some', () => {
    expect(projectDigest(fixture(), lampOS(fixture()), LAST, ['- Ship the night shift to every Swarm?'])).toMatch(/\nDecisions waiting:\n- Ship the night shift to every Swarm\?$/)
    expect(projectDigest(fixture(), lampOS(fixture()), LAST, [])).not.toContain('Decisions waiting')
  })

  // Decisions are read only by the person asked, the agent that asked and the Lead (decisions.ts readerWhere); the digest
  // goes to the whole project, so it says where and whom, never what is asked, and nothing of a private conversation.
  it('lists the decisions waiting by conversation and person, without their questions, from conversations the project reads', () => {
    const state = fixture()
    expect(decisionLines(state, lampOS(state), [{ conversationId: 'g7', personId: 'owner', count: 1 }, { conversationId: 'g7', personId: 'owner', count: 1 },
      { conversationId: 'g3', personId: 'ann', count: 1 }, { conversationId: 'g7', personId: 'ann', count: 1 }, { conversationId: 'g11', personId: 'owner', count: 1 },
      { conversationId: 'g9', personId: 'owner', count: 1 }, { conversationId: 'g3', personId: 'gone', count: 1 }, { conversationId: 'deleted', personId: 'owner', count: 1 },
      { conversationId: 'lead-p1', personId: 'ann', count: 1 }])).toEqual([
      '- This chat: 1 for ann@example.com',
      '- #3 Lexer: 1 for ann@example.com',
      '- #7 Pricing: 2 for owner@example.com, 1 for ann@example.com',
    ])
    expect(decisionLines(state, lampOS(state), [])).toEqual([])
  })

  it('leaves out decisions in work that is over: its task done or cancelled, or archived (Dee, 10-31)', () => {
    const state = fixture()
    const group = state.conversations.find(c => c.id === 'g7')!
    group.assignment = { ...group.assignment!, status: 'done' }
    expect(decisionLines(state, lampOS(state), [{ conversationId: 'g7', personId: 'owner', count: 1 }, { conversationId: 'g3', personId: 'ann', count: 1 }]))
      .toEqual(['- #3 Lexer: 1 for ann@example.com'])
  })

  it('puts the decisions waiting in the Lead\'s digest wake-up only when there are some', () => {
    const state = fixture(), lead = state.agents.find(a => a.id === 'lead')!
    expect(digestRequest(state, lead, EIGHT, [{ conversationId: 'g7', personId: 'ann', count: 1 }])!.text).toMatch(/\nDecisions waiting:\n- #7 Pricing: 1 for ann@example\.com$/)
    expect(digestRequest(state, lead, EIGHT, [])!.text).not.toContain('Decisions waiting')
  })

  it('says so when nothing moved', () => {
    const state = fixture()
    state.conversations = state.conversations.filter(c => !c.number || c.projectId !== 'p1')
    expect(projectDigest(state, lampOS(state), LAST)).toBe('Nothing shipped, in progress or blocked.')
  })

  it('wakes the project\'s Lead once a day at the project\'s local time, with the digest and what to do with it', () => {
    const state = fixture(), lead = state.agents.find(a => a.id === 'lead')!
    expect(digestRequest(state, lead, EIGHT - 60_000)).toBeNull()
    const wake = digestRequest(state, lead, EIGHT)!
    expect(wake).toMatchObject({ conversationId: 'lead-p1', recipients: ['lead'], source: { kind: 'digest-request', projectId: 'p1', on: '2026-10-27' } })
    expect(wake.text).toBe('Morning digest for project "lampOS" (08:00, Asia/Ho_Chi_Minh). This is a scheduled request, not a new task. '
      + 'Check that each pull request under Shipped is merged, and move one that is not to In progress. Then post one message to the people in this chat '
      + 'with these parts, in plain words, without commands or internal IDs.\n\n' + projectDigest(state, lampOS(state), LAST))
    expect(digestDue(lampOS(state), EIGHT)).toBe('2026-10-27')
    lampOS(state).digest!.lastOn = '2026-10-27'
    expect(digestRequest(state, lead, EIGHT + 12 * HOUR)).toBeNull()
    expect(digestRequest(state, lead, EIGHT + 24 * HOUR)).not.toBeNull()
  })

  it('wakes nobody for a project whose digest a person turned off, in a paused Swarm, or for an agent that is not the Lead', () => {
    const state = fixture()
    expect(digestRequest(state, state.agents.find(a => a.id === 'nico')!, EIGHT)).toBeNull()
    state.paused = true
    expect(digestRequest(state, state.agents.find(a => a.id === 'lead')!, EIGHT)).toBeNull()
    state.paused = false
    // Never set, it is on by default at 08:00 Vietnam time (Dee, 2026-10-31); turned off, it stays off.
    delete lampOS(state).digest
    expect(digestRequest(state, state.agents.find(a => a.id === 'lead')!, EIGHT)?.text).toContain('(08:00, Asia/Ho_Chi_Minh)')
    lampOS(state).digestOff = true
    expect(digestRequest(state, state.agents.find(a => a.id === 'lead')!, EIGHT)).toBeNull()
  })
})
