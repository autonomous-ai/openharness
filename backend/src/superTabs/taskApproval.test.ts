import { describe, expect, it } from 'vitest'
import { applyCommand, authorizeCommandAccess, commandSchema, withoutCredentials, type CommandContext } from './commands.js'
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
  // Its machine is its person's own computer: a Team-session machine takes no new work in Swarm v3 (task #4120).
  f.edit(state => {
    const reading = state.machines!.find(m => m.machineId === 'host')!.observation!
    reading.sessionKind = 'computer'
    delete reading.privacy
  })
  if (board) f.state.projects![0]!.boardMode = true
  else delete f.state.projects![0]!.boardMode
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
  const propose = () => run({ type: 'buddy.propose', conversationId: f.buddyChat, projectId: 'lead', ownerMessageId: 'ask',
    text: words, goal: words, scope: 'Drafts', priority: 'normal', why: 'Lost edits', doneWhen: 'Drafts return', evidence: ['Reproduction'] }, buddy, {
    proposalAsk: { id: 'ask', conversationId: f.buddyChat, source: false, author: { kind: 'person', id: peer.userId, name: 'Peer',
      membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation }, text: words,
      createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] } })
  return Object.assign(f, { runCommand: run, card, mode, create, propose, pm, buddyActor: buddy, candidate, other })
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
    for (const actor of [f.pm, f.buddyActor]) expect(() => f.runCommand({ type: 'member.approvalMode', mode: 'autoApprove' }, actor)).toThrow()
  })
  it('stages a PM task, excludes dispatch, and blocks assignment, starts and registration until approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    expect(f.card(id)).toMatchObject({ assignment: null, taskApproval: { state: 'proposal', personId: peer.userId } })
    expect(queueSiblings(f.state, f.state.projects![0]!)).not.toContainEqual(f.card(id))
    expect(openTasks(f.state, 'lead', NOW)).not.toContainEqual(f.card(id))
    for (const input of [
      { type: 'work.assign', conversationId: id, agentId: f.candidate },
      { type: 'agent.start', request: { conversationId: id, machineId: 'host', engine: 'codex', name: 'New worker', cwd: '/repo', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } },
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
    expect(f.card(id)).toMatchObject({ taskApproval: { state: 'approved', suggestedAgentId: f.other }, assignment: null })
    expect(approved.messages.some(m => m.recipients.includes(f.lead))).toBe(true)
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.other }, f.pm)
    expect(f.card(id).assignment?.agentId).toBe(f.other)
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
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
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
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.approve', conversationId: id })
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    expect(f.card(id).assignment?.agentId).toBe(f.candidate)
  })
  it('refuses attribution to a Review requester after assignment without changing the existing task', () => {
    const f = fixture()
    const id = f.runCommand({ type: 'conversation.create', title: 'PM maintenance', task, priority: 'P2', requesterId: owner.userId,
      checks: [{ description: 'Restores drafts' }] }, f.pm).result.conversationId as string
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    f.mode('review')
    expect(() => f.runCommand({ type: 'conversation.requester', conversationId: id, personId: peer.userId }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    expect(f.card(id)).toMatchObject({ requesterId: owner.userId, assignment: { agentId: f.candidate } })
    expect(f.card(id).taskApproval).toBeUndefined()
  })
  it('keeps existing attribution and Auto approve attribution compatible', () => {
    const f = fixture(), id = f.create()
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    f.mode('review')
    f.runCommand({ type: 'conversation.requester', conversationId: id, personId: peer.userId }, f.pm)
    expect(f.card(id).taskApproval).toBeUndefined()
    f.runCommand({ type: 'conversation.requester', conversationId: id, personId: owner.userId }, f.pm)
    expect(f.card(id)).toMatchObject({ requesterId: owner.userId, assignment: { agentId: f.candidate } })
    expect(f.card(id).taskApproval).toBeUndefined()
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
  // Task #4252 (audit 20): Approve is the person's consent to the agent shown; whether it is free is the assignment's to check.
  it('records approval of a busy suggested agent, and the assignment still waits for it to be free', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    f.edit(s => { s.conversations.find(c => c.id === f.web)!.assignment!.agentId = f.candidate })
    f.runCommand({ type: 'task.approve', conversationId: id })
    expect(f.card(id).taskApproval?.state).toBe('approved')
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)).toThrow(expect.objectContaining({ code: 'AGENT_BUSY' }))
  })
  it('says the suggested agent is gone when it was removed before the approval', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate })
    f.edit(s => { s.agents = s.agents.filter(a => a.id !== f.candidate) })
    expect(() => f.runCommand({ type: 'task.approve', conversationId: id })).toThrow(expect.objectContaining({ code: 'SUGGESTED_AGENT_GONE' }))
    expect(f.card(id).taskApproval?.state).toBe('proposal')
  })
  it('keeps a legacy proposal’s decision when the PM converts it to a task and refuses a second conversion', () => {
    const f = fixture(false); f.mode('review'); const sent = f.propose()
    const row = sent.messages.find(m => m.source?.kind === 'buddy-proposal')!
    const proposal = { id: row.id, conversationId: row.conversationId, author: row.author, source: row.source ?? null }
    const input = { type: 'conversation.create', title: 'Prepared', task, priority: 'P2', proposalMessageId: row.id,
      checks: [{ description: 'Restores drafts' }] }
    const id = f.runCommand(input, f.pm, { proposal }).result.conversationId
    expect(f.card(id).taskApproval?.state).toBe('proposal')
    expect(f.state.conversations.filter(c => !c.archived && c.requesterId === peer.userId && (c.task || c.proposal))).toHaveLength(1)
    expect(() => f.runCommand(input, f.pm, { proposal })).toThrow()
  })
  it('refuses approving an undecided or Later proposal; the person approves the task the PM shaped (#4249)', () => {
    const f = fixture(); f.mode('review'); f.propose()
    const card = f.state.conversations.find(c => c.proposal)!
    f.runCommand({ type: 'task.suggest', conversationId: card.id, agentId: f.candidate })
    expect(() => f.runCommand({ type: 'task.approve', conversationId: card.id })).toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
    expect(f.card(card.id).taskApproval?.state).toBe('proposal')
    f.runCommand({ type: 'proposal.decide', conversationId: card.id, decision: 'accept', reason: 'Build', task,
      checks: [{ description: 'Restores drafts' }] }, f.pm)
    expect(() => f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.candidate }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.approve', conversationId: card.id })
    expect(() => f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.other }, f.pm)).toThrow()
    f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.candidate }, f.pm)
    expect(f.card(card.id).assignment?.agentId).toBe(f.candidate)
  })
  it('refuses approving a proposal the PM marked Later (#4249)', () => {
    const f = fixture(); f.mode('review'); f.propose()
    const card = f.state.conversations.find(c => c.proposal)!
    f.runCommand({ type: 'proposal.decide', conversationId: card.id, decision: 'later', reason: 'Next week', revisitAt: NOW + 86_400_000 }, f.pm)
    expect(() => f.runCommand({ type: 'task.approve', conversationId: card.id })).toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
  })
  it.each(['accept', 'reshape'])('a stored approval from before the decision does not carry over to the task the PM shapes on %s (#4249)', decision => {
    const f = fixture(); f.mode('review'); f.propose()
    const card = f.state.conversations.find(c => c.proposal)!
    // Approved while undecided, as a server before this fix allowed.
    f.edit(s => Object.assign(s.conversations.find(c => c.id === card.id)!.taskApproval!,
      { state: 'approved', decidedAt: NOW, suggestedAgentId: f.candidate }))
    f.runCommand({ type: 'proposal.decide', conversationId: card.id, decision, reason: 'Bigger', task: { ...task, changes: 'Persist drafts and sync them' },
      checks: [{ description: 'Restores drafts' }] }, f.pm)
    expect(f.card(card.id).taskApproval).toMatchObject({ state: 'proposal', suggestedAgentId: f.candidate })
    expect(f.card(card.id).taskApproval?.decidedAt).toBeUndefined()
    expect(() => f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.candidate }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.approve', conversationId: card.id })
    f.runCommand({ type: 'work.assign', conversationId: card.id, agentId: f.candidate }, f.pm)
    expect(f.card(card.id).assignment?.agentId).toBe(f.candidate)
  })
  it('a new scope for an approved, unstarted task goes back to its person (#4249, security review 1)', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    f.runCommand({ type: 'task.suggest', conversationId: id, agentId: f.candidate }, f.pm)
    f.runCommand({ type: 'task.approve', conversationId: id })
    f.runCommand({ type: 'work.define', conversationId: id, task: { ...task, changes: 'Persist drafts and rewrite sync' },
      checks: [{ description: 'Restores and syncs drafts' }] }, f.pm)
    expect(f.card(id).taskApproval).toMatchObject({ state: 'proposal', suggestedAgentId: f.candidate })
    expect(f.card(id).taskApproval?.decidedAt).toBeUndefined()
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.approve', conversationId: id })
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    expect(f.card(id).assignment?.agentId).toBe(f.candidate)
  })
  it('a converted older proposal gets a fresh approval, never the card’s decision (#4249)', () => {
    const f = fixture(false); f.mode('review'); const sent = f.propose()
    const row = sent.messages.find(m => m.source?.kind === 'buddy-proposal')!
    const mirror = f.state.conversations.find(c => c.taskApproval && c.proposal)!
    f.edit(s => Object.assign(s.conversations.find(c => c.id === mirror.id)!.taskApproval!,
      { state: 'approved', decidedAt: NOW, suggestedAgentId: f.candidate }))
    const id = f.runCommand({ type: 'conversation.create', title: 'Prepared', task: { ...task, changes: 'A different scope' }, priority: 'P2',
      proposalMessageId: row.id, checks: [{ description: 'Restores drafts' }] }, f.pm,
    { proposal: { id: row.id, conversationId: row.conversationId, author: row.author, source: row.source ?? null } }).result.conversationId
    expect(f.card(id).taskApproval).toMatchObject({ state: 'proposal', personId: peer.userId })
    expect(f.card(id).taskApproval?.suggestedAgentId).toBeUndefined()
    expect(f.card(id).taskApproval?.decidedAt).toBeUndefined()
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
  })
  it('cannot merge an approved Review proposal and lose its chosen agent or requester', () => {
    const f = fixture(); f.mode('review'); f.propose()
    const card = f.state.conversations.find(c => c.proposal)!
    f.runCommand({ type: 'task.suggest', conversationId: card.id, agentId: f.candidate })
    // Approved while undecided, as a server before #4249 allowed.
    f.edit(s => Object.assign(s.conversations.find(c => c.id === card.id)!.taskApproval!, { state: 'approved', decidedAt: NOW }))
    const target = f.runCommand({ type: 'proposal.create', projectId: 'lead', title: 'Other', text: 'Other', goal: 'Other', why: 'Other',
      doneWhen: 'Other', evidence: ['Reproduction'], priority: 'P2' }, owner).result.conversationId
    expect(() => f.runCommand({ type: 'proposal.merge', conversationId: card.id, intoConversationId: target, reason: 'Same' }, f.pm)).toThrow()
  })
  it('removes a closed legacy proposal mirror from active Tasks', () => {
    const f = fixture(false); const sent = f.propose()
    const row = sent.messages.find(m => m.source?.kind === 'buddy-proposal')!
    f.runCommand({ type: 'proposal.close', projectId: 'lead', messageId: row.id, reason: 'Not planned' }, f.pm,
      { proposal: { id: row.id, conversationId: row.conversationId, author: row.author, source: row.source ?? null } })
    expect(f.state.conversations.find(c => c.proposal?.legacyMessageId === row.id)?.archived).toBe(true)
  })
  it('tells the person, through their Buddy, that the PM closed their proposal and why (task #4252, audit 18)', () => {
    const f = fixture(false); const sent = f.propose()
    const row = sent.messages.find(m => m.source?.kind === 'buddy-proposal')!
    const closed = f.runCommand({ type: 'proposal.close', projectId: 'lead', messageId: row.id, reason: 'Out of scope' }, f.pm,
      { proposal: { id: row.id, conversationId: row.conversationId, author: row.author, source: row.source ?? null } })
    const notice = closed.messages.find(m => m.source?.kind === 'proposal-notice')
    const mirror = f.state.conversations.find(c => c.proposal?.legacyMessageId === row.id)!
    // Routed as a board decision's notice is (buddies.ts buddyFor).
    expect(notice).toMatchObject({ source: { moment: 'decided', cardId: mirror.id } })
    expect(notice!.text).toContain('Out of scope')
  })
  it('redacts a pasted credential from a rejection before its reason reaches stored parts or messages', () => {
    const token = ['sk', 'AbCdEf0123456789'.repeat(3)].join('-') // Synthetic fixture, never a provider credential.
    const removed: Parameters<typeof withoutCredentials>[1] = []
    const clean = withoutCredentials(commandSchema.parse({ type: 'task.reject', conversationId: 'task', reason: `Avoid ${token}` }), removed)
    expect(JSON.stringify(clean)).not.toContain(token)
    expect(removed.length).toBeGreaterThan(0)
  })
  it('blocks child review execution while the owning task is pending or rejected', () => {
    const f = fixture(); f.mode('review'); const id = f.create()
    const step = () => f.runCommand({ type: 'conversation.create', title: 'Review', brief: 'Review implementation', checks: [{ description: 'Review passed' }],
      reviewOf: id, step: 'Review' }, f.pm)
    expect(step).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.reject', conversationId: id, reason: 'Do later' })
    expect(step).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
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
    expect(() => f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.other }, f.pm)).toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
    f.runCommand({ type: 'task.approve', conversationId: id })
    f.runCommand({ type: 'work.assign', conversationId: id, agentId: f.other }, f.pm)
    expect(f.card(id).assignment?.agentId).toBe(f.other)
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
