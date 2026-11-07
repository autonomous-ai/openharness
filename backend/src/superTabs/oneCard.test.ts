import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type CommandContext } from './commands.js'
import { fullSwarm, NOW, owner, peer } from './read/fixture.test-support.js'
import type { Actor } from './model.js'

/** Task #4538 (anh Dee): a person's ask stays one card from Proposal to shipped. The Lead took six of his asks by cancelling his
 *  card and starting its own task, so his Tasks filled with cards that open to "cancelled". */
const words = 'Keep edits offline until the connection returns.'
const proposal = { title: 'Offline edits', text: words, goal: 'Keep drafts', why: 'People lose offline work',
  doneWhen: 'Reconnect restores edits', evidence: ['Reproduced with network disabled'], priority: 'P2' as const }
const acceptedTask = { goal: 'Keep drafts', changes: 'Persist offline edits', constraints: 'No dependencies', owns: ['backend/src/drafts.ts'] }
const checks = [{ description: 'Reconnect restores edits', independent: false }]

function fixture(approval: 'autoApprove' | 'review' = 'autoApprove') {
  const f = fullSwarm(NOW)
  // Its machine is its person's own computer: a Team-session machine takes no new work in Swarm v3 (task #4120).
  f.edit(state => {
    const reading = state.machines!.find(m => m.machineId === 'host')!.observation!
    reading.sessionKind = 'computer'
    delete reading.privacy
  })
  Object.assign(f.state.projects![0]!, { boardMode: true })
  const candidate = f.add('candidate', f.web)
  for (const member of f.state.people) member.approvalMode = approval
  let seq = 0
  const run = (input: unknown, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(f.state, actor, commandSchema.parse(input), { now: NOW, operationId: `one-card-${++seq}`, ...context })
    f.edit(state => Object.assign(state, effects.state))
    return effects
  }
  const propose = (actor: Actor = peer) => run({ type: 'proposal.create', projectId: 'lead', ...proposal }, actor).result.conversationId as string
  const card = (id: string) => f.state.conversations.find(c => c.id === id)!
  const pm: Actor = { kind: 'agent', agentId: f.lead, machineOwnerId: `${owner.userId}-machine` }
  const decide = (id: string, decision = 'accept') => run({ type: 'proposal.decide', conversationId: id, decision, reason: 'Prevents lost work',
    ...decision === 'accept' ? { task: acceptedTask, checks } : {} }, pm)
  return Object.assign(f, { run, propose, card, pm, decide, candidate })
}

describe('a person\'s ask is one card from Proposal to shipped', () => {
  it('the Lead accepts it on that card, and the work is assigned on that card, with no second task', () => {
    const f = fixture(), id = f.propose()
    const tasksOf = () => f.state.conversations.filter(c => !c.kind && !c.audience && !c.reviewOf && c.requesterId === peer.userId).map(c => c.id)
    const before = tasksOf()
    f.decide(id)
    f.run({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    expect(f.card(id)).toMatchObject({ id, requesterId: peer.userId, task: acceptedTask, assignment: { agentId: f.candidate },
      proposal: { decision: { kind: 'accept' } } })
    expect(tasksOf()).toEqual(before)
  })

  it('refuses the Lead\'s cancel of the card when its reason names another task, and says what to use instead', () => {
    const f = fixture(), id = f.propose(), other = f.state.conversations.find(c => c.id === f.web)!
    for (const reason of [`Duplicate of #${other.number}`, `Being done inside #${other.number}.`]) {
      expect(() => f.run({ type: 'work.cancel', conversationId: id, assignmentId: 'current', reason }, f.pm))
        .toThrow(expect.objectContaining({ code: 'USE_PROPOSAL_COMMAND', message: expect.stringMatching(/proposal\.decide.*proposal\.merge/) }))
    }
    expect(f.card(id)).toMatchObject({ archived: false, assignment: null })
    expect(f.card(id).foldedInto).toBeUndefined()
  })

  it('refuses it after the card was accepted and assigned too, and the work goes on', () => {
    const f = fixture(), id = f.propose(), other = f.state.conversations.find(c => c.id === f.web)!
    f.decide(id)
    f.run({ type: 'work.assign', conversationId: id, agentId: f.candidate }, f.pm)
    const assignment = f.card(id).assignment!
    expect(() => f.run({ type: 'work.cancel', conversationId: id, assignmentId: assignment.id, reason: `Duplicate of #${other.number}` }, f.pm))
      .toThrow(expect.objectContaining({ code: 'USE_PROPOSAL_COMMAND' }))
    expect(f.card(id).assignment).toMatchObject({ id: assignment.id, status: 'working' })
  })

  it('changes nothing else about cancels: a cancel naming no task, and a task that is no proposal, work as before', () => {
    const f = fixture(), id = f.propose(), other = f.state.conversations.find(c => c.id === f.web)!
    f.run({ type: 'work.cancel', conversationId: id, assignmentId: 'current', reason: 'Not needed after all' }, f.pm)
    expect(f.card(id)).toMatchObject({ archived: true })
    const own = f.state.conversations.find(c => c.id === f.web)!
    expect(own.proposal).toBeUndefined()
    f.run({ type: 'work.cancel', conversationId: own.id, assignmentId: own.assignment!.id, reason: `Duplicate of #${f.state.conversations.find(c => c.id === f.secretGroup)?.number ?? other.number}` }, f.pm)
    expect(f.card(own.id).assignment).toMatchObject({ status: 'cancelled' })
  })

  it('proposal.merge works on a person\'s own Review card, so the Lead has a command for a duplicate', () => {
    const f = fixture('review'), first = f.propose(), second = f.propose()
    expect(f.card(first).taskApproval).toMatchObject({ personId: peer.userId, state: 'proposal' })
    f.run({ type: 'proposal.merge', conversationId: second, intoConversationId: first, reason: 'Same request' }, f.pm)
    expect(f.card(second)).toMatchObject({ archived: true, proposal: { mergedInto: first } })
    expect(f.card(first).proposal).toMatchObject({ mergedFrom: [second] })
  })

  it('still keeps two different people\'s Review cards apart', () => {
    const f = fixture('review'), first = f.propose(peer), second = f.propose(owner)
    expect(() => f.run({ type: 'proposal.merge', conversationId: second, intoConversationId: first, reason: 'Same request' }, f.pm))
      .toThrow(expect.objectContaining({ code: 'TASK_APPROVAL_REQUIRED' }))
  })
})
