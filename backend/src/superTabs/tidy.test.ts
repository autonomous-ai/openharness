import { describe, expect, it } from 'vitest'
import { agentOnly, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { ARCHIVE_QUIET_MS, archivable, archiveWaitsFor, linkPending, staleSwitches, SWITCH_UNCLAIMED_MS, reviewClosable, reviewCloseLine, reviewPullRequests } from './tidy.js'

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
const at = START + 15 * MINUTE
const target = (state: SuperTabState, id = 'w') => state.agents.find(a => a.id === id)!

describe('which finished groups archive', () => {
  const quiet = START + ARCHIVE_QUIET_MS

  it('never archives a finished step whose parent is open or absent from loaded state', () => {
    const review = group({ id: 'r1', reviewOf: 'g1', step: 'Review' })
    const state = swarm({ groups: [review] })
    expect(archivable(state, review, START + 25 * 60 * MINUTE)).toBe(false)
    const parent = group({ assignment: done({ agentId: 'other', status: 'working' }) })
    state.conversations.push(parent)
    expect(archivable(state, review, START + 25 * 60 * MINUTE)).toBe(false)
    parent.assignment!.status = 'done'
    expect(archivable(state, review, START + 25 * 60 * MINUTE)).toBe(true)
  })
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
    // A step, with its task open: none, whatever its own verdict says (task steps design).
    expect(state.conversations.slice(2).map(g => archivable(state, g, quiet))).toEqual([false, false, false])
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

// Diego, 11-04: "Ported from autonomous-harness PR #2716" read as this project's pull/2716 kept the task open forever (#2602).
describe('what a finished group\'s archive waits on', () => {
  const repo = 'https://github.com/acme/openharness', pull = (n: number) => `${repo}/pull/${n}`
  const named = (result: string) => group({ assignment: done({ result }) })
  it('waits on a "PR #N" of its project\'s repository, never on one another repository\'s name sits next to', () => {
    expect(archiveWaitsFor(named('Merged PR #40. Ported from autonomous-harness PR #2716.'), repo)).toEqual([pull(40)])
    for (const result of ['Ported (from autonomous-harness PR #12)', 'From other/tool PR #12', 'from foo.js/bar_baz PR #12',
      'acme/tool PR #12', 'PR #12 in acme/tool', 'PR #12 of ACME/tool']) {
      expect(archiveWaitsFor(named(result), repo)).toEqual([])
    }
  })

  // Review of #2895: dropping one of its own numbers archives it while that PR is open (#558); reading another's as its own
  // waits at most until that number of its own closes, or is not found. So a name counts only where it plainly says so.
  it('still reads a number its own repository names, or an ordinary word sits next to, as its project\'s', () => {
    for (const result of ['acme/openharness PR #12', 'ACME/OpenHarness PR #12', 'openharness PR #12', 'Follow-up PR #12', 'Re-opened PR #12',
      'Merged. PR #12', 'Merged PR #12', 'PR #12 in review', 'PR #12 of the batch', 'from openharness PR #12', 'from acme/openharness PR #12',
      'Desktop/CLI PR #12 is open', 'test-only PR #12', 'docs-only PR #12', 'backend-only PR #12', 'CLI-side PR #12', 'v0.5.33 PR #12',
      'fix/2598-relay-offline-hold PR #12', 'PR #12 in docs/plans', 'PR #12 in desktop/src', 'PR #12 of 2026-11-04', 'PR #12 of autonomous-harness']) {
      expect(archiveWaitsFor(named(result), repo)).toEqual([pull(12)])
    }
  })

  it('stays open for a bare number with no repository to read it in, but not for another repository\'s', () => {
    expect(archiveWaitsFor(named('PR #12'), null)).toBeNull()
    expect(archiveWaitsFor(named('Ported from autonomous-harness PR #2716.'), null)).toEqual([])
  })
})

// Ken, 2026-10-30: 28 of 31 open review groups waited for a Reviewer on pull requests already merged or closed.
describe('which reviews nobody reviews may close', () => {
  const quiet = START + ARCHIVE_QUIET_MS
  const PR = 'https://github.com/acme/app/pull/2288', SECOND = 'https://github.com/acme/app/pull/2290'
  /** Work ended, linking [built], and its review with no Reviewer, linking [own]. */
  const reviewState = (patch: Partial<Conversation> = {}, built: string[] = [PR], own: string[] = [], work: 'done' | 'cancelled' | 'review' | 'working' | 'stopped' | 'lost' = 'done') => swarm({ groups: [
    group({ assignment: done({ status: work }), pullRequestUrls: built }),
    group({ id: 'r1', title: 'Review: Task', reviewOf: 'g1', assignment: null, pullRequestUrls: own, ...patch })] })
  const review = (state: SuperTabState) => state.conversations[2]!

  it('is a review with no Reviewer, or one whose Reviewer\'s task ended, quiet for 30 minutes, whose work links a pull request', () => {
    for (const assignment of [null, done({ status: 'lost' }), done({ status: 'stopped' })]) {
      const state = reviewState({ assignment })
      expect(reviewClosable(state, review(state), quiet)).toBe(true)
      expect(reviewClosable(state, review(state), quiet - 1)).toBe(false)
    }
  })

  it('is never one whose task is open or was lost: it stays with its task, and is not archived while the task may need it', () => {
    for (const work of ['review', 'working', 'stopped', 'lost'] as const) {
      const state = reviewState({}, [PR], [], work)
      expect(reviewClosable(state, review(state), quiet)).toBe(false)
    }
    for (const work of ['done', 'cancelled'] as const) {
      const state = reviewState({}, [PR], [], work)
      expect(reviewClosable(state, review(state), quiet)).toBe(true)
    }
  })

  it('is never one whose task this write did not load', () => {
    const state = reviewState()
    state.conversations.splice(1, 1)
    expect(reviewClosable(state, state.conversations[1]!, quiet)).toBe(false)
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

  it('says a pull request GitHub does not know was not found', () => {
    const state = reviewState({}, [PR])
    expect(reviewCloseLine(state, review(state), { [PR]: 'missing' }, quiet)?.text).toBe('Closed: #2288 not found; no Swarm review is needed now.')
  })
})

describe('staleSwitches', () => {
  const request = (patch = {}) => ({ id: 'op1', engine: 'codex', profileId: 'p', requestedBy: 'p', at: iso(START), ...patch })
  const asked = (switchRequest?: Agent['switchRequest']) => { const state = swarm(); target(state, 'L').switchRequest = switchRequest; return state }
  const line = { conversationId: 'lead', recipients: [], text: "Couldn't switch the PM: its machine did not answer." }

  it('drops a request nobody claimed in 2 minutes, with one line in the project chat', () => {
    const state = asked(request())
    expect(staleSwitches(state, START + SWITCH_UNCLAIMED_MS - 1)).toEqual([])
    expect(target(state, 'L').switchRequest).toBeDefined()
    expect(staleSwitches(state, START + SWITCH_UNCLAIMED_MS)).toMatchObject([line])
    expect(target(state, 'L').switchRequest).toBeUndefined()
    expect(staleSwitches(state, START + 3 * SWITCH_UNCLAIMED_MS)).toEqual([])
  })

  it('keeps a claimed request while its lease lasts and drops it once it lapsed', () => {
    const state = asked(request({ claimedUntil: iso(START + 15 * MINUTE) }))
    expect(staleSwitches(state, START + 10 * MINUTE)).toEqual([])
    expect(target(state, 'L').switchRequest).toBeDefined()
    expect(staleSwitches(state, START + 15 * MINUTE)).toMatchObject([line])
    expect(target(state, 'L').switchRequest).toBeUndefined()
  })
})
