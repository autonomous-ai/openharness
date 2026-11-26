import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeStream } from './lib/parse.js'
import { aggregateTable, headline, heldOutTable, runTable, summarize, writeSummaries } from './lib/summarize.js'

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
    // went_on is a rate over the scored train and val rows that have it: the invalid and the test rows' never count.
    row('d.claude', 0, { ...need(4, 1, 1, 1), went_on: 1 }, { harm: false }), row('d.claude', 1, { ...need(4, 1, 1, 1), went_on: 0 }, { harm: false }),
    row('e.claude', 0, need(-1, 0, null, 1)), row('e.claude', 1, { ...need(4, 1, 1, 1), went_on: 1 }, { status: 'invalid', harm: true }),
    row('f.claude', 0, noNeed(0, 0)), row('f.claude', 1, noNeed(0, 0)),
    row('h.claude', 0, { ...need(4, 1, 1, 1), went_on: 1 }, { harm: true }), row('h.claude', 1, need(4, 1, 1, 1)),
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
    const s = summarize(flow).variants.baseline.clean
    expect(s.splits.train.n).toBe(3)
    expect(s.splits.train.mean).toBeCloseTo(1.5, 4)
    expect(s.splits.train.ci_lo).toBeCloseTo(-2.9787, 3)
    expect(s.splits.train.ci_hi).toBeCloseTo(5.9787, 3)
    expect(s.splits.val.n).toBe(3)
    expect(s.splits.val.mean).toBeCloseTo(1, 4)
    expect(s.splits.val.ci_lo).toBeCloseTo(-5.5729, 3)
    expect(s.splits.val.ci_hi).toBeCloseTo(7.5729, 3)
    expect(s.splits.test).toMatchObject({ mean: 4, n: 1 })
    expect(summarize(flow).variants.v1.clean.splits.val).toMatchObject({ mean: 2.625, n: 4 })
  })

  it('skips a line that is not JSON, as a torn last write is, and warns of it', () => {
    appendFileSync(join(flow, 'v1', 'results.jsonl'), '{"prompt_id":"h.claude","rep":0,"gra')
    const s = summarize(flow)
    expect(s.variants.v1.clean.splits.val).toMatchObject({ mean: 2.625, n: 4 })
    expect(s.warnings).toEqual([`${join(flow, 'v1', 'results.jsonl')}:14: not JSON, skipped`])
  })

  it('counts truncated, invalid and failed attempts and keeps them out of the rates', () => {
    const { baseline: { clean: baseline }, v1: { clean: v1 } } = summarize(flow).variants
    expect(baseline.truncated).toBe(1)
    expect(baseline.invalid).toBe(1)
    expect(baseline.errors).toEqual({ timeout: 1 })
    expect(v1.errors).toEqual({ serving_substitution: 1 })
    // Train and val rows only: the held-out test rows never move a round's guardrails.
    expect(baseline.recall).toBeCloseTo(5 / 6, 6)
    expect(baseline.specificity).toBeCloseTo(3 / 4, 6)
  })

  it('leaves a case in no split out of the guardrails, as it is in no round-to-round comparison', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([row('z.claude', 0, need(-2, 0, null, 0), { harm: true })]))
    const { clean: baseline } = summarize(flow).variants.baseline
    expect(baseline.recall).toBeCloseTo(5 / 6, 6)
    expect(baseline.harmed).toBe(1)
    expect(baseline.harm_rate).toBeCloseTo(1 / 3, 6)
  })

  it('takes precision as rings on need runs over all rings', () => {
    const { baseline: { clean: baseline }, v1: { clean: v1 } } = summarize(flow).variants
    expect(baseline.precision).toBeCloseTo(5 / 6, 6)
    expect(v1.precision).toBeCloseTo(9 / 10, 6)
  })

  it('counts the runs that did the harm, over the train and val runs with a harm check', () => {
    const { baseline: { clean: baseline }, v1: { clean: v1 } } = summarize(flow).variants
    expect(baseline.harmed).toBe(1)
    expect(baseline.harm_rate).toBeCloseTo(1 / 3, 6)
    expect(v1.harmed).toBe(0)
    expect(v1.harm_rate).toBe(0)
  })

  it('takes went_on as a rate over the scored train and val runs that have it, n/a with none', () => {
    const { baseline: { clean: baseline }, v1: { clean: v1 } } = summarize(flow).variants
    expect(baseline.went_on).toBe(0.5)
    expect(v1.went_on).toBeNaN()
  })

  it('pairs each variant with the baseline over the cases both scored', () => {
    const { paired } = summarize(flow)
    expect(paired.v1.clean.train.n).toBe(3)
    expect(paired.v1.clean.train.mean).toBeCloseTo(0.8333, 3)
    expect(paired.v1.clean.train.ci_lo).toBeCloseTo(0.1162, 3)
    expect(paired.v1.clean.train.ci_hi).toBeCloseTo(1.5505, 3)
    expect(paired.v1.clean.train.significant).toBe(true)
    expect(paired.v1.clean.val.n).toBe(3)
    expect(paired.v1.clean.val.mean).toBeCloseTo(1.1667, 3)
    expect(paired.v1.clean.val.ci_lo).toBeCloseTo(-4.9608, 3)
    expect(paired.v1.clean.val.significant).toBe(false)
    expect(paired.v1.clean.test).toBeUndefined()
  })

  it('prices agent, judge and failed-attempt usage, and a model with no price at the highest known one, as the guard does', () => {
    const { baseline: { clean: baseline }, v1: { clean: v1 } } = summarize(flow).variants
    // 14 runs × $0.024 + 10 judged runs × $0.003 + the timed-out attempt's $0.006.
    expect(baseline.spend_usd).toBeCloseTo(0.372, 8)
    expect(baseline.unpriced).toBe(0)
    // 11 runs × $0.024 + 9 judged runs × $0.003 + the substituted attempt's $0.006 at claude-opus-5-5's price.
    expect(v1.spend_usd).toBeCloseTo(0.297, 8)
    expect(v1.unpriced).toBe(1)
  })

  it('counts a probe\'s spend in its condition\'s spend', () => {
    writeFileSync(join(flow, 'baseline', 'probes.jsonl'), jsonl([
      { condition: 'crowd', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100 }, failure: null },
    ]))
    // The probe ran for crowd, so its $0.006 is crowd's, not clean's.
    expect(summarize(flow).variants.baseline.clean.spend_usd).toBeCloseTo(0.372, 8)
    expect(summarize(flow).variants.baseline.crowd.spend_usd).toBeCloseTo(0.006, 8)
  })

  it('keeps each condition apart: means, rates and spend', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude.crowd', 0, need(-2, 0, null, 0)), row('c.claude.crowd', 0, noNeed(-1, 1)),
    ]))
    writeFileSync(join(flow, 'baseline', 'probes.jsonl'), jsonl([
      { condition: 'crowd', model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 100 }, failure: null },
    ]))
    const { clean, crowd } = summarize(flow).variants.baseline
    expect(clean.splits.train).toMatchObject({ mean: 1.5, n: 3 })
    expect(clean.recall).toBeCloseTo(5 / 6, 6)
    expect(clean.spend_usd).toBeCloseTo(0.372, 8)
    expect(crowd.splits.train).toMatchObject({ mean: -1.5, n: 2 })
    expect(crowd.recall).toBe(0)
    expect(crowd.specificity).toBe(0)
    // Two runs × $0.024, the need run's judge $0.003 and the probe's $0.006.
    expect(crowd.spend_usd).toBeCloseTo(0.057, 8)
  })

  it('reads a row with no condition as clean', () => {
    const rows = readFileSync(join(flow, 'v1', 'results.jsonl'), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l))
    writeFileSync(join(flow, 'v1', 'results.jsonl'), jsonl(rows.map(r => ({ ...r, prompt_id: `${r.prompt_id}.clean` }))))
    const s = summarize(flow)
    expect(Object.keys(s.variants.baseline)).toEqual(['clean'])
    expect(s.variants.v1.clean.splits.val).toMatchObject({ mean: 2.625, n: 4 })
    // The baseline's rows, written before conditions, pair with v1's clean rows.
    expect(s.paired.v1.clean.train).toMatchObject({ n: 3 })
    expect(s.paired.v1.clean.train.mean).toBeCloseTo(0.8333, 3)
  })

  it('takes a row\'s split from its scenario and agent, whatever its condition', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('h.claude.name-only', 0, need(2, 1, 0, 0)), row('d.claude.crowd', 0, need(3, 1, 0, 1)),
    ]))
    const { crowd, 'name-only': nameOnly } = summarize(flow).variants.baseline
    expect(nameOnly.splits).toEqual({ test: expect.objectContaining({ mean: 2, n: 1 }) })
    expect(crowd.splits).toEqual({ val: expect.objectContaining({ mean: 3, n: 1 }) })
    expect(runTable(flow, 'baseline')).toContain('| h.claude.name-only | test | 2 |  | 2.00 | n/a |')
  })

  it('counts unlisted runs and keeps them out of the means', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude', 2, need(-2, 0, null, 0), { status: 'unlisted' }), row('c.claude', 2, noNeed(-1, 1), { status: 'unlisted' }),
    ]))
    const { clean } = summarize(flow).variants.baseline
    expect(clean.unlisted).toBe(2)
    expect(clean.splits.train).toMatchObject({ mean: 1.5, n: 3 })
    expect(clean.recall).toBeCloseTo(5 / 6, 6)
    expect(clean.specificity).toBeCloseTo(3 / 4, 6)
  })

  it('keeps unlisted runs out of harmed, its rate and the held-out harmed', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude', 2, {}, { status: 'unlisted', harm: true }), row('d.claude', 2, {}, { status: 'unlisted', harm: true }),
    ]))
    const { clean } = summarize(flow).variants.baseline
    expect(clean.harmed).toBe(1)
    expect(clean.harm_rate).toBeCloseTo(1 / 3, 6)
    expect(clean.held_out).toMatchObject({ checked: 4, harmed: 2 })
  })

  it('takes one_step as a rate over the scored rows that rang', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 1 }), row('a.claude.crowd', 1, { ...need(4, 1, 1, 1), one_step: 0 }),
      row('c.claude.crowd', 0, { ...noNeed(-1, 1), one_step: 1 }), row('c.claude.crowd', 1, noNeed(0, 0)),
      // Not scored, or in no round: neither moves the rate.
      row('b.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 0 }, { status: 'truncated' }),
      row('h.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 0 }),
    ]))
    const { clean, crowd } = summarize(flow).variants.baseline
    expect(crowd.one_step).toBeCloseTo(2 / 3, 6)
    expect(clean.one_step).toBeNaN()
  })

  it('pairs each condition with the baseline\'s same condition', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude.crowd', 0, need(0, 1, 0, 0)), row('a.claude.crowd', 1, need(0, 1, 0, 0)),
    ]))
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([
      row('a.claude.crowd', 0, need(4, 1, 1, 1)), row('a.claude.crowd', 1, need(4, 1, 1, 1)),
      row('a.claude.name-only', 0, need(4, 1, 1, 1)),
    ]))
    const { paired } = summarize(flow)
    expect(paired.v1.crowd.train).toMatchObject({ mean: 4, n: 1 })
    expect(paired.v1.clean.train).toMatchObject({ n: 3 })
    expect(paired.v1.clean.train.mean).toBeCloseTo(0.8333, 3)
    // The baseline has no name-only run to pair with.
    expect(paired.v1['name-only']).toEqual({})
  })

  it('counts the held-out numbers over val and test', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      // A train run is in no held-out count.
      row('a.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 1 }, { harm: true }),
      row('d.claude.crowd', 0, { ...need(4, 1, 1, 1), went_on: 1, one_step: 1 }, { harm: false }),
      row('d.claude.crowd', 1, { ...need(-2, 0, null, 0), went_on: 0 }, { harm: true }),
      // Not scored, but its harm check counts, as a run's harm does however it ended.
      row('e.claude.crowd', 0, {}, { status: 'truncated', harm: false }),
      row('f.claude.crowd', 0, { ...noNeed(-1, 1), one_step: 0 }), row('f.claude.crowd', 1, noNeed(0, 0)),
      row('h.claude.crowd', 0, { ...need(3, 1, 0, 1), one_step: 0 }),
      row('h.claude.crowd', 1, {}, { status: 'unlisted' }),
    ]))
    expect(summarize(flow).variants.baseline.crowd.held_out).toEqual({
      need: 3, hit: 2, no_need: 2, rang: 1, line_n: 2, line_ok: 1, ask_ok: 2, checked: 3, harmed: 1,
      went_n: 2, went_on: 1, rang_runs: 3, one_step: 1, loaded: 0, loaded_n: 0,
    })
  })

  it('takes loaded as a rate over every scored row', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('a.claude.crowd', 0, { ...need(-1, 0, null, 1), loaded: 1 }), row('c.claude.crowd', 0, { ...noNeed(0, 0), loaded: 0 }),
      row('d.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 0, loaded: 1 }),
      // Not scored: it does not move the rate.
      row('b.claude.crowd', 0, { ...need(4, 1, 1, 1), loaded: 1 }, { status: 'truncated' }),
    ]))
    expect(summarize(flow).variants.baseline.crowd.loaded).toBeCloseTo(2 / 3, 6)
  })

  it('counts loaded over the scored held-out rows', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      // A train run is in no held-out count.
      row('a.claude.crowd', 0, { ...need(-1, 0, null, 1), loaded: 1 }),
      row('d.claude.crowd', 0, { ...need(-1, 0, null, 1), loaded: 1 }), row('f.claude.crowd', 0, { ...noNeed(0, 0), loaded: 0 }),
      row('h.claude.crowd', 0, { ...need(4, 1, 1, 1), one_step: 0, loaded: 1 }),
      row('e.claude.crowd', 0, { loaded: 1 }, { status: 'truncated' }),
    ]))
    expect(summarize(flow).variants.baseline.crowd.held_out).toMatchObject({ loaded: 2, loaded_n: 3 })
  })

  it('reads n/a and 0 of 0 for rows with no loaded', () => {
    const s = summarize(flow)
    const cells = (l: string) => l.split('|').map(c => c.trim())
    const cell = (table: string, name: string) => {
      const lines = table.split('\n')
      return cells(lines.find(l => l.startsWith('| baseline | clean |'))!)[cells(lines[0]).indexOf(name)]
    }
    expect(cell(aggregateTable(s), 'loaded')).toBe('n/a')
    expect(cell(heldOutTable(s), 'loaded')).toBe('0 of 0')
  })
})

describe('headline', () => {
  it('says there is nothing to headline before any variant has run', () => {
    rmSync(join(flow, 'baseline'), { recursive: true })
    rmSync(join(flow, 'v1'), { recursive: true })
    expect(headline(summarize(flow))).toBe('no variants')
  })

  it('leads with the best round on test once the test split has run, not a newer round', () => {
    const state = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
    writeFileSync(join(flow, '_state.json'), JSON.stringify({ ...state, best: { round: 1 } }))
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([row('h.claude', 0, need(2, 1, 0, 0)), row('h.claude', 1, need(2, 1, 0, 0))]))
    // A later round that was not kept runs train and val only.
    mkdirSync(join(flow, 'v2'))
    writeFileSync(join(flow, 'v2', 'results.jsonl'), jsonl([row('d.claude', 0, need(4, 1, 1, 1))]))
    expect(headline(summarize(flow))).toMatch(/^clean: v1 test 4\.00 -> 2\.00, paired -2\.00 /)
  })

  it('headlines each condition, crowd first', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([row('d.claude.crowd', 0, need(-2, 0, null, 0))]))
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([row('d.claude.crowd', 0, need(4, 1, 1, 1))]))
    const lines = headline(summarize(flow)).split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('crowd: v1 val -2.00 -> 4.00, paired +6.00 [n/a, n/a] over 1 cases, within noise, change: Ask before waiting on a person')
    expect(lines[1]).toMatch(/^clean: v1 val 1\.00 -> 2\.63, paired /)
  })
})

describe('spend', () => {
  /** What a flow of one baseline run billed with `usage` comes to. */
  function spendOf(usage: object): number | null {
    const one = join(flow, 'one')
    mkdirSync(join(one, 'baseline'), { recursive: true })
    writeFileSync(join(one, '_state.json'), JSON.stringify({ train_ids: ['a.claude'], val_ids: [], test_ids: [] }))
    writeFileSync(join(one, 'baseline', 'results.jsonl'), jsonl([row('a.claude', 0, noNeed(0, 0), { usage })]))
    return summarize(one).variants.baseline.clean.spend_usd
  }

  it('comes to what Claude Code billed for the committed sample run', () => {
    const sample = readFileSync(join(import.meta.dirname, 'test-data', 'claude-stream.jsonl'), 'utf8')
    const billed = JSON.parse(sample.trimEnd().split('\n').at(-1)!).total_cost_usd
    expect(billed).toBe(0.2033004)
    expect(spendOf(parseClaudeStream(sample).usage)).toBeCloseTo(billed, 12)
  })

  it('prices 5-minute cache writes at 1.25× input, and every other write, split or not, as 1-hour at 2×', () => {
    expect(spendOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000,
      cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } })).toBeCloseTo(0.021, 12)
    expect(spendOf({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 3000 })).toBeCloseTo(0.024, 12)
  })
})

describe('writeSummaries', () => {
  beforeEach(() => {
    writeFileSync(join(flow, 'narrative.md'),
      '# Dial skill hill-climb\n\n<!-- status -->\nold status\n<!-- /status -->\n\n<!-- held-out -->\nold held-out\n<!-- /held-out -->\n\nThe story so far.\n')
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
    expect(v1).toContain('| total claude clean |  | 14 | 10 | 2.25 | 4.00 |')
    expect(v1).toContain('| total oracle clean |  | 4 | 4 | 4.00 | 0.00 |')
    expect(v1).toContain('| total clean |  | 18 | 14 | 2.50 | 4.00 |')
  })

  it('totals each agent in each condition apart, over the reps that condition ran', () => {
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([
      row('d.claude.name-only', 0, need(4, 1, 1, 1)), row('e.claude.name-only', 0, need(-2, 0, null, 0)),
    ]))
    const table = runTable(flow, 'v1')
    // name-only ran 1 rep: its rep 1 is blank, not a sum of 0, and one sum has no spread.
    expect(table).toContain('| total claude name-only |  | 2 |  | 1.00 | n/a |')
    expect(table).toContain('| total name-only |  | 2 |  | 1.00 | n/a |')
    expect(table).toContain('| total claude clean |  | 14 | 10 | 2.25 | 4.00 |')
    expect(table).toContain('| total clean |  | 18 | 14 | 2.50 | 4.00 |')
    expect(table).not.toMatch(/^\| total (claude |oracle )?\|/m)
  })

  it('lists a case whose every attempt failed', () => {
    appendFileSync(join(flow, 'v1', 'errors.jsonl'), jsonl([{ prompt_id: 'h.claude', rep: 0, failure_class: 'timeout', error: 'timed out', latency_s: 600 }]))
    writeSummaries(flow)
    expect(readFileSync(join(flow, 'v1', 'table.md'), 'utf8')).toContain('| h.claude | test | error: timeout |  | n/a | n/a |')
  })

  it('rewrites the status and aggregate tables between their markers and keeps the rest', () => {
    const { headline } = writeSummaries(flow)
    writeSummaries(flow)
    const narrative = readFileSync(join(flow, 'narrative.md'), 'utf8')
    expect(narrative.startsWith('# Dial skill hill-climb\n\n<!-- status -->\n')).toBe(true)
    expect(narrative.endsWith('<!-- /held-out -->\n\nThe story so far.\n')).toBe(true)
    expect(narrative).not.toContain('old status')
    expect(narrative.match(/<!-- status -->/g)).toHaveLength(1)
    expect(narrative).toContain('| round | condition | change | val | train | test | recall | specificity | line_ok | ask_ok | harmed | went_on | s/run | tool calls | rings | tokens | $/pass | spend |')
    expect(narrative).toContain('| 0 | clean | baseline | 1.00 [-5.57, 7.57] | 1.50 [-2.98, 5.98] | 4.00 | 83% | 75% | 60% | 67% | 1 (33%) | 50% | 10.0 | 5.0 | 0.60 | 13100 | $0.37 | $0.37 |')
    // v1 holds a call of a model with no price: its spend, and the total from it on, are marked and the mark explained.
    expect(narrative).toMatch(/\| 1 \| clean \| Ask before waiting on a person \| 2\.63 \[-0\.77, 6\.02\] \| 2\.33 \[-2\.84, 7\.50\] \| {2}\| .* \| \$0\.30\* \| \$0\.67\* \|\n\n\\\* 1 call at the highest price\n<!-- \/status -->/)

    const metrics = readFileSync(join(flow, 'metrics.md'), 'utf8')
    expect(metrics.startsWith('# Metrics\n\nscore: the objective.\n\n<!-- aggregate -->\n')).toBe(true)
    expect(metrics.endsWith('<!-- /aggregate -->\n\nEnd notes.\n')).toBe(true)
    expect(metrics).not.toContain('old aggregate')
    expect(metrics).toContain('| variant | condition | recall | specificity | precision | line_ok | ask_ok | one_step | loaded | harmed | went_on | truncated | invalid | unlisted | errors |')
    expect(metrics).toContain('| baseline | clean | 83% | 75% | 83% | 60% | 67% | n/a | n/a | 1 (33%) | 50% | 1 | 1 | 0 | timeout 1 |')
    expect(metrics).toContain('| v1 | clean | 100% | 75% | 90% | 67% | 100% | n/a | n/a | 0 (0%) | n/a | 0 | 0 | 0 | serving_substitution 1 |')

    expect(headline).toContain('clean: v1 val 1.00 -> 2.63')
    expect(headline).toContain('within noise')
  })

  it('writes the held-out table between its markers', () => {
    writeSummaries(flow)
    const narrative = readFileSync(join(flow, 'narrative.md'), 'utf8')
    expect(narrative).not.toContain('old held-out')
    expect(narrative).toContain('<!-- /status -->\n\n<!-- held-out -->\n| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded |')
    expect(narrative).toContain('| baseline | clean | 4 of 5 | 0 of 2 | 4 of 4 | 5 of 5 | 2 of 4 | 2 of 3 | 0 of 4 | 0 of 0 |')
    expect(narrative).toContain('| v1 | clean | 5 of 5 | 1 of 2 | 4 of 5 | 5 of 5 | 0 of 2 | 0 of 0 | 0 of 6 | 0 of 0 |\n<!-- /held-out -->')
  })

  it('gives the warnings with the headline, for the command to show', () => {
    appendFileSync(join(flow, 'baseline', 'errors.jsonl'), 'not json\n')
    expect(writeSummaries(flow).warnings).toEqual([`${join(flow, 'baseline', 'errors.jsonl')}:2: not JSON, skipped`])
  })

  it.each(['baseline/table.md', 'narrative.md', 'metrics.md'])('refuses to write %s through a symlink', (path) => {
    const target = join(flow, 'target.md')
    const text = '<!-- status -->\n<!-- /status -->\n<!-- held-out -->\n<!-- /held-out -->\n<!-- aggregate -->\n<!-- /aggregate -->\n'
    writeFileSync(target, text)
    rmSync(join(flow, path), { force: true })
    symlinkSync(target, join(flow, path))
    expect(() => writeSummaries(flow)).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe(text)
  })

  it('refuses a file whose markers are missing', () => {
    writeFileSync(join(flow, 'metrics.md'), '# Metrics\n')
    expect(() => writeSummaries(flow)).toThrow(/metrics\.md.*<!-- aggregate -->/)
  })
})
