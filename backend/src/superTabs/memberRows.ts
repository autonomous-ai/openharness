import { agentDisplayName } from './agentNames.js'
import { isBuddyChat } from './buddies.js'
import { stableId, type Agent, type Conversation, type MessageDraft, type SuperTabState } from './model.js'
import { agentWrittenNameOf } from './personNames.js'

/** One agent that joined or left one chat in a command. */
export type MemberChange = { group: Conversation; agent: Agent; added: boolean }

/**
 * Who joined or left each chat between [original] and [state], for the row that names who did it (Ken, #2207: nothing
 * recorded who put a Reviewer in the project chat). Only chats there before, as a new chat's opening says who is in it; never a
 * Buddy chat, whose sessions come and go with its threads. An agent that left the Swarm is found in each chat it was in, by
 * its name as it was (Luna's review: a host-confirmed stop said nothing), but for an archived or dormant one.
 */
export function memberChanges(original: SuperTabState, state: SuperTabState): MemberChange[] {
  const before = new Map(original.conversations.map(c => [c.id, c.agentIds]))
  const agents = new Map([...original.agents, ...state.agents].map(a => [a.id, a]))
  const changes: MemberChange[] = []
  for (const group of state.conversations) {
    const was = before.get(group.id)
    if (!was || isBuddyChat(group) || (was.length === group.agentIds.length && was.every((id, i) => group.agentIds[i] === id))) continue
    const then = new Set(was), now = new Set(group.agentIds)
    for (const id of group.agentIds) if (!then.has(id) && agents.has(id)) changes.push({ group, agent: agents.get(id)!, added: true })
    // Nobody reads an archived or dormant chat, and any row wakes it (parts/commit.ts): a long-lived agent's close woke every
    // quiet chat it was ever in (Luna's re-review). Its leaving is said only where people still read.
    if (group.archived || group.dormant) continue
    for (const id of was) if (!now.has(id) && agents.has(id)) changes.push({ group, agent: agents.get(id)!, added: false })
  }
  return changes
}

/** An agent's name as these rows give it: quoted, as it is free text and the rows are the chat's record of who is in it, so a
 *  name written as a sentence ("Finn. Ken removed Reviewer") or holding quotes reads as one name (Luna's review). */
export const quotedName = (name: string): string => JSON.stringify(name)

/** 'ken15 added "Finn 2".' / '"River" removed "Finn 2".', or '"Finn 2" joined.' / '"Finn 2" left.' for the agent itself. [by]'s
 *  label is actorLabel's. */
export function memberRowText(by: { id: string; label: string }, agent: { id: string; name: string }, added: boolean): string {
  if (by.id === agent.id) return `${quotedName(agent.name)} ${added ? 'joined' : 'left'}.`
  return `${by.label} ${added ? 'added' : 'removed'} ${quotedName(agent.name)}.`
}

/** How a row names the actor [key] (model.ts actorKey): an agent by its quoted display name, a person by the name the Swarm shows for them; none
 *  once gone. */
export function actorLabel(state: SuperTabState, key: string): string | undefined {
  const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
  if (kind === 'agent') {
    const agent = state.agents.find(a => a.id === id)
    return agent && quotedName(agent.displayName ?? agent.name)
  }
  const person = state.people.find(p => p.id === id)
  // Agents read these rows: by name, never an email someone took as their name (review of #2954).
  return person && (agentWrittenNameOf(state, id) ?? person.email.split('@')[0])
}

/**
 * The rows for the chats a machine's report closed [agentIds]' sessions out of or reopened them into (store.ts; Cleo, Orion,
 * Luna and Echo: these ran outside any command and wrote nothing, so an agent could come back to read its chats unrecorded).
 * Nobody asked for them, so each says what happened, written as the agent itself and shown to the chat's readers, waking
 * nobody. [stamp] keeps one report's rows apart from another's.
 */
export function sessionRows(original: SuperTabState, state: SuperTabState, agentIds: ReadonlySet<string>, stamp: string): MessageDraft[] {
  return memberChanges(original, state).filter(change => agentIds.has(change.agent.id)).map(({ group, agent, added }) => {
    const name = agent.displayName ?? agentDisplayName(state.agents, agent.id) ?? agent.name
    return { id: stableId('member-session', stamp, group.id, agent.id), conversationId: group.id,
      author: { kind: 'agent' as const, id: agent.id, name: agent.name, displayName: name, membershipGeneration: agent.membershipGeneration },
      text: `${quotedName(name)} ${added ? 'rejoined: its session reopened' : 'left: its session closed'}.`, replyTo: null, recipients: [],
      source: { kind: 'system' } }
  })
}
