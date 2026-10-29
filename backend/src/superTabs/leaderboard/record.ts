/**
 * What the leaderboard counts, recorded as it happens on the group it happened in (docs/swarms.md, Leaderboard): when a
 * request was asked and first shipped, which item waits on a person, and who answered it. Only facts and times, never text.
 */
import { isLeads, type Actor, type Agent, type AgentConfiguration, type Assignment, type Author, type Check, type Conversation, type SuperTabState, type WorkStatus } from '../model.js'
import { groupProject, ledProject } from '../projects.js'
import { WEEK_MS, weekStart } from './week.js'
import type { UnblockKind } from './contract.js'

/** How a person unblocked work (Dee, 2026-10-28): answered a decision, approved the Lead's plan, answered work waiting on them,
 *  or replied to a tag. `item`: what was answered (the decision, the Lead's ask, the waiting question or the tag message),
 *  credited once. Both are absent from answers recorded before kinds, which were all answers to waiting work. */
export interface Unblock { personId: string; at: number; waitedMs: number; kind?: UnblockKind; item?: string }
/** One attempt at a group's work: what it ran on and whether its first review passed (roadmap, Dec: about 30% of work on
 *  cheaper models without lower quality). `grid`: a model served on the Swarm's grid, named by its start, since the engine
 *  reports none of its own. `firstVerdicts`: each independent check's first verdict during this attempt, by check id.
 *  `firstReview`: false once any of them failed, true once every independent check passed its first, absent until then. */
export interface Run extends RanOn { assignmentId: string; at: number
  firstVerdicts?: Record<string, boolean>; firstReview?: boolean
  /** The step up from a cheaper model this attempt is (stepUp.ts): its attempt number and why. */
  stepUp?: { attempt: number; reason: string } }
/** What an agent ran on: its engine, the model (a grid model's own name, `grid` set), and its effort when it names one;
 *  absent from attempts recorded before efforts were (Lead, 2026-10-29: never guessed afterwards). */
export interface RanOn { engine: string; model: string | null; effort?: string; grid?: true }
/** How many review verdicts agents running on one model gave on the group's work in one week (Monday 00:00 UTC): a reviewer
 *  model's points (Lead, 2026-10-29). Counted, not listed, so no cap ever drops an earned point (review of #2097). A
 *  person's verdict is no model's. */
export interface ReviewCount extends RanOn { week: number; count: number }
/** A group's leaderboard bookkeeping; readers never get it whole (read/views.ts groupView). */
export interface GroupLedger {
  askedAt?: number
  /** When it shipped: its earliest recorded merge, or without one the first time its work was done. A group is one request,
   *  so finishing it again ships nothing new. */
  shippedAt?: number
  /** The earliest merge the Lead recorded (recordMerged); once there is one, it is the ship time. */
  mergedAt?: number
  /** The item waiting on a person: the attempt, since when, the "Needs a human" row it posted, the decision it asked with it
   *  (the same one again when the worker repeats an open question), and once a person answered it, when. An answered item no
   *  longer waits, though its worker has not moved on yet. A wait recorded before decisions were named has none. */
  waiting?: { assignmentId: string; since: number; messageId: string; decisionId?: string; answeredAt?: number }
  /** Answers within the last LEDGER_WEEKS, oldest first. */
  unblocks?: Unblock[]
  /** The last MAX_RUNS attempts, oldest first. */
  runs?: Run[]
  /** When its first attempt was assigned: kept apart, as that attempt rolls off [runs] after MAX_RUNS (review of #2097). */
  firstAssignedAt?: number
  /** The attempt it shipped on, and what that ran on, kept from the moment it shipped: a later attempt or older attempts
   *  rolling off never move its model's credit (review of #2097). */
  shippedBy?: RanOn & { assignmentId: string; at: number }
  /** Who led the group when it shipped, null for nobody: the PM's credit, kept whoever leads it later (review of #2097). */
  shippedLeadId?: string | null
  /** Review verdicts by week and model, for the last LEDGER_WEEKS weeks, oldest first. */
  reviews?: ReviewCount[]
  /** The Buddy's proposal the group was opened from: the Buddy earns when it ships (Lead, 2026-10-29). */
  proposal?: { buddyId: string; messageId: string }
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

/** A status change opens, closes or ships: needs_human starts a wait (again, when the agent asks anew after an answer), naming
 *  the decision it asked, any other status ends it, done ships once. */
export function recordStatus(group: Conversation, assignment: Assignment, previous: WorkStatus, now: number, messageId: string | null,
  decisionId?: string): void {
  const ledger = group.ledger ??= {}
  const open = ledger.waiting?.assignmentId === assignment.id && ledger.waiting.answeredAt == null
  if (assignment.status === 'needs_human' && messageId && (previous !== 'needs_human' || !open)) {
    ledger.waiting = { assignmentId: assignment.id, since: now, messageId, ...decisionId ? { decisionId } : {} }
  } else if (assignment.status !== 'needs_human') delete ledger.waiting
  if (assignment.status === 'done' && ledger.shippedAt == null) {
    ledger.shippedAt = now
    shipOn(group, ledger.runs?.find(r => r.assignmentId === assignment.id))
  }
}

/** Keeps who led a request when it first shipped, and the attempt it shipped on: the given one, else the last one
 *  assigned by the time it shipped. Once kept, never rewritten. */
function shipOn(group: Conversation, run?: Run): void {
  const ledger = group.ledger!
  if (ledger.shippedLeadId !== undefined) return
  ledger.shippedLeadId = group.leadId ?? null
  shipAttempt(ledger, run)
}

/** The attempt a request shipped on: the given one, else the latest started by the time it shipped, else (merged before any
 *  attempt started) the earliest. */
function shipAttempt(ledger: GroupLedger, run?: Run): void {
  const shipping = run ?? ledger.runs?.filter(r => r.at <= ledger.shippedAt!).at(-1) ?? ledger.runs?.[0]
  if (!shipping) return
  const { firstVerdicts: _verdicts, firstReview: _review, ...shippedBy } = shipping
  ledger.shippedBy = shippedBy
}

/** One GitHub pull request link, as a merge record names it (model.ts appendPullRequestUrls finds the same in text). */
export const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/

/** The Lead's record that a request's PR merged (Lead, 2026-10-27): the request ships at its earliest recorded merge, even
 *  when Done came first, and whatever its work does next, so work lost or cancelled after the merge still counts. */
export function recordMerged(group: Conversation, mergedAt: number): void {
  const ledger = group.ledger ??= {}
  const before = ledger.shippedAt
  ledger.mergedAt = Math.min(ledger.mergedAt ?? mergedAt, mergedAt)
  ledger.shippedAt = ledger.mergedAt
  // Who led it and which attempt shipped are kept from the first time it shipped. A merge that moves the ship earlier
  // takes the attempt running then; the lead stays, as no history of leads is kept (Lead, 2026-10-29).
  if (ledger.shippedLeadId !== undefined && before != null && ledger.shippedAt < before) shipAttempt(ledger)
  else shipOn(group)
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

/** The person asked answered a decision: credited from when it was asked. A decision a worker asked through needs_human is
 *  that wait's question, named by the wait, also when the worker asked it again after moving on: answering it answers the
 *  wait, and once the wait is answered, by a post or this decision, the other earns nothing more. A wait from before
 *  decisions were named is matched by its time, as it was asked in the same command. A decision left to the PM closes its
 *  wait and is credited to nobody. */
export function recordDecision(group: Conversation, decision: { id: string; personId: string; createdAt: number; assignmentId: string | null }, now: number,
  delegated = false): void {
  if (group.audience || isLeads(group)) return
  const waiting = group.ledger?.waiting
  if (waiting && (waiting.decisionId ? waiting.decisionId === decision.id
    : !!decision.assignmentId && waiting.assignmentId === decision.assignmentId && waiting.since === decision.createdAt)) {
    if (waiting.answeredAt != null) return
    waiting.answeredAt = now
  }
  // Left to the PM: the wait is over, but the person did not choose, so it earns them nothing.
  if (delegated) return
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

/** An assignment records what its agent runs on (ranOn), for the board's models. */
export function recordRun(state: SuperTabState, group: Conversation, assignment: Assignment, worker: Agent, now: number): void {
  const run: Run = { assignmentId: assignment.id, ...ranOn(state, worker, assignment.configuration), at: now,
    ...(group.stepUp ? { stepUp: { attempt: group.stepUp.attempt, reason: group.stepUp.reason } } : {}) }
  const ledger = group.ledger ??= {}
  // A request recorded before this time was kept still has its first attempt in [runs] until 20 more roll it off; only a
  // request with no attempt yet starts now (review of #2097).
  ledger.firstAssignedAt ??= ledger.runs?.[0]?.at ?? now
  ledger.runs = [...ledger.runs ?? [], run].slice(-MAX_RUNS)
}

/** An agent's verdict on an independent check is one finished review by the model it runs on. */
export function recordVerdict(state: SuperTabState, group: Conversation, check: Check, reviewer: Agent, now: number): void {
  if (!check.independent) return
  const ledger = group.ledger ??= {}
  const on = ranOn(state, reviewer, reviewer.configuration), week = weekStart(now)
  // Only the weeks the board reads: one row per week and model, however many verdicts.
  const kept = (ledger.reviews ?? []).filter(r => week - r.week < LEDGER_WEEKS * WEEK_MS)
  const same = kept.find(r => r.week === week && r.engine === on.engine && r.model === on.model && r.effort === on.effort && r.grid === on.grid)
  if (same) same.count++
  else kept.push({ week, ...on, count: 1 })
  ledger.reviews = kept
}

/** A group opened from a Buddy's proposal remembers it, for the Buddy's points when it ships. */
export function recordProposal(group: Conversation, proposal: { buddyId: string; messageId: string }): void {
  (group.ledger ??= {}).proposal = proposal
}

/** What [worker] runs on: the grid model its start named, else what its configuration reports. An agent started before it
 *  kept its grid model has it only on its start, which is here while that start is not finished. */
function ranOn(state: SuperTabState, worker: Agent, configuration: AgentConfiguration): RanOn {
  const gridModel = worker.gridModel
    ?? state.starts?.find(s => s.harnessId === worker.harnessId && s.request.machineId === worker.machineId)?.request.gridModel
  const effort = namedEffort(configuration.effort)
  return { engine: configuration.engine, model: gridModel ?? configuration.model, ...(effort ? { effort } : {}), ...(gridModel ? { grid: true as const } : {}) }
}

/** An effort that says which one runs: 'auto' is what Claude Code reports for one it was launched with, and 'default' what a
 *  start asks when it leaves the engine its own (desktop agent_line.dart reads them the same way). */
const namedEffort = (effort: string | null): string | undefined =>
  effort && effort !== 'auto' && effort !== 'default' ? effort : undefined

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
