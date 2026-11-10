import type { Agent } from './model.js'

/** An asleep agent woken for work (a Buddy's, buddySleep.ts and buddyEngine.ts): its host reopens the session in place, counted
 *  from now. Whether it was asleep. Goes with Buddies (S17). */
export function wakeCrewMember(agent: Agent, now: number): boolean {
  if (!agent.asleep) return false
  delete agent.asleep
  agent.downSince = new Date(now).toISOString()
  return true
}
