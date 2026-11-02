import { describe, expect, it } from 'vitest'
import { hostGroupsRule, hostGroupsSignature, type HostGroups } from './hostInputs.js'
import type { Part } from '../parts/index.js'
import type { SwarmDelta } from '../parts/load.js'

const group = (key: string, version: number, extra: Partial<Part> = {}): Part =>
  ({ kind: 'group', key, version, changedAt: version * 1_000, ordinal: version, data: { id: key }, ...extra }) as Part
const delta = (parts: Part[], digests: Array<[string, string | null]> | null): SwarmDelta =>
  ({ parts, head: null, ...digests ? { hostDigests: new Map(digests) } : {} })
const held = (): HostGroups => ({
  b: { digest: 'BBB', dormant: true, version: 2 },
  a: { digest: 'AAA', dormant: false, version: 3 },
  c: { digest: null, dormant: false, version: 1 },
})

describe('hostGroupsSignature', () => {
  it('joins each conversation\'s digest and dormancy in key order, as the pipeline did, and counts the ones with no digest', () => {
    expect(hostGroupsSignature(held())).toEqual({ missing: 1, all: 'AAA0BBB10' })
  })

  it('is empty for a Swarm with no conversation', () => {
    expect(hostGroupsSignature({})).toEqual({ missing: 0, all: '' })
  })
})

describe('hostGroupsRule', () => {
  it('replaces a row on a newer version, with its new digest', () => {
    const next = hostGroupsRule.apply(held(), delta([group('a', 4)], [['a', 'AAB']])) as HostGroups
    expect(next.a).toEqual({ digest: 'AAB', dormant: false, version: 4 })
    expect(hostGroupsSignature(next).all).toBe('AAB0BBB10')
  })

  it('keeps the rows that did not change as they were', () => {
    const before = held()
    const next = hostGroupsRule.apply(before, delta([group('a', 4)], [['a', 'AAB']])) as HostGroups
    expect(next.b).toBe(before.b)
  })

  it('a conversation put to sleep, and woken, changes its flag', () => {
    const asleep = hostGroupsRule.apply(held(), delta([group('a', 4, { dormant: true })], [['a', 'AAA']])) as HostGroups
    expect(hostGroupsSignature(asleep).all).toBe('AAA1BBB10')
    const woken = hostGroupsRule.apply(asleep, delta([group('a', 5)], [['a', 'AAA']])) as HostGroups
    expect(hostGroupsSignature(woken).all).toBe('AAA0BBB10')
  })

  it('a tombstone removes the row, and the same key added again returns', () => {
    const gone = hostGroupsRule.apply(held(), delta([group('b', 3, { deleted: true })], [['b', 'BBB']])) as HostGroups
    expect(Object.keys(gone).sort()).toEqual(['a', 'c'])
    const back = hostGroupsRule.apply(gone, delta([group('b', 4)], [['b', 'BBC']])) as HostGroups
    expect(back.b).toEqual({ digest: 'BBC', dormant: false, version: 4 })
  })

  it('a new conversation is added', () => {
    const next = hostGroupsRule.apply(held(), delta([group('d', 1)], [['d', 'DDD']])) as HostGroups
    expect(hostGroupsSignature(next).all).toBe('AAA0BBB10DDD0')
  })

  it('an equal or older version, or a tombstone of a conversation not held, changes nothing', () => {
    const before = held()
    expect(hostGroupsRule.apply(before, delta([group('a', 3), group('b', 1), group('z', 9, { deleted: true })], [['a', 'XXX'], ['b', 'XXX'], ['z', 'XXX']]))).toBe(before)
  })

  it('a row that gains its digest is no longer missing', () => {
    const next = hostGroupsRule.apply(held(), delta([group('c', 2)], [['c', 'CCC']])) as HostGroups
    expect(hostGroupsSignature(next)).toEqual({ missing: 0, all: 'AAA0BBB1CCC0' })
  })

  it('a conversation changed with no stored digest is missing again', () => {
    const next = hostGroupsRule.apply(held(), delta([group('a', 4)], [['a', null]])) as HostGroups
    expect(hostGroupsSignature(next).missing).toBe(2)
  })

  it('a delta that carries no digests cannot be applied: the entry loads again', () => {
    expect(hostGroupsRule.apply(held(), delta([group('a', 4)], null))).toBe('reload')
  })

  it('a delta with a conversation the loader gave no digest for cannot be applied either', () => {
    expect(hostGroupsRule.apply(held(), delta([group('a', 4)], []))).toBe('reload')
  })
})
