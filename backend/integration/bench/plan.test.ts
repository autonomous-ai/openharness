import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type BenchConfig } from './config.js'
import { plan, planDigest } from './plan.js'

const small: BenchConfig = { ...DEFAULT_CONFIG, groups: 10, doneShare: 0.7, workers: 3, machines: 3, durationMs: 20_000 }

describe('plan', () => {
  it('is the same for the same seed and differs for another', () => {
    expect(plan(small)).toEqual(plan(small))
    expect(plan({ ...small, seed: small.seed + 1 }).workers[0]!.actions).not.toEqual(plan(small).workers[0]!.actions)
  })

  it('fingerprints the plan, so two reports can show they ran the same work', () => {
    expect(planDigest(plan(small))).toMatch(/^[0-9a-f]{64}$/)
    expect(planDigest(plan(small))).toBe(planDigest(plan(small)))
    expect(planDigest(plan({ ...small, seed: 2 }))).not.toBe(planDigest(plan(small)))
  })

  it('gives each worker its own active groups, its task in the first, and shares the done groups among the workers', () => {
    const p = plan(small)
    expect(p.doneGroups).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(p.workers.map(w => w.groups)).toEqual([[7], [8], [9]])
    expect(p.workers.map(w => w.doneGroups)).toEqual([[0, 3, 6], [1, 4], [2, 5]])
    expect(p.workers.map(w => w.machine)).toEqual([0, 1, 2])
    expect(p.workers.every(w => w.actions.every(a => a.group === w.groups[0]))).toBe(true)
  })

  it('runs a hot Swarm with every group active and the same workers spread over them', () => {
    const p = plan({ ...small, doneShare: 0, durationMs: 120_000 })
    expect(p.doneGroups).toEqual([])
    expect(p.workers.map(w => w.groups)).toEqual([[0, 3, 6, 9], [1, 4, 7], [2, 5, 8]])
    for (const w of p.workers) {
      // An agent holds one active task at a time (AGENT_BUSY): its status and checks stay in its first group.
      expect(w.actions.filter(a => a.op !== 'message.send').every(a => a.group === w.groups[0])).toBe(true)
      expect(w.actions.every(a => w.groups.includes(a.group))).toBe(true)
      expect(new Set(w.actions.filter(a => a.op === 'message.send').map(a => a.group)).size).toBeGreaterThan(1)
    }
  })

  it('keeps each worker\'s schedule when only the share of done groups changes', () => {
    const at = (c: BenchConfig) => plan(c).workers.map(w => w.actions.map(a => `${a.at}:${a.op}`))
    expect(at({ ...small, doneShare: 0 })).toEqual(at(small))
  })

  it('draws worker actions only from the mix, within the run', () => {
    const p = plan({ ...small, mix: { 'message.send': 1, 'work.status': 0, 'work.check': 1 } })
    const ops = new Set(p.workers.flatMap(w => w.actions.map(a => a.op)))
    expect([...ops].sort()).toEqual(['message.send', 'work.check'])
    expect(p.workers.every(w => w.actions.every(a => a.at < small.durationMs) && w.turns.every(t => t < small.durationMs))).toBe(true)
  })

  it('reports every machine every 15 s, and puts readers on the first people and machines', () => {
    const p = plan(small)
    for (const { observations } of p.machines) {
      expect(observations[0]).toBeLessThan(15_000)
      expect(observations.slice(1).map((t, i) => t - observations[i]!)).toEqual(observations.slice(1).map(() => 15_000))
    }
    expect(p.readers.map(r => `${r.kind}:${r.index}`)).toEqual(['desktop:0', 'desktop:1', 'desktop:2', 'host:0', 'host:1'])
    expect(p.readers.find(r => r.kind === 'host')!.polls.slice(0, 3)).toEqual([0, 1000, 2000].map(t => t + p.readers.find(r => r.kind === 'host')!.polls[0]!))
  })

  it('has the Lead send to workers that exist, in one of their groups', () => {
    const p = plan({ ...small, doneShare: 0 })
    expect(p.lead.length).toBeGreaterThan(0)
    expect(p.lead.every(send => p.workers[send.worker]?.groups.includes(send.group))).toBe(true)
  })

  it('leaves out the Lead and the delivery passes in the cross-group lane, and keeps workers, machine reports and readers', () => {
    const mixed = plan(small), lane = plan({ ...small, lane: 'cross-group' })
    expect(lane.lead).toEqual([])
    expect(lane.machines.every(m => !m.deliveryPasses.length)).toBe(true)
    expect(lane.machines.map(m => m.observations)).toEqual(mixed.machines.map(m => m.observations))
    expect(lane.workers).toEqual(mixed.workers)
    expect(lane.readers).toEqual(mixed.readers)
  })
})
