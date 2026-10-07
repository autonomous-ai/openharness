import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { builtinSqlite } from '../../../cli/src/lib/sqliteBuiltin.js'
import type { MemoryAccess, MemoryDraft, SourceEvent } from './types.js'

const access: MemoryAccess = { profileId: 'owner', projectIds: ['project_a'], includeProfile: true }
const elsewhere: MemoryAccess = { ...access, projectIds: ['project_b'] }
const foreign: MemoryAccess = { ...access, profileId: 'someone_else' }
let directory: string
let store: CodingMemoryStore
const opened: CodingMemoryStore[] = []

function open(profileId = 'owner'): CodingMemoryStore {
  const result = CodingMemoryStore.open({ directory, profileId, now: () => 1_000 })
  if (!result.ok) throw new Error(result.reason)
  opened.push(result.store)
  return result.store
}

function source(id = 'event_a', changes: Partial<SourceEvent> = {}): SourceEvent {
  return { id, profileId: 'owner', projectId: 'project_a', engine: 'claude', sessionId: 'session_a',
    nativeEventId: id, role: 'user', eligibility: 'coding', observedAt: 900, rootIds: [id],
    text: 'For reproducible bugs, start with a small failing test. This makes the repair easier to review.',
    ...changes }
}

function draft(event = source(), changes: Partial<MemoryDraft> = {}): MemoryDraft {
  return { kind: 'working_preference', facet: 'reasoning_and_feedback', assertionType: 'stated_preference',
    scope: { profileId: 'owner', projectId: event.projectId! },
    claim: 'For reproducible bugs, start with a small failing test.',
    rationale: 'The developer says it makes the repair easier to review.',
    futureAction: 'Begin with a reproducer, then implement and verify the repair.',
    applicability: { taskType: 'debugging' }, exceptions: [], retrievalCues: ['bug', 'reproducer', 'repair'],
    evidenceClass: 'user_stated', evidence: [{ sourceEventId: event.id, quote: event.text,
      paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }], conflictKey: 'debugging_feedback',
    validity: { validFrom: null, validUntil: null, recheckWhen: [] }, ...changes }
}

function learn(changes: Partial<MemoryDraft> = {}) {
  const event = source()
  store.ingest(event)
  return store.propose(draft(event, changes), access).record
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'coding-memory-'))
  store = open()
  store.registerProject('project_a')
  store.registerProject('project_b')
  store.setControls({ learn: true, recall: true })
})

afterEach(() => {
  for (const handle of opened.splice(0)) handle.close()
  rmSync(directory, { recursive: true, force: true })
})

it('upgrades v1 queue metadata while preserving memories, evidence, controls and privacy', () => {
  const record = learn()
  store.setProjectIncluded('project_b', false)
  const controls = store.controls()
  store.close()
  const Database = builtinSqlite()!
  const db = new Database(join(directory, 'memory.sqlite'), { readOnly: false })
  try { db.exec("DROP TABLE memory_job_context; UPDATE memory_meta SET value='1' WHERE key='schema'") } finally { db.close() }
  store = open()
  expect(store.read(record.id, access)).toEqual(record)
  expect(store.source('event_a', access)?.text).toBe(source().text)
  expect(store.controls()).toEqual(controls)
  expect(store.capturePolicy('project_b', 'claude', 'session_b').included).toBe(false)
  const upgraded = new Database(join(directory, 'memory.sqlite'), { readOnly: true })
  try { expect(upgraded.prepare("SELECT value FROM memory_meta WHERE key='schema'").all()[0]?.value).toBe('2') }
  finally { upgraded.close() }
})

it('refuses an unknown store version without changing its data or version', () => {
  const record = learn()
  store.close()
  const Database = builtinSqlite()!
  const db = new Database(join(directory, 'memory.sqlite'), { readOnly: false })
  try { db.exec("UPDATE memory_meta SET value='999' WHERE key='schema'") } finally { db.close() }
  expect(CodingMemoryStore.open({ directory, profileId: 'owner' })).toEqual({ ok: false, reason: 'schema_unsupported' })
  const unchanged = new Database(join(directory, 'memory.sqlite'), { readOnly: true })
  try {
    expect(unchanged.prepare("SELECT value FROM memory_meta WHERE key='schema'").all()[0]?.value).toBe('999')
    expect(JSON.parse(String(unchanged.prepare('SELECT data FROM memories WHERE id=?').all(record.id)[0]?.data))).toEqual(record)
  } finally { unchanged.close() }
})

describe('session privacy', () => {
  it('withholds records, evidence, history, support and topics, and permits forgetting while hidden', () => {
    const record = learn()
    const page = { id: 'private_topic', scope: record.scope, title: 'Debugging',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }
    store.putTopic(page, access)
    store.setSessionIncluded('claude', 'session_a', false)
    expect(store.read(record.id, access)).toBeNull()
    expect(store.source('event_a', access)).toBeNull()
    expect(store.history(record.id, access)).toEqual([])
    expect(store.support(record.id, access)).toBeNull()
    expect(store.list(access)).toEqual([])
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
    expect(store.topic(page.id, access)).toBeNull()
    expect(() => store.putTopic(page, access, 1)).toThrow('stale_dependency')
    expect(() => store.ingest(source('private_new'))).toThrow('source_ineligible')
    expect(store.forget(record.id, 1, access).deletedIds).toEqual([record.id])
    store.setSessionIncluded('claude', 'session_a', true)
    expect(store.ingest(source()).disposition).toBe('suppressed')
  })

  it('restores existing knowledge when its session is explicitly included again', () => {
    const record = learn()
    store.setSessionIncluded('claude', 'session_a', false)
    const reopened = open()
    expect(reopened.sessionPolicy('claude', 'session_a')).toEqual({ included: false, epoch: 1, liveFrom: 1_000 })
    expect(reopened.read(record.id, access)).toBeNull()
    reopened.setSessionIncluded('claude', 'session_a', true)
    expect(store.read(record.id, access)?.id).toBe(record.id)
    expect(store.sessionPolicy('claude', 'session_a').epoch).toBe(2)
  })

  it('hides supplementary private confirmations without withholding an independently public record', () => {
    const record = learn()
    const second = source('second', { engine: 'codex', sessionId: 'private_session', observedAt: 950 })
    store.ingest(second)
    store.propose(draft(second), access)
    store.setSessionIncluded('codex', 'private_session', false)
    expect(store.read(record.id, access)).not.toBeNull()
    expect(store.support(record.id, access)).toEqual({ independentUserStatements: 1, verifiedObservations: 0,
      distinctSessions: 1, lastObservedAt: 900 })
  })

  it('uses new public evidence for the same meaning without exposing the old private revision', () => {
    const record = learn()
    store.setSessionIncluded('claude', 'session_a', false)
    const fresh = source('public_statement', { sessionId: 'public_session' })
    store.ingest(fresh)
    const published = store.propose(draft(fresh), access)
    expect(published.record.id).toBe(record.id)
    expect(published.record.revision).toBe(2)
    expect(published.record.evidence.map(item => item.sourceEventId)).toEqual([fresh.id])
    expect(store.history(record.id, access).map(item => item.revision)).toEqual([2])
    expect(store.support(record.id, access)?.independentUserStatements).toBe(1)
  })

  it('withholds generated descendants even when they live in another public session', () => {
    const parent = learn()
    const derived = source('derived', { role: 'derived', sessionId: 'public_session',
      rootIds: ['event_a'], derivedFrom: [{ memoryId: parent.id, revision: 1 }] })
    store.ingest(derived)
    const child = store.propose(draft(derived, { kind: 'reference', assertionType: 'observed_usage',
      evidenceClass: 'imported', conflictKey: 'guide' }), access).record
    store.setSessionIncluded('claude', 'session_a', false)
    expect(store.source(derived.id, access)).toBeNull()
    expect(store.read(child.id, access)).toBeNull()
    expect(() => store.ingest({ ...derived, id: 'new_derived', nativeEventId: 'new_derived' })).toThrow('invalid_lineage')
  })

  it('does not let more than 120 private candidates crowd a public memory out of recall or listing', () => {
    const publicEvent = source('public', { sessionId: 'public_session' })
    store.ingest(publicEvent)
    const publicRecord = store.propose(draft(publicEvent), access).record
    for (let i = 0; i < 125; i++) {
      const event = source(`private_${i}`)
      store.ingest(event)
      store.propose(draft(event, { claim: `Debugging bug reproducer ${i}`, conflictKey: `private_${i}` }), access)
    }
    store.setSessionIncluded('claude', 'session_a', false)
    expect(store.list(access, 1).map(record => record.id)).toEqual([publicRecord.id])
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items.map(record => record.id)).toEqual([publicRecord.id])
  }, 30_000) // Keep all 125 durable fixtures even on a busy shared CI disk.

  it('does not consult a private statement when admitting a new conflicting public statement', () => {
    const hidden = learn()
    store.setSessionIncluded('claude', 'session_a', false)
    const event = source('public', { sessionId: 'public_session' })
    store.ingest(event)
    const fresh = store.propose(draft(event, { claim: 'Explain the state model first.' }), access).record
    expect(fresh.state).toBe('active')
    store.setSessionIncluded('claude', 'session_a', true)
    expect(store.read(hidden.id, access)?.state).toBe('needs_verification')
    expect(store.read(fresh.id, access)?.state).toBe('needs_verification')
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
  })
})

describe('specific requirements and personal defaults', () => {
  function personalDefault() {
    const event = source('personal', { projectId: null, sessionId: 'companion' })
    store.ingest(event)
    return store.propose(draft(event, { scope: { profileId: 'owner' } }), access).record
  }

  function projectRequirement(changes: Partial<MemoryDraft> = {}, sourceChanges: Partial<SourceEvent> = {}) {
    const event = source('requirement', { sessionId: 'project_session', ...sourceChanges })
    store.ingest(event)
    return store.propose(draft(event, { claim: 'For this project, debug using an integration reproducer.', ...changes }),
      { ...access, taskId: changes.scope?.taskId, branchId: changes.scope?.branchId }).record
  }

  const request = { query: 'reproducer', conditions: { taskType: 'debugging' } }

  it('uses the project requirement here and keeps the personal default available elsewhere', () => {
    const personal = personalDefault()
    const project = projectRequirement()
    expect(store.recall(request, access).items.map(item => item.id)).toEqual([project.id])
    expect(store.recall(request, elsewhere).items.map(item => item.id)).toEqual([personal.id])
    expect(store.read(personal.id, access)?.state).toBe('active')
    // An already delivered project requirement must not cause a broader default to be substituted.
    expect(store.recall({ ...request, excludeIds: [project.id] }, access).items).toEqual([])
  })

  it('withholds a conflicting default even when only that default matches the current search words', () => {
    personalDefault()
    projectRequirement({ claim: 'Use the integration harness first.', rationale: null, retrievalCues: ['integration'] })
    expect(store.recall(request, access).items).toEqual([])
  })

  it('does not fall back to a personal default when project requirements need clarification', () => {
    personalDefault()
    const first = projectRequirement()
    const event = source('contradiction', { sessionId: 'project_session' })
    store.ingest(event)
    store.propose(draft(event, { claim: 'Use a manual reproducer first in this project.' }), access)
    expect(store.read(first.id, access)?.state).toBe('needs_verification')
    expect(store.recall(request, access).items).toEqual([])
  })

  it.each([
    ['not applicable', { applicability: { taskType: 'design' } }],
    ['excepted', { exceptions: [{ when: { taskType: 'debugging' }, reason: 'This rule excludes debugging.' }] }],
    ['expired', { validity: { validFrom: null, validUntil: 999, recheckWhen: [] } }],
    ['not yet valid', { validity: { validFrom: 1_001, validUntil: null, recheckWhen: [] } }],
    ['tentative', { evidenceClass: 'inferred', assertionType: 'observed_usage' }],
  ] as Array<[string, Partial<MemoryDraft>]>)('ignores a more specific requirement that is %s', (_label, changes) => {
    const personal = personalDefault()
    projectRequirement(changes)
    expect(store.recall(request, access).items.map(item => item.id)).toEqual([personal.id])
  })

  it('does not let a private requirement affect public recall', () => {
    const personal = personalDefault()
    projectRequirement()
    store.setSessionIncluded('claude', 'project_session', false)
    expect(store.recall(request, access).items.map(item => item.id)).toEqual([personal.id])
  })

  it.each(['taskId', 'branchId'] as const)('keeps %s precedence inside the active task or branch', key => {
    personalDefault()
    const project = projectRequirement()
    const event = source(`scoped_${key}`, { [key]: 'current' })
    store.ingest(event)
    const scopedAccess = { ...access, [key]: 'current' }
    const scoped = store.propose(draft(event, {
      scope: { profileId: 'owner', projectId: 'project_a', [key]: 'current' },
      claim: 'For this work, keep a local reproducer beside the changed module.',
    }), scopedAccess).record
    expect(store.recall(request, scopedAccess).items.map(item => item.id)).toEqual([scoped.id])
    expect(store.recall(request, { ...access, [key]: 'different' }).items.map(item => item.id)).toEqual([project.id])
    expect(store.recall(request, access).items.map(item => item.id)).toEqual([project.id])
  })
})

describe('coding memory ownership and admission', () => {
  it('persists sourced, conditional knowledge across reopen without tying it to an engine', () => {
    const record = learn()
    expect(record.state).toBe('active')
    expect(record.revision).toBe(1)
    const reopened = open()
    expect(reopened.read(record.id, access)).toEqual(record)
    const packet = reopened.recall({ query: 'repair bug', conditions: { taskType: 'debugging' } }, access)
    expect(packet.items.map(item => item.id)).toEqual([record.id])
    expect(packet.items[0].sources[0].engine).toBe('claude')
    expect(packet.items[0].assertionType).toBe('stated_preference')
    expect(packet.items[0].rationale).toBe(record.rationale)
  })

  it('rejects a database opened under a different profile without rewriting ownership', () => {
    const record = learn()
    expect(CodingMemoryStore.open({ directory, profileId: 'someone_else' })).toMatchObject({ ok: false, reason: 'profile_mismatch' })
    expect(store.read(record.id, access)?.claim).toBe(record.claim)
    expect(store.read(record.id, foreign)).toBeNull()
    expect(store.read(record.id, elsewhere)).toBeNull()
    expect(store.recall({ query: 'bug' }, foreign).items).toEqual([])
    expect(store.recall({ query: 'bug' }, elsewhere).items).toEqual([])
  })

  it('keeps source identity immutable and replays idempotent', () => {
    const event = source()
    expect(store.ingest(event).disposition).toBe('created')
    expect(store.ingest(event).disposition).toBe('duplicate')
    expect(() => store.ingest({ ...event, text: 'Different text under the same source ID.' })).toThrow('source_identity_conflict')
    const first = store.propose(draft(event), access)
    const repeated = store.propose(draft(event), access)
    expect(repeated.disposition).toBe('duplicate')
    expect(repeated.record.id).toBe(first.record.id)
    expect(store.history(first.record.id, access)).toHaveLength(1)
  })

  it('adds independent confirmations across frameworks without duplicating or rewriting a belief', () => {
    const record = learn()
    const second = source('independent', { engine: 'codex', sessionId: 'another_session', observedAt: 950 })
    store.ingest(second)
    expect(store.propose(draft(second), access).record.id).toBe(record.id)
    expect(store.propose(draft(second), access).disposition).toBe('duplicate')
    expect(store.support(record.id, access)).toEqual({ independentUserStatements: 2, verifiedObservations: 0,
      distinctSessions: 2, lastObservedAt: 950 })
    expect(store.read(record.id, access)?.revision).toBe(1)
    expect(store.list(access)).toHaveLength(1)
    expect(store.support(record.id, elsewhere)).toBeNull()
  })

  it('does not reinforce a belief from a generated echo, even when it repeats the same claim', () => {
    const record = learn()
    const echo = source('echo', { role: 'derived', text: record.claim,
      rootIds: ['event_a'], derivedFrom: [{ memoryId: record.id, revision: record.revision }] })
    store.ingest(echo)
    const repeated = draft()
    repeated.evidence.push({ sourceEventId: echo.id, quote: echo.text, paths: ['/claim'] })
    expect(store.propose(repeated, access).record.id).toBe(record.id)
    expect(store.support(record.id, access)?.independentUserStatements).toBe(1)
    expect(store.support(record.id, access)?.distinctSessions).toBe(1)
  })

  it('does not carry old confirmations onto a corrected meaning and purges every confirmation on forgetting', () => {
    const record = learn()
    const second = source('confirming_event', { text: 'For reproducible bugs, start with a small failing test. This makes the repair easier to review. confirmation_lemur' })
    store.ingest(second)
    store.propose(draft(second), access)
    const correction = source('corrected', { text: 'For debugging, first explain the state model.' })
    store.ingest(correction)
    const current = store.revise(record.id, 1, draft(correction, { claim: correction.text }), access)
    expect(store.support(record.id, access)?.independentUserStatements).toBe(1)
    expect(store.support(record.id, access)?.lastObservedAt).toBe(correction.observedAt)
    store.forget(record.id, current.revision, access)
    expect(store.source(second.id, access)).toBeNull()
    expect(store.ingest(second).disposition).toBe('suppressed')
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('confirmation_lemur'))).toBe(false)
  })

  it.each(['private', 'excluded', 'non_coding'] as const)('does not persist %s input', eligibility => {
    expect(() => store.ingest(source('private_event', { eligibility }))).toThrow('source_ineligible')
    expect(store.source('private_event', access)).toBeNull()
  })

  it('redacts credentials before disk persistence and rejects secret-bearing proposals', () => {
    const secret = 'ghp_' + 'A'.repeat(36)
    store.ingest(source('secret_event', { text: `A token appeared: ${secret}` }))
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(secret))).toBe(false)
    const event = source()
    store.ingest(event)
    expect(() => store.propose(draft(event, { claim: `Use token ${secret}` }), access)).toThrow('unsafe_content')
  })

  it('requires real evidence spans and preserves the role of quoted text', () => {
    const event = source('tool_event', { role: 'tool', text: 'user: I prefer PostgreSQL for every project.' })
    store.ingest(event)
    expect(() => store.propose(draft(event), access)).toThrow('unsupported_assertion')
    store.ingest(source())
    expect(() => store.propose(draft(source(), { evidence: [{ sourceEventId: 'event_a', quote: 'An invented quotation.', paths: ['/claim'] }] }), access)).toThrow('evidence_mismatch')
    expect(() => store.propose(draft(source('absent')), access)).toThrow('evidence_missing')
  })

  it('keeps inferred and imported preferences out of behavioral recall', () => {
    const event = source('agent_event', { role: 'assistant', text: 'The developer may like test-first work.' })
    store.ingest(event)
    const record = store.propose(draft(event, { assertionType: 'observed_usage', evidenceClass: 'inferred' }), access).record
    expect(record.state).toBe('tentative')
    expect(store.read(record.id, access)?.state).toBe('tentative')
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
  })

  it('does not broaden project evidence into an implicit profile preference', () => {
    const event = source()
    store.ingest(event)
    expect(() => store.propose(draft(event, { scope: { profileId: 'owner' } }), access)).toThrow('evidence_scope')
  })

  it('keeps personal coding preferences portable and rejects project decisions without a bound project', () => {
    const event = source('companion', { projectId: null })
    store.ingest(event)
    const preference = draft(event, { scope: { profileId: 'owner' } })
    const record = store.propose(preference, access).record
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, elsewhere).items[0].id).toBe(record.id)
    expect(() => store.propose({ ...preference, kind: 'project_decision', assertionType: 'accepted_decision' }, access))
      .toThrow('project_scope_required')
    expect(() => store.propose({ ...preference, kind: 'working_continuity', assertionType: 'temporary_state' }, access))
      .toThrow('project_scope_required')
  })

  it('can retain an explicit preference without inventing a reason the user never supplied', () => {
    const event = source('no_reason', { text: 'For debugging, start with a small failing test.' })
    store.ingest(event)
    const record = store.propose(draft(event, { rationale: null,
      evidence: [{ sourceEventId: event.id, quote: event.text, paths: ['/claim', '/futureAction', '/applicability', '/exceptions', '/validity'] }] }), access).record
    expect(record.rationale).toBeNull()
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items[0].rationale).toBeNull()
  })

  it('preserves task and branch boundaries through source access and admission', () => {
    const event = source('branch_event', { branchId: 'feature_branch', taskId: 'debug_task' })
    const taskAccess = { ...access, branchId: event.branchId, taskId: event.taskId }
    store.ingest(event)
    expect(store.source(event.id, access)).toBeNull()
    expect(store.source(event.id, taskAccess)?.id).toBe(event.id)
    expect(() => store.propose(draft(event), taskAccess)).toThrow('evidence_scope')
    const record = store.propose(draft(event, { scope: { profileId: 'owner', projectId: 'project_a',
      taskId: event.taskId, branchId: event.branchId } }), taskAccess).record
    expect(store.read(record.id, access)).toBeNull()
    expect(store.read(record.id, taskAccess)?.id).toBe(record.id)
  })
})

describe('recall conditions and control', () => {
  it('finds an applicable older memory even when more than 120 newer matches are inapplicable', () => {
    const expected = learn()
    for (let index = 0; index < 125; index++) {
      learn({ conflictKey: `unusable_${index}`,
        ...(index % 3 === 0 ? { applicability: { taskType: 'design' } }
          : index % 3 === 1 ? { exceptions: [{ when: { urgency: 'incident' }, reason: 'Different workflow.' }] }
            : { validity: { validFrom: null, validUntil: 900, recheckWhen: [] } }) })
    }
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging', urgency: 'incident' } }, access).items.map(item => item.id))
      .toEqual([expected.id])
  })

  it.each([
    [{ stage: ['review', 'implementation'] }, { stage: 'review' }, true],
    [{ stage: 'review' }, { stage: ['planning', 'review'] }, true],
    [{ stage: ['review', 'implementation'] }, { stage: ['review', 'planning'] }, true],
    [{ stage: ['review'] }, { stage: ['planning'] }, false],
    [{ available: true }, { available: 1 }, false],
    [{ available: false }, { available: false }, true],
    [{ limit: 1 }, { limit: 1 }, true],
    [{ limit: '1' }, { limit: 1 }, false],
  ])('preserves typed condition matching before candidate ranking', (required, actual, expected) => {
    learn({ applicability: required })
    expect(store.recall({ query: 'bug', conditions: actual }, access).items.length > 0).toBe(expected)
  })

  it('omits irrelevant, unknown-condition, expired, and excepted memories', () => {
    learn({ exceptions: [{ when: { urgency: 'incident' }, reason: 'Use the incident response procedure.' }] })
    expect(store.recall({ query: 'bug' }, access).items).toEqual([])
    expect(store.recall({ query: 'bug', conditions: { taskType: 'design' } }, access).items).toEqual([])
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging', urgency: 'incident' } }, access).items).toEqual([])
    expect(store.recall({ query: 'typography colors', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toHaveLength(1)
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items[0].exceptions).toHaveLength(1)
    store.setProjectIncluded('project_a', false)
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
  })

  it('keeps an expired observation out of recall and a derived current topic', () => {
    const record = learn({ validity: { validFrom: 1, validUntil: 999, recheckWhen: [] } })
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
    expect(() => store.putTopic({ id: 'expired', scope: record.scope, title: 'Current debugging rules',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: record.revision, paths: ['/claim'] }] }] }, access)).toThrow('stale_dependency')
  })

  it('treats search syntax as text and respects the byte and item budgets', () => {
    learn()
    const packet = store.recall({ query: 'bug OR * NOT " :', conditions: { taskType: 'debugging' }, maxBytes: 2_000, maxItems: 1 }, access)
    expect(Buffer.byteLength(packet.text)).toBeLessThanOrEqual(2_000)
    expect(packet.items.length).toBeLessThanOrEqual(1)
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' }, maxBytes: 80 }, access).items).toEqual([])
  })

  it('keeps learning and recall switches independent and does not revive excluded sources', () => {
    const record = learn()
    store.setControls({ learn: false, recall: true })
    expect(() => store.ingest(source('new_event'))).toThrow('learning_off')
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toHaveLength(1)
    store.setControls({ learn: true, recall: false })
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).status).toBe('off')
    expect(store.read(record.id, access)).not.toBeNull()
    store.setProjectIncluded('project_a', false)
    expect(() => store.ingest(source('excluded_project'))).toThrow('source_ineligible')
  })
})

describe('revision consistency, conflicts, and forgetting', () => {
  it('compares revisions atomically across independent connections', () => {
    const record = learn()
    const second = open()
    const correction = source('correction', { text: 'For debugging, explain the state transitions before writing the reproducer.' })
    store.ingest(correction)
    const changed = draft(correction, { claim: correction.text })
    const next = store.revise(record.id, record.revision, changed, access)
    expect(next.revision).toBe(2)
    expect(() => second.revise(record.id, record.revision, changed, access)).toThrow('revision_conflict')
    expect(second.history(record.id, access).map(row => row.revision)).toEqual([1, 2])
    expect(second.read(record.id, access)?.claim).toBe(correction.text)
  })

  it('withholds unresolved contradictory guidance instead of choosing the latest claim', () => {
    const first = learn()
    const event = source('other_preference', { text: 'For debugging, first explain the state model.' })
    store.ingest(event)
    const second = store.propose(draft(event, { claim: event.text }), access).record
    expect(store.read(first.id, access)?.state).toBe('needs_verification')
    expect(second.state).toBe('needs_verification')
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items).toEqual([])
  })

  it('resolves a conflict only with new user evidence and current revisions of all superseded records', () => {
    const first = learn()
    const other = source('other', { text: 'For debugging, explain the state model first.' })
    store.ingest(other)
    const second = store.propose(draft(other, { claim: other.text }), access).record
    const current = store.read(first.id, access)!
    const correction = source('resolution', { text: 'Use a failing reproducer first for these debugging tasks. That is my current preference.' })
    store.ingest(correction)
    expect(() => store.revise(current.id, current.revision, draft(correction), access,
      [{ id: second.id, revision: 999 }])).toThrow('revision_conflict')
    expect(store.read(first.id, access)?.revision).toBe(current.revision)
    const result = store.revise(current.id, current.revision, draft(correction), access,
      [{ id: second.id, revision: second.revision }])
    expect(result.state).toBe('active')
    expect(store.read(second.id, access)?.state).toBe('superseded')
    expect(store.recall({ query: 'bug', conditions: { taskType: 'debugging' } }, access).items.map(item => item.id)).toEqual([first.id])
  })

  it('invalidates a derived topic before returning from a correction and rejects stale regeneration', () => {
    const record = learn()
    const page = { id: 'debugging', scope: record.scope, title: 'How to debug this project',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }
    store.putTopic(page, access)
    expect(store.topic('debugging', access)?.statements[0].text).toBe(record.claim)
    const correction = source('correction', { text: 'For debugging, explain the state model first.' })
    store.ingest(correction)
    store.revise(record.id, 1, draft(correction, { claim: correction.text }), access)
    expect(store.topic('debugging', access)).toBeNull()
    expect(() => store.putTopic(page, access)).toThrow('stale_dependency')
    const fresh = { ...page, statements: [{ text: correction.text, supports: [{ memoryId: record.id, revision: 2, paths: ['/claim'] }] }] }
    expect(store.putTopic(fresh, access, 1).revision).toBe(2)
    expect(() => store.putTopic(fresh, access, 1)).toThrow('revision_conflict')
  })

  it('rejects a topic or memory generated before a control generation changed', () => {
    const record = learn()
    const generation = store.controls().generation
    store.setControls({ learn: false, recall: true })
    store.setControls({ learn: true, recall: true })
    expect(() => store.propose(draft(), access, generation)).toThrow('generation_changed')
    expect(() => store.putTopic({ id: 'stale', scope: record.scope, title: 'Debugging',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, access, 0, generation)).toThrow('generation_changed')
  })

  it('does not let a topic widen source scope or use a missing evidence field', () => {
    const record = learn()
    expect(() => store.putTopic({ id: 'wide', scope: { profileId: 'owner' }, title: 'Debugging',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, access)).toThrow('dependency_scope')
    expect(() => store.putTopic({ id: 'bad', scope: record.scope, title: 'Debugging',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/imaginary'] }] }] }, access)).toThrow('evidence_path')
  })

  it('carries the exact conditions and exceptions alongside every derived topic statement', () => {
    const record = learn({ exceptions: [{ when: { urgency: 'incident' }, reason: 'Use the incident procedure.' }] })
    const page = store.putTopic({ id: 'conditions', scope: record.scope, title: 'Debugging',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, access)
    expect(page.statements[0].constraints).toEqual([{ memoryId: record.id, applicability: record.applicability,
      exceptions: record.exceptions, validity: record.validity }])
  })

  it('purges revisions, source excerpts, derived content and index terms, then suppresses replay', () => {
    const unique = 'forgotten_amber_lemur'
    const event = source('forget_me', { text: `For debugging use ${unique}.` })
    store.ingest(event)
    const record = store.propose(draft(event, { claim: event.text }), access).record
    store.putTopic({ id: 'deleted_topic', scope: record.scope, title: 'Debugging preference',
      statements: [{ text: record.claim, supports: [{ memoryId: record.id, revision: 1, paths: ['/claim'] }] }] }, access)
    const receipt = store.forget(record.id, 1, access)
    expect(receipt.deletedIds).toContain(record.id)
    expect(receipt.alreadyDeliveredContent).toBe('not_erased')
    expect(store.read(record.id, access)).toBeNull()
    expect(store.history(record.id, access)).toEqual([])
    expect(store.topic('deleted_topic', access)).toBeNull()
    expect(store.source(event.id, access)).toBeNull()
    expect(store.ingest(event).disposition).toBe('suppressed')
    expect(() => store.propose(draft(event), access)).toThrow('source_suppressed')
    store.close()
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(unique))).toBe(false)
    const reopened = open()
    expect(reopened.recall({ query: unique, conditions: { taskType: 'debugging' } }, access).items).toEqual([])
    expect(reopened.ingest(event).disposition).toBe('suppressed')
  })

  it('rejects stale or unauthorized deletion and allows deletion when learning is off', () => {
    const record = learn()
    expect(() => store.forget(record.id, 999, access)).toThrow('revision_conflict')
    expect(() => store.forget(record.id, 1, elsewhere)).toThrow('not_found')
    store.setControls({ learn: false, recall: false })
    expect(store.forget(record.id, 1, access).deletedIds).toEqual([record.id])
  })

  it('allows an explicit user correction with learning off without enabling automatic writes', () => {
    const record = learn()
    store.setControls({ learn: false, recall: true })
    const { evidence: _evidence, evidenceClass: _class, ...correction } = draft(source(), {
      claim: 'For debugging, explain the state model first.',
      futureAction: 'Explain the state model, then reproduce and verify the repair.',
    })
    expect(() => store.correctFromUser(record.id, 1, correction, elsewhere)).toThrow('not_found')
    const updated = store.correctFromUser(record.id, 1, correction, access)
    expect(updated.revision).toBe(2)
    expect(updated.state).toBe('active')
    const event = store.source(updated.evidence[0].sourceEventId, access)!
    expect(event.role).toBe('user')
    expect(event.engine).toBe('harness_viewer')
    expect(store.controls().learn).toBe(false)
    expect(() => store.ingest(source('automatic'))).toThrow('learning_off')
    expect(() => store.propose(draft(), access)).toThrow('learning_off')
    expect(() => store.correctFromUser(record.id, 1, correction, access)).toThrow('revision_conflict')
  })

  it('forgets dependent generated memories while preserving an unrelated claim from the same source', () => {
    const event = source('two_preferences', { text: 'For bugs use amberlemur. For UI use compact rows.' })
    store.ingest(event)
    const parent = store.propose(draft(event, { claim: 'For bugs use amberlemur.', evidence: [{ sourceEventId: event.id,
      quote: 'For bugs use amberlemur.', paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }] }), access).record
    const kept = store.propose(draft(event, { claim: 'For UI use compact rows.', conflictKey: 'ui_density',
      applicability: { taskType: 'ui' }, evidence: [{ sourceEventId: event.id, quote: 'For UI use compact rows.',
        paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }] }), access).record
    const derived = source('derived_note', { role: 'derived', text: 'The debugging guide recommends amberlemur.',
      rootIds: [event.id], derivedFrom: [{ memoryId: parent.id, revision: 1 }] })
    store.ingest(derived)
    const child = store.propose(draft(derived, { kind: 'reference', claim: derived.text, assertionType: 'observed_usage',
      evidenceClass: 'imported', conflictKey: 'derived_guide' }), access).record
    expect(store.forget(parent.id, 1, access).deletedIds.sort()).toEqual([parent.id, child.id].sort())
    expect(store.read(kept.id, access)?.claim).toBe(kept.claim)
    expect(store.source(event.id, access)?.text).toBe('For UI use compact rows.')
    expect(store.source(derived.id, access)).toBeNull()
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('amberlemur'))).toBe(false)
  })

  it('withholds current descendants after correcting their parent and refuses stale derived evidence', () => {
    const parent = learn()
    const generated = source('summary', { role: 'derived', text: 'The debugging guide starts with a reproducer.',
      rootIds: ['event_a'], derivedFrom: [{ memoryId: parent.id, revision: 1 }] })
    store.ingest(generated)
    const child = store.propose(draft(generated, { kind: 'reference', assertionType: 'observed_usage',
      evidenceClass: 'imported', conflictKey: 'guide', claim: generated.text }), access).record
    const correction = source('corrected_parent', { text: 'For debugging, explain the state model first.' })
    store.ingest(correction)
    store.revise(parent.id, 1, draft(correction, { claim: correction.text }), access)
    expect(store.read(child.id, access)?.state).toBe('needs_verification')
    expect(() => store.propose(draft(generated, { kind: 'reference', assertionType: 'observed_usage',
      evidenceClass: 'imported', conflictKey: 'another_guide' }), access)).toThrow('stale_dependency')
  })

  it('cascades forgetting when a surviving evidence quote overlaps the forgotten span', () => {
    const event = source('overlapping_evidence', { text: 'For bugs use amberlemur. For UI use compact rows.' })
    store.ingest(event)
    const parent = store.propose(draft(event, { claim: 'For bugs use amberlemur.', evidence: [{ sourceEventId: event.id,
      quote: 'For bugs use amberlemur.', paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }] }), access).record
    const overlapping = store.propose(draft(event, { claim: 'For UI use compact rows.', conflictKey: 'ui_density',
      applicability: { taskType: 'ui' } }), access).record
    expect(store.forget(parent.id, 1, access).deletedIds.sort()).toEqual([parent.id, overlapping.id].sort())
    expect(store.source(event.id, access)).toBeNull()
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from('amberlemur'))).toBe(false)
  })
})
