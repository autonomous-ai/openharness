import { describe, expect, it } from 'vitest'
import type { AgentStart, Assignment, SuperTabState } from './model.js'
import { changesRequested, LEASE_MS, loseTasks, nextLossAt, QUIET_RUNNING_MS, renewOwnTask, revisionReady, sweepForLead, sweepLiveness, waitingForReview } from './liveness.js'
import { MACHINE_FRESH_MS, startPreparing } from './machines.js'
import { split } from './parts/index.js'
import { stepsFixture } from './steps.test-support.js'

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

describe('a task waiting on a person (task #2969)', () => {
  // 2026-11-04: an Engineer asked Huy, set needs_human with a 10:00 default, printed nothing, and lost its task after 30 minutes.
  const asked = 1_000_000, HOUR = 60 * MINUTE
  const waiting = (patch: Partial<Assignment> = {}, report: { receivedAt: number; harnessProgress?: Record<string, number> } | undefined = { receivedAt: asked + 2 * HOUR, harnessProgress: { h: asked } }) =>
    swarm(assignment({ status: 'needs_human', result: 'Mockup OK?', leaseUntil: asked + LEASE_MS, progressAt: asked, ...patch }), report)

  it('stays its agent\'s for 2 hours while the agent is alive on its machine, whatever its screen does', () => {
    for (const status of ['needs_human', 'blocked'] as const) {
      const idle = waiting({ status })
      expect(sweepLiveness(idle, asked + 2 * HOUR)).toEqual([])
      expect(idle.conversations[1]!.assignment!.status).toBe(status)
      // Even a session that reports no progress at all.
      expect(sweepLiveness(waiting({ status }, { receivedAt: asked + 2 * HOUR, harnessProgress: {} }), asked + 2 * HOUR)).toEqual([])
    }
  })

  it('is lost once its session is stopped, its machine is offline past the grace, or it is no longer running', () => {
    const stopped = waiting()
    stopped.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(status(stopped, asked + 2 * HOUR).status).toBe('lost')
    const offline = waiting()
    expect(status(offline, asked + 2 * HOUR + 3 * MINUTE).status).toBe('lost')
    const gone = waiting()
    gone.machines![0]!.observation!.runningHarnessIds = []
    expect(status(gone, asked + 2 * HOUR).status).toBe('lost')
  })

  it('is lost when no report ever showed its session, as before', () => {
    expect(status(waiting({}, undefined), asked + 2 * HOUR).status).toBe('lost')
  })

  it('runs 30 minutes from the person\'s answer, then is lost if the agent stays quiet', () => {
    const answeredAt = asked + HOUR
    const answered = (now: number) => {
      const state = waiting({}, { receivedAt: now, harnessProgress: { h: asked } })
      state.conversations[1]!.ledger = { waiting: { assignmentId: 'a1', since: asked, messageId: 'm', answeredAt } } as never
      return state
    }
    expect(status(answered(answeredAt + QUIET_RUNNING_MS), answeredAt + QUIET_RUNNING_MS).status).toBe('needs_human')
    expect(status(answered(answeredAt + QUIET_RUNNING_MS + 1), answeredAt + QUIET_RUNNING_MS + 1)).toMatchObject({ status: 'lost', lost: { reason: expect.stringContaining('no progress') } })
  })

  it('keeps today\'s 30-minute rule for a working assignment', () => {
    const working = (now: number) => swarm(assignment({ leaseUntil: asked + LEASE_MS, progressAt: asked }), { receivedAt: now, harnessProgress: { h: asked } })
    expect(status(working(asked + QUIET_RUNNING_MS), asked + QUIET_RUNNING_MS).status).toBe('working')
    expect(status(working(asked + QUIET_RUNNING_MS + 1), asked + QUIET_RUNNING_MS + 1).status).toBe('lost')
  })

  it('has no loss time while it waits for the person, so a machine\'s report is not scheduled for it', () => {
    expect(nextLossAt(waiting(), 'm')).toBeUndefined()
  })
})

describe('a task waiting for review', () => {
  // 2026-10-29: five Engineers who had pushed and handed over lost their tasks after 30 quiet minutes waiting for a Reviewer.
  const handedOver = 1_000_000
  const quiet = (status: 'review' | 'working', minutes: number) => status === 'review'
    ? swarm(assignment({ status, result: 'Ready for review: abc123', leaseUntil: handedOver + LEASE_MS, progressAt: handedOver }),
      { receivedAt: handedOver + minutes * MINUTE, harnessProgress: { h: handedOver } })
    : swarm(assignment({ status, leaseUntil: handedOver + LEASE_MS, progressAt: handedOver }),
      { receivedAt: handedOver + minutes * MINUTE, harnessProgress: { h: handedOver } })

  it('stays with its Engineer through 45 quiet minutes, while working work is still lost after 30', () => {
    expect(status(quiet('review', 45), handedOver + 45 * MINUTE)).toMatchObject({ status: 'review', result: 'Ready for review: abc123' })
    expect(status(quiet('working', 30), handedOver + 30 * MINUTE).status).toBe('working')
    expect(status(quiet('working', 30), handedOver + 30 * MINUTE + 1)).toMatchObject({ status: 'lost', lost: { reason: 'no progress for 30 minutes' } })
  })

  // Agents on the older built-in skills hand over as working with a "ready for review" result naming a revision, since their
  // skills had Done refused until a review passed. While such agents exist (this release), that result still waits, until a
  // review finds problems in it (final review of the project instructions branch).
  it('waits in the review status, and in an older skill\'s working hand-off until a review finds problems in it', () => {
    expect(waitingForReview(assignment({ status: 'review', result: 'Ready for review @abc1234' }))).toBe(true)
    expect(waitingForReview(assignment({ status: 'review', result: null }))).toBe(true)
    expect(waitingForReview(assignment({ status: 'working', result: 'Ready for review @abc1234' }))).toBe(true)
    expect(waitingForReview(assignment({ status: 'working', result: 'Ready for review @abc1234', reviewFoundAt: 5 }))).toBe(false)
    // No revision named, or no hand-off: working work counts its quiet time.
    expect(waitingForReview(assignment({ status: 'working', result: 'Ready for review on 2026-10-30' }))).toBe(false)
    expect(waitingForReview(assignment({ status: 'working', result: 'Pushed abc1234' }))).toBe(false)
    const handOff = (patch: Partial<Assignment> = {}) => status(swarm(assignment({ result: 'Ready for review: https://github.com/example/project/pull/2180 at 4f9c2e1',
      leaseUntil: handedOver + LEASE_MS, progressAt: handedOver, ...patch }), { receivedAt: handedOver + 45 * MINUTE, harnessProgress: { h: handedOver } }), handedOver + 45 * MINUTE)
    expect(handOff()).toMatchObject({ status: 'working' })
    expect(handOff({ reviewFoundAt: handedOver })).toMatchObject({ status: 'lost', lost: { reason: 'no progress for 45 minutes' } })
  })

  it('is still lost at once when its session stops or its machine goes offline', () => {
    const stopped = quiet('review', 1)
    stopped.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(status(stopped, handedOver + MINUTE)).toMatchObject({ status: 'lost', lost: { reason: 'its session on Mac stopped' } })
    expect(status(quiet('review', 1), handedOver + 4 * MINUTE)).toMatchObject({ status: 'lost', lost: { reason: 'its machine Mac has been offline for 2 minutes' } })
  })
})

describe('a review task while its build is back with the Engineer', () => {
  // Diego, 2026-11-01: a Reviewer checks and posts in the build's group, which never renewed its own linked task, so after a
  // normal fix round of ~31 minutes the review task was lost, its Lead woken and the Reviewer told to stop. Review of #2487: it
  // follows the Reviewer, never the Engineer, so an idle Reviewer is still lost.
  const asked = 1_000_000
  /** Review task r1 (reviewOf g1) held by Reviewer w on Mac, which reports it running with no screen change since [asked];
   *  build g1 held by Engineer e on Studio, both machines reporting at [at]. */
  const reviewing = (at: number, build: Partial<Assignment> = {}, buildPatch: Record<string, unknown> = {}, review: Partial<Assignment> = { changesRequestedAt: asked }) => {
    const report = (h: string) => ({ runningHarnessIds: [h], stoppedHarnessIds: [], receivedAt: at, harnessProgress: { [h]: asked } })
    return { id: 't',
      agents: [{ id: 'w', machineId: 'm', harnessId: 'h', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Reviewer' },
        { id: 'e', machineId: 'm2', harnessId: 'h2', machineOwnerId: 'o', contributorId: 'p', membershipGeneration: 'g', name: 'Builder' }],
      people: [{ id: 'p', email: 'p@example.com', role: 'owner', generation: 'g' }],
      machines: [{ machineId: 'm', name: 'Mac', observation: report('h') }, { machineId: 'm2', name: 'Studio', observation: report('h2') }],
      conversations: [{ id: 'lead', title: 'Lead', leadId: null, agentIds: [], archived: false, brief: '', checks: [], assignment: null, lastMessageSequence: 0 },
        { id: 'g1', title: 'Build', leadId: null, agentIds: ['e', 'w'], archived: false, brief: 'Do it', checks: [], lastMessageSequence: 0,
          assignment: assignment({ id: 'b1', agentId: 'e', execution: { machineId: 'm2', harnessId: 'h2', machineOwnerId: 'o' },
            leaseUntil: at + LEASE_MS, progressAt: at, ...build }), ...buildPatch },
        { id: 'r1', title: 'Review: Build', leadId: null, agentIds: ['w'], archived: false, brief: 'Review it', checks: [], lastMessageSequence: 0, reviewOf: 'g1',
          assignment: assignment({ id: 'r', leaseUntil: asked + LEASE_MS, progressAt: asked, ...review }) }],
    } as unknown as SuperTabState
  }
  const group = (state: SuperTabState, id: string) => state.conversations.find(c => c.id === id)!
  const review = (state: SuperTabState) => group(state, 'r1').assignment!
  const sweep = (state: SuperTabState, now: number) => {
    const rows = sweepLiveness(state, now).filter(row => row.source?.kind === 'work-lost' && row.source.assignmentId === 'r')
    return { status: review(state).status, lost: rows.length > 0 }
  }
  const later = asked + 35 * MINUTE

  it('keeps its task through 35 quiet minutes after its verdict asked for changes, while the build is in progress, blocked or asking a person', () => {
    for (const status of ['working', 'blocked', 'needs_human'] as const) expect(sweep(reviewing(later, { status }), later)).toEqual({ status: 'working', lost: false })
    // Nor is it the next loss its machine's reports wait for.
    expect(nextLossAt(reviewing(later), 'm')).toBeUndefined()
  })

  it('is lost after 30 quiet minutes with no verdict asking for changes, though its Engineer keeps working and sending heartbeats', () => {
    // The Engineer's "working" heartbeats renew the build every few minutes; the Reviewer sits idle.
    const idle = (at: number) => reviewing(at, { status: 'working', result: 'Working: awaiting review', progressAt: at, leaseUntil: at + LEASE_MS }, {}, {})
    expect(sweep(idle(asked + QUIET_RUNNING_MS), asked + QUIET_RUNNING_MS)).toEqual({ status: 'working', lost: false })
    expect(nextLossAt(idle(asked + 26 * MINUTE), 'm')).toBe(asked + QUIET_RUNNING_MS)
    const lost = idle(asked + QUIET_RUNNING_MS + 1)
    expect(sweep(lost, asked + QUIET_RUNNING_MS + 1)).toEqual({ status: 'lost', lost: true })
    expect(review(lost).lost?.reason).toBe('no progress for 30 minutes')
    // The build waiting for review again, with the Reviewer idle since: lost the same way.
    expect(sweep(reviewing(later, { status: 'review', result: 'Ready for review at abc1234' }, {}, {}), later)).toEqual({ status: 'lost', lost: true })
  })

  // Task #2241: Reviewers give their verdict as a post, and stay Working while the Engineer fixes it (instructions, revision 27).
  const told = { toldEngineerAt: asked }
  it('keeps its task through 35 quiet minutes after writing to its Engineer, while the Engineer is fixing', () => {
    for (const status of ['working', 'blocked', 'needs_human'] as const) expect(sweep(reviewing(later, { status }, {}, told), later)).toEqual({ status: 'working', lost: false })
    expect(nextLossAt(reviewing(later, {}, {}, told), 'm')).toBeUndefined()
  })

  it('holds nothing when its Engineer is waiting on a review: "starting now", then silence, still moves', () => {
    const waiting = reviewing(later, { status: 'review', result: 'Ready for review at abc1234' }, {}, told)
    expect(sweep(waiting, later)).toEqual({ status: 'lost', lost: true })
    expect(review(waiting).lost?.reason).toBe('no progress for 35 minutes')
    // An older skill's hand-off is working by status, and waits on a review all the same.
    expect(sweep(reviewing(later, { status: 'working', result: 'Ready for review at abc1234' }, {}, told), later)).toEqual({ status: 'lost', lost: true })
  })

  it('has 30 minutes from the Engineer\'s next Ready, and is moved after them', () => {
    const ready = (at: number) => {
      const state = reviewing(at, { status: 'review', result: 'Ready for review at abc1234', progressAt: later }, {}, told)
      revisionReady(state, group(state, 'g1'), later)
      return state
    }
    expect(review(ready(later)).toldEngineerAt).toBeUndefined()
    expect(sweep(ready(later + QUIET_RUNNING_MS), later + QUIET_RUNNING_MS)).toEqual({ status: 'working', lost: false })
    expect(sweep(ready(later + QUIET_RUNNING_MS + 1), later + QUIET_RUNNING_MS + 1)).toEqual({ status: 'lost', lost: true })
  })

  it('still loses its task at once when its session stops or its machine goes, and to time once its build ends', () => {
    const stopped = reviewing(later, {}, {}, told)
    stopped.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(sweep(stopped, later)).toEqual({ status: 'lost', lost: true })
    for (const status of ['cancelled', 'done', 'lost'] as const) expect(sweep(reviewing(later, { status }, {}, told), later)).toEqual({ status: 'lost', lost: true })
  })

  it('still loses its task to time once its build is cancelled, finished, lost, archived, unloaded or in another project', () => {
    for (const status of ['cancelled', 'done', 'lost'] as const) expect(sweep(reviewing(later, { status }), later)).toEqual({ status: 'lost', lost: true })
    expect(sweep(reviewing(later, {}, { archived: true }), later)).toEqual({ status: 'lost', lost: true })
    expect(sweep(reviewing(later, {}, { projectId: 'other', agentIds: ['e'] }), later)).toEqual({ status: 'lost', lost: true })
    const asleep = reviewing(later)
    asleep.conversations = asleep.conversations.filter(c => c.id !== 'g1')
    expect(sweep(asleep, later)).toEqual({ status: 'lost', lost: true })
    expect(nextLossAt(reviewing(later, { status: 'cancelled' }), 'm')).toBe(asked + QUIET_RUNNING_MS)
  })

  it('still loses its task at once when its session stops, its machine goes offline, it hits a limit or its model keeps failing', () => {
    const stopped = reviewing(later)
    stopped.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(sweep(stopped, later)).toEqual({ status: 'lost', lost: true })
    const offline = reviewing(later - 3 * MINUTE)
    sweep(offline, later)
    expect(review(offline)).toMatchObject({ status: 'lost', lost: { reason: 'its machine Mac has been offline for 2 minutes' } })
    const limited = reviewing(later)
    Object.assign(limited.agents[0]!, { alerting: ['limit'], limitedUntil: new Date(later + 60 * MINUTE).toISOString() })
    expect(sweep(limited, later)).toEqual({ status: 'lost', lost: true })
    const failing = reviewing(later)
    Object.assign(failing.agents[0]!, { alerting: ['model'] })
    expect(sweep(failing, later)).toEqual({ status: 'lost', lost: true })
  })

  it('has 30 minutes from the build\'s next Ready, so the end of the wait does not lose it', () => {
    const ready = (at: number) => {
      const state = reviewing(at, { status: 'review', result: 'Ready for review at abc1234', progressAt: later })
      revisionReady(state, group(state, 'g1'), later)
      return state
    }
    expect(review(ready(later))).toMatchObject({ progressAt: later, leaseUntil: later + QUIET_RUNNING_MS })
    expect(review(ready(later)).changesRequestedAt).toBeUndefined()
    expect(sweep(ready(later + QUIET_RUNNING_MS), later + QUIET_RUNNING_MS)).toEqual({ status: 'working', lost: false })
    expect(nextLossAt(ready(later + MINUTE), 'm')).toBe(later + QUIET_RUNNING_MS)
    const quiet = ready(later + QUIET_RUNNING_MS + 1)
    expect(sweep(quiet, later + QUIET_RUNNING_MS + 1)).toEqual({ status: 'lost', lost: true })
    expect(review(quiet).lost?.reason).toBe('no progress for 30 minutes')
  })

  it('is renewed and marked only by its own Reviewer acting in the build, never by the Engineer, another agent or another project', () => {
    const state = reviewing(asked, {}, {}, {})
    // A second linked task, a Tester's, and a linked task of another project naming the same build.
    state.agents.push({ ...structuredClone(state.agents[0]!), id: 't2', harnessId: 'h3', name: 'Tester' })
    state.conversations.push({ ...structuredClone(group(state, 'r1')), id: 's1', assignment: assignment({ id: 's', agentId: 't2', leaseUntil: 1, progressAt: 1 }) },
      { ...structuredClone(group(state, 'r1')), id: 'x1', projectId: 'other', assignment: assignment({ id: 'x', agentId: 'w', leaseUntil: 1, progressAt: 1 }) })
    const build = group(state, 'g1')
    renewOwnTask(state, build, 'e', later)
    expect(review(state)).toMatchObject({ leaseUntil: asked + LEASE_MS, progressAt: asked })
    expect(build.assignment).toMatchObject({ leaseUntil: later + LEASE_MS, progressAt: later })
    renewOwnTask(state, build, 'w', later + MINUTE)
    expect(review(state)).toMatchObject({ leaseUntil: later + MINUTE + LEASE_MS, progressAt: later + MINUTE })
    expect(group(state, 's1').assignment).toMatchObject({ leaseUntil: 1, progressAt: 1 })
    expect(group(state, 'x1').assignment).toMatchObject({ leaseUntil: 1, progressAt: 1 })
    // The build's lease is its Engineer's own, untouched by the Reviewer.
    expect(build.assignment).toMatchObject({ leaseUntil: later + LEASE_MS, progressAt: later })
    changesRequested(state, build, 'w', later)
    expect(review(state).changesRequestedAt).toBe(later)
    expect(group(state, 's1').assignment!.changesRequestedAt).toBeUndefined()
    expect(group(state, 'x1').assignment!.changesRequestedAt).toBeUndefined()
    // A cancelled build marks nothing.
    const cancelled = reviewing(asked, { status: 'cancelled' }, {}, {})
    changesRequested(cancelled, group(cancelled, 'g1'), 'w', later)
    expect(review(cancelled).changesRequestedAt).toBeUndefined()
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

  // A start its machine never started counts against its engine there as a host's failure does (engineHealth.ts).
  it('suspends its engine on its machine with the second one, saying so once and tagging the machine owner', () => {
    const at = LAUNCHED + 3 * MINUTE + 1
    const state = launched([{ receivedAt: at }], { machineOwnerId: 'o', request: { conversationId: 'lead', machineId: 'm', engine: 'codex', name: 'Builder' } })
    state.starts!.push(...['s2', 's3'].map(id => ({ ...structuredClone(state.starts![0]!), id })))
    const rows = () => sweepLiveness(state, at).filter(row => row.source?.kind === 'start-timeout')
    // All three time out in this one sweep: the second suspends Codex there, the third says nothing more.
    const told = rows()
    expect(told.map(row => row.mentions)).toEqual([undefined, ['o'], undefined])
    expect(told[1]!.text).toContain('Codex is suspended on this machine for new work: its last 2 starts there failed.')
    expect(told[2]!.text).not.toContain('suspended')
  })

  // Project instructions, phase 4 (decision 18): the coordinator and the agent that made the start hear it, with the model it
  // asked for; nothing is stepped up or started elsewhere.
  it('tells a failed grid start to the coordinator and the agent that made it, naming its model, and steps nothing up', () => {
    const at = LAUNCHED + 3 * MINUTE + 1
    const state = launched([{ receivedAt: at }], { actorKey: 'agent:E',
      request: { conversationId: 'lead', machineId: 'm', name: 'Builder', gridModel: 'moonshotai/kimi-k3' } })
    state.agents.push({ ...structuredClone(state.agents[0]!), id: 'E', name: 'Engineer' })
    state.conversations[0]!.agentIds.push('E')
    const rows = sweepLiveness(state, at).filter(row => row.source?.kind === 'start-timeout')
    expect(rows).toEqual([expect.objectContaining({ recipients: ['L', 'E'],
      text: 'Could not start Builder on moonshotai/kimi-k3: its machine did not start it within 3 minutes.' })])
    expect(state.conversations[0]!.stepUp).toBeUndefined()
  })

  // A task with no lead (opened before its project had a coordinator) still hears its failed start: the agent that made it,
  // and the coordinator in its own chat when it is not in the task. Nothing is ever written for no one (final review).
  it('tells a failed start on a task with no lead to the agent that made it, and the coordinator in its chat', () => {
    const at = LAUNCHED + 3 * MINUTE + 1
    const withTask = (actorKey: string) => {
      const state = launched([{ receivedAt: at }], { actorKey, request: { conversationId: 'g1', machineId: 'm', name: 'Builder' } })
      state.agents.push({ ...structuredClone(state.agents[0]!), id: 'E', name: 'Engineer' })
      state.conversations.push({ id: 'g1', number: 3, title: 'Task', leadId: null, agentIds: ['E'], archived: false, brief: '', checks: [], assignment: null,
        lastMessageSequence: 0 } as never)
      return state
    }
    const told = 'Could not start Builder: its machine did not start it within 3 minutes.'
    const rows = sweepLiveness(withTask('agent:E'), at).filter(row => row.source?.kind === 'start-timeout')
    expect(rows).toEqual([
      expect.objectContaining({ conversationId: 'g1', recipients: ['E'], author: expect.objectContaining({ kind: 'agent', id: 'E' }), text: told }),
      expect.objectContaining({ conversationId: 'lead', recipients: ['L'], text: told, source: { kind: 'start-timeout', startId: 's1', recipientsOnly: true } })])
    // A person's start, with no coordinator either: still said in the task, for people, under the Swarm's owner.
    const alone = withTask('person:p')
    alone.ownerId = 'p'
    alone.conversations[0]!.leadId = null
    alone.conversations[0]!.agentIds = []
    expect(sweepLiveness(alone, at).filter(row => row.source?.kind === 'start-timeout')).toEqual([
      expect.objectContaining({ conversationId: 'g1', recipients: [], author: expect.objectContaining({ kind: 'person', id: 'p' }), text: told })])
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
  /** Task r1 (#8), linked to g1 (reviewOf), with [work] on it. */
  const linkedTask = (work: Partial<Assignment> | null, patch: Record<string, unknown> = {}) => ({ id: 'r1', number: 8, title: 'Review: Ship it', leadId: 'L',
    agentIds: ['L'], archived: false, brief: 'Review it', checks: [], lastMessageSequence: 0, reviewOf: 'g1',
    assignment: work && assignment({ id: 'a2', agentId: 'L', ...work }), ...patch }) as unknown as SuperTabState['conversations'][number]

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
    // What happened, never the next step (project instructions, phase 4).
    expect(rows[0]!.text).toBe('A task is stalled:\n- #7 "Ship it": quiet, Luna has reported nothing for 30 minutes.')
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
    // In review with its review task open.
    const review = project({ status: 'review', progressAt: NOW - 3 * 60 * MINUTE })
    review.conversations.push(linkedTask(null))
    expect(wakes(sweepForLead(review, NOW))).toEqual([])
    expect(task(review).liveness).toEqual({ state: 'waiting', why: 'review', since: NOW - 3 * 60 * MINUTE })
    const blocked = project({ status: 'blocked', progressAt: NOW - 3 * 60 * MINUTE })
    expect(wakes(sweepForLead(blocked, NOW))).toEqual([])
    expect(task(blocked).liveness).toEqual({ state: 'waiting', why: 'blocked', since: NOW - 3 * 60 * MINUTE })
  })

  // Nothing opens a review by itself any more (project instructions, phase 4): work handed over with no review task open would
  // wait for good, and nothing else tells anyone (final review of the branch).
  it('tells the coordinator once when a task has waited in review 30 minutes with no review task open', () => {
    const state = project({ status: 'review', progressAt: NOW - 30 * MINUTE + 1 })
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toEqual({ state: 'waiting', why: 'review', since: NOW - 30 * MINUTE + 1 })
    const rows = wakes(sweepForLead(state, NOW + 1))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversationId: 'lead', recipients: ['L'],
      source: { kind: 'work-stalled', tasks: [{ conversationId: 'g1', state: 'quiet', why: 'review' }] } })
    expect(rows[0]!.text).toBe('A task is stalled:\n- #7 "Ship it": waited for review for 30 minutes; no review task is open.')
    expect(task(state).liveness).toEqual({ state: 'quiet', why: 'review', since: NOW - 30 * MINUTE + 1 })
    // Once per spell: later sweeps find it recorded.
    expect(wakes(sweepForLead(state, NOW + 60 * MINUTE))).toEqual([])
  })

  it('waits in review while a linked task is open, and counts its 30 minutes again from when the last one ended', () => {
    const state = project({ status: 'review', progressAt: NOW - 3 * 60 * MINUTE })
    state.conversations.push(linkedTask({ status: 'working', progressAt: NOW }))
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toMatchObject({ state: 'waiting', why: 'review' })
    // The review ends; its Engineer has 30 minutes to act on it before the coordinator hears.
    const review = state.conversations.find(c => c.id === 'r1')!
    review.assignment!.status = 'done'
    review.lastActivityAt = new Date(NOW + MINUTE).toISOString()
    // Its machine still reports the session running.
    state.machines![0]!.observation = { ...state.machines![0]!.observation!, receivedAt: NOW + 31 * MINUTE }
    expect(wakes(sweepForLead(state, NOW + 30 * MINUTE))).toEqual([])
    expect(wakes(sweepForLead(state, NOW + 31 * MINUTE))[0]!.text).toContain('waited for review for 30 minutes; no review task is open.')
    expect(task(state).liveness).toEqual({ state: 'quiet', why: 'review', since: NOW + MINUTE })
  })

  it('waits, never quiet, while it reviews a build that is back in progress, and turns quiet once that build is ready again', () => {
    const state = project({ progressAt: NOW - 3 * 60 * MINUTE })
    // g1 is now the review of build g0, whose Engineer is fixing the findings.
    task(state).reviewOf = 'g0'
    state.conversations.push({ ...structuredClone(task(state)), id: 'g0', number: 6, title: 'Build', reviewOf: undefined,
      assignment: assignment({ id: 'a0', agentId: 'L', status: 'working', progressAt: NOW }) })
    // Its verdict asked for changes.
    task(state).assignment!.changesRequestedAt = NOW - 3 * 60 * MINUTE
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toEqual({ state: 'waiting', why: 'revision', since: NOW - 3 * 60 * MINUTE })
    const build = state.conversations.find(c => c.id === 'g0')!
    build.assignment!.status = 'review'
    revisionReady(state, build, NOW)
    // Its quiet time runs from when the build came back, not from the Reviewer's last post before the fix round.
    const at = (now: number) => (state.machines![0]!.observation!.receivedAt = now, now)
    expect(wakes(sweepForLead(state, at(NOW + 29 * MINUTE)))).toEqual([])
    expect(wakes(sweepForLead(state, at(NOW + 30 * MINUTE)))).toHaveLength(1)
    expect(task(state).liveness).toEqual({ state: 'quiet', why: 'silent', since: NOW })
  })

  it('turns quiet when it reviews a build in progress without having asked for changes: an Engineer\'s work keeps no idle Reviewer', () => {
    const state = project({ progressAt: NOW - 30 * MINUTE })
    task(state).reviewOf = 'g0'
    state.conversations.push({ ...structuredClone(task(state)), id: 'g0', number: 6, title: 'Build', reviewOf: undefined,
      assignment: assignment({ id: 'a0', agentId: 'L', status: 'working', result: 'Working: awaiting review', progressAt: NOW }) })
    expect(wakes(sweepForLead(state, NOW))).toHaveLength(1)
    expect(task(state).liveness).toEqual({ state: 'quiet', why: 'silent', since: NOW - 30 * MINUTE })
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

  it('gives a start from before request times its 10 minutes from when it was first seen queued, not rewritten meanwhile', () => {
    const legacy = starting({ requestedAt: undefined })
    sweepForLead(legacy, NOW)
    const recorded = task(legacy).liveness
    expect(recorded).toEqual({ state: 'waiting', why: 'queued', since: NOW })
    sweepForLead(legacy, NOW + 9 * MINUTE)
    expect(task(legacy).liveness).toBe(recorded)
    expect(wakes(sweepForLead(legacy, NOW + 10 * MINUTE))[0]!.text).toContain('orphaned, its agent has not started for 10 minutes.')
    expect(task(legacy).liveness).toEqual({ state: 'orphaned', why: 'unstarted', since: NOW })
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
    expect(rows[0]!.text.startsWith('2 tasks are stalled:\n')).toBe(true)
    expect(state.conversations.find(c => c.id === 'g3')!.liveness).toBeUndefined()
    expect(state.conversations.find(c => c.id === 'lead')!.liveness).toBeUndefined()
  })

  it('is no longer orphaned once it is assigned again and working, and its next orphan episode wakes the Lead again', () => {
    const state = project({ status: 'reconciling' })
    expect(wakes(sweepForLead(state, NOW))).toHaveLength(1)
    // Reassigned: a new attempt held by a working agent.
    task(state).assignment = assignment({ id: 'a2', leaseUntil: NOW + MINUTE + LEASE_MS, progressAt: NOW + MINUTE })
    expect(wakes(sweepForLead(state, NOW + MINUTE))).toEqual([])
    expect(task(state).liveness).toBeUndefined()
    task(state).assignment!.status = 'reconciling'
    expect(wakes(sweepForLead(state, NOW + 2 * MINUTE))).toHaveLength(1)
  })

  it('is orphaned when a machine\'s report times its start out, recorded in that report\'s write, since no later poll loads the start', () => {
    const timedOut = starting({ dispatched: true, dispatchedAt: NOW - 4 * MINUTE })
    // The report path: the time checks without the Lead's task states.
    sweepLiveness(timedOut, NOW)
    expect(timedOut.starts![0]!.error).toBe('Mac did not start it within 3 minutes')
    expect(task(timedOut).liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: NOW })
    timedOut.starts = []
    expect(wakes(sweepForLead(timedOut, NOW + MINUTE))).toEqual([])
    expect(task(timedOut).liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: NOW })
  })

  it('stays orphaned after its failed start is no longer loaded, until it has work again', () => {
    const failed = starting({ dispatched: true, dispatchedAt: NOW - MINUTE, error: 'Mac could not prepare it' })
    sweepForLead(failed, NOW)
    failed.starts = []
    sweepForLead(failed, NOW + MINUTE)
    expect(task(failed).liveness).toEqual({ state: 'orphaned', why: 'start-failed', since: NOW })
    task(failed).assignment = assignment({ leaseUntil: NOW + 2 * MINUTE + LEASE_MS, progressAt: NOW + 2 * MINUTE })
    sweepForLead(failed, NOW + 2 * MINUTE)
    expect(task(failed).liveness).toBeUndefined()
  })

  it('records a stall only once its wake reaches a Lead: a project without one is told when its Lead arrives', () => {
    const state = project({ progressAt: NOW - 40 * MINUTE })
    const chat = state.conversations.find(c => c.id === 'lead')!
    chat.leadId = null
    chat.agentIds = []
    expect(wakes(sweepForLead(state, NOW))).toEqual([])
    expect(task(state).liveness).toBeUndefined()
    chat.leadId = 'L'
    chat.agentIds = ['L']
    expect(wakes(sweepForLead(state, NOW + MINUTE))).toHaveLength(1)
    expect(task(state).liveness).toMatchObject({ state: 'quiet' })
  })

  it('names the person its agent asked, not its requester, while it waits on a decision', () => {
    const asked = project({ status: 'needs_human', askedOf: 'q' })
    asked.people.push({ id: 'q', email: 'q@example.com', role: 'collaborator', generation: 'g' } as never)
    sweepForLead(asked, NOW)
    expect(task(asked).liveness).toMatchObject({ state: 'waiting', why: 'person', personId: 'q' })
  })

  it('clears its state once its work is finished', () => {
    const state = project({ progressAt: NOW - 40 * MINUTE })
    sweepForLead(state, NOW)
    task(state).assignment!.status = 'done'
    sweepForLead(state, NOW + MINUTE)
    expect(task(state).liveness).toBeUndefined()
  })
})

describe('the next time a machine\'s worker can lose its task (DB 2.5)', () => {
  const progress = 1_000_000
  /** Its machine reported at [at], its session's screen last changed at `progress`. */
  const reported = (at: number, task = assignment({ leaseUntil: 1 })) => swarm(task, { receivedAt: at, harnessProgress: { h: progress } })
  const ownLoss = (state: SuperTabState, now: number) => (loseTasks(state, now, worker => worker.machineId === 'm'), state.conversations[1]!.assignment!.status)

  it('is when its lease ends, so a report up to then loses nothing and the first after it loses the task', () => {
    const at = nextLossAt(reported(progress + 26 * MINUTE), 'm')!
    expect(at).toBeGreaterThan(progress)
    expect(ownLoss(reported(at), at)).toBe('working')
    expect(ownLoss(reported(at + 1), at + 1)).toBe('lost')
  })

  it('is none for another machine, a task waiting for review, or no task', () => {
    expect(nextLossAt(reported(progress), 'other')).toBeUndefined()
    expect(nextLossAt(reported(progress, assignment({ status: 'review', result: 'Ready for review', leaseUntil: 1 })), 'm')).toBeUndefined()
    const idle = reported(progress)
    idle.conversations[1]!.assignment = null
    expect(nextLossAt(idle, 'm')).toBeUndefined()
  })
})

// Diego, 2026-11-04 (task #2693): the project chat's thread replies are the only task state the chat shows (#2704), but a task
// lost outside any command (the sweep, a machine's report, its Lead's poll) never said Stuck there: the thread kept saying On it.
describe('a task lost outside any command says Stuck in its project-chat thread', () => {
  const lost = () => {
    const f = stepsFixture()
    // Asked for in a person's message, whose thread is the task's (taskLine.ts); a task no message asked for says nothing there.
    f.group(f.task).cards = { ...f.group(f.task).cards, line: { messageId: 'ask', conversationId: 'lead' } }
    const root = f.group(f.task).cards!.line!.messageId
    const worker = f.state.agents.find(a => a.id === f.dev)!
    const text = `Stuck: ${worker.displayName ?? worker.name} stopped. Next: another engineer takes it over.`
    const replies = (rows: ReturnType<typeof sweepLiveness>) => rows.filter(r => r.conversationId === f.group(f.task).cards!.line!.conversationId)
    f.tick(120 * MINUTE)
    return { f, root, text, replies }
  }

  it('through the sweep: exactly one reply, in the task\'s thread, as its coordinator', () => {
    const { f, root, text, replies } = lost()
    const rows = sweepLiveness(f.state, f.now)
    expect(f.group(f.task).assignment!.status).toBe('lost')
    expect(replies(rows)).toEqual([expect.objectContaining({ text, replyTo: root, thread: root, recipients: [],
      author: expect.objectContaining({ kind: 'agent', id: f.lead }), source: expect.objectContaining({ kind: 'system' }) })])
  })

  it('through the Lead\'s poll', () => {
    const { f, root, text, replies } = lost()
    expect(replies(sweepForLead(f.state, f.now))).toEqual([expect.objectContaining({ text, replyTo: root, thread: root })])
  })

  it('once when an alert loses it inside a command', () => {
    const { f, root, text } = lost()
    const rows = f.run({ type: 'agent.alert', agentId: f.dev, alert: 'limit', active: true }, f.as(f.dev)).messages
    expect(f.group(f.task).assignment!.status).toBe('lost')
    expect(rows.filter(r => r.thread === root && r.text.startsWith('Stuck:'))).toEqual([expect.objectContaining({ text })])
  })
})
