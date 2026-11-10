import { isRoleName } from './agentNames.js'
import { reserved } from './buddies.js'
import type { Author, Person, SuperTabState } from './model.js'
import { swarmUsernames, usernameOf } from './usernames.js'

/**
 * Why [name] (already trimmed) cannot be a name people see for a person, or null: a web address, or a role's or the
 * Swarm's own name. The account name (lib/accountName.ts, review 1 of #2917) and an agent's (agentRename.ts) refuse the
 * same ones.
 */
export function nameRefusal(name: string): { code: 'INVALID_NAME' | 'NAME_RESERVED'; message: string } | null {
  // Read as every compare here reads it: width variants folded (NFKC), so `ＰＭ` is `PM` (review 2 of #2794).
  const folded = name.normalize('NFKC')
  // A web address would show as a link in the lines the server writes (review 2 of #2794), a protocol-relative one too
  // ("//ev.il", security review 2 of #3015).
  if (/\/\/|^www\./i.test(folded)) return { code: 'INVALID_NAME', message: 'Use a name, not a web address.' }
  // A role's or the Swarm's own voice, as a Buddy may not take (buddies.ts), and the words readers put in place of a name.
  if (isRoleName(folded) || reserved(folded) || /^(?:tester|you|someone)(?:[\s#-]+\d+)?$/i.test(folded)) {
    return { code: 'NAME_RESERVED', message: `${name} is a role's name. Choose another.` }
  }
  return null
}

/** Makes [person]'s name in a Swarm their account's [accountName] (anh Dee, 2026-11-10: with no editor left, a person's name follows
 *  their account), or none when the account has none, so their username shows. A name they chose in the Swarm before is kept in
 *  `chosenName`, read by nothing. True when anything changed. */
export function nameFromAccount(person: Person, accountName: string | null | undefined): boolean {
  const name = accountName?.trim() || undefined
  if (person.nameFollowsAccount && person.name === name) return false
  if (!person.nameFollowsAccount && person.name !== undefined) person.chosenName = person.name
  person.nameFollowsAccount = true
  if (name === undefined) delete person.name
  else person.name = name
  return true
}

/** The name the Swarm shows for person [id]: their account's (nameFromAccount), else their username. */
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

/** A message's author as an agent reads it: a person by their username and the name they show, never by the email their
 *  stored row names them with, which agents copied into commands and pull requests until a machine's privacy hook stopped
 *  their sessions (task #2954, Ken 11-04). Someone who left reads as "a person". People's apps keep the stored row, which
 *  they match to a person (Desktop superTabPersonName). [names] is `lazyUsernames(state)`, made once per read. */
export function authorForAgent<T extends Pick<Author, 'kind' | 'id'>>(state: SuperTabState, author: T, names: Usernames): T {
  if (author.kind !== 'person') return author
  const name = names.get(author.id) ?? 'a person'
  return { ...author, name, displayName: agentReadName(state.people.find(p => p.id === author.id)?.name) ?? name }
}

/** A name a person set, unless it holds an email address, which the old name editor allowed for one's own: an agent never reads one. */
const agentReadName = (name: string | undefined): string | undefined => name && !/[^\s@]+@[^\s@]+\.[^\s@]+/.test(name) ? name : undefined

/** Person [id] as server-written text an agent reads names them (writtenNameOf), never by an email they took as their name. */
export const agentWrittenNameOf = (state: SuperTabState, id: string): string | undefined =>
  agentReadName(state.people.find(p => p.id === id)?.name) ? writtenNameOf(state, id) : usernameOf(state, id)

type Row = { author: unknown; source?: unknown }
const personAuthor = (value: unknown): value is Author => !!value && typeof value === 'object' && (value as Author).kind === 'person'
/** Whether a stored row names a person by email: its author, or the person who typed into an agent's terminal (a row terminal
 *  recording stored before Swarm v4 removed it). */
export const namesPerson = (row: Row): boolean => personAuthor(row.author) || personAuthor((row.source as { operator?: unknown } | null)?.operator)
/** A stored row as an agent reads it (authorForAgent): its author and, for input someone typed into an agent's terminal, its
 *  operator by name. */
export function rowForAgent<T extends Row>(state: SuperTabState, names: Usernames, row: T): T {
  const source = row.source as { kind?: unknown; operator?: unknown } | null | undefined
  const operator = source?.operator
  return {
    ...row,
    ...personAuthor(row.author) ? { author: authorForAgent(state, row.author, names) } : {},
    ...source && personAuthor(operator) ? { source: { ...source, operator: authorForAgent(state, operator, names) } } : {},
  }
}

/** Usernames by person id, as `swarmUsernames` gives them. */
export type Usernames = Pick<ReadonlyMap<string, string>, 'get'>
/** `swarmUsernames(state)`, worked out only for a person with no stored username: a stored one is final (usernames.ts), and
 *  working out every default names every agent too, about 0.25 ms for today's 40 people and 40 agents and 7.5 ms at ten
 *  times that, on each claim and page an agent reads (task #2954). */
export function lazyUsernames(state: SuperTabState): Usernames {
  let all: Map<string, string> | undefined
  return { get: id => state.people.find(p => p.id === id)?.username ?? (all ??= swarmUsernames(state)).get(id) }
}
