/**
 * What the leaderboard counts, recorded as it happens on the group it happened in (docs/swarms.md, Leaderboard): when a
 * request was asked and first shipped, which item waits on a person, and who answered it. Only facts and times, never text.
 */
import type { Actor, Assignment, Conversation, SuperTabState, WorkStatus } from '../model.js'
import { groupProject } from '../projects.js'

export interface Unblock { personId: string; at: number; waitedMs: number }
/** A group's leaderboard bookkeeping; readers never get it whole (read/views.ts groupView). */
export interface GroupLedger {
  askedAt?: number
  /** The first time its work was done; a group is one request, so finishing it again ships nothing new. */
  shippedAt?: number
  /** The item waiting on a person now: the attempt, since when, and the "Needs a human" row it posted. */
  waiting?: { assignmentId: string; since: number; messageId: string }
  /** Answers within the last LEDGER_WEEKS, oldest first. */
  unblocks?: Unblock[]
}

export const WEEK_MS = 7 * 86_400_000
/** The leaderboard reads this week and last; a little more keeps a streak and week boundaries safe. */
export const LEDGER_WEEKS = 5

/** A shared group is asked when it is opened. A private conversation is chat only and never counts. */
export function recordAsked(group: Conversation, requesterId: string | undefined, now: number): void {
  if (group.audience) return
  if (requesterId) group.requesterId = requesterId
  group.ledger = { askedAt: now }
}

/** A status change opens, closes or ships: needs_human starts a wait, any other status ends it, done ships once. */
export function recordStatus(group: Conversation, assignment: Assignment, previous: WorkStatus, now: number, messageId: string | null): void {
  const ledger = group.ledger ??= {}
  if (assignment.status === 'needs_human' && previous !== 'needs_human' && messageId) {
    ledger.waiting = { assignmentId: assignment.id, since: now, messageId }
  } else if (assignment.status !== 'needs_human') delete ledger.waiting
  if (assignment.status === 'done') ledger.shippedAt ??= now
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
  if (actor.kind !== 'person' || !waiting || group.assignment?.id !== waiting.assignmentId || group.assignment.status !== 'needs_human') return
  if (actor.userId !== waitedOn(state, group) && replyTo !== waiting.messageId) return
  const ledger = group.ledger!
  delete ledger.waiting
  const kept = (ledger.unblocks ?? []).filter(u => now - u.at < LEDGER_WEEKS * WEEK_MS)
  ledger.unblocks = [...kept, { personId: actor.userId, at: now, waitedMs: Math.max(0, now - waiting.since) }]
}
