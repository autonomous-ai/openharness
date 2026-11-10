/**
 * How the leaderboard scores (docs/plans/2026-11-09-swarm-v4-leaderboard.md): by what an agent shipped, never by activity. An
 * agent ships an issue when its pull request merges, the issue closes and nothing is reverted within 7 days; the daemon of its
 * person counts those by the issue's own priority label. The board's headline is how many of a person's agents ship.
 */
import type { Prisma } from '@prisma/client'

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'none'] as const
export type Priority = typeof PRIORITIES[number]
/** Issues shipped, by the priority label each carried. */
export type Shipped = Record<Priority, number>

/** What an issue is worth by its own priority label: the org's priorities decide what counts. P0 is a hotfix, P1 needed soon,
 *  P2 planned, P3 tools and docs; an issue with none counts as P2, as a task without one did. */
export const WEIGHT: Readonly<Record<Priority, number>> = { P0: 8, P1: 4, P2: 2, P3: 1, none: 2 }

export const none = (): Shipped => ({ P0: 0, P1: 0, P2: 0, P3: 0, none: 0 })
export const weighted = (shipped: Shipped): number => PRIORITIES.reduce((sum, priority) => sum + WEIGHT[priority] * shipped[priority], 0)

/** The levels follow the number of agents shipping: the count of these a person has reached. */
export const LEVELS = [1, 2, 3, 5, 8, 13, 21] as const
export const levelOf = (agentsShipping: number): number => LEVELS.filter(at => agentsShipping >= at).length

/**
 * The stages that sum, per person, the square root of what each of their agents shipped, weighed, for the rows a first `$match`
 * chose (one week's, or the all-time rows): one row per person comes back, however many agents there are. A second agent's first
 * ship (+1.0) is worth more than the first agent's tenth (+0.16), so the board rewards building more agents that ship. An agent
 * that shipped nothing is no agent shipping.
 */
export const pointsStages = (): Prisma.InputJsonValue[] => [
  { $project: { personId: 1, worth: { $add: PRIORITIES.map((priority, i) => ({ $multiply: [{ $ifNull: [{ $arrayElemAt: ['$shipped', i] }, 0] }, WEIGHT[priority]] })) } } },
  { $match: { worth: { $gt: 0 } } },
  { $group: { _id: '$personId', sum: { $sum: { $sqrt: '$worth' } }, shipping: { $sum: 1 } } },
]

export interface PersonSum { personId: string; sum: number; shipping: number }
export interface Standing { personId: string; agentsShipping: number; level: number; points: number; rank: number }

/**
 * The people with an agent shipping, best first. Points show to one decimal and ties are judged on what is shown; people with
 * the same points share a rank, and the one with more agents shipping, then the lower id, is listed first.
 */
export function rankSums(sums: readonly PersonSum[]): Standing[] {
  const listed = sums.filter(person => person.shipping > 0).map(({ personId, sum, shipping }) =>
    ({ personId, agentsShipping: shipping, level: levelOf(shipping), points: Math.round(sum * 10) / 10 }))
    .sort((a, b) => b.points - a.points || b.agentsShipping - a.agentsShipping || (a.personId < b.personId ? -1 : a.personId > b.personId ? 1 : 0))
  let rank = 0
  return listed.map((person, i) => ({ ...person, rank: i > 0 && listed[i - 1]!.points === person.points ? rank : (rank = i + 1) }))
}
