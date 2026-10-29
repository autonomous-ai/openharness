import { describe, expect, it } from 'vitest'
import { applyBoards, parseAider, parseSweBench, parseTerminalBench, renderData, type Board, type BoardRow } from './refresh.js'
import { loadPriors, type PriorsTable } from './priors.js'

const TB = 'https://www.tbench.ai/leaderboard'
const tbRow = (model: string, agent: string, accuracy: number, date: string, effort: string) => ({
  rank: 1,
  metadata: { date, model_display: { label: model, url: 'https://x.test' }, agent_display: { label: agent, url: 'https://x.test' }, reasoning_effort: effort },
  metrics: { accuracy, n_trials: 330 },
})
/** The leaderboard page embeds its data as a JSON string inside a script, so every quote is escaped. */
const tbPage = (title: string, rows: unknown[]) =>
  `<html><script>self.__next_f.push([1,"${JSON.stringify({ leaderboard: { title }, rows }).replace(/"/g, '\\"')}"])</script></html>`

describe('Terminal-Bench page', () => {
  it('reads each row: model, harness with its effort, accuracy and release date', () => {
    const page = tbPage('Terminal-Bench 4.0', [tbRow('Opus 5.5', 'Claude Code', 64.85, '2026-09-22', 'max'), tbRow('GPT-6.1 Sol', 'Codex', 58.18, '2026-09-29', 'max')])
    expect(parseTerminalBench(page)).toEqual({ benchmark: 'terminal-bench-4.0', source: TB, rows: [
      { benchmarkName: 'Opus 5.5', score: 64.85, harness: 'Claude Code, max effort', date: '2026-09-22' },
      { benchmarkName: 'GPT-6.1 Sol', score: 58.18, harness: 'Codex, max effort', date: '2026-09-29' },
    ] })
  })

  it('refuses a page of another Terminal-Bench version, or with no rows, instead of labelling it 4.0', () => {
    expect(() => parseTerminalBench(tbPage('Terminal-Bench 5.0', [tbRow('Opus 5.5', 'Claude Code', 70, '2026-10-01', 'max')]))).toThrow('Terminal-Bench 4.0')
    expect(() => parseTerminalBench(tbPage('Terminal-Bench 4.0', []))).toThrow('no rows')
    expect(() => parseTerminalBench('<html>maintenance</html>')).toThrow('no rows')
  })

  it('refuses a row whose accuracy is not a number', () => {
    expect(() => parseTerminalBench(tbPage('Terminal-Bench 4.0', [tbRow('Opus 5.5', 'Claude Code', 'n/a' as unknown as number, '2026-09-22', 'max')]))).toThrow('accuracy')
  })
})

describe('SWE-bench Verified file', () => {
  const entry = (patch: Record<string, unknown>) => ({ agent: 'mini-SWE-agent', name: 'Claude 4.5 Opus (high)', resolved: 76.8, date: '2026-02-17', tags: ['Model: claude-4-5-opus', 'Org: Anthropic'], ...patch })
  const file = (verified: unknown[]) => ({ leaderboards: [{ name: 'Lite', results: [entry({ resolved: 99 })] }, { name: 'Verified', results: verified }] })

  it('reads the Verified board only, one row per entry that runs a single model, with its agent as the harness', () => {
    expect(parseSweBench(file([entry({}), entry({ tags: ['Model: claude-sonnet-4-5', 'Model: gpt-5'], resolved: 74 })]))).toEqual({
      benchmark: 'swe-bench-verified', source: 'https://www.swebench.com',
      rows: [{ benchmarkName: 'claude-4-5-opus', score: 76.8, harness: 'mini-SWE-agent', date: '2026-02-17' }],
    })
  })

  it('refuses a file with no Verified board', () => {
    expect(() => parseSweBench({ leaderboards: [] })).toThrow('Verified')
    expect(() => parseSweBench(null)).toThrow('Verified')
  })
})

describe('Aider polyglot file', () => {
  const yaml = `- dirname: 2025-05-01--a
  test_cases: 225
  model: gpt-5 (high)
  edit_format: diff
  pass_rate_2: 88.0
  date: 2025-09-01
  versions: 0.86.2

- dirname: 2025-05-02--b
  model: Kimi K2
  edit_format: diff
  pass_rate_2: 59.1
  date: 2025-07-12
`

  it('reads model, second-try pass rate, date and the edit format as the harness', () => {
    expect(parseAider(yaml)).toEqual({ benchmark: 'aider-polyglot', source: 'https://aider.chat/docs/leaderboards/', rows: [
      { benchmarkName: 'gpt-5 (high)', score: 88, harness: 'aider, diff edit format', date: '2025-09-01' },
      { benchmarkName: 'Kimi K2', score: 59.1, harness: 'aider, diff edit format', date: '2025-07-12' },
    ] })
  })

  it('refuses a file with no entries', () => {
    expect(() => parseAider('')).toThrow('no entries')
  })
})

describe('applying boards to the table', () => {
  const src = 'https://example.org/old'
  const base: PriorsTable = {
    refreshed: '2026-10-01',
    note: 'Depends on the harness.',
    benchmarks: [{ id: 'terminal-bench-4.0', name: 'Terminal-Bench 4.0', url: TB }, { id: 'aider-polyglot', name: 'Aider polyglot', url: 'https://aider.chat/docs/leaderboards/' }],
    models: [
      { engine: 'claude', model: 'claude-opus-5-5', names: ['opus'], benchmarkNames: ['Opus 5.5'], scores: [
        { benchmark: 'terminal-bench-4.0', score: 1, harness: 'Claude Code', source: src, date: '2026-09-01', via: 'leaderboard' },
        { benchmark: 'aider-polyglot', score: 70, harness: 'aider', source: src, date: '2026-09-01', via: 'leaderboard' }] },
      { engine: 'grid', model: 'moonshotai/kimi-k3', names: [], benchmarkNames: ['Kimi K3'], scores: [
        { benchmark: 'terminal-bench-4.0', score: 12.6, harness: 'Claude Code', source: 'https://huggingface.co/deepseek-ai/x', date: '2026-10-17', via: 'model-card' }] },
      { engine: 'claude', model: 'claude-haiku-5-5', names: ['haiku'], benchmarkNames: ['Haiku 5.5'], scores: [], noData: 'On no board yet.' },
    ],
  }
  const tb = (rows: BoardRow[]): Board => ({ benchmark: 'terminal-bench-4.0', source: TB, rows })

  it('replaces a model\'s leaderboard scores with the best row of its benchmark name, keeping the harness of that row', () => {
    const { table, warnings } = applyBoards(base, [tb([
      { benchmarkName: 'Opus 5.5', score: 60, harness: 'Claude Code, high effort', date: '2026-09-22' },
      { benchmarkName: 'Opus 5.5', score: 64.85, harness: 'Claude Code, max effort', date: '2026-09-23' },
      { benchmarkName: 'Someone Else', score: 99, harness: 'Other', date: '2026-09-23' },
    ])], '2026-10-29')
    expect(warnings).toEqual([])
    expect(table.refreshed).toBe('2026-10-29')
    expect(table.models[0].scores).toEqual([
      { benchmark: 'terminal-bench-4.0', score: 64.85, harness: 'Claude Code, max effort', source: TB, date: '2026-09-23', via: 'leaderboard' },
      { benchmark: 'aider-polyglot', score: 70, harness: 'aider', source: src, date: '2026-09-01', via: 'leaderboard' },
    ])
    expect(table.models.some(m => m.model === 'Someone Else')).toBe(false)
  })

  it('keeps a model-card score the boards do not carry, and never touches a model with no rows', () => {
    const { table } = applyBoards(base, [tb([{ benchmarkName: 'Opus 5.5', score: 64.85, harness: 'Claude Code', date: '2026-09-22' }])], '2026-10-29')
    expect(table.models[1]).toEqual(base.models[1])
    expect(table.models[2]).toEqual(base.models[2])
  })

  it('drops a leaderboard score the board no longer lists for a model, but keeps the other benchmarks', () => {
    const { table } = applyBoards(base, [tb([{ benchmarkName: 'Kimi K3', score: 20, harness: 'Kimi Code', date: '2026-10-20' }])], '2026-10-29')
    expect(table.models[0].scores.map(s => s.benchmark)).toEqual(['aider-polyglot'])
  })

  it('keeps the previous rows of a benchmark whose board could not be read, with a warning, and applies the others', () => {
    const { table, warnings } = applyBoards(base, [
      { benchmark: 'terminal-bench-4.0', error: 'HTTP 503' },
      { benchmark: 'aider-polyglot', source: 'https://aider.chat/docs/leaderboards/', rows: [{ benchmarkName: 'Opus 5.5', score: 72, harness: 'aider, diff edit format', date: '2026-10-02' }] },
    ], '2026-10-29')
    expect(warnings).toEqual(['terminal-bench-4.0 was not refreshed (HTTP 503); its previous rows stay.'])
    expect(table.models[0].scores.find(s => s.benchmark === 'terminal-bench-4.0')?.score).toBe(1)
    expect(table.models[0].scores.find(s => s.benchmark === 'aider-polyglot')?.score).toBe(72)
  })

  it('does not change the input table, and the result passes the schema', () => {
    const before = JSON.stringify(base)
    const { table } = applyBoards(base, [tb([{ benchmarkName: 'Opus 5.5', score: 64.85, harness: 'Claude Code', date: '2026-09-22' }])], '2026-10-29')
    expect(JSON.stringify(base)).toBe(before)
    expect(loadPriors(table).warnings).toEqual([])
  })
})

describe('writing the data file', () => {
  it('renders TypeScript that reads back to the same table', () => {
    const table: PriorsTable = { refreshed: '2026-10-29', note: "It's per harness.", benchmarks: [{ id: 'a', name: 'A', url: 'https://x.test' }], models: [] }
    const text = renderData(table)
    expect(text).toContain('Generated by scripts/refresh-benchmark-priors.ts')
    expect(text).toContain("import type { PriorsTable } from './priors.js'")
    const body = text.slice(text.indexOf('= {') + 2).trim()
    expect(new Function(`return ${body}`)()).toEqual(table)
  })
})
