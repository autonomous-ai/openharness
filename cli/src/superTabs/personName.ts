/**
 * How the CLI names a person in what it hands an agent: by the name they show, else their username, never by email. Agents
 * copied emails from deliveries into commands and pull request bodies, and a machine's privacy hook stopped their sessions
 * for a person to approve (task #2954, Ken 11-04). The server names people to agents already (backend personNames.ts
 * authorForAgent); this keeps an older server's email out too.
 */
type Json = Record<string, unknown>
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
/** [name], or the part before its @ when it is an email address: the username an older server would have made from it. */
const notEmail = (name: string | undefined): string | undefined => name && EMAIL.test(name) ? name.slice(0, name.indexOf('@')) : name

/** A person row of a Swarm read, as the Swarm shows them. */
export const personName = (person: Json | undefined): string | undefined =>
  person ? notEmail(text(person.name)) ?? text(person.username) ?? notEmail(text(person.email)) : undefined

/** A message's author (or a terminal's operator): by its display name, else its stored name. An agent's stored name is the
 *  kind it was first started as ("Builder", "Lead"), not anyone the reader can name: "Message ... from Builder" left a PM
 *  unsure which Engineer wrote (Ken, 11-02). A person's is never shown as an email. */
export function authorName(author: unknown, fallback: string): string {
  const { displayName, name } = author && typeof author === 'object' ? author as Json : {}
  return notEmail(text(displayName) ?? (typeof name === 'string' && name ? name : undefined)) ?? fallback
}

/** The people [token] names, as a post's `--mention` takes it: their id, their username or display name in any case and
 *  spacing, with or without a leading @, or (older callers) their email. A username is unique in a Swarm (backend
 *  usernames.ts), so it wins; a display name two people share names them both. */
export function peopleNamed(people: Json[], token: string): Json[] {
  const key = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/gu, '').replace(/^@+/, '') : ''
  const wanted = key(token)
  if (!wanted) return []
  const byId = people.filter(p => p.id === token.trim())
  if (byId.length) return byId
  const byUsername = people.filter(p => key(p.username) === wanted)
  if (byUsername.length) return byUsername
  const byEmail = people.filter(p => key(p.email) === wanted)
  if (byEmail.length) return byEmail
  return people.filter(p => key(p.name) === wanted)
}
