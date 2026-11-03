import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { shippedNotice } from './buddyNews.js'
import { isLeads, stableId, type Author, type CommandEffects, type Conversation, type SuperTabState, type WorkStatus } from './model.js'
import { groupProject, projectsOf } from './projects.js'
import { isStep } from './steps.js'
import { usernameOf } from './usernames.js'

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

/** One line of an agent's result, ending as a sentence ends: what a thread reply quotes of it. */
function sentence(text: string | null | undefined): string {
  const first = (text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
  return !first || /[.!?。！？]$/.test(first) ? first : `${first}.`
}

/** `PR #12` for a GitHub pull request, else its link; several joined as a person would write them. */
function pullRequests(urls: readonly string[]): string {
  const names = urls.map(url => { const n = url.match(/\/pull\/(\d+)(?:[/?#]|$)/)?.[1]; return n ? `PR #${n}` : url })
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] ?? ''
}

const PULL_REQUEST = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g

/** The thread's reply for what changed in [group] in this command, in the words Dee approved (2026-11-03), or none. */
function progress(state: SuperTabState, effects: CommandEffects, group: Conversation, previous: Conversation | undefined, pm: string): string | null {
  const merged = (group.cards?.pullRequests ?? []).filter(card => card.mergedAt !== undefined
    && previous?.cards?.pullRequests?.find(was => was.url === card.url)?.mergedAt === undefined).map(card => card.url)
  if (merged.length) return `Merged: ${pullRequests(merged)}. Ships in the next release.`
  const assignment = group.assignment
  if (!assignment) return null
  const builder = agentDisplayName(state.agents, assignment.agentId)
  const was = previous?.assignment
  if (was?.id !== assignment.id) return assignment.status === 'lost' ? null : `On it: ${builder} is building it.`
  if (was.status === assignment.status) return null
  switch (assignment.status) {
    case 'needs_human': {
      const asked = assignment.askedOf && usernameOf(state, assignment.askedOf)
      const decision = effects.decisions?.find(d => d.conversationId === group.id && d.assignmentId === assignment.id)
      const fallback = decision && decision.options[decision.recommended]
      return `${asked ? `@${asked} ` : ''}Your call: ${sentence(assignment.result) || 'a decision is needed.'}${fallback ? ` Default: ${sentence(fallback)}` : ''}`
    }
    case 'review': {
      const linked = [...new Set([...assignment.result?.match(PULL_REQUEST) ?? [], ...group.pullRequestUrls ?? []])]
        .filter(url => !group.cards?.pullRequests?.some(card => card.url === url && card.mergedAt !== undefined))
      return linked.length ? `Ready for review: ${pullRequests(linked)}` : 'Ready for review.'
    }
    case 'working': return was.status === 'review' ? `Changes needed: ${sentence(assignment.result) || 'see the review.'} ${builder} is fixing it.` : null
    case 'blocked': return `Stuck: ${sentence(assignment.result) || `${builder} cannot go on.`} Next: ${pm} is looking at it.`
    case 'lost': return `Stuck: ${builder} stopped. Next: another engineer takes it over.`
    case 'cancelled': case 'stopped': return `Not building this: ${sentence(assignment.result) || 'it was stopped.'}`
    case 'done': return (group.pullRequestUrls ?? []).length || (group.cards?.pullRequests ?? []).length ? null : 'Done.'
    default: return null
  }
}

/** Keep task commands in their own conversation while presenting their work in one ordinary project-chat thread: its root,
 *  the brief as its first reply, then the PM's one reply per change (Dee, 2026-11-03). Agents' own posts stay in the task.
 *  Replies wake nobody. */
export function syncTaskLines(before: SuperTabState, effects: CommandEffects, reported: string | undefined, sender: Author | undefined, operationId: string): void {
  const state = effects.state
  const earlier = new Map(before.conversations.map(c => [c.id, c]))
  const chats = new Set(projectsOf(state).map(p => p.leadConversationId))
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
    const reply = (id: string, text: string) => {
      const root = group.cards!.line!.messageId
      effects.messages.push({ id, conversationId: chat.id, author: coordinator, text, replyTo: root, thread: root, recipients: [], source: { kind: 'system' } })
    }
    if (!line) {
      const proposal = group.ledger?.proposal
      const root = proposal?.messageId ?? stableId(operationId, TASK_LINE_KIND, group.id)
      group.cards = { ...group.cards, line: { messageId: root, conversationId: chat.id, ...now } }
      // A proposal's root already has the proposal as its first reply; only a root the server posts gets the brief.
      if (!proposal) {
        const requester = state.people.find(p => p.id === group.requesterId)
        effects.messages.push({ id: root, conversationId: chat.id,
          author: requester ? { kind: 'person', id: requester.id, name: requester.email, membershipGeneration: requester.generation } : coordinator,
          text: `Let's build: ${group.title}`, replyTo: null, recipients: [], source: { kind: TASK_LINE_KIND, ...fields(group) } })
        if (group.brief) reply(stableId(operationId, 'task-details', group.id), group.brief)
      }
      line = group.cards.line!
    } else {
      group.cards = { ...group.cards, line: { ...line, ...now } }
      if (previous && previous.brief !== group.brief && group.brief) reply(stableId(operationId, 'task-details', group.id), group.brief)
    }
    const text = progress(state, effects, group, previous, coordinator.kind === 'agent' ? coordinator.displayName ?? coordinator.name : 'the PM')
    if (text) reply(stableId(operationId, 'task-progress', group.id), text)
    // Only its first recorded merge is news to the Buddy, as the Shipped line was: a merge recorded again tells nobody again.
    if (group.ledger?.mergedAt != null && previous?.ledger?.mergedAt == null) {
      const news = sender && shippedNotice(state, group, sender, operationId)
      if (news) effects.messages.push(news)
    }
  }
}
