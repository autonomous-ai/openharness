/**
 * The leaderboard of one project and week (docs/swarms.md, Leaderboard): three numbers per person, Shipped, Unblocked and
 * Lent, their points against last week's, what they are made of, a shipping streak, the team goal, and who agents wait on
 * now. Pure: the read decides who may see it and hands in only the groups that reader may read. Private conversations are
 * left out here too.
 */
import type { ContributedMachine } from '../machines.js'
import { isLeads, type Conversation, type SuperTabState } from '../model.js'
import { isBuddy } from '../buddies.js'
import { agentProjectId, canReadProject, projectOf } from '../projects.js'
import { waitedOn, waitsNow, type RanOn, type Unblock } from './record.js'
import { DAY_MS, WEEK_MS } from './week.js'
import type { AgentScore, Leaderboard, Medal, ModelScore, ModelShare, PersonDetails, PersonScore, WeekGoal } from './contract.js'

export const SHIPPED_POINTS = 3
/** A reviewer model's point for each review verdict it gave (Lead, 2026-10-29). */
export const REVIEW_POINTS = 1
export const UNBLOCK_POINTS = 1
const HOUR_MS = 3_600_000
/** One more point per this many hours an item waited, up to UNBLOCK_MAX_WAIT_POINTS more: an answer is worth a ship at most
 *  (Lead's ruling, 2026-10-28). One point per this many busy agent-hours lent. */
export const UNBLOCK_HOURS_PER_POINT = 2
export const UNBLOCK_MAX_WAIT_POINTS = 2
export const LENT_HOURS_PER_POINT = 10
/** Each details list keeps the newest this many. */
export const DETAILS_LIMIT = 20
const MEDALS: Medal[] = ['gold', 'silver', 'bronze']

export interface LeaderboardInput {
  state: SuperTabState
  /** Every group of the Swarm the reader may read, dormant ones of the last weeks included. */
  groups: Conversation[]
  /** The contributed machines the reader may see (model.ts visibleState): Lent sums no other. */
  machines: ContributedMachine[]
  projectId: string
  /** The Monday 00:00 UTC the week starts (week.ts). */
  week: number
  now: number
  /** People's profile names by id, read with the board (read.ts profileNames); absent ones go by their email. */
  names?: ReadonlyMap<string, string>
}

export function leaderboard({ state, groups, machines: visibleMachines, projectId, week, now, names }: LeaderboardInput): Leaderboard {
  const project = projectOf(state, projectId)
  // The Lead conversation is where plans are approved: its answers count, though nothing there is a request that ships.
  const visible = groups.filter(g => !isLeads(g) && !g.audience && (g.projectId ?? 'lead') === projectId)
  const shared = visible.filter(g => g.id !== project.leadConversationId)
  const requests = shared.filter(g => !g.reviewOf)
  // Shipped with a PR: what agents and models are credited for. A person's points also need them to have asked (review
  // of #2097: a group opened from a Buddy's proposal may name no requester).
  const shippedRequests = requests.filter(g => g.ledger?.shippedAt != null && (g.pullRequestUrls?.length ?? 0) > 0)
  const landed = shippedRequests.filter(g => g.requesterId)
  const players = state.people.filter(p => canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project))
  const inWeek = (at: number, start = week) => at >= start && at < start + WEEK_MS
  // Each person's records, gathered once: the board scores every player three times (Diego's issue file, 2026-10-27).
  const landedBy = byKey(landed, g => g.requesterId!)
  const answersBy = byKey(visible.flatMap(group => (group.ledger?.unblocks ?? []).map(unblock => ({ ...unblock, group }))), u => u.personId)
  const machinesBy = byKey(visibleMachines, m => m.contributorId)
  const score = (personId: string, start: number) => {
    const shippedHere = (landedBy.get(personId) ?? []).filter(g => inWeek(g.ledger!.shippedAt!, start))
    const answers = (answersBy.get(personId) ?? []).filter(u => inWeek(u.at, start))
    const machines = (machinesBy.get(personId) ?? [])
      .map(m => ({ name: m.name, busyMs: m.lent?.find(l => l.week === start)?.busyMs ?? 0 })).filter(m => m.busyMs > 0)
    const freedMs = sum(answers.map(u => u.waitedMs)), lentMs = sum(machines.map(m => m.busyMs))
    const points = shippedHere.length * SHIPPED_POINTS + sum(answers.map(unblockPoints)) + Math.floor(lentMs / (LENT_HOURS_PER_POINT * HOUR_MS))
    const details: PersonDetails = {
      shipped: newest(shippedHere, g => g.ledger!.shippedAt!)
        .map(g => ({ title: g.title, prUrl: g.pullRequestUrls!.at(-1)!, mergedAt: g.ledger!.shippedAt! })),
      unblocked: newest(answers, u => u.at)
        .map(u => ({ title: u.group.title, conversationId: u.group.id, kind: u.kind ?? 'needs_human', waitedMinutes: Math.round(u.waitedMs / 60_000) })),
      lent: [...machines].sort((a, b) => b.busyMs - a.busyMs).slice(0, DETAILS_LIMIT)
        .map(m => ({ machineName: m.name, busyHours: Math.round(m.busyMs / HOUR_MS * 10) / 10 })),
    }
    return {
      points,
      shipped: { count: shippedHere.length, medianAskToShipMs: median(askToShip(shippedHere)) },
      unblocked: { count: answers.length, agentMs: freedMs, medianAnswerMs: median(answers.map(u => u.waitedMs)) },
      lent: { machines: machines.length, agentMs: lentMs },
      details,
    }
  }
  const goal = (start: number): WeekGoal => {
    const shippedHere = landed.filter(g => inWeek(g.ledger!.shippedAt!, start))
    return { shipped: shippedHere.length, points: sum(players.map(p => score(p.id, start).points)), medianAskToShipMs: median(askToShip(shippedHere)) }
  }
  const today = Math.floor(Math.min(now, week + WEEK_MS - 1) / DAY_MS)
  const scored = players.map(p => ({ personId: p.id, email: p.email, displayName: names?.get(p.id)?.trim() || p.email.split('@')[0]!,
    ...score(p.id, week), prevWeekPoints: score(p.id, week - WEEK_MS).points,
    streakDays: streak(new Set((landedBy.get(p.id) ?? []).map(g => Math.floor(g.ledger!.shippedAt! / DAY_MS))), today) }))
    .sort((a, b) => b.points - a.points || a.email.localeCompare(b.email))
  const people: PersonScore[] = scored.map(({ email: _email, details, ...entry }) => {
    const rank = 1 + scored.filter(other => other.points > entry.points).length
    return { ...entry, rank, medal: entry.points > 0 ? MEDALS[rank - 1] ?? null : null, details }
  })
  return {
    projectId, week,
    goal: { openRequests: requests.filter(open).length, thisWeek: goal(week), lastWeek: goal(week - WEEK_MS) },
    people,
    waiting: waitingNow(state, shared),
    models: { thisWeek: modelShare(requests, week), lastWeek: modelShare(requests, week - WEEK_MS) },
    agents: agentScores(state, projectId, shippedRequests.filter(g => inWeek(g.ledger!.shippedAt!))),
    byModel: modelScores(requests, shippedRequests.filter(g => inWeek(g.ledger!.shippedAt!)), inWeek),
  }
}

/** The project's PM and Buddies with the requests each shipped this week: the PM by the groups it led, a Buddy by the groups
 *  opened from its proposals. Builders and Reviewers are counted by model instead (modelScores). */
function agentScores(state: SuperTabState, projectId: string, shippedThisWeek: Conversation[]): AgentScore[] {
  const pmId = state.conversations.find(c => c.id === projectOf(state, projectId).leadConversationId)?.leadId
  const scored = state.agents
    .filter(a => a.id === pmId || (isBuddy(a) && agentProjectId(state, a) === projectId))
    .map(a => {
      const buddy = isBuddy(a)
      // The lead recorded when it shipped; a request shipped before that was recorded, its lead now.
      const ledBy = (g: Conversation) => g.ledger?.shippedLeadId !== undefined ? g.ledger.shippedLeadId : g.leadId
      const shipped = shippedThisWeek.filter(g => buddy ? g.ledger?.proposal?.buddyId === a.id : ledBy(g) === a.id).length
      return { agentId: a.id, displayName: a.displayName ?? a.name, kind: buddy ? 'buddy' as const : 'pm' as const,
        personId: a.buddyOf?.personId ?? null, machineId: a.machineId, points: shipped * SHIPPED_POINTS, shipped }
    })
    .sort((a, b) => b.points - a.points || (a.kind === b.kind ? a.displayName.localeCompare(b.displayName) : a.kind === 'pm' ? -1 : 1))
  return scored.map(entry => ({ ...entry, rank: 1 + scored.filter(other => other.points > entry.points).length }))
}

/** Every model that worked this week: the requests its attempts shipped, the first reviews of its attempts, and the review
 *  verdicts it gave. A request ships on its last attempt before it shipped. */
function modelScores(requests: Conversation[], shippedThisWeek: Conversation[], inWeek: (at: number) => boolean): ModelScore[] {
  const rows = new Map<string, ModelScore & { attemptMs: number[]; requestMs: number[] }>()
  const row = (on: RanOn) => {
    const key = JSON.stringify([on.engine, on.model, on.effort ?? null])
    let entry = rows.get(key)
    if (!entry) rows.set(key, entry = { engine: on.engine, model: on.model, effort: on.effort ?? null, grid: !!on.grid, points: 0, rank: 0,
      shipped: { count: 0, medianAttemptMs: null, medianRequestMs: null }, firstReview: { reviewed: 0, passed: 0 }, reviews: 0,
      attemptMs: [], requestMs: [] })
    return entry
  }
  for (const group of shippedThisWeek) {
    // The attempt recorded when it shipped; a request shipped before that was recorded, its last attempt by then.
    const ledger = group.ledger!, shippedAt = ledger.shippedAt!, runs = (ledger.runs ?? []).filter(r => r.at <= shippedAt)
    const last: RanOn & { at: number } | undefined = ledger.shippedBy ?? runs.at(-1)
    if (!last) continue
    const entry = row(last)
    entry.shipped.count++
    // Merged before its attempt started: shipped at once, never in negative time (Lead, 2026-10-29).
    entry.attemptMs.push(Math.max(0, shippedAt - last.at))
    const first = ledger.firstAssignedAt ?? runs[0]?.at
    if (first != null) entry.requestMs.push(Math.max(0, shippedAt - first))
  }
  for (const group of requests) {
    for (const run of group.ledger?.runs ?? []) {
      if (!inWeek(run.at)) continue
      const entry = row(run)
      if (run.firstReview === undefined) continue
      entry.firstReview.reviewed++
      if (run.firstReview) entry.firstReview.passed++
    }
    for (const counted of group.ledger?.reviews ?? []) if (inWeek(counted.week)) row(counted).reviews += counted.count
  }
  const scored = [...rows.values()].map(({ attemptMs, requestMs, ...entry }) => ({ ...entry,
    points: entry.shipped.count * SHIPPED_POINTS + entry.reviews * REVIEW_POINTS,
    shipped: { ...entry.shipped, medianAttemptMs: median(attemptMs), medianRequestMs: median(requestMs) } }))
    .sort((a, b) => b.points - a.points || (a.model ?? '').localeCompare(b.model ?? '') || (a.effort ?? '').localeCompare(b.effort ?? ''))
  return scored.map(entry => ({ ...entry, rank: 1 + scored.filter(other => other.points > entry.points).length }))
}

/** One point per answer, and more the longer its item waited, capped. */
const unblockPoints = (unblock: Unblock): number =>
  UNBLOCK_POINTS + Math.min(UNBLOCK_MAX_WAIT_POINTS, Math.floor(unblock.waitedMs / (UNBLOCK_HOURS_PER_POINT * HOUR_MS)))
const newest = <T>(items: T[], at: (item: T) => number): T[] => [...items].sort((a, b) => at(b) - at(a)).slice(0, DETAILS_LIMIT)

/** The attempts started in the week starting [start], by the kind of model they ran on. */
function modelShare(requests: Conversation[], start: number): ModelShare {
  const runs = requests.flatMap(g => g.ledger?.runs ?? []).filter(r => r.at >= start && r.at < start + WEEK_MS)
  const reviewed = runs.filter(r => r.firstReview !== undefined)
  const count = (list: typeof runs, grid: boolean) => list.filter(r => !!r.grid === grid).length
  const passed = reviewed.filter(r => r.firstReview)
  return { attempts: runs.length, grid: count(runs, true), reviewed: { grid: count(reviewed, true), subscription: count(reviewed, false) },
    passedFirst: { grid: count(passed, true), subscription: count(passed, false) } }
}

/** Shared work still to land: not shipped, cancelled, stopped or archived. */
const open = (group: Conversation): boolean => !group.archived && group.ledger?.shippedAt == null
  && !['done', 'cancelled', 'stopped'].includes(group.assignment?.status ?? '')

/** Who agents wait on now and how many items each: in name order, never ranked (the mockup's "Kind" rule). */
function waitingNow(state: SuperTabState, shared: Conversation[]): Leaderboard['waiting'] {
  const byPerson = new Map<string, string[]>()
  for (const group of shared.filter(g => !g.archived && waitsNow(g))) {
    const personId = waitedOn(state, group)
    byPerson.set(personId, [...byPerson.get(personId) ?? [], group.id])
  }
  const email = (id: string) => state.people.find(p => p.id === id)?.email ?? id
  const people = [...byPerson].map(([personId, conversationIds]) => ({ personId, count: conversationIds.length, conversationIds }))
    .sort((a, b) => email(a.personId).localeCompare(email(b.personId)))
  return { total: sum(people.map(p => p.count)), people }
}

/** Days in a row with a shipped request, ending today; a streak that reached yesterday still stands until today ends. */
function streak(days: Set<number>, today: number): number {
  let day = days.has(today) ? today : today - 1, count = 0
  while (days.has(day)) { count++; day-- }
  return count
}

const askToShip = (groups: Conversation[]): number[] =>
  groups.flatMap(g => g.ledger?.askedAt != null ? [g.ledger.shippedAt! - g.ledger.askedAt] : [])
function byKey<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const list = out.get(key(item))
    if (list) list.push(item)
    else out.set(key(item), [item])
  }
  return out
}
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
