import { describe, expect, it } from 'vitest'
import { individualName, pairedIndividual, zooIndividuals } from './individuals.js'

describe('the paired individual', () => {
  const one = { uid: 'a'.repeat(24), id: 'tim', seed: 13, name: 'pip', serial: 42 }
  const two = { uid: 'b'.repeat(24), id: 'tim', seed: 17, name: 'dot', serial: 43 }

  it('resolves the selected uid among multiple individuals of the same species', () => {
    const pair = pairedIndividual({ daemons: [one, two], paired: two.uid })!
    expect(pair).toMatchObject(two)
    expect(individualName(pair)).toBe('dot the tim')
    expect(individualName({ ...pair, name: null })).toBe('tim #0043')
  })

  it('respects an explicit unpair and never substitutes another individual', () => {
    expect(pairedIndividual({ daemons: [one, two], paired: null, pair: one.uid })).toBeNull()
    expect(pairedIndividual({ daemons: [one, two], paired: 'tim' })).toBeNull()
    expect(pairedIndividual({ daemons: [one, two], paired: 'c'.repeat(24) })).toBeNull()
  })

  it('reads an old zoo as default traits and the old nickname', () => {
    const pair = pairedIndividual({ daemons: [{ id: 'tim', nickname: 'pip', hatchedAt: '2026-09-27T00:00:00Z' }], pair: 'tim' })!
    expect(pair).toMatchObject({ uid: null, id: 'tim', seed: 0, name: 'pip', hatched: Date.parse('2026-09-27T00:00:00Z') })
    expect(zooIndividuals({ daemons: [null, { id: '../bad' }, { ...one, seed: 2 ** 32 }] })).toMatchObject([{ seed: 0 }])
  })
})
