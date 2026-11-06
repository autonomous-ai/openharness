/** Deterministic project-chat limits (Dee 11-04/11-05, task #3598). Threads carry work details; main carries decisions/results. */
import type { Command, CommandContext } from './commands.js'
import { fail, type Conversation, type SuperTabState } from './model.js'
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
