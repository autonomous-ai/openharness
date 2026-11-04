import { isRoleName } from './agentNames.js'
import { reserved } from './buddies.js'
import { fail, person, type Actor, type SuperTabState } from './model.js'
import { printable } from './profile.js'
import { agentNamesSeenBy, nameKey, swarmUsernames, usernameOf } from './usernames.js'

/** Characters, not UTF-16 units: a name in any script, or with an emoji, gets the same room. */
export const MAX_NAME_LENGTH = 40

/**
 * Why [name] (already trimmed) cannot be a name people see for a person, or null: a web address, or a role's or the
 * Swarm's own name. A Swarm name (setName below) and the account name (lib/accountName.ts, review 1 of #2917) refuse
 * the same ones.
 */
export function nameRefusal(name: string): { code: 'INVALID_NAME' | 'NAME_RESERVED'; message: string } | null {
  // Read as every compare here reads it: width variants folded (NFKC), so `ＰＭ` is `PM` (review 2 of #2794).
  const folded = name.normalize('NFKC')
  // A web address would show as a link in the lines the server writes (review 2 of #2794).
  if (/:\/\/|^www\./i.test(folded)) return { code: 'INVALID_NAME', message: 'Use a name, not a web address.' }
  // A role's or the Swarm's own voice, as a Buddy may not take (buddies.ts), and the words readers put in place of a name.
  if (isRoleName(folded) || reserved(folded) || /^(?:tester|you|someone)(?:[\s#-]+\d+)?$/i.test(folded)) {
    return { code: 'NAME_RESERVED', message: `${name} is a role's name. Choose another.` }
  }
  return null
}

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
  const refused = nameRefusal(name)
  if (refused) fail(refused.code, refused.message, 400)
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

/** Markdown's punctuation, escaped so a name reads as the words it is (CommonMark backslash escapes); a dot only after the
 *  digits a name may open with, where "1. Ken" would start a list. */
const escaped = (text: string): string =>
  text.replace(/[\\`*_{}[\]()#+\-!<>|~]/g, c => `\\${c}`).replace(/^(\d+)\./, '$1\\.')

/** The name of person [id] as text the server writes into a message, which readers render as Markdown: a name they set,
 *  escaped, so `[Ken](https://ev.il)` never becomes a link in a Lead's line (review 1 of #2794); else their username, as
 *  today (its letters, digits, `.`, `_` and `-` never form Markdown on their own). */
export function writtenNameOf(state: SuperTabState, id: string): string | undefined {
  const name = state.people.find(p => p.id === id)?.name
  return name ? escaped(name) : usernameOf(state, id)
}
