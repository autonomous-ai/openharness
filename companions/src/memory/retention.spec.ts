import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { MAX_EPISODES_PER_CALL, MAX_PENDING_EPISODES, PENDING_RETENTION_MS, type CaptureBatch } from './queue.js'
import type { MemoryDraft, SourceEvent } from './types.js'

let directory: string, store: CodingMemoryStore, now: number
const access = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
const target = { state: 'ready' as const, key: 'selected-model' }
const preference = 'For coding fixes, start with a small failing test.'
function event(id: string, text = `${preference}\nUnused context ${id}_unused_lemur.`): SourceEvent {
  return { id, profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'session', nativeEventId: id,
    role: 'user', eligibility: 'coding', observedAt: now, rootIds: [id], text }
}
function draft(source: SourceEvent): MemoryDraft {
  return { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference', scope: { profileId: 'owner', projectId: 'project' },
    claim: preference, rationale: null, futureAction: 'Start with a small failing test.', applicability: { taskType: 'debugging' },
    exceptions: [], retrievalCues: ['fixes'], evidenceClass: 'user_stated',
    evidence: [{ sourceEventId: source.id, quote: preference, paths: ['/claim', '/futureAction', '/applicability'] }],
    conflictKey: 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
}
function capture(source: SourceEvent, changes: Partial<CaptureBatch> = {}): void {
  store.learning.capture({ streamId: 'stream', engine: 'claude', sessionId: 'session', projectId: 'project', episodeId: source.id,
    from: store.learning.cursor('stream'), to: source.id, events: [source], boundary: 'complete', ...changes })
}
function claim() {
  const result = store.learning.claim(target)
  if (result.state !== 'claimed') throw new Error(result.state)
  return result.lease
}
function bytesContain(value: string): boolean { return readFileSync(join(directory, 'memory.sqlite')).includes(Buffer.from(value)) }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-retention-'))
  now = 1_000
  const opened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!opened.ok) throw new Error(opened.reason)
  store = opened.store
  store.registerProject('project')
  store.setControls({ learn: true, recall: true })
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('purges unused text after no-useful-memory and keeps content-free replay protection', () => {
  const source = event('unused')
  capture(source)
  expect(store.learning.finish(claim(), [], target).state).toBe('no_useful_memory')
  expect(store.source(source.id, access)).toBeNull()
  expect(bytesContain('unused_unused_lemur')).toBe(false)
  expect(store.learning.cursor('stream')).toBe(source.id)
  expect(store.ingest(source).disposition).toBe('retired')
  expect(() => store.ingest({ ...source, text: 'Changed content.' })).toThrow('source_identity_conflict')
  capture(source, { to: 'replay', episodeId: 'replay' })
  expect(store.learning.status().jobs.cancelled).toBe(1)
  expect(store.learning.status().jobs.no_useful_memory).toBe(1)
})

it('keeps exact evidence while removing unused surrounding conversation text', () => {
  const source = event('learned')
  capture(source)
  const result = store.learning.finish(claim(), [draft(source)], target)
  expect(result.state).toBe('learned')
  expect(store.source(source.id, access)).toMatchObject({ text: preference, retention: 'evidence_only' })
  expect(bytesContain('learned_unused_lemur')).toBe(false)
  expect(store.ingest(source).disposition).toBe('duplicate')
  const record = store.list(access)[0]
  expect(store.history(record.id, access)[0].evidence[0].quote).toBe(preference)
  expect(store.recall({ query: 'fixes', conditions: { taskType: 'debugging' } }, access).items).toHaveLength(1)
  expect(store.maintain()).toEqual({ expiredJobs: 0, compactedSources: 0, deletedSources: 0, removedBytes: 0 })
})

it('preserves full input until every pending episode that shares it has finished', () => {
  const source = event('shared')
  capture(source)
  capture(source, { episodeId: 'another', to: 'another', boundary: 'open' })
  expect(store.learning.finish(claim(), [draft(source)], target).state).toBe('learned')
  expect(store.source(source.id, access)?.text).toBe(source.text)
  capture(source, { episodeId: 'another', to: 'another_end', events: [] })
  expect(claim().sources[0].text).toBe(source.text)
  now += 120_001
  expect(store.learning.finish(claim(), [], target).state).toBe('no_useful_memory')
  expect(store.source(source.id, access)?.text).toBe(preference)
})

it('applies backpressure without acknowledging or saving a new episode when the backlog is full', () => {
  for (let i = 0; i < MAX_PENDING_EPISODES; i++) capture(event(`source_${i}`))
  const cursor = store.learning.cursor('stream')
  const next = event('blocked')
  expect(() => capture(next)).toThrow('memory_backlog_full')
  expect(store.learning.cursor('stream')).toBe(cursor)
  expect(store.source(next.id, access)).toBeNull()
  store.learning.finish(claim(), [], target)
  capture(next)
  expect(store.learning.cursor('stream')).toBe(next.id)
  expect(store.learning.status().jobs.queued).toBe(MAX_PENDING_EPISODES - MAX_EPISODES_PER_CALL + 1)
  for (let i = 1; i < MAX_EPISODES_PER_CALL; i++) capture(event(`refilled_${i}`))
  expect(store.learning.status().jobs.queued).toBe(MAX_PENDING_EPISODES)
  const fullCursor = store.learning.cursor('stream')
  expect(() => capture(event('still_blocked'))).toThrow('memory_backlog_full')
  expect(store.learning.cursor('stream')).toBe(fullCursor)
}, 30_000) // Hundreds of durable writes; this is a backpressure check, not a five-second benchmark.

it('expires unreviewed input as an explicit gap, rejects late results and eventually prunes job metadata', () => {
  const source = event('expired')
  capture(source)
  const lease = claim()
  capture(event('open'), { boundary: 'open' })
  capture(event('waiting'))
  now += PENDING_RETENTION_MS
  expect(store.maintain()).toMatchObject({ expiredJobs: 3, deletedSources: 3 })
  expect(store.learning.status().jobs).toEqual({ expired: 3 })
  expect(store.learning.status().oldestPendingAt).toBeNull()
  expect(store.learning.finish(lease, [draft(source)], target)).toEqual({ state: 'stale', reason: 'lease_changed' })
  expect(bytesContain('expired_unused_lemur')).toBe(false)
  now += 31 * 24 * 60 * 60 * 1_000
  store.maintain()
  expect(store.learning.status().jobs).toEqual({})
  expect(store.learning.status().callsLastHour).toBe(0)
  expect(store.learning.status().retention.expiredEpisodes).toBe(3)
  expect(store.ingest(source).disposition).toBe('retired')
})

it('does not send expired input to a model or accept an expired in-flight result between maintenance passes', () => {
  const source = event('aged')
  capture(source)
  const lease = claim()
  now += PENDING_RETENTION_MS
  expect(store.learning.finish(lease, [draft(source)], target).state).toBe('stale')
  expect(store.learning.status().retention.expiredEpisodes).toBe(1)
  capture(event('next'))
  now += PENDING_RETENTION_MS
  expect(store.learning.claim(target).state).toBe('idle')
  expect(store.learning.status().retention.expiredEpisodes).toBe(2)
  expect(store.learning.status().jobs.learned).toBeUndefined()
})

it('cleans old orphan input and retains evidence from every revision and independent confirmation', () => {
  const first = event('first')
  store.ingest(first)
  const record = store.propose(draft(first), access).record
  const second = event('second')
  store.ingest(second)
  store.propose(draft(second), access)
  const correction = event('correction', 'Explain the state model first. correction_unused_lemur')
  store.ingest(correction)
  store.revise(record.id, 1, { ...draft(correction), claim: 'Explain the state model first.',
    evidence: [{ sourceEventId: correction.id, quote: 'Explain the state model first.', paths: ['/claim', '/futureAction', '/applicability'] }] }, access)
  store.ingest(event('orphan'))
  now += PENDING_RETENTION_MS
  expect(store.maintain()).toMatchObject({ compactedSources: 3, deletedSources: 1 })
  expect(store.history(record.id, access)).toHaveLength(2)
  expect(store.source(first.id, access)?.text).toBe(preference)
  expect(store.source(second.id, access)?.text).toBe(preference)
  expect(store.source(correction.id, access)?.text).toBe('Explain the state model first.')
  expect(bytesContain('correction_unused_lemur')).toBe(false)
  expect(bytesContain('orphan_unused_lemur')).toBe(false)
})

it('bounds each cleanup pass while preserving later work for subsequent passes', () => {
  for (let job = 0; job < 9; job++) {
    const events = Array.from({ length: 64 }, (_, i) => event(`event_${job}_${i}`))
    capture(events[0], { events, episodeId: `job_${job}`, to: `cursor_${job}` })
  }
  now += PENDING_RETENTION_MS
  expect(store.maintain()).toMatchObject({ expiredJobs: 9, deletedSources: 512 })
  expect(store.maintain()).toMatchObject({ expiredJobs: 0, deletedSources: 64 })
  expect(store.maintain()).toMatchObject({ expiredJobs: 0, deletedSources: 0 })
})
