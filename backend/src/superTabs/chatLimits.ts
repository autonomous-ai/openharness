/** Deterministic project-chat limits (Dee 11-04/11-05, task #3598). Threads carry work details; main carries decisions/results. */
import type { Command, CommandContext } from './commands.js'
import { fail, type Conversation, type SuperTabState } from './model.js'
import { requireUnanswered, type AnsweredAsk } from './answers.js'
import { groupProject } from './projects.js'

type Send = Extract<Command, { type: 'message.send' }>
type Reply = CommandContext['reply']

export const isProjectChat = (state: SuperTabState, group: Conversation): boolean => groupProject(state, group).leadConversationId === group.id
export const inMainChat = (command: Send, reply: Reply): boolean => !command.replyTo || !!reply?.agentOnly || !reply?.thread || !!command.alsoSend

// Anchored labels, not words like "CI" appearing in a real question or result. No semantic classifier on the posting path.
const STATUS = /^(?:status(?: update)?|progress(?: update)?|on it|working|ready for review|ready for (?:the )?batch|CI|review|test run|batch)\s*:/im
const plain = (text: string) => text.trim().replace(/[.!。]+$/, '').trim()

export function requireChatContent(state: SuperTabState, group: Conversation, text: string): void {
  if (STATUS.test(text)) fail('CHAT_STATUS', 'Keep status lines in the task status or the ask’s thread, not the main chat.', 400)
  const line = plain(text)
  const pr = line.match(/^(?:PR\s*#\d+\s*:?\s*)?(https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+)\/?$/i)?.[1]
  const task = line.match(/^(?:Task\s*)?#(\d+)(?:\s*[:—-]?\s*(.*))?$/i)
  const repeatedTask = task && state.conversations.some(g => g.number === Number(task[1]) && g.cards?.line?.conversationId === group.id
    && (!task[2] || plain(task[2]).toLowerCase() === plain(g.title).toLowerCase()))
  if ((pr && group.cards?.pullRequests?.some(card => card.url === pr)) || repeatedTask) {
    fail('CHAT_CARD_REPEAT', 'This card is already in the chat. Add new details in its thread instead of repeating it.', 400)
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
  latest?: string
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

export function recordChatAsk(group: Conversation, id: string, at: number, root: string | null): void {
  remember(group, id, at)
  if (!root) group.chatLimits!.latest = id
}

function closedAsk(): never {
  fail('CHAT_ASK_CLOSED', 'This older ask’s main-chat budget is closed. Continue the discussion under its existing response in the thread.', 409)
}

/** Returns the main-budget owner, or null for thread-only posts and announcements before any person ask is recorded. */
export function requireChatPost(group: Conversation, command: Send, reply: Reply): string | null {
  if (!inMainChat(command, reply)) return null
  const ledger = group.chatLimits
  const linked = command.replyTo || command.answers ? reply : undefined
  const personAsk = linked?.author.kind === 'person' ? linked : undefined
  let askId = personAsk ? personAsk.thread ?? personAsk.id
    : linked ? ledger?.asks.find(ask => ask.main.includes(linked.id))?.id ?? linked.thread : undefined
  askId ??= ledger?.latest
  if (!askId) return null
  let ask = ledger?.asks.find(ask => ask.id === askId)
  if (!ask && personAsk && askId === personAsk.id && (ledger?.closedThrough === undefined || personAsk.createdAt > ledger.closedThrough)) {
    ask = remember(group, askId, personAsk.createdAt)
  }
  if (!ask) return closedAsk()
  if (ask.main.length >= 2) fail('CHAT_MAIN_LIMIT', 'At most two agent posts per ask in the main chat. Put follow-ups in its thread.', 409)
  return ask.id
}

export function recordChatPost(group: Conversation, askId: string | null, messageId: string): void {
  if (askId) group.chatLimits!.asks.find(ask => ask.id === askId)!.main.push(messageId)
}

/** Explicit answer links and a direct response to a person are answers; replies to an agent response are discussion. */
export function requireChatAnswer(group: Conversation, command: Send, reply: Reply): string | null {
  if (!reply || reply.agentOnly || !(command.answers || command.answer || (command.replyTo && reply.author.kind === 'person'))) return null
  let ask = group.chatLimits?.asks.find(ask => ask.id === reply.id)
  requireUnanswered(group, reply.id, ask?.answer)
  if (!ask) {
    if (group.chatLimits?.closedThrough !== undefined && reply.createdAt <= group.chatLimits.closedThrough) return closedAsk()
    ask = remember(group, reply.id, reply.createdAt)
  }
  return ask.id
}

export function recordChatAnswer(group: Conversation, askId: string | null, messageId: string, thread: string | null, at: number): void {
  const ask = askId && group.chatLimits?.asks.find(ask => ask.id === askId)
  if (ask) ask.answer = { id: askId, answerId: messageId, thread, at }
}
