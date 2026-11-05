import type { MessageDraft, SuperTabState } from '../superTabs/model.js'
import { actorName } from '../superTabs/activity.js'
import { taggerName } from '../superTabs/mentions.js'
import { groupProject } from '../superTabs/projects.js'
import type { PhoneNotice } from './sender.js'

/** A reply's Activity row as writeReplyActivity wrote it: who it tells, and whose reply. */
export interface ReplyRow { id: string; personId: string; conversationId: string; messageId: string; threadId: string; actorKind: string; actorId: string }
/** A tag's row as writeMentions wrote it; `holdUntil` while it waits for a quiet chat's grace. */
export interface TagRow { id: string; personId: string; conversationId: string; messageId: string; holdUntil?: Date }

/** The phone's notice body (mobile lib/swarm/swarm_notices.dart): a notice can be read on a locked phone, so it never says
 *  what was written. */
const BODY = 'Open Harness to read it.'

/** The phone's `swarm:` payload (mobile lib/notify/system_notices.dart encodeSwarmPayload), each part URI-encoded. */
function linkOf(tabId: string, conversationId: string, messageId: string, threadId: string | null): string {
  const e = encodeURIComponent
  return `swarm:${e(tabId)}/${e(conversationId)}/message/${e(messageId)}${threadId ? `/thread/${e(threadId)}` : ''}`
}

/**
 * What one write tells phones (task #2905): a notice for each reply row and each tag row it wrote, worded and keyed as the
 * phone's own notices are, so the phone shows one or the other, never both. Who is told was decided with the rows (#2954:
 * muted chats and Unfollow write no reply row; a tag always tells). A tag held for a quiet chat is not news yet.
 */
export function phoneNotices(tabId: string, state: SuperTabState, written: { replies: ReplyRow[]; tags: TagRow[] }, messages: MessageDraft[]): PhoneNotice[] {
  const byId = new Map(messages.map(m => [m.id, m]))
  const project = (conversationId: string) => {
    const group = state.conversations.find(c => c.id === conversationId)
    return group ? groupProject(state, group).name : ''
  }
  const replies = written.replies.map(row => ({
    personId: row.personId, key: `reply:${tabId}:${row.id}`,
    title: `${actorName(state, row.actorKind, row.actorId, byId.get(row.messageId)?.author)} replied in a thread`,
    subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, row.threadId),
  }))
  const tags = written.tags.filter(row => !row.holdUntil).flatMap(row => {
    const message = byId.get(row.messageId)
    if (!message) return []
    // A tag in a reply only in its thread opens that thread (swarm_notices.dart).
    const thread = message.thread && message.thread !== message.id && !message.alsoInChat ? message.thread : null
    return [{ personId: row.personId, key: `mention:${row.id}`, title: `${taggerName(state, message.author)} tagged you`,
      subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, thread) }]
  })
  return [...replies, ...tags]
}
