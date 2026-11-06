import { describe, expect, it } from 'vitest'
import { applyCommand, authorizeCommandAccess, commandSchema, type CommandContext } from './commands.js'
import { fullSwarm, NOW, owner, peer, outsider, config } from './read/fixture.test-support.js'
import { type Actor, type Conversation, type SuperTabState } from './model.js'
import { queueSiblings } from './taskQueue.js'
import { groupView } from './read/views.js'
import { GROUP_FIELDS } from './parts/light.js'

const words = 'Keep edits offline until the connection returns.'
const proposal = { title: 'Offline edits', text: words, goal: 'Keep drafts', why: 'People lose offline work',
  doneWhen: 'Reconnect restores edits', evidence: ['Reproduced with network disabled'], priority: 'P2' as const }
function fixture(switched = true) {
  const f = fullSwarm(NOW)
  if (switched) Object.assign(f.state.projects![0]!, { boardMode: true })
  let seq = 0
  const run = (input: unknown, actor: Actor = peer, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(f.state, actor, commandSchema.parse(input), { now: NOW, operationId: `proposal-test-${++seq}`, ...context })
    f.edit(state => Object.assign(state, effects.state))
    return effects
  }
  const create = (actor: Actor = peer, extra = {}) => run({ type: 'proposal.create', projectId: 'lead', ...proposal, ...extra }, actor)
  const card = (id: unknown) => f.state.conversations.find(c => c.id === id)!
  const pm: Actor = { kind: 'agent', agentId: f.lead, machineOwnerId: `${owner.userId}-machine` }
  return Object.assign(f, { run, create, card, pm })
}

// Removing record creation, membership/consent checks or the queue exclusion breaks these caller-visible assertions.
describe('proposal card creation', () => {
  it.each(['collaborator', 'viewer'] as const)('lets a current %s propose without a Buddy and keeps it out of the task queue', role => {
    const f = fixture()
    f.state.people.find(p => p.id === peer.userId)!.role = role
    const sent = f.create(), card = f.card(sent.result.conversationId)
    expect(card).toMatchObject({ title: 'Offline edits', projectId: 'lead', requesterId: peer.userId, priority: 'P2', assignment: null,
      proposal: { version: 1, text: words, goal: 'Keep drafts', why: 'People lose offline work', doneWhen: 'Reconnect restores edits', evidence: ['Reproduced with network disabled'], priority: 'P2', createdAt: NOW, senders: [{ personId: peer.userId,
        generation: f.state.people.find(p => p.id === peer.userId)!.generation }], questions: [] } })
    expect(card.task).toBeUndefined()
    expect(queueSiblings(f.state, f.state.projects![0]!)).not.toContainEqual(card)
    expect(sent.messages.find(m => m.conversationId === card.id)).toMatchObject({ text: words, recipients: [f.lead], source: { kind: 'proposal-card' } })
    expect(groupView(card, new Set())).toHaveProperty('proposal.text', words)
  })

  it.each(['goal', 'why', 'doneWhen', 'evidence'] as const)('refuses a missing %s', field => {
    const f = fixture(), input: Record<string, unknown> = { type: 'proposal.create', projectId: 'lead', ...proposal }
    delete input[field]
    expect(commandSchema.safeParse(input).success).toBe(false)
    expect(f.state.conversations.some(c => 'proposal' in c)).toBe(false)
  })

  it('refuses board proposals before switching and private projects the member cannot read', () => {
    const legacy = fixture(false)
    expect(() => legacy.create()).toThrow(expect.objectContaining({ code: 'BOARD_MODE_REQUIRED' }))
    const f = fixture()
    expect(() => f.create(outsider, { projectId: f.secret })).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('allows P0/hotfix only for an entitled person, including through their Buddy', () => {
    const f = fixture()
    expect(() => f.create(peer, { priority: 'P0' })).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
    for (const priority of ['P0', 'hotfix']) expect(f.card(f.create(owner, { priority }).result.conversationId).priority).toBe('P0')
    Object.assign(f.state.projects![0]!, { decider: peer.userId })
    expect(f.card(f.create(peer, { priority: 'P0' }).result.conversationId).priority).toBe('P0')
  })

  it('preserves exact consent and person/Buddy attribution on switched buddy.propose', () => {
    const f = fixture(), buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    const input = { type: 'buddy.propose', conversationId: f.buddyChat, ownerMessageId: 'ask', projectId: 'lead',
      ...proposal, scope: 'Persist drafts', priority: 'normal' }
    const ask: NonNullable<CommandContext['proposalAsk']> = { id: 'ask', conversationId: f.buddyChat, source: false,
      author: { kind: 'person', id: peer.userId, name: peer.email, membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation },
      text: words, createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] }
    const sent = f.run(input, buddy, { proposalAsk: ask }), card = f.card(sent.result.conversationId)
    expect(card.proposal?.senders[0]).toMatchObject({ personId: peer.userId, buddyId: f.buddy })
    expect(sent.messages.find(m => m.conversationId === card.id)?.author.id).toBe(peer.userId)
    expect(() => f.run({ ...input, ownerMessageId: 'ask2', text: 'Private extra detail' }, buddy,
      { proposalAsk: { ...ask, id: 'ask2', newestOwnerMessageId: 'ask2' } })).toThrow(expect.objectContaining({ code: 'PROPOSAL_UNSHOWN' }))
    expect(() => f.run({ ...input, ownerMessageId: 'ask3', priority: 'P0' }, buddy,
      { proposalAsk: { ...ask, id: 'ask3', newestOwnerMessageId: 'ask3' } })).toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
  })

  it('keeps unswitched Buddy proposals as project-chat roots and refuses new priorities there', () => {
    const f = fixture(false), buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    const input = { type: 'buddy.propose', conversationId: f.buddyChat, ownerMessageId: 'ask', projectId: 'lead',
      title: 'Offline edits', text: words, goal: proposal.goal, scope: 'Persist drafts', priority: 'high' }
    const ask: NonNullable<CommandContext['proposalAsk']> = { id: 'ask', conversationId: f.buddyChat, source: false,
      author: { kind: 'person', id: peer.userId, name: peer.email, membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation },
      text: words, createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] }
    const sent = f.run(input, buddy, { proposalAsk: ask })
    expect(sent.messages[0]).toMatchObject({ conversationId: 'lead', source: { kind: 'buddy-proposal', priority: 'high' } })
    expect(sent.result.conversationId).toBeUndefined()
    expect(() => f.run({ ...input, ownerMessageId: 'ask2', priority: 'P0' }, buddy, { proposalAsk: { ...ask, id: 'ask2', newestOwnerMessageId: 'ask2' } })).toThrow(expect.objectContaining({ code: 'BOARD_MODE_REQUIRED' }))
  })

  it('retains proposal authorization metadata in light delivery loads', () => {
    expect(GROUP_FIELDS.always).toContain('proposal')
  })

  it('imports an unanswered legacy message once with stable identity and original words', async () => {
    const cards = await import('./proposalCards.js')
    const f = fixture(), ask = { messageId: 'legacy-ask', conversationId: 'lead', personId: peer.userId, text: 'Please keep these exact words', at: NOW - 1000 }
    const id = cards.importLegacyProposal(f.state, f.state.projects![0]!, ask, NOW)
    expect(cards.importLegacyProposal(f.state, f.state.projects![0]!, ask, NOW)).toBe(id)
    expect(f.state.conversations.filter(c => c.id === id)).toHaveLength(1)
    expect(f.card(id)).toMatchObject({ requesterId: peer.userId, proposal: { text: ask.text, legacyMessageId: 'legacy-ask', createdAt: NOW - 1000 } })
  })
})
