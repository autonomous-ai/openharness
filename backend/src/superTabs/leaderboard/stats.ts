/**
 * The leaderboard of one project and week (docs/swarms.md, Leaderboard): three numbers per person, Shipped, Unblocked and
 * Lent, their points, a shipping streak, the team goal, and who agents wait on now. Pure: the read decides who may see it and
 * hands in only the groups that reader may read. Private conversations are left out here too.
 */
import { isLeads, type Conversation, type SuperTabState } from '../model.js'
import { canReadProject, projectOf } from '../projects.js'
import { waitedOn } from './record.js'
import { DAY_MS, WEEK_MS } from './week.js'
import type { Leaderboard, Medal, PersonScore, WeekGoal } from './contract.js'

export const SHIPPED_POINTS = 3
export const UNBLOCK_POINTS = 1
const HOUR_MS = 3_600_000
/** One more point per this many agent-hours an answer freed, and per this many agent-hours lent. */
export const UNBLOCK_HOURS_PER_POINT = 2
export const LENT_HOURS_PER_POINT = 10
const MEDALS: Medal[] = ['gold', 'silver', 'bronze']

export interface LeaderboardInput {
  state: SuperTabState
  /** Every group of the Swarm the reader may read, dormant ones of the last weeks included. */
  groups: Conversation[]
  projectId: string
  /** The Monday 00:00 UTC the week starts (week.ts). */
  week: number
  now: number
}

export function leaderboard({ state, groups, projectId, week, now }: LeaderboardInput): Leaderboard {
  const project = projectOf(state, projectId)
  const shared = groups.filter(g => !isLeads(g) && !g.audience && (g.projectId ?? 'lead') === projectId && g.id !== project.leadConversationId)
  const requests = shared.filter(g => !g.reviewOf)
  const landed = requests.filter(g => g.requesterId && g.ledger?.shippedAt != null && (g.pullRequestUrls?.length ?? 0) > 0)
  const players = state.people.filter(p => canReadProject(state, { kind: 'person', userId: p.id, email: p.email }, project))
  const inWeek = (at: number, start = week) => at >= start && at < start + WEEK_MS
  const score = (personId: string, start: number) => {
    const shippedHere = landed.filter(g => g.requesterId === personId && inWeek(g.ledger!.shippedAt!, start))
    const answers = shared.flatMap(g => g.ledger?.unblocks ?? []).filter(u => u.personId === personId && inWeek(u.at, start))
    const machines = (state.machines ?? []).filter(m => m.contributorId === personId)
      .map(m => m.lent?.find(l => l.week === start)?.agentMs ?? 0).filter(ms => ms > 0)
    const freedMs = sum(answers.map(u => u.waitedMs)), lentMs = sum(machines)
    const points = shippedHere.length * SHIPPED_POINTS + answers.length * UNBLOCK_POINTS
      + Math.floor(freedMs / (UNBLOCK_HOURS_PER_POINT * HOUR_MS)) + Math.floor(lentMs / (LENT_HOURS_PER_POINT * HOUR_MS))
    return {
      points,
      shipped: { count: shippedHere.length, medianAskToShipMs: median(askToShip(shippedHere)) },
      unblocked: { count: answers.length, agentMs: freedMs, medianAnswerMs: median(answers.map(u => u.waitedMs)) },
      lent: { machines: machines.length, agentMs: lentMs },
    }
  }
  const goal = (start: number): WeekGoal => {
    const shippedHere = landed.filter(g => inWeek(g.ledger!.shippedAt!, start))
    return { shipped: shippedHere.length, points: sum(players.map(p => score(p.id, start).points)), medianAskToShipMs: median(askToShip(shippedHere)) }
  }
  const today = Math.floor(Math.min(now, week + WEEK_MS - 1) / DAY_MS)
  const scored = players.map(p => ({ personId: p.id, email: p.email, ...score(p.id, week),
    streakDays: streak(new Set(landed.filter(g => g.requesterId === p.id).map(g => Math.floor(g.ledger!.shippedAt! / DAY_MS))), today) }))
    .sort((a, b) => b.points - a.points || a.email.localeCompare(b.email))
  const people: PersonScore[] = scored.map(({ email: _email, ...entry }) => {
    const rank = 1 + scored.filter(other => other.points > entry.points).length
    return { ...entry, rank, medal: entry.points > 0 ? MEDALS[rank - 1] ?? null : null }
  })
  return {
    projectId, week,
    goal: { openRequests: requests.filter(open).length, thisWeek: goal(week), lastWeek: goal(week - WEEK_MS) },
    people,
    waiting: waitingNow(state, shared),
  }
}

/** Shared work still to land: not shipped, cancelled, stopped or archived. */
const open = (group: Conversation): boolean => !group.archived && group.ledger?.shippedAt == null
  && !['done', 'cancelled', 'stopped'].includes(group.assignment?.status ?? '')

/** Who agents wait on now and how many items each: in name order, never ranked (the mockup's "Kind" rule). */
function waitingNow(state: SuperTabState, shared: Conversation[]): Leaderboard['waiting'] {
  const byPerson = new Map<string, string[]>()
  for (const group of shared.filter(g => !g.archived && g.assignment?.status === 'needs_human')) {
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
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
