import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, priorFor, routingPolicySchema } from './routingPolicy.js'
import type { PriorsTable } from './benchmarkPriors/priors.js'

describe('routing policy', () => {
  it('ships a valid default that needs no setup', () => {
    expect(routingPolicySchema.parse(DEFAULT_ROUTING_POLICY)).toEqual(DEFAULT_ROUTING_POLICY)
    expect(DEFAULT_ROUTING_POLICY.floor).toEqual({ low: 1, medium: 2, high: 3 })
    expect(DEFAULT_ROUTING_POLICY.quotaReserve).toBe(10)
    expect(DEFAULT_ROUTING_POLICY.notes).toBe('')
    expect(new Set(DEFAULT_ROUTING_POLICY.models.map(m => m.engine))).toEqual(new Set(['claude', 'codex']))
  })

  it('offers Claude Opus at xhigh as its own row, dearer than at high for the extra thinking', () => {
    expect(DEFAULT_ROUTING_POLICY.models).toContainEqual({ engine: 'claude', model: 'opus', effort: 'xhigh', quality: 3, cost: 4, enabled: true })
  })

  // Ken, 2026-11-02: Sonnet at high effort is back for small work (2026-10-30 had turned it off).
  it('offers Sonnet at high effort in the default table', () => {
    const sonnet = (models: Array<{ engine: string; model: string; enabled: boolean }>) => models.filter(m => m.engine === 'claude' && m.model === 'sonnet')
    expect(sonnet(DEFAULT_ROUTING_POLICY.models)).toEqual([expect.objectContaining({ effort: 'high', quality: 2, enabled: true })])
    // Haiku too (review of #2314): an older CLI on the new server picked it for easy work the server refuses, on every route.
    expect(DEFAULT_ROUTING_POLICY.models.filter(m => m.model === 'haiku')).toEqual([expect.objectContaining({ quality: 1, enabled: false })])
    // Nothing it may pick is rated below 2 (an older CLI's own route still keeps its builds at 3).
    expect(DEFAULT_ROUTING_POLICY.models.filter(m => m.enabled).every(m => m.quality >= 2)).toBe(true)
  })

  // Lead's ruling, 10-30: the owners' standing decision is that Builders run on Opus high or Astra xhigh; with no row Astra rated
  // 1 and was never picked.
  it('ships Codex GPT-6-Astra at xhigh as a strong built-in row, dearer than Opus', () => {
    const astra = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6-astra')!
    expect(astra).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', quality: 3, cost: 5, enabled: true })
    const opusCosts = DEFAULT_ROUTING_POLICY.models.filter(m => m.model === 'opus').map(m => m.cost)
    expect(astra.cost).toBeGreaterThan(Math.max(...opusCosts))
  })

  it('rejects out-of-range values and unknown engines', () => {
    const bad = (patch: Record<string, unknown>) => routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, ...patch }).success
    expect(bad({ quotaReserve: 91 })).toBe(false)
    expect(bad({ notes: 'x'.repeat(501) })).toBe(false)
    expect(bad({ floor: { low: 0, medium: 2, high: 3 } })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], engine: 'cursor' }] })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], cost: 0 }] })).toBe(false)
    expect(bad({ models: [] })).toBe(false)
  })

  describe('owner override of a benchmark prior', () => {
    const src = 'https://example.org/board'
    const entry = (model: string, value: number, engine: 'claude' | 'grid' = 'claude') => ({ engine, model, names: [model], benchmarkNames: [model],
      scores: [{ benchmark: 'terminal-bench-4.0', score: value, harness: 'Claude Code', source: src, date: '2026-09-22', via: 'leaderboard' as const }] })
    const table: PriorsTable = { refreshed: '2026-10-29', note: 'Depends on the harness.', benchmarks: [{ id: 'terminal-bench-4.0', name: 'Terminal-Bench 4.0', url: src }],
      models: [entry('best', 80), entry('moonshotai/kimi-k3', 12, 'grid')] }
    const withOverrides = (priorOverrides: unknown) => routingPolicySchema.parse({ ...DEFAULT_ROUTING_POLICY, priorOverrides })

    it('uses the benchmark prior when the owner sets nothing, and says where it came from', () => {
      const prior = priorFor(DEFAULT_ROUTING_POLICY, { engine: 'grid', model: 'moonshotai/kimi-k3' }, 'cli', table)
      expect(prior?.quality).toBe(1)
      expect(prior?.source).toBe('benchmark')
    })

    it('lets the owner replace one prior: that model and kind only, matched by the words of its name', () => {
      const policy = withOverrides([{ model: 'kimi k3', kind: 'cli', quality: 3 }])
      expect(priorFor(policy, { engine: 'grid', model: 'moonshotai/kimi-k3' }, 'cli', table)).toEqual({ quality: 3, source: 'owner' })
      expect(priorFor(policy, { engine: 'grid', model: 'moonshotai/kimi-k3' }, 'backend', table)?.source).toBe('benchmark')
      expect(priorFor(policy, { engine: 'claude', model: 'best' }, 'cli', table)?.quality).toBe(3)
      expect(priorFor(policy, { engine: 'claude', model: 'best' }, 'cli', table)?.source).toBe('benchmark')
    })

    it('gives a model with no data an owner prior, and keeps first match first', () => {
      const policy = withOverrides([{ model: 'qwen 3', kind: 'tests', quality: 2 }, { model: 'qwen', kind: 'tests', quality: 1 }])
      expect(priorFor(policy, { engine: 'grid', model: 'qwen3:4b', label: 'Qwen 3 4B' }, 'tests', table)).toEqual({ quality: 2, source: 'owner' })
      expect(priorFor(policy, { engine: 'grid', model: 'qwen3:4b', label: 'Qwen 3 4B' }, 'docs', table)).toBeUndefined()
    })

    it('rejects a level outside 1-3, an unknown kind, an empty or oversized model name, more than 100 rows and unknown fields', () => {
      const bad = (rows: unknown) => routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, priorOverrides: rows }).success
      const ok = { model: 'kimi k3', kind: 'cli', quality: 2 }
      expect(bad([ok])).toBe(true)
      expect(bad([{ ...ok, quality: 4 }])).toBe(false)
      expect(bad([{ ...ok, quality: 0 }])).toBe(false)
      expect(bad([{ ...ok, kind: 'ui' }])).toBe(false)
      expect(bad([{ ...ok, model: ' ' }])).toBe(false)
      expect(bad([{ ...ok, model: 'x'.repeat(201) }])).toBe(false)
      expect(bad(Array.from({ length: 101 }, () => ok))).toBe(false)
      expect(bad([{ ...ok, note: 'because' }])).toBe(false)
    })
  })
})
