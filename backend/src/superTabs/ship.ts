import type { Conversation } from './model.js'

/** When the group first shipped, as the leaderboard records it (leaderboard/record.ts `recordStatus`: once, on the first Done). */
export const shippedAt = (group: Conversation): number | undefined => group.ledger?.shippedAt
