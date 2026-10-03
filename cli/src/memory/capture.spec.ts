import { mkdtempSync, rmSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { digest } from './admission.js'
import { decodeMemoryRecord } from './native.js'
import { NativeMemoryCapture, type CaptureSession } from './capture.js'
import { QUEUE_OPERATIONS, type MemoryPort, type Operation, type Arguments, type Result } from './operations.js'

let directory: string, store: CodingMemoryStore, capture: NativeMemoryCapture, memory: MemoryPort, session: CaptureSession, now: number
const target = { state: 'ready' as const, key: 'selected' }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-capture-'))
  now = Date.now() - 1_000
  const result = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'owner', now: () => now })
  if (!result.ok) throw new Error(result.reason)
  store = result.store
  store.registerProject('project')
  store.setControls({ learn: true, recall: true })
  memory = { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
    const owner = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
    return (owner as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(owner, args) as Result<K>
  } }
  capture = new NativeMemoryCapture(memory, () => now)
  session = { profileId: 'owner', projectId: 'project', engine: 'claude', sessionId: 'session', transcriptPath: join(directory, 'transcript.jsonl'), busy: true }
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
function user(text = 'I prefer small changes.', id = 'user', at = now + 1): string {
  return JSON.stringify({ type: 'user', uuid: id, timestamp: new Date(at).toISOString(), message: { content: text } }) + '\n'
}
function answer(text = 'Understood.', id = 'answer'): string {
  return JSON.stringify({ type: 'assistant', uuid: id, timestamp: new Date(now + 2).toISOString(), message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } }) + '\n'
}
function claim() {
  const result = store.learning.claim(target)
  if (result.state !== 'claimed') throw new Error(result.state)
  return result.lease
}

it('persists the very first user message, resumes its cursor, and closes on the native reply', async () => {
  await writeFile(session.transcriptPath, user())
  expect(await capture.poll(session)).toEqual({ state: 'captured', sources: 1 })
  expect(store.learning.status().jobs.open).toBe(1)
  capture = new NativeMemoryCapture(memory, () => now)
  expect(await capture.poll(session)).toEqual({ state: 'idle', sources: 0 })
  await appendFile(session.transcriptPath, answer())
  expect((await capture.poll(session)).sources).toBe(1)
  const lease = claim()
  expect(lease.sources.map(source => source.role)).toEqual(['user', 'assistant'])
  expect(lease.sources[0].text).toBe('I prefer small changes.')
  store.learning.finish(lease, [], target)
  expect((await capture.poll(session)).sources).toBe(0)
  expect(store.learning.status().jobs.no_useful_memory).toBe(1)
})

it('waits for a complete UTF-8 JSON line before acknowledging its bytes', async () => {
  const line = Buffer.from(user('I prefer café-sized demos.'))
  const split = line.indexOf(Buffer.from('é')) + 1
  await writeFile(session.transcriptPath, line.subarray(0, split))
  expect((await capture.poll(session)).sources).toBe(0)
  await appendFile(session.transcriptPath, Buffer.concat([line.subarray(split), Buffer.from(answer())]))
  expect((await capture.poll(session)).sources).toBe(2)
  expect(claim().sources[0].text).toBe('I prefer café-sized demos.')
})

it('does not backfill messages from before consent or from a paused capture interval', async () => {
  await writeFile(session.transcriptPath, user('Old private work.', 'old', now - 100) + answer())
  await capture.poll(session)
  expect(claim().sources.map(source => source.text)).toEqual(['Understood.'])
  now += 1_000
  store.setControls({ learn: false, recall: true })
  await appendFile(session.transcriptPath, user('While learning was paused.', 'paused'))
  expect((await capture.poll(session)).state).toBe('learning_off')
  now += 1_000
  store.setControls({ learn: true, recall: true })
  await appendFile(session.transcriptPath, user('After re-enabling.', 'new') + answer('New reply.', 'new-answer'))
  expect((await capture.poll(session)).sources).toBe(2)
  // The old project lease is still in flight, but the new episode and its two sources are durable.
  expect(store.learning.status().jobs.queued).toBe(1)
  now += 120_001
  const recovered = claim()
  expect(recovered.sources.map(source => source.text)).toEqual(['Understood.', 'After re-enabling.', 'New reply.'])
  expect(recovered.episodes).toHaveLength(2)
  store.learning.finish(recovered, [], target)
  expect(store.learning.status().jobs.no_useful_memory).toBe(2)
})

it('detects an in-place rewrite and establishes a new baseline without relearning its history', async () => {
  await writeFile(session.transcriptPath, user('Before rewrite.'))
  await capture.poll(session)
  await writeFile(session.transcriptPath, user('Replacement history must not count twice.', 'replacement'))
  expect(await capture.poll(session)).toEqual({ state: 'source_changed', sources: 0, reason: 'transcript_rewritten' })
  expect(store.learning.status().jobs.source_incomplete).toBe(1)
  await appendFile(session.transcriptPath, user('A new live preference.', 'new') + answer())
  await capture.poll(session)
  expect(claim().sources.map(source => source.text)).toEqual(['A new live preference.', 'Understood.'])
})

it('keeps oversized input incomplete without discarding later intact instructions', async () => {
  await writeFile(session.transcriptPath, user('x'.repeat(600_000)) + user('A small preference.', 'small') + answer())
  const result = await capture.poll(session)
  expect(result.state).toBe('captured')
  expect(result.sources).toBe(2)
  expect(store.learning.status().jobs.source_incomplete).toBe(1)
  const lease = claim()
  expect(lease.sources.map(source => source.text)).toEqual(['A small preference.', 'Understood.'])
  expect(lease.episodes[0].context).toBe('bounded')
})

it.each(['bytes', 'count'] as const)('preserves intact instructions when a long turn reaches its %s limit', async limit => {
  const records = Array.from({ length: limit === 'bytes' ? 4 : 130 }, (_, index) => JSON.stringify({
    type: 'assistant', uuid: `progress-${index}`, timestamp: new Date(now + 2).toISOString(),
    message: { content: [{ type: 'text', text: limit === 'bytes' ? 'x'.repeat(30_000) : `Progress ${index}.` }] },
  }) + '\n')
  await writeFile(session.transcriptPath, user() + records.join('') + answer())
  await capture.poll(session)
  capture = new NativeMemoryCapture(memory, () => now)
  await capture.poll(session)
  expect(store.learning.status().jobs.source_incomplete).toBeUndefined()
  const captured = []
  while (store.learning.status().jobs.queued) {
    const lease = claim()
    captured.push(...lease.sources)
    expect(lease.episodes.every(episode => episode.context === 'bounded')).toBe(true)
    expect(lease.sources.length).toBeLessThanOrEqual(128)
    expect(Buffer.byteLength(JSON.stringify(lease.sources))).toBeLessThanOrEqual(96_000)
    store.learning.finish(lease, [], target)
  }
  expect(captured).toHaveLength(records.length + 2)
  expect(captured.filter(source => source.role === 'user').map(source => source.text)).toEqual(['I prefer small changes.'])
})

it('isolates a missing tool record, keeps both neighboring instructions, and resets at the next turn', async () => {
  await writeFile(session.transcriptPath, user('Keep the viewer on the left.', 'before')
    + JSON.stringify({ type: 'user', uuid: 'large-tool', timestamp: new Date(now + 2).toISOString(),
      message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'x'.repeat(40_000) }] } }) + '\n'
    + user('Keep keyboard navigation.', 'after') + answer())
  await capture.poll(session)
  const bounded = claim()
  expect(bounded.sources.filter(source => source.role === 'user').map(source => source.text).sort())
    .toEqual(['Keep keyboard navigation.', 'Keep the viewer on the left.'])
  expect(bounded.episodes).toHaveLength(2)
  expect(bounded.episodes.every(episode => episode.context === 'bounded')).toBe(true)
  expect(store.learning.status().jobs.source_incomplete).toBe(1)
  store.learning.finish(bounded, [], target)
  await appendFile(session.transcriptPath, user('A fresh turn.', 'fresh') + answer('Fresh reply.', 'fresh-reply'))
  await capture.poll(session)
  expect(claim().episodes[0].context).toBe('complete')
})

it('retains a gap across restart without treating an empty native completion as missing context in the next turn', async () => {
  await writeFile(session.transcriptPath, user('x'.repeat(40_000)))
  await capture.poll(session)
  store.close()
  const reopened = CodingMemoryStore.open({ directory: join(directory, 'memory'), profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  capture = new NativeMemoryCapture(memory, () => now)
  await appendFile(session.transcriptPath, user('Preserve keyboard navigation.', 'bounded'))
  await capture.poll(session)
  await appendFile(session.transcriptPath, answer('', 'empty') + user('A new request.', 'fresh') + answer())
  await capture.poll(session)
  const lease = claim()
  const contexts = lease.episodes.map(episode => ({ context: episode.context,
    text: lease.sources.find(source => episode.sourceIds.includes(source.id) && source.role === 'user')?.text }))
  expect(contexts).toEqual(expect.arrayContaining([
    { context: 'bounded', text: 'Preserve keyboard navigation.' },
    { context: 'complete', text: 'A new request.' },
  ]))
  expect(store.learning.status().jobs.source_incomplete).toBe(1)
})

it('closes a quiet, settled first message even without a native Stop record', async () => {
  await writeFile(session.transcriptPath, user())
  await capture.poll(session)
  now += 7_000
  await capture.poll({ ...session, busy: false })
  expect(claim().sources[0].text).toBe('I prefer small changes.')
})

it('does not silently reassign a session to a different project', async () => {
  await writeFile(session.transcriptPath, user())
  await capture.poll(session)
  store.registerProject('other')
  await appendFile(session.transcriptPath, answer())
  expect((await capture.poll({ ...session, projectId: 'other' })).reason).toBe('stream_identity_conflict')
  expect(store.learning.status().jobs.queued).toBeUndefined()
})

it('excludes copied history before the host-observed fork boundary', async () => {
  await writeFile(session.transcriptPath, user('Copied parent statement.', 'copied', now + 10)
    + user('A fresh statement in the fork.', 'fresh', now + 100) + answer())
  await capture.poll({ ...session, sessionId: 'fork', liveFrom: now + 50 })
  expect(claim().sources.map(source => source.text)).toEqual(['A fresh statement in the fork.'])
})

it('checks session and project exclusions before opening a transcript', async () => {
  store.setSessionIncluded(session.engine, session.sessionId, false)
  expect((await capture.poll(session)).reason).toBe('source_ineligible') // The path does not exist.
  store.setSessionIncluded(session.engine, session.sessionId, true)
  store.setProjectIncluded(session.projectId!, false)
  expect((await capture.poll(session)).reason).toBe('source_ineligible')
  expect(store.learning.status().capturedStreams).toBe(0)
})

it.each(['session', 'project'] as const)('resumes after a private %s interval without replaying it or getting stuck on a cancelled episode', async kind => {
  const include = (value: boolean) => kind === 'session' ? store.setSessionIncluded(session.engine, session.sessionId, value)
    : store.setProjectIncluded(session.projectId!, value)
  await writeFile(session.transcriptPath, user('Before privacy.', 'before'))
  await capture.poll(session)
  now += 1_000
  include(false)
  await appendFile(session.transcriptPath, user('Inside the private interval.', 'private') + answer())
  expect((await capture.poll(session)).reason).toBe('source_ineligible')
  now += 1_000
  include(true)
  await appendFile(session.transcriptPath, user('After privacy.', 'after') + answer('A fresh reply.', 'fresh'))
  expect(await capture.poll(session)).toEqual({ state: 'captured', sources: 2 })
  expect(store.learning.status().jobs.cancelled).toBe(1)
  expect(claim().sources.map(source => source.text)).toEqual(['After privacy.', 'A fresh reply.'])
})

it('resumes fresh learning after forgetting cancels an episode that is still being captured', async () => {
  const input = user()
  await writeFile(session.transcriptPath, input)
  await capture.poll(session)
  const access = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
  const part = decodeMemoryRecord('claude', input).parts[0]
  const id = digest([session.profileId, session.engine, session.sessionId, part.nativeEventId])
  const record = store.propose({ kind: 'working_preference', facet: 'changes', assertionType: 'stated_preference',
    scope: { profileId: 'owner', projectId: 'project' }, claim: part.text, rationale: null, futureAction: part.text,
    applicability: {}, exceptions: [], retrievalCues: ['changes'], evidenceClass: 'user_stated',
    evidence: [{ sourceEventId: id, quote: part.text, paths: ['/claim', '/futureAction', '/applicability'] }],
    conflictKey: 'change_size', validity: { validFrom: null, validUntil: null, recheckWhen: [] },
  }, access).record
  store.forget(record.id, 1, access)
  await appendFile(session.transcriptPath, user('Use accessible contrast.', 'fresh') + answer())
  expect(await capture.poll(session)).toEqual({ state: 'captured', sources: 2 })
  expect(claim().sources.map(source => source.text)).toEqual(['Use accessible contrast.', 'Understood.'])
})
