import { describe, expect, it } from 'vitest'
import { activeWork, type Actor, type Assignment, type Conversation, type WorkStatus } from '../model.js'
import { canReadGroup } from '../projects.js'
import { outsider, owner, peer, swarm } from '../read/fixture.test-support.js'
import { FINISHED, GROUP_FIELDS } from './light.js'

/** Every field a conversation and its assignment can carry: adding one to model.ts fails this file's typecheck until it is
 *  here, and the test below until light.ts either projects it or names it as unread by reads (review of #1745). */
const assignment: Required<Assignment> = {
  id: 'w', agentId: 'a', status: 'working', configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null },
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' }, result: null, recordingProgress: { at: 1, revision: 1 }, leaseUntil: 1, progressAt: 1, askedOf: 'p', reviewFoundAt: 1,
  handoffs: 1, verdicts: [{ by: 'agent:r', passed: true, handoff: 1 }], lost: { reason: 'r', at: 1 },
}
const conversation: Required<Conversation> = {
  id: 'g', kind: 'leads', projectId: 'p', number: 1, title: 't', leadId: null, agentIds: [], archived: false, brief: '',
  task: { goal: '', changes: '', constraints: '', owns: [] }, reviewOf: 'r', checks: [], assignment, lastMessageSequence: 0, lastMainSequence: 0, pullRequestUrls: [], cards: {},
  messageSeq: 0, reportSeq: 0, dormant: false, lastActivityAt: '', audience: { people: [] }, lostAttempt: { id: 'w', agentId: 'a' }, reactionSeq: 0,
  requesterId: 'p', ledger: {}, proposals: [], buddyName: 'Sparky', buddySessions: [], liveness: { state: 'quiet', why: 'silent', since: 1 }, leadAction: { kind: 'post', at: 1 },
  stepUp: { attempt: 2, floor: 2, reason: 'r', at: 1, carry: '' },
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

  it('keeps the fields the access check reads: every reader reads a light conversation as they read the whole one', () => {
    // The route-decision list asks canReadGroup of light groups (store.ts readableDecisions): a field dropped here opens a private one.
    expect(GROUP_FIELDS.always).toEqual(expect.arrayContaining(['id', 'kind', 'projectId', 'audience', 'agentIds']))
    const s = swarm()
    s.join(peer)
    s.join(outsider)
    const lead = s.add('lead-harness', 'lead', true)
    const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
    const [web, hidden, closedChat, buddyChat] = [s.group('Web'), s.group('Secret work', secret), s.group('Peer and PM'), s.group('Peer\'s Buddy')]
    s.edit(state => {
      const audience = { people: [{ id: peer.userId, generation: state.people.find(p => p.id === peer.userId)!.generation }] }
      state.conversations.find(c => c.id === closedChat)!.audience = audience
      Object.assign(state.conversations.find(c => c.id === buddyChat)!, { kind: 'buddy', leadId: null, agentIds: [], audience })
    })
    const state = s.state
    const kept = GROUP_FIELDS.always.filter(field => !field.includes('.'))
    const light = (group: Conversation) => Object.fromEntries(kept.filter(field => field in group).map(field => [field, group[field as keyof Conversation]])) as unknown as Conversation
    const leadActor: Actor = { kind: 'agent', agentId: lead, machineOwnerId: state.agents.find(a => a.id === lead)!.machineOwnerId }
    const readers: Actor[] = [owner, peer, outsider, leadActor]
    const reads = readers.flatMap(actor => [web, hidden, closedChat, buddyChat].map(id => {
      const group = state.conversations.find(c => c.id === id)!
      expect(canReadGroup(state, actor, light(group)), `${actor.kind} ${id}`).toBe(canReadGroup(state, actor, group))
      return canReadGroup(state, actor, group)
    }))
    // The readers differ over the groups, or "the same" proves little.
    expect(reads).toContain(true)
    expect(reads).toContain(false)
  })
})
