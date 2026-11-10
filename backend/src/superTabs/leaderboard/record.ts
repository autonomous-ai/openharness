/**
 * What the leaderboard counts, recorded as it happens on the group it happened in (docs/swarms.md, Leaderboard): when a
 * request was asked and first shipped, which item waits on a person, and who answered it. Only facts and times, never text.
 */
import { isLeads, type Actor, type Agent, type Author, type Conversation, type SuperTabState } from '../model.js'
import { groupProject, ledProject } from '../projects.js'
import { WEEK_MS } from './week.js'
import type { UnblockKind } from './contract.js'

/** How a person unblocked work (Dee, 2026-10-28): answered a decision, approved the Lead's plan, answered work waiting on them,
 *  or replied to a tag. `item`: what was answered (the decision, the Lead's ask, the waiting question or the tag message),
 *  credited once. Both are absent from answers recorded before kinds, which were all answers to waiting work. */
export interface Unblock { personId: string; at: number; waitedMs: number; kind?: UnblockKind; item?: string }
/** One attempt at a group's work: what it ran on and whether its first review passed (roadmap, Dec: about 30% of work on
 *  cheaper models without lower quality). `grid`: a model served on the Swarm's grid, named by its start, since the engine
 *  reports none of its own. `firstVerdicts`: each check's first verdicts during this attempt by anyone but its assignee, by
 *  check id: false once any checker's first verdict on it failed (#2311). `firstReview`: false once any of them failed, true
 *  while every one so far passed, absent until the first. */
export interface Run extends RanOn { assignmentId: string; at: number
  /** The agent and its terminal that ran it, so the model that terminal reports later fills this attempt only (record
   *  ReportedModel). Absent from attempts recorded before them. */
  agentId?: string; harnessId?: string
  /** The machine it ran on, so a person's card can say what their machine shipped (contributor view, #2444). Absent from
   *  attempts recorded before it; the board then finds it by the agent while that agent exists (brought.ts runMachine). */
  machineId?: string
  firstVerdicts?: Record<string, boolean>; firstReview?: boolean
  /** The step up from a cheaper model this attempt is, on a task stepped up before project instructions: its attempt number and why. */
  stepUp?: { attempt: number; reason: string }
  /** Its agent was launched on the engine's own model, which Codex reports by a slug the policy may not name: the board rates
   *  it by the engine's `default` row (review of ee4ee6c9a). */
  engineDefault?: true
  /** Re-reviews after a failed review during this attempt (evidence routing, Ken 2026-10-29): the most on any one check, so
   *  a review that judges two checks counts once. Absent until a review fails; 0 while a failure waits for its
   *  re-review. `reworks`: each checker's last verdict on a check and its re-reviews after its own failure, by check id and
   *  checker's actor key (`${checkId} ${by}`); one checker passing what another failed is no re-review (#2311). Attempts
   *  recorded before kept them by check id alone. */
  reworkRounds?: number
  reworks?: Record<string, { last: boolean; rounds: number }> }
/** What an agent ran on: its engine, the model (a grid model's own name, `grid` set), and its effort when it names one;
 *  absent from attempts recorded before efforts were (Lead, 2026-10-29: never guessed afterwards). */
export interface RanOn { engine: string; model: string | null; effort?: string; grid?: true }
/** How many review verdicts agents running on one model gave on the group's work in one week (Monday 00:00 UTC): a reviewer
 *  model's points (Lead, 2026-10-29). Counted, not listed, so no cap ever drops an earned point (review of #2097). A
 *  person's verdict is no model's. */
export interface ReviewCount extends RanOn { week: number; count: number }
/** The same verdicts by hour, for the rolling periods (rolling.ts): one row per hour and model that had one. */
export interface ReviewHour extends RanOn { hour: number; count: number }
/** A group's leaderboard bookkeeping; readers never get it whole (read/views.ts groupView). */
export interface GroupLedger {
  askedAt?: number
  /** Why nobody is named as its requester, said by the agent that opened work no person asked for (taskContract.ts). */
  noRequesterReason?: string
  /** When it shipped: its earliest recorded merge, or without one the first time its work was done. A group is one request,
   *  so finishing it again ships nothing new. */
  shippedAt?: number
  /** The earliest merge the Lead recorded (recordMerged); once there is one, it is the ship time. */
  mergedAt?: number
  /** When the first follow-up fix of its merged PR merged, within FIX_WINDOW_MS of its merge (recordFix): it needed a fix
   *  after merge (evidence routing, Ken 2026-10-29). */
  fixedAfterMergeAt?: number
  /** The group whose merged PR this group's merge fixed. */
  fixOf?: string
  /** The item waiting on a person: the attempt, since when, the "Needs a human" row it posted, and once a person answered it,
   *  when. An answered item no longer waits, though its worker has not moved on yet. */
  waiting?: { assignmentId: string; since: number; messageId: string; answeredAt?: number }
  /** Answers within the last LEDGER_WEEKS, oldest first. */
  unblocks?: Unblock[]
  /** The last MAX_RUNS attempts, oldest first. */
  runs?: Run[]
  /** When its first attempt was assigned: kept apart, as that attempt rolls off [runs] after MAX_RUNS (review of #2097). */
  firstAssignedAt?: number
  /** The attempt it shipped on, and what that ran on, kept from the moment it shipped: a later attempt or older attempts
   *  rolling off never move its model's credit (review of #2097). */
  shippedBy?: RanOn & { assignmentId: string; at: number; machineId?: string }
  /** Who led the group when it shipped, null for nobody: the PM's credit, kept whoever leads it later (review of #2097). */
  shippedLeadId?: string | null
  /** Review verdicts by week and model, for the last LEDGER_WEEKS weeks, oldest first. */
  reviews?: ReviewCount[]
  /** The same by hour, for the last LEDGER_WEEKS weeks. */
  reviewHours?: ReviewHour[]
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

/** One GitHub pull request link, as a merge record names it (model.ts appendPullRequestUrls finds the same in text). */
export const PULL_REQUEST_URL = /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/

/** The person a waiting item waits on: its requester while still a member, otherwise the project's owner. */
export function waitedOn(state: SuperTabState, group: Conversation): string {
  const requester = group.requesterId && state.people.some(p => p.id === group.requesterId) ? group.requesterId : undefined
  return requester ?? groupProject(state, group).ownerId
}

/** What a person's post can answer besides waiting work: the message it replies to, read by the store. */
export interface PostContext { replyTo: string | null; text: string; reply?: { id: string; author: Author; createdAt: number } }

/** A person's post earns one credit at most, for the first it answers of: the work waiting on them, the Lead's ask it approves
 *  (Lead's rulings, 2026-10-28; tags waiting on them earned too until Swarm v4 removed them, 2026-11-10). Private chats never count. */
export function recordPost(state: SuperTabState, group: Conversation, actor: Actor, post: PostContext, now: number): void {
  if (actor.kind !== 'person' || group.audience || isLeads(group)) return
  if (recordAnswer(state, group, actor.userId, post.replyTo, now)) return
  const reply = post.reply
  if (reply && reply.author.kind === 'agent' && approves(post.text) && ledProject(state, reply.author.id)?.id === groupProject(state, group).id) {
    credit(group, { personId: actor.userId, at: now, waitedMs: now - reply.createdAt, kind: 'approval', item: reply.id })
  }
}

/** A reply that starts with GO, approve(d) or duyệt, in any case, with or without accents; a bare "ok" is too ambiguous
 *  (Lead, 2026-10-28). */
export function approves(text: string): boolean {
  const plain = text.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/giu, 'd').trim().toLowerCase()
  return /^(go|approved?|duyet)(?![\p{L}\p{N}])/u.test(plain)
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

/** An agent started on its engine's own model reports which one only once it runs (Codex): its attempts recorded before
 *  then, with none, take the model it reports, so the board names it and step-ups rate it by it rather than by the engine
 *  alone (Dee, 2026-10-30). That holds for a finished or handed-on attempt too (Scholes, 2026-10-30: a review done before
 *  its agent's first report stayed "model not reported"). Only this agent's own attempts in its current terminal: a
 *  replacement terminal (agent.rebind) may run another model. An attempt recorded before attempts named their agent is
 *  matched as its group's current one. A model on record is never rewritten, nor a grid model's, nor another engine's. */
export function recordReportedModel(state: SuperTabState, worker: Agent): void {
  const model = worker.configuration.model
  if (!model || worker.gridModel) return
  const fill = (on: RanOn | undefined) => {
    if (on && on.model === null && !on.grid && on.engine === worker.configuration.engine) on.model = model
  }
  for (const group of state.conversations) {
    const ledger = group.ledger
    if (!ledger?.runs?.length) continue
    const current = group.assignment
    const legacy = current?.agentId === worker.id && current.execution.harnessId === worker.harnessId ? current.id : null
    for (const run of ledger.runs) {
      const own = run.agentId !== undefined ? run.agentId === worker.id && run.harnessId === worker.harnessId : run.assignmentId === legacy
      if (!own) continue
      fill(run)
      // The copy kept when its merge was recorded while it still ran.
      if (ledger.shippedBy?.assignmentId === run.assignmentId) fill(ledger.shippedBy)
    }
  }
}

/** When a request's first attempt was assigned: kept since that was recorded. A request recorded before has its first
 *  attempt in [runs] while fewer than MAX_RUNS are kept; once that many are, the first may have rolled off, so it takes
 *  the time the request was asked (full review of #2097). Undefined for a request never assigned. */
export function firstAssignedAt(ledger: GroupLedger): number | undefined {
  if (ledger.firstAssignedAt != null) return ledger.firstAssignedAt
  const runs = ledger.runs ?? []
  if (!runs.length) return undefined
  return runs.length < MAX_RUNS ? runs[0]!.at : ledger.askedAt ?? runs[0]!.at
}

/** A group opened from a Buddy's proposal remembers it, for the Buddy's points when it ships. */
export function recordProposal(group: Conversation, proposal: { buddyId: string; messageId: string }): void {
  (group.ledger ??= {}).proposal = proposal
}

