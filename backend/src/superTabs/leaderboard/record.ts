/**
 * What the leaderboard counts, recorded as it happens on the group it happened in (docs/swarms.md, Leaderboard): when a
 * request was asked and first shipped, which item waits on a person, and who answered it. Only facts and times, never text.
 */
import type { Actor, Assignment, Conversation, SuperTabState, WorkStatus } from '../model.js'
import { groupProject } from '../projects.js'
import { WEEK_MS } from './week.js'

export interface Unblock { personId: string; at: number; waitedMs: number }
/** A group's leaderboard bookkeeping; readers never get it whole (read/views.ts groupView). */
export interface GroupLedger {
  askedAt?: number
  /** The first time its work was done; a group is one request, so finishing it again ships nothing new. */
  shippedAt?: number
  /** The item waiting on a person: the attempt, since when, the "Needs a human" row it posted, and once a person answered it,
   *  when. An answered item no longer waits, though its worker has not moved on yet. */
  waiting?: { assignmentId: string; since: number; messageId: string; answeredAt?: number }
  /** Answers within the last LEDGER_WEEKS, oldest first. */
  unblocks?: Unblock[]
}

/** The leaderboard reads this week and last; a little more keeps a streak and week boundaries safe. */
export const LEDGER_WEEKS = 5

/** A shared group is asked when it is opened. A private conversation is chat only and never counts. */
export function recordAsked(group: Conversation, requesterId: string | undefined, now: number): void {
  if (group.audience) return
  if (requesterId) group.requesterId = requesterId
  group.ledger = { askedAt: now }
}

/** A status change opens, closes or ships: needs_human starts a wait (again, when the agent asks anew after an answer), any
 *  other status ends it, done ships once. */
export function recordStatus(group: Conversation, assignment: Assignment, previous: WorkStatus, now: number, messageId: string | null): void {
  const ledger = group.ledger ??= {}
  const open = ledger.waiting?.assignmentId === assignment.id && ledger.waiting.answeredAt == null
  if (assignment.status === 'needs_human' && messageId && (previous !== 'needs_human' || !open)) {
    ledger.waiting = { assignmentId: assignment.id, since: now, messageId }
  } else if (assignment.status !== 'needs_human') delete ledger.waiting
  if (assignment.status === 'done') ledger.shippedAt ??= now
}

/** One GitHub pull request link, as a merge record names it (model.ts appendPullRequestUrls finds the same in text). */
export const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/

/** The Lead's record that a request's PR merged (Lead, 2026-10-27): the request ships at the merge whatever its work does
 *  next, so work lost or cancelled after the merge still counts. Merge or Done, the earlier one is when it shipped. */
export function recordMerged(group: Conversation, mergedAt: number): void {
  const ledger = group.ledger ??= {}
  ledger.shippedAt = Math.min(ledger.shippedAt ?? mergedAt, mergedAt)
}

/** The person a waiting item waits on: its requester while still a member, otherwise the project's owner. */
export function waitedOn(state: SuperTabState, group: Conversation): string {
  const requester = group.requesterId && state.people.some(p => p.id === group.requesterId) ? group.requesterId : undefined
  return requester ?? groupProject(state, group).ownerId
}

/** A person's post answers the waiting item when they are the one it waits on, or when it replies to the question itself;
 *  a passer-by's chat earns nothing (Lead, 2026-10-27). One answer per wait. */
export function recordAnswer(state: SuperTabState, group: Conversation, actor: Actor, replyTo: string | null, now: number): void {
  const waiting = group.ledger?.waiting
  if (actor.kind !== 'person' || !waitsNow(group) || waiting?.assignmentId !== group.assignment!.id) return
  if (actor.userId !== waitedOn(state, group) && replyTo !== waiting.messageId) return
  const ledger = group.ledger!
  waiting.answeredAt = now
  const kept = (ledger.unblocks ?? []).filter(u => now - u.at < LEDGER_WEEKS * WEEK_MS)
  ledger.unblocks = [...kept, { personId: actor.userId, at: now, waitedMs: Math.max(0, now - waiting.since) }]
}

/** Whether the group's work waits on a person now: needs a human and not yet answered. An item from before answers were
 *  recorded has no wait on record and still waits. */
export function waitsNow(group: Conversation): boolean {
  const waiting = group.ledger?.waiting
  return group.assignment?.status === 'needs_human' && !(waiting?.assignmentId === group.assignment.id && waiting.answeredAt != null)
}
