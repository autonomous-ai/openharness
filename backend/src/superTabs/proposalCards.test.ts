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
  const base: Omit<typeof f, 'run'> = f
  return Object.assign(base, { run, create, card, pm })
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

  it('lets a viewer’s Buddy propose, but rechecks P0 rights before replay', () => {
    const f = fixture(), buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    f.state.people.find(p => p.id === peer.userId)!.role = 'viewer'
    const input = { type: 'buddy.propose', conversationId: f.buddyChat, ownerMessageId: 'ask', projectId: 'lead',
      ...proposal, scope: 'Persist drafts', priority: 'normal' }
    const consent: NonNullable<CommandContext['proposalAsk']> = { id: 'ask', conversationId: f.buddyChat, source: false,
      author: { kind: 'person', id: peer.userId, name: peer.email, membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation },
      text: words, createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] }
    expect(f.card(f.run(input, buddy, { proposalAsk: consent }).result.conversationId).proposal?.text).toBe(words)
    expect(() => authorizeCommandAccess(f.state, buddy, commandSchema.parse({ ...input, priority: 'P0' })))
      .toThrow(expect.objectContaining({ code: 'PRIORITY_FORBIDDEN' }))
  })

  it('keeps the approved files and scope when a Buddy sends a proposal card', () => {
    const f = fixture(), buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    const file = { id: 'plan', name: 'plan.md', mime: 'text/markdown', size: 120, url: 'https://cdn.example.test/plan.md' }
    const sent = f.run({ type: 'buddy.propose', conversationId: f.buddyChat, ownerMessageId: 'ask', projectId: 'lead',
      ...proposal, scope: 'Persist drafts', priority: 'normal', attachmentIds: ['plan'] }, buddy, {
      attachments: [file], proposalAsk: { id: 'ask', conversationId: f.buddyChat, source: false,
        author: { kind: 'person', id: peer.userId, name: peer.email, membershipGeneration: f.state.people.find(p => p.id === peer.userId)!.generation },
        text: words, createdAt: NOW, newestOwnerMessageId: 'ask', shown: [] },
    })
    expect(sent.messages.find(m => m.conversationId === sent.result.conversationId)?.attachments).toEqual([file])
    expect(f.card(sent.result.conversationId).proposal).toHaveProperty('scope', 'Persist drafts')
  })

  it('refuses hand assignment until the proposal is accepted', () => {
    const f = fixture(), id = f.create().result.conversationId
    expect(() => f.run({ type: 'work.assign', conversationId: id, agentId: f.worker }, f.pm))
      .toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
  })

  it('refuses a manual agent start before a decision', () => {
    const f = fixture(), id = f.create().result.conversationId
    expect(() => f.run({ type: 'agent.start', request: { conversationId: id, machineId: 'host', name: 'Builder', engine: 'codex', cwd: '/fixture', worktree: false, requirements: { memoryBytes: 100, diskBytes: 200, maxCpuPercent: 80, tools: [], devices: [], quotaRequired: false } } }, f.pm))
      .toThrow(expect.objectContaining({ code: 'PROPOSAL_UNDECIDED' }))
  })

  it('rejects dates outside the supported timestamp range at the command boundary', () => {
    const f = fixture(), id = f.create().result.conversationId
    expect(commandSchema.safeParse(ask(id, { deadline: 1e20 })).success).toBe(false)
    expect(commandSchema.safeParse(decide(id, 'later', { revisitAt: 1e20 })).success).toBe(false)
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

const acceptedTask = { goal: 'Keep drafts', changes: 'Persist offline edits', constraints: 'No dependencies', owns: ['backend/src/drafts.ts'] }
const checks = [{ description: 'Reconnect restores edits', independent: false }]
const deadline = NOW + 60_000
const decide = (conversationId: unknown, decision = 'accept', extra = {}) => ({ type: 'proposal.decide', conversationId,
  decision, reason: 'Prevents lost work for contributors', ...(['accept', 'reshape'].includes(decision) ? { task: acceptedTask, checks } : {}), ...extra })
const ask = (conversationId: unknown, extra = {}) => ({ type: 'proposal.ask', conversationId, personId: peer.userId,
  question: 'Keep drafts for seven days?', defaultAnswer: 'Keep seven days', deadline, ...extra })

describe('PM decisions and card questions', () => {
  it('sends shipped notices once to every proposer after verified release, never at merge', async () => {
    const { notePendingRelease, pendingKey, settleReleases } = await import('./releases.js')
    const { shippedNotice } = await import('./buddyNews.js')
    const { author } = await import('./model.js')
    const f = fixture(), id = f.create().result.conversationId, other = f.create(owner).result.conversationId
    f.run({ type: 'proposal.merge', conversationId: other, intoConversationId: id, reason: 'Same request' }, f.pm)
    f.run(decide(id), f.pm)
    const card = f.card(id), project = f.state.projects![0]!
    expect(shippedNotice(f.state, card, author(f.state, f.pm), 'merge')).toBeNull()
    notePendingRelease(project, card, 'https://github.com/o/r/pull/1', NOW)
    const entry = project.releases!.pending[0]!
    const facts = { resolved: [{ ...entry, components: ['backend' as const] }], releases: {} }
    expect(settleReleases(f.state, 'lead', facts, NOW).messages.filter(m => m.source?.moment === 'shipped')).toHaveLength(0)
    const verified = { resolved: [], releases: { backend: { tag: 'v1.0.0_backend', sha: 'verified', at: NOW + 1000, carries: [pendingKey(entry)] } } }
    const result = settleReleases(f.state, 'lead', verified, NOW + 1000)
    expect(result.messages.filter(m => m.source?.moment === 'shipped')).toHaveLength(2)
    expect(settleReleases(f.state, 'lead', verified, NOW + 2000).messages.filter(m => m.source?.moment === 'shipped')).toHaveLength(0)
  })

  it.each(['accept', 'reshape', 'later', 'no'])('records %s with its reason on the same card exactly once', decision => {
    const f = fixture(), id = f.create().result.conversationId
    const result = f.run(decide(id, decision, decision === 'later' ? { revisitAt: deadline } : {}), f.pm)
    expect(f.card(id).proposal?.decision).toMatchObject({ kind: decision, reason: 'Prevents lost work for contributors', at: NOW, by: f.lead })
    expect(result.messages.some(m => m.conversationId === id && m.text.includes('Prevents lost work'))).toBe(true)
    expect(result.messages.some(m => m.source?.kind === 'proposal-notice' && m.source.moment === 'decided')).toBe(true)
    if (['accept', 'reshape'].includes(decision)) {
      expect(f.card(id).task).toEqual(acceptedTask)
      expect(queueSiblings(f.state, f.state.projects![0]!)).toContainEqual(f.card(id))
      expect(f.card(id).checks[0]).toMatchObject({ description: 'Reconnect restores edits' })
    } else expect(f.card(id).task).toBeUndefined()
    if (decision === 'no') expect(f.card(id).archived).toBe(true)
    expect(() => f.run(decide(id), f.pm)).toThrow(expect.objectContaining({ code: 'PROPOSAL_DECIDED' }))
  })

  it('refuses decisions without accepted work/date and refuses non-PMs before receipt replay', () => {
    const f = fixture(), id = f.create().result.conversationId
    for (const actor of [owner, peer, { kind: 'agent', agentId: f.worker, machineOwnerId: `${owner.userId}-machine` } as Actor]) {
      expect(() => f.run(decide(id), actor)).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
    }
    for (const input of [decide(id, 'accept', { task: undefined }), decide(id, 'reshape', { checks: [] }), decide(id, 'later')]) {
      expect(() => f.run(input, f.pm)).toThrow()
    }
    const input = commandSchema.parse(decide(id))
    f.state.conversations.find(c => c.id === 'lead')!.leadId = f.worker
    expect(() => authorizeCommandAccess(f.state, f.pm, input)).toThrow(expect.objectContaining({ code: 'COORDINATOR_REQUIRED' }))
  })

  it('routes a question to its sender, and allows only that person or their sending Buddy to answer', () => {
    const f = fixture(), id = f.create().result.conversationId
    // A direct Board proposal has no sending Buddy: its current default may answer for its person.
    const asked = f.run(ask(id), f.pm), q = f.card(id).proposal!.questions[0]!
    expect(q).toMatchObject({ personId: peer.userId, question: 'Keep drafts for seven days?', defaultAnswer: 'Keep seven days', deadline, requiresConsent: false })
    expect(asked.messages.some(m => m.source?.kind === 'proposal-notice' && m.source.moment === 'needs-you')).toBe(true)
    const answer = { type: 'proposal.answer', conversationId: id, questionId: q.id, text: 'Keep fourteen days' }
    expect(() => f.run(answer, outsider)).toThrow(expect.objectContaining({ code: 'PROPOSAL_ANSWER_FORBIDDEN' }))
    f.state.people.find(p => p.id === peer.userId)!.role = 'viewer'
    f.run(answer, peer)
    expect(f.card(id).proposal!.questions[0]!.answer).toMatchObject({ text: 'Keep fourteen days', by: peer.userId, at: NOW })
    const late = f.run({ ...answer, text: 'Actually thirty' }, peer)
    expect(late.result.applied).toBe(false)
    expect(late.messages[0]!.text).toContain('Actually thirty')
    expect(f.card(id).proposal!.questions[0]!.answer!.text).toBe('Keep fourteen days')
  })

  it('permits the sending Buddy on its own card and keeps arbitrary posts and other Buddies forbidden', () => {
    const f = fixture(), id = f.create().result.conversationId, generation = f.state.people.find(p => p.id === peer.userId)!.generation
    f.card(id).proposal!.senders[0]!.buddyId = f.buddy
    const qid = f.run(ask(id), f.pm).result.questionId
    const buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Seven days is fine' }, buddy)
    expect(f.card(id).proposal!.questions[0]!.answer!.by).toBe(f.buddy)
    expect(() => f.run({ type: 'message.send', conversationId: id, text: 'Arbitrary new scope', recipientIds: [], replyTo: null }, buddy)).toThrow(expect.objectContaining({ code: 'BUDDY_FORBIDDEN' }))
    f.state.agents.push({ ...f.state.agents.find(a => a.id === f.buddy)!, id: 'other-buddy', harnessId: 'other', buddyOf: { personId: outsider.userId, generation: f.state.people.find(p => p.id === outsider.userId)!.generation } })
    expect(() => f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Foreign' },
      { kind: 'agent', agentId: 'other-buddy', machineOwnerId: `${owner.userId}-machine` })).toThrow()
    f.state.people.find(p => p.id === peer.userId)!.generation = 'rejoined'
    expect(() => authorizeCommandAccess(f.state, buddy, commandSchema.parse({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Stale' }))).toThrow()
  })

  it('never accepts a Buddy answer in place of explicit person consent', () => {
    const f = fixture(), id = f.create().result.conversationId
    f.card(id).proposal!.senders[0]!.buddyId = f.buddy
    const qid = f.run(ask(id, { requiresConsent: true }), f.pm).result.questionId
    expect(() => f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Yes' },
      { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` })).toThrow(expect.objectContaining({ code: 'PROPOSAL_CONSENT_REQUIRED' }))
  })

  it('allows the current default to answer after the sending Buddy is removed, but not while it remains', async () => {
    const { openSwarmBuddyChat } = await import('./buddies.js')
    const f = fixture(), id = f.create().result.conversationId
    const member = f.state.people.find(p => p.id === peer.userId)!
    const chat = openSwarmBuddyChat(f.state, member)
    const original = f.state.agents.find(a => a.id === f.buddy)!
    const fallback = { ...original, id: 'fallback', harnessId: 'fallback', buddyScope: 'swarm' as const }
    f.state.agents.push(fallback)
    chat.agentIds.push(fallback.id)
    f.card(id).proposal!.senders[0]!.buddyId = f.buddy
    const qid = f.run(ask(id), f.pm).result.questionId
    const answer = { type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Seven days' }
    const actor: Actor = { kind: 'agent', agentId: fallback.id, machineOwnerId: fallback.machineOwnerId }
    expect(() => f.run(answer, actor)).toThrow(expect.objectContaining({ code: 'PROPOSAL_ANSWER_FORBIDDEN' }))
    f.state.agents = f.state.agents.filter(a => a.id !== f.buddy)
    f.run(answer, actor)
    expect(f.card(id).proposal!.questions[0]!.answer?.by).toBe(fallback.id)
  })

  it('merges duplicates into one card, preserving attribution and notifying every proposer', () => {
    const f = fixture(), first = f.create().result.conversationId, second = f.create(outsider).result.conversationId
    const merged = f.run({ type: 'proposal.merge', conversationId: second, intoConversationId: first, reason: 'Same reconnect loss' }, f.pm)
    expect(f.card(second)).toMatchObject({ archived: true, proposal: { mergedInto: first } })
    expect(f.card(first).proposal!.senders.map(s => s.personId).sort()).toEqual([peer.userId, outsider.userId].sort())
    expect(merged.messages.filter(m => m.source?.kind === 'proposal-notice')).toHaveLength(2)
    expect(() => f.run({ type: 'proposal.merge', conversationId: first, intoConversationId: second, reason: 'Cycle' }, f.pm)).toThrow()
    expect(() => f.run({ type: 'proposal.merge', conversationId: first, intoConversationId: f.secretGroup, reason: 'Other project' }, f.pm)).toThrow()
    const third = f.create(owner).result.conversationId
    f.run({ type: 'proposal.merge', conversationId: first, intoConversationId: third, reason: 'Canonical combined card' }, f.pm)
    expect(f.card(second).proposal!.mergedInto).toBe(third)
    expect(f.card(first).proposal!.mergedInto).toBe(third)
  })

  it('does not abandon open questions or allow merge/ask metadata to grow without a bound', () => {
    const f = fixture(), id = f.create().result.conversationId, other = f.create(owner).result.conversationId
    f.run(ask(id), f.pm)
    expect(() => f.run({ type: 'proposal.merge', conversationId: id, intoConversationId: other, reason: 'Duplicate' }, f.pm)).toThrow(expect.objectContaining({ code: 'PROPOSAL_QUESTION_OPEN' }))
    for (let i = 1; i < 20; i++) f.run(ask(id), f.pm)
    expect(() => f.run(ask(id), f.pm)).toThrow(expect.objectContaining({ code: 'PROPOSAL_LIMIT' }))
  })
})

describe('proposal time and delivery boundaries', () => {
  it('applies a default exactly at the deadline once, preserving a later answer as discussion', async () => {
    const { advanceProposalCards } = await import('./proposalCards.js')
    const f = fixture(), id = f.create().result.conversationId
    const qid = f.run(ask(id), f.pm).result.questionId
    expect(advanceProposalCards(f.state, deadline - 1)).toEqual([])
    const messages = advanceProposalCards(f.state, deadline)
    expect(f.card(id).proposal!.questions[0]!.answer).toEqual({ text: 'Keep seven days', at: deadline, by: 'default', defaulted: true })
    expect(messages.some(m => m.source?.kind === 'proposal-answer' && m.recipients.includes(f.lead))).toBe(true)
    expect(advanceProposalCards(f.state, deadline + 1)).toEqual([])
    expect(f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Late correction' }, peer, { now: deadline + 2 }).result.applied).toBe(false)
    expect(f.card(id).proposal!.questions[0]!.answer!.text).toBe('Keep seven days')
  })

  it('checks the deadline within an answer transaction even before the worker runs', () => {
    const f = fixture(), id = f.create().result.conversationId, qid = f.run(ask(id), f.pm).result.questionId
    const answer = f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'Too late' }, peer, { now: deadline })
    expect(answer.result.applied).toBe(false)
    expect(f.card(id).proposal!.questions[0]!.answer!.defaulted).toBe(true)
  })

  it('marks explicit consent overdue without defaulting, and still permits the named person', async () => {
    const { advanceProposalCards } = await import('./proposalCards.js')
    const f = fixture(), id = f.create().result.conversationId, qid = f.run(ask(id, { requiresConsent: true }), f.pm).result.questionId
    advanceProposalCards(f.state, deadline)
    expect(f.card(id).proposal!.questions[0]).toMatchObject({ overdue: true })
    expect(f.card(id).proposal!.questions[0]!.answer).toBeUndefined()
    expect(advanceProposalCards(f.state, deadline + 1)).toEqual([])
    expect(f.run({ type: 'proposal.answer', conversationId: id, questionId: qid, text: 'I agree' }, peer, { now: deadline + 2 }).result.applied).toBe(true)
  })

  it('reopens Later on its date even after a month, and marks unanswered proposals overdue once', async () => {
    const { advanceProposalCards } = await import('./proposalCards.js')
    const f = fixture(), id = f.create().result.conversationId, date = NOW + 30 * 86_400_000
    f.run(decide(id, 'later', { revisitAt: date }), f.pm)
    expect(advanceProposalCards(f.state, date - 1)).toEqual([])
    expect(advanceProposalCards(f.state, date).some(m => m.recipients.includes(f.lead))).toBe(true)
    expect(f.card(id).proposal!.decision).toBeUndefined()
    const overdue = advanceProposalCards(f.state, date + 30 * 60_000)
    expect(f.card(id).proposal!.overdue).toBe(true)
    expect(overdue.some(m => m.source?.kind === 'proposal-overdue')).toBe(true)
    expect(advanceProposalCards(f.state, date + 31 * 60_000)).toEqual([])
  })

  it.each(['person', 'agent'] as const)('tells a %s when their ordinary post reaches no switched PM', kind => {
    const f = fixture(), actor: Actor = kind === 'person' ? owner : { kind: 'agent', agentId: f.worker, machineOwnerId: `${owner.userId}-machine` }
    const sent = f.run({ type: 'message.send', conversationId: f.web, text: 'Answer for the PM', recipientIds: [f.lead], replyTo: null }, actor)
    expect(sent.messages.find(m => m.id === sent.result.messageId)?.recipients).toEqual([])
    expect(sent.result.reachedNoAgent).toEqual(expect.any(String))
    expect(sent.result.notReached).toContain('lead-harness')
    expect(sent.result.notReached).toContain('proposal card')
  })

  it('reports the excluded PM while delivering to another recipient and leaves legacy delivery alone', () => {
    const f = fixture()
    const input = { type: 'message.send', conversationId: f.web, text: 'For both of you', recipientIds: [f.lead, f.worker], replyTo: null }
    const sent = f.run(input, owner)
    expect(sent.messages.find(m => m.id === sent.result.messageId)?.recipients).toEqual([f.worker])
    expect(sent.result.notReached).toContain('lead-harness')
    expect(sent.result.notReached).not.toContain('worker-harness')
    expect(sent.result).not.toHaveProperty('reachedNoAgent')
    delete f.state.projects![0]!.boardMode
    const legacy = f.run(input, owner)
    expect(legacy.messages.find(m => m.id === legacy.result.messageId)?.recipients).toEqual([f.lead, f.worker])
    expect(legacy.result).not.toHaveProperty('notReached')
    expect(legacy.result).not.toHaveProperty('reachedNoAgent')
  })

  it('blocks ordinary messages to a switched PM, retaining proposals, answers, server notices and all legacy inputs', async () => {
    const { pmAcceptsMessage } = await import('./proposalCards.js')
    const f = fixture(), id = f.create().result.conversationId
    expect(pmAcceptsMessage(f.state, f.lead, undefined)).toBe(false)
    for (const kind of ['proposal-card', 'proposal-answer', 'work-status', 'system']) expect(pmAcceptsMessage(f.state, f.lead, { kind })).toBe(true)
    const posted = f.run({ type: 'message.send', conversationId: id, text: 'New scope via chat', recipientIds: [f.lead], replyTo: null }, peer)
    expect(posted.messages[0]!.recipients).toEqual([])
    delete f.state.projects![0]!.boardMode
    expect(pmAcceptsMessage(f.state, f.lead, undefined)).toBe(true)
  })
})

// Review of #3310 at c91dc2489 (task #3595): a PM's or Buddy's credential reached a proposal ruling, a card question, a merge
// reason and a Buddy's answer as written. An agent's text there is refused as its posts are. (Redacting a person's: #4340.)
describe('an agent\'s credential in proposal text', () => {
  // Assembled at run time, as agentSecrets.test.ts does, so the repository holds nothing a scanner takes for a secret.
  const token = ['ghp', 'Q7mZ2xK9pL4vR8nT1wB6yC3dF5hJ0aE2sG7u'].join('_')
  const leaked = `Here it is: ${token} (for the deploy)`
  const refused = (f: ReturnType<typeof fixture>, input: Record<string, unknown>, actor: Actor) => {
    const before = JSON.stringify(f.state)
    let error: unknown
    try { f.run(input, actor) } catch (e) { error = e }
    expect(error, JSON.stringify(input)).toMatchObject({ code: 'SECRET_LIKE', status: 400 })
    expect(String((error as Error).message)).not.toContain(token)
    expect(JSON.stringify(f.state), 'something was stored').toBe(before)
  }
  const buddyCard = (f: ReturnType<typeof fixture>) => {
    const id = f.create().result.conversationId
    f.card(id).proposal!.senders[0]!.buddyId = f.buddy
    return id
  }

  it('is refused in a PM\'s ruling: its reason, the task and the checks', () => {
    const f = fixture(), id = buddyCard(f)
    refused(f, decide(id, 'no', { reason: leaked }), f.pm)
    refused(f, decide(id, 'accept', { task: { ...acceptedTask, goal: leaked } }), f.pm)
    refused(f, decide(id, 'accept', { checks: [{ description: leaked, independent: false }] }), f.pm)
  })

  it('is refused in a PM\'s question on a card and its default answer', () => {
    const f = fixture(), id = buddyCard(f)
    refused(f, ask(id, { question: leaked }), f.pm)
    refused(f, ask(id, { defaultAnswer: leaked }), f.pm)
  })

  it('is refused in a PM\'s merge reason', () => {
    const f = fixture(), id = f.create().result.conversationId, other = f.create(owner).result.conversationId
    refused(f, { type: 'proposal.merge', conversationId: other, intoConversationId: id, reason: leaked }, f.pm)
  })

  it('is refused in a Buddy\'s answer', () => {
    const f = fixture(), id = buddyCard(f)
    const qid = f.run(ask(id), f.pm).result.questionId
    const buddy: Actor = { kind: 'agent', agentId: f.buddy, machineOwnerId: `${owner.userId}-machine` }
    refused(f, { type: 'proposal.answer', conversationId: id, questionId: qid, text: leaked }, buddy)
  })
})
