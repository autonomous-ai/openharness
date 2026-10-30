import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, gridQuality, priorFor, routingOverrideSchema, routingPolicySchema } from './routingPolicy.js'
import type { PriorsTable } from './benchmarkPriors/priors.js'

describe('routing policy', () => {
  it('ships a valid default that needs no setup', () => {
    expect(routingPolicySchema.parse(DEFAULT_ROUTING_POLICY)).toEqual(DEFAULT_ROUTING_POLICY)
    expect(DEFAULT_ROUTING_POLICY.floor).toEqual({ low: 1, medium: 2, high: 3 })
    expect(DEFAULT_ROUTING_POLICY.quotaReserve).toBe(10)
    expect(DEFAULT_ROUTING_POLICY.notes).toBe('')
    expect(new Set(DEFAULT_ROUTING_POLICY.models.map(m => m.engine))).toEqual(new Set(['claude', 'codex']))
  })

  it('uses the default when the account has none, and merges a tab override field by field', () => {
    expect(effectivePolicy(null, null)).toEqual({ policy: DEFAULT_ROUTING_POLICY, warnings: [], overridden: [] })
    const account = { ...DEFAULT_ROUTING_POLICY, quotaReserve: 20, notes: 'Frontend prefers Claude.' }
    const result = effectivePolicy(account, { notes: 'Long jobs on remote-1.' })
    expect(result.policy.quotaReserve).toBe(20)
    expect(result.policy.notes).toBe('Long jobs on remote-1.')
    expect(result.overridden).toEqual(['notes'])
    expect(result.warnings).toEqual([])
  })

  it('reads a policy saved at the 40-row limit with the added rows, and saves and reads it back after an edit', () => {
    // Review of #2271: rows added on read must not push an owner's full policy past what saving accepts.
    const owner = Array.from({ length: 40 }, (_, i) => ({ engine: 'claude' as const, model: `model-${i}`, effort: 'high', quality: 2, cost: 2, enabled: true }))
    const read = effectivePolicy({ ...DEFAULT_ROUTING_POLICY, models: owner }, null).policy
    expect(read.models).toHaveLength(41)
    expect(read.models.slice(0, 40)).toEqual(owner)
    const saved = routingPolicySchema.parse({ ...read, notes: 'Edited.' })
    expect(saved.models).toEqual(read.models)
    expect(effectivePolicy(saved, null).policy.models).toEqual(read.models)
    // The limit grows by the added rows alone: an owner's own 41st row is still refused.
    expect(routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, models: [...owner, { ...owner[0]!, model: 'model-40' }, { ...owner[0]!, model: 'model-41' }] }).success).toBe(false)
  })

  it('falls back to the default with a warning for a corrupt account policy or override', () => {
    const corrupt = effectivePolicy({ version: 9 }, { floor: { low: 7 } })
    expect(corrupt.policy).toEqual(DEFAULT_ROUTING_POLICY)
    expect(corrupt.warnings).toEqual([
      'The account routing policy is unreadable; the built-in default applies.',
      'This Super Tab routing override is unreadable and was ignored.',
    ])
  })

  it('rejects out-of-range values and unknown engines', () => {
    const bad = (patch: Record<string, unknown>) => routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, ...patch }).success
    expect(bad({ quotaReserve: 91 })).toBe(false)
    expect(bad({ notes: 'x'.repeat(501) })).toBe(false)
    expect(bad({ floor: { low: 0, medium: 2, high: 3 } })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], engine: 'cursor' }] })).toBe(false)
    expect(bad({ models: [{ ...DEFAULT_ROUTING_POLICY.models[0], cost: 0 }] })).toBe(false)
    expect(bad({ models: [] })).toBe(false)
    expect(routingOverrideSchema.safeParse({ version: 1 }).success).toBe(false)
  })

  it('rates Kimi K3 and DeepSeek v4.1 at Sonnet\'s tier and every other grid model at the local quality, from the policy', () => {
    const { policy } = effectivePolicy(null, null)
    expect(gridQuality(policy, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridQuality(policy, 'deepseek/deepseek-v4.1-flash-1017', 'deepseek/deepseek-v4.1-flash-1017 · OpenRouter')).toBe(2)
    expect(gridQuality(policy, 'qwen3:4b', 'Qwen 3 4B')).toBe(1)
    // A policy saved before per-model rows reads the built-in ones; the owner's own rows replace them, first match first.
    const saved = { ...DEFAULT_ROUTING_POLICY, localModels: { quality: 1, enabled: true } }
    expect(gridQuality(effectivePolicy(saved, null).policy, 'moonshotai/kimi-k3')).toBe(2)
    const owner = effectivePolicy(saved, { localModels: { quality: 2, enabled: true, models: [{ model: 'qwen 3', quality: 3 }, { model: 'qwen', quality: 1 }] } }).policy
    expect(gridQuality(owner, 'qwen3:4b', 'Qwen 3 4B')).toBe(3)
    expect(gridQuality(owner, 'moonshotai/kimi-k3')).toBe(2)
    expect(gridQuality({ ...owner, localModels: { quality: 1, enabled: true, models: [] } }, 'moonshotai/kimi-k3')).toBe(1)
    expect(routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, localModels: { quality: 1, enabled: true, models: [{ model: 'x', quality: 4 }] } }).success).toBe(false)
  })

  describe('owner override of a benchmark prior', () => {
    const src = 'https://example.org/board'
    const entry = (model: string, value: number, engine: 'claude' | 'grid' = 'claude') => ({ engine, model, names: [model], benchmarkNames: [model],
      scores: [{ benchmark: 'terminal-bench-4.0', score: value, harness: 'Claude Code', source: src, date: '2026-09-22', via: 'leaderboard' as const }] })
    const table: PriorsTable = { refreshed: '2026-10-29', note: 'Depends on the harness.', benchmarks: [{ id: 'terminal-bench-4.0', name: 'Terminal-Bench 4.0', url: src }],
      models: [entry('best', 80), entry('moonshotai/kimi-k3', 12, 'grid')] }
    const withOverrides = (priorOverrides: unknown) => effectivePolicy({ ...DEFAULT_ROUTING_POLICY, priorOverrides }, null).policy

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

    it('reads a policy saved before overrides as having none', () => {
      expect(routingPolicySchema.safeParse(DEFAULT_ROUTING_POLICY).success).toBe(true)
      expect(priorFor(effectivePolicy(null, null).policy, { engine: 'claude', model: 'best' }, 'cli', table)?.source).toBe('benchmark')
    })

    it('replaces the account list with the tab override, and one policy never reads another policy\'s rows', () => {
      const account = { ...DEFAULT_ROUTING_POLICY, priorOverrides: [{ model: 'best', kind: 'cli', quality: 1 }] }
      const tab = effectivePolicy(account, { priorOverrides: [{ model: 'best', kind: 'cli', quality: 2 }] }).policy
      const other = effectivePolicy(null, null).policy
      expect(priorFor(tab, { engine: 'claude', model: 'best' }, 'cli', table)?.quality).toBe(2)
      expect(priorFor(effectivePolicy(account, null).policy, { engine: 'claude', model: 'best' }, 'cli', table)?.quality).toBe(1)
      expect(priorFor(other, { engine: 'claude', model: 'best' }, 'cli', table)?.quality).toBe(3)
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
      expect(routingOverrideSchema.safeParse({ priorOverrides: [ok] }).success).toBe(true)
    })

    it('falls back to the default with a warning when the saved overrides are corrupt', () => {
      const corrupt = effectivePolicy({ ...DEFAULT_ROUTING_POLICY, priorOverrides: [{ model: 'x', kind: 'cli', quality: 9 }] }, null)
      expect(corrupt.policy).toEqual(DEFAULT_ROUTING_POLICY)
      expect(corrupt.warnings).toEqual(['The account routing policy is unreadable; the built-in default applies.'])
    })
  })
})
