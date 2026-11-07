/**
 * A machine's owner hears when someone else's work starts on it (contributor view, #2444; AGENTS.md, contributed capacity: seen:
 * "their quota is never drained without them knowing"). Once per machine per leaderboard week, in their own Buddy chat, in
 * their own agent's voice; the person card shows the rest. Someone else's work is what Lent counts (leaderboard/lent.ts): a
 * task its machine's contributor did not ask for, never a PM's or a private chat's.
 */
import { defaultBuddyChat, ownAgentAuthor } from './buddies.js'
import { homeOf, weeklyUse } from './leaderboard/brought.js'
import { weekStart } from './leaderboard/week.js'
import { isLeads, type Agent, type Author, type Conversation, type SuperTabState } from './model.js'
import { canReadProject, groupProject, ledProject } from './projects.js'
import { usernameOf } from './usernames.js'

/** "3d", "5h", "20m": how long until [ms] from [now], as the Machines screen says a reset. */
function until(ms: number, now: number): string {
  const left = Math.max(0, ms - now)
  if (left >= 86_400_000) return `${Math.floor(left / 86_400_000)}d`
  if (left >= 3_600_000) return `${Math.floor(left / 3_600_000)}h`
  return `${Math.max(1, Math.floor(left / 60_000))}m`
}

/**
 * The notice for [worker] taking [group]'s work at [now], or null when it is not someone else's work on a contributed
 * machine, or its owner was told this week. Marks the machine (its Mac, for a Harness Team account) told this week.
 * [engineName]: how the server names the worker's engine ("Claude").
 */
export function othersWorkNotice(state: SuperTabState, group: Conversation, worker: Agent, now: number, engineName: string):
  { conversationId: string; machineId: string; author: Author; text: string } | null {
  if (group.audience || isLeads(group) || ledProject(state, worker.id)) return null
  const pool = state.machines?.find(m => m.machineId === worker.machineId)
  if (!pool || pool.buddyOnly || group.requesterId === pool.contributorId) return null
  const owner = state.people.find(p => p.id === pool.contributorId)
  // Written by the owner's own agent, as only they and it post in their private chat (task #4558); with none, their Members
  // card still shows what runs on the machine.
  const author = owner && ownAgentAuthor(state, owner)
  if (!owner || !author) return null
  const home = homeOf(state.machines ?? [], pool.machineId) ?? pool, week = weekStart(now)
  if (home.othersToldWeek === week) return null
  home.othersToldWeek = week
  const requester = group.requesterId && (usernameOf(state, group.requesterId) ?? state.people.find(p => p.id === group.requesterId)?.email)
  // The task's title only to an owner who reads its project: their Buddy chat is no way into a project they are not in.
  const readable = canReadProject(state, { kind: 'person', userId: owner.id, email: owner.email }, groupProject(state, group))
  const use = weeklyUse(home, worker.configuration.engine)
  const used = use.usedPercent == null ? '' : `, ${Math.round(use.usedPercent)}% of this week used${use.resetsAt == null ? '' : `, resets in ${until(use.resetsAt, now)}`}`
  return { conversationId: defaultBuddyChat(state, owner).id, machineId: pool.machineId, author,
    text: `${requester ? `${requester}'s` : 'A teammate\'s'} work${readable ? ` "${group.title}"` : ''} started on your ${home.name} (${engineName}${used}). `
      + 'Members › your card shows what it runs and ships; Manage › Machines can pause new work.' }
}
