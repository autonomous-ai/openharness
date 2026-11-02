/** A person's decisions (design: decisions in one place). The Lead, or a worker on its own task through needs_human, asks
 *  one person a batch of questions, each with options, a recommendation and what it unblocks; the person answers each
 *  with one tap, and the answer reaches the asking agent and the Lead in the conversation it came from. Decisions live in
 *  SuperTabDecision, never in the tab state, as mentions do. A decision is not a private channel: the PM's private lines go
 *  to the person's Buddy chat (buddies.ts). Called inside SuperTabStore's transactions. */
import { isBuddy, isSwarmBuddy, openBuddyChat, openSwarmBuddyChat } from './buddies.js'
import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { agentDisplayName } from './agentNames.js'
import { AGENT_ONLY, fail, isLeads, person, stableId, type Actor, type Author, type Conversation, type SuperTabState } from './model.js'
import { agentProjectId, canReadGroup, groupProject, isClosedPmChat, ledProject, projectAgent, projectOf, projectsOf, readsRecordsIn } from './projects.js'
import { LEDGER_WEEKS } from './leaderboard/record.js'
import { coordinatorNameOf } from './instructions.js'
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

/** The kind of a decision the nightly routing reflection asks (costs/reflection.ts): about the project's routing, so its
 *  owner's Buddy never reads it, and an approved one stays until routing applies it (review of #2276). */
export const REFLECTION_DECISION = 'routing-reflection'
/** Not a routing reflection's: rows written before `kind` have none. */
const notReflection: Prisma.SuperTabDecisionWhereInput = { OR: [{ kind: { isSet: false } }, { kind: null }, { kind: { not: REFLECTION_DECISION } }] }

/** A decision as asked, written by the store. */
export interface DecisionDraft extends Question {
  id: string; batchId: string; conversationId: string; projectId: string; personId: string; askerAgentId: string; assignmentId: string | null
  kind?: typeof REFLECTION_DECISION
}
/** The decision `decision.answer` names, read from SuperTabDecision by the store. */
export interface DecisionTarget {
  id: string; personId: string; conversationId: string; projectId: string; askerAgentId: string; question: string; options: string[]
  /** The option Let PM decide takes; a row whose index is not one of its options has none. */
  recommended: number; answeredAt: number | null
  /** When it was asked, and the task whose needs_human asked it: the leaderboard credits the answer (leaderboard/record.ts). */
  createdAt: number; assignmentId: string | null
  kind?: string | null
  /** Closed unanswered once its work was over (withdrawIn). */
  withdrawn?: boolean
}
/** `delegated`: the person asked left it to the PM, who took the recommended option. */
export interface DecisionAnswer { id: string; choice: number; note: string | null; delegated?: true }

/** Questions for one person in one conversation they read, from `asker`. One batch: one id ties them, no ping per question. */
export function askDecisions(state: SuperTabState, group: Conversation, personId: string, questions: Question[],
  from: { operationId: string; askerAgentId: string; assignmentId: string | null; kind?: typeof REFLECTION_DECISION }): DecisionDraft[] {
  const asked = state.people.find(p => p.id === personId) ?? fail('INVALID_PERSON', 'Ask a person in this Swarm.', 400)
  if (!canReadGroup(state, { kind: 'person', userId: asked.id, email: asked.email }, group)) {
    fail('INVALID_PERSON', `${asked.email} cannot read this conversation.`, 400)
  }
  for (const q of questions) if (q.recommended >= q.options.length) fail('INVALID_DECISION', 'A question must recommend one of its options.', 400)
  // It would wait for nobody: none waits where the work is over (workOver).
  if (workOver(state, group)) fail('WORK_FINISHED', 'This work is finished, so a decision asked here would not wait. Ask in the project chat, or reopen the task first.', 400)
  const projectId = groupProject(state, group).id
  return questions.map((q, index) => ({ ...q, id: stableId(from.operationId, 'decision', String(index)), batchId: from.operationId,
    conversationId: group.id, projectId, personId, askerAgentId: from.askerAgentId, assignmentId: from.assignmentId, ...from.kind ? { kind: from.kind } : {} }))
}

/** Any agent of the project asks with `decision.ask`, in its own project's conversations (project instructions, phase 4); a
 *  worker may also ask through needs_human. */
export function checkAsker(state: SuperTabState, actor: Actor, group: Conversation): string {
  if (isLeads(group) || !projectAgent(state, actor, groupProject(state, group).id)) {
    fail('FORBIDDEN', 'An agent asks for decisions in its own project’s conversations.', 403)
  }
  return actor.agentId
}

/** Whether the work a decision was asked about is over, so it waits no more (Dee, 10-31: decisions of tasks already done and
 *  merged still said they waited): a work group whose task is done or cancelled, or which is archived. Never a project chat,
 *  a Buddy chat or a closed Chat with PM, which hold no task of their own (tidy.ts archivable leaves them out alike). A
 *  deleted group is none: the reads find no conversation for its decisions. Reads only what an access check of a quiet
 *  conversation brings (ACCESS_FIELDS). */
export function workOver(state: SuperTabState, group: Pick<Conversation, 'id' | 'kind' | 'audience' | 'archived' | 'assignment'>): boolean {
  if (group.kind || group.audience || projectsOf(state).some(p => p.leadConversationId === group.id)) return false
  return group.archived === true || ['done', 'cancelled'].includes(group.assignment?.status ?? '')
}

/** The answer a decision whose work is over gets: the code an answered one gets, which a client already takes as gone. */
const NO_LONGER_WAITS = 'This decision no longer waits: its work is finished.'

/** The conversation a decision was asked in, while the person asked is still in the Swarm and still reads it, or read it
 *  before it closed as a Chat with PM: checked on every answer and on every retry of one (review of #1753). Anyone else is
 *  told it does not exist. */
export function answerable(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined): Conversation {
  const asked = actor.kind === 'person' && decision?.personId === actor.userId && state.people.some(p => p.id === actor.userId)
  const group = asked ? state.conversations.find(c => c.id === decision.conversationId) : undefined
  if (!group || !readsRecordsIn(state, actor, group)) fail('NOT_FOUND', 'This decision is unavailable.', 404)
  return group
}

/** What tells the asking agent and the Lead, whichever of them is still in the conversation. A notice only they read, with
 *  none of the answer in it: the decisions read, which checks who reads it, has the answer (review of #1753). */
export const ANSWERED_NOTICE = 'A decision asked in this conversation was answered. Read the answer with: harness super-tab decisions --answered'
/** The same notice for a decision the person left to the PM, with none of the answer either; [name] is what its project calls
 *  its coordinator (instructions.ts coordinatorNameOf). */
export const delegatedNotice = (name: string) => `A decision asked in this conversation was left to the ${name}, who took its recommended option. `
  + 'Read it with: harness super-tab decisions --answered'
/** The notices for a decision asked in a closed Chat with PM, told in the project chat instead: never "in this conversation". */
export const CLOSED_CHAT_ANSWERED_NOTICE = 'A decision you asked in a closed Chat with PM was answered. Read the answer with: harness super-tab decisions --answered'
export const closedChatDelegatedNotice = (name: string) => `A decision you asked in a closed Chat with PM was left to the ${name}, who took its recommended option. `
  + 'Read it with: harness super-tab decisions --answered'

/** How an answer reads in the decisions list: a delegated one never as the person's own choice. */
const answerText = (option: string, delegated: boolean) => delegated ? `PM decided: ${option}` : option

/** The asked person's one answer, or their leaving it to the PM (`delegate`), which takes the recommended option; the notice
 *  for the asking agent and the Lead, in the conversation it was asked in or, for a closed Chat with PM nobody reads, in
 *  the project chat (`noticeIn`); and for a delegated one, the Lead's line in the person's Buddy chat. */
export function answerDecision(state: SuperTabState, actor: Actor, decision: DecisionTarget | undefined,
  given: { choice?: number; note: string | null; delegate: boolean }) {
  if ((given.choice === undefined) === !given.delegate) fail('INVALID_DECISION', 'Choose one of its options, or leave it to the PM.', 400)
  const group = answerable(state, actor, decision)
  const asked = decision!
  if (asked.withdrawn || workOver(state, group)) fail('DECISION_ANSWERED', NO_LONGER_WAITS)
  if (asked.answeredAt !== null) fail('DECISION_ANSWERED', 'This decision is already answered.')
  if (given.delegate && !(asked.recommended >= 0 && asked.recommended < asked.options.length)) {
    fail('INVALID_DECISION', 'This decision has no recommended option to leave to the PM.', 400)
  }
  const choice = given.delegate ? asked.recommended : given.choice!
  if (choice >= asked.options.length) fail('INVALID_DECISION', 'Choose one of its options.', 400)
  const project = groupProject(state, group)
  const lead = state.conversations.find(c => c.id === project.leadConversationId)?.leadId
  const closed = isClosedPmChat(group)
  const noticeIn = closed ? state.conversations.find(c => c.id === project.leadConversationId)! : group
  const notice = given.delegate ? (closed ? closedChatDelegatedNotice : delegatedNotice)(coordinatorNameOf(project))
    : closed ? CLOSED_CHAT_ANSWERED_NOTICE : ANSWERED_NOTICE
  const recipients = [...new Set([asked.askerAgentId, ...lead ? [lead] : []])].filter(id => noticeIn.agentIds.includes(id))
  const answer: DecisionAnswer = { id: asked.id, choice, note: given.note, ...given.delegate ? { delegated: true as const } : {} }
  // A routing reflection's never reaches the Buddy chat: the person's Buddy reads it (review of #2276).
  const line = given.delegate && lead && asked.kind !== REFLECTION_DECISION ? delegatedLine(state, project.id, lead, asked, choice) : null
  return { answer, noticeIn: noticeIn.id, notice, recipients, source: { ...AGENT_ONLY, decisionId: asked.id }, line }
}

/** The Lead's one line saying what it chose, in the person's own Buddy chat of that project: only they and their Buddy read
 *  it, and they were asked the question. Opened for the line when they have none (buddies.ts openBuddyChat), so it never
 *  drops: Buddies replaced Chat with PM (Ken, 10-29). */
function delegatedLine(state: SuperTabState, projectId: string, leadId: string, asked: DecisionTarget, choice: number) {
  const lead = state.agents.find(a => a.id === leadId)
  if (!lead) return null
  const to = person(state, asked.personId)
  const author: Author = { kind: 'agent', id: lead.id, name: lead.name, displayName: agentDisplayName(state.agents, lead.id), membershipGeneration: lead.membershipGeneration }
  const question = asked.question.replace(/\s+/g, ' ')
  const text = `${answerText(asked.options[choice]!, true)} — ${question}`
  // In their one Buddy chat, marked with its project (Dee, 10-31), and in their older chat there for older apps.
  return [{ conversationId: openSwarmBuddyChat(state, to).id, author, text, source: { kind: 'decision-delegated', decisionId: asked.id, projectId }, buddyProject: projectId },
    { conversationId: openBuddyChat(state, projectId, to).id, author, text, source: { kind: 'decision-delegated', decisionId: asked.id } }]
}

/** Mongo omits unset fields, so `answeredAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabDecisionWhereInput = { OR: [{ answeredAt: null }, { answeredAt: { isSet: false } }] }

/** How many decisions asked of `personId` in this conversation still wait for them (catchUp.ts). */
export async function waitingFor(tx: Tx, tabId: string, conversationId: string, personId: string): Promise<number> {
  return tx.superTabDecision.count({ where: { tabId, conversationId, personId, ...waiting } })
}

/** Closes the decisions still waiting in these conversations, whose work is over (workOver), as withdrawn: answered at
 *  [now] with no choice, so none waits, none is listed, none can be answered and a new ask of the same question is a new
 *  decision. Never a routing reflection's, which expires on its own (expireReflections). Run in the transaction that ends
 *  the work (store.ts), so a concurrent answer conflicts with it and only one of them counts. With [askedBy], only those
 *  asked by then: the work was read as over at that time (store.ts withdrawEndedDecisions). The number closed. */
export async function withdrawIn(tx: Tx, tabId: string, conversationIds: readonly string[], now: number, askedBy?: number): Promise<number> {
  let closed = 0
  // One by one through the conversation index: a command ends one conversation's work, rarely a few (hotFilters.test.ts).
  for (const conversationId of new Set(conversationIds)) {
    closed += (await tx.superTabDecision.updateMany({ where: { tabId, conversationId, AND: [waiting, notReflection],
      ...askedBy === undefined ? {} : { createdAt: { lte: new Date(askedBy) } } },
      data: { answeredAt: new Date(now), withdrawn: true } })).count
  }
  return closed
}

/** The conversations, by Swarm, where a decision still waits, a routing reflection's aside (store.ts withdrawEndedDecisions,
 *  once at worker startup). Open decisions are few: at most MAX_OPEN_DECISIONS per asker and person. */
export async function waitingConversations(tx: Tx): Promise<Map<string, string[]>> {
  const rows = await tx.superTabDecision.findMany({ where: { AND: [waiting, notReflection] }, select: { tabId: true, conversationId: true },
    distinct: ['tabId', 'conversationId'] })
  const byTab = new Map<string, string[]>()
  for (const row of rows) byTab.set(row.tabId, [...byTab.get(row.tabId) ?? [], row.conversationId])
  return byTab
}

/** The conversations whose work this write ended (workOver in [after], not in [before]): their waiting decisions close. */
export function workEnded(before: SuperTabState, after: SuperTabState): string[] {
  const was = new Map(before.conversations.map(c => [c.id, c]))
  return after.conversations.filter(c => workOver(after, c) && !(was.has(c.id) && workOver(before, was.get(c.id)!))).map(c => c.id)
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

/** A project's routing reflection decisions, newest first, through the project index: at most MAX_PROPOSALS are asked a
 *  night, and answered ones go after the ledger's weeks (store.ts postReflection). */
export async function reflectionDecisions(tx: Tx, tabId: string, projectId: string) {
  return tx.superTabDecision.findMany({ where: { tabId, projectId, kind: REFLECTION_DECISION },
    select: { id: true, question: true, unblocks: true, choice: true, answeredAt: true, createdAt: true, delegated: true }, orderBy: { createdAt: 'desc' }, take: 500 })
}

/** Days a routing reflection's proposal stays open unanswered: its week's numbers are stale by then (review of #2276). */
export const REFLECTION_OPEN_DAYS = 7
/** Removes a project's routing proposals left unanswered for REFLECTION_OPEN_DAYS, through the project index. Run on every
 *  night the project's report is due, a report or not (delta review of #2276). */
export async function expireReflections(tx: Tx, tabId: string, projectId: string, now: number): Promise<void> {
  await tx.superTabDecision.deleteMany({ where: { tabId, projectId, kind: REFLECTION_DECISION,
    createdAt: { lt: new Date(now - REFLECTION_OPEN_DAYS * 24 * 3_600_000) }, ...waiting } })
}

export async function readAskedDecision(tx: Tx, tabId: string, id: string): Promise<DecisionTarget | undefined> {
  const row = await tx.superTabDecision.findFirst({ where: { id, tabId },
    select: { id: true, personId: true, conversationId: true, projectId: true, askerAgentId: true, question: true, options: true, recommended: true,
      answeredAt: true, createdAt: true, assignmentId: true, kind: true, withdrawn: true } })
  return row ? { ...row, answeredAt: row.answeredAt?.getTime() ?? null, createdAt: row.createdAt.getTime(), assignmentId: row.assignmentId ?? null,
    withdrawn: row.withdrawn === true } : undefined
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
  // A Buddy reads its person's own decisions in its project, by the person's index; each one's conversation is still
  // checked as the Buddy reads it (readableIn), so none in a private chat or after its person left (buddies.ts).
  const buddy = state.agents.find(a => a.id === actor.agentId && isBuddy(a))
  // Never a routing reflection's: those are about the project's routing, for its people (review of #2276).
  // A Swarm-wide Buddy reads its person's decisions in every project, each still checked as it reads that conversation
  // (Dee, 10-31); a project session and an older Buddy, those of its own project.
  if (buddy) return { personId: buddy.buddyOf!.personId, ...(isSwarmBuddy(buddy) ? {} : { projectId: agentProjectId(state, buddy) }), AND: [notReflection] }
  const led = ledProject(state, actor.agentId)
  return { OR: [{ askerAgentId: actor.agentId }, ...led ? [{ projectId: led.id }] : []] }
}

/** What an access check reads of a conversation (projects.ts canReadGroup), and whether its work is over (workOver). */
const ACCESS_FIELDS = ['id', 'kind', 'projectId', 'audience', 'archived', 'assignment.status'] as const

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

/** Checked at every read, for agents too: a reader who can no longer read the conversation no longer reads its decisions.
 *  One asked in a closed Chat with PM stays its person's and the PM's (projects.ts readsRecordsIn). */
const readableIn = (state: SuperTabState, actor: Actor, groups: Map<string, Conversation>, conversationId: string) => {
  const group = groups.get(conversationId)
  return group && readsRecordsIn(state, actor, group) ? group : undefined
}

/** Answered by the person themself: as `waiting`, a row written before `delegated` has no such field. */
const yours: Prisma.SuperTabDecisionWhereInput = { OR: [{ delegated: { isSet: false } }, { delegated: null }, { delegated: false }] }
/** Answered by someone: not closed unanswered (withdrawIn), which every row from before `withdrawn` was not. */
const notWithdrawn: Prisma.SuperTabDecisionWhereInput = { OR: [{ withdrawn: { isSet: false } }, { withdrawn: null }, { withdrawn: false }] }

/** Which decisions a list holds: those still open, or those answered. `settled` is every answered one, those left to the
 *  PM included; `answered` is what an older Desktop reads and labels each "You chose", so for a person it leaves out those
 *  the PM decided (their Chat with PM has the PM's line). An agent's `answered` holds them all, saying who decided. */
export type DecisionList = 'open' | 'answered' | 'settled'
const LIST_PAGE = 200

/** ponytail: the newest LIST_PAGE per list; `more` says when there are others. Page it if a reader ever has more. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Actor, list: DecisionList) {
  const which = list === 'open' ? [waiting] : list === 'answered' && actor.kind === 'person'
    ? [{ answeredAt: { not: null } }, yours, notWithdrawn] : [{ answeredAt: { not: null } }, notWithdrawn]
  const read = await tx.superTabDecision.findMany({ where: { tabId, AND: [readerWhere(state, actor), ...which] },
    orderBy: { createdAt: 'desc' }, take: LIST_PAGE + 1 })
  const rows = read.slice(0, LIST_PAGE)
  const groups = await conversationsOf(tx, tabId, state, rows.map(r => r.conversationId))
  return { more: read.length > LIST_PAGE, rows: rows.flatMap(row => {
    const group = readableIn(state, actor, groups, row.conversationId)
    // An open one whose work is over waits no more, closed or not yet (one from before withdrawIn).
    return group && !(list === 'open' && workOver(state, group)) ? [{ row, group }] : []
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
  const ids = rows.filter(row => {
    const group = readableIn(state, actor, groups, row.conversationId)
    return group && !workOver(state, group)
  }).map(row => row.id).sort()
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
