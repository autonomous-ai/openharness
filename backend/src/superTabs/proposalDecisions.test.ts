import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type CommandContext } from './commands.js'
import { PROPOSAL_QUESTION } from './decisions.js'
import { fullSwarm, NOW, owner, peer } from './read/fixture.test-support.js'
import { isBuddyChat } from './buddies.js'
import { stableId, SuperTabError, type Actor } from './model.js'

// Task #4547 (anh Dee, 11-07): what needs a person lands in their Decisions, never as a Lead's line in their private chat. A PM's
// question on a proposal card (proposal.ask) is a Decision for the person asked, and an answer there or on the card settles it.

const proposal = { title: 'Offline edits', text: 'Keep edits offline.', goal: 'Keep drafts', why: 'People lose offline work',
  doneWhen: 'Reconnect restores edits', evidence: ['Reproduced with network disabled'], priority: 'P2' as const }
const deadline = NOW + 60 * 60_000

function fixture() {
  const f = fullSwarm(NOW)
  Object.assign(f.state.projects![0]!, { boardMode: true })
  let seq = 0
  const run = (input: unknown, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(f.state, actor, commandSchema.parse(input), { now: NOW, operationId: `proposal-decision-${++seq}`, ...context })
    f.edit(state => Object.assign(state, effects.state))
    return effects
  }
  const pm: Actor = { kind: 'agent', agentId: f.lead, machineOwnerId: `${owner.userId}-machine` }
  const card = run({ type: 'proposal.create', projectId: 'lead', ...proposal }).result.conversationId as string
  const ask = (extra = {}) => run({ type: 'proposal.ask', conversationId: card, personId: peer.userId, question: 'Keep drafts for seven days?',
    defaultAnswer: 'Keep seven days', deadline, ...extra }, pm)
  const question = () => f.state.conversations.find(c => c.id === card)!.proposal!.questions.at(-1)!
  return Object.assign(f, { run, pm, card, ask, question })
}

/** The decision as the store reads it back for an answer. */
const target = (draft: NonNullable<ReturnType<typeof applyCommand>['decisions']>[number]) =>
  ({ ...draft, answeredAt: null, createdAt: NOW, withdrawn: false, mustAgree: draft.mustAgree === true, defaultAt: draft.defaultAt ? Date.parse(draft.defaultAt) : null })

describe('a PM’s question on a proposal card', () => {
  it('opens a Decision for the person asked, with its default as the option and its deadline as the default time', () => {
    const f = fixture()
    const asked = f.ask()
    const q = f.question()
    expect(asked.decisions).toEqual([expect.objectContaining({ id: stableId(q.id, 'decision'), personId: peer.userId, conversationId: f.card,
      question: 'Offline edits: Keep drafts for seven days?', options: ['Keep seven days'], recommended: 0, defaultAt: new Date(deadline).toISOString(),
      kind: PROPOSAL_QUESTION, askerAgentId: f.lead })])
    expect(asked.messages.filter(m => isBuddyChat(f.state.conversations.find(c => c.id === m.conversationId) ?? { kind: undefined }))).toEqual([])
  })

  it('waits for an agreement the person must give', () => {
    const f = fixture()
    expect(f.ask({ requiresConsent: true }).decisions![0]).toMatchObject({ mustAgree: true })
  })

  it('answers the card from Decisions: its default with one tap, or the person’s own words', () => {
    const f = fixture()
    const decision = target(f.ask().decisions![0]!)
    const done = f.run({ type: 'decision.answer', decisionId: decision.id, choice: 0 }, peer, { decision })
    expect(done.decisionAnswer).toMatchObject({ id: decision.id, choice: 0 })
    expect(f.question().answer).toMatchObject({ text: 'Keep seven days', by: peer.userId })
    const other = fixture(), typed = target(other.ask().decisions![0]!)
    other.run({ type: 'decision.answer', decisionId: typed.id, note: 'Keep fourteen days' }, peer, { decision: typed })
    expect(other.question().answer).toMatchObject({ text: 'Keep fourteen days' })
  })

  it('takes its default at its time', () => {
    const f = fixture()
    const decision = target(f.ask().decisions![0]!)
    f.run({ type: 'decision.answer', decisionId: decision.id, delegate: true }, peer, { decision, defaulted: true, now: deadline })
    expect(f.question().answer).toMatchObject({ text: 'Keep seven days' })
  })

  it('closes when the person answers on the card, and is answered no more', () => {
    const f = fixture()
    const decision = target(f.ask().decisions![0]!)
    const onCard = f.run({ type: 'proposal.answer', conversationId: f.card, questionId: f.question().id, text: 'Seven is fine' })
    expect(onCard.closedDecisions).toEqual([decision.id])
    let code = ''
    try { f.run({ type: 'decision.answer', decisionId: decision.id, choice: 0 }, peer, { decision }) } catch (error) { code = (error as SuperTabError).code }
    expect(code).toBe('DECISION_ANSWERED')
  })
})
