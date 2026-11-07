/** Deterministic project-chat limits (Dee 11-04/11-05, task #3598): the chat carries decisions and results, its tasks the work's
 *  details. No chat has threads (task #4555): a thread reply only an older app still sends is discussion outside these limits. */
import type { Command, CommandContext } from './commands.js'
import { fail, type Conversation, type SuperTabState } from './model.js'
import { requireUnanswered, type AnsweredAsk } from './answers.js'
import { projectsOf } from './projects.js'

type Send = Extract<Command, { type: 'message.send' }>
type Reply = CommandContext['reply']

export const isProjectChat = (state: SuperTabState, group: Conversation): boolean => projectsOf(state).some(project => project.leadConversationId === group.id)
export const inMainChat = (command: Send, reply: Reply): boolean => !command.replyTo || !!reply?.agentOnly || !reply?.thread || !!command.alsoSend

// Anchored labels, not words like "CI" appearing in a real question or result. No semantic classifier on the posting path.
const STATUS = /^(?:status(?: update)?|progress(?: update)?|on it|working|ready for review|ready for (?:the )?batch|CI|review|test run|batch)\s*:/im
const plain = (text: string) => text.trim().replace(/[.!。]+$/, '').trim()

export function requireChatContent(state: SuperTabState, group: Conversation, text: string): void {
  if (STATUS.test(text)) fail('CHAT_STATUS', 'Keep status lines in your task status, not the project chat.', 400)
  const line = plain(text)
  const pr = line.match(/^(?:PR\s*#\d+\s*:?\s*)?(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)\/?$/i)?.[1]
  const prNumber = line.match(/^PR\s*#(\d+)$/i)?.[1]
  const repeatedPr = group.cards?.pullRequests?.some(card => (pr && card.url === pr) || (prNumber && card.url.endsWith(`/pull/${prNumber}`)))
  const task = line.match(/^(?:Task\s*)?#(\d+)(?:\s*[:—-]?\s*(.*))?$/i)
  const repeatedTask = task && state.conversations.some(g => g.number === Number(task[1]) && g.cards?.line?.conversationId === group.id
    && (!task[2] || plain(task[2]).toLowerCase() === plain(g.title).toLowerCase()))
  if (repeatedPr || repeatedTask) {
    fail('CHAT_CARD_REPEAT', 'This card is already in the chat. Add new details in its task instead of repeating it.', 400)
  }
}

/** Private, bounded state read/written with the conversation part; removed with it. IDs only, never transcript content. */
export interface ChatAsk {
  id: string
  at: number
  main: string[]
  answer?: AnsweredAsk
}
export interface ChatLimits {
  asks: ChatAsk[]
  /** Evicted asks cannot become new asks again. Timestamp ties close conservatively; retained IDs always win. */
  closedThrough?: number
}
const MAX_ASKS = 50

function remember(group: Conversation, id: string, at: number): ChatAsk {
  const ledger = group.chatLimits ??= { asks: [] }
  const known = ledger.asks.find(ask => ask.id === id)
  if (known) return known
  const ask: ChatAsk = { id, at, main: [] }
  ledger.asks.push(ask)
  if (ledger.asks.length > MAX_ASKS) ledger.closedThrough = Math.max(ledger.closedThrough ?? 0, ledger.asks.shift()!.at)
  return ask
}

export function recordChatAsk(group: Conversation, id: string, at: number): void {
  remember(group, id, at)
}

function closedAsk(): never {
  fail('CHAT_ASK_CLOSED', 'This ask is too old to answer here. Answer a newer message, or post a plain line.', 409)
}

/** Returns the main-budget owner, or null for thread-only posts and unlinked announcements. */
export function requireChatPost(group: Conversation, command: Send, reply: Reply): string | null {
  if (reply?.agentOnly || !inMainChat(command, reply) || !(command.replyTo || command.answers)) return null
  const ledger = group.chatLimits
  const linked = command.replyTo || command.answers ? reply : undefined
  const personAsk = linked?.author.kind === 'person' ? linked : undefined
  // Each person message is its own ask; one in an older thread that was never one is its root's (task #4555).
  const askId = personAsk ? (ledger?.asks.some(ask => ask.id === personAsk.id) ? personAsk.id : personAsk.thread ?? personAsk.id)
    // An agent's line is an ask's when it answered one, or replied in its older thread; any other is no one's.
    : linked ? ledger?.asks.find(ask => ask.main.includes(linked.id))?.id ?? (linked.thread && linked.thread !== linked.id ? linked.thread : undefined) : undefined
  if (!askId) return null
  let ask = ledger?.asks.find(ask => ask.id === askId)
  if (!ask && personAsk && askId === personAsk.id && (ledger?.closedThrough === undefined || personAsk.createdAt > ledger.closedThrough)) {
    ask = remember(group, askId, personAsk.createdAt)
  }
  if (!ask) return closedAsk()
  if (ask.main.length >= 2) fail('CHAT_MAIN_LIMIT', 'At most two agent posts answer one ask in the project chat. Put more in its task, or edit your earlier post.', 409)
  return ask.id
}

export function recordChatPost(group: Conversation, askId: string | null, messageId: string): void {
  if (askId) group.chatLimits!.asks.find(ask => ask.id === askId)!.main.push(messageId)
}

/** Explicit answer links and person replies mirrored into main are answers; plain thread replies are discussion. */
export function requireChatAnswer(group: Conversation, command: Send, reply: Reply): string | null {
  if (!reply || reply.agentOnly || !(command.answers || command.answer || (command.replyTo && inMainChat(command, reply) && reply.author.kind === 'person'))) return null
  const ask = group.chatLimits?.asks.find(ask => ask.id === reply.id)
  requireUnanswered(group, reply.id, ask?.answer)
  if (!ask) {
    if (group.chatLimits?.closedThrough !== undefined && reply.createdAt <= group.chatLimits.closedThrough) return closedAsk()
  }
  return reply.id
}

export function recordChatAnswer(group: Conversation, askId: string | null, messageId: string, thread: string | null, at: number, askedAt: number): void {
  const ask = askId && remember(group, askId, askedAt)
  if (ask) ask.answer = { id: askId, answerId: messageId, thread, at }
}
