import { describe, expect, it } from 'vitest'
import type { AgentStart, Assignment, SuperTabState } from './model.js'
import { LEASE_MS, loseTasks, QUIET_RUNNING_MS, sweepLiveness, waitingForReview } from './liveness.js'
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
const status = (state: SuperTabState, now: number) => (loseTasks(state, now), state.conversations[1]!.assignment!)

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
      expect(loseTasks(idle, asked + 2 * HOUR)).toEqual([])
      expect(idle.conversations[1]!.assignment!.status).toBe(status)
      // Even a session that reports no progress at all.
      expect(loseTasks(waiting({ status }, { receivedAt: asked + 2 * HOUR, harnessProgress: {} }), asked + 2 * HOUR)).toEqual([])
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
    const unseen = waiting()
    unseen.machines = []
    expect(status(unseen, asked + 2 * HOUR).status).toBe('lost')
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

  it('stays its agent\'s while its terminal waits at a prompt for a person, though its status says working (task #4217)', () => {
    const prompted = (alerting: Array<'prompt'>) => {
      const state = swarm(assignment({ leaseUntil: asked + LEASE_MS, progressAt: asked }), { receivedAt: asked + 2 * HOUR, harnessProgress: { h: asked } })
      state.agents[0]!.alerting = alerting
      return state
    }
    expect(status(prompted(['prompt']), asked + 2 * HOUR).status).toBe('working')
    // The prompt answered, its quiet time counts again.
    expect(status(prompted([]), asked + 2 * HOUR).status).toBe('lost')
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

  // Swarm v4 has no crew (2026-11-10): a crew mark an agent kept from before gives its task no reopen grace.
  it('loses the task of an agent with a crew mark from before as any worker\'s when its session stops', () => {
    const state = quiet('working', 1)
    state.machines![0]!.observation!.stoppedHarnessIds = ['h']
    Object.assign(state.agents[0]!, { crew: { role: 'Engineer', at: 1, by: 'p' }, downSince: new Date(handedOver).toISOString() })
    expect(status(state, handedOver + MINUTE)).toMatchObject({ status: 'lost', lost: { reason: 'its session on Mac stopped' } })
  })

  // Task #3399: a handed task waits on its Reviewers and CI, not its Engineer, so neither loses it (handed.ts). An older skill's
  // working hand-off is still the Engineer's own work.
  it('is not lost when its session stops or its machine goes offline, while an older skill\'s working hand-off still is', () => {
    const stopped = quiet('review', 1)
    stopped.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(status(stopped, handedOver + MINUTE)).toMatchObject({ status: 'review' })
    expect(status(quiet('review', 1), handedOver + 4 * MINUTE)).toMatchObject({ status: 'review' })
    const older = swarm(assignment({ status: 'working', result: 'Ready for review: abc1234', leaseUntil: handedOver + LEASE_MS, progressAt: handedOver }),
      { receivedAt: handedOver + MINUTE, harnessProgress: { h: handedOver } })
    older.machines![0]!.observation!.stoppedHarnessIds = ['h']
    expect(status(older, handedOver + MINUTE)).toMatchObject({ status: 'lost', lost: { reason: 'its session on Mac stopped' } })
  })
})

describe('a worker whose task is lost', () => {
  it('is marked lost in the same write that loses its task, so routing keeps it out after a cancel or reassignment', () => {
    const state = swarm(assignment({ leaseUntil: 1 })), now = 1 + LEASE_MS + 1
    const parts = () => split(structuredClone(state), { tabId: 't', version: 1, now: 0 })
    const before = parts()
    loseTasks(state, now)
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

  // Pickup timeouts describe the machine, regardless of the engine requested.
  it('suspends the machine with the second timeout, saying so once and tagging the machine owner', () => {
    const at = LAUNCHED + 3 * MINUTE + 1
    const state = launched([{ receivedAt: at }], { machineOwnerId: 'o', request: { conversationId: 'lead', machineId: 'm', engine: 'codex', name: 'Builder' } })
    state.starts!.push(...['s2', 's3'].map(id => ({ ...structuredClone(state.starts![0]!), id })))
    const rows = () => sweepLiveness(state, at).filter(row => row.source?.kind === 'start-timeout')
    // All three time out in this one sweep: the second suspends the machine, the third says nothing more.
    const told = rows()
    expect(told.map(row => row.mentions)).toEqual([undefined, ['o'], undefined])
    expect(told[1]!.text).toContain('This machine is suspended for new work: its last 2 starts timed out.')
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

  /** Task g1 with no assignment yet and one start for it, asked for at `requestedAt`. */
  const starting = (start: Record<string, unknown>) => project(null, { starts: [{ id: 's1', request: { conversationId: 'g1', machineId: 'm', name: 'Builder' },
    dispatched: false, harnessId: null, error: null, requestedAt: NOW - 9 * MINUTE, ...start }] })

})
