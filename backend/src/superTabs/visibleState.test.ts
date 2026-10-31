import { describe, expect, it } from 'vitest'
import { freeze } from './cache.js'
import { SuperTabError, visibleState, type Actor } from './model.js'
import { fullSwarm, NOW, outsider, owner, peer } from './read/fixture.test-support.js'

const stranger: Actor = { kind: 'person', userId: '100000000000000000000009', email: 'stranger@example.com' }
const agentActor = (agentId: string): Actor => ({ kind: 'agent', agentId, machineOwnerId: `${owner.userId}-machine` })
const s = fullSwarm()
const readers: Array<[string, Actor]> = [['the owner', owner], ['a member of the private project', peer], ['a member outside it', outsider],
  ['a Buddy', agentActor(s.buddy)], ['a worker', agentActor(s.worker)], ['a Lead', agentActor(s.lead)]]
/** Kept from every reader: visibleState leaves them out before it copies. */
const withheld = ['sharing', 'harnessReservations', 'releasedHarnesses', 'overlapAlerts', 'closingSessions'] as const

describe('visibleState', () => {
  it('reads a Swarm that holds everything it leaves out', () => {
    for (const field of withheld) expect(s.state[field], field).toBeDefined()
    expect(s.state.conversations.some(c => c.dormant)).toBe(true)
  })

  it.each(readers)('hands %s no dormant conversation and none of the withheld fields', (_name, actor) => {
    const visible = visibleState(s.state, actor, NOW)
    for (const field of withheld) expect(visible, field).not.toHaveProperty(field)
    expect(visible.conversations.some(c => c.dormant)).toBe(false)
  })

  it('keeps project progress and each reader\'s projects', () => {
    expect(visibleState(s.state, owner, NOW).projects!.some(p => p.progress)).toBe(true)
    expect(visibleState(s.state, peer, NOW).projects!.map(p => p.id)).toContain(s.secret)
    expect(visibleState(s.state, outsider, NOW).projects!.map(p => p.id)).not.toContain(s.secret)
    expect(visibleState(s.state, agentActor(s.buddy), NOW).machines).toEqual([])
  })

  it('refuses someone outside the Swarm', () => {
    let refused: unknown
    try { visibleState(s.state, stranger, NOW) } catch (error) { refused = error }
    expect(refused).toBeInstanceOf(SuperTabError)
    expect(refused).toMatchObject({ code: 'FORBIDDEN', unreachable: true })
  })

  it.each(readers)('reads a frozen, shared state for %s as an unfrozen one, leaving it untouched', (_name, actor) => {
    const frozen = structuredClone(s.state)
    freeze(frozen)
    expect(visibleState(frozen, actor, NOW)).toStrictEqual(visibleState(structuredClone(s.state), actor, NOW))
  })

  it('fails loudly on a value it cannot copy', () => {
    expect(() => visibleState({ ...s.state, stray: new Map() } as never, owner, NOW)).toThrow(/cannot copy a Map at stray/)
  })
})
