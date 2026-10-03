import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import type { MemoryDraft, MemoryRecord, MemoryScope, SourceEvent } from './types.js'
import type { MemoryCorrection } from './library.js'

let directory: string, store: CodingMemoryStore
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-library-'))
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => 1000 })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  store.setControls({ learn: true, recall: true })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function learn(id: string, scope: MemoryScope = { profileId: 'owner', projectId: 'project' }): MemoryRecord {
  if (scope.projectId) store.registerProject(scope.projectId)
  const claim = `For coding task ${id}, I prefer a small reproducer.`
  const source: SourceEvent = { id, profileId: 'owner', projectId: scope.projectId ?? null, taskId: scope.taskId, branchId: scope.branchId,
    role: 'user', engine: 'claude', sessionId: id, nativeEventId: id, rootIds: [id], eligibility: 'coding', observedAt: 900,
    text: `${claim}\nUnrelated private conversation must never appear in the library detail.` }
  store.ingest(source)
  const draft: MemoryDraft = { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference', scope, claim,
    rationale: null, futureAction: 'Begin with a reproducer.', applicability: {}, exceptions: [], retrievalCues: ['reproducer'],
    conflictKey: id, evidenceClass: 'user_stated', evidence: [{ sourceEventId: id, quote: claim, paths: ['/claim', '/futureAction', '/applicability'] }],
    validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
  return store.propose(draft, { profileId: 'owner', projectIds: scope.projectId ? [scope.projectId] : [], includeProfile: true,
    taskId: scope.taskId, branchId: scope.branchId }).record
}
function fields(record: MemoryRecord): MemoryCorrection {
  const { claim, rationale, futureAction, applicability, exceptions, retrievalCues, validity } = record
  return { claim, rationale, futureAction, applicability, exceptions, retrievalCues, validity }
}

it('paginates all owner scopes without granting that access to ordinary agents', () => {
  const personal = learn('personal', { profileId: 'owner' })
  const task = learn('task', { profileId: 'owner', projectId: 'project', taskId: 'task' })
  const branch = learn('branch', { profileId: 'owner', projectId: 'second', branchId: 'branch' })
  const page = store.libraryPage('owner', { limit: 2 })
  expect(page.items.map(item => item.id)).toEqual([branch.id, task.id])
  expect(page.items[0]).not.toHaveProperty('evidence')
  expect(store.libraryPage('owner', { limit: 2, cursor: page.nextCursor! }).items.map(item => item.id)).toEqual([personal.id])
  expect(store.libraryPage('owner', { scope: 'personal' }).items.map(item => item.id)).toEqual([personal.id])
  expect(store.libraryPage('owner', { projectId: 'project' }).items.map(item => item.id)).toEqual([task.id])
  expect(store.list({ profileId: 'owner', projectIds: ['project'], includeProfile: false })).toEqual([])
  expect(() => store.libraryPage('other')).toThrow('scope_denied')
  expect(() => store.libraryDetail('other', task.id)).toThrow('scope_denied')
})

it('applies privacy before page limits and returns only retained evidence spans', () => {
  const record = learn('visible')
  learn('hidden')
  store.setSessionIncluded('claude', 'hidden', false)
  expect(store.libraryPage('owner', { limit: 1 }).items.map(item => item.id)).toEqual([record.id])
  const detail = store.libraryDetail('owner', record.id)!
  expect(detail.sources).toEqual([{ id: 'visible', engine: 'claude', sessionId: 'visible', role: 'user', observedAt: 900 }])
  expect(JSON.stringify(detail)).not.toContain('Unrelated private')
  store.setProjectIncluded('project', false)
  expect(store.libraryPage('owner').items).toEqual([])
  expect(store.libraryDetail('owner', record.id)).toBeNull()
  // Privacy must not prevent the owner from deleting a known record.
  const preview = store.libraryPreview('owner', { kind: 'forget', id: record.id, revision: 1 })
  expect(store.libraryApply('owner', preview.command, preview.version, false).deletedIds).toContain(record.id)
})

it('rejects stale, malformed, foreign-owner and differently filtered cursors', () => {
  const first = learn('first'); learn('second')
  const page = store.libraryPage('owner', { limit: 1 })
  expect(() => store.libraryPage('owner', { cursor: 'garbage' })).toThrow('invalid_cursor')
  expect(() => store.libraryPage('owner', { cursor: page.nextCursor!, scope: 'personal' })).toThrow('invalid_cursor')
  const cursor = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString())
  expect(() => store.libraryPage('owner', { cursor: Buffer.from(JSON.stringify({ ...cursor, owner: 'other' })).toString('base64url') })).toThrow('invalid_cursor')
  store.libraryCorrect('owner', first.id, 1, { ...fields(first), claim: 'I prefer a minimal failing test.' })
  expect(() => store.libraryPage('owner', { cursor: page.nextCursor! })).toThrow('page_changed')
})

it('validates a concrete correction without saving a revision or invented user event', () => {
  const record = learn('one', { profileId: 'owner', projectId: 'project', taskId: 'task', branchId: 'branch' })
  const version = store.libraryPage('owner').version
  const command = { kind: 'correct' as const, id: record.id, revision: 1, fields: { ...fields(record), claim: 'I prefer a focused regression test.' } }
  const preview = store.libraryPreview('owner', command)
  expect(preview.effects.record).toMatchObject({ claim: command.fields.claim, revision: 2, scope: record.scope })
  expect(store.libraryDetail('owner', record.id)!.record).toEqual(record)
  expect(store.libraryPage('owner').version).toEqual(version)
  store.setControls({ learn: false, recall: false })
  const current = store.libraryPreview('owner', command)
  expect(store.libraryApply('owner', command, current.version, false).record).toMatchObject({ revision: 2, evidenceClass: 'user_stated' })
  const detail = store.libraryDetail('owner', record.id)!
  expect(detail.sources).toMatchObject([{ engine: 'harness_viewer', role: 'user' }])
  expect(() => store.libraryApply('owner', command, current.version, false)).toThrow('preview_changed')
  expect(() => store.libraryCorrect('owner', record.id, 1, command.fields)).toThrow('revision_conflict')
})

it('refuses payload authority changes and secret-bearing corrections without changing the record', () => {
  const record = learn('one')
  expect(() => store.libraryCorrect('owner', record.id, 1, { ...fields(record), scope: { profileId: 'owner' } } as MemoryCorrection)).toThrow('invalid_input')
  expect(() => store.libraryPreview('owner', { kind: 'correct', id: record.id, revision: 1,
    fields: { ...fields(record), claim: 'Save this API key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } })).toThrow()
  expect(store.libraryDetail('owner', record.id)!.record).toEqual(record)
})

it('narrows a personal memory to one known project without changing its meaning or adding confirmation', () => {
  const record = learn('personal', { profileId: 'owner' })
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = record
  store.ingest({ id: 'corroboration', profileId: 'owner', projectId: null, role: 'user', engine: 'codex', sessionId: 'another_session',
    nativeEventId: 'corroboration', rootIds: ['corroboration'], eligibility: 'coding', observedAt: 950, text: record.claim })
  store.propose({ ...draft, evidence: [{ ...draft.evidence[0], sourceEventId: 'corroboration' }] },
    { profileId: 'owner', projectIds: [], includeProfile: true })
  store.registerProject('chosen_project')
  store.registerProject('other_project')
  const originalSupport = store.libraryDetail('owner', record.id)!.support
  expect(originalSupport?.independentUserStatements).toBe(2)
  const command = { kind: 'narrow' as const, id: record.id, revision: 1, projectId: 'chosen_project' }
  const preview = store.libraryPreview('owner', command)
  expect(preview.effects.record).toMatchObject({ id: record.id, revision: 2, scope: { profileId: 'owner', projectId: 'chosen_project' } })
  expect(store.libraryDetail('owner', record.id)!.record).toEqual(record)
  store.libraryApply('owner', command, preview.version, true)
  const detail = store.libraryDetail('owner', record.id)!
  expect(detail.record).toMatchObject({ claim: record.claim, rationale: record.rationale, evidence: record.evidence,
    evidenceClass: record.evidenceClass, applicability: record.applicability, revision: 2 })
  expect(detail.support).toEqual(originalSupport)
  expect(detail.scopeChanges).toEqual([{ revision: 2, from: { profileId: 'owner' },
    to: { profileId: 'owner', projectId: 'chosen_project' }, changedAt: 1000, actor: 'owner' }])
  expect(store.recall({ query: 'reproducer' }, { profileId: 'owner', projectIds: ['chosen_project'], includeProfile: true }).items).toHaveLength(1)
  expect(store.recall({ query: 'reproducer' }, { profileId: 'owner', projectIds: ['other_project'], includeProfile: true }).items).toEqual([])
  expect(() => store.libraryApply('owner', command, preview.version, true)).toThrow('preview_changed')
})

it('refuses unknown or excluded destinations and moving a memory from one project to another', () => {
  const personal = learn('personal', { profileId: 'owner' }), scoped = learn('scoped')
  store.registerProject('excluded'); store.setProjectIncluded('excluded', false)
  for (const projectId of ['missing', 'excluded']) expect(() => store.libraryPreview('owner',
    { kind: 'narrow', id: personal.id, revision: 1, projectId })).toThrow('project_unavailable')
  expect(() => store.libraryPreview('owner', { kind: 'narrow', id: scoped.id, revision: 1, projectId: 'project' }))
    .toThrow('scope_narrowing_only')
  expect(store.libraryDetail('owner', personal.id)!.record).toEqual(personal)
  expect(() => store.libraryPreview('other', { kind: 'narrow', id: personal.id, revision: 1, projectId: 'project' })).toThrow('scope_denied')
})

it('keeps inferred knowledge tentative when its applicability is narrowed', () => {
  const original = learn('statement', { profileId: 'owner' })
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = original
  const record = store.propose({ ...draft, assertionType: 'observed_usage', evidenceClass: 'inferred', conflictKey: 'inferred' },
    { profileId: 'owner', projectIds: [], includeProfile: true }).record
  store.registerProject('project')
  const preview = store.libraryPreview('owner', { kind: 'narrow', id: record.id, revision: 1, projectId: 'project' })
  store.libraryApply('owner', preview.command, preview.version, true)
  const detail = store.libraryDetail('owner', record.id)!
  expect(detail.record).toMatchObject({ state: 'tentative', evidenceClass: 'inferred', evidence: record.evidence })
  expect(detail.support?.independentUserStatements).toBe(0)
})

it('preserves an unresolved conflict while allowing an owner to narrow with learning and recall off', () => {
  const original = learn('original', { profileId: 'owner' }), opposing = learn('opposing', { profileId: 'owner' })
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = opposing
  store.propose({ ...draft, conflictKey: original.conflictKey }, { profileId: 'owner', projectIds: [], includeProfile: true })
  const conflicted = store.libraryDetail('owner', original.id)!.record
  expect(conflicted.state).toBe('needs_verification')
  store.registerProject('project')
  store.setControls({ learn: false, recall: false })
  const preview = store.libraryPreview('owner', { kind: 'narrow', id: original.id, revision: conflicted.revision, projectId: 'project' })
  store.libraryApply('owner', preview.command, preview.version, false)
  expect(store.libraryDetail('owner', original.id)!.record).toMatchObject({ state: 'needs_verification', evidence: original.evidence })
  expect(store.controls()).toMatchObject({ learn: false, recall: false })
})

it('previews conflicting project knowledge and atomically withholds both claims after narrowing', () => {
  const personal = learn('personal', { profileId: 'owner' }), existing = learn('project')
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = existing
  const opposing = store.propose({ ...draft, conflictKey: personal.conflictKey },
    { profileId: 'owner', projectIds: ['project'], includeProfile: true }).record
  const preview = store.libraryPreview('owner', { kind: 'narrow', id: personal.id, revision: 1, projectId: 'project' })
  expect(preview.effects.record?.state).toBe('needs_verification')
  expect(preview.effects.conflicts).toMatchObject([{ id: opposing.id, revision: 2, claim: opposing.claim, state: 'needs_verification' }])
  expect(store.libraryDetail('owner', opposing.id)!.record.state).toBe('active')
  expect(store.libraryDetail('owner', personal.id)!.record.scope.projectId).toBeUndefined()
  store.libraryApply('owner', preview.command, preview.version, true)
  expect(store.libraryDetail('owner', opposing.id)!.record.state).toBe('needs_verification')
  expect(store.libraryDetail('owner', personal.id)!.record.state).toBe('needs_verification')
})

it('persists scope audit across restart and removes it with the forgotten memory', () => {
  const record = learn('personal', { profileId: 'owner' })
  const projectId = store.projectForLocator({ kind: 'directory', path: '/synthetic/project-label-only' })
  const access = { profileId: 'owner', projectIds: [projectId], includeProfile: true }
  store.putTopic({ id: 'topic', scope: record.scope, title: 'Debugging', statements: [{ text: record.claim,
    supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, access)
  const preview = store.libraryPreview('owner', { kind: 'narrow', id: record.id, revision: 1, projectId })
  store.libraryApply('owner', preview.command, preview.version, true)
  expect(store.topic('topic', access)).toBeNull()
  expect(JSON.stringify({ list: store.list(access), recall: store.recall({ query: 'reproducer' }, access) }))
    .not.toContain('project-label-only')
  store.close()
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => 1000 })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  expect(store.libraryDetail('owner', record.id)!.scopeChanges).toHaveLength(1)
  expect(store.libraryDetail('owner', record.id)!.project?.location).toBe('/synthetic/project-label-only')
  store.libraryForget('owner', record.id, 2)
  expect(store.libraryDetail('owner', record.id)).toBeNull()
  expect(store.libraryPage('owner').items).toEqual([])
})

it('withdraws the broader revision from other conversations and invalidates a stale target preview', () => {
  const record = learn('personal', { profileId: 'owner' })
  store.registerProject('project'); store.registerProject('other_project')
  const access = { profileId: 'owner', projectIds: ['other_project'], includeProfile: true }
  const binding = { engine: 'claude' as const, sessionId: 'receiving', projectId: 'other_project', route: 'prompt_hook' as const }
  store.prepareRecall({ query: 'reproducer' }, binding, access)
  const command = { kind: 'narrow' as const, id: record.id, revision: 1, projectId: 'project' }
  const preview = store.libraryPreview('owner', command)
  store.setProjectIncluded('project', false)
  expect(() => store.libraryApply('owner', command, preview.version, true)).toThrow('preview_changed')
  store.setProjectIncluded('project', true)
  const current = store.libraryPreview('owner', command)
  store.libraryApply('owner', command, current.version, true)
  const next = store.prepareRecall({ query: 'reproducer' }, binding, access)
  expect(next.packet.items).toEqual([])
  expect(JSON.parse(next.packet.text).withdrawn.references).toEqual([{ id: record.id, revision: 1 }])
  store.libraryForget('owner', record.id, 2)
  expect(store.libraryDetail('owner', record.id)).toBeNull()
})

it('lists known project names and literal path matches with privacy applied before pagination', () => {
  const first = store.projectForLocator({ kind: 'git_common_directory', path: '/synthetic/work/editor/.git' })
  const second = store.projectForLocator({ kind: 'directory', path: '/synthetic/research/editor' })
  const hidden = store.projectForLocator({ kind: 'directory', path: '/synthetic/private-hidden' })
  store.setProjectIncluded(hidden, false)
  const page = store.libraryProjects('owner', { search: 'editor', limit: 1 })
  expect(page.items).toEqual([{ id: second, name: 'editor', location: '/synthetic/research/editor' }])
  expect(store.libraryProjects('owner', { search: 'editor', before: page.nextBefore!, limit: 1 }).items)
    .toEqual([{ id: first, name: 'editor', location: '/synthetic/work/editor' }])
  expect(store.libraryProjects('owner', { search: 'research/editor' }).items.map(project => project.id)).toEqual([second])
  expect(store.libraryProjects('owner', { search: '%' }).items).toEqual([])
  expect(store.libraryProjects('owner').items.map(project => project.id)).not.toContain(hidden)
  expect(() => store.libraryProjects('other')).toThrow('scope_denied')
  expect(() => store.libraryProjects('owner', { limit: 1000 })).toThrow('invalid_input')
})

it('previews forgetting without erasing evidence and refuses a changed dependency snapshot', () => {
  const record = learn('one')
  const preview = store.libraryPreview('owner', { kind: 'forget', id: record.id, revision: 1 })
  expect(preview.effects).toEqual({ deletedIds: [record.id], deletedTopicIds: [], alreadyDeliveredContent: 'not_erased' })
  expect(store.libraryDetail('owner', record.id)!.record).toEqual(record)
  learn('new_knowledge')
  expect(() => store.libraryApply('owner', preview.command, preview.version, true)).toThrow('preview_changed')
  const current = store.libraryPreview('owner', preview.command)
  store.libraryApply('owner', current.command, current.version, true)
  expect(store.libraryDetail('owner', record.id)).toBeNull()
})

it('invalidates a forget preview when a new notebook page depends on the record', () => {
  const record = learn('one')
  const preview = store.libraryPreview('owner', { kind: 'forget', id: record.id, revision: 1 })
  store.putTopic({ id: 'new_topic', scope: record.scope, title: 'Debugging', statements: [{ text: record.claim,
    supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, { profileId: 'owner', projectIds: ['project'], includeProfile: true })
  expect(() => store.libraryApply('owner', preview.command, preview.version, true)).toThrow('preview_changed')
  expect(store.libraryPreview('owner', preview.command).effects.deletedTopicIds).toEqual(['new_topic'])
})

it('invalidates a forget preview when new corroborating evidence connects existing memories', () => {
  const one = learn('one'), two = learn('two')
  const preview = store.libraryPreview('owner', { kind: 'forget', id: one.id, revision: 1 })
  const text = `${one.claim} ${two.claim}`
  store.ingest({ id: 'bridge', profileId: 'owner', projectId: 'project', role: 'user', engine: 'codex', sessionId: 'bridge',
    nativeEventId: 'bridge', rootIds: ['bridge'], eligibility: 'coding', observedAt: 950, text })
  for (const record of [one, two]) {
    const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated, ...draft } = record
    const input = { ...draft, evidence: [{ sourceEventId: 'bridge', quote: text, paths: ['/claim', '/futureAction', '/applicability'] }] }
    const access = { profileId: 'owner', projectIds: ['project'], includeProfile: true }
    expect(store.propose(input, access).disposition).toBe('duplicate')
    const version = store.libraryPage('owner').version
    store.propose(input, access) // Replaying the same root changes neither evidence nor the snapshot.
    expect(store.libraryPage('owner').version).toEqual(version)
  }
  expect(store.libraryDetail('owner', one.id)!.record.revision).toBe(1)
  expect(() => store.libraryApply('owner', preview.command, preview.version, true)).toThrow('preview_changed')
  expect(store.libraryPreview('owner', preview.command).effects.deletedIds).toEqual(expect.arrayContaining([one.id, two.id]))
})

it('keeps effective controls off when changing preferences without watching consent', () => {
  store.setControls({ learn: false, recall: false })
  const preview = store.libraryPreview('owner', { kind: 'configure', preferences: { learn: false, recall: true }, expected: { learn: true, recall: true } })
  expect(store.preferences()).toEqual({ learn: true, recall: true })
  expect(store.controls()).toMatchObject({ learn: false, recall: false })
  store.libraryApply('owner', preview.command, preview.version, false)
  expect(store.preferences()).toEqual({ learn: false, recall: true })
  expect(store.controls()).toMatchObject({ learn: false, recall: false })
  expect(() => store.changePreferences({ learn: true, recall: true }, { learn: true, recall: true })).toThrow('revision_conflict')
})
