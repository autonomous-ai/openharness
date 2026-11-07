/** A person's private chat with their own agent is theirs and its alone (anh Dee, 11-07, task #4547): River and Theo showed up
 *  in his, as a Lead's private lines and proposal notices were written there. Checked at the write every message takes
 *  (store.ts writeMessages, native.ts), so no path can write there as anyone else. What needs the person goes to their
 *  Decisions, and progress to its card. */
import { isBuddy, isBuddyChat } from './buddies.js'
import { fail, type MessageDraft, type SuperTabState } from './model.js'

/** Refuses a row into a person's Buddy chat unless its author is that person or one of their own Buddies. Only the source's
 *  kind is named, never its words. */
export function checkPrivateChat(state: SuperTabState, drafts: readonly Pick<MessageDraft, 'conversationId' | 'author' | 'source'>[]): void {
  for (const draft of drafts) {
    const chat = state.conversations.find(c => c.id === draft.conversationId)
    if (!chat || !isBuddyChat(chat)) continue
    const owners = chat.audience?.people ?? []
    const { kind, id } = draft.author
    const theirs = kind === 'person' ? owners.some(p => p.id === id)
      : state.agents.some(a => a.id === id && isBuddy(a) && owners.some(p => p.id === a.buddyOf!.personId && p.generation === a.buddyOf!.generation))
    if (!theirs) {
      const what = String((draft.source as { kind?: unknown } | null | undefined)?.kind ?? 'message')
      fail('PRIVATE_CHAT', `A person's chat with their own agent is theirs alone, so this ${what} is not written there. Ask them with decision.ask, or post in the project chat.`, 403)
    }
  }
}
