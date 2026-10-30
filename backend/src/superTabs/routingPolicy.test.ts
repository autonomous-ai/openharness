import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTING_POLICY, effectivePolicy, gridQuality, priorFor, routingOverrideSaveSchema, routingOverrideSchema, routingPolicySaveSchema, routingPolicySchema } from './routingPolicy.js'
import type { PriorsTable } from './benchmarkPriors/priors.js'
import { startTarget, targetQuality } from './rules.js'

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

  // Ken, 2026-10-30: no Sonnet Builders. Only the default table changes; an owner's own table is theirs (Lead's ruling).
  it('turns Sonnet off in the default table, and keeps an owner\'s saved Sonnet row and a tab override\'s as they are', () => {
    const sonnet = (models: Array<{ engine: string; model: string; enabled: boolean }>) => models.filter(m => m.engine === 'claude' && m.model === 'sonnet')
    expect(sonnet(DEFAULT_ROUTING_POLICY.models)).toEqual([expect.objectContaining({ effort: 'medium', quality: 2, enabled: false })])
    expect(sonnet(effectivePolicy(null, null).policy.models).map(m => m.enabled)).toEqual([false])
    // An owner who saved the table before keeps Sonnet on; it is their row.
    const saved = { ...DEFAULT_ROUTING_POLICY, models: DEFAULT_ROUTING_POLICY.models.map(m => m.model === 'sonnet' ? { ...m, enabled: true } : m) }
    const read = effectivePolicy(saved, null)
    expect(read.warnings).toEqual([])
    expect(sonnet(read.policy.models).map(m => m.enabled)).toEqual([true])
    expect(read.policy.models.filter(m => m.model !== 'sonnet')).toEqual(saved.models.filter(m => m.model !== 'sonnet'))
    // A tab override's own models win over the default too.
    expect(sonnet(effectivePolicy(null, { models: saved.models }).policy.models).map(m => m.enabled)).toEqual([true])
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
    expect(read.models).toHaveLength(42)
    expect(read.models.slice(0, 40)).toEqual(owner)
    const saved = routingPolicySchema.parse({ ...read, notes: 'Edited.' })
    expect(saved.models).toEqual(read.models)
    expect(effectivePolicy(saved, null).policy.models).toEqual(read.models)
  })

  it('keeps the owner\'s limit at exactly 40 rows of their own, whatever built-in rows are added on read', () => {
    const own = (n: number) => Array.from({ length: n }, (_, i) => ({ engine: 'claude' as const, model: `model-${i}`, effort: 'high', quality: 2, cost: 2, enabled: true }))
    const parses = (models: unknown[]) => routingPolicySchema.safeParse({ ...DEFAULT_ROUTING_POLICY, models }).success
    expect(parses(own(40))).toBe(true)
    expect(parses(own(41))).toBe(false)
    const sol = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6.1-sol')!
    expect(parses([...own(40), sol])).toBe(true)
    // The owner's own version of a built-in row takes its place, not one of their 40.
    expect(parses([...own(40), { ...sol, enabled: false }])).toBe(true)
    expect(parses([...own(41), sol])).toBe(false)
    // Both built-in rows ride free of the 40, Astra's as Sol's.
    const astra = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6-astra')!
    expect(parses([...own(40), sol, astra])).toBe(true)
    expect(parses([...own(40), sol, { ...astra, quality: 2 }])).toBe(true)
    expect(routingPolicySaveSchema.safeParse({ ...DEFAULT_ROUTING_POLICY, models: [...own(40), sol, astra] }).success).toBe(true)
    expect(routingPolicySaveSchema.safeParse({ ...DEFAULT_ROUTING_POLICY, models: [...own(40), sol, astra, astra] }).success).toBe(false)
  })

  // Lead's ruling, 10-30: the owners' standing decision is that Builders run on Opus high or Astra xhigh; with no row Astra rated
  // 1 and was never picked.
  it('ships Codex GPT-6-Astra at xhigh as a strong built-in row, dearer than Opus, and keeps an owner\'s own Astra row', () => {
    const astra = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6-astra')!
    expect(astra).toEqual({ engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh', quality: 3, cost: 5, enabled: true })
    const opusCosts = DEFAULT_ROUTING_POLICY.models.filter(m => m.model === 'opus').map(m => m.cost)
    expect(astra.cost).toBeGreaterThan(Math.max(...opusCosts))
    // A policy saved before the row reads it.
    const before = { ...DEFAULT_ROUTING_POLICY, models: DEFAULT_ROUTING_POLICY.models.filter(m => m.model !== 'gpt-6-astra') }
    expect(effectivePolicy(before, null).policy.models.filter(m => m.model === 'gpt-6-astra')).toEqual([astra])
    // An owner's own Astra row wins over the built-in one, on or off, and is never doubled (review of #2271).
    const owned = { ...before, models: [...before.models, { ...astra, effort: 'high', quality: 2, cost: 9, enabled: false }] }
    expect(effectivePolicy(owned, null).policy.models.filter(m => m.model === 'gpt-6-astra')).toEqual([{ ...astra, effort: 'high', quality: 2, cost: 9, enabled: false }])
  })

  it('rates a start or agent on Astra at the top tier on the server, as the CLI\'s route does (cli route.ts rateFor)', () => {
    const on = (effort: string) => targetQuality(DEFAULT_ROUTING_POLICY, startTarget({ machineId: 'm', engine: 'codex', model: 'gpt-6-astra', effort }))
    expect(on('xhigh')).toBe(3)
    expect(on('high')).toBe(3)
    const before = { ...DEFAULT_ROUTING_POLICY, models: DEFAULT_ROUTING_POLICY.models.filter(m => m.model !== 'gpt-6-astra') }
    expect(targetQuality(before, startTarget({ machineId: 'm', engine: 'codex', model: 'gpt-6-astra', effort: 'xhigh' }))).toBe(1)
  })

  describe('a built-in row added on read (review of #2271 at 1d9499646)', () => {
    const sol = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6.1-sol')!
    const codexDefault = DEFAULT_ROUTING_POLICY.models.find(m => m.engine === 'codex' && m.model === 'default')!
    const claudeRows = DEFAULT_ROUTING_POLICY.models.filter(m => m.engine === 'claude')
    const solOf = (models: Array<{ engine: string; model: string; enabled: boolean }>) => models.find(m => m.model === 'gpt-6.1-sol')

    it('is on only while its engine\'s default row is on, so an owner who turned Codex off keeps it off', () => {
      const off = effectivePolicy({ ...DEFAULT_ROUTING_POLICY, models: [...claudeRows, { ...codexDefault, enabled: false }] }, null)
      expect(solOf(off.policy.models)).toEqual({ ...sol, enabled: false })
      const absent = effectivePolicy({ ...DEFAULT_ROUTING_POLICY, models: claudeRows }, null)
      expect(solOf(absent.policy.models)).toEqual({ ...sol, enabled: false })
      const on = effectivePolicy({ ...DEFAULT_ROUTING_POLICY, models: [...claudeRows, codexDefault] }, null)
      expect(solOf(on.policy.models)).toEqual(sol)
      // A tab override without the row and with Codex off, over no saved account policy.
      const tab = effectivePolicy(null, { models: [...claudeRows, { ...codexDefault, enabled: false }] })
      expect(solOf(tab.policy.models)).toEqual({ ...sol, enabled: false })
    })

    it('comes from the account policy when a tab override saved without it', () => {
      const account = { ...DEFAULT_ROUTING_POLICY, models: [...claudeRows, codexDefault, { ...sol, enabled: false, quality: 2 }] }
      const tab = effectivePolicy(account, { models: [...claudeRows, codexDefault] })
      expect(solOf(tab.policy.models)).toEqual({ ...sol, enabled: false, quality: 2 })
      // The account's row on, but this tab turned Codex off: it stays off here.
      const accountOn = { ...DEFAULT_ROUTING_POLICY, models: [...claudeRows, codexDefault, sol] }
      const codexOff = effectivePolicy(accountOn, { models: [...claudeRows, { ...codexDefault, enabled: false }] })
      expect(solOf(codexOff.policy.models)).toEqual({ ...sol, enabled: false })
      expect(solOf(effectivePolicy(accountOn, { models: [...claudeRows, codexDefault] }).policy.models)).toEqual(sol)
    })
  })

  it('counts a second row for a built-in model against the 40 when saving, and still reads an old policy saved with one', () => {
    // Review of #2271: a second copy never rides free. Review of #2314: an owner with two Astra rows (two efforts, from before
    // Astra was built in) must still save.
    const own = (n: number) => Array.from({ length: n }, (_, i) => ({ engine: 'claude' as const, model: `model-${i}`, effort: 'high', quality: 2, cost: 2, enabled: true }))
    const sol = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6.1-sol')!
    const astra = DEFAULT_ROUTING_POLICY.models.find(m => m.model === 'gpt-6-astra')!
    const saves = (models: unknown[]) => routingPolicySaveSchema.safeParse({ ...DEFAULT_ROUTING_POLICY, models }).success
    expect(saves([...own(10), sol, astra, { ...astra, effort: 'high', quality: 2 }])).toBe(true)
    expect(saves([...own(39), sol, astra, { ...astra, effort: 'high' }])).toBe(true)
    const twice = { ...DEFAULT_ROUTING_POLICY, models: [...own(40), sol, { ...sol, enabled: false }] }
    const refused = routingPolicySaveSchema.safeParse(twice)
    expect(refused.success).toBe(false)
    expect(refused.error?.issues.map(i => i.message)).toEqual(['At most 40 rows of your own.'])
    expect(routingOverrideSaveSchema.safeParse({ models: twice.models }).success).toBe(false)
    expect(saves([...own(40), sol, astra])).toBe(true)
    // Saved before this count: still read as saved, never as unreadable; the Astra row joins it, off with Codex off.
    expect(effectivePolicy(twice, null)).toEqual({ policy: { ...twice, models: [...twice.models, { ...astra, enabled: false }] }, warnings: [], overridden: [] })
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
