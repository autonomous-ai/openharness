/**
 * The PM answers each ask once, in its place (task #3403, anh Dee's Swarm redesign, 11-05). An answer (`message.send` with
 * `answer`, the CLI's `answer` command) goes where the ask was made: in its thread when it is a reply in one, else right below
 * it in the main chat. The PM's answers are recorded on the conversation (`Conversation.answered`), by `answer` or by any post
 * that settles an owed ask (pulse.ts), and a second `answer` to the same message is refused with where the first one is. A
 * plain post is never refused: only the command that says "this is the answer" is.
 */
import type { CommandContext } from './commands.js'
import { fail, type Conversation, type SuperTabState } from './model.js'
import { groupProject } from './projects.js'
import { pmOf, type OwedAsk } from './pulse.js'

export const ALREADY_ANSWERED = 'ALREADY_ANSWERED'
/** At most this many answers are kept per conversation, the newest: a growth bound, as pulse.ts MAX_OWED. */
export const MAX_ANSWERED = 50

/** One message the PM answered: its id, the answer's id, the thread the answer went in (null: right below it), and when. */
export interface AnsweredAsk { id: string; answerId: string; thread: string | null; at: number }

type Reply = NonNullable<CommandContext['reply']>

/** Whether [reply] is a reply inside a thread, whose answer then goes in that thread. A thread's root is answered below it. */
export const inThread = (reply: Reply): boolean => !!reply.thread && reply.thread !== reply.id

/** Whether [agentId] leads [group]'s project. Never throws: a conversation outside every project has no PM. */
export function leadsGroup(state: SuperTabState, group: Conversation, agentId: string): boolean {
  try { return pmOf(state, groupProject(state, group)) === agentId } catch { return false }
}

const clock = (at: number): string => new Date(at).toISOString().slice(11, 16)

/** Refuses an answer to [messageId] when [group] records one, saying where it is. */
export function requireUnanswered(group: Conversation, messageId: string): void {
  const first = group.answered?.find(a => a.id === messageId)
  if (!first) return
  const where = first.thread ? 'in its thread' : 'right below it'
  fail(ALREADY_ANSWERED, `Answered already ${where} at ${clock(first.at)} UTC (message ${first.answerId}). Add to it there if something changed.`, 409,
    { answerId: first.answerId, thread: first.thread })
}

/** Records the PM's answer [answerId] to each of [asks]. */
export function recordAnswered(group: Conversation, asks: ReadonlyArray<Pick<OwedAsk, 'id'>>, answerId: string, thread: string | null, at: number): void {
  if (!asks.length) return
  const ids = new Set(asks.map(a => a.id))
  group.answered = [...(group.answered ?? []).filter(a => !ids.has(a.id)), ...asks.map(a => ({ id: a.id, answerId, thread, at }))].slice(-MAX_ANSWERED)
}
