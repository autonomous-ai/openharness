import { describe, expect, it } from 'vitest'
import { LEVELS, levelOf, none, rankPeople, weighted, WEIGHT, type Shipped } from './score.js'

const shipped = (counts: Partial<Shipped>): Shipped => ({ ...none(), ...counts })
const agent = (personId: string, counts: Partial<Shipped>) => ({ personId, shipped: shipped(counts) })

describe('what an issue is worth', () => {
  it('follows its own priority label, and no label counts as P2', () => {
    expect(WEIGHT).toEqual({ P0: 8, P1: 4, P2: 2, P3: 1, none: 2 })
    expect(weighted(shipped({ P0: 1, P1: 1, P2: 1, P3: 1, none: 1 }))).toBe(17)
    expect(weighted(shipped({}))).toBe(0)
  })
})

describe('a person\'s points', () => {
  it('are the sum over their agents of the square root of what each shipped', () => {
    const [mia] = rankPeople([agent('mia', { P3: 4 }), agent('mia', { P1: 1 })])
    expect(mia).toMatchObject({ personId: 'mia', agentsShipping: 2, points: 4 })
  })

  it('reward a second agent\'s first ship above the first agent\'s tenth', () => {
    const points = (agents: Array<Partial<Shipped>>) => rankPeople(agents.map(counts => agent('mia', counts)))[0]!.points
    const tenth = points([{ P3: 10 }]) - points([{ P3: 9 }])
    const second = points([{ P3: 9 }, { P3: 1 }]) - points([{ P3: 9 }])
    expect(second).toBeGreaterThan(tenth * 5)
  })

  it('count an agent shipping only while it has shipped something', () => {
    const [mia] = rankPeople([agent('mia', { P3: 1 }), agent('mia', {})])
    expect(mia!.agentsShipping).toBe(1)
  })
})

describe('the ranking', () => {
  it('lists the people with an agent shipping, most points first, ties sharing a rank', () => {
    const people = rankPeople([agent('zed', { P2: 2 }), agent('ann', { P2: 2 }), agent('bob', { P0: 8 }), agent('cy', {})])
    expect(people.map(p => [p.personId, p.rank, p.points])).toEqual([['bob', 1, 8], ['ann', 2, 2], ['zed', 2, 2]])
  })

  it('puts the person with more agents shipping first among equal points', () => {
    const people = rankPeople([agent('aaa', { P0: 2 }), agent('zzz', { P1: 1 }), agent('zzz', { P1: 1 })])
    expect(people.map(p => [p.personId, p.rank, p.agentsShipping])).toEqual([['zzz', 1, 2], ['aaa', 1, 1]])
  })

  it('judges ties on the points shown: one decimal', () => {
    // 10.0 and 10.05 are both shown as 10.
    const people = rankPeople([agent('b', { P3: 101 }), agent('a', { P2: 50 })])
    expect(people.map(p => [p.personId, p.points, p.rank])).toEqual([['a', 10, 1], ['b', 10, 1]])
  })

  it('lists nobody when nothing shipped', () => {
    expect(rankPeople([])).toEqual([])
    expect(rankPeople([agent('a', {})])).toEqual([])
  })
})

describe('levels', () => {
  it('follow the number of agents shipping', () => {
    expect(LEVELS).toEqual([1, 2, 3, 5, 8, 13, 21])
    expect([0, 1, 2, 3, 4, 5, 7, 8, 12, 13, 20, 21, 99].map(levelOf)).toEqual([0, 1, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7])
    const [mia] = rankPeople(Array.from({ length: 5 }, () => agent('mia', { P3: 1 })))
    expect(mia).toMatchObject({ agentsShipping: 5, level: 4 })
  })
})
