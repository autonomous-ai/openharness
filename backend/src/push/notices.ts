import type { MessageDraft, SuperTabState } from '../superTabs/model.js'
import { actorName } from '../superTabs/activity.js'
import { taggerName } from '../superTabs/mentions.js'
import { projectsOf } from '../superTabs/projects.js'
import { isSwarmBuddyChat } from '../superTabs/buddies.js'
import type { PhoneNotice } from './sender.js'

/** Why a reply's row tells its person (activity.ts writeReplyActivity): they started the thread, wrote the message it
 *  quotes, were tagged in the thread, or only replied in it. */
export type ReplyReason = 'starter' | 'quoted' | 'tagged' | 'replier'
/** A reply's Activity row as writeReplyActivity wrote it: who it tells, whose reply, why, and when. */
export interface ReplyRow {
  id: string; personId: string; conversationId: string; messageId: string; threadId: string; actorKind: string; actorId: string
  why: ReplyReason; createdAt: Date
}
/** A tag's row as writeMentions wrote it; `holdUntil` while it waits for a quiet chat's grace. */
export interface TagRow { id: string; personId: string; conversationId: string; messageId: string; holdUntil?: Date }
/** A decision a write asked of a person, new in that write (decisions.ts writeDecisions). */
export interface DecisionRow { id: string; personId: string; conversationId: string; askerAgentId: string }

/** The phone's notice body (mobile lib/swarm/swarm_notices.dart): a notice can be read on a locked phone, so it never says
 *  what was written. */
const BODY = 'Open Harness to read it.'
/** A decision's, as the app's own (swarm_notices.dart swarmNotice). */
const ANSWER = 'Open Harness to answer.'

/** Whom a reply's push tells, of those its Activity row tells (task #3248, Tony's rule): a reply in a thread they started,
 *  a reply to their own message, or one in a thread they were tagged in. A person who only replied in the thread reads it in
 *  Activity, with no push. */
const PUSHED: ReadonlySet<ReplyReason> = new Set(['starter', 'quoted', 'tagged'])

const e = encodeURIComponent
/** The phone's `swarm:` payload (mobile lib/notify/system_notices.dart encodeSwarmPayload), each part URI-encoded. */
function linkOf(tabId: string, conversationId: string, messageId: string, threadId: string | null): string {
  return `swarm:${e(tabId)}/${e(conversationId)}/message/${e(messageId)}${threadId ? `/thread/${e(threadId)}` : ''}`
}

/** The one notification a thread's replies share on a phone (task #3248): the app's own reply notices use it too
 *  (mobile lib/swarm/swarm_notices.dart threadSlot). */
export const threadSlot = (tabId: string, conversationId: string, threadId: string) => `thread:${tabId}:${conversationId}:${threadId}`

/**
 * What one write tells phones (tasks #2905, #3248): a notice for each reply row and tag row it wrote, and each decision it
 * asked, worded and keyed as the phone's own notices are, so the phone shows one or the other, never both. Who is told was
 * decided with the rows (#2954: muted chats and Unfollow write no reply row; a tag always tells); of a reply's rows, only
 * those Tony's rule pushes (PUSHED), and never for a Swarm line in a thread (a row with a source), which stays in Activity.
 * A tag held for a quiet chat is not news yet. Of one ask's decisions to a person, only the first sounds.
 */
export function phoneNotices(tabId: string, state: SuperTabState, written: { replies: ReplyRow[]; tags: TagRow[]; decisions?: DecisionRow[] },
  messages: MessageDraft[]): PhoneNotice[] {
  const byId = new Map(messages.map(m => [m.id, m]))
  // Where it is, as the phone names it; none for a person's Swarm Buddy chat, which belongs to no project. Never throws: this
  // runs inside the write (projects.ts groupProject refuses a Buddy chat, security review 2).
  const project = (conversationId: string) => {
    const group = state.conversations.find(c => c.id === conversationId)
    if (!group || isSwarmBuddyChat(group)) return ''
    return projectsOf(state).find(p => p.id === (group.projectId ?? 'lead'))?.name ?? ''
  }
  const replies = written.replies.filter(row => PUSHED.has(row.why) && !byId.get(row.messageId)?.source).map((row): PhoneNotice => ({
    personId: row.personId, key: `reply:${tabId}:${row.id}`,
    title: `${actorName(state, row.actorKind, row.actorId, byId.get(row.messageId)?.author)} replied in a thread`,
    subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, row.threadId),
    slot: threadSlot(tabId, row.conversationId, row.threadId),
    thread: { tabId, conversationId: row.conversationId, threadId: row.threadId, rowId: row.id, at: row.createdAt.getTime() },
  }))
  const tags = written.tags.filter(row => !row.holdUntil).flatMap((row): PhoneNotice[] => {
    const message = byId.get(row.messageId)
    if (!message) return []
    // A tag in a reply only in its thread opens that thread (swarm_notices.dart).
    const thread = message.thread && message.thread !== message.id && !message.alsoInChat ? message.thread : null
    const key = `mention:${row.id}`
    return [{ personId: row.personId, key, title: `${taggerName(state, message.author)} tagged you`,
      subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, thread), slot: key }]
  })
  const asked = new Set<string>()
  const decisions = (written.decisions ?? []).map((row): PhoneNotice => {
    // As the app names the asker (decisions.ts listDecisions askerName).
    const asker = state.agents.find(a => a.id === row.askerAgentId)
    const key = `decision:${row.id}`
    const first = !asked.has(row.personId)
    asked.add(row.personId)
    return { personId: row.personId, key, title: `${asker?.displayName ?? asker?.name ?? 'Agent'} asks you`, subtitle: project(row.conversationId),
      body: ANSWER, link: `swarm:${e(tabId)}/${e(row.conversationId)}/decision/${e(row.id)}`, slot: key, ...first ? {} : { quiet: true as const } }
  })
  return [...replies, ...tags, ...decisions]
}
