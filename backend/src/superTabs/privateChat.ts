/** A person's private chat with their own agent is theirs and its alone (anh Dee, 11-07, task #4547): River and Theo showed up
 *  in his, as a Lead's private lines and proposal notices were written there. Checked on every command's messages
 *  (commands.ts applyCommand) and again at the write every message takes (store.ts writeMessages, native.ts), so no path
 *  writes there as anyone else. What needs the person goes to their Decisions, and progress to its card. */
import { isBuddy, isBuddyChat } from './buddies.js'
import { fail, type Agent, type Author, type Conversation, type MessageDraft, type SuperTabState } from './model.js'

/** The Swarm's own lines about a person's Buddy, machines and account, in their chat: never a person's or a Lead's words. They are
 *  written as the chat's own Buddy, the agent that tells its person; with none there, as Harness itself (SWARM_AUTHOR), so a
 *  contributor still hears that their machine or account is used (AGENTS.md: never drained without them knowing). */
const SWARM_LINES: ReadonlySet<string> = new Set(['system', 'others-work-notice', 'pm-switch-notice', 'buddy-session-ended', 'computer-moved'])

export const SWARM_AUTHOR: Author = { kind: 'agent', id: 'harness', name: 'Harness', membershipGeneration: 'harness' }

const sourceKind = (draft: Pick<MessageDraft, 'source'>): string => String((draft.source as { kind?: unknown } | null | undefined)?.kind ?? 'message')

/** [chat]'s person's own Buddy there: its main Buddy first, else one of its sessions. */
function chatBuddy(state: SuperTabState, chat: Conversation): Agent | undefined {
  const owners = chat.audience?.people ?? []
  const theirs = state.agents.filter(a => chat.agentIds.includes(a.id) && isBuddy(a)
    && owners.some(p => p.id === a.buddyOf!.personId && p.generation === a.buddyOf!.generation))
  return theirs.find(a => !a.buddySession) ?? theirs[0]
}

/** [drafts] as they may be written: a row into a person's Buddy chat stays when that person or their own Buddy wrote it, and a
 *  Swarm line there is written as the chat's own Buddy, else as Harness. Anything else there is refused, naming only the row's
 *  kind, never its words. */
export function checkPrivateChat<T extends Pick<MessageDraft, 'conversationId' | 'author' | 'source'>>(state: SuperTabState, drafts: readonly T[]): T[] {
  return drafts.map(draft => {
    const chat = state.conversations.find(c => c.id === draft.conversationId)
    if (!chat || !isBuddyChat(chat)) return draft
    const owners = chat.audience?.people ?? []
    const { kind, id } = draft.author
    const theirs = kind === 'person' ? owners.some(p => p.id === id)
      : state.agents.some(a => a.id === id && isBuddy(a) && owners.some(p => p.id === a.buddyOf!.personId && p.generation === a.buddyOf!.generation))
    const what = sourceKind(draft)
    if (theirs || (SWARM_LINES.has(what) && id === SWARM_AUTHOR.id)) return draft
    if (!SWARM_LINES.has(what)) {
      fail('PRIVATE_CHAT', `A person's chat with their own agent is theirs alone, so this ${what} is not written there. Ask them with decision.ask, or post in the project chat.`, 403)
    }
    const buddy = chatBuddy(state, chat)
    return { ...draft, author: buddy ? { kind: 'agent' as const, id: buddy.id, name: buddy.name, ...buddy.displayName ? { displayName: buddy.displayName } : {},
      membershipGeneration: buddy.membershipGeneration } : SWARM_AUTHOR }
  })
}
