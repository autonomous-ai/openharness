import { describe, expect, it } from 'vitest'
import { BENCHMARK_PRIORS } from './data.js'
import { KIND_WEIGHTS, JOB_KINDS, LEVEL_CUTS, loadPriors, priorLevel, type PriorsTable } from './priors.js'

const source = 'https://example.org/board'
const score = (benchmark: string, value: number) => ({ benchmark, score: value, harness: 'Claude Code', source, date: '2026-09-22', via: 'leaderboard' as const })
const row = (model: string, names: string[], scores: PriorsTable['models'][number]['scores'], engine: 'claude' | 'codex' | 'grid' = 'claude') =>
  ({ engine, model, names, benchmarkNames: names, scores })

/** Hand-made board: terminal-bench best is 80, swe-bench best is 60, aider has only `strong` (50). */
const table: PriorsTable = {
  refreshed: '2026-10-29',
  note: 'Benchmark numbers depend on the harness that ran them.',
  benchmarks: [
    { id: 'terminal-bench-4.0', name: 'Terminal-Bench 4.0', url: source },
    { id: 'swe-bench-verified', name: 'SWE-bench Verified', url: source },
    { id: 'aider-polyglot', name: 'Aider polyglot', url: source },
  ],
  models: [
    row('strong', ['strong', 'big'], [score('terminal-bench-4.0', 80), score('swe-bench-verified', 60), score('aider-polyglot', 50)]),
    row('middle', ['middle'], [score('terminal-bench-4.0', 52), score('swe-bench-verified', 36)]),
    row('weak', ['weak'], [score('terminal-bench-4.0', 8)], 'grid'),
    row('blank', ['blank'], []),
  ],
}

describe('quality levels from a benchmark', () => {
  it('cuts at 85% and 55% of the best routed score on the same benchmark', () => {
    expect(LEVEL_CUTS).toEqual({ three: 0.85, two: 0.55 })
    // terminal-bench: 80 → 1.0; 52 → 0.65; 8 → 0.1; swe-bench only terminal-bench weight is checked via the cli kind below
    expect(priorLevel(table, 'claude', 'strong', 'cli')?.quality).toBe(3)
    expect(priorLevel(table, 'claude', 'middle', 'cli')?.quality).toBe(2)
    expect(priorLevel(table, 'grid', 'weak', 'cli')?.quality).toBe(1)
  })

  it('is exactly at the cut: 68 of 80 is 0.85 and counts as 3, 44 of 80 is 0.55 and counts as 2', () => {
    const edge: PriorsTable = { ...table, models: [...table.models, row('edge-high', ['edge-high'], [score('terminal-bench-4.0', 68)]), row('edge-low', ['edge-low'], [score('terminal-bench-4.0', 44)]), row('under', ['under'], [score('terminal-bench-4.0', 43.9)])] }
    expect(priorLevel(edge, 'claude', 'edge-high', 'cli')?.quality).toBe(3)
    expect(priorLevel(edge, 'claude', 'edge-low', 'cli')?.quality).toBe(2)
    expect(priorLevel(edge, 'claude', 'under', 'cli')?.quality).toBe(1)
  })

  it('weighs the benchmarks of a kind and renormalises over the ones a model has', () => {
    // backend: swe-bench 0.5, aider 0.2, terminal-bench 0.3. `middle` has no aider score: (0.5*0.6 + 0.3*0.65) / 0.8 = 0.61875 → 2.
    expect(KIND_WEIGHTS.backend).toEqual({ 'swe-bench-verified': 0.5, 'aider-polyglot': 0.2, 'terminal-bench-4.0': 0.3 })
    const middle = priorLevel(table, 'claude', 'middle', 'backend')
    expect(middle?.quality).toBe(2)
    expect(middle?.ratio).toBeCloseTo(0.61875, 5)
    // `weak` has only terminal-bench: ratio 0.1 → 1.
    expect(priorLevel(table, 'grid', 'weak', 'backend')?.ratio).toBeCloseTo(0.1, 5)
  })

  it('names the sources it used, each with its harness and date', () => {
    const level = priorLevel(table, 'claude', 'middle', 'backend')!
    expect(level.sources).toEqual([
      { benchmark: 'swe-bench-verified', score: 36, harness: 'Claude Code', source, date: '2026-09-22' },
      { benchmark: 'terminal-bench-4.0', score: 52, harness: 'Claude Code', source, date: '2026-09-22' },
    ])
  })

  it('has no prior for a model with no data, for security and review (no benchmark measures them), or for an unknown model', () => {
    expect(priorLevel(table, 'claude', 'blank', 'backend')).toBeUndefined()
    expect(priorLevel(table, 'claude', 'strong', 'security')).toBeUndefined()
    expect(priorLevel(table, 'claude', 'strong', 'review')).toBeUndefined()
    expect(priorLevel(table, 'claude', 'nobody', 'backend')).toBeUndefined()
    expect(KIND_WEIGHTS.security).toBeNull()
    expect(KIND_WEIGHTS.review).toBeNull()
  })

  it('covers every job kind once', () => {
    expect([...JOB_KINDS]).toEqual(['docs', 'tests', 'backend', 'cli', 'desktop', 'mobile', 'security', 'review', 'general'])
    expect(Object.keys(KIND_WEIGHTS).sort()).toEqual([...JOB_KINDS].sort())
    for (const weights of Object.values(KIND_WEIGHTS)) if (weights) expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
  })

  it('matches our model by engine and name: dated release, alias, case and punctuation, not another engine', () => {
    expect(priorLevel(table, 'claude', 'strong-20261001', 'cli')?.quality).toBe(3)
    expect(priorLevel(table, 'claude', 'Big', 'cli')?.quality).toBe(3)
    expect(priorLevel(table, 'grid', 'strong', 'cli')).toBeUndefined()
    expect(priorLevel(table, 'codex', 'strong', 'cli')).toBeUndefined()
  })
})

describe('the checked-in table', () => {
  it('covers every model the Swarm routes today with sources, or says it has no data', () => {
    const routed: Array<[string, string]> = [
      ['claude', 'claude-opus-5-5'], ['claude', 'claude-sonnet-5-5'], ['claude', 'claude-haiku-5-5'], ['claude', 'claude-fable-5-1'],
      ['codex', 'gpt-6.1-sol'], ['grid', 'moonshotai/kimi-k3'], ['grid', 'deepseek/deepseek-v4.1-flash-1017'], ['grid', 'qwen3:4b'],
    ]
    for (const [engine, name] of routed) {
      const entry = BENCHMARK_PRIORS.models.find(m => m.engine === engine && m.model === name)
      expect(entry, `${engine} ${name} is in the table`).toBeDefined()
      expect(entry!.scores.length > 0 || !!entry!.noData, `${name} has sources or a no-data reason`).toBe(true)
    }
  })

  it('passes its own schema, links every score to an https source with a date and a harness, and states the harness caveat', () => {
    expect(loadPriors(BENCHMARK_PRIORS).warnings).toEqual([])
    expect(BENCHMARK_PRIORS.note.toLowerCase()).toContain('harness')
    for (const m of BENCHMARK_PRIORS.models) for (const s of m.scores) {
      expect(s.source).toMatch(/^https:\/\//)
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.harness.length).toBeGreaterThan(0)
      expect(BENCHMARK_PRIORS.benchmarks.some(b => b.id === s.benchmark)).toBe(true)
    }
  })

  it('keeps the hand rating for a model with no data: Haiku and the small grid model have no prior', () => {
    expect(priorLevel(BENCHMARK_PRIORS, 'claude', 'claude-haiku-5-5', 'backend')).toBeUndefined()
    expect(priorLevel(BENCHMARK_PRIORS, 'grid', 'qwen3:4b', 'backend')).toBeUndefined()
  })
})

describe('loading the table', () => {
  it('refuses a corrupt table with a warning and no priors, never a partial one', () => {
    const bad = loadPriors({ ...table, models: [{ ...table.models[0], scores: [{ ...table.models[0].scores[0], score: 'high' }] }] })
    expect(bad.warnings).toEqual(['The benchmark priors table is unreadable; no benchmark priors apply.'])
    expect(bad.table.models).toEqual([])
    expect(priorLevel(bad.table, 'claude', 'strong', 'cli')).toBeUndefined()
    expect(loadPriors(null).table.models).toEqual([])
  })

  it('rejects a score that names no listed benchmark, a non-https source, a bad date, and any unknown field', () => {
    const withScore = (patch: Record<string, unknown>) => loadPriors({ ...table, models: [{ ...table.models[0], scores: [{ ...table.models[0].scores[0], ...patch }] }] }).warnings.length
    expect(withScore({})).toBe(0)
    expect(withScore({ benchmark: 'made-up' })).toBe(1)
    expect(withScore({ source: 'http://example.org' })).toBe(1)
    expect(withScore({ date: 'Sep 22' })).toBe(1)
    expect(withScore({ taskText: 'fix the login bug' })).toBe(1)
    expect(withScore({ score: -1 })).toBe(1)
    expect(withScore({ score: 101 })).toBe(1)
  })
})
