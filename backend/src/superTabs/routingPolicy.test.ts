import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, routingPolicySchema } from './routingPolicy.js'

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
})
