import type { Conversation } from './model.js'

/** The source of the celebration row Desktop draws with confetti. No longer written: a task's line says it shipped
 *  (taskLine.ts); older rows still read as people's, and their requester's Buddy heard them (buddyNews.ts). */
export const SHIP_KIND = 'ship'

/** When the group first shipped, as the leaderboard records it (leaderboard/record.ts `recordStatus`: once, on the first Done). */
export const shippedAt = (group: Conversation): number | undefined => group.ledger?.shippedAt
