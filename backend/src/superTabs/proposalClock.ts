/** Timed proposal transitions run in the existing singleton worker and the answering card's transaction. */
import { author, stableId, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'
import { proposalNotices, type ProposalQuestion, type ProposalRecord } from './proposalCards.js'

export const PROPOSAL_WAIT_MS = 30 * 60_000
export type ProposalCard = Conversation & { proposal: ProposalRecord }
export function proposalDueAt(proposal: ProposalRecord | undefined): number | null {
  if (!proposal || proposal.mergedInto || proposal.decision?.kind === 'no') return null
  if (proposal.decision?.kind === 'later') return proposal.decision.revisitAt ?? null
  const times = proposal.questions.filter(q => !q.answer && !q.overdue).map(q => q.deadline)
  if (!proposal.decision && !proposal.overdue) times.push((proposal.waitSince ?? proposal.createdAt) + PROPOSAL_WAIT_MS)
  return times.length ? Math.min(...times) : null
}
function clockAuthor(state: SuperTabState, card: ProposalCard): Author {
  const project = groupProject(state, card)
  const pm = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const agent = pm && state.agents.find(a => a.id === pm)
  if (agent) return author(state, { kind: 'agent', agentId: agent.id, machineOwnerId: agent.machineOwnerId })
  // No PM is running: the server still records expiry and tells the current project owner, without impersonating a former PM.
  const member = state.people.find(p => p.id === project.ownerId) ?? state.people.find(p => p.id === state.ownerId)!
  return { kind: 'person', id: member.id, name: member.email, membershipGeneration: member.generation }
}
export function expireProposalQuestion(state: SuperTabState, card: ProposalCard, q: ProposalQuestion, now: number): MessageDraft[] {
  if (q.answer || q.overdue || now < q.deadline) return []
  const sender = clockAuthor(state, card), id = stableId(q.id, 'deadline')
  if (q.requiresConsent) {
    q.overdue = true
    return proposalNotices(state, card, 'needs-you', `${card.title}: agreement is overdue. ${q.question}`, sender, id,
      card.proposal.senders.filter(s => s.personId === q.personId))
  }
  q.answer = { text: q.defaultAnswer, at: q.deadline, by: 'default', defaulted: true }
  return [{ id, conversationId: card.id, author: sender, text: q.defaultAnswer, recipients: card.leadId ? [card.leadId] : [], replyTo: null,
    source: { kind: 'proposal-answer', questionId: q.id, defaulted: true, applied: true } }]
}
export function advanceProposalCards(state: SuperTabState, now: number): MessageDraft[] {
  const messages: MessageDraft[] = []
  for (const group of state.conversations) {
    if (!group.proposal || group.proposal.mergedInto) continue
    const card = group as ProposalCard, record = card.proposal, project = groupProject(state, card)
    if (record.decision?.kind === 'later' && now >= record.decision.revisitAt!) {
      const date = record.decision.revisitAt!
      delete record.decision
      record.waitSince = now
      delete record.overdue
      card.archived = false
      messages.push({ id: stableId(card.id, 'revisit', String(date)), conversationId: card.id, author: clockAuthor(state, card), text: 'This proposal is due for another decision.',
        recipients: card.leadId ? [card.leadId] : [], replyTo: null, source: { kind: 'proposal-card', priority: card.priority } })
    }
    for (const q of record.questions) messages.push(...expireProposalQuestion(state, card, q, now))
    if (!record.decision && !record.overdue && now >= (record.waitSince ?? record.createdAt) + PROPOSAL_WAIT_MS) {
      record.overdue = true
      const owner = state.people.find(p => p.id === project.ownerId)
      if (owner) {
        const rows = proposalNotices(state, card, 'needs-you', `${card.title} has waited over 30 minutes for a PM decision.`, clockAuthor(state, card),
          stableId(card.id, 'overdue', String(record.waitSince ?? record.createdAt)), [{ personId: owner.id, generation: owner.generation }])
        for (const row of rows) row.source = { ...row.source, kind: 'proposal-overdue' }
        messages.push(...rows)
      }
    }
  }
  return messages
}
