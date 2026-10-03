import { expect, it } from 'vitest'
import { extractionSources, resolveExtractionProposals } from './extractionEvidence.js'
import { admission } from './admission.js'
import { MemoryError, type MemoryDraft, type SourceEvent } from './types.js'

const source: SourceEvent = { id: 'source', profileId: 'owner', projectId: 'project', engine: 'codex',
  sessionId: 'session', nativeEventId: 'event', role: 'user', eligibility: 'coding', observedAt: 1,
  rootIds: ['root'], text: 'Use PostgreSQL by default.  Keep the reason unknown.\r\n🌱' }
const draft: MemoryDraft = { scope: { profileId: 'owner', projectId: 'project' }, kind: 'working_preference',
  facet: 'database', assertionType: 'stated_preference', claim: 'Use PostgreSQL by default.', rationale: null,
  futureAction: 'Default to PostgreSQL.', applicability: {}, exceptions: [], retrievalCues: ['database'],
  evidenceClass: 'user_stated', evidence: [{ sourceEventId: source.id, quote: source.text,
    paths: ['/claim', '/futureAction', '/applicability'] }], conflictKey: 'default_database',
  validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
const reference = { ref: 's0p0', paths: draft.evidence[0].paths }
const answer = (evidence: unknown[] = [reference]) => ({ proposals: [{ ...draft, evidence }] })

it.each([
  source.text,
  'a'.repeat(3999) + '🌱' + 'b'.repeat(4001),
  ('line  with spaces\r\n\r\n🌱\n').repeat(1500).slice(0, 32000),
  ('a\n').repeat(16000),
  'a'.repeat(32000),
])('preserves full source text and metadata across bounded exact excerpts %#', text => {
  const original = { ...source, text, taskId: 'task', branchId: 'branch' }
  const [{ excerpts, ...metadata }] = extractionSources([original])
  expect(metadata).toEqual(Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'text')))
  expect(excerpts.map(part => part.text).join('')).toBe(text)
  expect(excerpts.length).toBeLessThanOrEqual(16)
  expect(new Set(excerpts.map(part => part.ref)).size).toBe(excerpts.length)
  for (const part of excerpts) {
    expect(part.text.length).toBeGreaterThan(0)
    expect(part.text.length).toBeLessThanOrEqual(4000)
    expect(text.includes(part.text)).toBe(true)
    // Our fixtures contain only paired surrogates. Serialization must not strand either half.
    expect(part.text).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u)
    const [resolved] = resolveExtractionProposals(answer([{ ...reference, ref: part.ref }]), [original])
    expect(resolved.evidence[0].quote).toBe(part.text)
  }
})

it('resolves only the supplied lease and keeps different source identities distinct', () => {
  const other = { ...source, id: 'other', nativeEventId: 'other', role: 'assistant' as const }
  const [resolved] = resolveExtractionProposals(answer([{ ...reference, ref: 's1p0' }]), [source, other])
  expect(resolved.evidence[0].sourceEventId).toBe(other.id)
  expect(() => resolveExtractionProposals(answer([{ ...reference, ref: 's1p0' }]), [source]))
    .toThrow(new MemoryError('evidence_reference'))
})

it.each([
  { quote: 'Different text' }, { sourceEventId: 'other' },
  { verification: { method: 'test', result: 'passed', artifact: 'made-up', coverage: 'all', limitations: [] } },
])('rejects model overrides of host-owned evidence metadata: %j', override => {
  expect(() => resolveExtractionProposals(answer([{ ...reference, ...override }]), [source])).toThrow(MemoryError)
})

it('copies captured verification, while its original source role still controls admission', () => {
  const verified: SourceEvent = { ...source, role: 'tool', verification: { method: 'test', result: 'passed',
    artifact: 'test.log', coverage: 'one regression', limitations: ['Not a general guarantee.'] } }
  const [resolved] = resolveExtractionProposals(answer(), [verified])
  expect(resolved.evidence[0]).toEqual({ ...draft.evidence[0], verification: verified.verification })
  expect(() => admission(resolved, new Map([[source.id, verified]]))).toThrow(new MemoryError('unsupported_assertion'))
  expect(resolveExtractionProposals(answer(), [source])[0].evidence[0]).not.toHaveProperty('verification')
})

it('applies persisted record size and validity refinements after expanding references', () => {
  const long = { ...source, text: 'a'.repeat(32000) }
  const refs = extractionSources([long])[0].excerpts.map(part => ({ ...reference, ref: part.ref }))
  expect(() => resolveExtractionProposals(answer(refs), [long])).toThrow(MemoryError)
  expect(() => resolveExtractionProposals({ proposals: [{ ...draft, evidence: [reference],
    validity: { validFrom: 2, validUntil: 1, recheckWhen: [] } }] }, [source])).toThrow(MemoryError)
})

it('preserves legacy evidence without silently repairing it', () => {
  const normalized = { ...draft.evidence[0], quote: source.text.replace('  ', ' ') }
  const [resolved] = resolveExtractionProposals(answer([normalized]), [source])
  expect(resolved.evidence).toEqual([normalized])
  expect(() => admission(resolved, new Map([[source.id, source]]))).toThrow(new MemoryError('evidence_mismatch'))
  expect(resolveExtractionProposals({ proposals: [draft] }, [source])).toEqual([draft])
})
