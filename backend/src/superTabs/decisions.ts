/** A person's decisions (design: decisions in one place). The Lead, or a worker on its own task through needs_human, asks
 *  one person a batch of questions, each with options, a recommendation and what it unblocks; the person answers each
 *  with one tap, and the answer reaches the asking agent and the Lead in the conversation it came from. Decisions live in
 *  SuperTabDecision, never in the tab state, as mentions do. A decision is not a private channel: anything private goes
 *  through Chat with PM. Called inside SuperTabStore's transactions. */
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { activeWork, AGENT_ONLY, fail, isLeads, person, stableId, type Actor, type Agent, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import type { PersonSignal } from './signals.js'
import { canReadGroup, groupProject, ledProject, projectOf, projectsOf } from './projects.js'

type Tx = Prisma.TransactionClient
export const MAX_QUESTIONS = 10

const line = (max: number) => z.string().trim().min(1).max(max)
/** What a question offers besides itself: 2–5 distinct options, the index of the recommended one, and what an answer unblocks. */
export const decisionChoices = z.object({ options: z.array(line(200)).min(2).max(5).refine(o => new Set(o).size === o.length, 'Give distinct options.'),
  recommended: z.number().int().min(0), unblocks: line(300) }).strict()
export const decisionQuestion = decisionChoices.extend({ question: line(1000) }).strict()
type Question = z.infer<typeof decisionQuestion>

/** A hands-on request (collaboration protocol): physical steps, a sign-in or an approval only that person can do, and what
 *  the agent does next. Kept in SuperTabDecision as kind 'handsOn': the request in `question`, what happens next in
 *  `unblocks`, no options. */
export const handsOnRequest = z.object({ request: line(300), steps: z.array(line(300)).min(1).max(10), next: line(300) }).strict()
export type HandsOnAnswerKind = 'done' | 'cant' | 'note'

/** A decision or a hands-on request as asked, written by the store. */
export interface DecisionDraft extends Question {
  id: string; batchId: string; conversationId: string; projectId: string; personId: string; askerAgentId: string; assignmentId: string | null
  kind?: 'handsOn'; steps?: string[]
}
/** The decision `decision.answer` or the request `handsOn.answer` names, read from SuperTabDecision by the store. */
export interface DecisionTarget {
  id: string; kind?: 'handsOn'; personId: string; conversationId: string; askerAgentId: string; question: string; options: string[]; answeredAt: number | null
}
export interface DecisionAnswer { id: string; choice: number; note: string | null }
export interface HandsOnAnswer { id: string; answer: HandsOnAnswerKind; note: string | null; until: number | null }

/** Questions for one person in one conversation they read, from `asker`. One batch: one id ties them, no ping per question. */
export function askDecisions(state: SuperTabState, group: Conversation, personId: string, questions: Question[],
  from: { operationId: string; askerAgentId: string; assignmentId: string | null }): DecisionDraft[] {
  for (const q of questions) if (q.recommended >= q.options.length) fail('INVALID_DECISION', 'A question must recommend one of its options.', 400)
  return drafts(state, group, personId, questions, from)
}

function drafts(state: SuperTabState, group: Conversation, personId: string, questions: Question[],
  from: { operationId: string; askerAgentId: string; assignmentId: string | null }): DecisionDraft[] {
  const asked = state.people.find(p => p.id === personId) ?? fail('INVALID_PERSON', 'Ask a person in this Swarm.', 400)
  if (!canReadGroup(state, { kind: 'person', userId: asked.id, email: asked.email }, group)) {
    fail('INVALID_PERSON', `${asked.email} cannot read this conversation.`, 400)
  }
  const projectId = groupProject(state, group).id
  return questions.map((q, index) => ({ ...q, id: stableId(from.operationId, 'decision', String(index)), batchId: from.operationId,
    conversationId: group.id, projectId, personId, askerAgentId: from.askerAgentId, assignmentId: from.assignmentId }))
}

/** One hands-on request for one person in one conversation they read. */
export function askHandsOn(state: SuperTabState, group: Conversation, personId: string, request: z.infer<typeof handsOnRequest>,
  from: { operationId: string; askerAgentId: string; assignmentId: string | null }): DecisionDraft {
  const [draft] = drafts(state, group, personId, [{ question: request.request, options: [], recommended: 0, unblocks: request.next }], from)
  return { ...draft!, kind: 'handsOn', steps: request.steps }
}

/** The project's Lead in its own project's conversations, or the worker on its own active task there, asks for hands-on help. */
export function checkHandsOnAsker(state: SuperTabState, actor: Actor, group: Conversation): { askerAgentId: string; assignmentId: string | null } {
  if (actor.kind === 'agent' && !isLeads(group)) {
    const led = ledProject(state, actor.agentId)
    if (led && groupProject(state, group).id === led.id) return { askerAgentId: actor.agentId, assignmentId: null }
    if (activeWork(group) && group.assignment!.agentId === actor.agentId) return { askerAgentId: actor.agentId, assignmentId: group.assignment!.id }
  }
  fail('HANDS_ON_FORBIDDEN', 'Only the project’s Lead, or the worker on its own task, asks for hands-on help.', 403)
}

/** Only the project's Lead asks with `decision.ask`, in its own project's conversations (a worker asks through needs_human). */
export function checkAsker(state: SuperTabState, actor: Actor, group: Conversation): string {
  const led = actor.kind === 'agent' ? ledProject(state, actor.agentId) : undefined
  if (!led || isLeads(group) || groupProject(state, group).id !== led.id) {
    fail('DECISION_FORBIDDEN', 'Only a project’s Lead asks for decisions in its own project’s conversations.', 403)
  }
  return (actor as Extract<Actor, { kind: 'agent' }>).agentId
}

/** The conversation a decision was asked in, while the person asked is still in the Swarm and still reads it: checked on
 *  every answer and on every retry of one (review of #1753). Anyone else is told it does not exist. */
export function answerable(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined, kind?: 'handsOn'): Conversation {
  const asked = actor.kind === 'person' && decision?.personId === actor.userId && decision.kind === kind && state.people.some(p => p.id === actor.userId)
  const group = asked ? state.conversations.find(c => c.id === decision.conversationId) : undefined
  if (!group || !canReadGroup(state, actor, group)) fail('NOT_FOUND', 'This decision is unavailable.', 404)
  return group
}

/** What tells the asking agent and the Lead, whichever of them is still in the conversation. A notice only they read, with
 *  none of the answer in it: the decisions read, which checks who reads it, has the answer (review of #1753). */
export const ANSWERED_NOTICE = 'A decision asked in this conversation was answered. Read the answer with: harness super-tab decisions --answered'

/** Whoever of the asking agent and the Lead is still in the conversation. */
function askerAndLead(state: SuperTabState, group: Conversation, decision: DecisionTarget): string[] {
  const lead = state.conversations.find(c => c.id === groupProject(state, group).leadConversationId)?.leadId
  return [...new Set([decision.askerAgentId, ...lead ? [lead] : []])].filter(id => group.agentIds.includes(id))
}

/** The asked person's one answer, and the notice for the asking agent and the Lead. */
export function answerDecision(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined, choice: number, note: string | null) {
  const group = answerable(state, actor, decision)
  if (decision!.answeredAt !== null) fail('DECISION_ANSWERED', 'This decision is already answered.')
  if (choice >= decision!.options.length) fail('INVALID_DECISION', 'Choose one of its options.', 400)
  return { answer: { id: decision!.id, choice, note }, recipients: askerAndLead(state, group, decision!), source: { ...AGENT_ONLY, decisionId: decision!.id } }
}

/** What tells the asking agent and the Lead that a hands-on request was answered; like ANSWERED_NOTICE, none of the answer. */
export const HANDS_ON_NOTICE = 'A hands-on request asked in this conversation was answered. Read the answer with: harness super-tab decisions --hands-on --answered'

/** The asked person's one answer to a hands-on request: done, can't now (until a time, with a note), or a note. */
export function answerHandsOn(state: SuperTabState, actor: Actor, request: DecisionTarget | undefined, answer: HandsOnAnswerKind,
  note: string | null, until: string | null) {
  const group = answerable(state, actor, request, 'handsOn')
  if (request!.answeredAt !== null) fail('DECISION_ANSWERED', 'This request is already answered.')
  if (answer === 'note' && !note) fail('INVALID_ANSWER', 'Write the note.', 400)
  if (until && answer !== 'cant') fail('INVALID_ANSWER', 'Only “can’t now” takes an until.', 400)
  return { answer: { id: request!.id, answer, note, until: until ? Date.parse(until) : null }, recipients: askerAndLead(state, group, request!),
    source: { ...AGENT_ONLY, handsOnId: request!.id } }
}

/** Mongo omits unset fields, so `answeredAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabDecisionWhereInput = { OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] }

/** What makes an ask a repeat: the same asker, task, person, conversation, question, options, recommendation and what it
 *  unblocks. Another asker, another task or other options with the same text is a decision of its own (review of #1753). */
const repeatKey = (d: Pick<DecisionDraft, 'askerAgentId' | 'assignmentId' | 'personId' | 'conversationId' | 'question' | 'options' | 'recommended' | 'unblocks'>
  & { kind?: string | null; steps?: string[] }) =>
  JSON.stringify([d.askerAgentId, d.assignmentId ?? null, d.personId, d.conversationId, d.question, d.options, d.recommended, d.unblocks,
    d.kind ?? null, d.steps ?? []])

/** Writes the questions asked and returns the decision each one is: an open decision that this ask exactly repeats is that
 *  decision again, not a second one. Read and written in the command's transaction; two identical asks committing at the
 *  same moment can still both be written. */
export async function writeDecisions(tx: Tx, tabId: string, drafts: DecisionDraft[], now: number): Promise<string[]> {
  if (!drafts.length) return []
  const open = await tx.superTabDecision.findMany({ where: { tabId, personId: drafts[0]!.personId, conversationId: drafts[0]!.conversationId,
    askerAgentId: drafts[0]!.askerAgentId, question: { in: drafts.map(d => d.question) }, ...waiting } })
  const held = new Map(open.map(o => [repeatKey(o), o.id]))
  const fresh = drafts.filter(d => !held.has(repeatKey(d)))
  if (fresh.length) await tx.superTabDecision.createMany({ data: fresh.map(d => ({ ...d, tabId, createdAt: new Date(now) })) })
  return drafts.map(d => held.get(repeatKey(d)) ?? d.id)
}

export async function readAskedDecision(tx: Tx, tabId: string, id: string): Promise<DecisionTarget | undefined> {
  const row = await tx.superTabDecision.findFirst({ where: { id, tabId },
    select: { id: true, kind: true, personId: true, conversationId: true, askerAgentId: true, question: true, options: true, answeredAt: true } })
  if (!row) return undefined
  const { kind, ...rest } = row
  return { ...rest, ...kind === 'handsOn' ? { kind } : {}, answeredAt: row.answeredAt?.getTime() ?? null }
}

/** Conflicts with a concurrent answer of the same decision: only the first one counts. */
export async function recordAnswer(tx: Tx, tabId: string, answer: DecisionAnswer, now: number): Promise<void> {
  const taken = await tx.superTabDecision.updateMany({ where: { id: answer.id, tabId, ...waiting },
    data: { choice: answer.choice, note: answer.note, answeredAt: new Date(now) } })
  if (!taken.count) fail('DECISION_ANSWERED', 'This decision is already answered.')
}

/** Conflicts with a concurrent answer of the same request, as a decision's does. */
export async function recordHandsOnAnswer(tx: Tx, tabId: string, answer: HandsOnAnswer, now: number): Promise<void> {
  const taken = await tx.superTabDecision.updateMany({ where: { id: answer.id, tabId, kind: 'handsOn', ...waiting },
    data: { answer: answer.answer, note: answer.note, until: answer.until === null ? null : new Date(answer.until), answeredAt: new Date(now) } })
  if (!taken.count) fail('DECISION_ANSWERED', 'This request is already answered.')
}

export type RequestKind = 'decision' | 'handsOn'
/** Rows of one kind: a decision is any row without the hands-on kind, written before or after it existed. */
const ofKind = (kind: RequestKind): Prisma.SuperTabDecisionWhereInput => kind === 'handsOn' ? { kind: 'handsOn' }
  : { OR: [{ kind: null }, { kind: { isSet: false } }] }

/** Whose decisions a reader sees: a person, those asked of them in conversations they still read; an agent, those it asked,
 *  and a Lead also those asked in its project. Nobody else, owners included. */
function readerWhere(state: SuperTabState, actor: Actor): Prisma.SuperTabDecisionWhereInput {
  if (actor.kind === 'person') return { personId: person(state, actor.userId).id }
  const led = ledProject(state, actor.agentId)
  return { OR: [{ askerAgentId: actor.agentId }, ...led ? [{ projectId: led.id }] : []] }
}

/** The conversations [ids] names: those the read loaded, and the rest (quiet, archived, or left out of a light read) read
 *  here, so a decision in one still counts. A deleted conversation is none. */
async function conversationsOf(tx: Tx, tabId: string, state: SuperTabState, ids: string[]): Promise<Map<string, Conversation>> {
  const found = new Map(state.conversations.filter(c => ids.includes(c.id)).map(c => [c.id, c]))
  const missing = [...new Set(ids.filter(id => !found.has(id)))]
  if (missing.length) {
    for (const row of await tx.swarmGroup.findMany({ where: { tabId, key: { in: missing }, deleted: false }, select: { key: true, data: true } })) {
      found.set(row.key, row.data as unknown as Conversation)
    }
  }
  return found
}

/** ponytail: capped at 200 per state, newest first; page it if a reader ever has more. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, open: boolean, kind?: RequestKind) {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, AND: [readerWhere(state, actor), open ? waiting : { answeredAt: { not: null } },
    ...kind ? [ofKind(kind)] : []] },
    orderBy: { createdAt: 'desc' }, take: 200 })
  const groups = await conversationsOf(tx, tabId, state, rows.map(r => r.conversationId))
  return rows.flatMap(row => {
    const group = groups.get(row.conversationId)
    // Checked at every read, for agents too: a reader who can no longer read the conversation no longer reads its decisions.
    return group && canReadGroup(state, actor, group) ? [{ row, group }] : []
  })
}

/** How many of a project's open decisions wait in each conversation for each person, for its digest (digest.ts
 *  decisionLines): never what they ask. Counted by the database, so every one counts, however many there are, and private
 *  ones filtered out later never crowd out shared ones (review of #1772). Hands-on requests are not decisions. */
export async function waitingInProject(tx: Tx, tabId: string, projectId: string): Promise<Array<{ conversationId: string; personId: string; count: number }>> {
  const groups = await tx.superTabDecision.groupBy({ by: ['conversationId', 'personId'], where: { tabId, projectId, AND: [waiting, ofKind('decision')] }, _count: { _all: true } })
  return groups.map(g => ({ conversationId: g.conversationId, personId: g.personId, count: g._count._all }))
}

/** A person's badge: their open decisions and hands-on requests, counted apart (an older Desktop counts decisions alone), and
 *  when the latest open one was reminded (escalation), so a client sees a reminder though no count moved. Counted
 *  exactly per kind over the conversations the person still reads, with no page between them, so neither kind crowds the
 *  other out (review of #1769). */
export async function requestsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>) {
  const open: Prisma.SuperTabDecisionWhereInput = { tabId, AND: [readerWhere(state, actor), waiting] }
  const ids = (await tx.superTabDecision.findMany({ where: open, distinct: ['conversationId'], select: { conversationId: true } })).map(r => r.conversationId)
  const groups = await conversationsOf(tx, tabId, state, ids)
  const where = { ...open, conversationId: { in: ids.filter(id => { const group = groups.get(id); return !!group && canReadGroup(state, actor, group) }) } }
  const all = await tx.superTabDecision.count({ where })
  const handsOn = await tx.superTabDecision.count({ where: { ...where, kind: 'handsOn' } })
  const latest = await tx.superTabDecision.findFirst({ where: { ...where, remindedAt: { not: null } }, orderBy: { remindedAt: 'desc' }, select: { remindedAt: true } })
  return { decisionsWaiting: all - handsOn, handsOnWaiting: handsOn, ...latest?.remindedAt ? { remindedAt: latest.remindedAt.getTime() } : {} }
}

export async function listDecisions(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, open: boolean, kind: RequestKind = 'decision') {
  return (await readable(tx, tabId, state, actor, open, kind)).map(({ row, group }) => {
    const asker = state.agents.find(a => a.id === row.askerAgentId)
    const common = { id: row.id, projectId: row.projectId, projectName: projectOf(state, row.projectId).name,
      conversationId: row.conversationId, conversationTitle: group.title, assignmentId: row.assignmentId ?? null,
      personId: row.personId, personEmail: state.people.find(p => p.id === row.personId)?.email ?? null,
      askerAgentId: row.askerAgentId, askerName: asker?.displayName ?? asker?.name ?? 'Agent',
      createdAt: row.createdAt, remindedAt: row.remindedAt ?? null, answeredAt: row.answeredAt ?? null, note: row.note ?? null }
    if (kind === 'handsOn') {
      return { ...common, kind: 'handsOn' as const, request: row.question, steps: row.steps, next: row.unblocks,
        answer: row.answer ?? null, until: row.until ?? null }
    }
    return { ...common, batchId: row.batchId, question: row.question, options: row.options, recommended: row.recommended, unblocks: row.unblocks,
      choice: row.choice ?? null }
  })
}

/** Escalation by time (collaboration protocol): an open request reminds its person after 30 minutes, and tells the Lead after
 *  2 hours to ask someone else or go on with the recommendation. */
export const REMIND_AFTER_MS = 30 * 60_000
export const ESCALATE_AFTER_MS = 2 * 60 * 60_000
const unset = (field: 'remindedAt' | 'escalatedAt'): Prisma.SuperTabDecisionWhereInput => ({ OR: [{ [field]: null }, { [field]: { isSet: false } }] })

/** The escalations due now, each recorded on its request by a write that only one sweep wins, so a restarted server or two
 *  sweeps at once never remind or tell twice. Run with the liveness time checks, in their transaction; the reminders are for
 *  the device hook once it commits. ponytail: 200 due requests per sweep; the rest wait for the next one. */
export async function sweepRequests(tx: Tx, tabId: string, state: SuperTabState, now: number,
  writer: (lead: Agent) => Author): Promise<{ messages: MessageDraft[]; signals: PersonSignal[] }> {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, AND: [waiting, { createdAt: { lte: new Date(now - REMIND_AFTER_MS) } },
    { OR: [unset('remindedAt'), { AND: [unset('escalatedAt'), { createdAt: { lte: new Date(now - ESCALATE_AFTER_MS) } }] }] }] },
    orderBy: { createdAt: 'asc' }, take: 200 })
  const groups = await conversationsOf(tx, tabId, state, rows.map(r => r.conversationId))
  const claim = async (id: string, field: 'remindedAt' | 'escalatedAt') =>
    (await tx.superTabDecision.updateMany({ where: { id, tabId, AND: [waiting, unset(field)] }, data: { [field]: new Date(now) } })).count === 1
  const messages: MessageDraft[] = [], signals: PersonSignal[] = []
  for (const row of rows) {
    const kind = row.kind === 'handsOn' ? 'handsOn' as const : 'decision' as const
    const group = groups.get(row.conversationId)
    if (!row.remindedAt && await claim(row.id, 'remindedAt')) {
      const asked = state.people.find(p => p.id === row.personId)
      if (asked && group && canReadGroup(state, { kind: 'person', userId: asked.id, email: asked.email }, group)) {
        signals.push({ tabId, personId: asked.id, requestId: row.id, kind, reason: 'reminder' })
      }
    }
    if (row.createdAt.getTime() > now - ESCALATE_AFTER_MS || row.escalatedAt) continue
    const project = projectsOf(state).find(p => p.id === row.projectId)
    const lead = project && state.agents.find(a => a.id === state.conversations.find(c => c.id === project.leadConversationId)?.leadId)
    // Told where it was asked when the Lead is there and that conversation is loaded to write in; else in the Lead's own.
    const home = state.conversations.find(c => c.id === row.conversationId && lead && c.agentIds.includes(lead.id))
      ?? state.conversations.find(c => c.id === project?.leadConversationId)
    if (!lead || !home || !await claim(row.id, 'escalatedAt')) continue
    const what = kind === 'handsOn' ? 'A hands-on request' : 'A decision'
    const where = home.id === row.conversationId ? 'here' : `in “${group?.title ?? 'a conversation'}”`
    messages.push({ id: stableId('request-escalated', row.id), conversationId: home.id, author: writer(lead), replyTo: null, recipients: [lead.id],
      source: { ...AGENT_ONLY, escalated: row.id },
      text: `${what} asked ${where} 2 hours ago is still unanswered. Ask someone else, or go on with your recommendation. `
        + `Read it with: harness super-tab decisions${kind === 'handsOn' ? ' --hands-on' : ''}` })
  }
  return { messages, signals }
}

/** Who a group waits on (collaboration protocol): the people with an open decision or hands-on request there, oldest first,
 *  recorded on the group so a phone or Desktop alerts only them rather than the project's owner. Recomputed from the open
 *  requests in the command's transaction, with the ones this command asks and without the one it answers. */
export async function noteAsked(tx: Tx, tabId: string, state: SuperTabState, conversationId: string, asked: DecisionDraft[], answeredId?: string): Promise<void> {
  const group = state.conversations.find(c => c.id === conversationId)
  if (!group) return
  // Every person with an open request, however many requests one person has (review of #1769), ordered by their oldest.
  const where: Prisma.SuperTabDecisionWhereInput = { tabId, conversationId, ...waiting, ...answeredId ? { id: { not: answeredId } } : {} }
  const ids = (await tx.superTabDecision.findMany({ where, distinct: ['personId'], select: { personId: true } })).map(r => r.personId)
  const oldest = new Map<string, number>()
  for (const personId of ids) {
    const first = await tx.superTabDecision.findFirst({ where: { ...where, personId }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
    if (first) oldest.set(personId, first.createdAt.getTime())
  }
  const open = [...oldest].sort((a, b) => a[1] - b[1]).map(([personId]) => personId)
  const people = [...new Set([...open, ...asked.map(d => d.personId)])]
  if (people.length) group.askedPersonIds = people
  else delete group.askedPersonIds
}
