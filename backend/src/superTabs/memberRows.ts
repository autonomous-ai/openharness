import { isBuddyChat } from './buddies.js'
import type { Agent, Conversation, SuperTabState } from './model.js'
import { usernameOf } from './usernames.js'

/** One agent that joined or left one chat in a command. */
export type MemberChange = { group: Conversation; agent: Agent; added: boolean }

/**
 * Who joined or left each chat between [original] and [state], for the row that names who did it (Ken, #2207: nothing
 * recorded who put a Reviewer in the project chat). Only chats there before, as a new chat's opening says who is in it; never a
 * Buddy chat, whose sessions come and go with its threads; never an agent removed from the Swarm, whose removal says so.
 */
export function memberChanges(original: SuperTabState, state: SuperTabState): MemberChange[] {
  const before = new Map(original.conversations.map(c => [c.id, c.agentIds]))
  const agents = new Map(state.agents.map(a => [a.id, a]))
  const changes: MemberChange[] = []
  for (const group of state.conversations) {
    const was = before.get(group.id)
    if (!was || isBuddyChat(group) || (was.length === group.agentIds.length && was.every((id, i) => group.agentIds[i] === id))) continue
    const then = new Set(was), now = new Set(group.agentIds)
    for (const id of group.agentIds) if (!then.has(id) && agents.has(id)) changes.push({ group, agent: agents.get(id)!, added: true })
    for (const id of was) if (!now.has(id) && agents.has(id)) changes.push({ group, agent: agents.get(id)!, added: false })
  }
  return changes
}

/** "Ken added Finn 2." / "River removed Finn 2.", or "Finn 2 joined." / "Finn 2 left." for the agent itself. */
export function memberRowText(by: { id: string; name: string }, agent: { id: string; name: string }, added: boolean): string {
  if (by.id === agent.id) return `${agent.name} ${added ? 'joined' : 'left'}.`
  return `${by.name} ${added ? 'added' : 'removed'} ${agent.name}.`
}

/** The name a row gives the actor [key] (model.ts actorKey): an agent's display name, a person's username; none once gone. */
export function actorName(state: SuperTabState, key: string): string | undefined {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  if (kind === 'agent') {
    const agent = state.agents.find(a => a.id === id)
    return agent && (agent.displayName ?? agent.name)
  }
  const person = state.people.find(p => p.id === id)
  return person && (usernameOf(state, id) ?? person.email.split('@')[0])
}
