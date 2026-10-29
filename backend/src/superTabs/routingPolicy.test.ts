import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, gridQuality, routingOverrideSchema, routingPolicySchema } from './routingPolicy.js'

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
})
