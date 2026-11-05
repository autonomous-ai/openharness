/** People talk only to the PM (anh Dee, 2026-11-05; task #3404, River's ruling). When an agent other than its project's PM
 *  tags a person, needs a person (needs_human), asks a person a decision or sends a person a line, the person is not told:
 *  the PM gets a crew need, and the agent's command result says so. This routes; it never refuses. The PM tags anyone. Any
 *  other agent may still tag the person it is answering (the author of the message it answers or replies to). A project with
 *  no PM in its chat routes nothing, so its tags reach people as before.
 *
 *  A crew need is either its own row (source kind `crew-need`: a tag, a decision ask, a line to a person) or the needs_human
 *  status row the agent already writes to the PM (`source.crewNeed`). `crewNeedOf` reads both; the PM's inbox (#3403) lists
 *  them. Neither is gathered into the notice digest (noticeDigest.ts DIGEST_KINDS). */
import { isBuddyChat } from './buddies.js'
import type { Actor, Conversation, SuperTabState } from './model.js'
import { agentWrittenNameOf } from './personNames.js'
import { groupProject } from './projects.js'

export const CREW_NEED_KIND = 'crew-need'
/** How much of the agent's words a crew need's text quotes; the PM reads the rest at its message. */
const QUOTE_MAX = 600

/** What the PM's inbox lists for one crew need. [messageId] is where the agent asked: its post, its status row, or the crew-need
 *  row itself for an ask or a line that has no message of its own. */
export interface CrewNeed {
  agentId: string
  personIds: string[]
  messageId: string
  conversationId: string
  question?: string
  options?: string[]
  recommended?: number
}

/** The crew need a stored message's source carries, in either shape, or null. */
export function crewNeedOf(source: unknown): CrewNeed | null {
  const need = (source as { crewNeed?: unknown } | null | undefined)?.crewNeed as Partial<CrewNeed> | undefined
  return need && typeof need.agentId === 'string' && Array.isArray(need.personIds) && typeof need.messageId === 'string'
    && typeof need.conversationId === 'string' ? need as CrewNeed : null
}

/** The PM of [group]'s project: the lead of the project's chat, while it is in that chat; null when the project has none. */
export function projectPm(state: SuperTabState, group: Conversation): string | null {
  const project = groupProject(state, group)
  const chat = state.conversations.find(c => c.id === project.leadConversationId)
  return chat?.leadId && chat.agentIds.includes(chat.leadId) ? chat.leadId : null
}

/** The PM [actor]'s words to people in [group] go to instead, or null when they reach people as before: a person, the PM
 *  itself, a Buddy chat, a project with no PM. */
export function routesToPm(state: SuperTabState, actor: Actor, group: Conversation): string | null {
  if (actor.kind !== 'agent' || isBuddyChat(group)) return null
  const pm = projectPm(state, group)
  return pm && pm !== actor.agentId ? pm : null
}

/** Where the PM reads a crew need about [group]: there when the PM is one of its members, else the project's chat. */
export function crewNeedPlace(state: SuperTabState, group: Conversation, pm: string): string {
  return group.agentIds.includes(pm) ? group.id : groupProject(state, group).leadConversationId
}

const namesOf = (state: SuperTabState, personIds: readonly string[]) => personIds.map(id => agentWrittenNameOf(state, id) ?? id).join(', ')
const quoted = (text: string) => text.length <= QUOTE_MAX ? text : `${text.slice(0, QUOTE_MAX - 1).trimEnd()}…`

/** A crew need row's text, for the PM: who it is for and the agent's words. */
export function crewNeedText(state: SuperTabState, personIds: readonly string[], words: string, options?: readonly string[], recommended?: number): string {
  const choices = options?.length ? `\n\nOptions: ${options.map((o, i) => i === recommended ? `${o} (recommended)` : o).join(' / ')}` : ''
  return `Crew need for ${namesOf(state, personIds) || 'a person'}, through you (people talk only to the PM):\n\n${quoted(words)}${choices}`
}

/** What the agent is told in its command's result. */
export function routedLine(state: SuperTabState, personIds: readonly string[]): string {
  const who = personIds.length ? namesOf(state, personIds) : 'a person'
  return `Sent to the PM as a crew need, not to ${who}: people talk only to the PM, who asks them and brings the answer back to you.`
}
