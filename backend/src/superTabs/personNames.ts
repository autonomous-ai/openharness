import { fail, person, type Actor, type SuperTabState } from './model.js'
import { printable } from './profile.js'
import { agentNamesSeenBy, nameKey, swarmUsernames, usernameOf } from './usernames.js'

/** Characters, not UTF-16 units: a name in any script, or with an emoji, gets the same room. */
export const MAX_NAME_LENGTH = 40

/**
 * `member.name`: a person sets the name the Swarm shows for them ("Minh Nguyen"), or clears it to show their username
 * again. Their username stays the handle a tag types. Trimmed, with one space between words, and never another member's
 * name, username or email, or an agent's name they can see, as [nameKey] compares them: a name nobody can take to pass
 * as someone else.
 */
export function setName(state: SuperTabState, actor: Actor, input: string | null): void {
  if (actor.kind !== 'person') fail('HUMAN_REQUIRED', 'Only a person has a name.', 403)
  // A viewer too: their name is theirs, though they write nothing else (commands.ts authorizeCommandAccess).
  const member = person(state, actor.userId)
  if (input === null) return void delete member.name
  const name = input.normalize('NFC').replace(/[\t\p{Zs}]+/gu, ' ').trim()
  if (!name || [...name].length > MAX_NAME_LENGTH || !printable(name)) {
    fail('INVALID_NAME', `Use 1 to ${MAX_NAME_LENGTH} characters, with no hidden ones.`, 400)
  }
  const key = nameKey(name)
  const usernames = swarmUsernames(state)
  const others = state.people.filter(p => p.id !== member.id)
    .flatMap(p => [p.name, usernames.get(p.id), p.email])
  if ([...others, ...agentNamesSeenBy(state, actor)].some(other => other && nameKey(other) === key)) {
    fail('NAME_TAKEN', 'Someone here already goes by that name.', 409)
  }
  member.name = name
}

/** The name the Swarm shows for person [id]: the one they set, else their username. */
export const shownNameOf = (state: SuperTabState, id: string): string | undefined =>
  state.people.find(p => p.id === id)?.name ?? usernameOf(state, id)
