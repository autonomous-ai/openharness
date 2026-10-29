import { describe, expect, it } from 'vitest'
import { agentOnly, type Agent, type Assignment, type Conversation, type SuperTabState } from './model.js'
import { ARCHIVE_QUIET_MS, archivable, IDLE_STOP_MS, stopIdleWorkers } from './tidy.js'

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

/** A Swarm whose Lead `L` runs on machine `m` with worker `w` (session `h`); the machine reported at `reportAt` that `h` runs
 *  with nothing uncommitted, unless `uncommitted` says otherwise. */
function swarm(opts: { agents?: Agent[]; groups?: Conversation[]; reportAt?: number; uncommitted?: Record<string, boolean> | null; running?: string[] } = {}) {
  const uncommitted = opts.uncommitted === undefined ? { h: false } : opts.uncommitted
  return {
    id: 't', ownerId: 'p', paused: false,
    agents: [worker({ id: 'L', harnessId: 'hl', name: 'Lead', displayName: 'River' }), ...opts.agents ?? [worker()]],
    people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
    machines: [{ machineId: 'm', name: 'Studio', observation: { receivedAt: opts.reportAt ?? START + 15 * MINUTE, runningHarnessIds: opts.running ?? ['hl', 'h'],
      stoppedHarnessIds: [], ...uncommitted ? { harnessUncommitted: uncommitted } : {} } }],
    conversations: [{ id: 'lead', title: 'Lead', leadId: 'L', agentIds: ['L'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
      ...opts.groups ?? [group()]],
  } as unknown as SuperTabState
}
const at = START + IDLE_STOP_MS
const target = (state: SuperTabState, id = 'w') => state.agents.find(a => a.id === id)!

describe('stopping idle workers', () => {
  it('stops a Swarm-started Builder 15 minutes after its last activity, with one line in its last group for the Lead', () => {
    const state = swarm()
    const rows = stopIdleWorkers(state, 'lead', at, new Set())
    expect(target(state)).toMatchObject({ workDecision: 'stop' })
    expect(target(state).releaseId).toEqual(expect.any(String))
    // Marked as the idle check's, so its host may withdraw it if its folder changed since (agent.stopRefused).
    expect(target(state).idleStop).toEqual({ previous: null })
    // Ken, 2026-10-29: the Lead's to handle, delivered to it; people do not read it (model.ts agentOnly).
    expect(rows).toEqual([expect.objectContaining({ conversationId: 'g1', recipients: ['L'], replyTo: null,
      author: expect.objectContaining({ kind: 'agent', id: 'L' }), text: 'Rowan stopped: no work for 15 minutes.',
      source: { kind: 'idle-stop', agentId: 'w' } })])
    expect(rows.map(row => agentOnly(row.source, row.recipients))).toEqual([true])
  })

  it('tells a Lead outside the worker\'s last group in its own chat, and hides the copy left in that group for no one', () => {
    const state = swarm({ groups: [group({ agentIds: ['w'] })] })
    const rows = stopIdleWorkers(state, 'lead', at, new Set())
    expect(rows.map(row => [row.conversationId, row.recipients])).toEqual([['g1', []], ['lead', ['L']]])
    expect(rows.map(row => agentOnly(row.source, row.recipients))).toEqual([true, true])
    expect(rows.map(row => row.source?.agentId)).toEqual(['w', 'w'])
  })

  it('waits until a full 15 minutes have passed since its group last spoke', () => {
    const state = swarm({ groups: [group({ lastActivityAt: iso(START + 5 * MINUTE) })] })
    expect(stopIdleWorkers(state, 'lead', at, new Set())).toEqual([])
    expect(target(state).workDecision).toBeUndefined()
    state.machines![0]!.observation!.receivedAt = at + 5 * MINUTE
    expect(stopIdleWorkers(state, 'lead', at + 5 * MINUTE, new Set())).toHaveLength(1)
  })

  it('counts its start, its last progress and a keep decision as activity', () => {
    const fresh = swarm({ agents: [worker({ startedSession: { creationId: 'c', sessionId: 's', createdAt: iso(START + MINUTE) } })], groups: [] })
    expect(stopIdleWorkers(fresh, 'lead', at, new Set())).toEqual([])
    const progressed = swarm({ groups: [group({ assignment: done({ progressAt: START + MINUTE }) })] })
    expect(stopIdleWorkers(progressed, 'lead', at, new Set())).toEqual([])
    const kept = swarm({ agents: [worker({ workDecision: 'keep', keptAt: START + MINUTE })] })
    expect(stopIdleWorkers(kept, 'lead', at, new Set())).toEqual([])
    kept.machines![0]!.observation!.receivedAt = at + MINUTE
    expect(stopIdleWorkers(kept, 'lead', at + MINUTE, new Set())).toHaveLength(1)
  })

  it('stops a worker that never got a task, saying so in the Lead conversation when it sits in no group', () => {
    const state = swarm({ groups: [] })
    expect(stopIdleWorkers(state, 'lead', at, new Set())).toEqual([expect.objectContaining({ conversationId: 'lead', recipients: ['L'] })])
    expect(target(state).workDecision).toBe('stop')
  })

  it('never stops a worker with active work, a queued delivery, or uncommitted changes', () => {
    expect(stopIdleWorkers(swarm({ groups: [group({ assignment: done({ status: 'working' }) })] }), 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm(), 'lead', at, new Set(['w']))).toEqual([])
    expect(stopIdleWorkers(swarm({ uncommitted: { h: true } }), 'lead', at, new Set())).toEqual([])
  })

  it('never stops a worker its host has not said is clean: an older host, a session not running, or a silent machine', () => {
    expect(stopIdleWorkers(swarm({ uncommitted: null }), 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ uncommitted: { other: false } }), 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ running: ['hl'] }), 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ reportAt: at - 3 * MINUTE }), 'lead', at, new Set())).toEqual([])
  })

  it('leaves Leads, people\'s own sessions, stopping workers and workers waiting out a usage limit alone', () => {
    const lead = swarm({ agents: [], uncommitted: { hl: false } })
    expect(stopIdleWorkers(lead, 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ agents: [worker({ startedSession: undefined })] }), 'lead', at, new Set())).toEqual([])
    const stopping = swarm({ agents: [worker({ workDecision: 'stop', releaseId: 'r1' })] })
    expect(stopIdleWorkers(stopping, 'lead', at, new Set())).toEqual([])
    expect(target(stopping).releaseId).toBe('r1')
    const limited = swarm({ agents: [worker({ lostTask: { conversationId: 'g1', assignmentId: 'a1', reason: 'limit', at: START, resumeAt: iso(at + MINUTE) } })],
      groups: [group({ assignment: done({ status: 'lost' }) })] })
    expect(stopIdleWorkers(limited, 'lead', at, new Set())).toEqual([])
  })

  it('keeps a worker waiting out a usage limit past its reset time, until its task resumes or is handed on', () => {
    const lostTask = { conversationId: 'g1', assignmentId: 'a1', reason: 'limit', at: START, resumeAt: iso(START + MINUTE) }
    const lost = () => group({ assignment: done({ status: 'lost', lost: { reason: 'limit', at: START, resumeAt: iso(START + MINUTE) } }) })
    // The reset passed long ago and the resume is late: its task still waits for it.
    const late = swarm({ agents: [worker({ lostTask })], groups: [lost()], reportAt: at + 10 * MINUTE })
    expect(stopIdleWorkers(late, 'lead', at + 10 * MINUTE, new Set())).toEqual([])
    // Handed on to another attempt, or cancelled: nothing waits for it any more.
    const handed = swarm({ agents: [worker({ lostTask })], groups: [group({ assignment: done({ id: 'a2', agentId: 'other', status: 'done' }) })] })
    expect(stopIdleWorkers(handed, 'lead', at, new Set())).toHaveLength(1)
    const cancelled = swarm({ agents: [worker({ lostTask })], groups: [group({ assignment: done({ status: 'cancelled' }) })] })
    expect(stopIdleWorkers(cancelled, 'lead', at, new Set())).toHaveLength(1)
  })

  it('keeps a Reviewer while the work it reviews is still open, and stops it once that work is finished', () => {
    const reviewer = worker({ role: 'reviewer' })
    const review = group({ id: 'r1', reviewOf: 'g1', assignment: done({ id: 'a2' }) })
    const open = swarm({ agents: [reviewer], groups: [group({ agentIds: ['L', 'b'], assignment: done({ agentId: 'b', status: 'review' }) }), review] })
    expect(stopIdleWorkers(open, 'lead', at, new Set())).toEqual([])
    const finished = swarm({ agents: [reviewer], groups: [group({ agentIds: ['L', 'b'], assignment: done({ agentId: 'b' }) }), review] })
    expect(stopIdleWorkers(finished, 'lead', at, new Set())).toHaveLength(1)
  })

  it('says so in a group the poll loaded, never in an asleep one, which would refuse the line (review of #2073)', () => {
    const reviewer = () => worker({ role: 'reviewer' })
    const asleep = group({ id: 'r2', reviewOf: 'g1', assignment: done({ id: 'a3' }), lastActivityAt: iso(START) })
    const older = group({ id: 'r1', reviewOf: 'g1', assignment: done({ id: 'a2' }), lastActivityAt: iso(START - 5 * MINUTE) })
    const finished = group({ agentIds: ['L', 'b'], assignment: done({ agentId: 'b' }) })
    const loaded = swarm({ agents: [reviewer()], groups: [finished, older] })
    expect(stopIdleWorkers(loaded, 'lead', at, new Set(), [asleep])).toEqual([expect.objectContaining({ conversationId: 'r1' })])
    const alone = swarm({ agents: [reviewer()], groups: [finished] })
    expect(stopIdleWorkers(alone, 'lead', at, new Set(), [asleep])).toEqual([expect.objectContaining({ conversationId: 'lead' })])
    expect(target(alone).workDecision).toBe('stop')
  })

  it('does nothing once the owner turned tidying off, or for another project\'s workers', () => {
    const off = swarm()
    off.tidy = false
    expect(stopIdleWorkers(off, 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ agents: [worker({ projectId: 'other' })] }), 'lead', at, new Set())).toEqual([])
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

  it('is never a review whose Reviewer gave no verdict while the work it reviews is going, unless it was cancelled', () => {
    const verdict = { id: 'v', description: 'Verdict with the reviewed revision', independent: false }
    const review = (patch: Partial<Conversation>) => group({ id: 'r1', reviewOf: 'g1', ...patch })
    // Stored as done with no verdict, as no command allows: the rule still holds.
    const state = swarm({ groups: [group({ assignment: done({ status: 'review' }) }),
      review({ checks: [{ ...verdict, evidence: null, passedBy: null }] }),
      review({ id: 'r2', checks: [{ ...verdict, evidence: 'Ready: yes — revision abc', passedBy: 'agent:w' }] }),
      review({ id: 'r3', checks: [{ ...verdict, evidence: null, passedBy: null }], assignment: done({ status: 'cancelled' }) })] })
    expect(state.conversations.slice(2).map(g => archivable(state, g, quiet))).toEqual([false, true, true])
    // Once the reviewed work is done, its review is moot.
    state.conversations[1]!.assignment = done()
    expect(archivable(state, state.conversations[2]!, quiet)).toBe(true)
  })

  it('is never a Lead conversation, a private chat, the Leads conversation, an archived group, or any once tidying is off', () => {
    const state = swarm({ groups: [group({ audience: { people: [] } as never }), group({ id: 'leads', kind: 'leads' }), group({ id: 'old', archived: true })] })
    for (const g of state.conversations) expect(archivable(state, g, quiet)).toBe(false)
    const off = swarm()
    off.tidy = false
    expect(archivable(off, off.conversations[1]!, quiet)).toBe(false)
  })
})
