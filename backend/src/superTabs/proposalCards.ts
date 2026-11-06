/** Durable proposal metadata lives on its existing version-guarded card. Discussion stays in message rows. */
import { z } from 'zod'
import { author, fail, nextConversationNumber, person, stableId, type Actor, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadProject, ownsProject, readProject, type SwarmProject } from './projects.js'
import { proposalPriority, type TaskPriority } from './taskPriority.js'

export interface ProposalSender { personId: string; generation: string; buddyId?: string }
export interface ProposalRecord {
  version: 1
  text: string
  goal: string
  why: string
  doneWhen: string
  evidence: string[]
  priority: TaskPriority
  createdAt: number
  senders: ProposalSender[]
  questions: ProposalQuestion[]
  legacyMessageId?: string
  decision?: { kind: 'accept' | 'reshape' | 'later' | 'no'; reason: string; at: number; by: string; revisitAt?: number }
  mergedInto?: string
  mergedFrom?: string[]
  overdue?: true
}
export interface ProposalQuestion {
  id: string; personId: string; question: string; defaultAnswer: string; deadline: number; requiresConsent: boolean
  answer?: { text: string; at: number; by: string; defaulted?: true }
  overdue?: true
}
const field = z.string().trim().min(1).max(4000)
export const proposalFields = {
  text: z.string().trim().min(1).max(32_000), goal: field, why: field, doneWhen: field,
  evidence: z.array(z.string().trim().min(1).max(2000)).min(1).max(5),
}
export const proposalCreateSchema = z.object({ type: z.literal('proposal.create'), projectId: z.string().min(1).max(160),
  title: z.string().trim().min(1).max(160), ...proposalFields, priority: z.enum(['P0', 'P1', 'P2', 'P3', 'hotfix']) }).strict()
export type CreateProposal = z.infer<typeof proposalCreateSchema>

export function requireBoard(project: SwarmProject): void {
  if (project.boardMode !== true) fail('BOARD_MODE_REQUIRED', 'This project has not switched to proposal cards.', 409)
}
/** Legacy low/normal/high keep their old meaning; only an entitled person can originate a hotfix. */
export function cardPriority(state: SuperTabState, project: SwarmProject, ownerId: string, value: string): TaskPriority {
  const priority = value === 'hotfix' ? 'P0' : /^P[0-3]$/.test(value) ? value as TaskPriority : proposalPriority(value)
  const member = person(state, ownerId)
  if (priority === 'P0' && member.id !== state.ownerId && !ownsProject(state, member.id, project) && project.decider !== member.id) {
    fail('PRIORITY_FORBIDDEN', 'Only the project owner, Swarm owner or top decider may propose P0 or a hotfix.', 403)
  }
  return priority
}

export function createProposalCard(state: SuperTabState, project: SwarmProject, sender: ProposalSender,
  input: Omit<CreateProposal, 'type' | 'projectId'>, id: string, now: number): Conversation {
  requireBoard(project)
  const member = state.people.find(p => p.id === sender.personId && p.generation === sender.generation)
  if (!member || !canReadProject(state, { kind: 'person', userId: member.id, email: member.email }, project)) fail('NOT_FOUND', 'This project is unavailable.', 404)
  const parsed = proposalCreateSchema.parse({ type: 'proposal.create', projectId: project.id, ...input })
  const priority = cardPriority(state, project, member.id, input.priority)
  const leadId = state.conversations.find(c => c.id === project.leadConversationId)?.leadId ?? null
  const number = nextConversationNumber(state)
  state.groupCounter = number
  const card: Conversation = { id, number, projectId: project.id, title: input.title, leadId, agentIds: leadId ? [leadId] : [],
    archived: false, brief: input.text, checks: [], assignment: null, lastMessageSequence: 0, lastActivityAt: new Date(now).toISOString(),
    requesterId: member.id, priority, codePullRequestUrls: [],
    proposal: { version: 1, text: parsed.text, goal: parsed.goal, why: parsed.why, doneWhen: parsed.doneWhen,
      evidence: parsed.evidence, priority, createdAt: now, senders: [sender], questions: [] } }
  state.conversations.push(card)
  return card
}
export function authorizePersonProposal(state: SuperTabState, actor: Actor, input: CreateProposal): void {
  if (actor.kind !== 'person') fail('PROPOSAL_PERSON', 'A person proposes from the Board; a Buddy uses buddy.propose with their consent.', 403)
  const project = readProject(state, actor, input.projectId)
  requireBoard(project)
  cardPriority(state, project, actor.userId, input.priority)
}
export function createPersonProposal(state: SuperTabState, actor: Actor, input: CreateProposal, id: string, now: number): Conversation {
  if (actor.kind !== 'person') fail('PROPOSAL_PERSON', 'A person proposes from the Board; a Buddy uses buddy.propose with their consent.', 403)
  authorizePersonProposal(state, actor, input)
  const member = person(state, actor.userId), project = readProject(state, actor, input.projectId)
  return createProposalCard(state, project, { personId: member.id, generation: member.generation }, input, id, now)
}
export function proposalRoot(state: SuperTabState, card: Conversation, id: string, sender: Author): MessageDraft {
  return { id, conversationId: card.id, author: sender, text: card.proposal!.text, replyTo: null,
    recipients: card.leadId ? [card.leadId] : [], source: { kind: 'proposal-card', priority: card.priority } }
}
export const legacyProposalId = (projectId: string, messageId: string): string => stableId('legacy-proposal', projectId, messageId)
export interface LegacyProposalAsk { messageId: string; conversationId: string; personId: string; text: string; at: number }
/** Caller loads this stable id (including dormant cards) before importing; no scan or second interpretation of consent. */
export function importLegacyProposal(state: SuperTabState, project: SwarmProject, ask: LegacyProposalAsk, now: number): string {
  requireBoard(project)
  const id = legacyProposalId(project.id, ask.messageId)
  if (state.conversations.some(c => c.id === id)) return id
  const member = person(state, ask.personId)
  const card = createProposalCard(state, project, { personId: member.id, generation: member.generation }, {
    title: ask.text.trim().slice(0, 160) || 'Earlier request', text: ask.text, goal: ask.text,
    why: 'Imported unanswered request; details remain to be clarified.', doneWhen: 'To be clarified on this card.',
    evidence: ['Original project message'], priority: 'P2',
  }, id, now)
  card.proposal!.legacyMessageId = ask.messageId
  card.proposal!.createdAt = ask.at
  return id
}
