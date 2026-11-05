/**
 * Nothing is typed into a busy agent (task #3403, anh Dee's Swarm redesign, 11-05): another agent's post to a crew member
 * waits for that member's turn to end, its own status change, or TURN_END_WAIT_MS, whichever comes first. Its delivery row
 * says until when (`SuperTabDelivery.waitsUntil`); the host holds it while the agent works (cli superTabs/host.ts), and an
 * older host types it as before. A person's message, and every system row (a stop, a cancel, an assignment, a moved task),
 * goes at once (River, 11-05); so does anything to a project's coordinator (its inbox) or to a Buddy.
 */
import { isBuddy } from './buddies.js'
import type { Agent, MessageDraft, SuperTabState } from './model.js'
import { ledProject } from './projects.js'

/** The longest a crew member's message waits for its turn to end. One place until the project rules record (#3393) holds it. */
export const TURN_END_WAIT_MS = 15 * 60_000

/** Whether [message] waits for [recipient]'s turn to end. */
export function waitsForTurnEnd(state: SuperTabState, recipient: Agent, message: Pick<MessageDraft, 'author' | 'source'>): boolean {
  return message.author.kind === 'agent' && !message.source && message.author.id !== recipient.id
    && !isBuddy(recipient) && !recipient.buddySession && !ledProject(state, recipient.id)
}

/** What a delivery list row says of its wait, by the server's clock: the host never compares times itself. */
export const withTurnEnd = <T extends { waitsUntil?: Date | null }>(row: T, now: number): T & { waitsForTurnEnd: boolean } =>
  ({ ...row, waitsForTurnEnd: !!row.waitsUntil && row.waitsUntil.getTime() > now })
