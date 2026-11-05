/**
 * Nothing is typed into a busy agent (task #3403, anh Dee's Swarm redesign, 11-05): a post by an agent other than the PM to
 * any agent that is not a PM or a Buddy (crew as the board counts it, pulse.ts; not only #3222's standing crew) waits for
 * that agent's turn to end, its own status change, or TURN_END_WAIT_MS, whichever comes first. Its delivery row says until
 * when (`SuperTabDelivery.waitsUntil`); the host holds it while the agent works (cli superTabs/host.ts), and an older host
 * types it as before. A person's message, the PM's own post (a redirect), and every system row (a stop, a cancel, an
 * assignment, a moved task) go at once; so does anything to a PM (its inbox) or a Buddy (River, 11-05).
 */
import { isBuddy } from './buddies.js'
import type { Agent, MessageDraft, SuperTabState } from './model.js'
import { ledProject } from './projects.js'

/** The longest a crew member's message waits for its turn to end. One place until the project rules record (#3393) holds it. */
export const TURN_END_WAIT_MS = 15 * 60_000

/** Whether [message] waits for [recipient]'s turn to end. */
export function waitsForTurnEnd(state: SuperTabState, recipient: Agent, message: Pick<MessageDraft, 'author' | 'source'>): boolean {
  return message.author.kind === 'agent' && !message.source && message.author.id !== recipient.id && !ledProject(state, message.author.id)
    && !isBuddy(recipient) && !recipient.buddySession && !ledProject(state, recipient.id)
}

/** What a delivery list row says of its wait, by the server's clock: the host never compares times itself. */
export const withTurnEnd = <T extends { waitsUntil?: Date | null }>(row: T, now: number): T & { waitsForTurnEnd: boolean } =>
  ({ ...row, waitsForTurnEnd: !!row.waitsUntil && row.waitsUntil.getTime() > now })
