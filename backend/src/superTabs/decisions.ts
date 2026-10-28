/** A person's decisions (design: decisions in one place). The Lead, or a worker on its own task through needs_human, asks
 *  one person a batch of questions, each with options, a recommendation and what it unblocks; the person answers each
 *  with one tap, and the answer reaches the asking agent and the Lead in the conversation it came from. Decisions live in
 *  SuperTabDecision, never in the tab state, as mentions do. A decision is not a private channel: anything private goes
 *  through Chat with PM. Called inside SuperTabStore's transactions. */
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { agentDisplayName } from './agentNames.js'
import { AGENT_ONLY, fail, isLeads, person, stableId, type Actor, type Author, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, ledProject, projectOf } from './projects.js'
import { LEDGER_WEEKS } from './leaderboard/record.js'
import { WEEK_MS } from './leaderboard/week.js'
import { groupsBy } from './parts/indexed.js'

type Tx = Prisma.TransactionClient
export const MAX_QUESTIONS = 10
/** Open decisions one asker may hold for one person: an asker whose question changes a little every turn would otherwise
 *  write without end, and push real decisions out of the person's list. */
export const MAX_OPEN_DECISIONS = 20

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
  id: string; personId: string; conversationId: string; projectId: string; askerAgentId: string; question: string; options: string[]
  /** The option Let PM decide takes; a row whose index is not one of its options has none. */
  recommended: number; answeredAt: number | null
  /** When it was asked, and the task whose needs_human asked it: the leaderboard credits the answer (leaderboard/record.ts). */
  createdAt: number; assignmentId: string | null
}
/** `delegated`: the person asked left it to the PM, who took the recommended option. */
export interface DecisionAnswer { id: string; choice: number; note: string | null; delegated?: true }

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

/** The conversation a decision was asked in, while the person asked is still in the Swarm and still reads it: checked on
 *  every answer and on every retry of one (review of #1753). Anyone else is told it does not exist. */
export function answerable(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined): Conversation {
  const asked = actor.kind === 'person' && decision?.personId === actor.userId && state.people.some(p => p.id === actor.userId)
  const group = asked ? state.conversations.find(c => c.id === decision.conversationId) : undefined
  if (!group || !canReadGroup(state, actor, group)) fail('NOT_FOUND', 'This decision is unavailable.', 404)
  return group
}

/** What tells the asking agent and the Lead, whichever of them is still in the conversation. A notice only they read, with
 *  none of the answer in it: the decisions read, which checks who reads it, has the answer (review of #1753). */
export const ANSWERED_NOTICE = 'A decision asked in this conversation was answered. Read the answer with: harness super-tab decisions --answered'
/** The same notice for a decision the person left to the PM, with none of the answer either. */
export const DELEGATED_NOTICE = 'A decision asked in this conversation was left to the Product Manager, who took its recommended option. '
  + 'Read it with: harness super-tab decisions --answered'

/** How an answer reads in the decisions list: a delegated one never as the person's own choice. */
const answerText = (option: string, delegated: boolean) => delegated ? `PM decided: ${option}` : option

/** The asked person's one answer, or their leaving it to the PM (`delegate`), which takes the recommended option; the notice
 *  for the asking agent and the Lead; and for a delegated one, the Lead's line in the person's own Chat with PM. */
export function answerDecision(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined,
  given: { choice?: number; note: string | null; delegate: boolean }) {
  if ((given.choice === undefined) === !given.delegate) fail('INVALID_DECISION', 'Choose one of its options, or leave it to the PM.', 400)
  const group = answerable(state, actor, decision)
  const asked = decision!
  if (asked.answeredAt !== null) fail('DECISION_ANSWERED', 'This decision is already answered.')
  if (given.delegate && !(asked.recommended >= 0 && asked.recommended < asked.options.length)) {
    fail('INVALID_DECISION', 'This decision has no recommended option to leave to the PM.', 400)
  }
  const choice = given.delegate ? asked.recommended : given.choice!
  if (choice >= asked.options.length) fail('INVALID_DECISION', 'Choose one of its options.', 400)
  const project = groupProject(state, group)
  const lead = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const recipients = [...new Set([asked.askerAgentId, ...lead ? [lead] : []])].filter(id => group.agentIds.includes(id))
  const answer: DecisionAnswer = { id: asked.id, choice, note: given.note, ...given.delegate ? { delegated: true as const } : {} }
  const line = given.delegate && lead ? delegatedLine(state, actor, project.id, lead, asked, choice) : null
  return { answer, recipients, source: { ...AGENT_ONLY, decisionId: asked.id }, line }
}

/** The Lead's one line saying what it chose, in the person's own Chat with PM of that project: only they read it, and they
 *  were asked the question. None when they have no open one with the Lead in it. */
function delegatedLine(state: SuperTabState, actor: Actor, projectId: string, leadId: string, asked: DecisionTarget, choice: number) {
  const lead = state.agents.find(a => a.id === leadId)
  const chat = state.conversations.find(c => !c.archived && c.audience?.people.length === 1 && c.audience.people[0]!.id === asked.personId
    && groupProject(state, c).id === projectId && c.agentIds.includes(leadId) && canReadGroup(state, actor, c))
  if (!lead || !chat) return null
  const author: Author = { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration }
  const question = asked.question.replace(/\s+/g, ' ')
  return { conversationId: chat.id, author, text: `${answerText(asked.options[choice]!, true)} — ${question}`,
    source: { kind: 'decision-delegated', decisionId: asked.id } }
}

/** Mongo omits unset fields, so `answeredAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabDecisionWhereInput = { OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] }

/** Whether a person's decision asked in this conversation still waits: a group that has one is never archived by itself. */
export async function waitingIn(tx: Tx, tabId: string, conversationId: string): Promise<boolean> {
  return !!await tx.superTabDecision.findFirst({ where: { tabId, conversationId, ...waiting }, select: { id: true } })
}

/** What makes an ask a repeat: the same asker, task, person, conversation, question, options, recommendation and what it
 *  unblocks. Another asker, another task or other options with the same text is a decision of its own (review of #1753). */
const repeatKey = (d: Pick<DecisionDraft, 'askerAgentId' | 'assignmentId' | 'personId' | 'conversationId' | 'question' | 'options' | 'recommended' | 'unblocks'>) =>
  JSON.stringify([d.askerAgentId, d.assignmentId ?? null, d.personId, d.conversationId, d.question, d.options, d.recommended, d.unblocks])

/** Writes the questions asked and returns the decision each one is: an open decision that this ask exactly repeats is that
 *  decision again, not a second one. New ones beyond MAX_OPEN_DECISIONS from this asker to this person are refused, and
 *  writing them removes the tab's decisions answered before the leaderboard's weeks. Read and written in the command's
 *  transaction; asks committing at the same moment each pass the check, so together they can still be written twice or
 *  go past the cap by what they add. */
export async function writeDecisions(tx: Tx, tabId: string, drafts: DecisionDraft[], now: number): Promise<string[]> {
  if (!drafts.length) return []
  const { personId, askerAgentId } = drafts[0]!
  const open = await tx.superTabDecision.findMany({ where: { tabId, personId, conversationId: drafts[0]!.conversationId,
    askerAgentId, question: { in: drafts.map(d => d.question) }, ...waiting } })
  const held = new Map(open.map(o => [repeatKey(o), o.id]))
  const fresh = drafts.filter(d => !held.has(repeatKey(d)))
  if (fresh.length) {
    const asked = await tx.superTabDecision.count({ where: { tabId, personId, askerAgentId, ...waiting } })
    if (asked + fresh.length > MAX_OPEN_DECISIONS) {
      fail('DECISIONS_FULL', `${asked} decisions you asked this person are still open, and at most ${MAX_OPEN_DECISIONS} can be. Wait for answers before asking more.`)
    }
    await tx.superTabDecision.createMany({ data: fresh.map(d => ({ ...d, tabId, createdAt: new Date(now) })) })
    await tx.superTabDecision.deleteMany({ where: { tabId, answeredAt: { lt: new Date(now - LEDGER_WEEKS * WEEK_MS) } } })
  }
  return drafts.map(d => held.get(repeatKey(d)) ?? d.id)
}

/** The open decision an ask exactly repeats, which writeDecisions keeps as that decision again. Read before a worker's
 *  needs_human that asks, so its wait names the decision it is waiting on (leaderboard/record.ts recordStatus). */
export async function repeatOf(tx: Tx, tabId: string, ask: Parameters<typeof repeatKey>[0]): Promise<string | undefined> {
  const same = await tx.superTabDecision.findMany({ where: { tabId, personId: ask.personId, askerAgentId: ask.askerAgentId,
    conversationId: ask.conversationId, question: ask.question, ...waiting } })
  return same.find(o => repeatKey(o) === repeatKey(ask))?.id
}

/** How many decisions this asker has open for this person when one more question would pass MAX_OPEN_DECISIONS, or null when
 *  it fits. Read before a worker's needs_human asks something new (an exact repeat of an open one, repeatOf, always fits),
 *  which at the cap still records its status and only skips the question (review of #1859). */
export async function fullFor(tx: Tx, tabId: string, ask: { personId: string; askerAgentId: string }): Promise<number | null> {
  const asked = await tx.superTabDecision.count({ where: { tabId, personId: ask.personId, askerAgentId: ask.askerAgentId, ...waiting } })
  return asked < MAX_OPEN_DECISIONS ? null : asked
}

export async function readAskedDecision(tx: Tx, tabId: string, id: string): Promise<DecisionTarget | undefined> {
  const row = await tx.superTabDecision.findFirst({ where: { id, tabId },
    select: { id: true, personId: true, conversationId: true, projectId: true, askerAgentId: true, question: true, options: true, recommended: true,
      answeredAt: true, createdAt: true, assignmentId: true } })
  return row ? { ...row, answeredAt: row.answeredAt?.getTime() ?? null, createdAt: row.createdAt.getTime(), assignmentId: row.assignmentId ?? null } : undefined
}

/** Conflicts with a concurrent answer of the same decision: only the first one counts. */
export async function recordAnswer(tx: Tx, tabId: string, answer: DecisionAnswer, now: number): Promise<void> {
  const taken = await tx.superTabDecision.updateMany({ where: { id: answer.id, tabId, ...waiting },
    data: { choice: answer.choice, note: answer.note, answeredAt: new Date(now), ...answer.delegated ? { delegated: true } : {} } })
  if (!taken.count) fail('DECISION_ANSWERED', 'This decision is already answered.')
}

/** Whose decisions a reader sees: a person, those asked of them in conversations they still read; an agent, those it asked,
 *  and a Lead also those asked in its project. Nobody else, owners included. */
function readerWhere(state: SuperTabState, actor: Actor): Prisma.SuperTabDecisionWhereInput {
  if (actor.kind === 'person') return { personId: person(state, actor.userId).id }
  const led = ledProject(state, actor.agentId)
  return { OR: [{ askerAgentId: actor.agentId }, ...led ? [{ projectId: led.id }] : []] }
}

/** What an access check reads of a conversation (projects.ts canReadGroup). */
const ACCESS_FIELDS = ['id', 'kind', 'projectId', 'audience'] as const

/** The conversations [ids] names: those the read loaded, and the rest (quiet, archived, or left out of a light read) read
 *  here, so a decision in one still counts. With [only], the rest bring only those fields. A deleted conversation is none. */
async function conversationsOf(tx: Tx, tabId: string, state: SuperTabState, ids: string[],
  only?: readonly string[]): Promise<Map<string, Conversation>> {
  const named = new Set(ids)
  const found = new Map(state.conversations.filter(c => named.has(c.id)).map(c => [c.id, c]))
  const missing = [...named].filter(id => !found.has(id))
  if (!missing.length) return found
  // By id through its index (parts/indexed.ts): a person's read counts these on each poll.
  const rows = await groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } },
    { $project: { _id: 0, key: 1, ...only ? Object.fromEntries(only.map(field => [`data.${field}`, 1])) : { data: 1 } } }]) as unknown as Array<{ key: string; data: unknown }>
  for (const row of rows) found.set(row.key, row.data as Conversation)
  return found
}

/** Checked at every read, for agents too: a reader who can no longer read the conversation no longer reads its decisions. */
const readableIn = (state: SuperTabState, actor: Actor, groups: Map<string, Conversation>, conversationId: string) => {
  const group = groups.get(conversationId)
  return group && canReadGroup(state, actor, group) ? group : undefined
}

/** Answered by the person themself: as `waiting`, a row written before `delegated` has no such field. */
const yours: Prisma.SuperTabDecisionWhereInput = { OR: [{ delegated: { isSet: false } }, { delegated: null }, { delegated: false }] }

/** Which decisions a list holds: those still open, or those answered. `settled` is every answered one, those left to the
 *  PM included; `answered` is what an older Desktop reads and labels each "You chose", so for a person it leaves out those
 *  the PM decided (their Chat with PM has the PM's line). An agent's `answered` holds them all, saying who decided. */
export type DecisionList = 'open' | 'answered' | 'settled'
const LIST_PAGE = 200

/** ponytail: the newest LIST_PAGE per list; `more` says when there are others. Page it if a reader ever has more. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, list: DecisionList) {
  const which = list === 'open' ? [waiting] : list === 'answered' && actor.kind === 'person'
    ? [{ answeredAt: { not: null } }, yours] : [{ answeredAt: { not: null } }]
  const read = await tx.superTabDecision.findMany({ where: { tabId, AND: [readerWhere(state, actor), ...which] },
    orderBy: { createdAt: 'desc' }, take: LIST_PAGE + 1 })
  const rows = read.slice(0, LIST_PAGE)
  const groups = await conversationsOf(tx, tabId, state, rows.map(r => r.conversationId))
  return { more: read.length > LIST_PAGE, rows: rows.flatMap(row => {
    const group = readableIn(state, actor, groups, row.conversationId)
    return group ? [{ row, group }] : []
  }) }
}

/** How many of a project's open decisions wait in each conversation for each person, for its digest (digest.ts
 *  decisionLines): never what they ask. Every open one is read, so every one counts, however many there are, and private
 *  ones filtered out later never crowd out shared ones (review of #1772). Counted here, reading only who and where:
 *  groupBy on this model once panicked the Prisma engine on Mongo (review of #1855). */
export async function waitingInProject(tx: Tx, tabId: string, projectId: string): Promise<Array<{ conversationId: string; personId: string; count: number }>> {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, projectId, ...waiting }, select: { conversationId: true, personId: true } })
  const counts = new Map<string, { conversationId: string; personId: string; count: number }>()
  for (const { conversationId, personId } of rows) {
    const key = JSON.stringify([conversationId, personId])
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { conversationId, personId, count: 1 })
  }
  return [...counts.values()]
}

/** A person's open decisions: how many, and a digest of which. A client reads its list again when the digest moves, as
 *  when one is answered elsewhere and another asked, which leaves the count alone (review of #1820). Read on every poll, so
 *  only each one's id and conversation, and each quiet conversation's access fields: never what they ask, nor a brief. Not
 *  capped: a cap counted rows the reader cannot open and left out ones they can, so the badge undercounted. */
export async function decisionsWaiting(tx: Tx, tabId: string, state: SuperTabState,
  actor: Extract<Actor, { kind: 'person' }>): Promise<{ count: number; digest: string }> {
  const rows = await tx.superTabDecision.findMany({ where: { tabId, AND: [readerWhere(state, actor), waiting] }, select: { id: true, conversationId: true } })
  const groups = await conversationsOf(tx, tabId, state, rows.map(r => r.conversationId), ACCESS_FIELDS)
  const ids = rows.filter(row => readableIn(state, actor, groups, row.conversationId)).map(row => row.id).sort()
  return { count: ids.length, digest: createHash('sha256').update(ids.join('\n')).digest('base64url').slice(0, 16) }
}

/** One list of the reader's decisions, newest first, and whether it leaves older ones out (`more`): a client may take a
 *  decision missing from it as answered or gone only when it does not. */
export async function listDecisions(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, list: DecisionList) {
  const { more, rows } = await readable(tx, tabId, state, actor, list)
  return { more, decisions: rows.map(({ row, group }) => {
    const asker = state.agents.find(a => a.id === row.askerAgentId)
    return { id: row.id, batchId: row.batchId, projectId: row.projectId, projectName: projectOf(state, row.projectId).name,
      conversationId: row.conversationId, conversationTitle: group.title, assignmentId: row.assignmentId ?? null,
      personId: row.personId, personEmail: state.people.find(p => p.id === row.personId)?.email ?? null,
      askerAgentId: row.askerAgentId, askerName: asker?.displayName ?? asker?.name ?? 'Agent',
      question: row.question, options: row.options, recommended: row.recommended, unblocks: row.unblocks,
      createdAt: row.createdAt, answeredAt: row.answeredAt ?? null, choice: row.choice ?? null, note: row.note ?? null,
      delegated: row.delegated === true,
      answer: row.choice == null || row.options[row.choice] === undefined ? null : answerText(row.options[row.choice]!, row.delegated === true) }
  }) }
}
