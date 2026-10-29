import { describe, expect, it } from 'vitest'
import { createSuperTab } from '../model.js'
import { capReleased, departedAgents, hostMarker, hostsToTell, plainHost, sameData, visibilityChanged } from './commit.js'
import type { PartWrite } from './write.js'

describe('writing a Swarm\'s parts', () => {
  it('keeps the newest 200 released harnesses of each machine and drops the oldest', () => {
    const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    state.releasedHarnesses = [...Array.from({ length: 205 }, (_, i) => ({ machineId: 'busy', harnessId: `h${i}` })), { machineId: 'quiet', harnessId: 'only' }]
    capReleased(state)
    const busy = state.releasedHarnesses.filter(r => r.machineId === 'busy').map(r => r.harnessId)
    expect(busy).toHaveLength(200)
    expect(busy[0]).toBe('h5')
    expect(busy.at(-1)).toBe('h204')
    expect(state.releasedHarnesses.filter(r => r.machineId === 'quiet')).toEqual([{ machineId: 'quiet', harnessId: 'only' }])
  })

  it('moves the visibility epoch when who sees what changes, and not for an ordinary write', () => {
    const before = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    const renamed = structuredClone(before)
    renamed.name = 'Renamed'
    expect(visibilityChanged(before, renamed)).toBe(false)
    const privateProject = structuredClone(before)
    privateProject.projects![0]!.visibility = 'private'
    expect(visibilityChanged(before, privateProject)).toBe(true)
    const withAudience = structuredClone(before)
    withAudience.conversations.push({ id: 'c', projectId: 'lead', title: 'C', leadId: null, agentIds: [], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: 'tab' }] } })
    const narrowed = structuredClone(withAudience)
    narrowed.conversations.at(-1)!.audience = { people: [] }
    expect(visibilityChanged(withAudience, narrowed)).toBe(true)
  })
})

describe('what a write tells host reads (review round 1)', () => {
  const pool = { machineId: 'mac', name: 'Mac', contributorId: 'owner', membershipGeneration: 'tab', generation: 'g1', cwd: '/repo', engines: ['codex'],
    maxAgents: 2, paused: false }
  const machine = (change: Record<string, unknown> = {}, observation?: Record<string, unknown>) => ({ machineId: 'mac', reservations: [], released: [],
    closingSessions: [], cleanups: [], ...change, contribution: { ...pool, ...(observation ? { observation } : {}) } })
  const reading = (receivedAt: number) => ({ generation: 'g1', receivedAt, resources: {}, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] })
  const none = new Map<string, string>()

  it('leaves the settings marker alone when only the machine\'s reading changed', () => {
    expect(hostMarker('machine', machine({}, reading(1)), machine({}, reading(2)), none, 9)).toEqual({})
    expect(hostMarker('machine', machine(), machine({}, reading(2)), none, 9)).toEqual({})
  })

  it('leaves it alone when only the Lent hours credited from that reading changed', () => {
    const lent = (agentMs: number, observation?: Record<string, unknown>) => {
      const part = machine({}, observation)
      return { ...part, contribution: { ...part.contribution, lent: [{ week: 0, agentMs }] } }
    }
    expect(hostMarker('machine', machine({}, reading(1)), lent(15_000, reading(2)), none, 9)).toEqual({})
    expect(hostMarker('machine', lent(15_000), lent(30_000), none, 9)).toEqual({})
  })

  it('moves it for a change to the machine\'s settings or ledger, and when the part is added or removed', () => {
    const at = { host: { hostChangedAt: new Date(9) } }
    const paused = machine({}, reading(2))
    paused.contribution.paused = true
    expect(hostMarker('machine', machine({}, reading(1)), paused, none, 9)).toEqual(at)
    expect(hostMarker('machine', machine(), machine({ reservations: [{ harnessId: 'h', generation: 'g', renewed: false }] }), none, 9)).toEqual(at)
    expect(hostMarker('machine', undefined, machine(), none, 9)).toEqual(at)
    expect(hostMarker('machine', machine(), undefined, none, 9)).toEqual(at)
  })

  it('names the machines of a group\'s agents and work before and after its write, the agent that left included', () => {
    const group = (agentIds: string[], executionMachineId?: string) => ({ id: 'g', title: 'G', leadId: null, agentIds, archived: false, brief: '', checks: [],
      lastMessageSequence: 0, assignment: executionMachineId ? { id: 'w', agentId: 'a', status: 'done', configuration: {}, result: null,
        execution: { machineId: executionMachineId, harnessId: 'h', machineOwnerId: 'o' } } : null })
    const machineOf = new Map([['leaving', 'm1'], ['staying', 'm2']])
    expect(hostMarker('group', group(['leaving', 'staying'], 'm3'), group(['staying']), machineOf, 9)).toEqual({ host: { hostMachineIds: ['m1', 'm2', 'm3'] } })
    expect(hostMarker('agent', {}, {}, machineOf, 9)).toEqual({})
  })
})

describe('which machines\' hosts a commit tells (WS roadmap Phase 2a)', () => {
  // Mac A lends a pool and runs agent a1; the team account B follows Mac A; Mac C runs agent c1 only.
  const swarm = () => {
    const state = createSuperTab('tab', 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'prod')
    state.machines = [{ machineId: 'A' }, { machineId: 'B', hostMachineId: 'A' }] as never
    state.agents = [{ id: 'a1', machineId: 'A' }, { id: 'c1', machineId: 'C' }] as never
    return state
  }
  const update = (kind: PartWrite['kind'], key: string, data: unknown, host?: object): PartWrite => ({ op: 'update', kind, key, seen: 1, data, ...(host ? { host } : {}) })
  const tell = (writes: PartWrite[]) => hostsToTell(writes, swarm(), swarm()).sort()

  it('tells every host of the Swarm when its head or members change', () => {
    expect(tell([update('head', 'head', {})])).toEqual(['A', 'B', 'C'])
    expect(tell([update('member', 'owner', {})])).toEqual(['A', 'B', 'C'])
  })

  it('tells only the machine an agent or a start is on', () => {
    expect(tell([update('agent', 'c1', { machineId: 'C' })])).toEqual(['C'])
    expect(tell([update('start', 's', { request: { machineId: 'A' } })])).toEqual(['A'])
  })

  it('tells the machines a group\'s marker names, and none for a group write without one', () => {
    expect(tell([update('group', 'g', {}, { hostMachineIds: ['C'] })])).toEqual(['C'])
    expect(tell([update('group', 'g', {})])).toEqual([])
  })

  it('tells a machine whose settings changed, the Mac it follows and the team accounts that follow it, never for its reading alone', () => {
    expect(tell([update('machine', 'A', { machineId: 'A', contribution: {} }, { hostChangedAt: new Date(9) })])).toEqual(['A', 'B'])
    expect(tell([update('machine', 'B', { machineId: 'B', contribution: { hostMachineId: 'A' } }, { hostChangedAt: new Date(9) })])).toEqual(['A', 'B'])
    expect(tell([update('machine', 'A', { machineId: 'A', contribution: {} })])).toEqual([])
  })

  it('tells nobody for touches or progress', () => {
    expect(tell([{ op: 'touch', kind: 'head', key: 'head', seen: 1 }, update('progress', 'p', {})])).toEqual([])
  })

  it('tells a machine the commit removed from the Swarm', () => {
    const after = swarm()
    after.agents = after.agents.filter(a => a.machineId !== 'C')
    expect(hostsToTell([update('head', 'head', {})], swarm(), after).sort()).toEqual(['A', 'B', 'C'])
  })
})

// Review of #2113: the host read (read/host.ts) and the push (hostsToTell) share one rule, so they cannot drift apart.
describe('which host a part concerns from its data alone', () => {
  it('is every host for the head and the Swarm\'s people, an agent\'s or a start\'s machine, and none for other kinds', () => {
    expect(plainHost('head', {})).toBe('all')
    expect(plainHost('member', {})).toBe('all')
    expect(plainHost('agent', { machineId: 'A' })).toBe('A')
    expect(plainHost('start', { request: { machineId: 'B' } })).toBe('B')
    expect(plainHost('agent', null)).toBeNull()
    expect(plainHost('start', { request: {} })).toBeNull()
    expect(plainHost('group', { agentIds: [] })).toBeNull()
    expect(plainHost('machine', { machineId: 'A' })).toBeNull()
  })
})

describe('agents a group write lets go (review round 2)', () => {
  const group = (agentIds: string[], worker?: string) => ({ id: 'g', title: 'G', leadId: null, agentIds, archived: false, brief: '', checks: [],
    lastMessageSequence: 0, assignment: worker ? { id: 'w', agentId: worker, status: 'working', configuration: {}, result: null,
      execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'o' } } : null })

  it('names the agents that left the group or its work, and nobody for a write that keeps everyone', () => {
    expect(departedAgents(group(['lead', 'loner']), group(['lead']))).toEqual(['loner'])
    expect(departedAgents(group(['lead'], 'worker'), group(['lead']))).toEqual(['worker'])
    expect(departedAgents(group(['lead', 'worker'], 'worker'), group(['lead', 'worker']))).toEqual([])
    expect(departedAgents(group(['lead']), group(['lead', 'new']))).toEqual([])
    expect(departedAgents(undefined, group(['lead']))).toEqual([])
  })
})

describe('whether a part\'s data changed', () => {
  /** What a stored record says, as JSON with sorted keys: the comparison commits made before (the oracle). */
  const sorted = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)

  it('ignores the order keys were built in, and fields left undefined', () => {
    expect(sameData({ a: 1, b: { c: [1, 2], d: 'x' } }, { b: { d: 'x', c: [1, 2] }, a: 1 })).toBe(true)
    expect(sameData({ a: 1, gone: undefined }, { a: 1 })).toBe(true)
    expect(sameData({ when: new Date(5) }, { when: new Date(5).toISOString() })).toBe(true)
  })

  it('sees a changed value, a null where nothing was, a reordered list, and a longer one', () => {
    expect(sameData({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
    expect(sameData({ a: null }, {})).toBe(false)
    expect(sameData({ list: [1, 2] }, { list: [2, 1] })).toBe(false)
    expect(sameData({ list: [1] }, { list: [1, undefined] })).toBe(false)
    expect(sameData({ n: 1 }, { n: '1' })).toBe(false)
    expect(sameData([], {})).toBe(false)
  })

  it('agrees with comparing sorted JSON on many random records', () => {
    let seed = 1726
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    const leaf = () => [null, undefined, 0, 1, 'a', 'b', true, false, Number.NaN][Math.floor(next() * 9)]
    const make = (depth: number): unknown => {
      const r = next()
      if (depth > 3 || r < 0.4) return leaf()
      if (r < 0.7) return Array.from({ length: Math.floor(next() * 3) }, () => make(depth + 1))
      return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [['x', 'y', 'z', 'w'][Math.floor(next() * 4)]!, make(depth + 1)]))
    }
    const mutate = (value: unknown): unknown => {
      if (next() < 0.3) return make(2)
      if (Array.isArray(value)) return value.map(mutate)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, mutate(v)]))
      return value
    }
    let differ = 0
    for (let i = 0; i < 5_000; i++) {
      const a = make(0), b = next() < 0.5 ? structuredClone(a) : mutate(a)
      const expected = sorted(a) === sorted(b)
      if (!expected) differ++
      expect(sameData(a, b), `${sorted(a)} vs ${sorted(b)}`).toBe(expected)
    }
    expect(differ).toBeGreaterThan(500)
  })
})
