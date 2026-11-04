import { isRoleName } from './agentNames.js'
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
type Checked = { name: string } | { code: 'INVALID_AGENT_NAME' | 'AGENT_NAME_ROLE' | 'AGENT_NAME_TAKEN'; message: string; status: 400 | 409 }

/** [input] as the name of [exceptId]'s agent (or a new one), for what [actor] reads, or why it is refused. */
function checkedAgentName(state: SuperTabState, actor: Actor, exceptId: string | null, input: string): Checked {
  const name = input.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (!name || [...name].length > AGENT_NAME_LENGTH || !printable(name) || HIDDEN.test(name)) {
    return { code: 'INVALID_AGENT_NAME', message: `Use 1 to ${AGENT_NAME_LENGTH} characters, with no hidden ones.`, status: 400 }
  }
  const refused = nameRefusal(name)
  if (refused) return { code: refused.code === 'NAME_RESERVED' ? 'AGENT_NAME_ROLE' : 'INVALID_AGENT_NAME', message: refused.message, status: 400 }
  const key = nameKey(name)
  const usernames = swarmUsernames(state)
  const others = state.people.flatMap(p => [p.name, usernames.get(p.id), p.email])
  const agents = agentNamesSeenBy({ ...state, agents: state.agents.filter(a => a.id !== exceptId) }, actor)
  if ([...others, ...agents].some(other => other && nameKey(other) === key)) {
    return { code: 'AGENT_NAME_TAKEN', message: `${name} is taken in this Swarm. Choose another.`, status: 409 }
  }
  return { name }
}

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
  const checked = checkedAgentName(state, actor, target.id, input)
  if ('code' in checked) fail(checked.code, checked.message, checked.status)
  target.displayName = checked.name
}

/**
 * The name `agent.add` gives a session a person shares, which Desktop takes from the harness's own name: the same rules, but
 * a name that fails them never stops the add. It is left for a member name (a role's name already is: agentNames.ts), so a
 * harness called "System" or "Quinn" joins as someone else's name never would.
 */
export function addedAgentName(state: SuperTabState, actor: Actor, input: string): string {
  const checked = checkedAgentName(state, actor, null, input)
  // A role's name stays as it always did: the agent is given a member name for it (agentNames.ts).
  if (isRoleName(input.normalize('NFKC'))) return input
  return 'name' in checked ? checked.name : 'Agent'
}
