/** Every question for a person is a Decision (anh Dee, 11-07, task #4623): they see every question for them, from every project,
 *  in one place. An agent's chat post that tags a person and asks something is refused, naming decision.ask; a reply to that
 *  person's own message stays a conversation with them. */
import { isBuddy, isBuddyChat } from './buddies.js'
import { fail, type Actor, type Author, type Conversation, type SuperTabState } from './model.js'

export const QUESTION_FOR_PERSON = 'A question for a person goes to their Decisions, where they see every question from every project: '
  + 'ask it with decision.ask (2 to 5 options, your pick, what it unblocks). Tag them in a chat only to tell them something.'

/** Whether [text] asks something: a question mark outside a link or code, where one is only part of an address or an example. */
export function asksSomething(text: string): boolean {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/\bhttps?:\/\/\S+/g, ' ').includes('?')
}

/** Refuses [actor]'s post in [group] that tags people in [tagged] with a question, unless it answers [reply], a message of the
 *  one person it tags. Never a person's post, a Buddy's in its chat, or an agent's note no person sees. */
export function refuseTaggedQuestion(state: SuperTabState, actor: Actor, group: Conversation, tagged: readonly string[], text: string,
  reply: { author: Pick<Author, 'kind' | 'id'> } | undefined): void {
  if (actor.kind !== 'agent' || isBuddyChat(group) || state.agents.some(a => a.id === actor.agentId && isBuddy(a))) return
  const answering = reply?.author.kind === 'person' ? reply.author.id : null
  if (tagged.some(id => id !== answering) && asksSomething(text)) fail('QUESTION_FOR_PERSON', QUESTION_FOR_PERSON, 400)
}
