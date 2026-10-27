import { describe, expect, it } from 'vitest'
import type { Agent, Assignment, Conversation, SuperTabState } from './model.js'
import { IDLE_STOP_MS, stopIdleWorkers } from './tidy.js'

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
  it('stops a Swarm-started Builder 15 minutes after its last activity, with one quiet line in its last group', () => {
    const state = swarm()
    const rows = stopIdleWorkers(state, 'lead', at, new Set())
    expect(target(state)).toMatchObject({ workDecision: 'stop' })
    expect(target(state).releaseId).toEqual(expect.any(String))
    expect(rows).toEqual([expect.objectContaining({ conversationId: 'g1', recipients: [], replyTo: null,
      author: expect.objectContaining({ kind: 'agent', id: 'L' }), text: 'Rowan stopped: no work for 15 minutes.',
      source: { kind: 'idle-stop', agentId: 'w' } })])
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
    expect(stopIdleWorkers(state, 'lead', at, new Set())).toEqual([expect.objectContaining({ conversationId: 'lead' })])
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
    const limited = swarm({ agents: [worker({ lostTask: { conversationId: 'g1', assignmentId: 'a1', reason: 'limit', at: START, resumeAt: iso(at + MINUTE) } })] })
    expect(stopIdleWorkers(limited, 'lead', at, new Set())).toEqual([])
  })

  it('keeps a Reviewer while the work it reviews is still open, and stops it once that work is finished', () => {
    const reviewer = worker({ role: 'reviewer' })
    const review = group({ id: 'r1', reviewOf: 'g1', assignment: done({ id: 'a2' }) })
    const open = swarm({ agents: [reviewer], groups: [group({ agentIds: ['L', 'b'], assignment: done({ agentId: 'b', status: 'review' }) }), review] })
    expect(stopIdleWorkers(open, 'lead', at, new Set())).toEqual([])
    const finished = swarm({ agents: [reviewer], groups: [group({ agentIds: ['L', 'b'], assignment: done({ agentId: 'b' }) }), review] })
    expect(stopIdleWorkers(finished, 'lead', at, new Set())).toHaveLength(1)
  })

  it('does nothing once the owner turned tidying off, or for another project\'s workers', () => {
    const off = swarm()
    off.tidy = false
    expect(stopIdleWorkers(off, 'lead', at, new Set())).toEqual([])
    expect(stopIdleWorkers(swarm({ agents: [worker({ projectId: 'other' })] }), 'lead', at, new Set())).toEqual([])
  })
})
