import { stableId, type MessageDraft, type SuperTabState } from '../superTabs/model.js'
import { isAgentChat } from '../superTabs/projects.js'
import type { PhoneNotice } from './sender.js'

/** The phone's notice body (mobile lib/swarm/swarm_notices.dart): a notice can be read on a locked phone, so it never says
 *  what was written. */
const BODY = 'Open Harness to read it.'

const e = encodeURIComponent
/** The phone's `swarm:` payload (mobile lib/notify/system_notices.dart encodeSwarmPayload), each part URI-encoded. */
function linkOf(tabId: string, conversationId: string, messageId: string, threadId: string | null): string {
  return `swarm:${e(tabId)}/${e(conversationId)}/message/${e(messageId)}${threadId ? `/thread/${e(threadId)}` : ''}`
}

/**
 * Swarm v4 (anh Dee, 2026-11-10): an agent reaches its person in their 1:1 chat, so its own words there ring that person, unless
 * they muted the chat (push/muted.ts). One notice per chat a write posts in, for its newest words, under the phone's own key
 * and slot for that chat (mobile lib/swarm/swarm_notices.dart announceChat), so the app's "New messages" notice and the push
 * are one notification. It sounds once until the person reads the chat: one sent while their read mark is behind what the chat
 * held before this write, as [before] holds it, is quiet (push/unread.ts), as the app's own is. Only the agent's own post (`post`), never a row the
 * server writes in its name; only to the person listed on the chat while they are still in the Swarm at that generation, and
 * only from their own agent, on their own account, as the chat's readers are (projects.ts readsAgentChat).
 */
export function chatNotices(tabId: string, state: SuperTabState, messages: MessageDraft[], before: SuperTabState): PhoneNotice[] {
  const newest = new Map<string, MessageDraft>()
  for (const message of messages) if (message.author.kind === 'agent' && message.post) newest.set(message.conversationId, message)
  return [...newest.values()].flatMap((message): PhoneNotice[] => {
    const group = state.conversations.find(c => c.id === message.conversationId)
    if (!group || !isAgentChat(group) || !group.agentIds.includes(message.author.id)) return []
    const listed = group.audience?.people[0]
    const to = listed && state.people.find(p => p.id === listed.id && p.generation === listed.generation)
    const agent = state.agents.find(a => a.id === message.author.id)
    if (!to || agent?.contributorId !== to.id || agent.machineOwnerId !== to.id) return []
    const key = `chat:${tabId}:${group.id}`
    const thread = message.thread && message.thread !== message.id && !message.alsoInChat ? message.thread : null
    // The chat's newest main row before this write, as the write found it: a chat new in this write had none.
    const held = before.conversations.find(c => c.id === group.id)?.lastMainSequence ?? 0
    return [{ personId: to.id, key, slot: key, title: `${agent.displayName ?? agent.name} wrote to you`, subtitle: '',
      body: BODY, link: linkOf(tabId, group.id, message.id, thread), setting: stableId(tabId, group.id, to.id, 'notify'),
      ...held > 0 ? { unreadBefore: { mark: stableId(tabId, group.id, to.id), tabId, conversationId: group.id, sequence: held } } : {} }]
  })
}
