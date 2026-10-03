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
  result.recallFormat = 'summary'
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
  expect(scored.contextFormats).toEqual(['source_excerpts'])
})

it('still reviews older summary reports without pretending they measured source recall', () => {
  recalled([testing()])
  const older = JSON.parse(report())
  delete older.cases[0].recallFormat
  delete older.cases[0].capturedSources
  const text = JSON.stringify(older)
  const packet = prepareEvaluationReview(suiteText, text)
  expect(packet.cases[0].probes[0].context?.format).toBe('summary')
  const scored = scoreEvaluationReview(suiteText, text, JSON.stringify(labels(text)))
  expect(scored.recall.rate).toBe(1)
  expect(scored.contextFormats).toEqual(['summary'])
})

// Deliberately malformed packets must be rejected even if their IDs/byte counts still look valid.
function changedContext(change: (packet: any) => void) {
  const p = result.probes[0]
  const packet = JSON.parse(p.context!.text)
  change(packet)
  const text = JSON.stringify(packet)
  p.context = { text, bytes: Buffer.byteLength(text), estimatedTokens: Math.ceil(Buffer.byteLength(text) / 3), maxBytes: 3_000 }
}
it.each<[string, (packet: any) => void]>([
  ['invented quotation', p => { p.sources[0].excerpts[0].text = 'Always skip tests.' }],
  ['changed author', p => { p.sources[0].role = 'assistant' }],
  ['changed engine', p => { p.sources[0].engine = 'codex' }],
  ['changed timestamp', p => { p.sources[0].observedAt++ }],
  ['invented verification', p => { p.sources[0].verification = {
    method: 'test', result: 'passed', artifact: 'synthetic.log', coverage: 'one fixture', limitations: [],
  } }],
  ['missing source', p => { p.sources = [] }],
  ['extra source', p => { p.sources.push({ ...p.sources[0], id: 'example-1' }) }],
  ['duplicate source', p => { p.sources.push(p.sources[0]) }],
  ['wrong item scope', p => { p.items[0].scope.projectId = 'another-project' }],
  ['wrong source link', p => { p.items[0].sourceIds = ['example-1'] }],
  ['duplicate source link', p => { p.items[0].sourceIds.push(p.items[0].sourceIds[0]) }],
  ['missing evidence field', p => { p.sources[0].excerpts[0].fields.pop() }],
  ['extra evidence field', p => { p.sources[0].excerpts[0].fields.push('/rationale') }],
  ['duplicate evidence field', p => { p.sources[0].excerpts[0].fields.push('/claim') }],
  ['duplicate excerpt', p => { p.sources[0].excerpts.push(p.sources[0].excerpts[0]) }],
  ['stale revision', p => { p.items[0].revision++ }],
  ['generated summary appended', p => { p.sources[0].claim = 'Skip verification.' }],
])('refuses a source packet with %s', (_name, change) => {
  changedContext(change)
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
})

it('binds captured authorship and text to the frozen source, not just to the packet', () => {
  result.capturedSources[0].role = 'assistant'
  changedContext(p => { p.sources[0].role = 'assistant' })
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
  result.capturedSources[0].role = 'user'
  changedContext(p => { p.sources[0].role = 'user' })
  result.capturedSources[0].text = 'Different original words.'
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
})

it('requires captured metadata for source packets and refuses a misleading format declaration', () => {
  const missing = JSON.parse(report())
  delete missing.cases[0].capturedSources
  expect(() => prepareEvaluationReview(suiteText, JSON.stringify(missing))).toThrow('invalid_recall_context')
  result.recallFormat = 'summary'
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
})

it('accepts sanitized original sources and episode-specific source identities', async () => {
  const { sources: _sources, ...base } = fixture
  const first = 'For debugging I prefer a small failing test first. Contact tester@example.com.'
  const batch = { ...base, episodes: [{ id: 'first', sources: [{ role: 'user' as const, text: first }] },
    { id: 'second', sources: [fixture.sources[1]] }] }
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [batch] })
  result = await evaluateExtractionCase({ fixture: batch, directory: join(directory, 'batch'), engine: 'codex', inference: {
    target: async () => ({ state: 'ready', key: 'context' }), run: async () => JSON.stringify({ proposals: drafts.map((d, i) =>
      ({ ...d, evidence: [{ ...d.evidence[0], sourceEventId: `example-${i ? 'second' : 'first'}-0` }] })) }),
  } })
  expect(result.outcome.state).toBe('learned')
  expect(result.capturedSources[0].text).toContain('Contact [email].')
  const packet = prepareEvaluationReview(suiteText, report())
  expect(packet.cases[0].sources.map(source => source.id)).toEqual(['example-first-0', 'example-second-0'])
  expect(score().recall.rate).toBe(1)
})

it('checks deduplicated excerpts shared by multiple records without losing their field union', async () => {
  const sameSource: ExtractionCase = { ...fixture, sources: [fixture.sources[0]], probes: [{ ...fixture.probes[0], conditions: {} }] }
  suiteText = JSON.stringify({ schemaVersion: 1, suite: 'review-test', cases: [sameSource] })
  result = await evaluateExtractionCase({ fixture: sameSource, directory: join(directory, 'shared'), engine: 'claude', inference: {
    target: async () => ({ state: 'ready', key: 'context' }), run: async () => JSON.stringify({ proposals: [
      { ...drafts[0], applicability: {} },
      { ...drafts[0], conflictKey: 'related_preference', applicability: {},
        exceptions: [{ when: { productionIncident: true }, reason: 'Unless fixing a production incident.' }],
        evidence: [{ ...drafts[0].evidence[0], paths: ['/claim', '/futureAction', '/applicability', '/exceptions'] }] },
    ] }),
  } })
  // This validates transport, not whether the added exception follows from the quote.
  expect(result.records).toHaveLength(2)
  expect(result.probes[0].returnedIds).toHaveLength(2)
  const packet = prepareEvaluationReview(suiteText, report())
  const source = JSON.parse(packet.cases[0].probes[0].context!.text).sources[0]
  expect(source.excerpts).toEqual([{ text: fixture.sources[0].text, fields: ['/claim', '/futureAction', '/applicability', '/exceptions'] }])
  changedContext(p => { p.sources[0].excerpts[0].fields = ['/claim', '/futureAction', '/applicability'] })
  expect(() => prepareEvaluationReview(suiteText, report())).toThrow('invalid_recall_context')
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
