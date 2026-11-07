import { openSwarmBuddyChat } from './buddies.js'
import type { Agent, SuperTabState } from './model.js'

/** Gives [personId] their own default Buddy in its Swarm chat, as buddy.create and its start leave it: the agent that writes the
 *  server's notices in their private chat, where only they and it post (task #4558). */
export function giveOwnBuddy(state: SuperTabState, personId: string, id = `${personId}-buddy`): Agent {
  const member = state.people.find(p => p.id === personId)!
  const buddy = { id, machineId: `${personId}-mac`, harnessId: id, machineOwnerId: personId, contributorId: personId, membershipGeneration: member.generation,
    name: 'Buddy', configuration: { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null },
    buddyOf: { personId, generation: member.generation }, buddyScope: 'swarm' } as Agent
  state.agents.push(buddy)
  openSwarmBuddyChat(state, member).agentIds.push(id)
  return buddy
}
