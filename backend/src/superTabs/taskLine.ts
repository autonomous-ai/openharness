import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { shippedNotice } from './buddyNews.js'
import { isLeads, stableId, type Author, type CommandEffects, type Conversation, type MessageDraft, type SuperTabState, type WorkStatus } from './model.js'
import { groupProject, projectsOf } from './projects.js'
import { isStep } from './steps.js'
import { shownNameOf } from './personNames.js'

/**
 * A task's one message in its project chat (Quiet Swarm, Dee, 11-02; docs/plans/2026-11-02-quiet-swarm-task-line-plan.md):
 * like a Slack bot's long job, one message that keeps itself current until it ships, its thread the task's own
 * conversation. It replaces the Shipped line. The server posts it when a task first has an Engineer and edits it in place
 * as the task moves, only when its words change; Desktop and the phone draw it from its source, an older client from its
 * text. It wakes nobody.
 */
export const TASK_LINE_KIND = 'task-line'
/** `ready`: Done with its pull request, not merged yet; `shipped`: a merge of it recorded; `done`: Done with no pull request,
 *  such as a review (PM, review of #2633). */
export type TaskLineState = 'planned' | 'working' | 'waiting' | 'review' | 'ready' | 'shipped' | 'done' | 'stopped'
/** What the line last showed, kept on its task (cards.ts GroupCards.line). `reported`: the assignment whose agent has sent a
 *  status, so the line reads planned until then. */
export interface TaskLine { messageId: string; conversationId: string; state: TaskLineState; title: string; builderId: string; answerFor?: string; reported?: string }
/** A stored message's new words, written by the store over the row with that id (store.ts). */
export interface MessageEdit { id: string; conversationId: string; text: string; source: Record<string, unknown> }

const WORDS: Record<Exclude<TaskLineState, 'waiting'>, string> = { planned: 'planned', working: 'working', review: 'in review', ready: 'ready',
  shipped: 'shipped', done: 'done', stopped: 'stopped' }
const MOVING: ReadonlySet<WorkStatus> = new Set(['working', 'blocked', 'reconciling', 'lost'])

/** A task of a project with work of its own: never a step, the project chat, a Buddy chat, the Leads chat, or a private
 *  conversation (chat only: it holds no work, and its words are its own). */
function lined(chats: ReadonlySet<string>, group: Conversation): boolean {
  return !group.kind && !isLeads(group) && !isBuddyChat(group) && !isStep(group) && !group.audience && !chats.has(group.id)
}

/** What [group]'s line shows now. [reported]: its agent sent a status in this command. */
function drawn(group: Conversation, line: TaskLine | undefined, reported: boolean): Omit<TaskLine, 'messageId' | 'conversationId'> {
  const assignment = group.assignment!
  const status = assignment.status
  const heard = reported || line?.reported === assignment.id
  // Shipped only once a merge is recorded (conversation.merged), never on Done alone: the batch merges after the review passed.
  const state: TaskLineState = status === 'working' && !heard ? 'planned' : MOVING.has(status) ? 'working'
    : status === 'needs_human' ? 'waiting' : group.ledger?.mergedAt != null ? 'shipped' : status === 'review' ? 'review'
    : status === 'done' ? group.pullRequestUrls?.length ? 'ready' : 'done' : 'stopped'
  return { state, title: group.title, builderId: assignment.agentId, ...(state === 'waiting' && assignment.askedOf ? { answerFor: assignment.askedOf } : {}),
    ...(heard ? { reported: assignment.id } : {}) }
}

const same = (a: Omit<TaskLine, 'messageId' | 'conversationId'>, b: TaskLine) => a.state === b.state && a.title === b.title
  && a.builderId === b.builderId && a.answerFor === b.answerFor

function words(state: SuperTabState, line: Omit<TaskLine, 'messageId' | 'conversationId'>): string {
  const asked = line.answerFor && shownNameOf(state, line.answerFor)
  return `${line.title} · ${line.state === 'waiting' ? asked ? `waiting on ${asked}` : 'waiting' : WORDS[line.state]}`
}

/** The line's source, but for its kind (written beside each `source` as TASK_LINE_KIND, notices.test.ts reads it there). */
function fields(group: Conversation, line: Omit<TaskLine, 'messageId' | 'conversationId'>): Record<string, unknown> {
  return { taskId: group.id, ...(group.number != null ? { number: group.number } : {}), title: line.title, state: line.state,
    ...(line.answerFor ? { answerFor: line.answerFor } : {}), builderId: line.builderId, ...(group.requesterId ? { requesterId: group.requesterId } : {}) }
}

/** The line's author: its project's coordinator, as the server's other notices in that chat are (tidy.ts), else whoever moved
 *  the task. */
function lineAuthor(state: SuperTabState, chat: Conversation, sender: Author | undefined): Author | undefined {
  const coordinator = chat.leadId ? state.agents.find(a => a.id === chat.leadId) : undefined
  return coordinator ? { kind: 'agent', id: coordinator.id, name: coordinator.name, displayName: agentDisplayName(state.agents, coordinator.id),
    membershipGeneration: coordinator.membershipGeneration } : sender
}

/** After a command: each task whose line's words changed has it posted (the first time its assignment changes) or edited,
 *  and the chat's reaction counter moves for each edit, so a reader polling it reads the page shown again (reactions.ts).
 *  A task that had work before lines gets its line at its next change; one that never changes again, none. */
export function syncTaskLines(before: SuperTabState, effects: CommandEffects, reported: string | undefined, sender: Author | undefined, operationId: string): void {
  const state = effects.state
  let earlier: Map<string, Conversation> | undefined
  const was = (id: string) => (earlier ??= new Map(before.conversations.map(c => [c.id, c]))).get(id)
  const chats = new Set(projectsOf(state).map(p => p.leadConversationId))
  for (const group of state.conversations) {
    if (!group.assignment || !lined(chats, group)) continue
    const line = group.cards?.line
    const now = drawn(group, line, reported === group.id)
    if (line) {
      if (same(now, line)) {
        if (now.reported !== line.reported) group.cards = { ...group.cards, line: { ...line, ...now } }
        continue
      }
      const chat = state.conversations.find(c => c.id === line.conversationId)
      if (!chat) continue
      effects.edits = [...effects.edits ?? [], { id: line.messageId, conversationId: chat.id, text: words(state, now), source: { kind: TASK_LINE_KIND, ...fields(group, now) } }]
      chat.reactionSeq = (chat.reactionSeq ?? 0) + 1
      group.cards = { ...group.cards, line: { messageId: line.messageId, conversationId: chat.id, ...now } }
    } else {
      const previous = was(group.id)?.assignment
      if (previous && previous.id === group.assignment.id && previous.status === group.assignment.status && previous.askedOf === group.assignment.askedOf) continue
      const chat = state.conversations.find(c => c.id === groupProject(state, group).leadConversationId)
      const author = chat && lineAuthor(state, chat, sender)
      if (!chat || !author) continue
      const message: MessageDraft = { id: stableId(operationId, TASK_LINE_KIND, group.id), conversationId: chat.id, author, text: words(state, now),
        replyTo: null, recipients: [], source: { kind: TASK_LINE_KIND, ...fields(group, now) } }
      effects.messages.push(message)
      group.cards = { ...group.cards, line: { messageId: message.id, conversationId: chat.id, ...now } }
    }
    // Only its first recorded merge is news, as the Shipped line was: a merge recorded again tells nobody again.
    if (now.state === 'shipped' && was(group.id)?.ledger?.mergedAt == null) {
      const news = sender && shippedNotice(state, group, sender, operationId)
      if (news) effects.messages.push(news)
    }
  }
}
