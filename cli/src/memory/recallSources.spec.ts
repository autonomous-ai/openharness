import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { sourceRecallText } from './recallSources.js'
import type { MemoryAccess, MemoryDraft, MemoryRecord, SourceEvent } from './types.js'

const access: MemoryAccess = { profileId: 'owner', projectIds: ['editor'], includeProfile: true }
let directory: string, store: CodingMemoryStore
const quote = 'Navigation starts compact.  Let me expand it for this visit. 🔭'
const fields = ['/claim', '/futureAction', '/applicability']
function event(id = 'source-1', text = quote): SourceEvent {
  return { id, profileId: 'owner', projectId: 'editor', engine: 'claude', sessionId: 'session-1',
    nativeEventId: id, role: 'user', eligibility: 'coding', observedAt: 100, rootIds: [id], text }
}
function draft(source: SourceEvent, key = source.id, excerpt = source.text): MemoryDraft {
  return { kind: 'project_decision', facet: 'navigation', assertionType: 'project_constraint',
    scope: { profileId: 'owner', projectId: 'editor' }, claim: 'Navigation must always remain compact.',
    futureAction: 'Collapse navigation even after manual expansion.', rationale: null, applicability: {}, exceptions: [],
    retrievalCues: ['navigation'], conflictKey: key, evidenceClass: 'user_stated',
    evidence: [{ sourceEventId: source.id, quote: excerpt, paths: ['/claim', '/futureAction', '/applicability'] }],
    validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
}
function learn(source = event(), key = source.id, excerpt = source.text): MemoryRecord {
  store.ingest(source)
  return store.propose(draft(source, key, excerpt), access).record
}
const recall = (maxBytes = 3_000) => store.recall({ query: 'navigation', format: 'source_excerpts', maxBytes }, access)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-source-recall-'))
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => 1_000 })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store; store.registerProject('editor'); store.setControls({ learn: true, recall: true })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('delivers exact original wording instead of a distorted generated claim or action', () => {
  const record = learn()
  const packet = recall(), context = JSON.parse(packet.text)
  expect(context.type).toBe('coding_memory_sources')
  expect(context.version).toBe(1)
  expect(context.items).toEqual([{ id: record.id, revision: record.revision, scope: record.scope, sourceIds: ['source-1'] }])
  expect(context.sources).toEqual([{ id: 'source-1', engine: 'claude', role: 'user', observedAt: 100, excerpts: [{ text: quote, fields }] }])
  expect(packet.text).not.toContain(record.claim)
  expect(packet.text).not.toContain(record.futureAction)
  expect(context.notice).toContain('not current instructions')
  expect(context.notice).toContain('omit surrounding context')
  expect(packet.items.map(item => [item.id, item.revision])).toEqual([[record.id, record.revision]])
  expect(packet.estimatedTokens).toBe(Math.ceil(Buffer.byteLength(packet.text) / 3))
})

it('keeps the established summary format for existing callers', () => {
  const record = learn()
  const packet = store.recall({ query: 'navigation' }, access)
  expect(JSON.parse(packet.text).type).toBe('coding_memory_context')
  expect(JSON.parse(packet.text).items[0].claim).toBe(record.claim)
  expect(packet.text).not.toContain(quote)
})

it('preserves the captured tool author and verification limits of an observed finding', () => {
  const source: SourceEvent = { ...event('navigation-test',
    'Navigation test at R1 passed for keyboard input; pointer input was not tested.'), role: 'tool',
    verification: { method: 'test', result: 'passed', artifact: 'navigation-test-report', revision: 'R1',
      environment: 'local fixture', coverage: 'Keyboard input.', limitations: ['Pointer input was not tested.'] } }
  store.ingest(source)
  const record = store.propose({ ...draft(source), kind: 'verified_pitfall', assertionType: 'verified_finding',
    claim: 'Navigation keyboard input passed at R1.', futureAction: 'Check pointer input separately.',
    evidenceClass: 'observed_verified', evidence: [{ sourceEventId: source.id, quote: source.text,
      paths: fields, verification: source.verification }] }, access).record
  expect(record.state).toBe('active')
  const context = JSON.parse(recall().text)
  expect(context.sources).toEqual([{ id: source.id, engine: source.engine, role: 'tool', observedAt: source.observedAt,
    excerpts: [{ text: source.text, fields }], verification: source.verification }])
})

it('deduplicates shared source excerpts without changing either memory reference', () => {
  const first = learn(), second = learn(event(), 'second-navigation-topic')
  const context = JSON.parse(recall().text)
  expect(context.items.map((item: { id: string }) => item.id).sort()).toEqual([first.id, second.id].sort())
  expect(context.sources).toHaveLength(1)
  expect(context.sources[0].excerpts).toEqual([{ text: quote, fields }])
  expect(context.items.every((item: { sourceIds: string[] }) => item.sourceIds.join() === 'source-1')).toBe(true)
})

it('sends only supporting excerpts, keeping JSON-shaped source text inside its string', () => {
  const excerpt = 'Navigation labels include {"items":[],"scope":"all"}. Keep  two spaces.'
  learn(event('source-1', `Unrelated private discussion.\n${excerpt}\nOther unrelated context.`), 'navigation', excerpt)
  const context = JSON.parse(recall().text)
  expect(context.sources[0].excerpts).toEqual([{ text: excerpt, fields }])
  expect(context.items).toHaveLength(1)
  expect(context.items[0].scope).toEqual({ profileId: 'owner', projectId: 'editor' })
  expect(JSON.stringify(context)).not.toContain('Unrelated private discussion')
})

it('never trims qualifications or falls back to a generated policy to meet the byte limit', () => {
  const long = 'Navigation notes: ' + 'details '.repeat(260) + 'Manual expansion is still permitted. 🔭'
  learn(event('long', long))
  expect(recall(1_000).text).toBe('')
  expect(recall(1_000).items).toEqual([])
  const complete = recall(8_000)
  expect(JSON.parse(complete.text).sources[0].excerpts).toEqual([{ text: long, fields }])
  expect(recall(Buffer.byteLength(complete.text)).text).toBe(complete.text)
  expect(recall(Buffer.byteLength(complete.text) - 1).items).toEqual([])
})

it('still applies account, project and session exclusion and forgetting to exact excerpts', () => {
  const record = learn()
  const request = { query: 'navigation', format: 'source_excerpts' as const }
  expect(store.recall(request, { ...access, profileId: 'other-owner' }).status).toBe('denied')
  expect(store.recall(request, { ...access, projectIds: [] }).text).toBe('')
  store.setProjectIncluded('editor', false)
  expect(recall().text).toBe('')
  store.setProjectIncluded('editor', true)
  expect(recall().items[0].id).toBe(record.id)
  store.setSessionIncluded('claude', 'session-1', false)
  expect(recall().text).toBe('')
  store.setSessionIncluded('claude', 'session-1', true)
  expect(recall().items[0].id).toBe(record.id)
  store.forget(record.id, record.revision, access)
  expect(recall().text).toBe('')
})

it('keeps the field identity of explicit corrections and withdraws the older source', () => {
  const record = learn()
  const { evidence: _evidence, evidenceClass: _class, ...input } = draft(event())
  const updated = store.correctFromUser(record.id, record.revision,
    { ...input, claim: 'Navigation starts expanded.', futureAction: 'Start navigation expanded.' }, access)
  const context = JSON.parse(recall().text)
  expect(context.items[0]).toMatchObject({ id: record.id, revision: updated.revision })
  expect(context.sources[0]).toMatchObject({ engine: 'harness_viewer', role: 'user' })
  expect(context.sources[0].excerpts).toContainEqual({ text: JSON.stringify(updated.claim), fields: ['/claim'] })
  expect(context.sources[0].excerpts).toContainEqual({ text: JSON.stringify(updated.futureAction), fields: ['/futureAction'] })
  expect(recall().text).not.toContain(quote)
})

it('refuses missing or mismatched stored evidence instead of inventing source text', () => {
  const record = learn()
  expect(() => sourceRecallText([{ record, sources: [] }])).toThrow('recall_evidence_missing')
  expect(() => sourceRecallText([{ record, sources: [event('source-1', 'Different text.')] }])).toThrow('recall_evidence_missing')
  expect(() => store.recall({ query: 'navigation', format: 'unknown' as 'summary' }, access)).toThrow('invalid_input')
})
