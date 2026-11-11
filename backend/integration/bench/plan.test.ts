import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type BenchConfig } from './config.js'
import { plan, planDigest } from './plan.js'

const small: BenchConfig = { ...DEFAULT_CONFIG, agents: 7, projects: 3, machines: 3, durationMs: 120_000 }

describe('plan', () => {
  it('is the same for the same seed and differs for another', () => {
    expect(plan(small)).toEqual(plan(small))
    expect(plan({ ...small, seed: small.seed + 1 }).agents[0]!.posts).not.toEqual(plan(small).agents[0]!.posts)
  })

  it('fingerprints the plan, so two reports can show they ran the same work', () => {
    expect(planDigest(plan(small))).toMatch(/^[0-9a-f]{64}$/)
    expect(planDigest(plan(small))).toBe(planDigest(plan(small)))
    expect(planDigest(plan({ ...small, seed: 2 }))).not.toBe(planDigest(plan(small)))
  })

  it('makes the first agent of each project its PM, spreads the others over the projects, and every agent over the machines', () => {
    const p = plan(small)
    expect(p.agents.map(a => a.pm)).toEqual([true, true, true, false, false, false, false])
    expect(p.agents.map(a => a.project)).toEqual([0, 1, 2, 0, 1, 2, 0])
    expect(p.agents.map(a => a.machine)).toEqual([0, 1, 2, 0, 1, 2, 0])
  })

  it('has every agent post in its channel and its person talk with it, within the run', () => {
    for (const a of plan(small).agents) {
      expect(a.posts.length, `agent ${a.index}`).toBeGreaterThan(0)
      expect(a.turns.length, `agent ${a.index}`).toBeGreaterThan(0)
      expect([...a.posts, ...a.turns].every(t => t >= 0 && t < small.durationMs)).toBe(true)
    }
  })

  it('keeps each agent\'s schedule when the Swarm grows', () => {
    const at = (c: BenchConfig) => plan(c).agents.slice(0, small.agents).map(a => [a.posts, a.turns])
    expect(at({ ...small, agents: 40, projects: 10 })).toEqual(at(small))
  })

  it('leaves out the delivery passes in the cross-chat lane, and keeps agents, machine reports and readers', () => {
    const mixed = plan(small), lane = plan({ ...small, lane: 'cross-chat' })
    expect(mixed.machines.every(m => m.deliveryPasses.length > 0)).toBe(true)
    expect(lane.machines.every(m => !m.deliveryPasses.length)).toBe(true)
    expect(lane.machines.map(m => m.observations)).toEqual(mixed.machines.map(m => m.observations))
    expect(lane.agents).toEqual(mixed.agents)
    expect(lane.readers).toEqual(mixed.readers)
  })

  it('reports every machine every 15 s, and puts readers on the first people and machines', () => {
    const p = plan(small)
    for (const { observations } of p.machines) {
      expect(observations[0]).toBeLessThan(15_000)
      expect(observations.slice(1).map((t, i) => t - observations[i]!)).toEqual(observations.slice(1).map(() => 15_000))
    }
    expect(p.readers.map(r => `${r.kind}:${r.index}`)).toEqual(['desktop:0', 'desktop:1', 'desktop:2', 'host:0', 'host:1'])
    const host = p.readers.find(r => r.kind === 'host')!
    expect(host.polls.slice(0, 3)).toEqual([0, 1000, 2000].map(t => t + host.polls[0]!))
  })
})
