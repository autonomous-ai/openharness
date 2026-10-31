import { describe, expect, it } from 'vitest'
import { catalogRead, MODEL_CATALOG } from './catalog.js'
import { DEFAULT_ROUTING_POLICY } from './routingPolicy.js'
import { BENCHMARK_PRIORS } from './benchmarkPriors/data.js'
import { PRICES } from './costs/prices.js'

const NOT_OFFERED = 'Not offered by default: no Engineer runs on Claude Sonnet or Claude Haiku (Ken and Dee, 2026-10-30).'

describe('the model catalog', () => {
  it('lists today\'s models with their strength', () => {
    expect(MODEL_CATALOG.models).toEqual([
      { engine: 'claude', model: 'opus', effort: 'high', strength: 3, cost: 3, offered: true },
      { engine: 'claude', model: 'opus', effort: 'xhigh', strength: 3, cost: 4, offered: true },
      { engine: 'codex', model: 'default', effort: 'default', strength: 3, cost: 2, offered: true },
      { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', strength: 3, cost: 2, offered: true },
      { engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', strength: 3, cost: 5, offered: true },
      { engine: 'claude', model: 'sonnet', effort: 'medium', strength: 2, cost: 2, offered: false, note: NOT_OFFERED },
      { engine: 'claude', model: 'haiku', effort: 'auto', strength: 1, cost: 1, offered: false, note: NOT_OFFERED },
    ])
    expect(MODEL_CATALOG.models.filter(m => m.offered).every(m => m.strength === 3)).toBe(true)
    expect(MODEL_CATALOG.grid).toEqual({ strength: 1, models: [{ model: 'kimi k3', strength: 2 }, { model: 'deepseek v4.1', strength: 2 }] })
  })

  it('gives older CLIs the same rows as a policy', () => {
    expect(DEFAULT_ROUTING_POLICY.models).toEqual(MODEL_CATALOG.models.map(m =>
      ({ engine: m.engine, model: m.model, effort: m.effort, quality: m.strength, cost: m.cost, enabled: m.offered })))
    expect(DEFAULT_ROUTING_POLICY.localModels).toEqual({ quality: 1, enabled: true,
      models: MODEL_CATALOG.grid.models.map(r => ({ model: r.model, quality: r.strength })) })
    expect(DEFAULT_ROUTING_POLICY).toMatchObject({ version: 1, floor: { low: 1, medium: 2, high: 3 }, quotaReserve: 10, notes: '' })
  })

  it('serves the catalog with the benchmark priors and the prices in one read', () => {
    expect(catalogRead()).toEqual({ models: MODEL_CATALOG.models, grid: MODEL_CATALOG.grid, priors: BENCHMARK_PRIORS, prices: PRICES })
    expect(catalogRead().prices.map(p => p.model)).toContain('claude-opus-5-5')
  })
})
