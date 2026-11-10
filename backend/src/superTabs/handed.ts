// A task whose pull request is ready for review is handed over (task #3399, docs/plans/2026-11-05-handed-on-ready-plan.md).
// Its Engineer is free for new work (model.ts occupiesAgent: every "is this agent busy" check reads it) and keeps its GitHub
// push access (github/holds.ts HOLDING keeps `review`). A No verdict, red CI or a merge conflict brings the same attempt back
// to that Engineer; if it is down, or has not picked it up within REOPEN_OWNER_MS, the task is lost, so anyone free in the
// lane takes it (liveness.ts). A dispatcher looking for a free agent reads occupiesAgent from here.
import { handed, type Assignment, type Conversation } from './model.js'
import type { PullRequestEvent } from './pullRequestEvents.js'

export { handed, occupiesAgent } from './model.js'

/** How long a reopened task waits for its own Engineer before anyone free may take it. One place until the project rules
 *  record (#3393) holds the Swarm's numbers. */
export const REOPEN_OWNER_MS = 60 * 60_000
/** What the Engineer is told after why its task came back. */
export const BACK_WITH_YOU = 'Your task is back with you: fix it on the same branch and mark it ready for review again.'
/** The PR watch's events that reopen a handed task (pullRequestEvents.ts keys): CI failed on the head, or a merge conflict. */
const REOPENS = /^(ci-red|conflict):/
const WHY_MAX = 300

/** Brings a handed [group] back to its Engineer, in the same attempt: same assignment id, so its GitHub hold neither ends nor
 *  starts, and its run ledger ("built by") is untouched. Its lease runs REOPEN_OWNER_MS from now. False when it is not handed. */
export function reopenHanded(group: Conversation, why: string, now: number): boolean {
  if (!handed(group)) return false
  const assignment = group.assignment!
  assignment.status = 'working'
  assignment.reopened = { at: now, why: why.trim().slice(0, WHY_MAX) }
  assignment.progressAt = now
  assignment.leaseUntil = Math.max(assignment.leaseUntil ?? 0, now + REOPEN_OWNER_MS)
  return true
}

/** The PR watch's new [events] for [group]: the first that reopens it does so, and its message to the Engineer says the task is
 *  back with it. The events as they are told. */
export function reopenOnEvents(group: Conversation, events: PullRequestEvent[], now: number): PullRequestEvent[] {
  const trigger = events.find(event => REOPENS.test(event.key))
  if (!trigger || !reopenHanded(group, trigger.text, now)) return events
  return events.map(event => event === trigger ? { ...event, text: `${event.text} ${BACK_WITH_YOU}` } : event)
}

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
