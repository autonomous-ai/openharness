import { describe, expect, it } from 'vitest'
import { stateDifference } from './verify.js'
import { richSwarm } from '../read/fixture.test-support.js'
import type { SuperTabState } from '../model.js'

const base = (): SuperTabState => {
  const state = structuredClone(richSwarm().state)
  state.harnessReservations = [{ machineId: 'a', harnessId: '1', generation: 'g', renewed: false }, { machineId: 'b', harnessId: '2', generation: 'g', renewed: true }]
  state.releasedHarnesses = [{ machineId: 'a', harnessId: 'x' }, { machineId: 'b', harnessId: 'y' }]
  state.overlapAlerts = ['p:q', 'a:b']
  return state
}

describe('state verification (design 6.3)', () => {
  it('finds no difference between equal states', () => {
    expect(stateDifference(base(), base())).toBeNull()
  })

  it('ignores the order of the ledger arrays and overlap alerts, which carry none', () => {
    const other = base()
    other.harnessReservations!.reverse()
    other.releasedHarnesses!.reverse()
    other.overlapAlerts!.reverse()
    expect(stateDifference(base(), other)).toBeNull()
  })

  it('keeps the order of every other array', () => {
    const other = base()
    other.conversations.reverse()
    expect(stateDifference(base(), other)).toMatch(/^conversations\[0\]/)
  })

  it('treats an absent optional list and an empty one as the same', () => {
    const one = base(), other = base()
    one.starts = []
    one.machineCleanups = []
    delete other.starts
    expect(stateDifference(one, other)).toBeNull()
  })

  it('treats a key holding undefined as absent, as stored JSON does', () => {
    const other = base()
    other.agents[0]!.downSince = undefined
    expect(stateDifference(base(), other)).toBeNull()
  })

  it('names the first differing path', () => {
    const other = base()
    other.conversations[2]!.title = 'Changed'
    expect(stateDifference(base(), other)).toBe('conversations[2].title: "Web" ≠ "Changed"')
    const extra = base()
    ;(extra.agents[1] as unknown as Record<string, unknown>).surprise = 1
    expect(stateDifference(base(), extra)).toBe('agents[1].surprise: (absent) ≠ 1')
    const shorter = base()
    shorter.people.pop()
    expect(stateDifference(base(), shorter)).toMatch(/^people: 3 items ≠ 2 items/)
  })
})
