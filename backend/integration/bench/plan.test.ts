import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type BenchConfig } from './config.js'
import { plan, planDigest } from './plan.js'

const small: BenchConfig = { ...DEFAULT_CONFIG, groups: 10, doneShare: 0.7, machines: 3, durationMs: 20_000 }

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

  it('gives every active group its own worker, and shares the done groups among the workers', () => {
    const p = plan(small)
    expect(p.doneGroups).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(p.workers.map(w => w.activeGroup)).toEqual([7, 8, 9])
    expect(p.workers.map(w => w.doneGroups)).toEqual([[0, 3, 6], [1, 4], [2, 5]])
    expect(p.workers.map(w => w.machine)).toEqual([0, 1, 2])
  })

  it('runs a hot Swarm with every group active', () => {
    const p = plan({ ...small, doneShare: 0 })
    expect(p.doneGroups).toEqual([])
    expect(p.workers).toHaveLength(10)
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

  it('has the Lead send to workers that exist', () => {
    const p = plan(small)
    expect(p.lead.length).toBeGreaterThan(0)
    expect(p.lead.every(send => send.worker >= 0 && send.worker < p.workers.length)).toBe(true)
  })
})
