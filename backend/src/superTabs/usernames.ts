import { assignAgentDisplayNames } from './agentNames.js'
import { fail, person, type Actor, type Person, type SuperTabState } from './model.js'

/** A username as a person types it: 2 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. */
const SHAPE = /^[a-z0-9][a-z0-9._-]{1,31}$/
/** Room left in a default for its number (`ken` → `ken12`). */
const DEFAULT_BASE_LENGTH = 30

/** The name a person's email prefix makes: lowercased, only the characters a username takes, never too short. */
function base(email: string): string {
  const prefix = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, DEFAULT_BASE_LENGTH)
  if (!prefix) return 'user'
  return prefix.length < 2 ? `${prefix}1` : prefix
}

/**
 * Every person's username, by id: the one they chose (or one kept for them), else their email prefix, numbered (`ken2`,
 * `ken3`) after the names of everyone who joined before them, every chosen name and every agent's name, so nobody is
 * `@River` beside the Product Manager. [people] are in join order (the state's own order). Readers get these names from
 * the server (read/views.ts, model.ts visibleState); Desktop works out the same defaults only for an older server.
 */
export function usernames(people: ReadonlyArray<Pick<Person, 'id' | 'email' | 'username'>>, agentNames: Iterable<string> = []): Map<string, string> {
  const taken = new Set([...people.flatMap(p => p.username ? [p.username] : []), ...[...agentNames].map(name => name.toLowerCase())])
  const names = new Map<string, string>()
  for (const member of people) {
    if (member.username) {
      names.set(member.id, member.username)
      continue
    }
    const root = base(member.email)
    let name = root
    for (let n = 2; taken.has(name); n++) name = `${root}${n}`
    taken.add(name)
    names.set(member.id, name)
  }
  return names
}

/** The names the Swarm shows its agents, as `assignAgentDisplayNames` gives them, without changing [state]. */
export function agentNames(state: Pick<SuperTabState, 'agents'>): string[] {
  const named = state.agents.map(agent => ({ ...agent }))
  assignAgentDisplayNames(named)
  return named.map(agent => agent.displayName ?? agent.name)
}

/** Every person's username in [state], by id. */
export const swarmUsernames = (state: Pick<SuperTabState, 'people' | 'agents'>): Map<string, string> => usernames(state.people, agentNames(state))
export const usernameOf = (state: SuperTabState, id: string): string | undefined => swarmUsernames(state).get(id)

/** `member.username`: a person chooses their own name, or clears it to go back to their default. Unique in the Swarm. */
export function setUsername(state: SuperTabState, actor: Actor, input: string | null): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Only a person has a username.', 403)
  // A viewer too: their name is theirs, though they write nothing else (commands.ts authorizeCommandAccess).
  const member = person(state, actor.userId)
  if (input === null) return void delete member.username
  const name = input.trim().toLowerCase()
  if (!SHAPE.test(name)) fail('INVALID_USERNAME', 'Use 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit.', 400)
  if (agentNames(state).some(agent => agent.toLowerCase() === name)) fail('USERNAME_TAKEN', `${name} is an agent’s name here.`, 409)
  for (const [id, other] of swarmUsernames(state)) {
    if (id !== member.id && other === name) fail('USERNAME_TAKEN', `${name} is taken.`, 409)
  }
  member.username = name
}

/** A name never changes under anyone, since tags and habits use it: when a command would move someone's default (the name
 *  before it was freed by a rename or a departure, or an agent now has it), they keep the name they had, stored now. */
export function keepUsernames(before: SuperTabState, after: SuperTabState): void {
  const was = swarmUsernames(before)
  // Only defaults: someone who cleared their own chosen name meant to go back to theirs.
  const defaulted = new Set(before.people.filter(p => !p.username).map(p => p.id))
  // One at a time: keeping one person's name can move the next default again.
  for (;;) {
    const now = swarmUsernames(after)
    const moved = after.people.find(p => !p.username && defaulted.has(p.id) && now.get(p.id) !== was.get(p.id))
    if (!moved) return
    moved.username = was.get(moved.id)!
  }
}
