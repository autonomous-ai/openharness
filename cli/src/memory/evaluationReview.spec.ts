import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { evaluateExtractionCase, type ExtractionCase } from './evaluation.js'
import { prepareEvaluationReview, scoreEvaluationReview } from './evaluationReview.js'
import type { MemoryDraft } from './types.js'

const fixture: ExtractionCase = { id: 'example', projectId: null,
  sources: [{ role: 'user', text: 'For debugging I prefer a small failing test first.' },
    { role: 'user', text: 'For release notes I prefer a compatibility section.' }],
  expected: { records: { min: 2, max: 2 }, scope: 'personal', rationale: 'null', review: ['Preserve the two conditional preferences.'] },
  probes: [{ id: 'tests', query: 'failing test', projectIds: ['alpha'], conditions: { taskType: 'debugging' }, expected: 'recall' },
    { id: 'unrelated', query: 'orchids', projectIds: ['alpha'], conditions: {}, expected: 'abstain' }] }
const drafts: MemoryDraft[] = fixture.sources.map((source, index) => ({
  kind: 'working_preference', facet: 'workflow', assertionType: 'stated_preference', scope: { profileId: 'synthetic-owner' },
  claim: source.text, rationale: null, futureAction: source.text,
  applicability: { taskType: index ? 'release' : 'debugging' }, exceptions: [], retrievalCues: [index ? 'release' : 'test'],
  evidenceClass: 'user_stated', evidence: [{ sourceEventId: `example-${index}`, quote: source.text, paths: ['/claim', '/futureAction', '/applicability'] }],
  conflictKey: index ? 'release_order' : 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
let directory: string, suiteText: string, result: Awaited<ReturnType<typeof evaluateExtractionCase>>
const report = () => JSON.stringify({ schemaVersion: 1, suite: 'review-test', suiteSha256: hash(suiteText),
  status: 'completed', selected: { model: 'MODEL_LABEL_SHOULD_BE_HIDDEN' }, cases: [result] })
const testing = () => result.records.find(r => r.conflictKey === 'debugging_order')!.id
const release = () => result.records.find(r => r.conflictKey === 'release_order')!.id
function recalled(ids: string[]) {
  const p = result.probes[0]
  const text = JSON.stringify({ type: 'coding_memory_context', items: ids.map(id => result.records.find(r => r.id === id)) })
  p.returnedIds = ids
  p.context = { text, bytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 3), maxBytes: 3_000 }
}
function labels(reportText = report()) {
  const packet = prepareEvaluationReview(suiteText, reportText)
  return { ...packet.review, reviewer: { id: 'reviewer-a', kind: 'agent' as const, independent: false },
    cases: packet.review.cases.map(row => ({ id: row.id,
      records: row.records.map(r => ({ ...r, supported: true, specific: true, useful: true, note: 'The source states this conditional preference.' })),
      probes: row.probes.map(p => ({ ...p, relevantIds: p.id === 'tests' ? [testing()] : [],
        requiredIds: p.id === 'tests' ? [testing()] : [], missingRequiredMemory: false, faithfulContext: true,
        note: 'Judge against the source and the frozen task conditions.' })) })) }
}
const score = (review = labels(), reportText = report()) => scoreEvaluationReview(suiteText, reportText, JSON.stringify(review))
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'memory-quality-review-'))
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [fixture] })
  result = await evaluateExtractionCase({ fixture, directory, engine: 'claude', inference: {
    target: async () => ({ state: 'ready', key: 'context' }), run: async () => JSON.stringify({ proposals: drafts }),
  } })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('prepares sources, criteria and blank labels without exposing model labels or assigning a grade', () => {
  expect(result.checks.every(check => check.passed)).toBe(true)
  const packet = prepareEvaluationReview(suiteText, report())
  expect(packet.cases[0].sources.map(s => s.id)).toEqual(['example-0', 'example-1'])
  expect(packet.cases[0].sources[0].text).toBe(fixture.sources[0].text)
  expect(packet.review.cases[0].records.every(r => r.supported === null && r.note === null)).toBe(true)
  expect(JSON.stringify(packet)).not.toContain('MODEL_LABEL_SHOULD_BE_HIDDEN')
  const unreviewed = scoreEvaluationReview(suiteText, report(), JSON.stringify(packet.review))
  expect(unreviewed.memories).toMatchObject({ total: 2, reviewed: 0, rate: null })
  expect(unreviewed.recall.rate).toBeNull()
})

it('keeps attributed semantic review separate from native delivery and task benefit', () => {
  const scored = score()
  expect(scored.memories).toEqual({ total: 2, reviewed: 2, passed: 2, rate: 1 })
  expect(scored.recall.rate).toBe(1)
  expect(scored.abstention.rate).toBe(1)
  expect(scored.reviewer?.kind).toBe('agent')
  expect(scored.evidence).toBe('development_diagnostic_only')
  expect(scored.taskBenefit).toBe('not_measured')
  expect(scored.nativeDelivery).toBe('not_measured')
})

it('shows bounded context to the reviewer and rejects a missing or changed capture boundary', () => {
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [{ ...fixture, boundary: 'bounded' }] })
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('evaluation_boundary_changed')
  result.episodes.boundary = 'bounded'
  const packet = prepareEvaluationReview(suiteText, report())
  expect(packet.cases[0].sources.every(source => source.boundary === 'bounded')).toBe(true)
  const missing = JSON.parse(report())
  delete missing.cases[0].episodes.boundary
  expect(() => prepareEvaluationReview(suiteText, JSON.stringify(missing))).toThrow('evaluation_boundary_changed')
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [fixture] })
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('evaluation_boundary_changed')
})

it('fails a nonempty recall of the wrong memory even when the older presence check passed', () => {
  recalled([release()])
  expect(result.probes[0].passed).toBe(true)
  expect(score().recall).toEqual({ passed: 0, reviewed: 1, total: 1, rate: 0 })
})

it('does not hide irrelevant extras or an unmet need behind one useful recalled memory', () => {
  recalled([testing(), release()])
  expect(score().recall.rate).toBe(0)
  recalled([testing()])
  const review = labels()
  review.cases[0].probes[0].missingRequiredMemory = true
  expect(score(review).recall.rate).toBe(0)
  review.cases[0].probes[0].missingRequiredMemory = false
  review.cases[0].probes[0].faithfulContext = false
  expect(score(review).recall.rate).toBe(0)
})

it('does not accept a relevant-looking but unsupported or unspecified memory judgement', () => {
  const review = labels()
  review.cases[0].records.find(r => r.id === testing())!.supported = false
  expect(score(review).recall.rate).toBe(0)
  expect(score(review).memories.rate).toBe(.5)
  const partial = { ...review, cases: [{ ...review.cases[0], records: [] }] }
  expect(score(partial).memories.rate).toBeNull()
  expect(score(partial).recall.rate).toBeNull()
})

it('keeps an incomplete relevance judgement pending instead of requiring a particular fill order', () => {
  const review = labels()
  const partial = { ...review, cases: [{ ...review.cases[0], probes: review.cases[0].probes.map(p =>
    p.id === 'tests' ? { ...p, relevantIds: null } : p) }] }
  expect(scoreEvaluationReview(suiteText, report(), JSON.stringify(partial)).recall.rate).toBeNull()
})

it('scores completed abstention while leaving an empty memory-quality denominator unknown', async () => {
  const empty: ExtractionCase = { ...fixture, id: 'empty', sources: [{ role: 'user', text: 'Thanks.' }],
    expected: { ...fixture.expected, records: { min: 0, max: 0 }, scope: 'none' }, probes: [fixture.probes[1]] }
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [empty] })
  result = await evaluateExtractionCase({ fixture: empty, directory: join(directory, 'empty'), engine: 'claude', inference: {
    target: async () => ({ state: 'ready', key: 'context' }), run: async () => JSON.stringify({ proposals: [] }),
  } })
  expect(score().memories).toEqual({ passed: 0, reviewed: 0, total: 0, rate: null })
  expect(score().abstention.rate).toBe(1)
})

it('refuses changed files, record versions, duplicate labels and invented record references', () => {
  const review = labels()
  expect(() => score(review, `${report()}\n`)).toThrow('evaluation_review_changed')
  expect(() => prepareEvaluationReview(`${suiteText}\n`, report())).toThrow('evaluation_suite_changed')
  review.cases[0].records[0].revision++
  expect(() => score(review)).toThrow('review_record_changed')
  const duplicate = labels()
  duplicate.cases[0].records.push(duplicate.cases[0].records[0])
  expect(() => score(duplicate)).toThrow('duplicate_evaluation_id')
  const invented = labels()
  invented.cases[0].probes[0].relevantIds = ['made-up']
  expect(() => score(invented)).toThrow('unknown_review_memory')
})

it('refuses a changed probe or a review that rewrites an abstention requirement', () => {
  const review = labels()
  review.cases[0].probes[1].relevantIds = [testing()]
  expect(() => score(review)).toThrow('abstention_review_changed')
  result.probes[0].query = 'different task'
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('evaluation_probe_changed')
})

it('requires the actual bounded recall context before crediting correct-memory recall', () => {
  result.probes[0].context!.bytes++
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
  result.probes[0].context!.bytes--
  result.probes[0].context!.maxBytes = 10
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
  result.probes[0].context = null
  expect(score().memories.rate).toBe(1)
  expect(score().recall.rate).toBeNull()
})

it('keeps failed extraction and unfinished suites out of passing quality denominators', () => {
  const review = labels()
  result.outcome = { state: 'waiting_for_model' }
  const text = report()
  const packet = prepareEvaluationReview(suiteText, text)
  const unavailable = scoreEvaluationReview(suiteText, text, JSON.stringify(packet.review))
  expect(packet.review.cases).toEqual([])
  expect(unavailable.coverage).toEqual({ completedCases: 0, expectedCases: 1 })
  expect(unavailable.memories.rate).toBeNull()
  expect(unavailable.abstention.rate).toBeNull()
  expect(() => score({ ...review, reportSha256: hash(text) }, text)).toThrow('case_not_reviewable')
  result.outcome = { state: 'learned', learned: 2 }
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [fixture, { ...fixture, id: 'not-run' }] })
  expect(score().coverage).toEqual({ completedCases: 1, expectedCases: 2 })
  expect(score().memories.rate).toBeNull()
  expect(score().recall.rate).toBeNull()
})
