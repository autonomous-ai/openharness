import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { builtinSqlite } from '../../../cli/src/lib/sqliteBuiltin.js'
import type { Database } from './database.js'
import type { LibraryCommand } from './library.js'
import type { MemoryDeliveryBinding } from './receipts.js'
import type { Conditions, MemoryAccess, MemoryDraft, MemoryRecord, SourceEvent } from './types.js'

let directory: string, store: CodingMemoryStore, now: number, record: MemoryRecord
const access = { profileId: 'owner', projectIds: ['project'], includeProfile: true }
const binding: MemoryDeliveryBinding = { engine: 'codex', sessionId: 'private_receiver_lemur', projectId: 'project', route: 'prompt_hook' }
const claim = 'For coding changes, keep reviews small. feedback_claim_iguana'
const source: SourceEvent = { id: 'statement', profileId: 'owner', projectId: null, engine: 'claude', sessionId: 'source_session',
  nativeEventId: 'statement', role: 'user', eligibility: 'coding', observedAt: 900, rootIds: ['statement'], text: claim }
const draft: MemoryDraft = { kind: 'working_preference', facet: 'changes', assertionType: 'stated_preference',
  scope: { profileId: 'owner' }, claim, rationale: null, futureAction: 'Keep coding reviews small.',
  applicability: {}, exceptions: [], retrievalCues: ['reviews'], evidenceClass: 'user_stated',
  evidence: [{ sourceEventId: source.id, quote: claim, paths: ['/claim', '/futureAction', '/applicability', '/validity'] }],
  conflictKey: 'change_size', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-feedback-'))
  now = 1_000
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  store.registerProject('project'); store.registerProject('other_project')
  store.setControls({ learn: true, recall: true })
  store.ingest(source)
  record = store.propose(draft, access).record
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function recall(next = binding) {
  now++
  return store.prepareRecall({ query: 'small reviews private_prompt_capuchin' }, next,
    { ...access, projectIds: next.projectId ? [next.projectId] : [] }).receipt!
}
function command(receiptId: string, value: 'helpful' | 'unhelpful' | null = 'helpful', expected = 0): Extract<LibraryCommand, { kind: 'feedback' }> {
  return { kind: 'feedback', id: record.id, revision: record.revision, receiptId, value, expected }
}
function apply(value: LibraryCommand) {
  const preview = store.libraryPreview('owner', value)
  return store.libraryApply('owner', value, preview.version, false)
}
function recalls() { return store.libraryDetail('owner', record.id)!.recalls }

it('shows recent recall per receiving session without retaining prompts or raw receiver identity', () => {
  const first = recall()
  const latest = recall({ ...binding, route: 'mcp' })
  recall({ ...binding, sessionId: 'second_session' })
  expect(recalls()).toHaveLength(2)
  expect(recalls()[1]).toMatchObject({ receiptId: latest.id, revision: 1, engine: 'codex',
    route: 'mcp', delivery: 'unverified', preparedAt: latest.preparedAt, emittedAt: null,
    feedback: { value: null, version: 0, updatedAt: null }, project: { id: 'project' } })
  expect(recalls().some(item => item.receiptId === first.id)).toBe(false)
  const bytes = readFileSync(join(directory, 'memory.sqlite'))
  expect(bytes.includes(Buffer.from(binding.sessionId))).toBe(false)
  expect(bytes.includes(Buffer.from('private_prompt_capuchin'))).toBe(false)
  expect(() => store.libraryDetail('other_owner', record.id)).toThrow('scope_denied')
})

it('records explicit feedback only after apply and never changes the claim, support or delivery claim', () => {
  const received = recall()
  const before = store.support(record.id, access)
  const preview = store.libraryPreview('owner', command(received.id))
  expect(preview.effects.feedback).toMatchObject({ value: 'helpful', version: 1 })
  expect(recalls()[0].feedback.value).toBeNull()
  store.libraryApply('owner', preview.command, preview.version, false)
  expect(recalls()[0]).toMatchObject({ feedback: { value: 'helpful', version: 1 }, delivery: 'unverified' })
  expect(store.read(record.id, access)).toEqual(record)
  expect(store.support(record.id, access)).toEqual(before)
  expect(store.recallReceipts(binding, access)[0].delivery).toBe('unverified')
  const repeated = recall({ ...binding, route: 'manual' })
  expect(recalls()).toHaveLength(1)
  expect(recalls()[0]).toMatchObject({ receiptId: repeated.id, feedback: { value: 'helpful', version: 1 } })
  apply(command(repeated.id, 'unhelpful', 1))
  expect(recalls()[0].feedback).toMatchObject({ value: 'unhelpful', version: 2 })
  apply(command(repeated.id, null, 2))
  expect(recalls()[0].feedback).toMatchObject({ value: null, version: 3 })
  expect(store.support(record.id, access)).toEqual(before)
})

it('rejects concurrent feedback changes and ignores no-op feedback without inventing extra votes', () => {
  const receipt = recall()
  const earlier = store.libraryPreview('owner', command(receipt.id, 'unhelpful'))
  apply(command(receipt.id))
  expect(() => store.libraryApply('owner', earlier.command, earlier.version, false)).toThrow('feedback_changed')
  apply(command(receipt.id, 'helpful', 1))
  expect(recalls()[0].feedback.version).toBe(1)
  expect(() => apply(command(receipt.id, null))).toThrow('feedback_changed')
})

it('binds feedback to the exact selected memory revision and preserves separate task contexts', () => {
  const receipt = recall()
  apply(command(receipt.id))
  recall({ ...binding, sessionId: 'other_session' })
  recall({ ...binding, projectId: 'other_project' })
  expect(recalls().map(item => item.feedback.value)).toEqual([null, null, 'helpful'])
  expect(() => apply({ ...command(receipt.id), revision: 2 })).toThrow('revision_conflict')
  expect(() => apply(command('unknown_receipt'))).toThrow('recall_unavailable')
  const otherSource = { ...source, id: 'other', nativeEventId: 'other', rootIds: ['other'], text: 'For coding changes, review documentation too.' }
  store.ingest(otherSource)
  const unrelated = store.propose({ ...draft, conflictKey: 'documentation', claim: otherSource.text,
    futureAction: 'Review documentation.', evidence: [{ ...draft.evidence[0], sourceEventId: 'other', quote: otherSource.text }] }, access).record
  expect(() => apply({ ...command(receipt.id), id: unrelated.id })).toThrow('recall_unavailable')
})

it('does not transfer a rating across different known conditions or explicit task and branch scopes', () => {
  const receipt = recall()
  apply(command(receipt.id))
  const variants: Array<{ access: MemoryAccess; conditions: Conditions }> = [
    { access, conditions: { task: 'debugging', platform: 'mac' } },
    { access: { ...access, taskId: 'second_task' }, conditions: {} },
    { access: { ...access, branchId: 'second_branch' }, conditions: {} },
  ]
  for (const variant of variants) {
    now++
    const prepared = store.prepareRecall({ query: 'reviews', conditions: variant.conditions }, binding, variant.access)
    expect(prepared.receipt).not.toBeNull()
    expect(recalls()[0]).toMatchObject({ receiptId: prepared.receipt!.id, feedback: { value: null, version: 0 } })
  }
  now++
  store.prepareRecall({ query: 'reviews', conditions: { platform: 'mac', task: 'debugging' } }, binding, access)
  expect(recalls()).toHaveLength(4)
  expect(recalls().filter(item => item.feedback.value === 'helpful')).toHaveLength(1)
})

it('withholds private receiving projects before the history limit, even for a visible personal memory', () => {
  const visible = recall({ ...binding, projectId: 'other_project' })
  for (let index = 0; index < 30; index++) recall({ ...binding, sessionId: `hidden_${index}` })
  store.setProjectIncluded('project', false)
  expect(store.libraryDetail('owner', record.id)).not.toBeNull()
  expect(recalls().map(item => item.receiptId)).toEqual([visible.id])
})

it('withdraws receiver-session feedback on privacy changes without reviving it on reinclusion', () => {
  const receipt = recall()
  apply(command(receipt.id))
  const preview = store.libraryPreview('owner', command(receipt.id, 'unhelpful', 1))
  store.setSessionIncluded(binding.engine, binding.sessionId, false)
  expect(recalls()).toEqual([])
  expect(() => store.libraryApply('owner', preview.command, preview.version, false)).toThrow('preview_changed')
  store.setSessionIncluded(binding.engine, binding.sessionId, true)
  expect(recalls()).toEqual([])
  expect(() => apply(command(receipt.id, 'unhelpful', 1))).toThrow('recall_unavailable')
  recall()
  expect(recalls()[0].feedback).toEqual({ value: null, version: 0, updatedAt: null })
  expect(store.read(record.id, access)).toEqual(record)
})

it('withholds source-private memory and does not transfer feedback to a corrected revision', () => {
  const receipt = recall()
  apply(command(receipt.id))
  store.setSessionIncluded(source.engine, source.sessionId, false)
  expect(store.libraryDetail('owner', record.id)).toBeNull()
  expect(() => apply(command(receipt.id, 'unhelpful', 1))).toThrow('not_found')
  store.setSessionIncluded(source.engine, source.sessionId, true)
  const { claim: original, rationale, futureAction, applicability, exceptions, retrievalCues, validity } = record
  record = store.libraryCorrect('owner', record.id, 1, { claim: `${original} Prefer related groups.`,
    rationale, futureAction, applicability, exceptions, retrievalCues, validity })
  expect(recalls()).toEqual([])
  expect(() => apply(command(receipt.id))).toThrow('recall_unavailable')
  recall()
  expect(recalls()[0].feedback.value).toBeNull()
})

it('expires feedback with its receipt and forgetting leaves no deleted claim text', () => {
  const receipt = recall()
  apply(command(receipt.id))
  now += 30 * 86_400_000
  expect(recalls()).toEqual([])
  expect(() => apply(command(receipt.id, 'unhelpful', 1))).toThrow('recall_unavailable')
  store.maintain()
  recall()
  expect(recalls()[0].feedback.value).toBeNull()
  store.libraryForget('owner', record.id, record.revision)
  expect(store.libraryDetail('owner', record.id)).toBeNull()
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('feedback_claim_iguana'))).toBe(false)
})

it('expires an older rating even when a newer recall in that session is still retained', () => {
  const receipt = recall()
  apply(command(receipt.id))
  now += 29 * 86_400_000
  const newer = recall()
  now += 2 * 86_400_000
  expect(recalls()[0]).toMatchObject({ receiptId: newer.id, feedback: { value: null, version: 0 } })
  apply(command(newer.id, 'unhelpful'))
  expect(recalls()[0].feedback).toMatchObject({ value: 'unhelpful', version: 1 })
})

it('honors session privacy written by an earlier daemon without the new activity cleanup hook', () => {
  const receipt = recall()
  apply(command(receipt.id))
  const Sqlite = builtinSqlite() as unknown as new (path: string) => Database
  const legacy = new Sqlite(join(directory, 'memory.sqlite'))
  try {
    legacy.prepare('INSERT INTO memory_session_policy VALUES(?,?,?,?,?)')
      .run(binding.engine, binding.sessionId, 0, 1, now)
  } finally { legacy.close() }
  expect(recalls()).toEqual([])
  expect(() => apply(command(receipt.id, 'unhelpful', 1))).toThrow('recall_unavailable')
})

it('does not invent receiver context when opening pre-feedback receipts', () => {
  const receipt = recall()
  store.close()
  const Sqlite = builtinSqlite() as unknown as new (path: string) => Database
  const legacy = new Sqlite(join(directory, 'memory.sqlite'))
  try { legacy.exec('DROP TABLE memory_recall_feedback; DROP TABLE memory_receipt_context;') }
  finally { legacy.close() }
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  expect(store.recallReceipts(binding, access)[0].id).toBe(receipt.id)
  expect(recalls()).toEqual([])
  expect(() => apply(command(receipt.id))).toThrow('recall_unavailable')
  recall()
  expect(recalls()).toHaveLength(1)
})
