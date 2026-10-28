/**
 * What the leaderboard counts, recorded as it happens on the group it happened in (docs/swarms.md, Leaderboard): when a
 * request was asked and first shipped, which item waits on a person, and who answered it. Only facts and times, never text.
 */
import { isLeads, type Actor, type Agent, type Assignment, type Author, type Check, type Conversation, type SuperTabState, type WorkStatus } from '../model.js'
import { groupProject, ledProject } from '../projects.js'
import { WEEK_MS } from './week.js'

/** How a person unblocked work: answered a decision, approved the Lead's plan, answered work waiting on them, or replied to
 *  a tag (Dee, 2026-10-28). */
export type UnblockKind = 'decision' | 'approval' | 'needs_human' | 'tag_reply'
/** `item`: what was answered (the decision, the Lead's ask, the waiting question or the tag message), credited once. Absent
 *  from answers recorded before kinds, which were all answers to waiting work. */
export interface Unblock { personId: string; at: number; waitedMs: number; kind?: UnblockKind; item?: string }
/** One attempt at a group's work: what it ran on and whether its first review passed (roadmap, Dec: about 30% of work on
 *  cheaper models without lower quality). `grid`: a model served on the Swarm's grid, named by its start, since the engine
 *  reports none of its own. `firstVerdicts`: each independent check's first verdict during this attempt, by check id.
 *  `firstReview`: false once any of them failed, true once every independent check passed its first, absent until then. */
export interface Run { assignmentId: string; engine: string; model: string | null; grid?: true; at: number
  firstVerdicts?: Record<string, boolean>; firstReview?: boolean }
/** A group's leaderboard bookkeeping; readers never get it whole (read/views.ts groupView). */
export interface GroupLedger {
  askedAt?: number
  /** When it shipped: its earliest recorded merge, or without one the first time its work was done. A group is one request,
   *  so finishing it again ships nothing new. */
  shippedAt?: number
  /** The earliest merge the Lead recorded (recordMerged); once there is one, it is the ship time. */
  mergedAt?: number
  /** The item waiting on a person: the attempt, since when, the "Needs a human" row it posted, and once a person answered it,
   *  when. An answered item no longer waits, though its worker has not moved on yet. */
  waiting?: { assignmentId: string; since: number; messageId: string; answeredAt?: number }
  /** Answers within the last LEDGER_WEEKS, oldest first. */
  unblocks?: Unblock[]
  /** The last MAX_RUNS attempts, oldest first. */
  runs?: Run[]
}

/** The leaderboard reads this week and last; a little more keeps a streak and week boundaries safe. */
export const LEDGER_WEEKS = 5
/** A group is one request; more attempts than this are a stuck task, and the oldest say nothing new. */
export const MAX_RUNS = 20
/** Credits one conversation keeps, newest: a busy Lead conversation collects approvals and tag replies for weeks. */
export const MAX_UNBLOCKS = 200

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

/** The Lead's record that a request's PR merged (Lead, 2026-10-27): the request ships at its earliest recorded merge, even
 *  when Done came first, and whatever its work does next, so work lost or cancelled after the merge still counts. */
export function recordMerged(group: Conversation, mergedAt: number): void {
  const ledger = group.ledger ??= {}
  ledger.mergedAt = Math.min(ledger.mergedAt ?? mergedAt, mergedAt)
  ledger.shippedAt = ledger.mergedAt
}

/** The person a waiting item waits on: its requester while still a member, otherwise the project's owner. */
export function waitedOn(state: SuperTabState, group: Conversation): string {
  const requester = group.requesterId && state.people.some(p => p.id === group.requesterId) ? group.requesterId : undefined
  return requester ?? groupProject(state, group).ownerId
}

/** What a person's post can answer besides waiting work: the message it replies to, and the tags waiting on the poster in
 *  this conversation (mentions.ts), both read by the store. */
export interface PostContext { replyTo: string | null; text: string; reply?: { id: string; author: Author; createdAt: number }
  openTags?: Array<{ messageId: string; createdAt: number }> }

/** A person's post earns one credit at most, for the first it answers of: the work waiting on them, the Lead's ask it approves,
 *  the oldest tag waiting on them here (Lead's rulings, 2026-10-28). Private chats never count. */
export function recordPost(state: SuperTabState, group: Conversation, actor: Actor, post: PostContext, now: number): void {
  if (actor.kind !== 'person' || group.audience || isLeads(group)) return
  if (recordAnswer(state, group, actor.userId, post.replyTo, now)) return
  const reply = post.reply
  if (reply && reply.author.kind === 'agent' && approves(post.text) && ledProject(state, reply.author.id)?.id === groupProject(state, group).id) {
    if (credit(group, { personId: actor.userId, at: now, waitedMs: now - reply.createdAt, kind: 'approval', item: reply.id })) return
  }
  const oldest = [...post.openTags ?? []].sort((a, b) => a.createdAt - b.createdAt)[0]
  if (oldest) credit(group, { personId: actor.userId, at: now, waitedMs: now - oldest.createdAt, kind: 'tag_reply', item: oldest.messageId })
}

/** A reply that starts with GO, approve(d) or duyệt, in any case, with or without accents; a bare "ok" is too ambiguous
 *  (Lead, 2026-10-28). */
export function approves(text: string): boolean {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/giu, 'd').trim().toLowerCase()
  return /^(go|approved?|duyet)(?![\p{L}\p{N}])/u.test(plain)
}

/** The person asked answered a decision: credited from when it was asked. A decision a worker asked through needs_human
 *  answers that wait too, so a post after it is not a second answer. */
export function recordDecision(group: Conversation, decision: { id: string; personId: string; createdAt: number; assignmentId: string | null }, now: number): void {
  if (group.audience || isLeads(group)) return
  const waiting = group.ledger?.waiting
  if (decision.assignmentId && waitsNow(group) && waiting?.assignmentId === decision.assignmentId && group.assignment?.id === decision.assignmentId) {
    waiting.answeredAt = now
  }
  credit(group, { personId: decision.personId, at: now, waitedMs: now - decision.createdAt, kind: 'decision', item: decision.id })
}

/** A person's post answers the waiting item when they are the one it waits on, or when it replies to the question itself;
 *  a passer-by's chat earns nothing (Lead, 2026-10-27). One answer per wait. */
function recordAnswer(state: SuperTabState, group: Conversation, personId: string, replyTo: string | null, now: number): boolean {
  const waiting = group.ledger?.waiting
  if (!waitsNow(group) || waiting?.assignmentId !== group.assignment!.id) return false
  if (personId !== waitedOn(state, group) && replyTo !== waiting.messageId) return false
  waiting.answeredAt = now
  return credit(group, { personId, at: now, waitedMs: now - waiting.since, kind: 'needs_human', item: waiting.messageId })
}

/** Adds a credit unless its item already has one; keeps the last LEDGER_WEEKS, at most MAX_UNBLOCKS. */
function credit(group: Conversation, unblock: Unblock & { item: string }): boolean {
  const ledger = group.ledger ??= {}
  if (ledger.unblocks?.some(u => u.item === unblock.item)) return false
  const kept = (ledger.unblocks ?? []).filter(u => unblock.at - u.at < LEDGER_WEEKS * WEEK_MS)
  ledger.unblocks = [...kept, { ...unblock, waitedMs: Math.max(0, unblock.waitedMs) }].slice(-MAX_UNBLOCKS)
  return true
}

/** Whether the group's work waits on a person now: needs a human and not yet answered. An item from before answers were
 *  recorded has no wait on record and still waits. */
export function waitsNow(group: Conversation): boolean {
  const waiting = group.ledger?.waiting
  return group.assignment?.status === 'needs_human' && !(waiting?.assignmentId === group.assignment.id && waiting.answeredAt != null)
}

/** An assignment records the model its agent runs: the grid model its start named, else what its engine reports. An agent
 *  started before it kept its grid model has it only on its start, which is here while that start is not finished. */
export function recordRun(state: SuperTabState, group: Conversation, assignment: Assignment, worker: Agent, now: number): void {
  const gridModel = worker.gridModel
    ?? state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)?.request.gridModel
  const run: Run = { assignmentId: assignment.id, engine: assignment.configuration.engine,
    model: gridModel ?? assignment.configuration.model, ...(gridModel ? { grid: true as const } : {}), at: now }
  const ledger = group.ledger ??= {}
  ledger.runs = [...ledger.runs ?? [], run].slice(-MAX_RUNS)
}

/** Each independent check's first verdict during an attempt is its first review; later verdicts are repairs and never
 *  rewrite it. The attempt passed its first review only when every independent check passed the first time (review of
 *  #1808: one check passing first used to count as a pass while another failed). */
export function recordReview(group: Conversation, check: Check, passed: boolean): void {
  const run = group.ledger?.runs?.find(r => r.assignmentId === group.assignment?.id)
  if (!check.independent || !run) return
  const verdicts = run.firstVerdicts ??= {}
  verdicts[check.id] ??= passed
  const firsts = group.checks.filter(c => c.independent).map(c => verdicts[c.id])
  if (firsts.includes(false)) run.firstReview = false
  else if (firsts.every(v => v === true)) run.firstReview = true
}
