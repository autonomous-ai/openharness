import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import type { MemoryDeliveryBinding } from './receipts.js'
import type { MemoryDraft, SourceEvent } from './types.js'

let directory: string, store: CodingMemoryStore, now: number
const access = { profileId: 'owner', projectIds: ['project'], includeProfile: true }
const binding: MemoryDeliveryBinding = { engine: 'codex', sessionId: 'receiving_session', projectId: 'project', route: 'prompt_hook' }
const preference = 'For coding changes, keep each review small. receipt_unique_lemur'
const source: SourceEvent = { id: 'statement', profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'source_session',
  nativeEventId: 'statement', role: 'user', eligibility: 'coding', observedAt: 900, rootIds: ['statement'], text: preference }
const draft: MemoryDraft = { kind: 'working_preference', facet: 'changes', assertionType: 'stated_preference',
  scope: { profileId: 'owner', projectId: 'project' }, claim: preference, rationale: null,
  futureAction: 'Keep coding changes small.', applicability: {}, exceptions: [], retrievalCues: ['changes'],
  evidenceClass: 'user_stated', evidence: [{ sourceEventId: source.id, quote: preference,
    paths: ['/claim', '/futureAction', '/applicability', '/validity'] }],
  conflictKey: 'change_size', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-receipts-'))
  now = 1_000
  const result = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!result.ok) throw new Error(result.reason)
  store = result.store
  store.registerProject('project'); store.registerProject('another_project')
  store.setControls({ learn: true, recall: true })
  store.ingest(source)
  store.propose(draft, access)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('tracks selected and emitted packets separately without claiming delivery or adding support', () => {
  const prepared = store.prepareRecall({ query: 'coding changes private_query_iguana' }, binding, access)
  expect(prepared.receipt).toMatchObject({ preparedAt: 1_000, emittedAt: null, delivery: 'unverified',
    items: [{ id: prepared.packet.items[0].id, revision: 1, current: true }] })
  expect(JSON.parse(prepared.packet.text).receiptId).toBe(prepared.receipt!.id)
  expect(Buffer.byteLength(prepared.packet.text)).toBe(prepared.receipt!.bytes)
  now += 10
  expect(store.recallEmitted(prepared.receipt!.id, binding, access)).toBe(true)
  now += 10
  expect(store.recallEmitted(prepared.receipt!.id, binding, access)).toBe(true)
  expect(store.recallReceipts(binding, access)).toEqual([{ ...prepared.receipt, emittedAt: 1_010 }])
  expect(store.support(prepared.packet.items[0].id, access)?.independentUserStatements).toBe(1)
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('private_query_iguana'))).toBe(false)
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(binding.sessionId))).toBe(false)
})

it('requires the original owner, engine, session, project and transport binding', () => {
  const prepared = store.prepareRecall({ query: 'changes' }, binding, access)
  const variants: MemoryDeliveryBinding[] = [
    { ...binding, engine: 'claude' }, { ...binding, sessionId: 'another_session' },
    { ...binding, projectId: 'another_project' }, { ...binding, route: 'mcp' },
  ]
  for (const other of variants) {
    expect(store.recallReceipts(other, access)).toEqual([])
    expect(store.recallEmitted(prepared.receipt!.id, other, access)).toBe(false)
  }
  const foreign = { ...access, profileId: 'someone_else' }
  expect(store.recallReceipts(binding, foreign)).toEqual([])
  expect(store.recallEmitted(prepared.receipt!.id, binding, foreign)).toBe(false)
  expect(store.prepareRecall({ query: 'changes' }, binding, foreign).packet.status).toBe('denied')
  expect(store.prepareRecall({ query: 'changes' }, { ...binding, projectId: null }, access).packet.status).toBe('denied')
  expect(store.prepareRecall({ query: 'changes' }, binding, { ...access, projectIds: ['project', 'another_project'] }).packet.status).toBe('denied')
})

it('does not allocate a receipt for off, irrelevant, private or over-budget recall', () => {
  expect(store.prepareRecall({ query: 'aardvark' }, binding, access).receipt).toBeNull()
  expect(store.prepareRecall({ query: 'changes', maxBytes: 400 }, binding, access).receipt).toBeNull()
  store.setControls({ learn: false, recall: false })
  expect(store.prepareRecall({ query: 'changes' }, binding, access).packet.status).toBe('off')
  store.setControls({ learn: false, recall: true })
  store.setSessionIncluded(binding.engine, binding.sessionId, false)
  expect(store.prepareRecall({ query: 'changes' }, binding, access).packet.status).toBe('denied')
  store.setSessionIncluded(binding.engine, binding.sessionId, true)
  expect(store.recallReceipts(binding, access)).toEqual([])
})

it('includes its receipt ID inside the exact context byte budget', () => {
  const roomy = store.prepareRecall({ query: 'changes' }, binding, access)
  const required = Buffer.byteLength(roomy.packet.text)
  const result = store.prepareRecall({ query: 'changes', maxBytes: required + 64 }, binding, access)
  expect(result.packet.items).toHaveLength(1)
  expect(Buffer.byteLength(result.packet.text)).toBeLessThanOrEqual(required + 64)
  expect(store.prepareRecall({ query: 'changes', maxBytes: required - 1 }, binding, access).packet.items).toEqual([])
})

it('retains only opaque revision references after forgetting and never preserves the deleted claim', () => {
  const prepared = store.prepareRecall({ query: 'changes' }, binding, access)
  store.forget(prepared.packet.items[0].id, 1, access)
  expect(store.recallReceipts(binding, access)[0].items).toEqual([{ id: prepared.packet.items[0].id, revision: 1, current: false }])
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('receipt_unique_lemur'))).toBe(false)
  expect(store.recallEmitted(prepared.receipt!.id, binding, access)).toBe(true)
  const next = store.prepareRecall({ query: 'another unrelated task' }, binding, access)
  expect(next.packet.items).toEqual([])
  expect(JSON.parse(next.packet.text)).toMatchObject({ withdrawn: {
    references: [{ id: prepared.packet.items[0].id, revision: 1 }], more: false,
  } })
  expect(next.packet.text).not.toContain('receipt_unique_lemur')
  expect(store.prepareRecall({ query: 'another task' }, { ...binding, sessionId: 'other_session' }, access).packet.text).toBe('')
})

it('marks an old revision as no longer current after correction or source privacy changes', () => {
  const prepared = store.prepareRecall({ query: 'changes' }, binding, access)
  store.setSessionIncluded(source.engine, source.sessionId, false)
  expect(store.recallReceipts(binding, access)[0].items[0].current).toBe(false)
  expect(JSON.parse(store.prepareRecall({ query: 'unrelated task' }, binding, access).packet.text).withdrawn.references)
    .toEqual([{ id: prepared.packet.items[0].id, revision: 1 }])
  store.setSessionIncluded(source.engine, source.sessionId, true)
  expect(store.recallReceipts(binding, access).find(receipt => receipt.id === prepared.receipt!.id)!.items[0].current).toBe(true)
  expect(store.prepareRecall({ query: 'unrelated task' }, binding, access).packet.text).toBe('')
  const correction = { ...source, id: 'correction', nativeEventId: 'correction', rootIds: ['correction'], text: 'For coding changes, group related modules.' }
  store.ingest(correction)
  store.revise(prepared.packet.items[0].id, 1, { ...draft, claim: correction.text,
    evidence: [{ ...draft.evidence[0], sourceEventId: correction.id, quote: correction.text }] }, access)
  expect(store.recallReceipts(binding, access).find(receipt => receipt.id === prepared.receipt!.id)!.items[0].current).toBe(false)
  expect(JSON.parse(store.prepareRecall({ query: 'unrelated task' }, binding, access).packet.text).withdrawn.references)
    .toEqual([{ id: prepared.packet.items[0].id, revision: 1 }])
})

it('expires receipt metadata after thirty days, including its revision links', () => {
  const prepared = store.prepareRecall({ query: 'changes' }, binding, access)
  now += 30 * 86_400_000
  expect(store.recallReceipts(binding, access)).toEqual([])
  expect(store.recallEmitted(prepared.receipt!.id, binding, access)).toBe(false)
  store.maintain()
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(prepared.receipt!.id))).toBe(false)
  expect(store.read(prepared.packet.items[0].id, access)).not.toBeNull()
})
