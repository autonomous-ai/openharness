import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { builtinSqlite } from '../lib/sqliteRead.js'
import type { Database as MemoryDatabase } from './database.js'
import type { NotebookLease } from './notebook.js'
import type { MemoryAccess, MemoryDraft, MemoryRecord, SourceEvent } from './types.js'

let directory: string, store: CodingMemoryStore, now: number
const target = { state: 'ready' as const, key: 'selected-companion:account:model:effort' }
const access: MemoryAccess = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
const statement = 'For this editor, keep persistence in SQLite because it works offline.'
const draft: MemoryDraft = { kind: 'project_decision', facet: 'storage', assertionType: 'accepted_decision',
  scope: { profileId: 'owner', projectId: 'project' }, claim: statement, rationale: 'The editor works offline.',
  futureAction: 'Keep persistence in SQLite.', applicability: { projectMode: 'offline_editor' }, exceptions: [],
  retrievalCues: ['editor', 'storage'], evidenceClass: 'user_stated',
  evidence: [{ sourceEventId: 'decision', quote: statement, paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/validity'] }],
  conflictKey: 'editor_storage', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
const source: SourceEvent = { id: 'decision', profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'decision_session',
  nativeEventId: 'decision', role: 'user', eligibility: 'coding', observedAt: 100, rootIds: ['decision'], text: statement }

beforeEach(() => {
  now = 1_000
  directory = mkdtempSync(join(tmpdir(), 'memory-notebook-'))
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  store.registerProject('project')
  store.setControls({ learn: true, recall: true })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function remember(change: Partial<MemoryDraft> = {}): MemoryRecord {
  store.ingest(source)
  return store.propose({ ...draft, ...change }, access).record
}
function claim(): NotebookLease {
  expect(store.notebookPending().state).toBe('ready')
  const result = store.notebookClaim(target)
  if (result.state !== 'claimed') throw new Error(result.state)
  return result.lease
}
function page(lease: NotebookLease) {
  const record = lease.input.records[0]
  return { statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: record.revision, paths: ['/claim'] }] }] }
}

function editDatabase(edit: (db: MemoryDatabase) => void): void {
  const Database = builtinSqlite()!
  const db = new Database(join(directory, 'memory.sqlite'), { readOnly: false }) as unknown as MemoryDatabase
  try { edit(db) } finally { db.close() }
}

it.each(['off', 'project', 'session', 'forgotten', 'expired'] as const)(
  'withdraws deferred notebook notices when work becomes %s', change => {
    const record = remember({ validity: { ...draft.validity, validUntil: now + 5_000 } })
    const lease = claim()
    store.notebookDefer(lease, 'waiting_for_model', 'companion_account_unavailable')
    expect(store.notebookPending()).toEqual({ state: 'waiting_for_model', prefer: false, reason: 'companion_account_unavailable' })
    if (change === 'off') store.setControls({ learn: false, recall: true })
    if (change === 'project') store.setProjectIncluded('project', false)
    if (change === 'session') store.setSessionIncluded(source.engine, source.sessionId, false)
    if (change === 'forgotten') store.forget(record.id, record.revision, access)
    if (change === 'expired') now += 5_001
    expect(store.notebookPending().state).toBe(change === 'off' ? 'learning_off' : 'idle')
    expect(store.learning.status().callsLastHour).toBe(1)
  },
)

it('adds wait metadata to an older store without changing its memories, controls or retry delay', () => {
  const record = remember(), controls = store.controls()
  const lease = claim()
  store.notebookDefer(lease, 'waiting_for_model', 'companion_stopped')
  store.close()
  editDatabase(db => { db.exec('DROP TABLE memory_notebook_waits') })
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  expect(store.notebookPending()).toEqual({ state: 'waiting_for_model', prefer: false })
  expect(store.list(access)).toEqual([record])
  expect(store.controls()).toEqual(controls)
  now += 60_001
  expect(store.notebookPending()).toEqual({ state: 'ready', prefer: false })
})

it.each(['version', 'updated_at'] as const)('discards an old reason after an older writer changes job %s', field => {
  remember()
  const lease = claim()
  store.notebookDefer(lease, 'waiting_for_model', 'companion_stopped')
  editDatabase(db => { db.prepare(`UPDATE memory_notebook_jobs SET ${field}=${field}+1 WHERE id=?`).run(lease.id) })
  expect(store.notebookPending()).toEqual({ state: 'waiting_for_model', prefer: false })
})

it('clears a previous wait reason before a new claim and never stores unknown provider text', () => {
  remember()
  const first = claim()
  store.notebookDefer(first, 'waiting_for_model', 'companion_stopped')
  now += 60_001
  const resumed = claim()
  editDatabase(db => { expect(db.prepare('SELECT * FROM memory_notebook_waits').all()).toEqual([]) })
  store.notebookDefer(resumed, 'waiting_for_model', 'secret-provider-response' as 'companion_stopped')
  expect(store.notebookPending()).toEqual({ state: 'waiting_for_model', prefer: false })
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('secret-provider-response'))).toBe(false)
})

it('builds a project explanation with exact source revisions and inherited conditions, without extra truth support', () => {
  const record = remember(), support = store.support(record.id, access)
  const lease = claim()
  expect(lease.input).toMatchObject({ records: [record], total: 1, unresolved: 0, nextChangeAt: null })
  expect(store.notebookFinish(lease, page(lease), target)).toEqual({ state: 'ready', topicId: lease.id })
  expect(store.topic(lease.id, access)).toMatchObject({ title: 'Storage', scope: draft.scope, revision: 1,
    statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: record.revision }],
      constraints: [{ memoryId: record.id, applicability: draft.applicability }] }] })
  expect(store.topic(lease.id, { ...access, profileId: 'another_owner' })).toBeNull()
  expect(store.support(record.id, access)).toEqual(support)
  expect(store.notebookPending().state).toBe('idle')
  expect(store.learning.status().callsLastHour).toBe(1)
})

it('clears the old explanation synchronously and rejects a response from before a correction', () => {
  const record = remember(), first = claim()
  store.notebookFinish(first, page(first), target)
  const { claim: original, rationale, futureAction, applicability, exceptions, retrievalCues, validity } = record
  const corrected = store.libraryCorrect('owner', record.id, 1, { claim: `${original} Recheck this for hosted editions.`,
    rationale, futureAction, applicability, exceptions, retrievalCues, validity })
  expect(store.topic(first.id, access)).toBeNull()
  expect(store.notebookFinish(first, page(first), target).state).toBe('stale')
  const next = claim()
  expect(next.input.records[0].revision).toBe(corrected.revision)
  expect(store.notebookFinish(next, page(next), target).state).toBe('ready')
  expect(store.topic(next.id, access)?.revision).toBe(2)
})

it('revokes in-flight pages on source/project privacy changes, without widening the remaining scope', () => {
  remember()
  const lease = claim()
  store.setSessionIncluded(source.engine, source.sessionId, false)
  expect(store.notebookFinish(lease, page(lease), target).state).toBe('stale')
  expect(store.notebookPending().state).toBe('idle')
  store.setSessionIncluded(source.engine, source.sessionId, true)
  const restored = claim()
  store.setProjectIncluded('project', false)
  expect(store.notebookFinish(restored, page(restored), target).state).toBe('stale')
  expect(store.notebookPending().state).toBe('idle')
})

it('ignores caller-supplied scope/input authority and rejects a dependency the model did not receive', () => {
  remember()
  const lease = claim(), result = page(lease)
  result.statements[0].supports[0].memoryId = 'unseen_record'
  expect(() => store.notebookFinish({ ...lease, scope: { profileId: 'other' }, input: { ...lease.input, records: [] } }, result, target))
    .toThrow('notebook_dependency')
  expect(store.topic(lease.id, access)).toBeNull()
  store.notebookFinish({ ...lease, scope: { profileId: 'other' }, input: { ...lease.input, records: [] } }, page(lease), target)
  expect(store.topic(lease.id, access)?.scope).toEqual(draft.scope)
})

it('keeps branch-specific work separate from the project-wide notebook', () => {
  const branchSource = { ...source, id: 'branch_decision', nativeEventId: 'branch_decision', rootIds: ['branch_decision'], branchId: 'experiment' }
  store.ingest(branchSource)
  const branchAccess = { ...access, branchId: 'experiment' }
  store.propose({ ...draft, scope: { ...draft.scope, branchId: 'experiment' },
    evidence: [{ ...draft.evidence[0], sourceEventId: branchSource.id }] }, branchAccess)
  const lease = claim()
  store.notebookFinish(lease, page(lease), target)
  expect(store.topic(lease.id, access)).toBeNull()
  expect(store.topic(lease.id, branchAccess)?.scope.branchId).toBe('experiment')
})

it('does not create a successful empty page or erase waiting work when the selected model changes', () => {
  remember()
  const lease = claim()
  expect(store.notebookFinish(lease, page(lease), { ...target, key: 'a-different-model' }).state).toBe('stale')
  expect(store.notebookPending().state).toBe('ready')
  const next = claim()
  expect(store.notebookFinish(next, { statements: [] }, target).state).toBe('empty')
  expect(store.topic(next.id, access)).toBeNull()
  expect(store.notebookPending().state).toBe('idle')
})

it('hides an expired explanation before the next background tick and handles future validity', () => {
  remember({ validity: { ...draft.validity, validFrom: now + 10, validUntil: now + 100 } })
  expect(store.notebookPending().state).toBe('idle')
  now += 10
  const lease = claim()
  expect(lease.input.nextChangeAt).toBe(1_100)
  store.notebookFinish(lease, page(lease), target)
  expect(store.topic(lease.id, access)).not.toBeNull()
  now = 1_100
  expect(store.topic(lease.id, access)).toBeNull()
  expect(store.notebookPending().state).toBe('idle')
})

it('does not revive a forgotten record through a late synthesis or retain its explanation text', () => {
  const record = remember(), lease = claim()
  store.notebookFinish(lease, page(lease), target)
  const forgotten = store.libraryForget('owner', record.id, record.revision)
  expect(forgotten.deletedTopicIds).toContain(lease.id)
  expect(store.topic(lease.id, access)).toBeNull()
  expect(store.notebookFinish(lease, page(lease), target).state).toBe('stale')
  expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(statement))).toBe(false)
  expect(store.notebookPending().state).toBe('idle')
})

it('recovers an expired lease after restart and keeps its already spent reservation', () => {
  remember()
  const abandoned = claim()
  store.close()
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  expect(store.notebookPending().state).toBe('idle')
  now += 120_001
  const replacement = claim()
  expect(store.notebookFinish(abandoned, page(abandoned), target).state).toBe('stale')
  expect(store.notebookFinish(replacement, page(replacement), target).state).toBe('ready')
  expect(store.learning.status().callsLastHour).toBe(2)
})

function captureEpisodes(count: number): void {
  for (let index = 0; index < count; index++) {
    const project = `coding_${index}`, id = `episode_${index}`
    store.registerProject(project)
    store.learning.capture({ streamId: id, engine: 'claude', sessionId: id, projectId: project,
      episodeId: id, from: null, to: '1', boundary: 'complete',
      events: [{ ...source, id, nativeEventId: id, sessionId: id, projectId: project, rootIds: [id] }] })
  }
}
function reviewEpisode(): void {
  const next = store.learning.claim(target)
  if (next.state !== 'claimed') throw new Error(next.state)
  store.learning.finish(next.lease, [], target)
}

it('shares the six-call budget across notebook generation and episode extraction', () => {
  remember()
  const lease = claim()
  store.notebookFinish(lease, page(lease), target)
  captureEpisodes(6)
  for (let count = 0; count < 5; count++) reviewEpisode()
  expect(store.learning.claim(target).state).toBe('budget_deferred')
  expect(store.learning.status().callsLastHour).toBe(6)
})

it('offers one existing budget slot to a waiting notebook during continuous episode intake', () => {
  remember(); captureEpisodes(6)
  for (let count = 0; count < 5; count++) reviewEpisode()
  expect(store.notebookPending()).toEqual({ state: 'ready', prefer: true })
  const lease = claim()
  store.notebookDefer(lease, 'queued')
  expect(store.notebookPending()).toEqual({ state: 'budget_deferred', prefer: false })
  expect(store.notebookClaim(target).state).toBe('idle')
  expect(store.learning.status().callsLastHour).toBe(6)
})

it.each([false, true])('bounds notebook input without hiding omitted coverage (large Unicode records: %s)', large => {
  for (let index = 0; index < 35; index++) remember({
    conflictKey: `decision_${index}`,
    ...(large ? {
      details: { reference: { notes: '示例说明'.repeat(1_000) } },
      evidence: [{ ...draft.evidence[0], paths: [...draft.evidence[0].paths, '/details'] }],
    } : {}),
  })
  const lease = claim()
  expect(lease.input.total).toBe(35)
  expect(lease.input.records.length).toBeLessThanOrEqual(24)
  expect(lease.input.records.length).toBeGreaterThan(0)
  expect(lease.input.records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)), 0)).toBeLessThanOrEqual(48_000)
  if (large) expect(lease.input.records.length).toBeLessThan(24)
  else expect(lease.input.records).toHaveLength(24)
  store.notebookFinish(lease, page(lease), target)
  const detail = store.libraryNotebook('owner', lease.id)!
  expect(detail.summary).toMatchObject({ activeRecords: 35, supportingRecords: 1 })
  const second = store.libraryPage('owner', { topicId: lease.id, cursor: detail.memories.nextCursor!, limit: 20 })
  expect([...detail.memories.items, ...second.items]).toHaveLength(35)
  expect(second.nextCursor).toBeNull()
})

it('indexes older stores in bounded chunks only while learning, keeping individual records available', () => {
  for (let index = 0; index < 55; index++) remember({ facet: `topic_${index}`, conflictKey: `decision_${index}` })
  store.setControls({ learn: false, recall: false })
  store.close()
  const Database = builtinSqlite()!
  const db = new Database(join(directory, 'memory.sqlite'), { readOnly: false }) as unknown as MemoryDatabase
  try {
    db.exec('DROP TABLE memory_notebook_jobs; DROP TABLE memory_inference_purpose;')
  } finally { db.close() }
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  expect(store.notebookPending()).toEqual({ state: 'learning_off', prefer: false })
  expect(store.libraryNotebooks('owner').items).toEqual([])
  expect(store.libraryPage('owner', { limit: 50 }).items).toHaveLength(50)
  const notebookIds = (): string[] => {
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = store.libraryNotebooks('owner', { limit: 20, cursor })
      ids.push(...page.items.map(item => item.id))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return ids
  }
  store.setControls({ learn: true, recall: false })
  expect(store.notebookPending().state).toBe('indexing')
  expect(notebookIds()).toHaveLength(50)
  expect(store.notebookPending().state).toBe('ready')
  expect(new Set(notebookIds()).size).toBe(55)
  expect(store.learning.status().callsLastHour).toBe(0)
})

it('rebuilds a page invalidated by an older writer before its future validity boundary', () => {
  remember({ validity: { ...draft.validity, validUntil: now + 60_000 } })
  const first = claim()
  store.notebookFinish(first, page(first), target)
  const Database = builtinSqlite()!
  const db = new Database(join(directory, 'memory.sqlite'), { readOnly: false }) as unknown as MemoryDatabase
  try { db.prepare('UPDATE topics SET data=NULL WHERE id=?').run(first.id) } finally { db.close() }
  expect(store.notebookPending().state).toBe('ready')
  const rebuilt = claim()
  expect(store.notebookFinish(rebuilt, page(rebuilt), target).state).toBe('ready')
})

it.each(['/id', '/revision', '/updatedAt', '/claim/absent'])('refuses non-material or missing statement support at %s', path => {
  remember()
  const lease = claim(), result = page(lease)
  result.statements[0].supports[0].paths = [path]
  expect(() => store.notebookFinish(lease, result, target)).toThrow('evidence_path')
  expect(store.topic(lease.id, access)).toBeNull()
})

it('lets the owner browse queued and ready pages with evidence links without starting inference', () => {
  const record = remember()
  const index = store.libraryNotebooks('owner')
  expect(index.items).toHaveLength(1)
  const id = index.items[0].id
  expect(index.items[0]).toMatchObject({ title: 'Storage', state: 'queued', activeRecords: 1, supportingRecords: 0 })
  expect(store.libraryNotebook('owner', id)).toMatchObject({ explanation: null, supporting: [], memories: { items: [{ id: record.id }] } })
  expect(store.learning.status().callsLastHour).toBe(0)
  const lease = claim()
  store.notebookFinish(lease, page(lease), target)
  const detail = store.libraryNotebook('owner', id)!
  expect(detail.summary).toMatchObject({ state: 'ready', supportingRecords: 1 })
  expect(detail.explanation?.statements[0].supports[0]).toMatchObject({ memoryId: record.id, revision: record.revision })
  expect(detail.supporting.map(item => item.id)).toEqual([record.id])
  expect(detail.supporting[0]).not.toHaveProperty('evidence')
  expect(store.libraryNotebook('owner', 'missing')).toBeNull()
  expect(() => store.libraryNotebooks('other')).toThrow('scope_denied')
  expect(() => store.libraryNotebook('other', id)).toThrow('scope_denied')
  expect(store.learning.status().callsLastHour).toBe(1)
})

it('hides source-private notebook groups before pagination and direct lookup', () => {
  const visible = remember()
  const visibleId = store.libraryNotebooks('owner').items[0].id
  store.ingest({ ...source, id: 'private', nativeEventId: 'private', rootIds: ['private'], sessionId: 'private' })
  const hidden = store.propose({ ...draft, facet: 'private_topic', conflictKey: 'private',
    evidence: [{ ...draft.evidence[0], sourceEventId: 'private' }] }, access).record
  const hiddenId = store.libraryNotebooks('owner', { limit: 1 }).items[0].id
  expect(hiddenId).not.toBe(visibleId)
  store.setSessionIncluded('claude', 'private', false)
  const page = store.libraryNotebooks('owner', { limit: 1 })
  expect(page.items.map(item => item.id)).toEqual([visibleId])
  expect(page.nextCursor).toBeNull()
  expect(store.libraryNotebook('owner', hiddenId)).toBeNull()
  expect(store.libraryPage('owner', { topicId: visibleId }).items.map(item => item.id)).toEqual([visible.id])
  expect(store.libraryPage('owner', { topicId: hiddenId }).items).toEqual([])
  expect(JSON.stringify(page)).not.toContain(hidden.facet)
  store.setProjectIncluded('project', false)
  expect(store.libraryNotebooks('owner').items).toEqual([])
  expect(store.libraryNotebook('owner', visibleId)).toBeNull()
})

it('rejects obsolete or differently scoped notebook cursors and removes forgotten groups', () => {
  const first = remember()
  store.ingest({ ...source, id: 'second', nativeEventId: 'second', rootIds: ['second'], sessionId: 'second' })
  const second = store.propose({ ...draft, facet: 'testing', conflictKey: 'second_topic',
    evidence: [{ ...draft.evidence[0], sourceEventId: 'second' }] }, access).record
  const firstPage = store.libraryNotebooks('owner', { limit: 1 })
  const secondPage = store.libraryNotebooks('owner', { limit: 1, cursor: firstPage.nextCursor! })
  expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id)
  expect(secondPage.nextCursor).toBeNull()
  expect(() => store.libraryNotebooks('owner', { cursor: firstPage.nextCursor!, projectId: 'project' })).toThrow('invalid_cursor')
  expect(() => store.libraryNotebooks('owner', { cursor: 'broken' })).toThrow('invalid_cursor')
  const command = { kind: 'forget' as const, id: second.id, revision: second.revision }
  const preview = store.libraryPreview('owner', command)
  store.libraryApply('owner', command, preview.version, false)
  expect(() => store.libraryNotebooks('owner', { cursor: firstPage.nextCursor! })).toThrow('page_changed')
  expect(store.libraryNotebook('owner', firstPage.items[0].id)).toBeNull()
  expect(store.libraryNotebook('owner', secondPage.items[0].id)?.memories.items[0].id).toBe(first.id)
})
