import { describe, expect, it } from 'vitest'
import { BENCHMARK_PRIORS } from './data.js'
import { priorsSchema, type PriorsTable } from './priors.js'

const source = 'https://example.org/board'
const table: PriorsTable = {
  refreshed: '2026-10-29',
  note: 'Benchmark numbers depend on the harness that ran them.',
  benchmarks: [{ id: 'terminal-bench-4.0', name: 'Terminal-Bench 4.0', url: source }],
  models: [{ engine: 'claude', model: 'strong', names: ['strong'], benchmarkNames: ['strong'],
    scores: [{ benchmark: 'terminal-bench-4.0', score: 80, harness: 'Claude Code', source, date: '2026-09-22', via: 'leaderboard' }] }],
}

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
    expect(priorsSchema.safeParse(BENCHMARK_PRIORS).success).toBe(true)
    expect(BENCHMARK_PRIORS.note.toLowerCase()).toContain('harness')
    for (const m of BENCHMARK_PRIORS.models) for (const s of m.scores) {
      expect(s.source).toMatch(/^https:\/\//)
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.harness.length).toBeGreaterThan(0)
      expect(BENCHMARK_PRIORS.benchmarks.some(b => b.id === s.benchmark)).toBe(true)
    }
  })
})

describe('the table schema', () => {
  it('rejects a score that names no listed benchmark, a non-https source, a bad date, and any unknown field', () => {
    const withScore = (patch: Record<string, unknown>) =>
      priorsSchema.safeParse({ ...table, models: [{ ...table.models[0], scores: [{ ...table.models[0]!.scores[0], ...patch }] }] }).success
    expect(withScore({})).toBe(true)
    expect(withScore({ benchmark: 'made-up' })).toBe(false)
    expect(withScore({ source: 'http://example.org' })).toBe(false)
    expect(withScore({ date: 'Sep 22' })).toBe(false)
    expect(withScore({ taskText: 'fix the login bug' })).toBe(false)
    expect(withScore({ score: -1 })).toBe(false)
    expect(withScore({ score: 101 })).toBe(false)
    expect(withScore({ score: 'high' })).toBe(false)
  })
})
