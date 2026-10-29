import { describe, expect, it } from 'vitest'
import type { AgentStart, Assignment, SuperTabState } from './model.js'
import { LEASE_MS, QUIET_RUNNING_MS, sweepForLead, sweepLiveness } from './liveness.js'
import { MACHINE_FRESH_MS, startPreparing } from './machines.js'
import { split } from './parts/index.js'

const MINUTE = 60_000
const assignment = (patch: Partial<Assignment> = {}): Assignment => ({ id: 'a1', agentId: 'w', status: 'working', result: null,
  configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, ...patch })
/** A worker on machine `m` with session `h` holding `task`; the machine's last report, when given, listed it running. */
const swarm = (task: Assignment, report?: { receivedAt: number; harnessProgress?: Record<string, number> }, lastActivityAt?: number) => ({ id: 't',
  agents: [{ id: 'w', machineId: 'm', harnessId: 'h', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Worker', configuration: task.configuration }],
  people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
  machines: report ? [{ machineId: 'm', name: 'Mac', observation: { runningHarnessIds: ['h'], stoppedHarnessIds: [], ...report } }] : [],
  conversations: [{ id: 'lead', title: 'Lead', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }, { id: 'g1', title: 'Task', leadId: null, agentIds: ['w'], archived: false, brief: 'Do it', checks: [], assignment: task, lastMessageSequence: 0,
    ...(lastActivityAt === undefined ? {} : { lastActivityAt: new Date(lastActivityAt).toISOString() }) }],
} as unknown as SuperTabState)
const status = (state: SuperTabState, now: number) => (sweepLiveness(state, now), state.conversations[1]!.assignment!)

describe('the lease on a worker\'s task', () => {
  it('runs 30 minutes from the last progress a report showed for a running session, and is never written by the report', () => {
    const progress = 1_000_000, received = progress + 30 * MINUTE
    const lastRenewal = progress + QUIET_RUNNING_MS - LEASE_MS
    // Its own lease ran out long ago; the reports keep it until 5 minutes after the last one that still had fresh progress.
    const kept = swarm(assignment({ leaseUntil: 1 }), { receivedAt: lastRenewal + LEASE_MS, harnessProgress: { h: progress } })
    expect(status(kept, lastRenewal + LEASE_MS)).toMatchObject({ status: 'working', leaseUntil: 1 })
    const lost = swarm(assignment({ leaseUntil: 1 }), { receivedAt: lastRenewal + LEASE_MS + 1, harnessProgress: { h: progress } })
    expect(status(lost, lastRenewal + LEASE_MS + 1)).toMatchObject({ status: 'lost', lost: { reason: 'no progress for 30 minutes' } })
    // A report that has no progress for the session renews nothing.
    expect(status(swarm(assignment({ leaseUntil: 1 }), { receivedAt: received, harnessProgress: {} }), received).status).toBe('lost')
  })

  it('is renewed by a report listing the session running when the host sends no progress at all (an older host)', () => {
    expect(status(swarm(assignment({ leaseUntil: 1 }), { receivedAt: 50 * MINUTE }), 50 * MINUTE).status).toBe('working')
  })

  it('runs an assignment from before leases from its group\'s last message, without writing it', () => {
    const task = assignment()
    expect(status(swarm(task, undefined, 7000), 7000 + LEASE_MS)).toMatchObject({ status: 'working' })
    expect(task.leaseUntil).toBeUndefined()
    expect(status(swarm(task, undefined, 7000), 7000 + LEASE_MS + 1)).toMatchObject({ status: 'lost', lost: { reason: 'no progress seen' } })
  })
})

describe('a worker whose task is lost', () => {
  it('is marked lost in the same write that loses its task, so routing keeps it out after a cancel or reassignment', () => {
    const state = swarm(assignment({ leaseUntil: 1 })), now = 1 + LEASE_MS + 1
    const parts = () => split(structuredClone(state), { tabId: 't', version: 1, now: 0 })
    const before = parts()
    sweepLiveness(state, now)
    const after = parts()
    expect(after.agents[0]!.data).toMatchObject({ lostTask: { conversationId: 'g1', assignmentId: 'a1', reason: 'no progress seen', at: now } })
    // commitParts writes every part whose data changed, all in one transaction: the worker's with the task's.
    expect(after.agents[0]!.data).not.toEqual(before.agents[0]!.data)
    expect(after.groups.find(g => g.key === 'g1')!.data).not.toEqual(before.groups.find(g => g.key === 'g1')!.data)
  })
})

describe('a start its machine has launched', () => {
  const LAUNCHED = 1_000_000
  type Report = { machineId?: string; receivedAt: number; preparingStartIds?: string[] }
  /** The Lead's group, and a start for "Builder" sent to machine `m` (Worker Mac) at LAUNCHED; each report is a machine's last. */
  const launched = (reports: Report[] = [], start: Record<string, unknown> = {}) => ({ id: 't',
    agents: [{ id: 'L', machineId: 'lm', harnessId: 'lh', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Lead' }],
    people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
    machines: [{ machineId: 'm', name: 'Worker Mac' }, { machineId: 'x', name: 'Other Mac' }].map(machine => {
      const report = reports.find(r => (r.machineId ?? 'm') === machine.machineId)
      if (!report) return machine
      const { machineId: _machine, ...reading } = report
      return { ...machine, observation: { runningHarnessIds: [], stoppedHarnessIds: [], ...reading } }
    }),
    conversations: [{ id: 'lead', title: 'Lead', leadId: 'L', agentIds: ['L'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 }],
    starts: [{ id: 's1', request: { conversationId: 'lead', machineId: 'm', name: 'Builder' }, dispatched: true, dispatchedAt: LAUNCHED,
      harnessId: null, error: null, ...start }],
  } as unknown as SuperTabState)
  const sweep = (state: SuperTabState, now: number) => {
    const told = sweepLiveness(state, now).filter(row => row.source?.kind === 'start-timeout').map(row => row.text)
    return { error: state.starts![0]!.error, told }
  }

  it('fails 3 minutes after launch when its machine never says it is preparing, as an older machine does', () => {
    const at = LAUNCHED + 3 * MINUTE
    expect(sweep(launched([{ receivedAt: at }]), at)).toEqual({ error: null, told: [] })
    expect(sweep(launched([{ receivedAt: at }]), at + 1)).toEqual({ error: 'Worker Mac did not start it within 3 minutes',
      told: ['Could not start Builder: its machine did not start it within 3 minutes.'] })
    expect(sweep(launched(), at + 1).error).toBe('Worker Mac did not start it within 3 minutes')
  })

  it('waits while its machine\'s reports say it is preparing, and fails it 15 minutes after launch', () => {
    const at = LAUNCHED + 15 * MINUTE
    expect(sweep(launched([{ receivedAt: LAUNCHED + 5 * MINUTE, preparingStartIds: ['s1'] }]), LAUNCHED + 5 * MINUTE).error).toBeNull()
    expect(sweep(launched([{ receivedAt: at - 10_000, preparingStartIds: ['s1'] }]), at)).toEqual({ error: null, told: [] })
    expect(sweep(launched([{ receivedAt: at, preparingStartIds: ['s1'] }]), at + 1)).toEqual({ error: 'Worker Mac was still preparing it after 15 minutes',
      told: ['Could not start Builder: its machine was still preparing it after 15 minutes.'] })
  })

  it('fails once its machine\'s reports saying it is preparing have stopped for three beats', () => {
    const now = LAUNCHED + 6 * MINUTE
    expect(sweep(launched([{ receivedAt: now - MACHINE_FRESH_MS, preparingStartIds: ['s1'] }]), now).error).toBeNull()
    expect(sweep(launched([{ receivedAt: now - MACHINE_FRESH_MS - 1, preparingStartIds: ['s1'] }]), now)).toEqual({
      error: 'Worker Mac stopped reporting while preparing it', told: ['Could not start Builder: its machine stopped reporting while preparing it.'] })
    // The latest report no longer lists it: preparing is over without a start, so the 3 minutes apply.
    expect(sweep(launched([{ receivedAt: now, preparingStartIds: [] }]), now).error).toBe('Worker Mac did not start it within 3 minutes')
  })

  it('is kept waiting only by its own machine\'s report naming it', () => {
    const now = LAUNCHED + 3 * MINUTE + 1
    expect(sweep(launched([{ receivedAt: now, preparingStartIds: ['another-start'] }]), now).error).toBe('Worker Mac did not start it within 3 minutes')
    expect(sweep(launched([{ machineId: 'x', receivedAt: now, preparingStartIds: ['s1'] }]), now).error).toBe('Worker Mac did not start it within 3 minutes')
  })

  it('says a start is preparing only while its own machine\'s fresh report names it and it is neither running nor failed', () => {
    const now = LAUNCHED + 4 * MINUTE
    const preparing = (state: SuperTabState) => startPreparing(state, state.starts![0]!, now)
    expect(preparing(launched([{ receivedAt: now, preparingStartIds: ['s1'] }]))).toBe(true)
    expect(preparing(launched([{ receivedAt: now, preparingStartIds: ['s1'] }], { harnessId: 'h' }))).toBe(false)
    expect(preparing(launched([{ receivedAt: now, preparingStartIds: ['s1'] }], { error: 'Could not prepare' }))).toBe(false)
    expect(preparing(launched([{ receivedAt: now, preparingStartIds: ['s1'] }], { dispatched: false, dispatchedAt: undefined }))).toBe(false)
    expect(preparing(launched([{ machineId: 'x', receivedAt: now, preparingStartIds: ['s1'] }]))).toBe(false)
    expect(preparing(launched([{ receivedAt: now - MACHINE_FRESH_MS - 1, preparingStartIds: ['s1'] }]))).toBe(false)
  })
})

describe('the state of each task, and the Lead woken when one stalls', () => {
  const NOW = 100 * MINUTE
  /** A project "lead" led by L, its owner p, and task g1 ("Ship it", #7) held by worker w, whose machine reports it running
   *  with a fresh screen, so only the task's own progress decides. */
  const project = (task: Partial<Assignment> | null, patch: Record<string, unknown> = {}) => ({ id: 't', name: 'Swarm', ownerId: 'p',
    agents: [{ id: 'L', machineId: 'lm', harnessId: 'lh', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Lead' },
      { id: 'w', machineId: 'm', harnessId: 'h', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Worker', displayName: 'Luna',
        configuration: assignment().configuration }],
    people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
    machines: [{ machineId: 'm', name: 'Mac', observation: { runningHarnessIds: ['h'], stoppedHarnessIds: [], receivedAt: NOW, harnessProgress: { h: NOW } } }],
    conversations: [{ id: 'lead', title: 'Lead', leadId: 'L', agentIds: ['L'], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
      { id: 'g1', number: 7, title: 'Ship it', leadId: 'L', agentIds: ['L', 'w'], archived: false, brief: 'Do it', checks: [], lastMessageSequence: 0,
        assignment: task && assignment({ leaseUntil: NOW + LEASE_MS, progressAt: NOW, ...task }) }],
    starts: [], ...patch,
  } as unknown as SuperTabState)
  const task = (state: SuperTabState) => state.conversations.find(c => c.id === 'g1')!
  const wakes = (rows: ReturnType<typeof sweepLiveness>) => rows.filter(r => r.source?.kind === 'work-stalled')

  it('is never recorded by a machine\'s reading, which loads only running work and writes no group', () => {
    const state = project({ progressAt: NOW - 40 * MINUTE })
    expect(sweepLiveness(state, NOW).filter(r => r.source?.kind === 'work-stalled')).toEqual([])
    expect(task(state).liveness).toBeUndefined()
  })

  it('has no record while its agent reported progress in the last 30 minutes, and wakes nobody', () => {
    const state = project({ progressAt: NOW - 29 * MINUTE })
    const parts = () => split(structuredClone(state), { tabId: 't', version: 1, now: 0 }).groups
    const before = parts()
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toBeUndefined()
    // A steady Swarm's time checks write no group.
    expect(parts()).toEqual(before)
  })

  it('turns quiet after 30 minutes without its agent\'s own status, check or post, and wakes the Lead once, in its chat', () => {
    const state = project({ progressAt: NOW - 30 * MINUTE })
    const rows = wakes(sweepForLead(state, NOW))
    expect(task(state).liveness).toEqual({ state: 'quiet', why: 'silent', since: NOW - 30 * MINUTE })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversationId: 'lead', recipients: ['L'], author: { kind: 'agent', id: 'L' },
      source: { kind: 'work-stalled', tasks: [{ conversationId: 'g1', state: 'quiet', why: 'silent' }] } })
    expect(rows[0]!.text).toBe('A task needs you:\n- #7 "Ship it": quiet, Luna has reported nothing for 30 minutes.\n'
      + 'Act on it now: nudge its agent, reassign it, or post in its chat why it waits.')
    // Every later sweep, on any server, sees it already quiet.
    expect(wakes(sweepForLead(state, NOW + 30_000))).toEqual([])
    expect(wakes(sweepForLead(state, NOW + 60 * MINUTE))).toEqual([])
  })

  it('names its wake-up apart from another Swarm\'s whose project has the same id, stalling at the same moment', () => {
    const one = project({ progressAt: NOW - 30 * MINUTE }), other = { ...project({ progressAt: NOW - 30 * MINUTE }), id: 't2' }
    expect(wakes(sweepForLead(one, NOW))[0]!.id).not.toBe(wakes(sweepForLead(other, NOW))[0]!.id)
  })

  it('wakes the Lead again only after the task moved and stalled once more', () => {
    const state = project({ progressAt: NOW - 30 * MINUTE })
    sweepForLead(state, NOW)
    task(state).assignment!.progressAt = NOW + MINUTE
    task(state).assignment!.leaseUntil = NOW + MINUTE + LEASE_MS
    expect(wakes(sweepForLead(state, NOW + 2 * MINUTE))).toEqual([])
    expect(task(state).liveness).toBeUndefined()
    // Its machine still reports the session running, its screen changing.
    state.machines![0]!.observation = { ...state.machines![0]!.observation!, receivedAt: NOW + 31 * MINUTE, harnessProgress: { h: NOW + 31 * MINUTE } }
    expect(wakes(sweepForLead(state, NOW + 31 * MINUTE))).toHaveLength(1)
  })

  it('waits on purpose, never quiet, while it needs a person (named), is in review or is blocked', () => {
    const asked = project({ status: 'needs_human', result: 'Mockup OK?', progressAt: NOW - 3 * 60 * MINUTE })
    task(asked).ledger = { waiting: { assignmentId: 'a1', since: NOW - 12 * MINUTE, messageId: 'm1' } }
    expect(wakes(sweepForLead(asked, NOW))).toEqual([])
    expect(task(asked).liveness).toEqual({ state: 'waiting', why: 'person', personId: 'p', since: NOW - 12 * MINUTE })
    const review = project({ status: 'review', progressAt: NOW - 3 * 60 * MINUTE })
    expect(wakes(sweepForLead(review, NOW))).toEqual([])
    expect(task(review).liveness).toEqual({ state: 'waiting', why: 'review', since: NOW - 3 * 60 * MINUTE })
    const blocked = project({ status: 'blocked', progressAt: NOW - 3 * 60 * MINUTE })
    expect(wakes(sweepForLead(blocked, NOW))).toEqual([])
    expect(task(blocked).liveness).toEqual({ state: 'waiting', why: 'blocked', since: NOW - 3 * 60 * MINUTE })
  })

  it('waits, never quiet, while it reviews a build that is back in progress, and turns quiet once that build is ready again', () => {
    const state = project({ progressAt: NOW - 3 * 60 * MINUTE })
    // g1 is now the review of build g0, whose Engineer is fixing the findings.
    task(state).reviewOf = 'g0'
    state.conversations.push({ ...structuredClone(task(state)), id: 'g0', number: 6, title: 'Build', reviewOf: undefined,
      assignment: assignment({ id: 'a0', agentId: 'L', status: 'working', progressAt: NOW }) })
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toEqual({ state: 'waiting', why: 'revision', since: NOW - 3 * 60 * MINUTE })
    state.conversations.find(c => c.id === 'g0')!.assignment!.status = 'review'
    expect(wakes(sweepForLead(state, NOW))).toHaveLength(1)
    expect(task(state).liveness).toMatchObject({ state: 'quiet', why: 'silent' })
  })

  it('is orphaned at once when its agent was removed or is gone, and wakes the Lead once', () => {
    const removed = project({ status: 'reconciling' })
    expect(wakes(sweepForLead(removed, NOW))[0]!.text).toContain('- #7 "Ship it": orphaned, its agent was removed from the Swarm.')
    expect(task(removed).liveness).toEqual({ state: 'orphaned', why: 'removed', since: NOW })
    expect(wakes(sweepForLead(removed, NOW + MINUTE))).toEqual([])
    const gone = project({})
    gone.agents = gone.agents.filter(a => a.id !== 'w')
    expect(wakes(sweepForLead(gone, NOW))).toHaveLength(1)
    expect(task(gone).liveness).toMatchObject({ state: 'orphaned', why: 'removed' })
  })

  it('is orphaned when its agent stopped, told by the lost-work notice alone', () => {
    const state = project({})
    state.machines![0]!.observation!.stoppedHarnessIds = ['h']
    const rows = sweepForLead(state, NOW)
    expect(rows.filter(r => r.source?.kind === 'work-lost' && r.recipients.includes('L'))).toHaveLength(1)
    expect(wakes(rows)).toEqual([])
    expect(task(state).liveness).toEqual({ state: 'orphaned', why: 'lost', since: NOW })
  })

  /** Task g1 with no assignment yet and one start for it, asked for at `requestedAt`. */
  const starting = (start: Record<string, unknown>) => project(null, { starts: [{ id: 's1', request: { conversationId: 'g1', machineId: 'm', name: 'Builder' },
    dispatched: false, harnessId: null, error: null, requestedAt: NOW - 9 * MINUTE, ...start }] })

  it('waits queued while its start is not launched, and is orphaned 10 minutes after it was asked for, waking the Lead once', () => {
    const queued = starting({})
    expect(wakes(sweepForLead(queued, NOW))).toEqual([])
    expect(task(queued).liveness).toEqual({ state: 'waiting', why: 'queued', since: NOW - 9 * MINUTE })
    const stale = starting({ requestedAt: NOW - 10 * MINUTE })
    expect(wakes(sweepForLead(stale, NOW))[0]!.text).toContain('- #7 "Ship it": orphaned, its agent has not started for 10 minutes.')
    expect(task(stale).liveness).toEqual({ state: 'orphaned', why: 'unstarted', since: NOW - 10 * MINUTE })
    expect(wakes(sweepForLead(stale, NOW + MINUTE))).toEqual([])
  })

  it('waits queued, never orphaned and never written again, while a start from before request times is not launched', () => {
    const legacy = starting({ requestedAt: undefined })
    sweepForLead(legacy, NOW)
    const recorded = task(legacy).liveness
    expect(recorded).toEqual({ state: 'waiting', why: 'queued', since: NOW })
    sweepForLead(legacy, NOW + 60 * MINUTE)
    expect(task(legacy).liveness).toBe(recorded)
  })

  it('stays queued while the Lead keeps acting on it: 10 minutes run from its last action', () => {
    const retried = starting({ requestedAt: NOW - 25 * MINUTE })
    task(retried).leadAction = { kind: 'route', at: NOW - 2 * MINUTE }
    expect(wakes(sweepForLead(retried, NOW))).toEqual([])
    expect(task(retried).liveness).toEqual({ state: 'waiting', why: 'queued', since: NOW - 25 * MINUTE })
  })

  it('waits while its launched start is being prepared, and is orphaned when the start fails, told by the failure notice alone', () => {
    const launched = starting({ dispatched: true, dispatchedAt: NOW - MINUTE })
    sweepForLead(launched, NOW)
    expect(task(launched).liveness).toEqual({ state: 'waiting', why: 'starting', since: NOW - MINUTE })
    const failed = starting({ dispatched: true, dispatchedAt: NOW - MINUTE, error: 'Mac could not prepare it' })
    expect(wakes(sweepForLead(failed, NOW))).toEqual([])
    expect(task(failed).liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: NOW })
  })

  it('lists every task that stalled in one wake-up, and none for finished work or a Buddy\'s start', () => {
    const state = project({ progressAt: NOW - 40 * MINUTE })
    state.conversations.push({ ...structuredClone(task(state)), id: 'g2', number: 8, title: 'Second', assignment: { ...task(state).assignment!, id: 'a2', status: 'reconciling' } },
      { ...structuredClone(task(state)), id: 'g3', number: 9, title: 'Finished', assignment: { ...task(state).assignment!, id: 'a3', status: 'done' } })
    state.starts = [{ id: 'b1', request: { conversationId: 'g3', machineId: 'm', name: 'Buddy', buddyOf: { personId: 'p', generation: 'g' } },
      dispatched: false, harnessId: null, error: null, requestedAt: 0 } as unknown as AgentStart]
    const rows = wakes(sweepForLead(state, NOW))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.source!.tasks).toEqual([{ conversationId: 'g1', state: 'quiet', why: 'silent' }, { conversationId: 'g2', state: 'orphaned', why: 'removed' }])
    expect(rows[0]!.text.startsWith('2 tasks need you:\n')).toBe(true)
    expect(state.conversations.find(c => c.id === 'g3')!.liveness).toBeUndefined()
    expect(state.conversations.find(c => c.id === 'lead')!.liveness).toBeUndefined()
  })

  it('clears its state once its work is finished', () => {
    const state = project({ progressAt: NOW - 40 * MINUTE })
    sweepForLead(state, NOW)
    task(state).assignment!.status = 'done'
    sweepForLead(state, NOW + MINUTE)
    expect(task(state).liveness).toBeUndefined()
  })
})
