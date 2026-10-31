/** A person, or any agent of the project but a Buddy, tags people in a message; each tag waits in the person's Swarm-wide list
 *  until they reply in that conversation or mark it done. Tags live in SuperTabMention, never in the tab state, so an older backend still
 *  reads and writes a tab that has them. Called inside SuperTabStore's transactions. */
import { createHash } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { ensureIndex } from '../lib/db/indexes.js'
import { activeWork, agentOnly, fail, isLeads, person, stableId, type Actor, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, projectAgent, projectOf } from './projects.js'
import { groupsBy, readBy } from './parts/indexed.js'
import { deliveredCopies } from './pageReads.js'
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
  if (isLeads(group)) return false
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

export async function writeMentions(tx: Tx, tabId: string, state: SuperTabState, messages: MessageDraft[], now: number): Promise<void> {
  const data = messages.flatMap(message => (message.mentions ?? []).map(personId => ({
    id: stableId(tabId, message.id, personId), tabId, personId, projectId: state.conversations.find(c => c.id === message.conversationId)!.projectId ?? 'lead',
    conversationId: message.conversationId, messageId: message.id, authorAgentId: message.author.id,
    createdAt: new Date(now), resolvedAt: null, resolvedBy: null, ...(message.holdMentions ? { holdUntil: new Date(now + NO_WORKER_GRACE_MS) } : {}),
  })))
  if (data.length) await tx.superTabMention.createMany({ data })
}

/** Any post by the tagged person in that conversation answers every earlier tag there, in a thread or not. */
export async function resolveByReply(tx: Tx, tabId: string, conversationId: string, personId: string, now: number): Promise<void> {
  await tx.superTabMention.updateMany({ where: { tabId, conversationId, personId, createdAt: { lte: new Date(now) }, ...waiting },
    data: { resolvedAt: new Date(now), resolvedBy: 'reply' } })
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
const tagRows = (tabId: string, personId: string, now: number, open: boolean) => ({
  where: { tabId, personId, createdAt: { gt: new Date(now - MENTION_EXPIRY_MS) }, ...(open ? waiting : { resolvedAt: { not: null } }) },
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
async function readable(tx: Tx, tabId: string, state: SuperTabState, actor: Extract<Actor, { kind: 'person' }>, now: number, open: boolean) {
  person(state, actor.userId)
  const rows = await tx.superTabMention.findMany(tagRows(tabId, actor.userId, now, open))
  const groups = new Map(state.conversations.map(c => [c.id, c]))
  const missing = [...new Set(rows.map(r => r.conversationId))].filter(id => !groups.has(id))
  if (missing.length) {
    // By id through its index (parts/indexed.ts): every person's read counts these on each poll.
    for (const row of await groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: missing } } }, { $project: { _id: 0, key: 1, data: 1 } }])) {
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
  const messages = tagged.length ? await tx.superTabMessage.findMany({ where: { tabId, id: { in: tagged.map(t => t.row.messageId) } },
    select: { id: true, text: true, author: true, conversationId: true, thread: true, alsoInChat: true, sequence: true } }) : []
  const threads = await threadsOf(tx, tabId, messages)
  return tagged.map(({ row, group }) => {
    const message = messages.find(m => m.id === row.messageId)
    const author = message?.author as { kind?: string; name?: string; displayName?: string } | undefined
    // A person's name in a message is their email: the inbox shows their username, as everywhere in the Swarm.
    const authorName = author?.kind === 'person' ? usernameOf(state, row.authorAgentId) ?? 'Someone' : author?.displayName ?? author?.name ?? 'Lead'
    return { id: row.id, projectId: row.projectId, projectName: projectOf(state, group.projectId ?? 'lead').name,
      conversationId: row.conversationId, conversationTitle: group.title, messageId: row.messageId,
      leadId: row.authorAgentId, leadName: authorName, text: (message?.text ?? '').slice(0, 200),
      createdAt: row.createdAt, resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy, threadId: message ? threads.get(message.id) ?? null : null,
      // Where the tagged message is in its chat: Desktop clears its red number once the reader has read past it (Slack).
      messageSequence: message?.sequence ?? null }
  })
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
