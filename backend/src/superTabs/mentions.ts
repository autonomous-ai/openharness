/** A person, or any agent of the project but a Buddy, tags people in a message; each tag waits in the person's Swarm-wide list
 *  until they reply in that conversation or mark it done. Tags live in SuperTabMention, never in the tab state, so an older backend still
 *  reads and writes a tab that has them. Called inside SuperTabStore's transactions. */
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { activeWork, agentOnly, fail, isLeads, person, stableId, type Actor, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, canReadProject, groupProject, projectAgent, projectOf, projectsOf } from './projects.js'
import { isBuddyChat, isSwarmBuddyChat } from './buddies.js'
import { groupsBy, readBy } from './parts/indexed.js'
import { deliveredCopies } from './pageReads.js'
import { shownNameOf } from './personNames.js'
import { usernameOf } from './usernames.js'

type Tx = Prisma.TransactionClient
export const MAX_MENTIONS = 5
/** A tag drops off the list this long after it was made: refused on read, and removed by a TTL index. */
export const MENTION_EXPIRY_MS = 30 * 24 * 60 * 60_000
/** A Lead's tag about a task with no worker (message.send mentionsIfNoWorker) is listed only after this long, and only if the
 *  group still has no worker and the Lead has done nothing for it since: the Lead sees a failed start first and usually
 *  restarts the task within minutes, so a person tagged at once got a notice they could do nothing about (Dee, 2026-10-29). */
export const NO_WORKER_GRACE_MS = 20 * 60_000
/** The mention `mention.done` names, read from this tab by the store. */
export interface MentionTarget { id: string; personId: string; conversationId: string }
/** Mongo omits unset fields, so `resolvedAt: null` alone would miss a row written without it. */
const waiting: Prisma.SuperTabMentionWhereInput = { OR: [{ resolvedAt: null }, { resolvedAt: { isSet: false } }] }

/** Run by the singleton worker at startup, like the terminal answer expiry. */
export async function ensureMentionExpiry(db: PrismaClient): Promise<void> {
  await ensureIndex(db, 'SuperTabMention', { key: { createdAt: 1 }, name: 'mention_expiry', expireAfterSeconds: MENTION_EXPIRY_MS / 1000 })
}

/** `@name` or `@name@domain`, as people tag in chat. Never right after a letter, digit, `@` or `/` (an address, a path, a
 *  link), and a name never ends in a dot: `@dee.` closes a sentence. Desktop (message_text.dart) and the phone
 *  (swarm_message_row.dart) use this same pattern; tagFixture.json is the table all three pass. */
const TAG = /(?<![\w@/])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const blank = (part: string) => part.replace(/[^\n]/g, ' ')

/** [text] with what is never a tag blanked out, as Markdown renders it: fenced and indented code, code spans, bare links and
 *  link destinations. */
function prose(text: string): string {
  const lines = text.split('\n')
  let fence: string | null = null
  let indented = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      const close = FENCE.exec(line)
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !line.slice(close[0].length).trim()) fence = null
      lines[i] = blank(line)
      continue
    }
    const open = FENCE.exec(line)
    if (open && !(open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = open[1]!
      lines[i] = blank(line)
      indented = false
      continue
    }
    // Indented code starts after a blank line (or the first line) and runs while its lines stay indented.
    const startsCode: boolean = /^( {4}|\t)/.test(line) && line.trim() !== '' && (indented || i === 0 || !lines[i - 1]!.trim())
    indented = startsCode || (indented && !line.trim())
    if (startsCode) lines[i] = blank(line)
  }
  return lines.join('\n')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
    .replace(/\]\([^)\]]*\)/g, blank)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, blank)
}

/** The tags [text] holds, in order: each name as written after its `@`, lowercased, a full address with its domain. */
export function tagTokens(text: string): string[] {
  return [...prose(text).matchAll(TAG)].map(match => `${match[1]}${match[2] ?? ''}`.toLowerCase())
}

/** The people [text] names, in order, once each: `@username` in any case, or `@` and their full address. [names] is the
 *  Swarm's usernames by person (usernames.ts swarmUsernames). */
export function namedIn(state: SuperTabState, text: string, names: ReadonlyMap<string, string>): string[] {
  const tokens = tagTokens(text)
  if (!tokens.length) return []
  const byName = new Map([...names].map(([id, name]) => [name.toLowerCase(), id]))
  const ids = tokens.flatMap(token => {
    const id = token.includes('@') ? state.people.find(p => p.email.toLowerCase() === token)?.id : byName.get(token)
    return id && state.people.some(p => p.id === id) ? [id] : []
  })
  return [...new Set(ids)]
}

/** The agents of [group] that [text] names by `@Name` (task #2963): its display name or name in any case, matched only when
 *  exactly one agent there goes by it and no person's username is the same, so a person's tag stays a tag. [names] is the
 *  Swarm's usernames by person (usernames.ts swarmUsernames). A Buddy chat names no one this way: its sessions hear their own
 *  threads alone (buddySessions.ts). */
export function agentsNamedIn(state: SuperTabState, group: Conversation, text: string, names: ReadonlyMap<string, string>): string[] {
  if (isBuddyChat(group)) return []
  const people = new Set([...names.values()].map(name => name.toLowerCase()))
  const tokens = tagTokens(text).filter(token => !token.includes('@') && !people.has(token))
  if (!tokens.length) return []
  const members = state.agents.filter(a => group.agentIds.includes(a.id))
  return [...new Set(tokens.flatMap(token => {
    const matches = members.filter(a => a.displayName?.toLowerCase() === token || a.name.toLowerCase() === token)
    return matches.length === 1 ? [matches[0]!.id] : []
  }))]
}

/** Whether [text] says `@` and exactly [name] outside code and links, in any case: a stored name that ends in a dot, chosen
 *  before such names were refused, reads as a shorter tag in [namedIn] but is still said. */
export function saysName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w@/])@${escaped}(?![\\w+-]|\\.[\\w+-])`, 'i').test(prose(text))
}

/** [tags] on the first line of [text], as a person types them in chat. Only text that opens with a block (a list, heading,
 *  quote, table, code, divider or link definition) keeps them on a line of their own, so that block still renders. The same
 *  rule as Desktop's SuperTabMessageText.withTags, which shows an older message's unsaid tags. */
export function withTags(tags: string[], text: string): string {
  if (!tags.length) return text
  const body = text.replace(/^(?:[ \t]*\n)+/, '')
  if (!body) return tags.join(' ')
  return OPENS_BLOCK.test(body) ? `${tags.join(' ')}\n\n${body}` : `${tags.join(' ')} ${body}`
}
const OPENS_BLOCK = new RegExp('^(?: {4}|\\t| {0,3}(?:[-*+](?:[ \\t\\n]|$)|#{1,6}(?:[ \\t\\n]|$)|>'
  + '|\\d{1,9}[.)](?:[ \\t\\n]|$)|```|~~~|\\||\\[[^\\]\\n]+\\]:'
  + '|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})(?:\\n|$)))')

/** Whether [actor] may tag people in [group]: a person who can post there; any agent of the project but a Buddy, in its own
 *  project's conversations (project instructions, phase 4); nobody in the Leads conversation. */
function mayTag(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  // Nobody else reads a person's one Buddy chat, so nobody is tagged there (Dee, 10-31).
  if (isLeads(group) || isSwarmBuddyChat(group)) return false
  return actor.kind !== 'agent' || projectAgent(state, actor, groupProject(state, group).id)
}

/** The people [named] by a post's text whom it tags: only when [actor] may tag here, only people who can read [group], never
 *  the author. Anyone else stays plain text: a name in a sentence is never an error. */
export function textTags(state: SuperTabState, actor: Actor, group: Conversation, named: string[]): string[] {
  if (!mayTag(state, actor, group)) return []
  return named.filter(id => (actor.kind !== 'person' || id !== actor.userId) && state.people.some(p => p.id === id
    && canReadGroup(state, { kind: 'person', userId: p.id, email: p.email }, group)))
}

/** A person who can post here tags people; so does any agent of the project but a Buddy, in that project's conversations.
 *  Never in the Leads conversation, and only people who can read the conversation. A person's tag of themselves is dropped. */
export function checkMentions(state: SuperTabState, actor: Actor, group: Conversation, personIds: string[]): string[] {
  const ids = [...new Set(personIds)].filter(id => actor.kind !== 'person' || id !== actor.userId)
  if (!ids.length) return ids
  if (isLeads(group)) fail('INVALID_MENTION', 'Nobody is tagged in the Leads conversation.', 400)
  if (isSwarmBuddyChat(group)) fail('INVALID_MENTION', 'Nobody else reads your Buddy chat.', 400)
  if (actor.kind === 'agent' && !projectAgent(state, actor, groupProject(state, group).id)) {
    fail('FORBIDDEN', 'Only a person or an agent of this project tags people here.', 403)
  }
  for (const id of ids) {
    const member = state.people.find(p => p.id === id) ?? fail('INVALID_MENTION', 'Tag a person in this Swarm.', 400)
    if (!canReadGroup(state, { kind: 'person', userId: member.id, email: member.email }, group)) {
      fail('INVALID_MENTION', `${usernameOf(state, member.id)} cannot read this conversation.`, 400)
    }
  }
  return ids
}

/** Writes the tags `messages` carry, and answers the rows it wrote (push/notices.ts tells their phones). */
export async function writeMentions(tx: Tx, tabId: string, state: SuperTabState, messages: MessageDraft[], now: number): Promise<MentionRow[]> {
  const data = messages.flatMap(message => (message.mentions ?? []).map(personId => ({
    id: stableId(tabId, message.id, personId), tabId, personId, projectId: state.conversations.find(c => c.id === message.conversationId)!.projectId ?? 'lead',
    conversationId: message.conversationId, messageId: message.id, authorAgentId: message.author.id,
    createdAt: new Date(now), resolvedAt: null, resolvedBy: null, ...(message.holdMentions ? { holdUntil: new Date(now + NO_WORKER_GRACE_MS) } : {}),
  })))
  if (data.length) await tx.superTabMention.createMany({ data })
  await bringBackUnfollowed(tx, tabId, messages, now)
  return data
}
type MentionRow = { id: string; personId: string; conversationId: string; messageId: string; holdUntil?: Date }

/** Who tagged, as the inbox and a phone notice name them: a person by the name the Swarm shows for them (a person's name in a
 *  message is their email, personNames.ts), an agent by its own. */
export function taggerName(state: SuperTabState, author: { kind?: string; id?: string; name?: string; displayName?: string } | undefined): string {
  return author?.kind === 'person' ? shownNameOf(state, author.id ?? '') ?? 'Someone' : author?.displayName ?? author?.name ?? 'Lead'
}

/** A tag in a thread reply puts the thread back on the tagged person's Threads page, as in Slack: their Unfollow of it is cleared
 *  (follow back to no choice; updatedAt moves so their other devices read the change), in the write of the tag. A reply that tags
 *  nobody leaves an Unfollow as it is, and a send that tags nobody in a thread sends no command. At most MAX_MENTIONS ids a message,
 *  in one raw update by `_id`, which Prisma would send as $expr (hotFilters.test.ts). */
async function bringBackUnfollowed(tx: Tx, tabId: string, messages: MessageDraft[], now: number): Promise<void> {
  const ids = [...new Set(messages.flatMap(message => message.thread && message.thread !== message.id ? (message.mentions ?? []).map(personId =>
    stableId(tabId, message.conversationId, message.thread!, personId)) : []))]
  if (!ids.length) return
  const answer = await tx.$runCommandRaw({ update: 'SuperTabThreadMark', updates: [{ q: { _id: { $in: ids }, tabId, follow: false },
    u: { $set: { follow: null, updatedAt: { $date: new Date(now).toISOString() } } }, multi: true }] }) as { writeErrors?: unknown[] }
  if (answer.writeErrors?.length) throw new Error('The database refused some thread follows')
}

/** Any post by the tagged person in that conversation answers every earlier tag there, in a thread or not. */
export async function resolveByReply(tx: Tx, tabId: string, conversationId: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { tabId, conversationId, personId, createdAt: { lte: new Date(now) }, ...waiting },
    data: { resolvedAt: new Date(now), resolvedBy: 'reply' } })
}

/** A read mark moved to [sequence] resolves the person's waiting tags it passes: in the chat (threadId null) those shown there, in a
 *  thread those shown only in it (threadsOf, as Desktop's mentionUnread reads them). Most marks find no tag and stop after one read.
 *  A held tag (holdUntil) resolved before its time is never listed, as in resolveByReply (intended). */
export async function resolveRead(db: Tx | PrismaClient, input: { tabId: string; personId: string; conversationId: string; threadId: string | null;
  sequence: number; now: number }): Promise<number> {
  const { tabId, personId, conversationId, threadId, sequence, now } = input, tx = db as Tx
  const rows = await tx.superTabMention.findMany({ where: { tabId, personId, conversationId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS) }, ...waiting },
    select: { id: true, messageId: true }, orderBy: { createdAt: 'desc' }, take: 500 })
  if (!rows.length) return 0
  // By id through its index (parts/indexed.ts), never a Prisma `in` on a hot collection (hotFilters.test.ts).
  const messages = (await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(rows.map(r => r.messageId))] }, tabId,
    sequence: { $lte: sequence } } }, { $project: { conversationId: 1, thread: 1, alsoInChat: 1 } }]))
    .map(m => ({ id: m._id as string, conversationId: m.conversationId as string, thread: (m.thread as string | undefined) ?? null,
      alsoInChat: (m.alsoInChat as boolean | undefined) ?? null }))
  const threads = await threadsOf(tx, tabId, messages)
  const passed = new Set(messages.filter(m => (threads.get(m.id) ?? null) === threadId).map(m => m.id))
  return resolveIds(tx, tabId, personId, rows.filter(r => passed.has(r.messageId)).map(r => r.id), 'read', now)
}

/** Resolves these waiting tags of the person in one write, by their ids (at most the 500 a read takes): raw, since Prisma sends
 *  an `in` on this hot collection as $expr (hotFilters.test.ts). `resolvedAt: null` matches an unset one too. Answers how many. */
async function resolveIds(tx: Tx, tabId: string, personId: string, ids: string[], by: 'read' | 'answer', now: number): Promise<number> {
  if (!ids.length) return 0
  const answer = await tx.$runCommandRaw({ update: 'SuperTabMention', updates: [{ q: { _id: { $in: ids }, tabId, personId, resolvedAt: null },
    u: { $set: { resolvedAt: { $date: new Date(now).toISOString() }, resolvedBy: by } }, multi: true }] }) as { nModified?: number; writeErrors?: unknown[] }
  if (answer.writeErrors?.length) throw new Error('The database refused some tag resolves')
  return answer.nModified ?? 0
}

/** The agents a person's post answers: its recipients, and in their own Buddy chat also the coordinator of each project the Buddy
 *  relays to (every project they read for the Swarm chat, the chat's own for a project chat). */
export function answeredAgents(state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, group: Conversation, recipients: readonly string[]): string[] {
  const coordinators = !isBuddyChat(group) || !group.audience?.people.some(p => p.id === actor.userId) ? []
    : (isSwarmBuddyChat(group) ? projectsOf(state).filter(p => canReadProject(state, actor, p)) : [projectOf(state, group.projectId ?? 'lead')])
      .map(p => state.conversations.find(c => c.id === p.leadConversationId)?.leadId)
  return [...new Set([...recipients.filter(id => state.agents.some(a => a.id === id)), ...coordinators.filter((id): id is string => !!id)])]
}

/** A post to an agent answers every tag that agent made for the person, in any conversation. A held tag (holdUntil) resolved
 *  before its time is never listed, as in resolveByReply (intended). The agent that made a tag is in no index: the person's
 *  waiting tags are read once by theirs, as resolveRead reads them, and the agents' resolved in one write. */
export async function resolveByAnswer(tx: Tx, tabId: string, personId: string, agentIds: readonly string[], now: number): Promise<void> {
  if (!agentIds.length) return
  const answered = new Set(agentIds)
  const rows = await tx.superTabMention.findMany({ where: { tabId, personId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS), lte: new Date(now) }, ...waiting },
    select: { id: true, authorAgentId: true }, orderBy: { createdAt: 'desc' }, take: 500 })
  await resolveIds(tx, tabId, personId, rows.filter(row => answered.has(row.authorAgentId)).map(row => row.id), 'answer', now)
}

/** A worker took the group: its held tags are over. A listed one moves to Earlier; one not yet listed is dropped, as if never
 *  made. Run before [dropHeldTags] of the same command, which would drop the listed ones too. */
export async function resolveWhenWorked(tx: Tx, tabId: string, conversationId: string, now: number): Promise<void> {
  const held = { tabId, conversationId, holdUntil: { isSet: true as const }, ...waiting }
  await tx.superTabMention.updateMany({ where: { ...held, holdUntil: { lte: new Date(now) } }, data: { resolvedAt: new Date(now), resolvedBy: 'worker' } })
  await tx.superTabMention.deleteMany({ where: held })
}

/** The task was handled (leadAction in the state: any agent's route, start or assignment there, or its coordinator's post): the
 *  held tags made before that are dropped for good, listed or not.
 *  Dropped, not resolved, so a later reply or assignment cannot bring one back in Earlier. */
export async function dropHeldTags(tx: Tx, tabId: string, conversationId: string, now: number): Promise<void> {
  await tx.superTabMention.deleteMany({ where: { tabId, conversationId, holdUntil: { isSet: true }, createdAt: { lt: new Date(now) }, ...waiting } })
}

/** Whether a tag is listed: a held one only once its time has come, while its group still has no worker; one answered before
 *  it came up was never listed. */
function listed(row: { resolvedAt: Date | null; holdUntil?: Date | null }, group: Conversation, now: number): boolean {
  if (!row.holdUntil) return true
  if (row.resolvedAt) return row.resolvedAt >= row.holdUntil
  return now >= row.holdUntil.getTime() && !group.archived && !activeWork(group)
}

/** The tags a person's post in this conversation is about to answer (resolveByReply), for the leaderboard's credit
 *  (leaderboard/record.ts recordPost): only which message and when. */
export async function openTags(tx: Tx, tabId: string, conversationId: string, personId: string, now: number): Promise<Array<{ messageId: string; createdAt: number }>> {
  const rows = await tx.superTabMention.findMany({ where: { tabId, conversationId, personId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS), lte: new Date(now) },
    ...waiting }, select: { messageId: true, createdAt: true } })
  return rows.map(row => ({ messageId: row.messageId, createdAt: row.createdAt.getTime() }))
}

export async function readMention(tx: Tx, tabId: string, id: string): Promise<MentionTarget | undefined> {
  return await tx.superTabMention.findFirst({ where: { id, tabId }, select: { id: true, personId: true, conversationId: true } }) ?? undefined
}

/** Marking an answered tag done again keeps how it was answered. */
export async function markDone(tx: Tx, tabId: string, id: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { id, tabId, personId, ...waiting }, data: { resolvedAt: new Date(now), resolvedBy: 'done' } })
}

/** A person's unexpired tags in a Swarm, waiting or answered, newest first: the rows [readable] lists and counts. */
const tagRows = (tabId: string, personId: string, now: number, open: boolean | null) => ({
  where: { tabId, personId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS) }, ...(open === null ? {} : open ? waiting : { resolvedAt: { not: null } }) },
  orderBy: { createdAt: 'desc' as const }, take: 500,
})

/** The conversations of a person's waiting tags, newest tag first, once each: those [waitingMentions] may read beyond what a
 *  read holds, so a change poll can hold them per conversation (read/service.ts). */
export async function waitingTagConversations(tx: Tx, tabId: string, personId: string, now: number): Promise<string[]> {
  const rows = await tx.superTabMention.findMany({ ...tagRows(tabId, personId, now, true), select: { conversationId: true } })
  return [...new Set(rows.map(row => row.conversationId))]
}

/** The person's own unexpired tags in conversations they can still read, newest first, each with its conversation. The badge
 *  counts this same list. Ordinary loads leave quiet (dormant) conversations out of the state, so the ones a tag is in are
 *  read here: the count and the list check the same conversations whichever state they get.
 *  ponytail: capped at 500 per state; page it if a person ever gets more in 30 days. */
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean | null) {
  person(state, actor.userId)
  const rows = await tx.superTabMention.findMany(tagRows(tabId, actor.userId, now, open))
  const groups = new Map(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(rows.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    // By id through its index (parts/indexed.ts): every person's read counts these on each poll.
    for (const row of await groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } }, { $project: { _id: 0, key: 1,
      data: { kind: 1, projectId: 1, audience: 1, archived: 1, assignment: { status: 1 } } } }])) {
      groups.set(row.key as string, row.data as unknown as Conversation)
    }
  }
  return rows.flatMap(row => {
    const group = groups.get(row.conversationId)
    return group && !isLeads(group) && canReadGroup(state, actor, group) && listed(row, group, now) ? [{ row, group }] : []
  })
}

export async function mentionsWaiting(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number): Promise<number> {
  return (await waitingMentions(tx, tabId, state, actor, now)).count
}

/** A person's waiting tags: how many, and a digest of which, as decisions.ts decisionsWaiting. A client reads its lists again
 *  when either moves (a tag made, answered or expired, though the count may stay), not on every change of the Swarm. Only
 *  the person's own tags they can still read go into it, and only their ids. */
export async function waitingMentions(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>,
  now: number): Promise<{ count: number; digest: string }> {
  const ids = (await readable(tx, tabId, state, actor, now, true)).map(({ row }) => row.id).sort()
  return { count: ids.length, digest: mentionsDigest(ids) }
}

/** Which of these Swarms hold a waiting tag for the person, by one plain match (the index on tabId, personId, createdAt
 *  bounds it; Prisma would send `in` as an $expr that no index can). Raw, so a Swarm list counts a page of Swarms at once. */
export const swarmsWithTags = (tabIds: string[], personId: string, now: number) => [{ $match: { tabId: { $in: tabIds }, personId, resolvedAt: null,
  createdAt: { $gt: { $date: new Date(now - MENTION_EXPIRY_MS).toISOString() } } } }, { $group: { _id: '$tabId' } }]

/** The digest of a sorted list of waiting tag ids; a Swarm with none has this one. */
export function mentionsDigest(ids: string[]): string {
  return createHash('sha256').update(ids.join('\n')).digest('base64url').slice(0, 16)
}

export async function listMentions(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  const tagged = await readable(tx, tabId, state, actor, now, open)
  // By id with a plain `$in` (parts/indexed.ts readBy): Prisma's `id: { in }` goes as an `$expr` OR of one branch per id, which
  // planned slowly (1,640 ms on prod, Ken's scan of 2026-11-04, task #2674).
  const messages = tagged.length ? (await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(tagged.map(t => t.row.messageId))] }, tabId } },
    { $project: { text: 1, author: 1, conversationId: 1, thread: 1, alsoInChat: 1, sequence: 1 } }])).map(r => ({ id: r._id as string,
    text: r.text as string, author: r.author, conversationId: r.conversationId as string, thread: (r.thread as string | undefined) ?? null,
    alsoInChat: (r.alsoInChat as boolean | undefined) ?? null, sequence: r.sequence as number })) : []
  const threads = await threadsOf(tx, tabId, messages)
  return tagged.map(({ row, group }) => {
    const message = messages.find(m => m.id === row.messageId)
    const author = message?.author as { kind?: string; name?: string; displayName?: string } | undefined
    const authorName = taggerName(state, author && { ...author, id: row.authorAgentId })
    return { id: row.id, projectId: row.projectId, projectName: projectOf(state, group.projectId ?? 'lead').name,
      conversationId: row.conversationId, conversationTitle: group.title, messageId: row.messageId,
      leadId: row.authorAgentId, leadName: authorName, text: (message?.text ?? '').slice(0, 200),
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy, threadId: message ? threads.get(message.id) ?? null : null,
      // Where the tagged message is in its chat: Desktop clears its red number once the reader has read past it (Slack).
      messageSequence: message?.sequence ?? null }
  })
}

/** A thread a person's own tag is in: the tagged message's thread (a reply's root, or a root itself), in the tag's conversation. */
export interface TaggedThread { conversationId: string; threadId: string; at: number }

/** The threads the person's own unexpired tags are in, waiting or answered, newest tag first, once each, at most `limit` of those
 *  `keep` accepts (the caller's own filters apply before the count, so threads it drops never use up the limit) (the
 *  Threads list, read/followedThreads.ts: a tag in a chat they never opened has no thread mark, so no other read finds it). Only
 *  tags [readable] lists: conversations they can read, never a held Lead notice before its time. A message is taken only in the
 *  conversation its tag names, and only its thread id leaves here, so a tag never names a thread of another chat. Its root
 *  and replies are read and checked by the caller. The tags by one indexed read of at most 500 rows (tagRows), their messages by id
 *  in one more. */
export async function taggedThreads(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number,
  limit: number, keep: (thread: TaggedThread) => boolean = () => true): Promise<TaggedThread[]> {
  const tagged = await readable(tx, tabId, state, actor, now, null)
  if (!tagged.length) return []
  const found = await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(tagged.map(t => t.row.messageId))] }, tabId } },
    { $project: { conversationId: 1, thread: 1 } }])
  const messages = new Map(found.map(r => [r._id as string, r]))
  const seen = new Set<string>()
  const threads: TaggedThread[] = []
  for (const { row } of tagged) {
    const message = messages.get(row.messageId)
    const threadId = typeof message?.thread === 'string' ? message.thread : null
    if (!threadId || message!.conversationId !== row.conversationId) continue
    const key = `${row.conversationId}\u0000${threadId}`
    if (seen.has(key)) continue
    seen.add(key)
    const thread = { conversationId: row.conversationId, threadId, at: row.createdAt.getTime() }
    if (!keep(thread)) continue
    threads.push(thread)
    if (threads.length >= limit) break
  }
  return threads
}

/** For each tagged message that is a thread reply only (not also sent to the chat), its thread's root: the tag belongs to the
 *  thread, not the chat's main stream (Desktop counts it on Threads, as Slack does). Only a root the person may read, in the
 *  tag's own conversation, roots its own thread: an agent-only or delivered-copy root reads as none, so the tag counts as the
 *  chat's and no root id they cannot open leaves here. The roots by id in one read. */
async function threadsOf(tx: Tx, tabId: string, messages: Array<{ id: string; conversationId: string; thread: string | null; alsoInChat: boolean | null }>):
  Promise<Map<string, string>> {
  const replies = messages.filter(m => m.thread && m.thread !== m.id && m.alsoInChat !== true)
  if (!replies.length) return new Map()
  const found = await readBy(tx, 'SuperTabMessage', 'id', [{ $match: { _id: { $in: [...new Set(replies.map(m => m.thread!))] }, tabId } },
    { $project: { conversationId: 1, thread: 1, source: 1, recipientIds: 1 } }])
  const roots = found.map(r => ({ id: r._id as string, conversationId: r.conversationId as string, thread: r.thread, source: r.source ?? null,
    recipientIds: (r.recipientIds as string[] | undefined) ?? [] })).filter(r => r.thread === r.id && !agentOnly(r.source, r.recipientIds))
  const copies = await deliveredCopies(tx, tabId, roots)
  const shown = new Map(roots.filter(r => !copies.has(r.id)).map(r => [r.id, r.conversationId]))
  return new Map(replies.filter(m => shown.get(m.thread!) === m.conversationId).map(m => [m.id, m.thread!]))
}
