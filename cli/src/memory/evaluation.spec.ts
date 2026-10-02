import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { evaluateExtractionCase, type ExtractionCase, type ExtractionBatchCase } from './evaluation.js'
import { nativeMemoryUsage } from './inferenceProcess.js'
import type { MemoryDraft } from './types.js'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'memory-evaluation-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const fixture: ExtractionCase = {
  id: 'synthetic', projectId: null,
  sources: [{ role: 'user', text: 'For debugging I prefer a small failing test first.' }],
  expected: { records: { min: 1, max: 1 }, scope: 'personal', rationale: 'null', review: ['SECRET_EXPECTATION_NOT_IN_PROMPT'] },
  probes: [{ id: 'expected', query: 'failing test', projectIds: ['alpha'], conditions: { taskType: 'debugging' }, expected: 'recall' },
    { id: 'negative', query: 'failing test', projectIds: ['alpha'], conditions: {}, expected: 'abstain' }],
}
const draft: MemoryDraft = {
  kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference', scope: { profileId: 'synthetic-owner' },
  claim: 'For debugging prefer a small failing test first.', rationale: null, futureAction: 'Start with a small failing test.',
  applicability: { taskType: 'debugging' }, exceptions: [], retrievalCues: ['test'], evidenceClass: 'user_stated',
  evidence: [{ sourceEventId: 'synthetic-0', quote: fixture.sources[0].text, paths: ['/claim', '/futureAction', '/applicability'] }],
  conflictKey: 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] },
}
function provider(proposals: MemoryDraft[]) {
  return { target: async () => ({ state: 'ready' as const, key: 'synthetic-context' }), run: vi.fn(async () => JSON.stringify({ proposals })) }
}

it('runs real admission and scoped recall without leaking its rubric or probes to inference', async () => {
  const inference = provider([draft])
  const result = await evaluateExtractionCase({ fixture, directory, engine: 'claude', inference })
  expect(result.outcome).toEqual({ state: 'learned', learned: 1 })
  expect(result.checks.every(check => check.passed)).toBe(true)
  expect(result.semanticReview.status).toBe('pending')
  const prompt = (inference.run.mock.calls[0] as unknown as [string])[0]
  expect(prompt).toContain(fixture.sources[0].text)
  expect(prompt).not.toContain('SECRET_EXPECTATION_NOT_IN_PROMPT')
  expect(prompt).not.toContain('"id":"negative"')
})

it('exposes independently specified condition mismatch instead of copying generated keys into the probe', async () => {
  const result = await evaluateExtractionCase({ fixture, directory, engine: 'codex',
    inference: provider([{ ...draft, applicability: { task: 'debugging' } }]) })
  expect(result.outcome.state).toBe('learned')
  expect(result.checks.find(check => check.name === 'recall:expected')?.passed).toBe(false)
})

it('never scores invalid output as successful abstention', async () => {
  const empty: ExtractionCase = { ...fixture, expected: { ...fixture.expected, records: { min: 0, max: 0 }, scope: 'none' }, probes: [] }
  const inference = provider([])
  inference.run = vi.fn(async () => 'not json')
  const result = await evaluateExtractionCase({ fixture: empty, directory, engine: 'claude', inference })
  expect(result.outcome.state).toBe('failed')
  expect(result.records).toEqual([])
  expect(result.checks.find(check => check.name === 'completed_extraction')?.passed).toBe(false)
  expect(result.checks.find(check => check.name === 'record_count')?.passed).toBeNull()
  expect(result.semanticReview.status).toBe('not_reviewable')
})

it('marks recall probes inconclusive when the selected provider is unavailable', async () => {
  const result = await evaluateExtractionCase({ fixture, directory, engine: 'claude', inference: {
    target: async () => ({ state: 'ready', key: 'synthetic-context' }), run: async () => null,
  } })
  expect(result.probes.every(probe => probe.status === 'not_run' && probe.passed === null)).toBe(true)
  expect(result.checks.filter(check => check.name !== 'completed_extraction').every(check => check.passed === null)).toBe(true)
})

it('evaluates separate sessions together without leaking their rubric, and reports each episode outcome', async () => {
  const { sources, ...base } = fixture
  const batch: ExtractionBatchCase = { ...base, episodes: [{ id: 'preference', sources },
    { id: 'unrelated', sources: [{ role: 'assistant', text: 'I used MongoDB for a throwaway experiment.' }, { role: 'user', text: 'Thanks.' }] }] }
  const inference = provider([{ ...draft, evidence: [{ ...draft.evidence[0], sourceEventId: 'synthetic-preference-0' }] }])
  const result = await evaluateExtractionCase({ fixture: batch, directory, engine: 'claude', inference })
  expect(result.checks.every(check => check.passed)).toBe(true)
  expect(result.episodes).toEqual({ expected: 2, reviewed: 2, jobs: { learned: 1, no_useful_memory: 1 }, boundary: 'complete' })
  expect(result.semanticReview.status).toBe('pending')
  expect(inference.run).toHaveBeenCalledOnce()
  const prompt = (inference.run.mock.calls[0] as unknown as [string])[0]
  expect(prompt).not.toContain('SECRET_EXPECTATION_NOT_IN_PROMPT')
  expect(prompt).not.toContain('"id":"negative"')
  expect(prompt).toContain('synthetic-synthetic-preference')
  expect(prompt).toContain('synthetic-synthetic-unrelated')
})

it('does not score a partial batch as successful abstention when input limits leave episodes queued', async () => {
  const { sources: _sources, ...base } = fixture
  const batch: ExtractionBatchCase = { ...base, expected: { ...base.expected, records: { min: 0, max: 0 }, scope: 'none' },
    episodes: Array.from({ length: 4 }, (_, index) => ({ id: `large-${index}`, sources: [{ role: 'user', text: 'x'.repeat(32_000) }] })) }
  const result = await evaluateExtractionCase({ fixture: batch, directory, engine: 'claude', inference: provider([]) })
  expect(result.outcome.state).toBe('no_useful_memory')
  expect(result.episodes).toEqual({ expected: 4, reviewed: 2, jobs: { no_useful_memory: 2, queued: 2 }, boundary: 'complete' })
  expect(result.checks[0]).toEqual({ name: 'completed_extraction', passed: false })
  expect(result.checks.slice(1).every(check => check.passed === null)).toBe(true)
  expect(result.probes.every(probe => probe.status === 'not_run')).toBe(true)
  expect(result.semanticReview.status).toBe('not_reviewable')
})

it('rejects an oversized diagnostic group before invoking inference', async () => {
  const { sources, ...base } = fixture
  const inference = provider([])
  const batch: ExtractionBatchCase = { ...base, episodes: Array.from({ length: 5 }, (_, index) => ({ id: `case-${index}`, sources })) }
  await expect(evaluateExtractionCase({ fixture: batch, directory, engine: 'claude', inference })).rejects.toThrow('invalid_evaluation_episodes')
  expect(inference.run).not.toHaveBeenCalled()
})

it('runs bounded excerpts under the real queue restriction and exposes the boundary in its report', async () => {
  const inferred: MemoryDraft = { ...draft, assertionType: 'observed_usage', evidenceClass: 'inferred' }
  const complete = await evaluateExtractionCase({ fixture, directory, engine: 'codex', inference: provider([inferred]) })
  expect(complete.outcome).toEqual({ state: 'learned', learned: 1 })
  const inference = provider([inferred])
  const bounded = await evaluateExtractionCase({ fixture: { ...fixture, boundary: 'bounded' },
    directory: join(directory, 'bounded'), engine: 'codex', inference })
  expect(bounded.outcome).toEqual({ state: 'failed', reason: 'bounded_context_evidence' })
  expect(bounded.episodes.boundary).toBe('bounded')
  expect(bounded.records).toEqual([])
  expect(bounded.probes.every(probe => probe.status === 'not_run')).toBe(true)
  expect((inference.run.mock.calls[0] as unknown as [string])[0]).toContain('"context":"bounded"')
})

it('rejects an unrecognized boundary before calling the model', async () => {
  const inference = provider([])
  await expect(evaluateExtractionCase({ fixture: { ...fixture, boundary: 'partial' as 'bounded' }, directory, engine: 'codex', inference }))
    .rejects.toThrow('invalid_evaluation_boundary')
  expect(inference.run).not.toHaveBeenCalled()
})

it.each([undefined, {}, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 2 },
  { input_tokens: 1.1, output_tokens: 2 }, { input_tokens: 2, output_tokens: '3' }])('keeps unknown/invalid native usage unknown', value => {
  expect(nativeMemoryUsage(value)).toBeUndefined()
})
