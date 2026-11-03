/**
 * The leaderboard of one project and week (docs/swarms.md, Leaderboard): three numbers per person, Shipped, Unblocked and
 * Lent, their points against last week's, what they are made of, a shipping streak, the team goal, and who agents wait on
 * now. Pure: the read decides who may see it and hands in only the groups that reader may read. Private conversations are
 * left out here too.
 */
import type { ContributedMachine } from '../machines.js'
import { isLeads, type Agent, type Conversation, type SuperTabState } from '../model.js'
import { isBuddy, isSwarmBuddy } from '../buddies.js'
import { agentProjectId, canReadProject, projectOf } from '../projects.js'
import { firstAssignedAt, waitedOn, waitsNow, type RanOn, type Unblock } from './record.js'
import { lentIn, periodSpans, reviewsIn, weekSpan, within, type PeriodName, type Span } from './rolling.js'
import { DAY_MS, WEEK_MS } from './week.js'
import type { AgentScore, Leaderboard, Medal, ModelScore, ModelShare, PersonDetails, PersonScore, RecentModel, WeekGoal } from './contract.js'

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
  /** A rolling period ending now to sum instead of [week] (rolling.ts); [week] is then only the answer's label. */
  period?: PeriodName
  /** Sum every one of these projects instead of [projectId] alone: the ones the reader may read, whose groups [groups] holds.
   *  Everyone in the Swarm is then listed. [projectId] stays the board's project and its recent models. */
  allProjects?: string[]
  /** People's profile names by id, read with the board (read.ts profileNames); absent ones go by their email. */
  names?: ReadonlyMap<string, string>
}

export function leaderboard({ state, groups, machines: visibleMachines, projectId, week, now, period, allProjects, names }: LeaderboardInput): Leaderboard {
  const project = projectOf(state, projectId)
  // The Lead conversation is where plans are approved: its answers count, though nothing there is a request that ships.
  const projectIds = new Set(allProjects ?? [projectId])
  const visible = groups.filter(g => !isLeads(g) && !g.audience && projectIds.has(g.projectId ?? 'lead'))
  const leadConversations = new Set([...projectIds].map(id => projectOf(state, id).leadConversationId))
  const shared = visible.filter(g => !leadConversations.has(g.id))
  const requests = shared.filter(g => !g.reviewOf)
  // Shipped with a PR: what agents and models are credited for. A person's points also need them to have asked (review
  // of #2097: a group opened from a Buddy's proposal may name no requester).
  const shippedRequests = requests.filter(g => g.ledger?.shippedAt != null && (g.pullRequestUrls?.length ?? 0) > 0)
  const landed = shippedRequests.filter(g => g.requesterId)
  const players = allProjects ? state.people : state.people.filter(p => canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project))
  const { current, previous } = period ? periodSpans(period, now) : { current: weekSpan(week), previous: weekSpan(week - WEEK_MS) }
  // Each person's records, gathered once: the board scores every player three times (Diego's issue file, 2026-10-27).
  const landedBy = byKey(landed, g => g.requesterId!)
  const answersBy = byKey(visible.flatMap(group => (group.ledger?.unblocks ?? []).map(unblock => ({ ...unblock, group }))), u => u.personId)
  const machinesBy = byKey(visibleMachines, m => m.contributorId)
  // Under All projects, whether a board of this reader's already shows the person; a project's board lists only its own.
  const sharesBoard = (personId: string): boolean => {
    const person = state.people.find(p => p.id === personId)
    return !allProjects || (!!person && [...projectIds].some(id => canReadProject(state, { kind: 'person', userId: person.id, email: person.email }, projectOf(state, id))))
  }
  const score = (personId: string, span: Span) => {
    const shippedHere = (landedBy.get(personId) ?? []).filter(g => within(g.ledger!.shippedAt!, span))
    const answers = (answersBy.get(personId) ?? []).filter(u => within(u.at, span))
    const machines = (machinesBy.get(personId) ?? [])
      .map(m => ({ name: m.name, busyMs: lentIn(m, span, now, { projects: projectIds, unsplit: sharesBoard(personId) }) })).filter(m => m.busyMs > 0)
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
  const goal = (span: Span): WeekGoal => {
    const shippedHere = landed.filter(g => within(g.ledger!.shippedAt!, span))
    return { shipped: shippedHere.length, points: sum(players.map(p => score(p.id, span).points)), medianAskToShipMs: median(askToShip(shippedHere)) }
  }
  const today = Math.floor(Math.min(now, current.end - 1) / DAY_MS)
  const scored = players.map(p => ({ personId: p.id, email: p.email, displayName: names?.get(p.id)?.trim() || p.email.split('@')[0]!,
    ...score(p.id, current), prevWeekPoints: previous && score(p.id, previous).points,
    streakDays: streak(new Set((landedBy.get(p.id) ?? []).map(g => Math.floor(g.ledger!.shippedAt! / DAY_MS))), today) }))
    .sort((a, b) => b.points - a.points || a.email.localeCompare(b.email))
  const people: PersonScore[] = scored.map(({ email: _email, details, ...entry }) => {
    const rank = 1 + scored.filter(other => other.points > entry.points).length
    return { ...entry, rank, medal: entry.points > 0 ? MEDALS[rank - 1] ?? null : null, details }
  })
  const shippedNow = shippedRequests.filter(g => within(g.ledger!.shippedAt!, current))
  return {
    projectId, week,
    ...period ? { period: { name: period, start: current.start, end: now } } : {},
    ...allProjects ? { allProjects: true as const } : {},
    goal: { openRequests: requests.filter(open).length, thisWeek: goal(current), lastWeek: previous && goal(previous) },
    people,
    waiting: waitingNow(state, shared),
    models: { thisWeek: modelShare(requests, current), lastWeek: previous && modelShare(requests, previous) },
    agents: agentScores(state, projectIds, shippedNow, visibleMachines),
    byModel: modelScores(requests, shippedNow, current),
    recentModels: recentModels(requests.filter(g => (g.projectId ?? 'lead') === projectId), now),
  }
}

/** Each model's attempts at requests in the 7 days up to [now], every effort as one, most attempts first. The groups the board
 *  already holds cover them: dormant ones of the last LEDGER_WEEKS are read with it (read/service.ts). */
function recentModels(requests: Conversation[], now: number): RecentModel[] {
  const rows = new Map<string, RecentModel>()
  for (const run of requests.flatMap(g => g.ledger?.runs ?? [])) {
    if (run.at < now - WEEK_MS || run.at > now) continue
    const key = JSON.stringify([run.engine, run.model])
    let row = rows.get(key)
    if (!row) rows.set(key, row = { engine: run.engine, model: run.model, attempts: 0, firstReview: { reviewed: 0, passed: 0 } })
    row.attempts++
    if (run.firstReview === undefined) continue
    row.firstReview.reviewed++
    if (run.firstReview) row.firstReview.passed++
  }
  return [...rows.values()].sort((a, b) => b.attempts - a.attempts || a.engine.localeCompare(b.engine)
    || (a.model ?? '').localeCompare(b.model ?? ''))
}

/** The project's PM and Buddies with the requests each shipped this week: a PM by the groups it led when they shipped, a
 *  Buddy by the groups opened from its proposals. One credited this week stays listed after it was removed or replaced,
 *  as "Former PM" or "Former Buddy" once the Swarm no longer has it (full review of #2097). Builders and Reviewers are
 *  counted by model instead (modelScores). */
function agentScores(state: SuperTabState, projectIds: ReadonlySet<string>, shippedThisWeek: Conversation[], visibleMachines: readonly ContributedMachine[]): AgentScore[] {
  const projects = [...projectIds].map(id => projectOf(state, id))
  // A person's one Buddy belongs to no project (Dee, 10-31): it is listed for each project summed that its person reads, and in none else,
  // so a private project never shows a Buddy, name or Mac of someone outside it. Its sessions are never rows of their own.
  const listedHere = (a: Agent): boolean => {
    if (!isBuddy(a) || a.buddySession) return false
    if (!isSwarmBuddy(a)) return projectIds.has(agentProjectId(state, a) ?? '')
    const owner = state.people.find(p => p.id === a.buddyOf!.personId && p.generation === a.buddyOf!.generation)
    return !!owner && projects.some(project => canReadProject(state, { kind: 'person', userId: owner.id, email: owner.email }, project))
  }
  // A proposal recorded before the credit moved to the one Buddy names its session: the person's one Buddy earns it.
  const creditee = (agentId: string): string => {
    const a = state.agents.find(agent => agent.id === agentId)
    if (!a?.buddySession || !a.buddyOf) return agentId
    return state.agents.find(m => isSwarmBuddy(m) && !m.buddySession && listedHere(m)
      && m.buddyOf!.personId === a.buddyOf!.personId && m.buddyOf!.generation === a.buddyOf!.generation)?.id ?? agentId
  }
  const leads = new Set(projects.map(project => project.leadConversationId))
  const pmIds = new Set(state.conversations.filter(c => leads.has(c.id)).map(c => c.leadId))
  const shipped = new Map<string, { kind: 'pm' | 'buddy'; count: number }>()
  for (const a of state.agents) {
    if (pmIds.has(a.id) || listedHere(a)) shipped.set(a.id, { kind: isBuddy(a) ? 'buddy' : 'pm', count: 0 })
  }
  const credit = (agentId: string, kind: 'pm' | 'buddy') => {
    const entry = shipped.get(agentId) ?? { kind, count: 0 }
    entry.count++
    shipped.set(agentId, entry)
  }
  for (const g of shippedThisWeek) {
    // The lead recorded when it shipped; a request shipped before that was recorded, its lead now.
    const ledBy = g.ledger?.shippedLeadId !== undefined ? g.ledger.shippedLeadId : g.leadId
    if (ledBy) credit(ledBy, 'pm')
    if (g.ledger?.proposal) credit(creditee(g.ledger.proposal.buddyId), 'buddy')
  }
  const scored = [...shipped].map(([agentId, { kind, count }]) => {
    // Who it is now only while it is this project's: an agent id stays the same when its terminal is added again
    // elsewhere, and a private project's names and owners are not this board's to show (review of #2128).
    const a = state.agents.find(agent => agent.id === agentId && (listedHere(agent) || (!isBuddy(agent) && projectIds.has(agentProjectId(state, agent) ?? ''))))
    // Its Mac only to a reader who sees that Mac: the one Buddy's is its person's, not the project's.
    const machineId = a && (!isSwarmBuddy(a) || visibleMachines.some(m => m.machineId === a.machineId)) ? a.machineId : ''
    return { agentId, displayName: a ? a.displayName ?? a.name : kind === 'pm' ? 'Former PM' : 'Former Buddy', kind,
      personId: a?.buddyOf?.personId ?? null, machineId, points: count * SHIPPED_POINTS, shipped: count }
  }).sort((a, b) => b.points - a.points || (a.kind === b.kind ? a.displayName.localeCompare(b.displayName) : a.kind === 'pm' ? -1 : 1))
  return scored.map(entry => ({ ...entry, rank: 1 + scored.filter(other => other.points > entry.points).length }))
}

/** Every model that worked this week: its attempts, the requests they shipped, their first reviews, and the review
 *  verdicts it gave. A request ships on its last attempt before it shipped. */
function modelScores(requests: Conversation[], shippedThisWeek: Conversation[], span: Span): ModelScore[] {
  const rows = new Map<string, ModelScore & { attemptMs: number[]; requestMs: number[] }>()
  const row = (on: RanOn) => {
    const key = JSON.stringify([on.engine, on.model, on.effort ?? null])
    let entry = rows.get(key)
    if (!entry) rows.set(key, entry = { engine: on.engine, model: on.model, effort: on.effort ?? null, grid: !!on.grid, points: 0, rank: 0,
      attempts: 0, shipped: { count: 0, medianAttemptMs: null, medianRequestMs: null }, firstReview: { reviewed: 0, passed: 0 }, reviews: 0,
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
    const first = firstAssignedAt(ledger)
    if (first != null) entry.requestMs.push(Math.max(0, shippedAt - first))
  }
  for (const group of requests) {
    for (const run of group.ledger?.runs ?? []) {
      if (!within(run.at, span)) continue
      const entry = row(run)
      entry.attempts++
      if (run.firstReview === undefined) continue
      entry.firstReview.reviewed++
      if (run.firstReview) entry.firstReview.passed++
    }
    for (const counted of reviewsIn(group.ledger ?? {}, span)) row(counted).reviews += counted.count
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

/** The attempts started in [span], by the kind of model they ran on. */
function modelShare(requests: Conversation[], span: Span): ModelShare {
  const runs = requests.flatMap(g => g.ledger?.runs ?? []).filter(r => within(r.at, span))
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
