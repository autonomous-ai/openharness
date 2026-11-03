import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { shippedNotice } from './buddyNews.js'
import { isLeads, stableId, type Author, type CommandEffects, type Conversation, type SuperTabState, type WorkStatus } from './model.js'
import { groupProject, projectsOf } from './projects.js'
import { isStep } from './steps.js'

/** A task's ordinary opening message in the project chat. Its details and progress are replies; the root is never edited. */
export const TASK_LINE_KIND = 'task-line'
/** `ready`: Done with its pull request, not merged yet; `shipped`: a merge of it recorded; `done`: Done with no pull request,
 *  such as a review (PM, review of #2633). */
export type TaskLineState = 'planned' | 'working' | 'waiting' | 'review' | 'ready' | 'shipped' | 'done' | 'stopped'
/** What the line last showed, kept on its task (cards.ts GroupCards.line). `reported`: the assignment whose agent has sent a
 *  status, so the line reads planned until then. */
export interface TaskLine { messageId: string; conversationId: string; state: TaskLineState; title: string; builderId: string; answerFor?: string; reported?: string }
/** A stored message's new words, written by the store over the row with that id (store.ts). */
export interface MessageEdit { id: string; conversationId: string; text: string; source: Record<string, unknown> }

const MOVING: ReadonlySet<WorkStatus> = new Set(['working', 'blocked', 'reconciling', 'lost'])

/** A task of a project with work of its own: never a step, the project chat, a Buddy chat, the Leads chat, or a private
 *  conversation (chat only: it holds no work, and its words are its own). */
function lined(chats: ReadonlySet<string>, group: Conversation): boolean {
  return !group.kind && !isLeads(group) && !isBuddyChat(group) && !isStep(group) && !group.audience && !chats.has(group.id)
}

/** What [group]'s line shows now. [reported]: its agent sent a status in this command. */
function drawn(group: Conversation, line: TaskLine | undefined, reported: boolean): Omit<TaskLine, 'messageId' | 'conversationId'> {
  const assignment = group.assignment
  if (!assignment) return { state: 'planned', title: group.title, builderId: '' }
  const status = assignment.status
  const heard = reported || line?.reported === assignment.id
  // Shipped only once a merge is recorded (conversation.merged), never on Done alone: the batch merges after the review passed.
  const state: TaskLineState = status === 'working' && !heard ? 'planned' : MOVING.has(status) ? 'working'
    : status === 'needs_human' ? 'waiting' : group.ledger?.mergedAt != null ? 'shipped' : status === 'review' ? 'review'
    : status === 'done' ? group.pullRequestUrls?.length ? 'ready' : 'done' : 'stopped'
  return { state, title: group.title, builderId: assignment.agentId, ...(state === 'waiting' && assignment.askedOf ? { answerFor: assignment.askedOf } : {}),
    ...(heard ? { reported: assignment.id } : {}) }
}

/** Only stable linkage is on the root. State belongs to replies, never its text or visible source. */
function fields(group: Conversation): Record<string, unknown> {
  return { taskId: group.id, ...(group.number != null ? { number: group.number } : {}), title: group.title,
    ...(group.requesterId ? { requesterId: group.requesterId } : {}) }
}

/** The line's author: its project's coordinator, as the server's other notices in that chat are (tidy.ts), else whoever moved
 *  the task. */
function lineAuthor(state: SuperTabState, chat: Conversation, sender: Author | undefined): Author | undefined {
  const coordinator = chat.leadId ? state.agents.find(a => a.id === chat.leadId) : undefined
  return coordinator ? { kind: 'agent', id: coordinator.id, name: coordinator.name, displayName: agentDisplayName(state.agents, coordinator.id),
    membershipGeneration: coordinator.membershipGeneration } : sender
}

/** Keep task commands in their own conversation while presenting their work in one ordinary project-chat thread.
 * Copies wake nobody: the task's original message carries its delivery exactly once. */
export function syncTaskLines(before: SuperTabState, effects: CommandEffects, reported: string | undefined, sender: Author | undefined, operationId: string): void {
  const state = effects.state
  const earlier = new Map(before.conversations.map(c => [c.id, c]))
  const chats = new Set(projectsOf(state).map(p => p.leadConversationId))
  const posts = [...effects.messages]
  for (const group of state.conversations) {
    if (!lined(chats, group)) continue
    const previous = earlier.get(group.id)
    let line = group.cards?.line
    const now = drawn(group, line, reported === group.id)
    const changed = !previous || previous.assignment?.id !== group.assignment?.id || previous.assignment?.status !== group.assignment?.status
      || previous.brief !== group.brief || previous.title !== group.title
    if (!line && !changed) continue
    const chat = state.conversations.find(c => c.id === (line?.conversationId ?? groupProject(state, group).leadConversationId))
    const coordinator = chat && lineAuthor(state, chat, sender)
    if (!chat || !coordinator) continue
    const reply = (id: string, text: string, author = sender ?? coordinator) => {
      const root = group.cards!.line!.messageId
      effects.messages.push({ id, conversationId: chat.id, author, text, replyTo: root, thread: root, recipients: [], source: { kind: 'system' } })
    }
    if (!line) {
      const proposal = group.ledger?.proposal
      const root = proposal?.messageId ?? stableId(operationId, TASK_LINE_KIND, group.id)
      group.cards = { ...group.cards, line: { messageId: root, conversationId: chat.id, ...now } }
      if (!proposal) {
        const requester = state.people.find(p => p.id === group.requesterId)
        effects.messages.push({ id: root, conversationId: chat.id,
          author: requester ? { kind: 'person', id: requester.id, name: requester.email, membershipGeneration: requester.generation } : coordinator,
          text: `Let's build: ${group.title}`, replyTo: null, recipients: [], source: { kind: TASK_LINE_KIND, ...fields(group) } })
      }
      if (group.brief) reply(stableId(operationId, 'task-details', group.id), group.brief)
      line = group.cards.line!
    } else {
      group.cards = { ...group.cards, line: { ...line, ...now } }
      if (previous && previous.brief !== group.brief && group.brief) reply(stableId(operationId, 'task-details', group.id), group.brief)
    }
    const assignmentChanged = !!group.assignment && previous?.assignment?.id !== group.assignment.id
    const stateChanged = !!group.assignment && (line.state !== now.state || previous?.assignment?.status !== group.assignment.status || line.answerFor !== now.answerFor)
    const freshPrs = (group.pullRequestUrls ?? []).filter(url => !previous?.pullRequestUrls?.includes(url))
    const merged = group.ledger?.mergedAt != null && previous?.ledger?.mergedAt == null
    const mergedPrs = (group.cards?.pullRequests ?? []).filter(card => card.mergedAt !== undefined
      && previous?.cards?.pullRequests?.find(was => was.url === card.url)?.mergedAt === undefined).map(card => card.url)
    if (mergedPrs.length) {
      reply(stableId(operationId, 'task-progress', group.id), `Merged ${mergedPrs.join(', ')}.`)
      const news = merged && sender && shippedNotice(state, group, sender, operationId)
      if (news) effects.messages.push(news)
    } else if (assignmentChanged) {
      reply(stableId(operationId, 'task-progress', group.id), `Assigned to ${agentDisplayName(state.agents, group.assignment!.agentId)}.`)
    } else if (stateChanged || freshPrs.length) {
      const labels: Record<TaskLineState, string> = { planned: 'Work assigned.', working: 'Work started.', waiting: 'Waiting for an answer.',
        review: 'Ready for review.', ready: 'Ready to merge.', shipped: 'Merged.', done: 'Work completed.', stopped: 'Work stopped.' }
      const result = reported === group.id ? group.assignment?.result : null
      const links = freshPrs.filter(url => !result?.includes(url))
      const status = group.assignment?.status
      const label = status === 'blocked' ? 'Work is blocked.' : status === 'lost' ? 'Work needs a new engineer.'
        : status === 'reconciling' ? 'Checking who can continue the work.' : status === 'cancelled' ? 'Work cancelled.' : labels[now.state]
      reply(stableId(operationId, 'task-progress', group.id), [label, result, ...links].filter(Boolean).join('\n\n'))
    }
    for (const post of posts) {
      if (post.conversationId !== group.id || post.source) continue
      effects.messages.push({ ...post, id: stableId(post.id, 'task-thread'), conversationId: chat.id, replyTo: line.messageId,
        thread: line.messageId, recipients: [], buddyRecipients: undefined, alsoInChat: undefined, mentions: undefined })
    }
  }
}
