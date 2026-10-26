import { describe, expect, it } from 'vitest'
import type { Assignment, SuperTabState } from './model.js'
import { LEASE_MS, QUIET_RUNNING_MS, sweepLiveness } from './liveness.js'

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
