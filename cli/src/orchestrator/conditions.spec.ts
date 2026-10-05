import { describe, expect, it } from 'vitest'
import { evaluateCondition, parseCondition, type Condition } from './conditions.js'

const parsed = (text: string): Condition => { const c = parseCondition(text); if ('error' in c) throw new Error(c.error); return c }
describe('conditions', () => {
  it('fails instead of throwing on a count that is not a whole number', () => {
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      for (const field of ['errors', 'warnings'] as const) {
        const verdict = { ready: true, errors: 0, warnings: 0, [field]: bad }
        const text = `a.verdict.${field} == 0`
        expect(evaluateCondition(parseCondition(text) as Condition, { state: 'succeeded', verdict }))
          .toEqual({ ok: false, reason: `a has a verdict.${field} of ${bad}, which is not a whole number; the condition ${text} cannot be evaluated.` })
      }
    }
  })
  it('compares whole numbers of any size exactly', () => {
    const at = (text: string, errors: number) => evaluateCondition(parseCondition(text) as Condition, { state: 'succeeded', verdict: { ready: true, errors, warnings: 0 } })
    expect(parseCondition('a.verdict.errors < 1000000000')).toMatchObject({ value: '1000000000' })
    expect(at('a.verdict.errors < 1000000000', 999_999_999)).toEqual({ ok: true, value: true })
    expect(at('a.verdict.errors >= 18446744073709551616', 5)).toEqual({ ok: true, value: false })
    // above 2^53 Number() rounds 9007199254740993 to 9007199254740992; exact comparison keeps them apart
    expect(at('a.verdict.errors == 9007199254740993', 9_007_199_254_740_992)).toEqual({ ok: true, value: false })
    expect(at('a.verdict.errors < 9007199254740993', 9_007_199_254_740_992)).toEqual({ ok: true, value: true })
    expect(at('a.verdict.errors >= 9007199254740993', 9_007_199_254_740_992)).toEqual({ ok: true, value: false })
    expect(parseCondition('a.verdict.errors == 01')).toEqual({ error: 'verdict.errors is compared with a whole number.' })
  })

  it('parses one comparison with optional spaces', () => {
    expect(parsed('review.verdict.errors==0')).toMatchObject({ task: 'review', field: 'verdict.errors', op: '==', value: '0' })
    expect(parsed('  tests.state != failed ')).toMatchObject({ task: 'tests', field: 'state', op: '!=', value: 'failed', text: 'tests.state != failed' })
    expect(parsed('choose.decision == ship')).toMatchObject({ field: 'decision', value: 'ship' })
  })
  it.each([
    ['', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.state == succeeded && b.state == succeeded', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.output == x', 'Write one comparison, like "review.verdict.errors == 0".'],
    ['a.state < succeeded', 'Only verdict.errors and verdict.warnings can be compared with <, <=, > or >=.'],
    ['a.state == done', 'a state is one of succeeded, failed, skipped, cancelled, blocked.'],
    ['a.verdict.ready == yes', 'verdict.ready is true or false.'],
    ['a.verdict.errors >= -1', 'verdict.errors is compared with a whole number.'],
    ['a.decision == Ship', 'a decision id looks like ship or needs-work.'],
  ])('rejects %j', (text, error) => { expect(parseCondition(text)).toEqual({ error }) })
  it('evaluates against a snapshot', () => {
    expect(evaluateCondition(parsed('t.state == failed'), { state: 'failed' })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.errors > 0'), { state: 'succeeded', verdict: { ready: true, errors: 2, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.ready == false'), { state: 'succeeded', verdict: { ready: true, errors: 0, warnings: 0 } })).toEqual({ ok: true, value: false })
    expect(evaluateCondition(parsed('t.verdict.ready == true'), { state: 'succeeded', verdict: { ready: true, errors: 0, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.warnings <= 1'), { state: 'failed', verdict: { ready: false, errors: 0, warnings: 1 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('t.verdict.warnings < 1'), { state: 'failed', verdict: { ready: false, errors: 0, warnings: 1 } })).toEqual({ ok: true, value: false })
    expect(evaluateCondition(parsed('t.verdict.errors >= 1'), { state: 'failed', verdict: { ready: false, errors: 1, warnings: 0 } })).toEqual({ ok: true, value: true })
    expect(evaluateCondition(parsed('c.decision != ship'), { state: 'succeeded', decision: 'rework' })).toEqual({ ok: true, value: true })
  })
  it('cannot evaluate what the dependency never recorded', () => {
    expect(evaluateCondition(parsed('review.verdict.errors == 0'), { state: 'succeeded' }))
      .toEqual({ ok: false, reason: 'review wrote no verdict; the condition review.verdict.errors == 0 cannot be evaluated.' })
    expect(evaluateCondition(parsed('ok.decision == ship'), { state: 'failed' }))
      .toEqual({ ok: false, reason: 'ok has no decision; the condition ok.decision == ship cannot be evaluated.' })
  })
})
