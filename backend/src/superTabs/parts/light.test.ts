import { describe, expect, it } from 'vitest'
import { activeWork, type Assignment, type Conversation, type WorkStatus } from '../model.js'
import { FINISHED, GROUP_FIELDS } from './light.js'

/** Every field a conversation and its assignment can carry: adding one to model.ts fails this file's typecheck until it is
 *  here, and the test below until light.ts either projects it or names it as unread by reads (review of #1745). */
const assignment: Required<Assignment> = {
  id: 'w', agentId: 'a', status: 'working', configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, result: null, recordingProgress: { at: 1, revision: 1 }, leaseUntil: 1, progressAt: 1,
  lost: { reason: 'r', at: 1 },
}
const conversation: Required<Conversation> = {
  id: 'g', kind: 'leads', projectId: 'p', number: 1, title: 't', leadId: null, agentIds: [], archived: false, brief: '',
  task: { goal: '', changes: '', constraints: '', owns: [] }, reviewOf: 'r', checks: [], assignment, lastMessageSequence: 0, pullRequestUrls: [],
  messageSeq: 0, reportSeq: 0, dormant: false, lastActivityAt: '', audience: { people: [] }, lostAttempt: { id: 'w', agentId: 'a' }, reactionSeq: 0,
  requesterId: 'p', ledger: {},
}

describe('the light conversation projection (parts/light.ts)', () => {
  it('projects or deliberately leaves out every field a conversation and its assignment carry', () => {
    const fields = [...Object.keys(conversation).filter(k => k !== 'assignment'), ...Object.keys(assignment).map(k => `assignment.${k}`)]
    const projected: string[] = [...GROUP_FIELDS.always, ...GROUP_FIELDS.whenRunning]
    const named = [...projected, ...GROUP_FIELDS.unread].map(f => f === 'task.owns' ? 'task' : f)
    expect(fields.filter(f => !named.includes(f))).toEqual([])
    expect(GROUP_FIELDS.unread.filter(f => projected.includes(f))).toEqual([])
  })

  it('reads work as finished exactly where model.ts does, for every status', () => {
    const statuses: Record<WorkStatus, true> = { planned: true, working: true, needs_human: true, blocked: true, review: true, done: true,
      stopped: true, cancelled: true, reconciling: true, lost: true }
    for (const status of Object.keys(statuses) as WorkStatus[]) {
      expect([status, !FINISHED.includes(status)]).toEqual([status, activeWork({ ...conversation, assignment: { ...assignment, status } })])
    }
  })
})
