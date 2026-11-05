// Task #3399 (docs/plans/2026-11-05-handed-on-ready-plan.md): not implemented yet.
import type { Conversation } from './model.js'
import type { PullRequestEvent } from './pullRequestEvents.js'
export { handed, occupiesAgent } from './model.js'
export const REOPEN_OWNER_MS = 60 * 60_000
export function reopenOnEvents(_group: Conversation, events: PullRequestEvent[], _now: number): PullRequestEvent[] { return events }
