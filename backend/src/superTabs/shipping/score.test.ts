import { describe, expect, it } from 'vitest'
import { LEVELS, levelOf, none, pointsStages, rankSums, weighted, WEIGHT, type Shipped } from './score.js'

const shipped = (counts: Partial<Shipped>): Shipped => ({ ...none(), ...counts })
const sum = (personId: string, agents: Array<Partial<Shipped>>) => ({ personId,
  sum: agents.reduce((total, counts) => total + Math.sqrt(weighted(shipped(counts))), 0), shipping: agents.filter(counts => weighted(shipped(counts)) > 0).length })

describe('what an issue is worth', () => {
  it('follows its own priority label, and no label counts as P2', () => {
    expect(WEIGHT).toEqual({ P0: 8, P1: 4, P2: 2, P3: 1, none: 2 })
    expect(weighted(shipped({ P0: 1, P1: 1, P2: 1, P3: 1, none: 1 }))).toBe(17)
    expect(weighted(shipped({}))).toBe(0)
  })

  it('is summed in the database: one row per person, from the square root of each agent\'s weighed week', () => {
    const [project, drop, group] = pointsStages() as Array<Record<string, any>>
    expect(project.$project.worth.$add.map((term: any) => term.$multiply[1])).toEqual([8, 4, 2, 1, 2])
    expect(drop).toEqual({ $match: { worth: { $gt: 0 } } })
    expect(group.$group).toEqual({ _id: '$personId', sum: { $sum: { $sqrt: '$worth' } }, shipping: { $sum: 1 } })
  })
})

describe('the ranking', () => {
  it('lists the people with an agent shipping, most points first, ties sharing a rank', () => {
    const people = rankSums([sum('zed', [{ P2: 2 }]), sum('ann', [{ P2: 2 }]), sum('bob', [{ P0: 8 }]), sum('cy', [{}])])
    expect(people.map(p => [p.personId, p.rank, p.points])).toEqual([['bob', 1, 8], ['ann', 2, 2], ['zed', 2, 2]])
  })

  it('puts the person with more agents shipping first among equal points', () => {
    const people = rankSums([sum('aaa', [{ P0: 2 }]), sum('zzz', [{ P1: 1 }, { P1: 1 }])])
    expect(people.map(p => [p.personId, p.rank, p.agentsShipping])).toEqual([['zzz', 1, 2], ['aaa', 1, 1]])
  })

  it('judges ties on the points shown: one decimal', () => {
    // 10.0 and 10.05 are both shown as 10.
    const people = rankSums([sum('b', [{ P3: 101 }]), sum('a', [{ P2: 50 }])])
    expect(people.map(p => [p.personId, p.points, p.rank])).toEqual([['a', 10, 1], ['b', 10, 1]])
  })

  it('lists nobody when nothing shipped', () => {
    expect(rankSums([])).toEqual([])
    expect(rankSums([sum('a', [{}])])).toEqual([])
  })
})

describe('levels', () => {
  it('follow the number of agents shipping', () => {
    expect(LEVELS).toEqual([1, 2, 3, 5, 8, 13, 21])
    expect([0, 1, 2, 3, 4, 5, 7, 8, 12, 13, 20, 21, 99].map(levelOf)).toEqual([0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7])
    const [mia] = rankSums([sum('mia', Array.from({ length: 5 }, () => ({ P3: 1 })))])
    expect(mia).toMatchObject({ agentsShipping: 5, level: 4 })
  })
})
