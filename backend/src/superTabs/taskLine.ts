import { projectPm } from './crewNeeds.js'
import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { shippedNotice } from './buddyNews.js'
import { activeWork, isLeads, stableId, type Assignment, type Author, type CommandEffects, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { groupProject, projectsOf } from './projects.js'
import type { Reaction } from './reactions.js'
import { isStep } from './steps.js'
import { usernameOf } from './usernames.js'

/** A task's ordinary opening message in the project chat. Its details and progress are replies; the root is never edited. */
export const TASK_LINE_KIND = 'task-line'
/** Where a task's root is, kept on its task (cards.ts GroupCards.line). A line stored before plain chat (2026-11-03) also
 *  holds state, title, builderId, answerFor and reported, which nothing reads; they go with their task when it archives, and
 *  this note can go once no open task predates 2026-11-03. */
export interface TaskLine { messageId: string; conversationId: string }

/** A task of a project with work of its own: never a step, the project chat, a Buddy chat, the Leads chat, or a private
 *  conversation (chat only: it holds no work, and its words are its own). */
function lined(chats: ReadonlySet<string>, group: Conversation): boolean {
  return !group.kind && !isLeads(group) && !isBuddyChat(group) && !isStep(group) && !group.audience && !chats.has(group.id)
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

/** What a task's reply says for its row in the chat (threads.ts): the group leaves the apps once it archives, and this stays. */
export type TaskAsk = 'on-it' | 'shipped' | 'closed'

function taskAsk(group: Conversation): TaskAsk {
  if (group.ledger?.mergedAt != null) return 'shipped'
  const status = group.assignment?.status
  if (status === 'cancelled' || status === 'stopped') return 'closed'
  return status === 'done' && !group.pullRequestUrls?.length && !group.cards?.pullRequests?.length ? 'closed' : 'on-it'
}

/** What a task's thread says when its builder stops reporting and its task is lost, and when its work is stopped. */
const stuck = (builder: string) => `Stuck: ${builder} stopped. Next: another engineer takes it over.`
const notBuilding = (assignment: Assignment) => `Not building this: ${sentence(assignment.result) || 'it was stopped.'}`

/** The thread's reply for what changed in [group] in this command, in the words Dee approved (2026-11-03), or none. */
function progress(state: SuperTabState, effects: CommandEffects, group: Conversation, previous: Conversation | undefined, pm: string): string | null {
  const cards = group.cards?.pullRequests
  const merged = cards?.length ? cards.filter(card => card.mergedAt !== undefined
    && previous?.cards?.pullRequests?.find(was => was.url === card.url)?.mergedAt === undefined).map(card => card.url) : []
  if (merged.length) return `Merged: ${pullRequests(merged)}. Ships in the next release.`
  // A merge with no card to mark is still the merge: its row has no other way to say it shipped.
  if (group.ledger?.mergedAt != null && previous?.ledger?.mergedAt == null) return `Merged: ${pullRequests(group.pullRequestUrls ?? [])}. Ships in the next release.`
  const assignment = group.assignment
  const was = previous?.assignment
  // Most tasks did not move in this command: they say nothing, and nothing more is read for them.
  if (!assignment || (was?.id === assignment.id && was.status === assignment.status)) return null
  const builder = agentDisplayName(state.agents, assignment.agentId)
  // Its agent's 👀 on the ask says it is taken (inThread), a new agent's takeover no more than that.
  if (was?.id !== assignment.id) return null
  switch (assignment.status) {
    case 'needs_human': {
      // People talk only to the PM (anh Dee, 11-05; crewNeeds.ts): another agent's question is the PM's crew need, so its line
      // tells nobody it is their call.
      const projectLead = projectPm(state, group)
      if (projectLead && projectLead !== assignment.agentId) return `Needs a decision: ${sentence(assignment.result) || 'a decision is needed.'} Next: ${pm} is on it.`
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
    // A lost task says Stuck where it is lost, the one place that sees every loss (liveness.ts loseTask, endedReply).
    case 'cancelled': case 'stopped': return notBuilding(assignment)
    case 'done': return (group.pullRequestUrls ?? []).length || (group.cards?.pullRequests ?? []).length ? null : 'Done.'
    default: return null
  }
}

/** Whether [group] neither moved nor merged in this command: true for nearly every task on every command. */
function still(group: Conversation, previous: Conversation): boolean {
  const now = group.assignment, was = previous.assignment
  if (now?.id !== was?.id || now?.status !== was?.status || group.brief !== previous.brief) return false
  if (group.ledger?.mergedAt != null && previous.ledger?.mergedAt == null) return false
  const cards = group.cards?.pullRequests
  return !cards?.some(card => card.mergedAt !== undefined && previous.cards?.pullRequests?.find(old => old.url === card.url)?.mergedAt === undefined)
}

/** Keep task commands in their own conversation while presenting their work in one ordinary project-chat thread: its root,
 *  the brief as its first reply, then the PM's one reply per change (Dee, 2026-11-03). Agents' own posts stay in the task.
 *  Replies wake nobody. It runs on every command, so a task that did not move costs a few field reads; its chat, its author
 *  and a map of the conversations before are looked up only for one that did. */
export function syncTaskLines(before: SuperTabState, effects: CommandEffects, sender: Author | undefined, operationId: string): void {
  const state = effects.state
  // The clone keeps the order, and a command appends new conversations: a task is at its own index before, unless one was
  // removed; only then is the map built.
  let earlier: Map<string, Conversation> | undefined
  let chats: ReadonlySet<string> | undefined
  for (let index = 0; index < state.conversations.length; index++) {
    const group = state.conversations[index]!
    const same = before.conversations[index]
    const previous = same?.id === group.id ? same : (earlier ??= new Map(before.conversations.map(c => [c.id, c]))).get(group.id)
    if (previous && still(group, previous)) continue
    if (!lined(chats ??= new Set(projectsOf(state).map(p => p.leadConversationId)), group)) continue
    moved(state, effects, group, previous, sender, operationId)
  }
}

/** [group] is new, or moved in this command. A task some message asked for (a person's own, or their Buddy's proposal) replies
 *  in that message's thread; one nobody's message asked for posts nothing in the chat (Dee, 11-04, 'bot messages': a person sees
 *  only rows they wrote), and lives in Backlog and its own conversation. */
function moved(state: SuperTabState, effects: CommandEffects, group: Conversation, previous: Conversation | undefined, sender: Author | undefined,
  operationId: string): void {
  if (group.cards?.line || group.ledger?.proposal) inThread(state, effects, group, previous, sender, operationId)
  // Only its first recorded merge is news to the Buddy, as the Shipped line was: a merge recorded again tells nobody again.
  if (group.ledger?.mergedAt != null && previous?.ledger?.mergedAt == null) {
    const news = sender && shippedNotice(state, group, sender, operationId)
    if (news) effects.messages.push(news)
  }
}

/** [group]'s replies in the thread of the message that asked for it: its name when it opens there (several tasks may share one
 *  message), then its details and progress. */
function inThread(state: SuperTabState, effects: CommandEffects, group: Conversation, previous: Conversation | undefined, sender: Author | undefined,
  operationId: string): void {
  const line = group.cards?.line
  const chat = state.conversations.find(c => c.id === (line?.conversationId ?? groupProject(state, group).leadConversationId))
  const coordinator = chat && lineAuthor(state, chat, sender)
  if (!chat || !coordinator) return
  // Stuck names the coordinator, never the agent that is stuck when there is no coordinator to sign.
  const pm = chat.leadId && coordinator.kind === 'agent' && coordinator.id === chat.leadId ? coordinator.displayName ?? coordinator.name : 'the PM'
  const reply = (id: string, words: string, linked: Record<string, unknown> = {}) => {
    const root = group.cards!.line!.messageId
    effects.messages.push({ id, conversationId: chat.id, author: coordinator, text: words, replyTo: root, thread: root, recipients: [],
      source: { kind: 'system', ask: taskAsk(group), ...linked } })
  }
  if (!line) {
    // A proposal's root already has the proposal as its first reply.
    group.cards = { ...group.cards, line: { messageId: group.ledger!.proposal!.messageId, conversationId: chat.id } }
  } else if (!previous) {
    // Opened from a person's message (commands.ts requestOf): the thread names it, by its title alone.
    reply(stableId(operationId, 'task-named', group.id), group.title, fields(group))
  } else if (previous.brief !== group.brief && group.brief) reply(stableId(operationId, 'task-details', group.id), group.brief)
  const text = progress(state, effects, group, previous, pm)
  if (text) reply(stableId(operationId, 'task-progress', group.id), text)
  // In place of the On it / Shipped label (Dee, 11-04, 'bot messages'): its agent reacts on the ask as a teammate would, 👀 when
  // the task's work first starts and ✅ at its first merge. The store writes each as that agent's own reaction, once by its id.
  const agentId = group.assignment?.agentId
  const react = (emoji: Reaction) => {
    (effects.reactions ??= []).push({ conversationId: chat.id, messageId: group.cards!.line!.messageId, agentId: agentId!, emoji })
    chat.reactionSeq = (chat.reactionSeq ?? 0) + 1
  }
  if (agentId && !previous?.assignment && group.assignment!.status !== 'lost') react('eyes')
  if (agentId && group.ledger?.mergedAt != null && previous?.ledger?.mergedAt == null) react('check')
}

/** The thread reply of a task that ended outside any command, which syncTaskLines never sees (Diego, 2026-11-04, task #2693):
 *  lost to the liveness sweep, its machine's report or its Lead's poll (liveness.ts loseTask, the agent.alert command's too), or
 *  stopped by its host's receipt (store.ts stopped). As the command path's replies are: in its line's thread, by its project's
 *  coordinator, else [fallback], waking nobody. None for a task with no line, or whose project chat is gone. */
export function endedReply(state: SuperTabState, group: Conversation, id: string, fallback?: Author): MessageDraft[] {
  const line = group.cards?.line, assignment = group.assignment
  if (!line || !assignment) return []
  const chat = state.conversations.find(c => c.id === line.conversationId)
  const author = chat && lineAuthor(state, chat, fallback)
  if (!chat || !author) return []
  const text = assignment.status === 'lost' ? stuck(agentDisplayName(state.agents, assignment.agentId) ?? 'its engineer') : notBuilding(assignment)
  return [{ id, conversationId: chat.id, author, text, replyTo: line.messageId, thread: line.messageId, recipients: [],
    source: { kind: 'system', ask: taskAsk(group) } }]
}

/** The project chats holding the lines of [state]'s open tasks that its load left out: a store path that may end a task outside
 *  any command loads them first, so endedReply has its thread to write in. Empty on every path today, which loads every project chat. */
export function taskLineChats(state: SuperTabState): string[] {
  const loaded = new Set(state.conversations.map(c => c.id))
  return [...new Set(state.conversations.flatMap(c => activeWork(c) && c.cards?.line && !loaded.has(c.cards.line.conversationId)
    ? [c.cards.line.conversationId] : []))]
}
