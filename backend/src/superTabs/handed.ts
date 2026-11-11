// A task whose pull request is ready for review is handed over (task #3399, docs/plans/2026-11-05-handed-on-ready-plan.md).
// Its Engineer is free for new work (model.ts occupiesAgent: every "is this agent busy" check reads it) and keeps its GitHub
// push access (github/holds.ts HOLDING keeps `review`). A task brought back to that Engineer before Swarm v4 (a No verdict, red CI,
// a merge conflict) that it has not picked up within REOPEN_OWNER_MS is lost, so anyone free in the lane takes it (liveness.ts). A
// dispatcher looking for a free agent reads occupiesAgent from here.
import type { Assignment } from './model.js'

export { handed, occupiesAgent } from './model.js'

/** How long a reopened task waits for its own Engineer before anyone free may take it. One place until the project rules
 *  record (#3393) holds the Swarm's numbers. */
export const REOPEN_OWNER_MS = 60 * 60_000

/** Its Engineer's own status, check or post in a reopened task picks it up: from then it is any working task. */
export function pickUp(assignment: Assignment): void {
  delete assignment.reopened
}

/** When a reopened task not picked up stops waiting for its Engineer, or undefined. */
export const unclaimedAt = (assignment: Assignment): number | undefined =>
  assignment.reopened ? assignment.reopened.at + REOPEN_OWNER_MS : undefined

/** Why a reopened task leaves its Engineer now: it did not pick it up in REOPEN_OWNER_MS. Null otherwise. */
export function unclaimedReason(assignment: Assignment, now: number): string | null {
  const until = unclaimedAt(assignment)
  return until !== undefined && now > until
    ? `it came back to it (${assignment.reopened!.why.replace(/[.\s]+$/, '')}) and it did not pick it up within ${REOPEN_OWNER_MS / 60_000} minutes` : null
}
