import { stableId, type MessageDraft, type SuperTabState } from '../superTabs/model.js'
import { actorName } from '../superTabs/activity.js'
import { taggerName } from '../superTabs/mentions.js'
import { isAgentChat, projectChannels, projectsOf } from '../superTabs/projects.js'
import { agentDisplayName } from '../superTabs/agentNames.js'
import { isSwarmBuddyChat } from '../superTabs/buddies.js'
import type { PhoneNotice } from './sender.js'

/** A reply's Activity row as writeReplyActivity wrote it: who it tells, whose reply, and whether it rings their phone. */
export interface ReplyRow {
  id: string; personId: string; conversationId: string; messageId: string; threadId: string; actorKind: string; actorId: string
  rings?: true
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

const e = encodeURIComponent
/** The phone's `swarm:` payload (mobile lib/notify/system_notices.dart encodeSwarmPayload), each part URI-encoded. */
function linkOf(tabId: string, conversationId: string, messageId: string, threadId: string | null): string {
  return `swarm:${e(tabId)}/${e(conversationId)}/message/${e(messageId)}${threadId ? `/thread/${e(threadId)}` : ''}`
}

/** The one notification of a thread's replies on a phone (task #3248): the app's own reply notice uses it too (mobile
 *  lib/swarm/swarm_notices.dart threadSlot), so the phone shows one or the other. */
export const threadSlot = (tabId: string, conversationId: string, threadId: string) => `thread:${tabId}:${conversationId}:${threadId}`

/** The one notification a task's questions share on a phone (task #3607): a decision asked of the person, and the app's own
 *  "stuck" and "needs you" for the same task, show in this slot, so a later one replaces the earlier (mobile
 *  lib/swarm/swarm_notices.dart swarmTaskSlot). */
export const taskSlot = (tabId: string, conversationId: string) => `task:${tabId}:${conversationId}`

/**
 * What one write tells phones (tasks #2905, #3248): a notice for each reply row that rings, each tag row it wrote, and each
 * decision it asked, worded and keyed as the phone's own notices are, so the phone shows one or the other, never both. Who
 * is told was decided with the rows (#2954: muted chats and Unfollow write no reply row; a tag always tells). A reply rings
 * only as its row says (activity.ts writeReplyActivity, Tony's rule of 2026-11-09): a thread's starter, once, for the first
 * person's reply there; every other reply stays in Activity and the badge. Only a person's tag rings (task #3607): an
 * agent's stays in Activity and the badge, whatever it says. A tag held for a quiet chat is not news yet. Of one ask's
 * decisions to a person, only the first sounds; all of a task's decisions share one notification slot (taskSlot).
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
  // Tony's rule (task #3607): a phone rings when a person speaks to its person, or when work waits on them (a decision). An
  // agent's reply or tag stays in Activity and the badge. By the event's kind (who wrote it), never by its words.
  const replies = written.replies.filter(row => row.rings).map((row): PhoneNotice => ({
    personId: row.personId, key: `reply:${tabId}:${row.id}`,
    title: `${actorName(state, row.actorKind, row.actorId, byId.get(row.messageId)?.author)} replied in a thread`,
    subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, row.threadId),
    slot: threadSlot(tabId, row.conversationId, row.threadId),
  }))
  const channels = projectChannels(state)
  const tags = written.tags.filter(row => !row.holdUntil).flatMap((row): PhoneNotice[] => {
    const message = byId.get(row.messageId)
    if (!message || message.author.kind !== 'person') return []
    // A tag in a reply only in its thread opens that thread (swarm_notices.dart).
    const thread = message.thread && message.thread !== message.id && !message.alsoInChat ? message.thread : null
    const key = `mention:${row.id}`
    return [{ personId: row.personId, key, title: `${taggerName(state, message.author)} tagged you`,
      subtitle: project(row.conversationId), body: BODY, link: linkOf(tabId, row.conversationId, row.messageId, thread), slot: key,
      // A tag in a chat its person muted rings nothing; that is read as it is sent, not in the write (push/muted.ts). A
      // project's channel's mute does not hold (projects.ts projectChannels), so its tag carries no setting to weigh.
      ...channels.has(row.conversationId) ? {} : { setting: stableId(tabId, row.conversationId, row.personId, 'notify') } }]
  })
  const asked = new Set<string>()
  const decisions = (written.decisions ?? []).map((row): PhoneNotice => {
    // As the app names the asker (decisions.ts listDecisions askerName).
    const asker = state.agents.find(a => a.id === row.askerAgentId)
    const key = `decision:${row.id}`
    const first = !asked.has(row.personId)
    asked.add(row.personId)
    return { personId: row.personId, key, title: `${asker?.displayName ?? asker?.name ?? 'Agent'} asks you`, subtitle: project(row.conversationId),
      body: ANSWER, link: `swarm:${e(tabId)}/${e(row.conversationId)}/decision/${e(row.id)}`, slot: taskSlot(tabId, row.conversationId),
      ...first ? {} : { quiet: true as const } }
  })
  return [...replies, ...tags, ...decisions, ...chatNotices(tabId, state, messages)]
}

/**
 * Swarm v4 (anh Dee, 2026-11-10): an agent reaches its person in their 1:1 chat, so its own words there ring that person, unless
 * they muted the chat (push/muted.ts). One notice per chat a write posts in, for its newest words, under the phone's own key
 * and slot for that chat (mobile lib/swarm/swarm_notices.dart announceChat), so the app's "New messages" notice and the push
 * are one notification. Only what the agent wrote: never a row the server writes in its name (one with a source, which is
 * every row only agents read too); and only to the person listed on the chat while they are still in the Swarm at that generation.
 */
function chatNotices(tabId: string, state: SuperTabState, messages: MessageDraft[]): PhoneNotice[] {
  const told = new Map<string, PhoneNotice>()
  for (const message of messages) {
    if (message.author.kind !== 'agent' || message.source) continue
    const group = state.conversations.find(c => c.id === message.conversationId)
    if (!group || !isAgentChat(group) || !group.agentIds.includes(message.author.id)) continue
    const listed = group.audience?.people[0]
    const to = listed && state.people.find(p => p.id === listed.id && p.generation === listed.generation)
    if (!to) continue
    const key = `chat:${tabId}:${group.id}`
    const thread = message.thread && message.thread !== message.id && !message.alsoInChat ? message.thread : null
    told.set(group.id, { personId: to.id, key, slot: key, title: `${agentDisplayName(state.agents, message.author.id) ?? 'Agent'} wrote to you`,
      subtitle: '', body: BODY, link: linkOf(tabId, group.id, message.id, thread), setting: stableId(tabId, group.id, to.id, 'notify') })
  }
  return [...told.values()]
}
