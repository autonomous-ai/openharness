import { fail, type Actor, type Agent, type SuperTabState } from './model.js'
import { nameRefusal } from './personNames.js'
import { printable } from './profile.js'
import { agentNamesSeenBy, nameKey, swarmUsernames } from './usernames.js'

/** Characters, not UTF-16 units, as a person's name counts (personNames.ts). */
const AGENT_NAME_LENGTH = 60
/** What hides a name: the default-ignorables, and the Braille blank U+2800, which no category marks. */
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\u2800]/u

/**
 * `agent.rename`: the name a person gave their agent with Rename Harness, which every reader's list shows. Only the agent's
 * contributor or its machine's owner, as a person, may (security review 2 of #3015). The name passes what a person's does
 * (personNames.ts `nameRefusal`: no web address, no role's or the Swarm's own name) and is not a name or username or email
 * of anyone here, nor another agent's that [actor] can read: a name nobody can take to pass as someone else, and a refusal
 * that never tells them an agent they cannot read exists.
 */
export function renameAgentTo(state: SuperTabState, actor: Actor, target: Agent, input: string): void {
  if (actor.kind !== 'person' || (actor.userId !== target.contributorId && actor.userId !== target.machineOwnerId)) {
    fail('FORBIDDEN', 'Only the person who runs this agent, or its machine\'s owner, can rename it.', 403)
  }
  const name = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > AGENT_NAME_LENGTH || !printable(name) || HIDDEN.test(name)) {
    fail('INVALID_AGENT_NAME', `Use 1 to ${AGENT_NAME_LENGTH} characters, with no hidden ones.`, 400)
  }
  const refused = nameRefusal(name)
  if (refused) fail(refused.code === 'NAME_RESERVED' ? 'AGENT_NAME_ROLE' : 'INVALID_AGENT_NAME', refused.message, 400)
  const key = nameKey(name)
  const usernames = swarmUsernames(state)
  const others = state.people.flatMap(p => [p.name, usernames.get(p.id), p.email])
  const agents = agentNamesSeenBy({ ...state, agents: state.agents.filter(a => a.id !== target.id) }, actor)
  if ([...others, ...agents].some(other => other && nameKey(other) === key)) {
    fail('AGENT_NAME_TAKEN', `${name} is taken in this Swarm. Choose another.`, 409)
  }
  target.displayName = name
}
