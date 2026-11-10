/**
 * The PM's inbox (task #3403, anh Dee's Swarm redesign, 11-05): people's new messages and its crew's needs, each with who
 * asked and where, so it answers each once, in its place (answers.ts). A person is named by username, never by email.
 */
import type { SuperTabDelivery } from '@prisma/client'
import { crewNeedOf, type CrewNeed } from './crewNeeds.js'
import type { Agent, Author, SuperTabState } from './model.js'
import { digestIsDue, noticeLine } from './noticeDigest.js'
import { TURN_END_WAIT_MS } from './turnEnd.js'
import { ledProject } from './projects.js'
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

/** Whether [agent] leads a project and its host sends its turn with its list read (INBOX_CAPABILITY, from its machine's report). */
export const turnInboxHost = (state: SuperTabState, agent: Agent): boolean => !!ledProject(state, agent.id)
  && !!state.machines?.find(m => m.machineId === agent.machineId)?.observation?.capabilities?.includes(INBOX_CAPABILITY)

/** Only crew needs wait for a turn-aware PM's inbox (#3609). People waited 2–15 minutes behind this gate;
 *  their original messages now go straight to the session, while noticeDigest.ts still batches agents' notices. */
export const gathersForInbox = (state: SuperTabState, recipient: Agent, message: { author: Pick<Author, 'kind'>; source?: unknown }): boolean =>
  inboxSection(message) === 'crew' && turnInboxHost(state, recipient)

/** Whether the PM's gathered rows, oldest first, go out now. A read that sends no turn (an older host) keeps the notice
 *  digest's own clock. One that does: when the oldest has waited TURN_END_WAIT_MS, whatever the turn; at idle, at once for a
 *  person's message or a crew need, and on the digest's clock for notices alone, which it batches (Relay's review of #3278:
 *  each message is a new turn of a long-context session). */
export function inboxDue(gathered: ReadonlyArray<Pick<SuperTabDelivery, 'createdAt' | 'inboxSection'>>, now: number, turn: 'idle' | 'busy' | undefined): boolean {
  const oldest = gathered[0]
  if (!oldest) return false
  if (turn === undefined) return digestIsDue(oldest, now)
  if (now - oldest.createdAt.getTime() >= TURN_END_WAIT_MS) return true
  return turn === 'idle' && (digestIsDue(oldest, now) || gathered.some(d => d.inboxSection))
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
  // A crew-need row's own text (crewNeeds.ts crewNeedText) starts with its lead-in and ends with its options: the line says both.
  const asked = need.question ?? words.replace(/^Crew need for [^\n]*\n\n/, '').replace(/\n\nOptions: [\s\S]*$/, '')
  return `${shortened(`- ${who} needs ${people}: ${oneLine(asked)}${options}`, INBOX_LINE_MAX - ids.length)}${ids}`
}
