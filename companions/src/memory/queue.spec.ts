import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { builtinSqlite } from '../../../cli/src/lib/sqliteRead.js'
import type { CaptureBatch, LearningLease } from './queue.js'
import type { MemoryAccess, MemoryDraft, SourceEvent } from './types.js'

const access: MemoryAccess = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
const target = { state: 'ready' as const, key: 'collection:codex:account1:selected-model:high' }
let directory: string
let now: number
let store: CodingMemoryStore
const opened: CodingMemoryStore[] = []
function open(): CodingMemoryStore {
  const result = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!result.ok) throw new Error(result.reason)
  opened.push(result.store)
  return result.store
}
function event(id = 'first', changes: Partial<SourceEvent> = {}): SourceEvent {
  return { id, profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'session', nativeEventId: id,
    role: 'user', eligibility: 'coding', observedAt: 9_000, rootIds: [id],
    text: 'For debugging start with a small failing test because it makes review easier.', ...changes }
}
function batch(id = 'first', changes: Partial<CaptureBatch> = {}): CaptureBatch {
  return { streamId: 'stream', engine: 'claude', sessionId: 'session', projectId: 'project', episodeId: `episode_${id}`,
    from: null, to: id, events: [event(id)], boundary: 'complete', ...changes }
}
function proposal(source = event(), changes: Partial<MemoryDraft> = {}): MemoryDraft {
  return { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference', scope: { profileId: 'owner', projectId: 'project' },
    claim: 'For debugging, start with a small failing test.', rationale: 'It makes review easier.',
    futureAction: 'Start with a small failing test.', applicability: { taskType: 'debugging' }, exceptions: [], retrievalCues: ['bug', 'test'],
    evidenceClass: 'user_stated', evidence: [{ sourceEventId: source.id, quote: source.text, paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }],
    conflictKey: 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] }, ...changes }
}
function claim(handle = store): LearningLease {
  const result = handle.learning.claim(target)
  if (result.state !== 'claimed') throw new Error(result.state)
  return result.lease
}
function captureEpisode(id: string, changes: Partial<SourceEvent> = {}): SourceEvent {
  const source = event(id, { sessionId: `session_${id}`, ...changes })
  store.learning.capture(batch(id, { streamId: `stream_${id}`, engine: source.engine, sessionId: source.sessionId,
    projectId: source.projectId, events: [source] }))
  now++
  return source
}
beforeEach(() => {
  now = 10_000
  directory = mkdtempSync(join(tmpdir(), 'memory-queue-'))
  store = open()
  store.registerProject('project')
  store.setControls({ learn: true, recall: true })
})
afterEach(() => { for (const handle of opened.splice(0)) handle.close(); rmSync(directory, { recursive: true, force: true }) })

describe('bounded episode batches', () => {
  it('reviews four compatible episodes per reservation and records each episode outcome separately', () => {
    const sources = Array.from({ length: 5 }, (_, index) => captureEpisode(`source_${index}`,
      { engine: index % 2 ? 'codex' : 'claude' }))
    const lease = claim()
    expect(lease.episodes.map(episode => episode.sourceIds)).toEqual(sources.slice(0, 4).map(source => [source.id]))
    expect(lease.sources.map(source => source.id)).toEqual(sources.slice(0, 4).map(source => source.id))
    expect(store.learning.status().callsLastHour).toBe(1)
    expect(store.learning.status().jobs).toEqual({ reviewing: 4, queued: 1 })
    expect(store.learning.finish(lease, [proposal(sources[1])], target).state).toBe('learned')
    expect(store.learning.status().jobs).toEqual({ learned: 1, no_useful_memory: 3, queued: 1 })
    expect(claim().sources.map(source => source.id)).toEqual(['source_4'])
  })

  it('keeps unknown, task, branch and project scope boundaries separate', () => {
    store.registerProject('other_project')
    captureEpisode('first', { taskId: 'task', branchId: 'branch' })
    captureEpisode('other_task', { taskId: 'other', branchId: 'branch' })
    captureEpisode('other_branch', { taskId: 'task', branchId: 'other' })
    captureEpisode('unknown_scope')
    captureEpisode('other_project', { projectId: 'other_project', taskId: 'task', branchId: 'branch' })
    captureEpisode('compatible', { taskId: 'task', branchId: 'branch' })
    const lease = claim()
    expect(lease.sources.map(source => source.id)).toEqual(['first', 'compatible'])
    expect(lease.access).toMatchObject({ projectIds: ['project'], taskId: 'task', branchId: 'branch' })
    expect(store.learning.status().jobs).toEqual({ reviewing: 2, queued: 4 })
  })

  it('rolls back the whole batch on invalid evidence, then retries failed episodes individually', () => {
    const first = captureEpisode('first'), second = captureEpisode('second')
    store.ingest(event('outside_batch'))
    const lease = claim()
    lease.episodes.push({ jobId: 'forged_member', sourceIds: ['outside_batch'], context: 'complete' })
    lease.sources.push(event('outside_batch'))
    expect(store.learning.finish(lease, [proposal(first), proposal(event('outside_batch'), { conflictKey: 'other' })], target))
      .toEqual({ state: 'failed', reason: 'episode_evidence' })
    expect(store.list(access)).toEqual([])
    expect(store.learning.status().jobs).toEqual({ failed: 2 })
    expect(store.source(second.id, access)).not.toBeNull()
    now += 300_001
    const retry = claim()
    expect(retry.sources.map(source => source.id)).toEqual(['first'])
    expect(store.learning.finish(retry, [proposal(first)], target).state).toBe('learned')
    expect(claim().sources.map(source => source.id)).toEqual(['second'])
  })

  it.each(['first', 'second'])('rejects all output when %s becomes private, and releases only the still-authorized episode', privateId => {
    const first = captureEpisode('first'), second = captureEpisode('second')
    const lease = claim()
    expect(lease.episodes).toHaveLength(2)
    store.setSessionIncluded('claude', `session_${privateId}`, false)
    expect(store.learning.finish(lease, [proposal(first), proposal(second)], target).state).toBe('stale')
    expect(store.list(access)).toEqual([])
    expect(store.learning.status().jobs).toEqual({ cancelled: 1, queued: 1 })
    expect(claim().sources.map(source => source.id)).toEqual([privateId === 'first' ? 'second' : 'first'])
  })

  it('recovers every member after restart and rejects a late result without releasing the replacement lease', () => {
    captureEpisode('first'); captureEpisode('second'); captureEpisode('third')
    const abandoned = claim()
    store.close(); store = open()
    now = abandoned.until + 1
    const recovered = claim()
    expect(recovered.sources.map(source => source.id)).toEqual(['first', 'second', 'third'])
    expect(recovered.token).not.toBe(abandoned.token)
    expect(store.learning.finish(abandoned, [], target).state).toBe('stale')
    expect(store.learning.status().jobs).toEqual({ reviewing: 3 })
    store.learning.defer(recovered, 'queued')
    expect(store.learning.status().jobs).toEqual({ queued: 3 })
    expect(store.learning.status().callsLastHour).toBe(2)
  })

  it('keeps byte and source-count caps when several complete episodes are waiting', () => {
    for (let i = 0; i < 4; i++) captureEpisode(`large_${i}`, { text: 'x'.repeat(31_500) })
    const large = claim()
    expect(large.episodes).toHaveLength(3)
    expect(Buffer.byteLength(JSON.stringify(large.sources))).toBeLessThanOrEqual(96_000)
    store.learning.finish(large, [], target)
    store.learning.finish(claim(), [], target)
    for (let i = 0; i < 4; i++) {
      store.learning.capture(batch(`many_${i}`, { streamId: `many_${i}`,
        events: Array.from({ length: 64 }, (_, index) => event(`many_${i}_${index}`)) }))
      now++
    }
    const many = claim()
    expect(many.episodes).toHaveLength(2)
    expect(many.sources).toHaveLength(128)
    expect(store.learning.status().jobs.queued).toBe(2)
  })

  it('preserves episode boundaries without duplicating shared source text or support', () => {
    store.learning.capture(batch())
    store.learning.capture(batch('second', { from: 'first', events: [event()] }))
    const lease = claim()
    expect(lease.sources).toHaveLength(1)
    expect(lease.episodes.map(episode => episode.sourceIds)).toEqual([['first'], ['first']])
    const result = store.learning.finish(lease, [proposal()], target)
    expect(result.state).toBe('learned')
    expect(store.learning.status().jobs.learned).toBe(2)
    expect(store.support(store.list(access)[0].id, access)?.independentUserStatements).toBe(1)
  })

  it('opens an earlier queue without batch metadata and recovers its unfinished lease after expiry', () => {
    captureEpisode('first')
    const old = claim()
    store.close()
    const Database = builtinSqlite()!
    const legacy = new Database(join(directory, 'memory.sqlite'), { readOnly: false })
    try { legacy.exec("DROP TABLE memory_inference_jobs; DROP TABLE memory_job_context; UPDATE memory_meta SET value='1' WHERE key='schema'") } finally { legacy.close() }
    store = open()
    expect(store.learning.claim(target).state).toBe('idle')
    expect(store.learning.finish(old, [], target).state).toBe('stale')
    expect(store.source('first', access)?.text).toBe(event().text)
    now = old.until + 1
    const recovered = claim()
    expect(recovered.episodes).toEqual([{ jobId: 'episode_first', sourceIds: ['first'], context: 'complete' }])
    expect(store.learning.status().callsLastHour).toBe(2)
    expect(store.learning.finish(recovered, [], target).state).toBe('no_useful_memory')
  })
})

describe('durable coding episode capture', () => {
  it('retains bounded context after restart and admits a self-contained user preference', () => {
    store.learning.capture(batch('first', { boundary: 'bounded' }))
    store.close(); store = open()
    const lease = claim()
    expect(lease.episodes[0].context).toBe('bounded')
    expect(store.learning.finish(lease, [proposal()], target).state).toBe('learned')
    expect(store.list(access)[0].claim).toBe(proposal().claim)
  })

  it.each(['assistant_evidence', 'inferred', 'temporary_state', 'verified_finding'] as const)
  ('rejects %s from bounded context even when the caller forges complete lease metadata', variant => {
    const assistant = event('assistant', { role: 'assistant', text: 'Every test passed.' })
    store.learning.capture(batch('first', { events: [event(), assistant], boundary: 'bounded' }))
    const lease = claim()
    lease.episodes[0].context = 'complete'
    const draft = proposal()
    if (variant === 'assistant_evidence') draft.evidence.push({ sourceEventId: assistant.id, quote: assistant.text, paths: ['/claim'] })
    else if (variant === 'inferred') draft.evidenceClass = 'inferred'
    else draft.assertionType = variant
    expect(store.learning.finish(lease, [draft], target)).toEqual({ state: 'failed', reason: 'bounded_context_evidence' })
    expect(store.list(access)).toEqual([])
  })

  it('captures the first user turn before an assistant reply and resumes after reopen', () => {
    store.learning.capture(batch('first', { boundary: 'open' }))
    expect(store.learning.claim(target).state).toBe('idle')
    store.close()
    store = open()
    expect(store.learning.cursor('stream')).toBe('first')
    expect(store.learning.capture(batch('first', { boundary: 'open' })).disposition).toBe('duplicate')
    store.learning.capture(batch('end', { from: 'first', episodeId: 'episode_first', events: [], boundary: 'complete' }))
    const lease = claim()
    expect(lease.sources.map(source => source.id)).toEqual(['first'])
    const result = store.learning.finish(lease, [proposal()], target)
    expect(result.state).toBe('learned')
    expect(store.learning.status().jobs.learned).toBe(1)
    expect(store.list(access)).toHaveLength(1)
    expect(store.learning.claim(target).state).toBe('idle')
  })

  it('rolls back sources, cursor, and jobs together when any input is ineligible', () => {
    expect(() => store.learning.capture(batch('bad', { events: [event('good'), event('private', { eligibility: 'private' })] })))
      .toThrow('source_ineligible')
    expect(store.learning.cursor('stream')).toBeNull()
    expect(store.source('good', access)).toBeNull()
    expect(store.learning.status().capturedStreams).toBe(0)
    expect(store.learning.status().jobs).toEqual({})
  })

  it('does not acknowledge an out-of-order cursor or broaden episode ownership', () => {
    store.learning.capture(batch())
    expect(() => store.learning.capture(batch('second', { from: 'missing' }))).toThrow('cursor_conflict')
    expect(store.learning.cursor('stream')).toBe('first')
    expect(store.source('second', access)).toBeNull()
    expect(() => store.learning.capture(batch('second', { from: 'first', events: [event('foreign', { projectId: null })] }))).toThrow('episode_scope')
    expect(store.learning.cursor('stream')).toBe('first')
  })

  it('preserves incomplete source status without pretending an extraction found no memory', () => {
    store.learning.capture(batch('partial', { boundary: 'incomplete' }))
    expect(store.learning.claim(target).state).toBe('idle')
    expect(store.learning.status().jobs.source_incomplete).toBe(1)
    expect(store.learning.status().jobs.no_useful_memory).toBeUndefined()
    store.learning.capture(batch('completed', { from: 'partial', episodeId: 'episode_partial', events: [] }))
    const lease = claim()
    expect(store.learning.finish(lease, [], target).state).toBe('no_useful_memory')
  })
})

describe('model availability, leases, and idempotent publication', () => {
  it('shows personal defaults to project reviews without authorizing project evidence to rewrite global preferences', () => {
    const personal = event('personal', { projectId: null, sessionId: 'companion' })
    store.ingest(personal)
    const personalAccess = { ...access, includeProfile: true }
    const original = store.propose(proposal(personal, { scope: { profileId: 'owner' } }), personalAccess).record
    store.learning.capture(batch())
    const lease = claim()
    expect(store.list(lease.access).map(record => record.id)).toContain(original.id)
    const result = store.learning.finish(lease, [proposal(event(), { scope: { profileId: 'owner' } })], target)
    expect(result).toEqual({ state: 'failed', reason: 'evidence_scope' })
    expect(store.read(original.id, personalAccess)?.revision).toBe(1)
    expect(store.support(original.id, personalAccess)?.independentUserStatements).toBe(1)
  })

  it('cancels private work and rejects late extraction, including episodes with derived private roots', () => {
    store.learning.capture(batch())
    const lease = claim()
    const parent = store.propose(proposal(), access).record
    const derived = event('echo', { sessionId: 'public_session', role: 'derived', rootIds: ['first'],
      derivedFrom: [{ memoryId: parent.id, revision: 1 }] })
    store.learning.capture(batch('echo', { streamId: 'another_stream', sessionId: 'public_session', events: [derived] }))
    store.setSessionIncluded('claude', 'session', false)
    expect(store.learning.status().jobs.cancelled).toBe(2)
    expect(store.learning.finish(lease, [proposal()], target)).toEqual({ state: 'stale', reason: 'lease_changed' })
    expect(store.learning.claim(target).state).toBe('idle')
    expect(() => store.learning.capture(batch('private', { from: 'first', events: [] }))).toThrow('source_ineligible')
    expect(() => store.learning.checkpoint({ streamId: 'stream', engine: 'claude', sessionId: 'session', projectId: 'project',
      from: 'first', to: 'private', generation: store.controls().generation })).toThrow('source_ineligible')
  })

  it('retains observations when the selected model is unavailable and resumes without fallback', () => {
    store.learning.capture(batch())
    expect(store.learning.claim({ state: 'unsupported' }).state).toBe('waiting_for_model')
    expect(store.learning.status().callsLastHour).toBe(0)
    store.close()
    store = open()
    expect(store.learning.status().jobs.waiting_for_model).toBe(1)
    now += 60_000
    expect(claim().sources).toHaveLength(1)
  })

  it('leases at most one review per project and recovers an expired process without accepting its late result', () => {
    store.learning.capture(batch())
    store.learning.capture(batch('second', { from: 'first' }))
    const first = claim()
    const other = open()
    expect(other.learning.claim(target).state).toBe('idle')
    now = first.until + 1
    const recovered = claim(other)
    expect(recovered.jobId).toBe(first.jobId)
    expect(recovered.token).not.toBe(first.token)
    expect(store.learning.finish(first, [proposal()], target).state).toBe('stale')
    expect(other.learning.finish(recovered, [proposal()], target).state).toBe('learned')
    expect(store.learning.finish(recovered, [proposal()], target).state).toBe('stale')
    expect(store.list(access)).toHaveLength(1)
  })

  it('rejects a completed result after the model/account or capture controls change', () => {
    store.learning.capture(batch())
    const lease = claim()
    expect(store.learning.finish(lease, [proposal()], { ...target, key: 'new-account' }).state).toBe('stale')
    expect(store.list(access)).toEqual([])
    const fresh = claim()
    store.setControls({ learn: false, recall: true })
    expect(store.learning.finish(fresh, [proposal()], target).state).toBe('stale')
    expect(store.learning.claim(target).state).toBe('learning_off')
    store.setControls({ learn: true, recall: true })
    expect(store.learning.finish(claim(), [proposal()], target).state).toBe('learned')
  })

  it('reserves the rolling inference budget durably and preserves deferred sources and foreground priority', () => {
    let previous: string | null = null
    for (let index = 0; index < 25; index++) {
      const id = `source_${index}`
      store.learning.capture(batch(id, { from: previous }))
      previous = id
      now++
    }
    expect(store.learning.claim({ ...target, foregroundBusy: true }).state).toBe('foreground_busy')
    for (let index = 0; index < 6; index++) expect(store.learning.finish(claim(), [], target).state).toBe('no_useful_memory')
    store.close()
    store = open()
    expect(store.learning.claim(target).state).toBe('budget_deferred')
    expect(store.learning.status().callsLastHour).toBe(6)
    expect(store.learning.status().jobs.budget_deferred).toBe(1)
    expect(store.learning.cursor('stream')).toBe('source_24')
    now += 3_600_001
    expect(claim().sources.map(source => source.id)).toEqual(['source_24'])
  })

  it('publishes a proposal batch atomically and rejects evidence outside the captured episode', () => {
    store.learning.capture(batch())
    store.ingest(event('unrelated'))
    const lease = claim()
    const result = store.learning.finish(lease, [proposal(), proposal(event('unrelated'), { conflictKey: 'other' })], target)
    expect(result).toEqual({ state: 'failed', reason: 'episode_evidence' })
    expect(store.list(access)).toEqual([])
    expect(store.learning.status().jobs.failed).toBe(1)
    expect(store.source('first', access)).not.toBeNull()
  })

  it('keeps interrupted calls in the rolling budget even when the same episode is immediately eligible again', () => {
    store.learning.capture(batch())
    for (let index = 0; index < 6; index++) store.learning.defer(claim(), 'queued')
    expect(store.learning.claim(target).state).toBe('budget_deferred')
    expect(store.learning.status().callsLastHour).toBe(6)
    expect(store.source('first', access)).not.toBeNull()
    now += 3_600_001
    expect(claim().sources.map(source => source.id)).toEqual(['first'])
  })

  it('cancels jobs and late model output when their supporting memory is forgotten', () => {
    const unique = 'forgotten_queued_lemur'
    const source = event('first', { text: `For debugging use ${unique}.` })
    store.learning.capture(batch('first', { events: [source] }))
    const lease = claim()
    const record = store.propose(proposal(source, { claim: source.text }), access).record
    store.forget(record.id, 1, access)
    expect(store.learning.finish(lease, [proposal(source)], target)).toEqual({ state: 'stale', reason: 'lease_changed' })
    expect(store.learning.status().jobs.cancelled).toBe(1)
    expect(store.source('first', access)).toBeNull()
    expect(readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(unique))).toBe(false)
    expect(store.learning.capture(batch('replayed', { from: 'first', events: [source] })).state).toBe('cancelled')
  })

  it('rejects a late broader proposal after the owner narrows its memory to a project', () => {
    const source = event('personal', { projectId: null })
    store.learning.capture(batch('personal', { projectId: null, events: [source] }))
    const lease = claim()
    const broad = proposal(source, { scope: { profileId: 'owner' } })
    const record = store.propose(broad, lease.access).record
    const preview = store.libraryPreview('owner', { kind: 'narrow', id: record.id, revision: 1, projectId: 'project' })
    expect(store.learning.status().jobs.reviewing).toBe(1) // Preview rolls back cancellation too.
    store.libraryApply('owner', preview.command, preview.version, true)
    expect(store.learning.finish(lease, [broad], target)).toEqual({ state: 'stale', reason: 'lease_changed' })
    expect(store.learning.status().jobs.cancelled).toBe(1)
    expect(store.libraryPage('owner', { scope: 'personal' }).items).toEqual([])
    expect(store.libraryDetail('owner', record.id)!.record.scope.projectId).toBe('project')
    expect(store.source(source.id, lease.access)).not.toBeNull()
  })
})
