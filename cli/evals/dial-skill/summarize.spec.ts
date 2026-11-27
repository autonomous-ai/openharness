import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseClaudeStream } from './lib/parse.js'
import { aggregateTable, closeGate, closeTable, fisherOneSided, headline, heldOutTable, runTable, summarize, writeSummaries } from './lib/summarize.js'

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
      went_n: 2, went_on: 1, rang_runs: 3, one_step: 1, loaded: 0, loaded_n: 0, nudged: 0, nudged_n: 0,
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

  it('counts nudged over the scored held-out rows, and takes its rate over the scored train and val rows', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      // A train run is in the rate, not in the held-out count.
      row('a.claude.crowd', 0, { ...need(4, 1, 1, 1), nudged: 1 }),
      row('d.claude.crowd', 0, { ...need(4, 1, 1, 1), nudged: 1 }), row('f.claude.crowd', 0, { ...noNeed(0, 0), nudged: 0 }),
      row('h.claude.crowd', 0, { ...need(4, 1, 1, 1), nudged: 1 }),
      // Not scored: in neither.
      row('e.claude.crowd', 0, { nudged: 1 }, { status: 'truncated' }),
    ]))
    const s = summarize(flow)
    expect(s.variants.baseline.crowd.held_out).toMatchObject({ nudged: 2, nudged_n: 3 })
    expect(s.variants.baseline.crowd.nudged).toBeCloseTo(2 / 3, 6)
    const cells = (l: string) => l.split('|').map(c => c.trim())
    const cell = (table: string, name: string) => {
      const lines = table.split('\n')
      return cells(lines.find(l => l.startsWith('| baseline | crowd |'))!)[cells(lines[0]).indexOf(name)]
    }
    expect(cells(heldOutTable(s).split('\n')[0]).slice(-6, -1)).toEqual(['loaded', 'nudged', 'score vs baseline', 'recall vs base', 'recall p vs base'])
    expect(cell(heldOutTable(s), 'nudged')).toBe('2 of 3')
    expect(cells(aggregateTable(s).split('\n')[0]).slice(9, 12)).toEqual(['loaded', 'nudged', 'harmed'])
    expect(cell(aggregateTable(s), 'nudged')).toBe('67%')
  })

  it('pairs each variant with the baseline over the val and test cases pooled', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('d.claude.crowd', 0, need(0, 1, 0, 0)), row('e.claude.crowd', 0, need(0, 1, 0, 0)),
      row('h.claude.crowd', 0, need(0, 1, 0, 0)),
      // A train case is in no held-out pair.
      row('a.claude.crowd', 0, need(-2, 0, null, 0)),
    ]))
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([
      row('d.claude.crowd', 0, need(2, 1, 0, 0)), row('e.claude.crowd', 0, need(3, 1, 1, 0)),
      row('h.claude.crowd', 0, need(4, 1, 1, 1)), row('a.claude.crowd', 0, need(4, 1, 1, 1)),
    ]))
    const crowd = summarize(flow).held_out_paired.v1.crowd
    expect(crowd.n).toBe(3)
    expect(crowd.mean).toBeCloseTo(3, 6)
    expect(crowd.ci_lo).toBeCloseTo(0.5156, 3)
    expect(crowd.ci_hi).toBeCloseTo(5.4844, 3)
    expect(crowd.significant).toBe(true)
  })

  it('shows the pooled paired score in the held-out table', () => {
    appendFileSync(join(flow, 'baseline', 'results.jsonl'), jsonl([
      row('d.claude.crowd', 0, need(0, 1, 0, 0)), row('e.claude.crowd', 0, need(0, 1, 0, 0)),
      row('h.claude.crowd', 0, need(0, 1, 0, 0)),
    ]))
    appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl([
      row('d.claude.crowd', 0, need(2, 1, 0, 0)), row('e.claude.crowd', 0, need(3, 1, 1, 0)),
      row('h.claude.crowd', 0, need(4, 1, 1, 1)),
      // The baseline has no name-only run to pair with.
      row('h.claude.name-only', 0, need(4, 1, 1, 1)),
    ]))
    const lines = heldOutTable(summarize(flow)).split('\n')
    expect(lines[0]).toMatch(/\| loaded \| nudged \| score vs baseline \| recall vs base \| recall p vs base \|$/)
    expect(lines.find(l => l.startsWith('| v1 | crowd |'))).toMatch(/\| \+3\.00 \[0\.52, 5\.48\] \| n\/a \| n\/a \|$/)
    expect(lines.find(l => l.startsWith('| v1 | name-only |'))).toMatch(/\| n\/a \| n\/a \| n\/a \|$/)
    expect(lines.find(l => l.startsWith('| baseline | crowd |'))).toMatch(/\|  \| n\/a \| n\/a \|$/)
  })

  describe('recall against the best round', () => {
    function setBest(round: number | null) {
      const { best: _, ...state } = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
      writeFileSync(join(flow, '_state.json'), JSON.stringify(round === null ? state : { ...state, best: { round } }))
    }

    /** v1 (the best) and v2 in crowd, each given its hits per held-out need case; a no-need case and a train case in
     *  both, which no recall pair may count. */
    function crowd(v1Hits: Record<string, number[]>, v2Hits: Record<string, number[]>) {
      const rowsOf = (hits: Record<string, number[]>) => [
        ...Object.entries(hits).flatMap(([id, hs]) =>
          hs.map((h, rep) => row(`${id}.crowd`, rep, h ? need(4, 1, 1, 1) : need(-2, 0, null, 0)))),
        row('f.claude.crowd', 0, noNeed(-1, 1)), row('a.claude.crowd', 0, need(-2, 0, null, 0)),
      ]
      appendFileSync(join(flow, 'v1', 'results.jsonl'), jsonl(rowsOf(v1Hits)))
      mkdirSync(join(flow, 'v2'), { recursive: true })
      appendFileSync(join(flow, 'v2', 'results.jsonl'), jsonl(rowsOf(v2Hits)))
    }

    beforeEach(() => setBest(1))

    it('pairs each round\'s held-out recall with the best round\'s, over the need cases both scored', () => {
      crowd({ 'd.claude': [0], 'e.claude': [1, 0], 'h.claude': [0] }, { 'd.claude': [1], 'e.claude': [1], 'h.claude': [1] })
      const p = summarize(flow).held_out_recall.v2.crowd
      expect(p.n).toBe(3)
      expect(p.mean).toBeCloseTo(0.8333, 3)
      expect(p.ci_lo).toBeCloseTo(0.1162, 3)
      expect(p.ci_hi).toBeCloseTo(1.5505, 3)
      expect(p.significant).toBe(true)
    })

    it('reads a fall as an interval below 0', () => {
      crowd({ 'd.claude': [1], 'e.claude': [1, 1], 'h.claude': [1, 0] }, { 'd.claude': [0], 'e.claude': [0], 'h.claude': [0] })
      const p = summarize(flow).held_out_recall.v2.crowd
      expect(p.ci_hi).toBeLessThan(0)
      expect(p.significant).toBe(true)
    })

    it('reads equal recall as within noise', () => {
      crowd({ 'd.claude': [1], 'e.claude': [1, 0], 'h.claude': [0] }, { 'd.claude': [1, 1], 'e.claude': [0, 1], 'h.claude': [0] })
      const p = summarize(flow).held_out_recall.v2.crowd
      expect(p.mean).toBe(0)
      expect(p.significant).toBe(false)
    })

    it('gives the best round and a condition the best never ran no recall pair', () => {
      crowd({ 'd.claude': [0] }, { 'd.claude': [1] })
      appendFileSync(join(flow, 'v2', 'results.jsonl'), jsonl([row('h.claude.name-only', 0, need(4, 1, 1, 1))]))
      const { held_out_recall } = summarize(flow)
      expect(held_out_recall.v1).toBeUndefined()
      expect(held_out_recall.v2['name-only']).toBeUndefined()
    })

    it('has no recall pair without a best round', () => {
      crowd({ 'd.claude': [0] }, { 'd.claude': [1] })
      setBest(null)
      expect(summarize(flow).held_out_recall).toEqual({})
    })

    it('shows the recall pair in the held-out table', () => {
      crowd({ 'd.claude': [0], 'e.claude': [1, 0], 'h.claude': [0] }, { 'd.claude': [1], 'e.claude': [1], 'h.claude': [1] })
      appendFileSync(join(flow, 'v2', 'results.jsonl'), jsonl([row('h.claude.name-only', 0, need(4, 1, 1, 1))]))
      const lines = heldOutTable(summarize(flow)).split('\n')
      const p = summarize(flow).held_out_recall_p.v2.crowd
      expect(lines.find(l => l.startsWith('| v2 | crowd |'))).toMatch(new RegExp(`\\| \\+0\\.83 \\[0\\.12, 1\\.55\\] \\| ${p.toFixed(3).replace('.', '\\.')} \\|$`))
      for (const l of lines.filter(l => l.startsWith('| v1 |'))) expect(l).toMatch(/\|  \|  \|$/)
      expect(lines.find(l => l.startsWith('| v2 | name-only |'))).toMatch(/\| n\/a \| n\/a \|$/)
    })
  })
})

describe('recall against a round\'s base', () => {
  /** Rounds v1 (3 reps), v2 and v3 (2 reps) in crowd, the best round 2, and `bases` as given; hits per held-out need
   *  case. */
  function flowOf(bases: Record<string, number> | undefined, hits: Record<string, Record<string, number[]>>) {
    const state = JSON.parse(readFileSync(join(flow, '_state.json'), 'utf8'))
    writeFileSync(join(flow, '_state.json'), JSON.stringify({ ...state, best: { round: 2 }, ...(bases && { bases }) }))
    for (const [v, byCase] of Object.entries(hits)) {
      mkdirSync(join(flow, v), { recursive: true })
      appendFileSync(join(flow, v, 'results.jsonl'), jsonl(Object.entries(byCase).flatMap(([id, hs]) =>
        hs.map((h, rep) => row(`${id}.crowd`, rep, h ? need(4, 1, 1, 1) : need(-2, 0, null, 0))))))
    }
  }
  const HITS = {
    baseline: { 'd.claude': [1], 'e.claude': [1], 'h.claude': [1] },
    v1: { 'd.claude': [1, 0, 0], 'e.claude': [1, 1, 1], 'h.claude': [0, 0, 1] },
    v2: { 'd.claude': [0, 0], 'e.claude': [0, 0], 'h.claude': [0, 0] },
    v3: { 'd.claude': [1, 1], 'e.claude': [1, 0], 'h.claude': [1, 1] },
  }

  it('pairs a round\'s held-out recall with the base _state.json names for it', () => {
    flowOf({ v3: 1 }, HITS)
    const p = summarize(flow).held_out_recall.v3.crowd
    // Case means against v1's: d 1 - 1/3, e 1/2 - 1, h 1 - 1/3; against v2's they would all be above 0.
    expect(p.n).toBe(3)
    expect(p.mean).toBeCloseTo(0.2778, 3)
    expect(p.ci_lo).toBeCloseTo(-1.3956, 3)
    expect(p.ci_hi).toBeCloseTo(1.9512, 3)
    expect(p.significant).toBe(false)
  })

  it('without a base, the best round', () => {
    flowOf({ v3: 1 }, HITS)
    const { held_out_recall } = summarize(flow)
    expect(held_out_recall.v2).toBeUndefined()
    expect(held_out_recall.baseline.crowd).toMatchObject({ mean: 1, n: 3 })
    expect(held_out_recall.v1.crowd.mean).toBeCloseTo(5 / 9, 6)
  })

  it('gives each round\'s recall p against its base', () => {
    flowOf({ v3: 1 }, HITS)
    const s = summarize(flow)
    // v1 hit 5 of its 9 held-out need runs, v3 5 of 6.
    expect(s.held_out_recall_p.v3.crowd).toBe(fisherOneSided(5, 9, 5, 6))
    expect(s.held_out_recall_p.baseline.crowd).toBe(fisherOneSided(0, 6, 3, 3))
    expect(s.held_out_recall_p.v2).toBeUndefined()
    const lines = heldOutTable(s).split('\n')
    expect(lines[0]).toMatch(/\| loaded \| nudged \| score vs baseline \| recall vs base \| recall p vs base \|$/)
    expect(lines.find(l => l.startsWith('| v3 | crowd |'))).toMatch(/\| \+0\.28 \[-1\.40, 1\.95\] \| 0\.294 \|$/)
    expect(lines.find(l => l.startsWith('| v2 | crowd |'))).toMatch(/\|  \|  \|$/)
  })

  it('gives the recall p over the held-out cases both scored, as the recall pair', () => {
    // v4 ran val only (d, e), against v1, which ran val and test: v1's test runs of h must not reach the p.
    flowOf({ v4: 1 }, { ...HITS, v4: { 'd.claude': [1, 1], 'e.claude': [1, 1] } })
    const s = summarize(flow)
    expect(s.held_out_recall.v4.crowd.n).toBe(2)
    // v1 hit 4 of its 6 val need runs, v4 4 of 4.
    expect(s.held_out_recall_p.v4.crowd).toBe(fisherOneSided(4, 6, 4, 4))
  })
})

describe('fisherOneSided', () => {
  it('gives the one-sided exact p of the variant\'s hits against its base\'s', () => {
    expect(fisherOneSided(41, 48, 48, 48)).toBeCloseTo(0.00618, 5)
    expect(fisherOneSided(41, 48, 47, 48)).toBeCloseTo(0.02950, 5)
    expect(fisherOneSided(41, 48, 46, 48)).toBeCloseTo(0.07932, 5)
    expect(fisherOneSided(41, 48, 32, 32)).toBeCloseTo(0.02318, 5)
  })

  it('is above 0.5 for equal counts, and 1 where the hits could not have been fewer', () => {
    expect(fisherOneSided(5, 10, 5, 10)).toBeGreaterThan(0.5)
    expect(fisherOneSided(0, 10, 0, 10)).toBe(1)
    expect(fisherOneSided(10, 10, 10, 10)).toBe(1)
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

describe('the close gates', () => {
  /** A two-turn run: turn 1 graded as any need run, turn 2's close fields beside it. */
  const followUp = (id: string, rep: number, kind: string, close: Record<string, number>,
    grade: Record<string, number> = need(4, 1, 1, 1), extra: Record<string, unknown> = {}) =>
    row(id, rep, { ...grade, ...close }, { meta: { scenario: id.split('.')[0], agent: id.split('.')[1], follow_up: kind }, ...extra })
  const append = (v: string, rows: object[]) => {
    mkdirSync(join(flow, v), { recursive: true })
    appendFileSync(join(flow, v, 'results.jsonl'), jsonl(rows))
  }
  /** One crowd run of each held-out need case (d, e, h) with `hit`, and `needless` rings on the no-need case f. */
  const crowd = (v: string, { hit = 1, needless = 0 } = {}) => append(v, [
    ...['d', 'e', 'h'].map(c => row(`${c}.claude.crowd`, 0, hit ? need(4, 1, 1, 1) : need(-2, 0, null, 0))),
    ...Array.from({ length: needless }, (_, rep) => row('f.claude.crowd', rep, noNeed(-1, 1))),
    row('f.claude.crowd', needless, noNeed(0, 0)),
  ])
  /** n answer and answer-one runs, the first k closed right, on a case round 4 never ran, so recall pairs skip it. */
  const rights = (k: number, n: number) => append('v7', Array.from({ length: n }, (_, rep) =>
    followUp('g.oracle.crowd', rep, rep % 2 ? 'answer-one' : 'answer', { close_right: rep < k ? 1 : 0, close_wrong: 0, close_errors: 0 })))
  const wrongs = (from: number, n: number) => append('v7', Array.from({ length: n }, (_, k) =>
    followUp('e.claude.crowd', from + k, 'relay', { close_wrong: 1, close_errors: 0 })))

  beforeEach(() => crowd('v4', { needless: 1 }))

  it('counts each kind over the scored held-out runs, train and unscored runs left out', () => {
    crowd('v7')
    append('v7', [
      followUp('d.claude.crowd', 10, 'answer', { close_right: 1, close_wrong: 0, close_errors: 0 }),
      followUp('d.claude.crowd', 11, 'answer', { close_right: 0, close_wrong: 0, close_errors: 1 }),
      followUp('h.claude.crowd', 10, 'answer-one', { close_right: 1, close_wrong: 1, close_errors: 0 }),
      // Turn 1 rang no card: nothing to close right, so no close_right.
      followUp('h.claude.crowd', 11, 'answer-one', { close_wrong: 0, close_errors: 0 }, need(-2, 0, null, 0)),
      followUp('e.claude.crowd', 10, 'relay', { close_wrong: 1, close_errors: 0 }),
      followUp('e.claude.crowd', 11, 'new-request', { close_wrong: 0, close_errors: 0 }),
      followUp('g.oracle.crowd', 0, 'unrung', { close_wrong: 0, close_errors: 2 }),
      // A train run and a truncated one are in no count.
      followUp('a.claude.crowd', 0, 'answer', { close_right: 0, close_wrong: 3, close_errors: 1 }),
      followUp('d.claude.crowd', 12, 'relay', { close_wrong: 1, close_errors: 1 }, need(4, 1, 1, 1), { status: 'truncated' }),
    ])
    const s = summarize(flow)
    expect(s.close.v7.crowd).toEqual({
      right: 2, right_n: 3, wrong: 2, errors: 3, unrung: 1, cut: 0,
      by_kind: {
        answer: { runs: 2, right: 1, wrong: 0 }, 'answer-one': { runs: 2, right: 1, wrong: 1 },
        relay: { runs: 1, wrong: 1 }, 'new-request': { runs: 1, wrong: 0 }, unrung: { runs: 1, wrong: 0 },
      },
    })
    expect(s.close.v4).toBeUndefined()
  })

  it('counts a run whose turn 2 was cut apart, in no right, wrong or rang-no-card count', () => {
    crowd('v7')
    append('v7', [
      followUp('d.claude.crowd', 10, 'answer', { close_right: 1, close_wrong: 0, close_errors: 0 }),
      followUp('d.claude.crowd', 11, 'answer', { close_cut: 1 }),
      followUp('e.claude.crowd', 10, 'relay', { close_cut: 1 }),
    ])
    expect(summarize(flow).close.v7.crowd).toEqual({
      right: 1, right_n: 1, wrong: 0, errors: 0, unrung: 0, cut: 2,
      by_kind: {
        answer: { runs: 1, right: 1, wrong: 0 }, 'answer-one': { runs: 0, right: 0, wrong: 0 },
        relay: { runs: 0, wrong: 0 }, 'new-request': { runs: 0, wrong: 0 }, unrung: { runs: 0, wrong: 0 },
      },
    })
  })

  it('passes a right close on 13 of 14 answer and answer-one runs', () => {
    crowd('v7')
    rights(13, 14)
    expect(closeGate(summarize(flow), 'v7')).toEqual({ right: true, wrong: true, ring: true, pass: true })
  })

  it('fails a right close on 12 of 14', () => {
    crowd('v7')
    rights(12, 14)
    expect(closeGate(summarize(flow), 'v7')).toEqual({ right: false, wrong: true, ring: true, pass: false })
  })

  it('passes 1 wrong close and fails 2', () => {
    crowd('v7')
    rights(14, 14)
    wrongs(10, 1)
    expect(closeGate(summarize(flow), 'v7').wrong).toBe(true)
    wrongs(11, 1)
    expect(closeGate(summarize(flow), 'v7')).toEqual({ right: true, wrong: false, ring: true, pass: false })
  })

  it('fails the ring gate when held-out recall falls below round 4\'s beyond noise', () => {
    crowd('v7', { hit: 0 })
    rights(14, 14)
    const s = summarize(flow)
    expect(s.close_recall.v7.crowd.ci_hi).toBeLessThan(0)
    expect(closeGate(s, 'v7')).toEqual({ right: true, wrong: true, ring: false, pass: false })
  })

  it('passes one needless ring over round 4\'s and fails two', () => {
    crowd('v7', { needless: 2 })
    rights(14, 14)
    expect(closeGate(summarize(flow), 'v7').ring).toBe(true)
    rmSync(join(flow, 'v7'), { recursive: true })
    crowd('v7', { needless: 3 })
    rights(14, 14)
    expect(closeGate(summarize(flow), 'v7')).toEqual({ right: true, wrong: true, ring: false, pass: false })
  })

  it('passes nothing for a variant with no follow-up runs', () => {
    expect(closeGate(summarize(flow), 'v4')).toEqual({ right: false, wrong: false, ring: false, pass: false })
  })

  describe('in narrative.md', () => {
    beforeEach(() => {
      writeFileSync(join(flow, 'narrative.md'), '<!-- status -->\n<!-- /status -->\n<!-- held-out -->\n<!-- /held-out -->\n'
        + '<!-- close -->\nold close\n<!-- /close -->\n\nThe story so far.\n')
      writeFileSync(join(flow, 'metrics.md'), '<!-- aggregate -->\n<!-- /aggregate -->\n')
    })

    it('writes the close table between its markers', () => {
      crowd('v7')
      rights(13, 14)
      wrongs(10, 1)
      // Gates are read in crowd alone: another condition's row leaves them blank.
      append('v7', [followUp('d.claude', 10, 'answer', { close_right: 1, close_wrong: 0, close_errors: 1 })])
      writeSummaries(flow)
      const narrative = readFileSync(join(flow, 'narrative.md'), 'utf8')
      expect(narrative).toContain('<!-- close -->\n'
        + '| variant | condition | right | wrong | errors | rang no card | turn 2 cut | by kind | right ≥ 90% | wrong ≤ 1 | ring |\n'
        + '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n'
        + '| v7 | clean | 1 of 1 | 0 | 1 | 0 | 0 | answer 1 runs, 1 right, 0 wrong |  |  |  |\n'
        + '| v7 | crowd | 13 of 14 | 1 | 0 | 0 | 0 | answer 7 runs, 7 right, 0 wrong; answer-one 7 runs, 6 right, 0 wrong; '
        + 'relay 1 runs, 1 wrong | pass | pass | pass |\n'
        + '<!-- /close -->\n\nThe story so far.\n')
      expect(closeTable(summarize(flow))).toBe(narrative.slice(narrative.indexOf('<!-- close -->\n') + 15, narrative.indexOf('\n<!-- /close -->')))
    })

    it('writes nothing between them before any follow-up run', () => {
      writeSummaries(flow)
      expect(readFileSync(join(flow, 'narrative.md'), 'utf8')).toContain('<!-- close -->\n\n<!-- /close -->')
    })
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
      '# Dial skill hill-climb\n\n<!-- status -->\nold status\n<!-- /status -->\n\n<!-- held-out -->\nold held-out\n<!-- /held-out -->\n\n<!-- close -->\nold close\n<!-- /close -->\n\nThe story so far.\n')
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
    expect(narrative.endsWith('<!-- /close -->\n\nThe story so far.\n')).toBe(true)
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
    expect(metrics).toContain('| variant | condition | recall | specificity | precision | line_ok | ask_ok | one_step | loaded | nudged | harmed | went_on | truncated | invalid | unlisted | errors |')
    expect(metrics).toContain('| baseline | clean | 83% | 75% | 83% | 60% | 67% | n/a | n/a | n/a | 1 (33%) | 50% | 1 | 1 | 0 | timeout 1 |')
    expect(metrics).toContain('| v1 | clean | 100% | 75% | 90% | 67% | 100% | n/a | n/a | n/a | 0 (0%) | n/a | 0 | 0 | 0 | serving_substitution 1 |')

    expect(headline).toContain('clean: v1 val 1.00 -> 2.63')
    expect(headline).toContain('within noise')
  })

  it('writes the held-out table between its markers', () => {
    writeSummaries(flow)
    const narrative = readFileSync(join(flow, 'narrative.md'), 'utf8')
    expect(narrative).not.toContain('old held-out')
    expect(narrative).toContain('<!-- /status -->\n\n<!-- held-out -->\n| variant | condition | recall | needless rings | line_ok | ask_ok | harmed | went_on | one_step | loaded | nudged | score vs baseline | recall vs base | recall p vs base |')
    expect(narrative).toContain('| baseline | clean | 4 of 5 | 0 of 2 | 4 of 4 | 5 of 5 | 2 of 4 | 2 of 3 | 0 of 4 | 0 of 0 | 0 of 0 |  | n/a | n/a |')
    expect(narrative).toContain('| v1 | clean | 5 of 5 | 1 of 2 | 4 of 5 | 5 of 5 | 0 of 2 | 0 of 0 | 0 of 6 | 0 of 0 | 0 of 0 | +1.17 [-4.96, 7.29] | n/a | n/a |\n<!-- /held-out -->')
  })

  it('gives the warnings with the headline, for the command to show', () => {
    appendFileSync(join(flow, 'baseline', 'errors.jsonl'), 'not json\n')
    expect(writeSummaries(flow).warnings).toEqual([`${join(flow, 'baseline', 'errors.jsonl')}:2: not JSON, skipped`])
  })

  it.each(['baseline/table.md', 'narrative.md', 'metrics.md'])('refuses to write %s through a symlink', (path) => {
    const target = join(flow, 'target.md')
    const text = '<!-- status -->\n<!-- /status -->\n<!-- held-out -->\n<!-- /held-out -->\n<!-- close -->\n<!-- /close -->\n<!-- aggregate -->\n<!-- /aggregate -->\n'
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
