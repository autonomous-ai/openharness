import { z } from 'zod'

/**
 * Reactions are gone from Swarm v4 (anh Dee, 2026-11-09): nothing stores, counts or shows one, and the server adds none of its
 * own. `message.react` stays for what it means to an agent: its reaction acknowledges a message without a post (an
 * acknowledgement-only post is refused, acknowledgements.ts), so it settles that agent's delivery of the message and, from the
 * project's PM, the ask it owes (pulse.ts). A person's reaction does nothing. Message reads say `reactions: []` for apps from
 * before, and the rows stored before are read by nothing; they go with the Swarm or when their message is deleted.
 */

/** What `message.react` may name, as apps and agents from before send it. */
export const REACTIONS = ['thumbs_up', 'tada', 'heart', 'laugh', 'eyes', 'check', 'rocket'] as const
export const reactionSchema = z.enum(REACTIONS)

/** The message an agent's `message.react` names, found by the store in that conversation and readable by the agent. */
export interface ReactionTarget { messageId: string }
