import { reopenTaskApproval, stageTaskApproval } from './taskApproval.js'
import { steers } from './boardRights.js'
import { expireProposalQuestion } from './proposalClock.js'
export { proposalDueAt } from './proposalClock.js'
/** Durable proposal metadata lives on its existing version-guarded card. Discussion stays in message rows. */
import { z } from 'zod'
import { author, fail, nextConversationNumber, person, stableId, type Actor, type Author, type Conversation, type MessageDraft, renderWorkTask, type SuperTabState } from './model.js'
import { defaultBuddy, isBuddy } from './buddies.js'
import { recordAsked } from './leaderboard/record.js'
import { stampLane } from './dispatch.js'
import { groupProject, ledProject, readConversation, canReadProject, readProject, type SwarmProject } from './projects.js'
import { proposalPriority, type TaskPriority } from './taskPriority.js'

export interface ProposalSender { personId: string; generation: string; buddyId?: string }
export interface ProposalRecord {
  version: 1
  text: string
  goal: string
  scope?: string
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
  waitSince?: number
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
  if (priority === 'P0' && !steers(state, project, member.id)) {
    fail('PRIORITY_FORBIDDEN', 'Only the project owner, Swarm owner or top decider may propose P0 or a hotfix.', 403)
  }
  return priority
}

export function createProposalCard(state: SuperTabState, project: SwarmProject, sender: ProposalSender,
  input: Omit<CreateProposal, 'type' | 'projectId'>, id: string, now: number, legacyMirror = false): Conversation {
  if (!legacyMirror) requireBoard(project)
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
  stageTaskApproval(state, card, now)
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
export interface LegacyProposalAsk { messageId: string; conversationId: string; personId: string; text: string; at: number; generation?: string }
/** Caller loads this stable id (including dormant cards) before importing; no scan or second interpretation of consent. */
export function importLegacyProposal(state: SuperTabState, project: SwarmProject, ask: LegacyProposalAsk, now: number): string {
  requireBoard(project)
  const id = legacyProposalId(project.id, ask.messageId)
  if (state.conversations.some(c => c.id === id)) return id
  const member = person(state, ask.personId)
  const original = state.conversations.find(c => c.id === ask.conversationId)
  if (!original || original.kind || original.audience || groupProject(state, original).id !== project.id
    || (ask.generation && member.generation !== ask.generation)) fail('NOT_FOUND', 'The original request is unavailable.', 404)
  const card = createProposalCard(state, project, { personId: member.id, generation: member.generation }, {
    title: ask.text.trim().slice(0, 160) || 'Earlier request', text: ask.text, goal: ask.text.slice(0, 4000),
    why: 'Imported unanswered request; details remain to be clarified.', doneWhen: 'To be clarified on this card.',
    evidence: ['Original project message'], priority: 'P2',
  }, id, now)
  card.proposal!.legacyMessageId = ask.messageId
  card.proposal!.createdAt = ask.at
  return id
}

export const MAX_CARD_QUESTIONS = 20
export const MAX_CARD_SENDERS = 50
export type ProposalAction =
  | { type: 'proposal.decide'; conversationId: string; decision: 'accept' | 'reshape' | 'later' | 'no'; reason: string;
      task?: import('./model.js').WorkTask; checks?: Array<{ description: string; independent?: boolean }>; revisitAt?: number }
  | { type: 'proposal.ask'; conversationId: string; personId: string; question: string; defaultAnswer: string; deadline: number; requiresConsent?: boolean }
  | { type: 'proposal.answer'; conversationId: string; questionId: string; text: string }
  | { type: 'proposal.merge'; conversationId: string; intoConversationId: string; reason: string }

function namedCard(state: SuperTabState, actor: Actor, id: string): Conversation & { proposal: ProposalRecord } {
  const group = readConversation(state, actor, id)
  if (!group.proposal || group.kind || group.audience) fail('NOT_FOUND', 'This proposal is unavailable.', 404)
  return group as Conversation & { proposal: ProposalRecord }
}
function currentSender(state: SuperTabState, card: Conversation & { proposal: ProposalRecord }, personId: string): ProposalSender[] {
  const member = state.people.find(p => p.id === personId)
  return member ? card.proposal.senders.filter(s => s.personId === member.id && s.generation === member.generation) : []
}
function answerer(state: SuperTabState, actor: Actor, card: Conversation & { proposal: ProposalRecord }, questionId: string): ProposalQuestion {
  const q = card.proposal.questions.find(q => q.id === questionId) ?? fail('NOT_FOUND', 'This question is unavailable.', 404)
  const senders = currentSender(state, card, q.personId)
  const self = actor.kind === 'agent' ? state.agents.find(a => a.id === actor.agentId && isBuddy(a)) : undefined
  const own = actor.kind === 'person' ? actor.userId === q.personId : !!self && self.buddyOf!.personId === q.personId
    && senders.some(s => s.generation === self.buddyOf!.generation && (s.buddyId === self.id ||
      ((!s.buddyId || !state.agents.some(a => a.id === s.buddyId && a.buddyOf?.personId === s.personId && a.buddyOf.generation === s.generation))
        && defaultBuddy(state, s.personId)?.id === self.id)))
  if (!senders.length || !own) fail('PROPOSAL_ANSWER_FORBIDDEN', 'Only the person asked or the Buddy that sent this card may answer.', 403)
  if (q.requiresConsent && actor.kind !== 'person') fail('PROPOSAL_CONSENT_REQUIRED', 'This question needs the named person’s own agreement.', 403)
  return q
}
/** Called before receipt replay as well as apply; a recorded operation retains no revoked right. */
export function authorizeProposalAction(state: SuperTabState, actor: Actor, command: ProposalAction): void {
  const card = namedCard(state, actor, command.conversationId), project = groupProject(state, card)
  if (command.type === 'proposal.answer') { answerer(state, actor, card, command.questionId); return }
  if (actor.kind !== 'agent' || ledProject(state, actor.agentId)?.id !== project.id) fail('COORDINATOR_REQUIRED', 'Only this project’s current PM decides, asks or merges proposals.', 403)
  if (command.type === 'proposal.merge') {
    const target = namedCard(state, actor, command.intoConversationId)
    if (groupProject(state, target).id !== project.id) fail('NOT_FOUND', 'This proposal is unavailable.', 404)
  }
}

function pending(card: Conversation & { proposal: ProposalRecord }): void {
  if (card.proposal.decision || card.proposal.mergedInto) fail('PROPOSAL_DECIDED', 'This proposal already has a decision or was merged.', 409)
}
const hasOpenQuestion = (card: Conversation & { proposal: ProposalRecord }) => card.proposal.questions.some(q => !q.answer)

export function applyProposalAction(state: SuperTabState, actor: Actor, command: ProposalAction, operationId: string, now: number):
  { messages: MessageDraft[]; result: Record<string, unknown> } {
  authorizeProposalAction(state, actor, command)
  const card = namedCard(state, actor, command.conversationId), sender = author(state, actor)
  const messages: MessageDraft[] = []
  const result: Record<string, unknown> = { conversationId: card.id, messageId: operationId }
  const row = (text: string, source: Record<string, unknown>, recipients: string[] = [], id = operationId) =>
    messages.push({ id, conversationId: card.id, author: sender, text, recipients, replyTo: null, source })
  if (command.type === 'proposal.answer') {
    const q = answerer(state, actor, card, command.questionId)
    messages.push(...expireProposalQuestion(state, card, q, now))
    result.applied = !q.answer
    if (!q.answer) q.answer = { text: command.text, at: now, by: sender.id }
    row(command.text, { kind: 'proposal-answer', questionId: q.id, applied: result.applied }, card.leadId ? [card.leadId] : [])
  } else if (command.type === 'proposal.ask') {
    pending(card)
    if (!currentSender(state, card, command.personId).length) fail('PROPOSAL_ANSWER_FORBIDDEN', 'Ask a current proposer on this card.', 403)
    if (command.deadline <= now) fail('PROPOSAL_DEADLINE', 'Choose a future deadline.', 400)
    if (card.proposal.questions.length >= MAX_CARD_QUESTIONS) fail('PROPOSAL_LIMIT', 'This card has 20 questions; decide it or reshape a new proposal.', 409)
    const q: ProposalQuestion = { id: operationId, personId: command.personId, question: command.question, defaultAnswer: command.defaultAnswer,
      deadline: command.deadline, requiresConsent: command.requiresConsent ?? false }
    card.proposal.questions.push(q)
    result.questionId = q.id
    // On the card alone: no line in the proposer's private chat with their own agent (task #4558). One that needs their own
    // agreement has no default to fall back on, so it tags them there: their inbox and phone, with or without a Buddy.
    row(`${q.question}\nDefault: ${q.defaultAnswer}\nBy: ${new Date(q.deadline).toISOString()}`, { kind: 'proposal-question', questionId: q.id })
    if (q.requiresConsent) messages.at(-1)!.mentions = [q.personId]
  } else if (command.type === 'proposal.decide') {
    pending(card)
    if (hasOpenQuestion(card)) fail('PROPOSAL_QUESTION_OPEN', 'Answer the open questions before deciding.', 409)
    if (command.decision === 'later' && (!command.revisitAt || command.revisitAt <= now)) fail('PROPOSAL_DATE', 'Later needs a future revisit date.', 400)
    if (command.decision === 'accept' || command.decision === 'reshape') {
      if (!command.task || !command.checks?.length) fail('TASK_CONTRACT_MISSING', 'Accepted work needs its task and done-when checks.', 400)
      card.task = command.task
      card.brief = renderWorkTask(command.task)
      card.briefAt = now
      card.checks = command.checks.map((check, i) => ({ id: stableId(operationId, 'check', String(i)), description: check.description, independent: check.independent ?? false, evidence: null, passedBy: null }))
      stampLane(card)
      recordAsked(card, card.requesterId, now)
      // The person approves the task the PM shaped: an approval stored before this decision never carries over.
      reopenTaskApproval(card)
    }
    card.proposal.decision = { kind: command.decision, reason: command.reason, at: now, by: sender.id,
      ...(command.decision === 'later' ? { revisitAt: command.revisitAt } : {}) }
    delete card.proposal.overdue
    if (command.decision === 'no') card.archived = true
    row(`${command.decision}: ${command.reason}`, { kind: 'proposal-decision', decision: command.decision })
  } else {
    if (card.taskApproval) fail('TASK_APPROVAL_REQUIRED', 'Keep Review proposals separate so each person’s decision and chosen agent stay attached.', 409)
    pending(card)
    const target = namedCard(state, actor, command.intoConversationId)
    if (target.taskApproval) fail('TASK_APPROVAL_REQUIRED', 'Keep Review proposals separate so each person’s decision and chosen agent stay attached.', 409)
    pending(target)
    if (target.id === card.id) fail('PROPOSAL_MERGE_SELF', 'Merge another proposal into this card.', 400)
    if (hasOpenQuestion(card)) fail('PROPOSAL_QUESTION_OPEN', 'Answer the source card’s questions before merging.', 409)
    const senders = [...target.proposal.senders, ...card.proposal.senders].filter((s, i, all) =>
      all.findIndex(p => p.personId === s.personId && p.generation === s.generation && p.buddyId === s.buddyId) === i)
    const mergedFrom = [...new Set([...target.proposal.mergedFrom ?? [], card.id, ...card.proposal.mergedFrom ?? []])]
    if (senders.length > MAX_CARD_SENDERS || mergedFrom.length > MAX_CARD_SENDERS) fail('PROPOSAL_LIMIT', 'A combined card holds at most 50 senders and merged cards.', 409)
    for (const id of card.proposal.mergedFrom ?? []) {
      const child = namedCard(state, actor, id)
      if (child.proposal.mergedInto !== card.id) fail('PROPOSAL_MERGE_STALE', 'A merged card changed; read the cards again.', 409)
      child.proposal.mergedInto = target.id
    }
    target.proposal.senders = senders
    target.proposal.mergedFrom = mergedFrom
    card.proposal.mergedInto = target.id
    card.archived = true
    row(`Merged into #${target.number}: ${command.reason}`, { kind: 'proposal-merged', intoConversationId: target.id })
    messages.push({ id: stableId(operationId, 'merge-target'), conversationId: target.id, author: sender, text: `Merged #${card.number}: ${command.reason}`,
      recipients: target.leadId ? [target.leadId] : [], replyTo: null, source: { kind: 'proposal-merged' } })
    result.conversationId = target.id
  }
  return { messages, result }
}

/** Server-written sources are the only notices. A raw chat line never enters a switched PM's delivery queue. */
export function pmAcceptsMessage(state: SuperTabState, recipientId: string, source: unknown): boolean {
  const project = ledProject(state, recipientId)
  return !project?.boardMode || !!source && typeof source === 'object' && typeof (source as { kind?: unknown }).kind === 'string'
}

/** Verified originals are supplied by the store in bounded primary-key batches. Keep every other ask owed. */
export function migrateLegacyProposals(state: SuperTabState, project: SwarmProject, originals: LegacyProposalAsk[], now: number): MessageDraft[] {
  const messages: MessageDraft[] = []
  for (const ask of originals) {
    const id = legacyProposalId(project.id, ask.messageId)
    const existed = state.conversations.some(c => c.id === id)
    importLegacyProposal(state, project, ask, now)
    if (!existed) {
      const card = state.conversations.find(c => c.id === id)!
      messages.push(proposalRoot(state, card, stableId(id, 'root'), author(state, { kind: 'person', userId: ask.personId, email: '' })))
    }
    const original = state.conversations.find(c => c.id === ask.conversationId)!
    original.owed = (original.owed ?? []).filter(a => a.id !== ask.messageId)
    if (!original.owed.length) delete original.owed
  }
  return messages
}
