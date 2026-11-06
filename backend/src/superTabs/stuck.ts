/**
 * Stuck work is flagged at once to the PM and the people on the task (task #3915, Tony 11-06: #3821 sat with red checks and a
 * lost Test step, and nobody told him; the same day Mac 3's terminal stopped and Engineers and Testers were down for an hour
 * with only scattered "could not start" notices). A task is stuck when its agent went down and nobody took it for
 * STUCK_DOWN_MS, when one of its steps lost its agent or its agent could not start, or when its pull request's checks are red
 * at its head while its Engineer says review or done. The time checks (store.ts runTimeChecks, every Swarm at least every 5
 * minutes) tell each change once, in one line in the task, written as its PM to its PM and tagging its people, so it is in
 * their Needs you; when it is fixed one line says so and the tags resolve. The record on the task is the deduplication.
 */
import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { MAX_MENTIONS } from './mentions.js'
import { codePullRequests, isLeads, stableId, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { canReadGroup, projectsOf } from './projects.js'
import { stepName, stepsOf } from './steps.js'

/** How long a task whose agent went down waits for a taker before its people hear it. */
export const STUCK_DOWN_MS = 10 * 60_000
/** The people a task keeps as its writers (Conversation.writers): with its requester, at most MAX_MENTIONS. */
const WRITERS_KEPT = MAX_MENTIONS - 1

/** [personId] posted in [group]: its writers, newest last, at most WRITERS_KEPT. */
export function noteWriter(group: Conversation, personId: string): void {
  const writers = group.writers ?? []
  if (writers.at(-1) === personId) return
  group.writers = [...writers.filter(id => id !== personId), personId].slice(-WRITERS_KEPT)
}

/** Why a task is stuck now: the key that names this reason (a new key is a new line), what its line says and what its fix says. */
interface Stuck { key: string; text: string; fixed: string }

const short = (sha: string) => sha.slice(0, 7)
const minutes = (ms: number) => { const n = Math.max(0, Math.floor(ms / 60_000)); return `${n} minute${n === 1 ? '' : 's'}` }
const prName = (url: string) => { const n = url.match(/\/pull\/(\d+)/)?.[1]; return n ? `PR #${n}` : url }

/** The first reason [task] is stuck at [now], or null: its own agent down, then a step, then red checks. */
export function stuckOf(state: SuperTabState, task: Conversation, now: number): Stuck | null {
  const assignment = task.assignment
  if (!assignment) return null
  if (assignment.status === 'lost') {
    const since = assignment.lost?.at ?? now
    if (now - since < STUCK_DOWN_MS) return null
    const who = agentDisplayName(state.agents, assignment.agentId) ?? 'Its agent'
    return { key: `down:${assignment.id}`, text: `Stuck: ${who} went down ${minutes(now - since)} ago and nobody has taken this task.`,
      fixed: 'this task has an agent again' }
  }
  for (const step of stepsOf(state, task.id)) {
    if (step.archived || !step.assignment) continue
    const name = stepName(step)
    if (step.assignment.status === 'lost') {
      return { key: `step:${step.assignment.id}`, text: `Stuck: the ${name} step lost its agent and nobody has taken it.`, fixed: `the ${name} step has an agent again` }
    }
    if (step.liveness?.why === 'start-failed') {
      return { key: `start:${step.id}:${step.assignment.id}`, text: `Stuck: the ${name} step's agent could not start again.`, fixed: `the ${name} step has an agent again` }
    }
  }
  // Red at its head while its Engineer says it is ready: in review or done, or reopened by that red and not picked up yet. Only its
  // own code's newest pull request: a task also links others' that its brief or a result names (review of #3431).
  const url = codePullRequests(task).at(-1)
  const ready = assignment.status === 'review' || assignment.status === 'done' || !!assignment.reopened
  if (url && ready && task.pullRequestChecks?.[url] === 'red') {
    const head = task.pullRequestHeads?.[url]?.head
    const says = assignment.status === 'done' ? 'done' : 'ready for review'
    return { key: `ci:${url}:${head ?? ''}`, text: `Stuck: checks are red on ${prName(url)}${head ? ` at ${short(head)}` : ''} while its Engineer says it is ${says}. ${url}`,
      fixed: `checks on ${prName(url)} are no longer red` }
  }
  return null
}

/** A task the checks read: a task of a project with work, never a step, a chat, a private chat or one archived. */
const flaggable = (state: SuperTabState, chats: ReadonlySet<string>, group: Conversation) =>
  !group.archived && !group.reviewOf && !group.kind && !group.audience && !isLeads(group) && !isBuddyChat(group) && !chats.has(group.id)
  && projectsOf(state).some(p => p.id === (group.projectId ?? 'lead'))

/** Tags a stuck line resolves once its task is fixed or ends: in [conversationId], [messageId]'s tags of [personIds]. */
export interface ResolvedTags { conversationId: string; messageId: string; personIds: string[] }

/**
 * Each task's change since its record: a new reason posts its line, as the project's PM to the PM, tagging its requester and
 * writers who can read it, at most MAX_MENTIONS; a reason gone posts "No longer stuck" to the PM, tagging nobody, and hands back
 * the old line's tags to resolve. A task that ended while stuck says nothing, and its tags resolve. A project with no PM is left
 * until it has one. Records the change on the task in the caller's write.
 */
export function stuckAlerts(state: SuperTabState, now: number): { rows: MessageDraft[]; resolved: ResolvedTags[] } {
  const rows: MessageDraft[] = [], resolved: ResolvedTags[] = []
  const projects = projectsOf(state)
  const chats = new Set(projects.map(p => p.leadConversationId))
  for (const task of state.conversations) {
    if (!task.stuck && !task.assignment) continue
    // Ended: archived, cancelled, stopped or merged. Its tags resolve and nothing is said.
    const status = task.assignment?.status
    const live = flaggable(state, chats, task) && status !== 'cancelled' && status !== 'stopped' && !(status === 'done' && task.ledger?.mergedAt != null)
    const chat = live ? state.conversations.find(c => c.id === projects.find(p => p.id === (task.projectId ?? 'lead'))!.leadConversationId) : undefined
    const pm = chat?.leadId ? state.agents.find(a => a.id === chat.leadId) : undefined
    const was = task.stuck
    const reason = live ? stuckOf(state, task, now) : null
    if (reason?.key === was?.key || (live && !pm)) continue
    if (was) {
      resolved.push({ conversationId: task.id, messageId: was.messageId, personIds: was.tagged })
      delete task.stuck
    }
    if (!pm) continue
    const author = { kind: 'agent' as const, id: pm.id, name: pm.name, displayName: agentDisplayName(state.agents, pm.id), membershipGeneration: pm.membershipGeneration }
    const recipients = task.agentIds.includes(pm.id) ? [pm.id] : []
    if (reason) {
      const tagged = [...new Set([task.requesterId, ...task.writers ?? []])].filter((id): id is string => !!id).filter(id => {
        const person = state.people.find(p => p.id === id)
        return !!person && canReadGroup(state, { kind: 'person', userId: person.id, email: person.email }, task)
      }).slice(0, MAX_MENTIONS)
      const id = stableId('stuck', task.id, reason.key)
      rows.push({ id, conversationId: task.id, author, text: reason.text, replyTo: null, recipients, ...tagged.length ? { mentions: tagged } : {},
        source: { kind: 'system' } })
      task.stuck = { key: reason.key, messageId: id, tagged, fixed: reason.fixed }
    } else if (was) {
      rows.push({ id: stableId('stuck-fixed', task.id, was.key), conversationId: task.id, author, text: `No longer stuck: ${was.fixed}.`, replyTo: null,
        recipients, source: { kind: 'system' } })
    }
  }
  return { rows, resolved }
}
