import { describe, expect, it } from 'vitest'
import { applyCommand, authorizeCommandAccess, commandSchema, withoutCredentials, type CommandContext } from './commands.js'
import { fullSwarm, NOW, owner, peer, outsider } from './read/fixture.test-support.js'
import type { Actor } from './model.js'
import { queueSiblings } from './taskQueue.js'
import { touchesFor } from './parts/touches.js'
import { GROUP_FIELDS } from './parts/light.js'
import { storedAssignment } from './storedWork.test-support.js'

const words = 'Keep offline edits.'
const task = { goal: words, changes: 'Persist drafts', constraints: 'No sign-in', owns: ['backend/src/superTabs/'] }
function fixture() {
  const f = fullSwarm(NOW)
  f.state.projects![0]!.boardMode = true
  const candidate = f.add('candidate', f.web), other = f.add('other-candidate', f.web)
  let seq = 0
  const pm: Actor = { kind: 'agent', agentId: f.lead, machineOwnerId: `${owner.userId}-machine` }
  const buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
  const run = (value: unknown, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(f.state, actor, commandSchema.parse(value), { now: NOW, operationId: `approval-${++seq}`, ...context })
    f.edit(s => Object.assign(s, effects.state))
    return effects
  }
  const card = (id: unknown) => f.state.conversations.find(c => c.id === id)!
  const mode = (mode: string) => run({ type: 'member.approvalMode', mode })
  const create = () => run({ type: 'conversation.create', title: 'Offline drafts', task, priority: 'P2', requesterId: peer.userId,
    checks: [{ description: 'Restores drafts' }] }, pm).result.conversationId as string
  return Object.assign(f, { runCommand: run, card, mode, create, pm, buddyActor: buddy, candidate, other })
}

describe('personal approval enforced before work', () => {
  it('keeps default Auto approve unchanged and persists only the acting person’s mode', () => {
    const f = fixture(), id = f.create()
    expect(f.card(id).taskApproval).toBeUndefined()
    f.mode('review')
    expect(f.state.people.find(p => p.id === peer.userId)?.approvalMode).toBe('review')
    expect(f.state.people.find(p => p.id === owner.userId)?.approvalMode).toBeUndefined()
    expect(commandSchema.safeParse({ type: 'member.approvalMode', mode: 'review', personId: owner.userId }).success).toBe(false)
    for (const actor of [f.pm, f.buddyActor]) expect(() => f.runCommand({ type: 'member.approvalMode', mode: 'autoApprove' }, actor)).toThrow()
  })
  it('stages a PM task, keeps it out of Next up, and blocks starts and registration until approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'proposal', personId: peer.userId } })
    expect(queueSiblings(f.state, f.state.projects![0]!)).not.toContainEqual(f.card(id))
    expect(() => f.runCommand({ type: 'agent.start', request: { conversationId: id, machineId: 'host', engine: 'codex', name: 'New worker', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    expect(() => f.runCommand({ type: 'agent.add', conversationId: id, machineId: 'host', harnessId: 'external', name: 'External',
      configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }, lead: false }, owner,
      { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } })).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    // Accept all stays off without an API account (task #4697; members.test.ts covers one with): the task still waits.
    expect(() => f.mode('autoApprove')).toThrow(expect.objectContaining({ code: 'ACCEPT_ALL_SUBSCRIPTION' }))
    expect(f.card(id).taskApproval?.state).toBe('proposal')
  })
  it('lets the PM suggest, lets the requester change it, and approves only their choice', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    expect(f.card(id).assignment).toBeNull()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.other })
    const approved = f.runCommand({ type: 'task.approve', conversationId: id })
    expect(f.card(id)).toMatchObject({ taskApproval: { state: 'approved', suggestedAgentId: f.other }, assignment: null })
    expect(approved.messages.some(m => m.recipients.includes(f.lead))).toBe(true)
    expect(approved.messages.some(m => m.recipients.includes(f.other))).toBe(false)
    expect(approved.messages.some(m => m.recipients.includes(f.candidate))).toBe(false)
  })
  it('approves only the agent the person was shown: a suggestion changed since is refused and approves nothing (task #4217)', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    // The person saw the candidate; the PM suggests another before their tap lands.
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.other }, f.pm)
    for (const agentId of [f.candidate, null]) {
      expect(() => f.runCommand({ type: 'task.approve', conversationId: id, suggestedAgentId: agentId })).toThrow(expect.objectContaining({ code: 'TASK_SUGGESTION_CHANGED' }))
      expect(f.card(id).taskApproval).toMatchObject({ state: 'proposal', suggestedAgentId: f.other })
    }
    f.runCommand({ type: 'task.approve', conversationId: id, suggestedAgentId: f.other })
    expect(f.card(id).taskApproval).toMatchObject({ state: 'approved', suggestedAgentId: f.other })
    // With no agent suggested, the approval names none.
    const plain = f.create()
    expect(() => f.runCommand({ type: 'task.approve', conversationId: plain, suggestedAgentId: f.other })).toThrow(expect.objectContaining({ code: 'TASK_SUGGESTION_CHANGED' }))
    f.runCommand({ type: 'task.approve', conversationId: plain, suggestedAgentId: null })
    expect(f.card(plain).taskApproval?.state).toBe('approved')
  })

  it('refuses another person, PM or Buddy approval and old membership authority before receipt replay', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    for (const actor of [owner, outsider, f.pm, f.buddyActor]) for (const type of ['task.approve', 'task.reject'])
      expect(() => f.runCommand({ type, conversationId: id, ...type === 'task.reject' ? { reason: 'No' } : {} }, actor)).toThrow()
    const command = commandSchema.parse({ type: 'task.approve', conversationId: id })
    authorizeCommandAccess(f.state, peer, command)
    f.state.people.find(p => p.id === peer.userId)!.generation = 'rejoined'
    expect(() => authorizeCommandAccess(f.state, peer, command)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_FORBIDDEN' }))
  })
  it('keeps rejected work stopped and refuses reopening or changing requester to evade approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    expect(() => f.runCommand({ type: 'conversation.requester', conversationId: id, personId: owner.userId }, f.pm)).toThrow()
    expect(commandSchema.safeParse({ type: 'task.reject', conversationId: id, reason: ' ' }).success).toBe(false)
    f.runCommand({ type: 'task.reject', conversationId: id, reason: 'Keep current behavior' })
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'rejected', reason: 'Keep current behavior' } })
    expect(() => f.runCommand({ type: 'task.approve', conversationId: id })).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_DECIDED' }))
  })
  // Task #4218: approval is the requesting membership's, so once they left nobody could approve or reject it again, and the task
  // stayed open for good. A rejoined person decides nothing of the membership they left.
  it('rejects a leaving requester\'s pending approvals and tells the PM', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    const left = f.runCommand({ type: 'member.remove', userId: peer.userId })
    expect(f.card(id).taskApproval).toMatchObject({ state: 'rejected', decidedAt: NOW, reason: 'Its requester left the Swarm.' })
    expect(left.messages.some(m => m.conversationId === id && m.recipients.includes(f.lead))).toBe(true)
  })
  it.each([undefined, owner.userId])('stages personal approval when an unassigned task is attributed from %s to a Review requester', previous => {
    const f = fixture(); f.mode('review')
    const id = f.runCommand({ type: 'conversation.create', title: 'PM maintenance', task, priority: 'P2',
      ...previous ? { requesterId: previous } : { noRequesterReason: 'Proactive maintenance' },
      checks: [{ description: 'Restores drafts' }] }, f.pm).result.conversationId as string
    const command = commandSchema.parse({ type: 'conversation.requester', conversationId: id, personId: peer.userId })
    const before = f.state
    const effects = f.runCommand(command, f.pm)
    expect(f.card(id)).toMatchObject({ requesterId: peer.userId, assignment: null,
      taskApproval: { personId: peer.userId, generation: f.state.people.find(p => p.id === peer.userId)!.generation, state: 'proposal' } })
    expect(touchesFor(command, f.pm, before, effects)).toContainEqual({ kind: 'member', key: peer.userId })
  })
  it('refuses attribution to a Review requester after assignment without changing the existing task', () => {
    const f = fixture()
    const id = f.runCommand({ type: 'conversation.create', title: 'PM maintenance', task, priority: 'P2', requesterId: owner.userId,
      checks: [{ description: 'Restores drafts' }] }, f.pm).result.conversationId as string
    storedAssignment(f.state, id, f.candidate, NOW)
    f.mode('review')
    expect(() => f.runCommand({ type: 'conversation.requester', conversationId: id, personId: peer.userId }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    expect(f.card(id)).toMatchObject({ requesterId: owner.userId, assignment: { agentId: f.candidate } })
    expect(f.card(id).taskApproval).toBeUndefined()
  })
  it('keeps existing attribution and Auto approve attribution compatible', () => {
    const f = fixture(), id = f.create()
    storedAssignment(f.state, id, f.candidate, NOW)
    f.mode('review')
    f.runCommand({ type: 'conversation.requester', conversationId: id, personId: peer.userId }, f.pm)
    expect(f.card(id).taskApproval).toBeUndefined()
    f.runCommand({ type: 'conversation.requester', conversationId: id, personId: owner.userId }, f.pm)
    expect(f.card(id)).toMatchObject({ requesterId: owner.userId, assignment: { agentId: f.candidate } })
    expect(f.card(id).taskApproval).toBeUndefined()
  })
  // Proposals are gone (2026-11-10), but cards made before are stored: one its PM never accepted or reshaped, Later too, is still no
  // task its person approves or anyone starts (#4249).
  it.each([['undecided', undefined], ['Later', 'later']] as const)('refuses approving or starting a stored proposal card its PM left %s', (_, decision) => {
    const f = fixture(); f.mode('review'); const id = f.create()
    const senders = [{ personId: peer.userId, generation: f.state.people.find(p => p.id === peer.userId)!.generation }]
    f.edit(s => { s.conversations.find(c => c.id === id)!.proposal = { senders, ...decision ? { decision: { kind: decision, reason: 'Next week' } } : {} } })
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    expect(() => f.runCommand({ type: 'task.approve', conversationId: id })).toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
    // Approved while undecided, as a server before #4249 allowed, with no agent chosen.
    f.edit(s => { s.conversations.find(c => c.id === id)!.taskApproval = { ...s.conversations.find(c => c.id === id)!.taskApproval!, state: 'approved', decidedAt: NOW, suggestedAgentId: undefined } })
    expect(() => f.runCommand({ type: 'agent.start', request: { conversationId: id, machineId: 'host', engine: 'codex', name: 'New worker', cwd: '/repo', worktree: true,
      requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, f.pm))
      .toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
  })
  it('refuses invalid suggestions and rechecks a changed agent atomically on approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    for (const agentId of [f.buddy, 'missing']) expect(() => f.runCommand({ type: 'task.suggest', conversationId: id, agentId })).toThrow()
    // A busy agent may be suggested: the task waits for it, and its assignment checks it is free (task #4252).
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.worker })
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    f.state.agents.find(a => a.id === f.candidate)!.workDecision = 'stop'
    expect(() => f.runCommand({ type: 'task.approve', conversationId: id })).toThrow()
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'proposal' } })
  })
  // Task #4252 (audit 20): Approve is the person's consent to the agent shown; whether it is free is not its to check.
  it('records approval of a busy suggested agent', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    f.edit(s => { s.conversations.find(c => c.id === f.web)!.assignment!.agentId = f.candidate })
    f.runCommand({ type: 'task.approve', conversationId: id })
    expect(f.card(id).taskApproval?.state).toBe('approved')
  })
  it('says the suggested agent is gone when it was removed before the approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    f.edit(s => { s.agents = s.agents.filter(a => a.id !== f.candidate) })
    expect(() => f.runCommand({ type: 'task.approve', conversationId: id })).toThrow(expect.objectContaining({ code: 'SUGGESTED_AGENT_GONE' }))
    expect(f.card(id).taskApproval?.state).toBe('proposal')
  })
  it('redacts a pasted credential from a rejection before its reason reaches stored parts or messages', () => {
    const token = ['sk', 'AbCdEf0123456789'.repeat(3)].join('-') // Synthetic fixture, never a provider credential.
    const removed: Parameters<typeof withoutCredentials>[1] = []
    const clean = withoutCredentials(commandSchema.parse({ type: 'task.reject', conversationId: 'task', reason: `Avoid ${token}` }), removed)
    expect(JSON.stringify(clean)).not.toContain(token)
    expect(removed.length).toBeGreaterThan(0)
  })
  it.each(['removed', 'stopping'])('recovers an approved, unassigned task when its chosen worker is %s, with fresh person approval', state => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    f.runCommand({ type: 'task.approve', conversationId: id })
    if (state === 'removed') f.state.agents = f.state.agents.filter(a => a.id !== f.candidate)
    else f.state.agents.find(a => a.id === f.candidate)!.workDecision = 'stop'
    expect(() => f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.other }, owner)).toThrow()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.other }, state === 'removed' ? f.pm : peer)
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'proposal', suggestedAgentId: f.other } })
    expect(f.card(id).taskApproval?.decidedAt).toBeUndefined()
    f.runCommand({ type: 'task.approve', conversationId: id })
    // Once its chosen worker holds it, the approval is decided.
    storedAssignment(f.state, id, f.other, NOW)
    expect(() => f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.worker })).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_DECIDED' }))
  })
  it('guards the person and selected agent against concurrent changes, and keeps approval in light loads', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    const before = f.state, command = commandSchema.parse({ type: 'task.approve', conversationId: id })
    const touches = touchesFor(command, peer, before, f.runCommand(command))
    expect(touches).toContainEqual({ kind: 'member', key: peer.userId })
    expect(touches).toContainEqual({ kind: 'agent', key: f.candidate })
    expect(GROUP_FIELDS.always).toContain('taskApproval')
  })
})
