/** A person, or any agent of the project, tags people in a message: the message keeps whom it tags (`mentions`), as
 *  its readers see them. Swarm v4 (anh Dee, 2026-11-10) keeps no tag list: an agent reaches its person in their 1:1 chat. */
import { fail, isLeads, type Actor, type Conversation, type SuperTabState } from './model.js'
import { canReadGroup, groupProject, inChannelOf, isAgentChat, projectAgent, projectsOf } from './projects.js'
import { usernameOf } from './usernames.js'

export const MAX_MENTIONS = 5
/** `@name` or `@name@domain`, as people tag in chat. Never right after a letter, digit, `@` or `/` (an address, a path, a
 *  link), and a name never ends in a dot: `@dee.` closes a sentence. Desktop (message_text.dart) and the phone
 *  (swarm_message_row.dart) use this same pattern; tagFixture.json is the table all three pass. */
const TAG = /(?<![\w@/])@([\w+-]+(?:\.[\w+-]+)*)(@[\w-]+(?:\.[\w-]+)+)?/g
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const blank = (part: string) => part.replace(/[^\n]/g, ' ')

/** [text] with what is never a tag blanked out, as Markdown renders it: fenced and indented code, code spans, bare links and
 *  link destinations. */
function prose(text: string): string {
  const lines = text.split('\n')
  let fence: string | null = null
  let indented = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (fence) {
      const close = FENCE.exec(line)
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !line.slice(close[0].length).trim()) fence = null
      lines[i] = blank(line)
      continue
    }
    const open = FENCE.exec(line)
    if (open && !(open[1]![0] === '`' && line.slice(open[0].length).includes('`'))) {
      fence = open[1]!
      lines[i] = blank(line)
      indented = false
      continue
    }
    // Indented code starts after a blank line (or the first line) and runs while its lines stay indented.
    const startsCode: boolean = /^( {4}|\t)/.test(line) && line.trim() !== '' && (indented || i === 0 || !lines[i - 1]!.trim())
    indented = startsCode || (indented && !line.trim())
    if (startsCode) lines[i] = blank(line)
  }
  return lines.join('\n')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, blank)
    .replace(/\]\([^)\]]*\)/g, blank)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, blank)
}

/** The tags [text] holds, in order: each name as written after its `@`, lowercased, a full address with its domain. */
export function tagTokens(text: string): string[] {
  return [...prose(text).matchAll(TAG)].map(match => `${match[1]}${match[2] ?? ''}`.toLowerCase())
}

/** The people [text] names, in order, once each: `@username` in any case, or `@` and their full address. [names] is the
 *  Swarm's usernames by person (usernames.ts swarmUsernames). */
export function namedIn(state: SuperTabState, text: string, names: ReadonlyMap<string, string>): string[] {
  const tokens = tagTokens(text)
  if (!tokens.length) return []
  const byName = new Map([...names].map(([id, name]) => [name.toLowerCase(), id]))
  const ids = tokens.flatMap(token => {
    const id = token.includes('@') ? state.people.find(p => p.email.toLowerCase() === token)?.id : byName.get(token)
    return id && state.people.some(p => p.id === id) ? [id] : []
  })
  return [...new Set(ids)]
}

/** The agents of [group] that [text] names by `@Name` (task #2963): its display name or name in any case, matched only when
 *  exactly one agent there goes by it and no person's username is the same, so a person's tag stays a tag. [names] is the
 *  Swarm's usernames by person (usernames.ts swarmUsernames). In a project's chat, its channel (Swarm v4, anh Dee 2026-11-08), every agent of the
 *  project goes by its name, joined or not: agents there talk to each other by name, as lampOS's did in its issues. */
export function agentsNamedIn(state: SuperTabState, group: Conversation, text: string, names: ReadonlyMap<string, string>): string[] {
  // No tag at all: most posts. Nothing more is read for them.
  if (!text.includes('@')) return []
  const people = new Set([...names.values()].map(name => name.toLowerCase()))
  const project = projectsOf(state).find(p => p.leadConversationId === group.id)
  const members = state.agents.filter(a => group.agentIds.includes(a.id) || (project && inChannelOf(state, a, project)))
  // A name of several words ("first builder", lampOS's PM; "a2a swarm" in the sandbox) is no one tag by TAG, which reads a
  // word: `@first builder` named nobody, or the agent called "first". Such a name is looked for whole, the longest first,
  // and what it covered is no shorter tag.
  const spaced = [...new Set(members.flatMap(a => [a.displayName, a.name]).filter((name): name is string => !!name && /\s/.test(name.trim()))
    .map(name => name.trim().toLowerCase()))].sort((a, b) => b.length - a.length)
  let rest = prose(text)
  const whole: string[] = []
  for (const name of spaced) {
    const said = new RegExp(`(?<![\\w@/])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\w+-]|\\.[\\w+-])`, 'gi')
    if (!said.test(rest)) continue
    whole.push(name)
    rest = rest.replace(said, match => blank(match))
  }
  const tokens = [...whole, ...[...rest.matchAll(TAG)].map(match => `${match[1]}${match[2] ?? ''}`.toLowerCase())
    .filter(token => !token.includes('@') && !people.has(token))]
  return [...new Set(tokens.flatMap(token => {
    const matches = members.filter(a => a.displayName?.trim().toLowerCase() === token || a.name.trim().toLowerCase() === token)
    return matches.length === 1 ? [matches[0]!.id] : []
  }))]
}

/** Whether [text] says `@` and exactly [name] outside code and links, in any case: a stored name that ends in a dot, chosen
 *  before such names were refused, reads as a shorter tag in [namedIn] but is still said. */
export function saysName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w@/])@${escaped}(?![\\w+-]|\\.[\\w+-])`, 'i').test(prose(text))
}

/** [tags] on the first line of [text], as a person types them in chat. Only text that opens with a block (a list, heading,
 *  quote, table, code, divider or link definition) keeps them on a line of their own, so that block still renders. The same
 *  rule as Desktop's SuperTabMessageText.withTags, which shows an older message's unsaid tags. */
export function withTags(tags: string[], text: string): string {
  if (!tags.length) return text
  const body = text.replace(/^(?:[ \t]*\n)+/, '')
  if (!body) return tags.join(' ')
  return OPENS_BLOCK.test(body) ? `${tags.join(' ')}\n\n${body}` : `${tags.join(' ')} ${body}`
}
const OPENS_BLOCK = new RegExp('^(?: {4}|\\t| {0,3}(?:[-*+](?:[ \\t\\n]|$)|#{1,6}(?:[ \\t\\n]|$)|>'
  + '|\\d{1,9}[.)](?:[ \\t\\n]|$)|```|~~~|\\||\\[[^\\]\\n]+\\]:'
  + '|(?:(?:\\*[ \\t]*){3,}|(?:-[ \\t]*){3,}|(?:_[ \\t]*){3,})(?:\\n|$)))')

/** Whether [actor] may tag people in [group]: a person who can post there; any agent of the project, in its own
 *  project's conversations (project instructions, phase 4); nobody in the Leads conversation. */
function mayTag(state: SuperTabState, actor: Actor, group: Conversation): boolean {
  // Nobody else reads a person's 1:1 chat with an agent of theirs, so nobody is tagged there (Swarm v4). Such a chat is in no project, so the project check below would refuse the post itself (2026-11-09).
  if (isLeads(group) || isAgentChat(group)) return false
  return actor.kind !== 'agent' || projectAgent(state, actor, groupProject(state, group).id)
}

/** The people [named] by a post's text whom it tags: only when [actor] may tag here, only people who can read [group], never
 *  the author. Anyone else stays plain text: a name in a sentence is never an error. */
export function textTags(state: SuperTabState, actor: Actor, group: Conversation, named: string[]): string[] {
  if (!mayTag(state, actor, group)) return []
  return named.filter(id => (actor.kind !== 'person' || id !== actor.userId) && state.people.some(p => p.id === id
    && canReadGroup(state, { kind: 'person', userId: p.id, email: p.email }, group)))
}

/** A person who can post here tags people; so does any agent of the project, in that project's conversations.
 *  Never in the Leads conversation, and only people who can read the conversation. A person's tag of themselves is dropped. */
export function checkMentions(state: SuperTabState, actor: Actor, group: Conversation, personIds: string[]): string[] {
  const ids = [...new Set(personIds)].filter(id => actor.kind !== 'person' || id !== actor.userId)
  if (!ids.length) return ids
  if (isLeads(group)) fail('INVALID_MENTION', 'Nobody is tagged in the Leads conversation.', 400)
  if (actor.kind === 'agent' && !projectAgent(state, actor, groupProject(state, group).id)) {
    fail('FORBIDDEN', 'Only a person or an agent of this project tags people here.', 403)
  }
  for (const id of ids) {
    const member = state.people.find(p => p.id === id) ?? fail('INVALID_MENTION', 'Tag a person in this Swarm.', 400)
    if (!canReadGroup(state, { kind: 'person', userId: member.id, email: member.email }, group)) {
      fail('INVALID_MENTION', `${usernameOf(state, member.id)} cannot read this conversation.`, 400)
    }
  }
  return ids
}
