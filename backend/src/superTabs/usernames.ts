import { assignAgentDisplayNames } from './agentNames.js'
import { isBuddy } from './buddies.js'
import { fail, person, type Actor, type Agent, type Person, type SuperTabState } from './model.js'
import { agentProjectId, canReadAgent, projectsOf } from './projects.js'

/** A username as a person types it: 2 to 32 lowercase letters, digits, `.`, `_` or `-`, starting with a letter or digit. Never
 *  a dot at its end or two in a row, so `@name` in a message tags them (mentions.ts: `@dee.` closes a sentence). */
const SHAPE = /^[a-z0-9](?:[a-z0-9_-]|\.(?!\.)){0,30}[a-z0-9_-]$/
/** Room left in a default for its number (`ken` → `ken12`). */
const DEFAULT_BASE_LENGTH = 30

/** The name a person's email prefix makes: lowercased, only the characters a username takes, never too short. Like a chosen
 *  name (SHAPE), never a dot at its end or two in a row, so `@name` in a message tags them: trimmed after it is cut. */
function base(email: string): string {
  const prefix = email.split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '')
    .slice(0, DEFAULT_BASE_LENGTH).replace(/\.+$/, '')
  if (!prefix) return 'user'
  return prefix.length < 2 ? `${prefix}1` : prefix
}

/**
 * Every person's username, by id: the one they chose (or one kept for them), else their email prefix, numbered (`ken2`,
 * `ken3`) after the names of everyone who joined before them, every chosen name and [agentNames], so nobody is
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

/** The names the Swarm shows its agents, as `assignAgentDisplayNames` gives them, without changing [state], for those [counts]
 *  keeps. A Buddy never counts: it is one person's, named for them. */
function agentNames(state: Pick<SuperTabState, 'agents'>, counts: (agent: Agent) => boolean): string[] {
  const named = state.agents.map(agent => ({ ...agent }))
  assignAgentDisplayNames(named)
  return named.filter(agent => !isBuddy(agent) && counts(agent)).map(agent => agent.displayName ?? agent.name)
}

/** Agents every member sees, those of shared projects: only these number a default, which every member reads. An agent some
 *  members cannot see never shapes a name they can (review of #2088). */
const sharedAgentNames = (state: SuperTabState): string[] => agentNames(state, agent => {
  // An agent of a project that is gone counts for nobody; every read works this out, so it never throws.
  const project = projectsOf(state).find(p => p.id === agentProjectId(state, agent))
  return !!project && project.visibility !== 'private'
})

/** Every person's username in [state], by id. */
export const swarmUsernames = (state: SuperTabState): Map<string, string> => usernames(state.people, sharedAgentNames(state))
export const usernameOf = (state: SuperTabState, id: string): string | undefined => swarmUsernames(state).get(id)

/** `member.username`: a person chooses their own name, or clears it to go back to their default. Unique in the Swarm. */
export function setUsername(state: SuperTabState, actor: Actor, input: string | null): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Only a person has a username.', 403)
  // A viewer too: their name is theirs, though they write nothing else (commands.ts authorizeCommandAccess).
  const member = person(state, actor.userId)
  if (input === null) return void delete member.username
  const name = input.trim().toLowerCase()
  if (!SHAPE.test(name)) fail('INVALID_USERNAME', 'Use 2 to 32 letters, digits, dots, dashes or underscores, starting with a letter or digit, with no dot at the end or two in a row.', 400)
  // Only agents this person can see, the scope their reads use: refusing another's name would tell them it exists.
  const sees = (agent: Agent) => projectsOf(state).some(p => p.id === agentProjectId(state, agent)) && canReadAgent(state, actor, agent)
  if (agentNames(state, sees).some(agent => agent.toLowerCase() === name)) {
    fail('USERNAME_TAKEN', `${name} is an agent’s name here.`, 409)
  }
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
