import { describe, expect, it } from 'vitest'
import { admission } from './admission.js'
import { draftSchema, parse, type MemoryDraft, type SourceEvent } from './types.js'

const observation: SourceEvent = {
  id: 'measurement', profileId: 'owner', projectId: 'project', engine: 'codex', sessionId: 'session', nativeEventId: 'event',
  role: 'tool', eligibility: 'coding', observedAt: 1, rootIds: ['measurement'],
  text: 'At revision R1 in local fixture Q, two identical requests rendered once. No concurrent-worker or production check was performed.',
  verification: { method: 'test', result: 'passed', artifact: 'test_report', revision: 'R1', environment: 'local fixture Q',
    coverage: 'Two sequential identical requests.', limitations: ['No concurrent-worker or production check.'] },
}

function finding(changes: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    kind: 'verified_pitfall', facet: 'verification', assertionType: 'verified_finding', scope: { profileId: 'owner', projectId: 'project' },
    claim: 'Two identical requests rendered once in the local fixture at R1.', rationale: 'The test establishes sequential reuse in that fixture.',
    futureAction: 'Recheck concurrency separately before relying on this across workers.',
    applicability: { fixture: 'Q' }, exceptions: [], retrievalCues: ['cache'], evidenceClass: 'observed_verified',
    evidence: [{ sourceEventId: observation.id, quote: observation.text, paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'], verification: observation.verification }],
    conflictKey: 'cache_result', validity: { validFrom: null, validUntil: null, recheckWhen: ['Worker topology changes.'] }, ...changes,
  }
}

describe('evidence and measurement admission', () => {
  it('accepts a finding tied to actual source verification and rejects invented verification metadata', () => {
    expect(admission(finding(), new Map([[observation.id, observation]]))).toBe('active')
    const invented = finding()
    invented.evidence[0].verification = { ...observation.verification!, environment: 'production', coverage: 'All workers and all inputs.' }
    expect(() => admission(invented, new Map([[observation.id, observation]]))).toThrow('verification_mismatch')
  })

  it('does not promote an assistant success statement into a verified finding', () => {
    const assertion = { ...observation, role: 'assistant' as const }
    expect(() => admission(finding(), new Map([[assertion.id, assertion]]))).toThrow('unsupported_assertion')
  })

  it('requires evidence for material detail fields instead of letting explanations invent outcomes', () => {
    const draft = finding({ details: { decision: { observedOutcome: 'Latency dropped by half everywhere.' } } })
    expect(() => admission(draft, new Map([[observation.id, observation]]))).toThrow('evidence_coverage')
  })

  it.each(['/futureAction', '/exceptions', '/validity'])('requires evidence for behavioral field %s', field => {
    const draft = finding({ exceptions: [{ when: { concurrency: true }, reason: 'The fixture did not check concurrency.' }] })
    draft.evidence[0].paths = draft.evidence[0].paths.filter(path => path !== field)
    expect(() => admission(draft, new Map([[observation.id, observation]]))).toThrow('evidence_coverage')
  })

  it('rejects a quote from a different project and missing field pointers', () => {
    expect(() => admission(finding(), new Map([[observation.id, { ...observation, projectId: 'another_project' }]]))).toThrow('evidence_scope')
    const draft = finding()
    draft.evidence[0].paths.push('/details/missing')
    expect(() => admission(draft, new Map([[observation.id, observation]]))).toThrow('evidence_path')
  })

  it('rejects invented state and permissions in a model proposal', () => {
    expect(() => parse(draftSchema, { ...finding(), state: 'active', publication: 'approved' })).toThrow('invalid_input')
  })

  it('normalizes a failed-run sentinel while preserving typed failure and comparison conditions', () => {
    const draft = finding({ details: { experiment: {
      objective: { metric: 'validation_loss', direction: 'lower' }, evaluator: { revision: 'E1' }, dataset: { revision: 'D1' },
      environment: { hardware: 'GPU_A' }, budget: { value: 300, unit: 'seconds', includes: 'training', excludes: ['startup'] },
      runs: [{ id: 'candidate', codeRevision: 'R2', status: 'crashed', score: 0, disposition: 'discarded', artifact: 'crash_report' }],
      result: 'No candidate evaluation completed.', limitations: ['Failed run has no valid score.'],
    } } })
    const parsed = parse(draftSchema, draft)
    expect(parsed.details?.experiment?.runs?.[0]).toMatchObject({ status: 'crashed', score: null, disposition: 'discarded' })
    draft.details!.experiment!.runs![0].disposition = 'kept'
    expect(() => parse(draftSchema, draft)).toThrow('invalid_input')
  })

  it('requires evaluator, data, resource conditions, and tool evidence for measured runs', () => {
    const missing = { ...finding(), details: { experiment: { result: 'A score', limitations: [],
      runs: [{ id: 'baseline', codeRevision: 'R1', status: 'completed', score: 1, disposition: 'pending', artifact: 'report' }] } } }
    expect(() => parse(draftSchema, missing)).toThrow('invalid_input')
    expect(() => parse(draftSchema, { ...missing, details: { experiment: { ...missing.details.experiment,
      evaluator: { revision: 'E1' }, dataset: { revision: 'D1' }, environment: { hardware: 'GPU_A' },
      objective: { metric: 'loss', direction: 'lower' }, budget: { value: 300, unit: 'seconds', includes: 'training', excludes: [] },
      runs: [{ ...missing.details.experiment.runs[0], score: null }],
    } } })).toThrow('invalid_input')
  })
})
