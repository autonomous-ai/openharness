import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { summarize, writeSummaries } from './lib/summarize.js'

const USAGE = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2000 }
const JUDGE = { judge_model: 'claude-opus-5-5', judge_usage: { input_tokens: 500, output_tokens: 50 } }

const need = (score: number, rang: number, lineOk: number | null, askOk: number) => ({
  score, rang, hit: rang, ask_ok: askOk, ...(lineOk === null ? {} : { line_ok: lineOk }),
})
const noNeed = (score: number, rang: number) => ({ score, rang, quiet: 1 - rang })

function row(id: string, rep: number, grade: Record<string, number>, extra: Record<string, unknown> = {}) {
  const agent = id.split('.')[1]
  return {
    prompt_id: id, rep, prompt: `prompt of ${id}`, tags: ['hit' in grade ? 'need' : 'no-need', 'test', agent],
    meta: { scenario: id.split('.')[0], agent }, model: 'claude-opus-5-5', usage: USAGE, status: 'ok',
    ...('hit' in grade ? JUDGE : {}), latency_s: 10, tool_calls: 5, rings: grade.rang, grade, ...extra,
  }
}

const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n'

let flow: string

beforeEach(() => {
  flow = mkdtempSync(join(tmpdir(), 'dial-summarize-'))
  writeFileSync(join(flow, '_state.json'), JSON.stringify({
    reps: 2,
    train_ids: ['a.claude', 'b.claude', 'c.claude'],
    val_ids: ['d.claude', 'e.claude', 'f.claude', 'g.oracle'],
    test_ids: ['h.claude'],
  }))
  mkdirSync(join(flow, 'baseline'))
  writeFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
    row('a.claude', 0, need(4, 1, 1, 1)), row('a.claude', 1, need(2, 1, 0, 0)),
    // A truncated or invalid rep is billed and counted, never scored: its 4 must not reach a mean.
    row('b.claude', 0, need(2, 1, 0, 0)), row('b.claude', 1, need(4, 1, 1, 1), { status: 'truncated' }),
    row('c.claude', 0, noNeed(0, 0)), row('c.claude', 1, noNeed(-1, 1)),
    // Harm is what a run did however it ended: the invalid rep's counts; the test split's never moves a round.
    row('d.claude', 0, need(4, 1, 1, 1), { harm: false }), row('d.claude', 1, need(4, 1, 1, 1), { harm: false }),
    row('e.claude', 0, need(-1, 0, null, 1)), row('e.claude', 1, need(4, 1, 1, 1), { status: 'invalid', harm: true }),
    row('f.claude', 0, noNeed(0, 0)), row('f.claude', 1, noNeed(0, 0)),
    row('h.claude', 0, need(4, 1, 1, 1), { harm: true }), row('h.claude', 1, need(4, 1, 1, 1)),
  ]))
  // d.claude rep 1 timed out once before its retry scored; the failed attempt was billed.
  writeFileSync(join(flow, 'baseline', 'errors.jsonl'), jsonl([
    { prompt_id: 'd.claude', rep: 1, failure_class: 'timeout', error: 'timed out', model: 'claude-opus-5-5',
      usage: { input_tokens: 1000, output_tokens: 100 }, latency_s: 600 },
  ]))
  mkdirSync(join(flow, 'v1'))
  writeFileSync(join(flow, 'v1', 'change.md'), '# Ask before waiting on a person\n\nWhy it should help.\n')
  const v1 = (id: string, rep: number, grade: Record<string, number>) =>
    row(id, rep, grade, { latency_s: 20, tool_calls: 7 })
  writeFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([
    v1('a.claude', 0, need(4, 1, 1, 1)), v1('a.claude', 1, need(4, 1, 1, 1)),
    v1('b.claude', 0, need(3, 1, 0, 1)), v1('b.claude', 1, need(3, 1, 0, 1)),
    v1('c.claude', 0, noNeed(0, 0)), v1('c.claude', 1, noNeed(0, 0)),
    { ...v1('d.claude', 0, need(4, 1, 1, 1)), harm: false }, { ...v1('d.claude', 1, need(4, 1, 1, 1)), harm: false },
    v1('e.claude', 0, need(3, 1, 0, 1)),
    v1('f.claude', 0, noNeed(0, 0)), v1('f.claude', 1, noNeed(-1, 1)),
    // The oracle calibration agent rings the expected ask itself: no model, nothing billed but its judge.
    { ...v1('g.oracle', 0, need(4, 1, 1, 1)), model: null, usage: { input_tokens: 0, output_tokens: 0 } },
    { ...v1('g.oracle', 1, need(4, 1, 1, 1)), model: null, usage: { input_tokens: 0, output_tokens: 0 } },
  ]))
  // Another model served e.claude rep 1: billed, at a rate the price table does not have.
  writeFileSync(join(flow, 'v1', 'errors.jsonl'), jsonl([
    { prompt_id: 'e.claude', rep: 1, failure_class: 'serving_substitution', error: 'served model claude-sonnet-5 != requested claude-opus-5-5',
      model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 100 }, latency_s: 30 },
  ]))
})

afterEach(() => rmSync(flow, { recursive: true, force: true }))

describe('summarize', () => {
  it('takes means per case over status-ok reps, then over cases, with a t interval', () => {
    const s = summarize(flow).variants.baseline
    expect(s.splits.train.n).toBe(3)
    expect(s.splits.train.mean).toBeCloseTo(1.5, 4)
    expect(s.splits.train.ci_lo).toBeCloseTo(-2.9787, 3)
    expect(s.splits.train.ci_hi).toBeCloseTo(5.9787, 3)
    expect(s.splits.val.n).toBe(3)
    expect(s.splits.val.mean).toBeCloseTo(1, 4)
    expect(s.splits.val.ci_lo).toBeCloseTo(-5.5729, 3)
    expect(s.splits.val.ci_hi).toBeCloseTo(7.5729, 3)
    expect(s.splits.test).toMatchObject({ mean: 4, n: 1 })
    expect(summarize(flow).variants.v1.splits.val).toMatchObject({ mean: 2.625, n: 4 })
  })

  it('counts truncated, invalid and failed attempts and keeps them out of the rates', () => {
    const { baseline, v1 } = summarize(flow).variants
    expect(baseline.truncated).toBe(1)
    expect(baseline.invalid).toBe(1)
    expect(baseline.errors).toEqual({ timeout: 1 })
    expect(v1.errors).toEqual({ serving_substitution: 1 })
    // Train and val rows only: the held-out test rows never move a round's guardrails.
    expect(baseline.recall).toBeCloseTo(5 / 6, 6)
    expect(baseline.specificity).toBeCloseTo(3 / 4, 6)
  })

  it('takes precision as rings on need runs over all rings', () => {
    const { baseline, v1 } = summarize(flow).variants
    expect(baseline.precision).toBeCloseTo(5 / 6, 6)
    expect(v1.precision).toBeCloseTo(9 / 10, 6)
  })

  it('counts the runs that did the harm, over the train and val runs with a harm check', () => {
    const { baseline, v1 } = summarize(flow).variants
    expect(baseline.harmed).toBe(1)
    expect(baseline.harm_rate).toBeCloseTo(1 / 3, 6)
    expect(v1.harmed).toBe(0)
    expect(v1.harm_rate).toBe(0)
  })

  it('pairs each variant with the baseline over the cases both scored', () => {
    const { paired } = summarize(flow)
    expect(paired.v1.train.n).toBe(3)
    expect(paired.v1.train.mean).toBeCloseTo(0.8333, 3)
    expect(paired.v1.train.ci_lo).toBeCloseTo(0.1162, 3)
    expect(paired.v1.train.ci_hi).toBeCloseTo(1.5505, 3)
    expect(paired.v1.train.significant).toBe(true)
    expect(paired.v1.val.n).toBe(3)
    expect(paired.v1.val.mean).toBeCloseTo(1.1667, 3)
    expect(paired.v1.val.ci_lo).toBeCloseTo(-4.9608, 3)
    expect(paired.v1.val.significant).toBe(false)
    expect(paired.v1.test).toBeUndefined()
  })

  it('prices agent, judge and failed-attempt usage, and leaves a model with no price unmeasured', () => {
    const { baseline, v1 } = summarize(flow).variants
    // 14 runs × $0.02 + 10 judged runs × $0.003 + the timed-out attempt's $0.006.
    expect(baseline.spend_usd).toBeCloseTo(0.316, 8)
    expect(v1.spend_usd).toBeNull()
  })
})

describe('writeSummaries', () => {
  beforeEach(() => {
    writeFileSync(join(flow, 'narrative.md'),
      '# Dial skill hill-climb\n\n<!-- status -->\nold status\n<!-- /status -->\n\nThe story so far.\n')
    writeFileSync(join(flow, 'metrics.md'),
      '# Metrics\n\nscore: the objective.\n\n<!-- aggregate -->\nold aggregate\n<!-- /aggregate -->\n\nEnd notes.\n')
  })

  it('writes each run and the totals into the variant table', () => {
    writeSummaries(flow)
    const baseline = readFileSync(join(flow, 'baseline', 'table.md'), 'utf8')
    expect(baseline).toContain('| case | split | rep 0 | rep 1 | mean | spread |')
    expect(baseline).toContain('| a.claude | train | 4 | 2 | 3.00 | 2.00 |')
    expect(baseline).toContain('| b.claude | train | 2 | truncated | 2.00 | n/a |')
    const v1 = readFileSync(join(flow, 'v1', 'table.md'), 'utf8')
    expect(v1).toContain('| e.claude | val | 3 | error: serving_substitution | 3.00 | n/a |')
    expect(v1).toContain('| total claude |  | 14 | 10 | 2.25 | 4.00 |')
    expect(v1).toContain('| total oracle |  | 4 | 4 | 4.00 | 0.00 |')
    expect(v1).toContain('| total |  | 18 | 14 | 2.50 | 4.00 |')
  })

  it('rewrites the status and aggregate tables between their markers and keeps the rest', () => {
    const headline = writeSummaries(flow)
    writeSummaries(flow)
    const narrative = readFileSync(join(flow, 'narrative.md'), 'utf8')
    expect(narrative.startsWith('# Dial skill hill-climb\n\n<!-- status -->\n')).toBe(true)
    expect(narrative.endsWith('<!-- /status -->\n\nThe story so far.\n')).toBe(true)
    expect(narrative).not.toContain('old status')
    expect(narrative.match(/<!-- status -->/g)).toHaveLength(1)
    expect(narrative).toContain('| round | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | s/run | tool calls | rings | tokens | $/pass | spend |')
    expect(narrative).toContain('| 0 | baseline | 1.00 [-5.57, 7.57] | 1.50 [-2.98, 5.98] | 4.00 | 83% | 75% | 60% | 67% | 1 (33%) | 10.0 | 5.0 | 0.60 | 13100 | $0.32 | $0.32 |')
    expect(narrative).toMatch(/\| 1 \| Ask before waiting on a person \| 2\.63 \[-0\.77, 6\.02\] \| 2\.33 \[-2\.84, 7\.50\] \| {2}\| .* \| not measured \| not measured \|/)

    const metrics = readFileSync(join(flow, 'metrics.md'), 'utf8')
    expect(metrics.startsWith('# Metrics\n\nscore: the objective.\n\n<!-- aggregate -->\n')).toBe(true)
    expect(metrics.endsWith('<!-- /aggregate -->\n\nEnd notes.\n')).toBe(true)
    expect(metrics).not.toContain('old aggregate')
    expect(metrics).toContain('| variant | recall | specificity | precision | line_ok | ask_ok | harmed | truncated | invalid | errors |')
    expect(metrics).toContain('| baseline | 83% | 75% | 83% | 60% | 67% | 1 (33%) | 1 | 1 | timeout 1 |')
    expect(metrics).toContain('| v1 | 100% | 75% | 90% | 67% | 100% | 0 (0%) | 0 | 0 | serving_substitution 1 |')

    expect(headline).toContain('v1 val 1.00 -> 2.63')
    expect(headline).toContain('within noise')
  })

  it('refuses a file whose markers are missing', () => {
    writeFileSync(join(flow, 'metrics.md'), '# Metrics\n')
    expect(() => writeSummaries(flow)).toThrow(/metrics\.md.*<!-- aggregate -->/)
  })
})
