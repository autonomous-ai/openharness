/** A person's decisions (design: decisions in one place). The Lead, or a worker on its own task through needs_human, asks
 *  one person a batch of questions, each with options, a recommendation and what it unblocks; the person answers each
 *  with one tap, and the answer reaches the asking agent and the Lead in the conversation it came from. Decisions live in
 *  SuperTabDecision, never in the tab state, as mentions do. A decision is not a private channel: anything private goes
 *  through Chat with PM. Called inside SuperTabStore's transactions. */
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { fail, isLeads, person, stableId, type Actor, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, ledProject, projectOf } from './projects.js'

type Tx = Prisma.TransactionClient
export const MAX_QUESTIONS = 10

const line = (max: number) => z.string().trim().min(1).max(max)
/** What a question offers besides itself: 2–5 distinct options, the index of the recommended one, and what an answer unblocks. */
export const decisionChoices = z.object({ options: z.array(line(200)).min(2).max(5).refine(o => new Set(o).size === o.length, 'Give distinct options.'),
  recommended: z.number().int().min(0), unblocks: line(300) }).strict()
export const decisionQuestion = decisionChoices.extend({ question: line(1000) }).strict()
type Question = z.infer<typeof decisionQuestion>

/** A decision as asked, written by the store. */
export interface DecisionDraft extends Question {
  id: string; batchId: string; conversationId: string; projectId: string; personId: string; askerAgentId: string; assignmentId: string | null
}
/** The decision `decision.answer` names, read from SuperTabDecision by the store. */
export interface DecisionTarget {
  id: string; personId: string; conversationId: string; askerAgentId: string; question: string; options: string[]; answeredAt: number | null
}
export interface DecisionAnswer { id: string; choice: number; note: string | null }

/** Questions for one person in one conversation they read, from `asker`. One batch: one id ties them, no ping per question. */
export function askDecisions(state: SuperTabState, group: Conversation, personId: string, questions: Question[],
  from: { operationId: string; askerAgentId: string; assignmentId: string | null }): DecisionDraft[] {
  const asked = state.people.find(p => p.id === personId) ?? fail('INVALID_PERSON', 'Ask a person in this Swarm.', 400)
  if (!canReadGroup(state, { kind: 'person', userId: asked.id, email: asked.email }, group)) {
    fail('INVALID_PERSON', `${asked.email} cannot read this conversation.`, 400)
  }
  for (const q of questions) if (q.recommended >= q.options.length) fail('INVALID_DECISION', 'A question must recommend one of its options.', 400)
  const projectId = groupProject(state, group).id
  return questions.map((q, index) => ({ ...q, id: stableId(from.operationId, 'decision', String(index)), batchId: from.operationId,
    conversationId: group.id, projectId, personId, askerAgentId: from.askerAgentId, assignmentId: from.assignmentId }))
}

/** Only the project's Lead asks with `decision.ask`, in its own project's conversations (a worker asks through needs_human). */
export function checkAsker(state: SuperTabState, actor: Actor, group: Conversation): string {
  const led = actor.kind === 'agent' ? ledProject(state, actor.agentId) : undefined
  if (!led || isLeads(group) || groupProject(state, group).id !== led.id) {
    fail('DECISION_FORBIDDEN', 'Only a project’s Lead asks for decisions in its own project’s conversations.', 403)
  }
  return (actor as Extract<Actor, { kind: 'agent' }>).agentId
}

/** The asked person's one answer, and the row that tells the asking agent and the Lead, whichever of them is still there. */
export function answerDecision(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined, choice: number, note: string | null) {
  if (actor.kind !== 'person' || !decision || decision.personId !== actor.userId) fail('NOT_FOUND', 'This decision is unavailable.', 404)
  if (decision.answeredAt !== null) fail('DECISION_ANSWERED', 'This decision is already answered.')
  const option = decision.options[choice] ?? fail('INVALID_DECISION', 'Choose one of its options.', 400)
  const group = state.conversations.find(c => c.id === decision.conversationId)
  const lead = group ? state.conversations.find(c => c.id === groupProject(state, group).leadConversationId)?.leadId : null
  const recipients = group ? [...new Set([decision.askerAgentId, ...lead ? [lead] : []])].filter(id => group.agentIds.includes(id)) : []
  const text = `${person(state, actor.userId).email} decided: ${option}\n\n${decision.question}${note ? `\n\n${note}` : ''}`
  return { answer: { id: decision.id, choice, note }, recipients, text }
}

/** Mongo omits unset fields, so `answeredAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabDecisionWhereInput = { OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] }

export async function writeDecisions(tx: Tx, tabId: string, drafts: DecisionDraft[], now: number): Promise<void> {
  if (drafts.length) await tx.superTabDecision.createMany({ data: drafts.map(d => ({ ...d, tabId, createdAt: new Date(now) })) })
}

export async function readAskedDecision(tx: Tx, tabId: string, id: string): Promise<DecisionTarget | undefined> {
  const row = await tx.superTabDecision.findFirst({ where: { id, tabId },
    select: { id: true, personId: true, conversationId: true, askerAgentId: true, question: true, options: true, answeredAt: true } })
  return row ? { ...row, answeredAt: row.answeredAt?.getTime() ?? null } : undefined
}

/** Conflicts with a concurrent answer of the same decision: only the first one counts. */
export async function recordAnswer(tx: Tx, tabId: string, answer: DecisionAnswer, now: number): Promise<void> {
  const taken = await tx.superTabDecision.updateMany({ where: { id: answer.id, tabId, ...waiting },
    data: { choice: answer.choice, note: answer.note, answeredAt: new Date(now) } })
  if (!taken.count) fail('DECISION_ANSWERED', 'This decision is already answered.')
}

/** Whose decisions a reader sees: a person, those asked of them in conversations they still read; an agent, those it asked,
 *  and a Lead also those asked in its project. Nobody else, owners included. */
function readerWhere(state: SuperTabState, actor: Actor): Prisma.SuperTabDecisionWhereInput {
  if (actor.kind === 'person') return { personId: person(state, actor.userId).id }
  const led = ledProject(state, actor.agentId)
  return { OR: [{ askerAgentId: actor.agentId }, ...led ? [{ projectId: led.id }] : []] }
}

/** ponytail: capped at 200 per state, newest first; page it if a reader ever has more. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, open: boolean) {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, AND: [readerWhere(state, actor), open ? waiting : { answeredAt: { not: null } }] },
    orderBy: { createdAt: 'desc' }, take: 200 })
  return rows.filter(row => {
    const group = state.conversations.find(c => c.id === row.conversationId)
    return !!group && (actor.kind === 'agent' || canReadGroup(state, actor, group))
  })
}

/** The conversations a person's open decisions were asked in: a light change read loads them to count those decisions. */
export async function decisionConversations(tx: Tx, tabId: string, personId: string): Promise<string[]> {
  return (await tx.superTabDecision.findMany({ where: { tabId, personId, ...waiting }, select: { conversationId: true },
    distinct: ['conversationId'] })).map(d => d.conversationId)
}

export async function decisionsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>): Promise<number> {
  return (await readable(tx, tabId, state, actor, true)).length
}

export async function listDecisions(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, open: boolean) {
  const rows = await readable(tx, tabId, state, actor, open)
  return rows.map(row => {
    const group = state.conversations.find(c => c.id === row.conversationId)!
    const asker = state.agents.find(a => a.id === row.askerAgentId)
    return { id: row.id, batchId: row.batchId, projectId: row.projectId, projectName: projectOf(state, row.projectId).name,
      conversationId: row.conversationId, conversationTitle: group.title, assignmentId: row.assignmentId ?? null,
      personId: row.personId, personEmail: state.people.find(p => p.id === row.personId)?.email ?? null,
      askerAgentId: row.askerAgentId, askerName: asker?.displayName ?? asker?.name ?? 'Agent',
      question: row.question, options: row.options, recommended: row.recommended, unblocks: row.unblocks,
      createdAt: row.createdAt, answeredAt: row.answeredAt ?? null, choice: row.choice ?? null, note: row.note ?? null }
  })
}
