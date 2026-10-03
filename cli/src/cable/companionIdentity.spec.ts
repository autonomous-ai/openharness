import { describe, expect, it } from 'vitest'
import { CompanionZoo, companionIdentity, readCompanionIdentity, COMPANION_SPECIES } from './companionIdentity.js'
import type { ZooIndividual } from '../pair/individuals.js'

const individual = (id = 'tim', changes: Partial<ZooIndividual> = {}): ZooIndividual => ({
  id, uid: `individual_${id}`, seed: 123456, serial: 42, name: 'Pip', version: '0.1', hatched: 100_000, ...changes,
})
const zoo = (daemons = [individual()], paired: string | null = 'individual_tim') => ({ daemons, paired })

describe('individual companion identity and milestones', () => {
  it('uses the same deterministic traits for every species and preserves legacy artwork', () => {
    for (const id of COMPANION_SPECIES) {
      const identity = companionIdentity(individual(id))!
      expect(readCompanionIdentity(identity)).toEqual(identity)
      expect(companionIdentity(individual(id))).toEqual(identity)
      expect(identity.colour).toBeGreaterThanOrEqual(0)
      expect(identity.colour).toBeLessThan(6)
      expect(companionIdentity(individual(id, { seed: 0 }))).toMatchObject({ colour: -1, mark: 0 })
    }
    expect(companionIdentity(individual('tim', { name: null }))).toMatchObject({ name: 'tim #0042' })
  })

  it('rejects malformed wire identities before they reach the dial', () => {
    const good = companionIdentity(individual())!
    for (const patch of [{id:'unknown'}, {uid:'../bad'}, {name:'\n'}, {name:'x'.repeat(25)},
      {seed:NaN}, {seed:2**32}, {seed:1.5}, {version:'3.0'}, {colour:6}, {mark:5}, {mark:-1}]) {
      expect(readCompanionIdentity({...good,...patch})).toBeNull()
    }
  })

  it('keeps initial reads, stale snapshots, renames, retries and resets quiet', () => {
    const observer = new CompanionZoo()
    observer.observe(zoo(), 100_000, 1)
    expect(observer.milestone).toBeNull()
    observer.observe(zoo([individual('tim', {version:'1.0'})]), 100_100, 2)
    expect(observer.milestone).toMatchObject({kind:'grow',at:100_100,companion:{version:'1.0'}})
    observer.observe(zoo(), 101_000, 1)
    expect(observer.identity?.version).toBe('1.0')
    observer.observe(zoo([individual('tim', {version:'1.0',name:'Dot'})]), 101_200, 3)
    expect(observer.milestone?.at).toBe(100_100)
    expect(observer.identity?.name).toBe('Dot')
    observer.observe(zoo([individual('tim', {version:'1.0'})]), 110_000, 4)
    expect(observer.milestone).toBeNull()
    observer.reset()
    observer.observe(zoo([individual('tim', {version:'2.0'})]), 111_000, 1)
    expect(observer.milestone).toBeNull()
  })

  it('celebrates a fresh hatch without pairing it, and ignores an old arrival', () => {
    const observer = new CompanionZoo()
    observer.observe(zoo(), 100_000)
    observer.observe(zoo([individual(), individual('gnu', {hatched:101_000})]), 101_000)
    expect(observer.identity?.id).toBe('tim')
    expect(observer.milestone).toMatchObject({kind:'hatch',companion:{id:'gnu'}})
    observer.observe(zoo([individual(), individual('gnu'), individual('yak', {hatched:1})]), 120_000)
    expect(observer.milestone).toBeNull()
  })
})
