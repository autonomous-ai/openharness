import { agentOnly, pullRequestLinks, type Conversation, type MessageDraft } from './model.js'

/**
 * Live cards (Slack parity, Dee 10-29): like a Slack app's message that updates itself, a task or a pull request is one
 * message in its conversation, drawn as a card that changes in place, and later events go in that message's thread.
 * The group names its card messages; clients draw them from the group state they already read, so a card reaches only
 * readers of its own conversation, and its pull request facts come from each reader's own GitHub (Desktop). A card names
 * only messages of its own group: no other conversation is ever looked up for it.
 */
export interface GroupCards {
  /** The message that is the task card: its newest brief. */
  task?: string
  /** Each linked pull request's card: the first main-chat message that linked it, and when a merge was recorded. */
  pullRequests?: PullRequestCard[]
}
export interface PullRequestCard { url: string; messageId: string; mergedAt?: number }

/** Rows that may become a card: an agent's or person's own post, or the system's line. A celebration, a route or another
 *  structured row has its own drawing. */
const cardable = (message: MessageDraft) => !message.source || message.source.kind === 'system'

/** [brief] is [group]'s newest brief: it is the task card from now on. */
export function bindTaskCard(group: Conversation, brief: MessageDraft): void {
  group.cards = { ...group.cards, task: brief.id }
}

/** A main-chat row linking a pull request this group has no card for becomes its card. A thread reply or an agent-only
 *  notice never does: people read the main chat. */
export function bindPullRequestCards(group: Conversation, message: MessageDraft): void {
  if (message.thread || agentOnly(message.source) || !cardable(message)) return
  const known = new Set(group.cards?.pullRequests?.map(card => card.url))
  const fresh = pullRequestLinks(message.text).filter(url => !known.has(url))
  if (fresh.length) group.cards = { ...group.cards, pullRequests: [...group.cards?.pullRequests ?? [], ...fresh.map(url => ({ url, messageId: message.id }))] }
}

/** The card of [url] in [group], if a message already is one. */
export const pullRequestCard = (group: Conversation, url: string): PullRequestCard | undefined =>
  group.cards?.pullRequests?.find(card => card.url === url)

/** A merge of [url] was recorded at [mergedAt]: its card shows it, even to a reader whose computer cannot read GitHub. */
export function recordCardMerged(group: Conversation, url: string, mergedAt: number): void {
  const card = pullRequestCard(group, url)
  if (card) card.mergedAt = mergedAt
}
