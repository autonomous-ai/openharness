import { activeWork, type Agent, type MessageDraft, type SuperTabState } from './model.js'
import { isBuddy, isBuddyChat, isSwarmBuddy } from './buddies.js'
import { switched } from './boardRights.js'
import { SLEEP_IDLE_MS } from './crewRules.js'
import { MACHINE_FRESH_MS } from './machines.js'
import { agentProjectId, canReadGroup, canReadProject, projectsOf } from './projects.js'
import { groupsOf, idleSince } from './tidy.js'
import { wakeCrewMember } from './crewKeep.js'
import { startWake } from './crewTimes.js'
import { buddiesHearing } from './buddyNews.js'

/** Only a current main Buddy in Board projects can rest (#3824). */
export function buddySleepManaged(state: SuperTabState, agent: Agent): boolean {
  if (!isBuddy(agent) || agent.buddySession || agent.workDecision === 'stop' || agent.movedTo) return false
  const person = state.people.find(p => p.id === agent.buddyOf!.personId && p.generation === agent.buddyOf!.generation)
  if (!person) return false
  const reader = { kind: 'person' as const, userId: person.id, email: person.email }
  const home = state.conversations.find(c => isBuddyChat(c) && c.agentIds.includes(agent.id) && !c.archived && canReadGroup(state, reader, c))
  if (!home) return false
  // Keep an already resting Buddy resumable even if a project switches back to chat while it is asleep.
  if (agent.asleep || agent.crewWaking) return true
  const projects = projectsOf(state).filter(p => isSwarmBuddy(agent) ? canReadProject(state, reader, p) : p.id === agentProjectId(state, agent))
  return projects.length > 0 && projects.every(p => canReadProject(state, reader, p) && switched(p))
}

/** Quiet output is not idle proof: only the host's fresh, positive engine activity reading allows a sleep. */
export function buddySleepCandidates(state: SuperTabState, now: number): Agent[] {
  if (state.paused) return []
  return state.agents.filter(agent => {
    if (agent.asleep || agent.modelRequest || agent.switchRequest || agent.switchLanded || !buddySleepManaged(state, agent)) return false
    const pool = state.machines?.find(m => m.machineId === agent.machineId), reading = pool?.observation
    if (!pool || pool.paused || pool.removal || !reading || now - reading.receivedAt > MACHINE_FRESH_MS
      || !reading.runningHarnessIds.includes(agent.harnessId) || !reading.idleBuddyHarnessIds?.includes(agent.harnessId)) return false
    const groups = groupsOf(state, agent)
    if (groups.some(g => g.assignment?.agentId === agent.id && activeWork(g))) return false
    const since = idleSince(agent, groups)
    const homeActivity = groups.filter(isBuddyChat).flatMap(g => g.lastActivityAt ? [Date.parse(g.lastActivityAt)] : []).filter(Number.isFinite)
    return since !== undefined && now - Math.max(since, ...homeActivity) >= SLEEP_IDLE_MS
  })
}

/** The store checks open deliveries under the same guarded agent write before applying a candidate. */
export function sleepBuddies(_state: SuperTabState, candidates: Agent[], busy: ReadonlySet<string>, now: number): void {
  for (const agent of candidates) if (!busy.has(agent.id) && !agent.asleep) agent.asleep = { since: now }
}

/** Final, authorized recipients decide who wakes, including private notices omitted from the shown message counter. */
export function wakeBuddies(state: SuperTabState, message: MessageDraft, now: number): void {
  const group = state.conversations.find(c => c.id === message.conversationId)
  if (!group) return
  for (const buddy of buddiesHearing(state, [message])) {
    if (buddy.buddySession || !state.people.some(p => p.id === buddy.buddyOf!.personId && p.generation === buddy.buddyOf!.generation)
      || !canReadGroup(state, { kind: 'agent', agentId: buddy.id, machineOwnerId: buddy.machineOwnerId }, group)) continue
    if (wakeCrewMember(buddy, now)) {
      buddy.keptAt = now
      startWake(buddy, group.id, now)
    }
  }
}
