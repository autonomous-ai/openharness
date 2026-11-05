/**
 * The PM's inbox (task #3403, anh Dee's Swarm redesign, 11-05): its digest starts with what it owes people (pulse.ts owed
 * asks), oldest first, each with who asked, how long ago and where, so it answers each once, in its place (answers.ts). A
 * person is named by username, never by email.
 */
import type { SuperTabDelivery } from '@prisma/client'
import { crewNeedOf, type CrewNeed } from './crewNeeds.js'
import type { Agent, Author, SuperTabState } from './model.js'
import { noticeLine } from './noticeDigest.js'
import { ledProject, type SwarmProject } from './projects.js'
import { swarmUsernames } from './usernames.js'

/** What a host reports (machines.ts `capabilities`) when it sends its PM's turn with the PM's delivery list read (cli
 *  superTabs/host.ts): only then are people's messages and crew needs to that PM gathered into its inbox. An older host gets
 *  them at once, as before. */
export const INBOX_CAPABILITY = 'turnInbox'
/** How much of a person's message, or a crew need, one inbox line keeps; a notice line keeps 200 (noticeDigest.ts). */
export const INBOX_LINE_MAX = 1000

export type InboxSection = 'people' | 'crew' | 'results'

/** Which section of the inbox [message] goes in: a person's own message, a crew need (a crew-need row or a needs_human status
 *  row, crewNeeds.ts), or anything else, the results and notices. */
export function inboxSection(message: { author: Pick<Author, 'kind'>; source?: unknown }): InboxSection {
  if (crewNeedOf(message.source)) return 'crew'
  return message.author.kind === 'person' && !message.source ? 'people' : 'results'
}

/** Whether [message] to [recipient] waits for its inbox: a person's message or a crew need to a project's PM whose host sends
 *  its turn (INBOX_CAPABILITY). Results and notices are gathered as noticeDigest.ts says, whatever the host. */
export function gathersForInbox(state: SuperTabState, recipient: Agent, message: { author: Pick<Author, 'kind'>; source?: unknown }): boolean {
  if (inboxSection(message) === 'results' || !ledProject(state, recipient.id)) return false
  return !!state.machines?.find(m => m.machineId === recipient.machineId)?.observation?.capabilities?.includes(INBOX_CAPABILITY)
}

type Where = Pick<SuperTabDelivery, 'conversationId' | 'messageId'>
const oneLine = (text: string) => text.trim().replace(/\s+/g, ' ')
const shortened = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`

/** A person's message as one inbox line, by username, kept whole up to INBOX_LINE_MAX. */
export const personLine = (state: SuperTabState, delivery: Where, text: string, from: string): string =>
  noticeLine(state, delivery, text, false, from, INBOX_LINE_MAX)

/** A crew need as one inbox line: which agent needs which people, its question (else the agent's words), its options with the
 *  one recommended, and where it is. */
export function crewNeedLine(state: SuperTabState, delivery: Where, need: CrewNeed, words: string): string {
  const asker = state.agents.find(a => a.id === need.agentId), names = swarmUsernames(state)
  const who = asker ? asker.displayName ?? asker.name : 'An agent'
  const people = need.personIds.map(id => names.get(id) ?? 'a person').join(', ') || 'a person'
  const options = need.options?.length ? ` Options: ${need.options.map((o, i) => i === need.recommended ? `${o} (recommended)` : o).join(' / ')}` : ''
  const ids = ` (message ${delivery.messageId} in ${delivery.conversationId})`
  return `${shortened(`- ${who} needs ${people}: ${oneLine(need.question ?? words)}${options}`, INBOX_LINE_MAX - ids.length)}${ids}`
}

/** The asks one inbox names; the board lists them all. */
export const OWED_LINES_MAX = 10
const MINUTE = 60_000

/** [project]'s owed asks as the inbox's first lines: a header, then one line each, oldest first. None when nothing is owed. */
export function owedLines(state: SuperTabState, project: SwarmProject, now: number): string[] {
  const asks = state.conversations.filter(c => !c.archived && c.owed && (c.projectId ?? 'lead') === project.id)
    .flatMap(c => c.owed!.map(ask => ({ ...ask, conversationId: c.id }))).sort((a, b) => a.at - b.at)
  if (!asks.length) return []
  const names = swarmUsernames(state)
  const ago = (at: number) => `${Math.max(0, Math.round((now - at) / MINUTE))}m`
  return [`Owed asks (${asks.length}, oldest ${ago(asks[0]!.at)}). Answer each once, in its place: harness super-tab answer GROUP MESSAGE_ID TEXT OPERATION_ID.`,
    ...asks.slice(0, OWED_LINES_MAX).map(a => `- from ${names.get(a.personId) ?? 'a person'}, ${ago(a.at)} ago (message ${a.id} in ${a.conversationId})`),
    ...asks.length > OWED_LINES_MAX ? [`And ${asks.length - OWED_LINES_MAX} more owed: the board lists them all.`] : []]
}
