import { z } from 'zod'

/**
 * Reactions are gone from Swarm v4 (anh Dee, 2026-11-09): nothing stores, counts or shows one, and the server adds none of its
 * own. `message.react` stays for what it means to an agent: its reaction acknowledges a message without a post (an
 * acknowledgement-only post is refused, acknowledgements.ts), so it settles that agent's delivery of the message; today's CLI
 * sends none, older ones do. A person's reaction is answered as a retired
 * command (retired.ts), counted by client. Message reads say `reactions: []` for apps from before, and the rows stored before
 * are read by nothing; they go with the Swarm or when their message is deleted. The person's answer, the empty `reactions` and
 * the delete's reaction cleanup go 30 days after the release that carries this, not before 2026-12-09.
 */

/** What `message.react` may name, as apps and agents from before send it. */
export const REACTIONS = ['thumbs_up', 'tada', 'heart', 'laugh', 'eyes', 'check', 'rocket'] as const
export const reactionSchema = z.enum(REACTIONS)

/** The message an agent's `message.react` names, found by the store in that conversation and readable by the agent. */
export interface ReactionTarget { messageId: string }
