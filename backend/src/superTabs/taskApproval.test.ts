import { describe, expect, it } from 'vitest'
import { applyCommand, authorizeCommandAccess, commandSchema, type CommandContext } from './commands.js'
import { fullSwarm, NOW, owner, peer, outsider } from './read/fixture.test-support.js'
import type { Actor } from './model.js'
import { openTasks } from './dispatch.js'
import { queueSiblings } from './taskQueue.js'
import { touchesFor } from './parts/touches.js'
import { GROUP_FIELDS } from './parts/light.js'

const words = 'Keep offline edits.'
const task = { goal: words, changes: 'Persist drafts', constraints: 'No sign-in', owns: ['backend/src/superTabs/'] }
function fixture(board = true) {
  const f = fullSwarm(NOW)
  f.state.projects![0]!.boardMode = board
  const candidate = f.add('candidate', f.done), other = f.add('other-candidate', f.done)
  let seq = 0
  const pm: Actor = { kind: 'agent', agentId: f.lead, machineOwnerId: 'unrelated-machine-owner' }
  const buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: 'unrelated-machine-owner' }
  const run = (value: unknown, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(f.state, actor, commandSchema.parse(value), { now: NOW, operationId: `approval-${++seq}`, ...context })
    f.edit(s => Object.assign(s, effects.state))
    return effects
  }
  const card = (id: unknown) => f.state.conversations.find(c => c.id === id)!
  const mode = (mode: string) => run({ type: 'member.approvalMode', mode })
  const create = () => run({ type: 'conversation.create', title: 'Offline drafts', task, priority: 'P2', requesterId: peer.userId,
    checks: [{ description: 'Restores drafts' }] }, pm).result.conversationId as string
  const propose = () => run({ type: 'buddy.propose', conversationId: f.buddyChat, projectId: 'lead', ownerMessageId: 'ask',
    text: words, goal: words, scope: 'Drafts', priority: 'normal', why: 'Lost edits', doneWhen: 'Drafts return', evidence: ['Reproduction'] }, buddy, {
    proposalAsk: { id: 'ask', conversationId: f.buddyChat, source: false, author: { kind: 'person', id: peer.userId, name: 'Peer',
      membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation }, text: words,
      createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] } })
  return Object.assign(f, { runCommand: run, card, mode, create, propose, pm, buddy, candidate, other })
}

describe('personal approval enforced before work', () => {
  it('keeps default Auto approve unchanged and persists only the acting person’s mode', () => {
    const f = fixture(), id = f.create()
    expect(f.card(id).taskApproval).toBeUndefined()
    expect(f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm).result.assignmentId).toBeTruthy()
    f.mode('review')
    expect(f.state.people.find(p => p.id === peer.userId)?.approvalMode).toBe('review')
    expect(f.state.people.find(p => p.id === owner.userId)?.approvalMode).toBeUndefined()
    expect(commandSchema.safeParse({ type: 'member.approvalMode', mode: 'review', personId: owner.userId }).success).toBe(false)
    for (const actor of [f.pm, f.buddy]) expect(() => f.runCommand({ type: 'member.approvalMode', mode: 'autoApprove' }, actor)).toThrow()
  })
  it('stages a PM task, excludes dispatch, and blocks assignment, starts and registration until approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'proposal', personId: peer.userId } })
    expect(queueSiblings(f.state, f.state.projects![0]!)).not.toContainEqual(f.card(id))
    expect(openTasks(f.state, 'lead', NOW)).not.toContainEqual(f.card(id))
    for (const input of [
      { type: 'work.assign', conversationId: id, agentId: f.candidate },
      { type: 'agent.start', request: { conversationId: id, machineId: 'host', engine: 'codex', name: 'New worker' } },
    ]) expect(() => f.runCommand(input, f.pm)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    expect(() => f.runCommand({ type: 'agent.add', conversationId: id, machineId: 'host', harnessId: 'external', name: 'External',
      configuration: { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }, lead: false }, owner,
      { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } })).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.mode('autoApprove')
    expect(f.card(id).taskApproval?.state).toBe('proposal')
    expect(f.card(f.create()).taskApproval).toBeUndefined()
  })
  it('lets the PM suggest, lets the requester change it, and assigns only their approved choice', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    expect(f.card(id).assignment).toBeNull()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.other })
    const approved = f.runCommand({ type: 'task.approve', conversationId: id })
    expect(f.card(id)).toMatchObject({ taskApproval: { state: 'approved', suggestedAgentId: f.other }, assignment: { agentId: f.other, status: 'working' } })
    expect(approved.messages.some(m => m.recipients.includes(f.other))).toBe(true)
    expect(approved.messages.some(m => m.recipients.includes(f.candidate))).toBe(false)
  })
  it('refuses another person, PM or Buddy approval and old membership authority before receipt replay', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    for (const actor of [owner, outsider, f.pm, f.buddy]) for (const type of ['task.approve', 'task.reject'])
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
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
  })
  it.each([true, false])('keeps consented Buddy proposals in Tasks and reaches the PM with board mode %s', board => {
    const f = fixture(board); f.mode('review'); const sent = f.propose()
    const card = f.state.conversations.find(c => c.proposal?.senders.some(s => s.buddyId === f.buddy))!
    expect(card).toMatchObject({ requesterId: peer.userId, assignment: null, taskApproval: { state: 'proposal' }, proposal: { text: words } })
    expect(sent.messages.some(m => m.recipients.includes(f.lead) && m.author.id === peer.userId)).toBe(true)
    if (board) {
      f.runCommand({ type: 'proposal.decide', conversationId: card.id, decision: 'accept', reason: 'Build it', task,
        checks: [{ description: 'Restores drafts' }] }, f.pm)
      expect(() => f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.candidate }, f.pm)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
      f.runCommand({ type: 'task.approve', conversationId: card.id })
      expect(f.card(card.id).taskApproval?.state).toBe('approved')
    }
  })
  it('cannot merge an unapproved proposal into another card to bypass its person', () => {
    const f = fixture(); f.mode('review'); f.propose()
    const card = f.state.conversations.find(c => c.taskApproval)!
    const other = f.runCommand({ type: 'proposal.create', projectId: 'lead', title: 'Other', text: 'Other', goal: 'Other', why: 'Other',
      doneWhen: 'Other', evidence: ['Reproduction'], priority: 'P2' }, owner).result.conversationId
    expect(() => f.runCommand({ type: 'proposal.merge', conversationId: card.id, intoConversationId: other, reason: 'Same' }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
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
