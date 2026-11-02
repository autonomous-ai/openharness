import { describe, expect, it } from 'vitest'
import { agentOnly, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { ARCHIVE_QUIET_MS, archivable, IDLE_NOTICE_MS, idleNotices, linkPending, reviewClosable, reviewCloseLine, reviewPullRequests } from './tidy.js'

const MINUTE = 60_000
const START = Date.parse('2026-10-27T08:00:00.000Z')
const iso = (at: number) => new Date(at).toISOString()
const config = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const done = (patch: Partial<Assignment> = {}): Assignment => ({ id: 'a1', agentId: 'w', status: 'done', result: 'Merged', configuration: config,
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, progressAt: START, ...patch })
const worker = (patch: Partial<Agent> = {}): Agent => ({ id: 'w', machineId: 'm', harnessId: 'h', machineOwnerId: 'o', contributorId: 'p',
  membershipGeneration: 'g', name: 'Builder', displayName: 'Rowan', configuration: config,
  startedSession: { creationId: 'c1', sessionId: 's1', createdAt: iso(START - 60 * MINUTE) }, ...patch })
const group = (patch: Partial<Conversation> = {}): Conversation => ({ id: 'g1', title: 'Task', leadId: 'L', agentIds: ['L', 'w'], archived: false,
  brief: 'Do it', checks: [], assignment: done(), lastMessageSequence: 3, lastActivityAt: iso(START), ...patch })

/** A Swarm whose coordinator `L` runs on machine `m` with agent `w` (session `h`). */
function swarm(opts: { agents?: Agent[]; groups?: Conversation[] } = {}) {
  return {
    id: 't', ownerId: 'p', paused: false,
    agents: [worker({ id: 'L', harnessId: 'hl', name: 'Lead', displayName: 'River' }), ...opts.agents ?? [worker()]],
    people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
    machines: [{ machineId: 'm', name: 'Studio' }],
    conversations: [{ id: 'lead', title: 'Lead', leadId: 'L', agentIds: ['L'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
      ...opts.groups ?? [group()]],
  } as unknown as SuperTabState
}
const at = START + IDLE_NOTICE_MS
const target = (state: SuperTabState, id = 'w') => state.agents.find(a => a.id === id)!

// Project instructions, phase 4, decision 7: the server stops no idle agent; it tells the coordinator once per idle spell, and
// the instructions say what the coordinator does about it.
describe('idle agents', () => {
  it('tells the coordinator once about an agent with no open task for 15 minutes', () => {
    const state = swarm({ agents: [worker({ startedSession: { creationId: 'c', sessionId: 's', createdAt: iso(START - MINUTE) } })], groups: [] })
    const rows = idleNotices(state, 'lead', at, new Set())
    expect(rows).toEqual([expect.objectContaining({ conversationId: 'lead', recipients: ['L'], replyTo: null,
      author: expect.objectContaining({ kind: 'agent', id: 'L' }), text: 'Rowan has had no open task for 15 minutes.', source: { kind: 'idle', agentId: 'w' } })])
    // The coordinator's alone: people do not read it (model.ts agentOnly).
    expect(rows.map(row => agentOnly(row.source, row.recipients))).toEqual([true])
    // Nothing is stopped or decided for it.
    expect(target(state).workDecision).toBeUndefined()
    expect(target(state).releaseId).toBeUndefined()
    expect(target(state).idleNoticedAt).toBe(START - MINUTE)
    // Once per idle spell: the next polls say nothing.
    expect(idleNotices(state, 'lead', at + MINUTE, new Set())).toEqual([])
    expect(idleNotices(state, 'lead', at + 60 * MINUTE, new Set())).toEqual([])
    // New work and a new idle spell after it: one more.
    state.conversations.push(group({ assignment: done({ progressAt: at + 2 * MINUTE }), lastActivityAt: iso(at + 2 * MINUTE) }))
    expect(idleNotices(state, 'lead', at + 10 * MINUTE, new Set())).toEqual([])
    const again = idleNotices(state, 'lead', at + 17 * MINUTE, new Set())
    expect(again).toEqual([expect.objectContaining({ text: 'Rowan has had no open task for 15 minutes.' })])
    expect(new Set([...rows, ...again].map(row => row.id)).size).toBe(2)
    expect(target(state).idleNoticedAt).toBe(at + 2 * MINUTE)
  })

  it('never tells of a Buddy, the coordinator, an agent with a delivery waiting or one in a task with active work', () => {
    const buddy = swarm({ agents: [worker({ buddyOf: { personId: 'p', generation: 'g' } })], groups: [] })
    expect(idleNotices(buddy, 'lead', at, new Set())).toEqual([])
    const alone = swarm({ agents: [], groups: [] })
    expect(idleNotices(alone, 'lead', at, new Set())).toEqual([])
    expect(idleNotices(swarm({ groups: [] }), 'lead', at, new Set(['w']))).toEqual([])
    // Its own work, or a member of a task whose work is going (a Reviewer or a Tester linked to it).
    expect(idleNotices(swarm({ groups: [group({ assignment: done({ status: 'working' }) })] }), 'lead', at, new Set())).toEqual([])
    const linked = group({ agentIds: ['L', 'other', 'w'], assignment: done({ agentId: 'other', status: 'review' }), lastActivityAt: iso(START - 60 * MINUTE) })
    expect(idleNotices(swarm({ groups: [linked] }), 'lead', at, new Set())).toEqual([])
  })

  it('waits until a full 15 minutes have passed since the group of its own task last spoke', () => {
    const state = swarm({ groups: [group({ lastActivityAt: iso(START + 5 * MINUTE) })] })
    expect(idleNotices(state, 'lead', at, new Set())).toEqual([])
    expect(idleNotices(state, 'lead', at + 5 * MINUTE, new Set())).toHaveLength(1)
  })

  it('counts its start and its last progress as activity', () => {
    const fresh = swarm({ agents: [worker({ startedSession: { creationId: 'c', sessionId: 's', createdAt: iso(START + MINUTE) } })], groups: [] })
    expect(idleNotices(fresh, 'lead', at, new Set())).toEqual([])
    const progressed = swarm({ groups: [group({ assignment: done({ progressAt: START + MINUTE }) })] })
    expect(idleNotices(progressed, 'lead', at, new Set())).toEqual([])
  })

  // A keep is the coordinator's answer to the notice: it is not asked again every 15 minutes while the agent waits, only once
  // the agent has had and finished another task (final review of the branch).
  it('says nothing more of a kept agent until it has had and finished another task', () => {
    const kept = swarm({ agents: [worker({ workDecision: 'keep', keptAt: START + MINUTE })] })
    expect(idleNotices(kept, 'lead', at + MINUTE, new Set())).toEqual([])
    expect(idleNotices(kept, 'lead', at + 24 * 60 * MINUTE, new Set())).toEqual([])
    // Assigned again, its keep is cleared (commands.ts work.assign); finished, it is marked awaiting (model.ts finishWorker).
    const later = at + 30 * MINUTE
    target(kept).workDecision = 'awaiting'
    kept.conversations.push(group({ id: 'g2', assignment: done({ id: 'a2', progressAt: later }), lastActivityAt: iso(later) }))
    expect(idleNotices(kept, 'lead', later + IDLE_NOTICE_MS - 1, new Set())).toEqual([])
    expect(idleNotices(kept, 'lead', later + IDLE_NOTICE_MS, new Set())).toHaveLength(1)
  })

  // Swarm autonomous-harness, 2026-10-29: an agent started by hand in a busy chat never got a task, and every message there
  // kept it idle. Messages in a group without active work are about others' work: it is idle from its start.
  it('tells of an agent that never had a task 15 minutes after its start, however busy a finished group it sits in is', () => {
    const chatty = group({ assignment: done({ agentId: 'other' }), agentIds: ['L', 'other', 'w'], lastActivityAt: iso(at - MINUTE) })
    expect(idleNotices(swarm({ groups: [chatty] }), 'lead', at, new Set())).toEqual([expect.objectContaining({ source: { kind: 'idle', agentId: 'w' } })])
    // One that had a task of its own and finished it: its group's last message still counts.
    const finished = swarm({ groups: [group({ lastActivityAt: iso(at - MINUTE) })] })
    expect(idleNotices(finished, 'lead', at, new Set())).toEqual([])
  })

  it('tells of an agent a person added by hand, from its groups\' last activity, and of no agent it cannot time', () => {
    const added = worker({ startedSession: undefined })
    expect(idleNotices(swarm({ agents: [added], groups: [group({ assignment: null, lastActivityAt: iso(START) })] }), 'lead', at, new Set())).toHaveLength(1)
    expect(idleNotices(swarm({ agents: [added], groups: [group({ assignment: null, lastActivityAt: iso(START + MINUTE) })] }), 'lead', at, new Set())).toEqual([])
    expect(idleNotices(swarm({ agents: [added], groups: [] }), 'lead', at, new Set())).toEqual([])
  })

  it('leaves stopping agents and agents waiting out a usage limit alone, past its reset time too, until their task is handed on', () => {
    expect(idleNotices(swarm({ agents: [worker({ workDecision: 'stop', releaseId: 'r1' })] }), 'lead', at, new Set())).toEqual([])
    const lostTask = { conversationId: 'g1', assignmentId: 'a1', reason: 'limit', at: START, resumeAt: iso(START + MINUTE) }
    const lost = () => group({ assignment: done({ status: 'lost', lost: { reason: 'limit', at: START, resumeAt: iso(START + MINUTE) } }) })
    expect(idleNotices(swarm({ agents: [worker({ lostTask })], groups: [lost()] }), 'lead', at + 10 * MINUTE, new Set())).toEqual([])
    const handed = swarm({ agents: [worker({ lostTask })], groups: [group({ assignment: done({ id: 'a2', agentId: 'other', status: 'done' }) })] })
    expect(idleNotices(handed, 'lead', at, new Set())).toHaveLength(1)
  })

  it('tells whether or not the owner turned tidying off, and never of another project\'s agents', () => {
    const off = swarm({ groups: [] })
    off.tidy = false
    expect(idleNotices(off, 'lead', at, new Set())).toHaveLength(1)
    expect(idleNotices(swarm({ agents: [worker({ projectId: 'other' })] }), 'lead', at, new Set())).toEqual([])
  })
})

describe('which finished groups archive', () => {
  const quiet = START + ARCHIVE_QUIET_MS
  it('is a group whose task is done or cancelled and that has been quiet for 30 minutes', () => {
    const state = swarm()
    expect(archivable(state, state.conversations[1]!, quiet)).toBe(true)
    expect(archivable(state, state.conversations[1]!, quiet - 1)).toBe(false)
    const cancelled = swarm({ groups: [group({ assignment: done({ status: 'cancelled' }) })] })
    expect(archivable(cancelled, cancelled.conversations[1]!, quiet)).toBe(true)
  })

  it('is never a group with work still going, lost or stopped, or no task at all', () => {
    for (const assignment of [done({ status: 'working' }), done({ status: 'review' }), done({ status: 'lost' }), done({ status: 'stopped' }), null]) {
      const state = swarm({ groups: [group({ assignment })] })
      expect(archivable(state, state.conversations[1]!, quiet)).toBe(false)
    }
  })

  // By hand any agent or person archives a linked task (project instructions, phase 4); the Swarm alone still waits for it.
  it('is never a linked task with no verdict while the work it links to is going, unless it was cancelled', () => {
    const verdict = { id: 'v', description: 'Verdict with the reviewed revision', independent: false }
    const review = (patch: Partial<Conversation>) => group({ id: 'r1', reviewOf: 'g1', ...patch })
    // Stored as done with no verdict, as no command allows: the rule still holds.
    const state = swarm({ groups: [group({ assignment: done({ status: 'review' }) }),
      review({ checks: [{ ...verdict, evidence: null, passedBy: null }] }),
      review({ id: 'r2', checks: [{ ...verdict, evidence: 'Ready: yes — revision abc', passedBy: 'agent:w' }] }),
      review({ id: 'r3', checks: [{ ...verdict, evidence: null, passedBy: null }], assignment: done({ status: 'cancelled' }) })] })
    expect(state.conversations.slice(2).map(g => archivable(state, g, quiet))).toEqual([false, true, true])
    expect(state.conversations.slice(2).map(g => linkPending(state, g))).toEqual([true, false, false])
    // Once the reviewed work is done, its review is moot.
    state.conversations[1]!.assignment = done()
    expect(archivable(state, state.conversations[2]!, quiet)).toBe(true)
    expect(linkPending(state, state.conversations[2]!)).toBe(false)
  })

  it('is never a Lead conversation, a private chat, the Leads conversation, an archived group, or any once tidying is off', () => {
    const state = swarm({ groups: [group({ audience: { people: [] } as never }), group({ id: 'leads', kind: 'leads' }), group({ id: 'old', archived: true })] })
    for (const g of state.conversations) expect(archivable(state, g, quiet)).toBe(false)
    const off = swarm()
    off.tidy = false
    expect(archivable(off, off.conversations[1]!, quiet)).toBe(false)
  })
})

// Ken, 2026-10-30: 28 of 31 open review groups waited for a Reviewer on pull requests already merged or closed.
describe('which reviews nobody reviews may close', () => {
  const quiet = START + ARCHIVE_QUIET_MS
  const PR = 'https://github.com/acme/app/pull/2288', SECOND = 'https://github.com/acme/app/pull/2290'
  /** Work still waiting for its review, linking [built], and its review with no Reviewer, linking [own]. */
  const reviewState = (patch: Partial<Conversation> = {}, built: string[] = [PR], own: string[] = []) => swarm({ groups: [
    group({ assignment: done({ status: 'review' }), pullRequestUrls: built }),
    group({ id: 'r1', title: 'Review: Task', reviewOf: 'g1', assignment: null, pullRequestUrls: own, ...patch })] })
  const review = (state: SuperTabState) => state.conversations[2]!

  it('is a review with no Reviewer, or one whose Reviewer\'s task ended, quiet for 30 minutes, whose work links a pull request', () => {
    for (const assignment of [null, done({ status: 'lost' }), done({ status: 'stopped' })]) {
      const state = reviewState({ assignment })
      expect(reviewClosable(state, review(state), quiet)).toBe(true)
      expect(reviewClosable(state, review(state), quiet - 1)).toBe(false)
    }
  })

  it('is never one a Reviewer works on', () => {
    for (const status of ['working', 'review', 'needs_human', 'blocked'] as const) {
      const state = reviewState({ assignment: done({ status }) })
      expect(reviewClosable(state, review(state), quiet)).toBe(false)
    }
  })

  it('is never one with no pull request anywhere: nothing can say the work needs no review', () => {
    const state = reviewState({}, [])
    expect(reviewClosable(state, review(state), quiet)).toBe(false)
  })

  it('is never an archived one, a chat, a group that reviews nothing, or any once tidying is off', () => {
    for (const patch of [{ archived: true }, { audience: { people: [] } as never }, { kind: 'buddy' as const }, { reviewOf: undefined }]) {
      const state = reviewState(patch)
      expect(reviewClosable(state, review(state), quiet)).toBe(false)
    }
    const off = reviewState()
    off.tidy = false
    expect(reviewClosable(off, review(off), quiet)).toBe(false)
  })

  it('reads the pull requests of the review and of the work it reviews, each once', () => {
    const state = reviewState({}, [PR, SECOND], [PR])
    expect(reviewPullRequests(state, review(state))).toEqual([PR, SECOND])
  })

  it('says, as the Lead and to nobody, how each pull request ended', () => {
    const state = reviewState({}, [PR, SECOND])
    expect(reviewCloseLine(state, review(state), { [PR]: 'merged', [SECOND]: 'closed' }, quiet)).toMatchObject({ conversationId: 'r1', recipients: [],
      author: { kind: 'agent', id: 'L' }, source: { kind: 'auto-archive' }, text: 'Closed: #2288 merged, #2290 closed; no Swarm review is needed now.' })
  })
})
