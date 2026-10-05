import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { builtinSqlite } from '../../../cli/src/lib/sqliteRead.js'
import type { Database } from './database.js'
import { CodingMemoryStore } from './store.js'
import type { MemoryDeliveryBinding } from './receipts.js'
import type { Conditions, MemoryAccess, MemoryDraft, MemoryRecord, SourceEvent } from './types.js'

let directory: string, store: CodingMemoryStore, now: number, tests: MemoryRecord, docs: MemoryRecord
const access: MemoryAccess = { profileId: 'owner', projectIds: ['project'], includeProfile: true }
const binding: MemoryDeliveryBinding = { engine: 'claude', sessionId: 'rated_session', projectId: 'project', route: 'prompt_hook' }
const conditions: Conditions = { task: 'bug_fix', language: 'TypeScript' }
const query = { query: 'review changes', conditions, maxBytes: 16_000 }

function remember(id: string, claim: string, cues = ['review', 'changes'],
  changes: Partial<Pick<MemoryDraft, 'scope' | 'conflictKey'>> = {}): MemoryRecord {
  const source: SourceEvent = { id, profileId: 'owner', projectId: changes.scope?.projectId ?? null, engine: 'claude', sessionId: `source_${id}`,
    nativeEventId: id, role: 'user', eligibility: 'coding', observedAt: now, rootIds: [id], text: claim }
  const draft: MemoryDraft = { kind: 'working_preference', facet: 'review', assertionType: 'stated_preference',
    scope: { profileId: 'owner' }, claim, rationale: null, futureAction: claim, applicability: {}, exceptions: [],
    retrievalCues: cues, evidenceClass: 'user_stated', conflictKey: id,
    evidence: [{ sourceEventId: id, quote: claim, paths: ['/claim', '/futureAction', '/applicability'] }],
    validity: { validFrom: null, validUntil: null, recheckWhen: [] }, ...changes }
  store.ingest(source)
  return store.propose(draft, access).record
}
function open() {
  const result = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!result.ok) throw new Error(result.reason)
  store = result.store
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-usefulness-'))
  now = 1_000
  open()
  store.registerProject('project'); store.registerProject('other_project')
  store.setControls({ learn: true, recall: true })
  tests = remember('tests', 'For changes, review the tests before merging.')
  docs = remember('docs', 'For changes, review the docs before merging.')
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function order(request = query, scope = access) { return store.recall(request, scope).items.map(item => item.id) }
function rate(receiptId: string, value: 'helpful' | 'unhelpful' | null, expected = 0, record = tests) {
  const command = { kind: 'feedback' as const, id: record.id, revision: record.revision, receiptId, value, expected }
  const preview = store.libraryPreview('owner', command)
  return store.libraryApply('owner', command, preview.version, false)
}
function receive(next = binding, scope = access, request = query) {
  ++now
  return store.prepareRecall(request, next, scope).receipt!
}
function legacyWrite(sql: string) {
  const Native = builtinSqlite()!
  const db = new Native(join(directory, 'memory.sqlite'), { readOnly: false }) as unknown as Database
  try { db.exec(sql) } finally { db.close() }
}

it('uses explicit feedback across frameworks without changing facts, evidence or delivery claims', () => {
  expect(order()).toEqual([docs.id, tests.id])
  const support = store.support(tests.id, access)
  const received = receive()
  rate(received.id, 'helpful')
  expect(order()).toEqual([tests.id, docs.id])
  const next = store.prepareRecall(query, { ...binding, engine: 'codex', sessionId: 'new_session' }, access)
  expect(next.packet.items.map(item => item.id)).toEqual([tests.id, docs.id])
  expect(next.receipt!.delivery).toBe('unverified')
  expect(store.read(tests.id, access)).toEqual(tests)
  expect(store.support(tests.id, access)).toEqual(support)
  expect(store.libraryDetail('owner', tests.id)!.recalls.find(use => use.receiptId === received.id))
    .toMatchObject({ feedback: { value: 'helpful' }, canGuideRecall: true })
  rate(received.id, 'unhelpful', 1)
  expect(order()).toEqual([docs.id, tests.id])
  rate(received.id, null, 2)
  expect(order()).toEqual([docs.id, tests.id])
})

it('keeps changed conditions, project, task, branch, missing context and foreign owners separate', () => {
  rate(receive().id, 'helpful')
  expect(order({ ...query, conditions: { language: 'TypeScript', task: 'bug_fix' } })).toEqual([tests.id, docs.id])
  const variants: Conditions[] = [{}, { task: 'feature', language: 'TypeScript' }, { ...conditions, platform: 'mac' }]
  for (const variant of variants) {
    expect(order({ ...query, conditions: variant })).toEqual([docs.id, tests.id])
  }
  for (const scope of [
    { ...access, projectIds: ['other_project'] }, { ...access, projectIds: [] },
    { ...access, projectIds: ['project', 'other_project'] },
    { ...access, taskId: 'different_task' }, { ...access, branchId: 'different_branch' },
  ]) expect(order(query, scope)).toEqual([docs.id, tests.id])
  expect(order(query, { ...access, profileId: 'foreign' })).toEqual([])
})

it('does not reinforce repeated recalls or transport retries without another explicit rating', () => {
  const first = receive()
  for (let index = 0; index < 30; index++) receive({ ...binding, route: index % 2 ? 'mcp' : 'manual' })
  expect(order()).toEqual([docs.id, tests.id])
  rate(first.id, 'helpful')
  for (let index = 0; index < 30; index++) {
    const again = receive({ ...binding, route: 'mcp' })
    rate(again.id, 'helpful', 1)
  }
  expect(store.libraryDetail('owner', tests.id)!.recalls).toHaveLength(1)
  rate(receive().id, null, 1)
  expect(order()).toEqual([docs.id, tests.id])
})

it('cannot make an irrelevant or substantially weaker lexical match outrank better evidence', () => {
  const strongest = remember('merge', 'For changes, review tests and merge only after verification.', ['review', 'merge'])
  const rated = remember('unrelated', 'When tending orchids, keep the room humid.', ['orchids'])
  const unrelated = receive(binding, access, { ...query, query: 'orchids' })
  rate(unrelated.id, 'helpful', 0, rated)
  for (let index = 0; index < 30; index++) rate(receive({ ...binding, sessionId: `rated_${index}` }).id, 'helpful')
  expect(order({ ...query, query: 'review merge' })[0]).toBe(strongest.id)
  expect(order()).not.toContain(rated.id)
  expect(order({ ...query, query: 'aardvark' })).toEqual([])
  expect(store.recall({ ...query, maxBytes: 20 }, access).items).toEqual([])
})

it('drops a private receiver’s influence permanently and honors policy changes from older writers', () => {
  rate(receive().id, 'helpful')
  expect(order()[0]).toBe(tests.id)
  legacyWrite("INSERT INTO memory_session_policy(engine,session_id,included,epoch,live_from) VALUES('claude','rated_session',0,1,1000)")
  expect(order()).toEqual([docs.id, tests.id])
  store.setSessionIncluded('claude', 'rated_session', false)
  store.setSessionIncluded('claude', 'rated_session', true)
  expect(order()).toEqual([docs.id, tests.id])
})

it('does not let a helpful personal default override a project requirement', () => {
  rate(receive().id, 'helpful')
  expect(order()[0]).toBe(tests.id)
  const requirement = remember('project_tests', 'For changes, review the production tests before merging.',
    ['review', 'changes'], { scope: { profileId: 'owner', projectId: 'project' }, conflictKey: tests.conflictKey })
  expect(order()).toContain(requirement.id)
  expect(order()).not.toContain(tests.id)
  expect(order(query, { ...access, projectIds: ['other_project'] })).toEqual([docs.id, tests.id])
})

it('removes receiving-project activity and influence before reinclusion, including an older writer', () => {
  rate(receive().id, 'helpful')
  store.setProjectIncluded('project', false)
  expect(order()).toEqual([docs.id, tests.id])
  store.setProjectIncluded('project', true)
  expect(order()).toEqual([docs.id, tests.id])
  rate(receive({ ...binding, sessionId: 'fresh' }).id, 'helpful')
  expect(order()[0]).toBe(tests.id)
  legacyWrite("UPDATE projects SET included=0 WHERE id='project'")
  store.setProjectIncluded('project', true)
  expect(order()).toEqual([docs.id, tests.id])
})

it('ignores expired and legacy ratings while leaving retained owner history inspectable', () => {
  rate(receive().id, 'helpful')
  store.close()
  legacyWrite('DROP TABLE memory_receipt_relevance')
  open()
  expect(order()).toEqual([docs.id, tests.id])
  expect(store.libraryDetail('owner', tests.id)!.recalls[0])
    .toMatchObject({ feedback: { value: 'helpful' }, canGuideRecall: false })
  rate(receive({ ...binding, sessionId: 'fresh_session' }).id, 'helpful')
  expect(order()[0]).toBe(tests.id)
  now += 30 * 86_400_000
  expect(order()).toEqual([docs.id, tests.id])
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('fresh_session'))).toBe(false)
})

it('does not transfer ratings to a corrected revision or expose excluded source memories', () => {
  rate(receive().id, 'helpful')
  const { claim, rationale, futureAction, applicability, exceptions, retrievalCues, validity } = tests
  store.libraryCorrect('owner', tests.id, tests.revision, { claim, rationale, futureAction, applicability, exceptions, retrievalCues, validity })
  expect(order()).toEqual([docs.id, tests.id])
  store.setSessionIncluded('claude', 'source_docs', false)
  expect(order()).not.toContain(docs.id)
  store.forget(tests.id, 2, access)
  expect(order()).toEqual([])
})
