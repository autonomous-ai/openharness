import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodingMemoryStore } from './store.js'
import { MemoryLearner, type MemoryInference } from './learner.js'
import { QUEUE_OPERATIONS, type MemoryPort, type Operation, type Arguments, type Result } from './operations.js'
import { MemoryError, type MemoryAccess, type MemoryDraft, type SourceEvent } from './types.js'
import { PENDING_RETENTION_MS } from './queue.js'

const access: MemoryAccess = { profileId: 'owner', projectIds: ['project'], includeProfile: false }
const event: SourceEvent = { id: 'first', profileId: 'owner', projectId: 'project', engine: 'codex', sessionId: 'session',
  nativeEventId: 'first', role: 'user', eligibility: 'coding', observedAt: 1, rootIds: ['first'],
  text: 'For debugging start with a small failing test because it makes review easier.' }
const proposal: MemoryDraft = { kind: 'working_preference', facet: 'debugging', assertionType: 'stated_preference',
  scope: { profileId: 'owner', projectId: 'project' }, claim: 'For debugging, start with a small failing test.',
  rationale: 'It makes review easier.', futureAction: 'Start with a small failing test.', applicability: { taskType: 'debugging' },
  exceptions: [], retrievalCues: ['bug', 'test'], evidenceClass: 'user_stated',
  evidence: [{ sourceEventId: event.id, quote: event.text, paths: ['/claim', '/rationale', '/futureAction', '/applicability', '/exceptions', '/validity'] }],
  conflictKey: 'debugging_order', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
let directory: string
let store: CodingMemoryStore
let memory: MemoryPort
let now: number
beforeEach(() => {
  now = 10_000
  directory = mkdtempSync(join(tmpdir(), 'memory-learner-'))
  const result = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!result.ok) throw new Error(result.reason)
  store = result.store
  store.registerProject('project')
  store.setControls({ learn: true, recall: true })
  store.learning.capture({ streamId: 'stream', engine: 'codex', sessionId: 'session', projectId: 'project', episodeId: 'episode',
    from: null, to: '1', events: [event], boundary: 'complete' })
  memory = { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
    const owner = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
    return (owner as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(owner, args) as Result<K>
  } }
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

function inference(answer: string | null = JSON.stringify({ proposals: [proposal] })): MemoryInference {
  return { target: vi.fn(async () => ({ state: 'ready' as const, key: 'collection:selected-account:model:high' })),
    run: vi.fn(async () => answer) }
}
function pendingInference(): { provider: MemoryInference; entered: Promise<void>; resolve: (value: string) => void } {
  let enter!: () => void, resolve!: (value: string) => void
  const entered = new Promise<void>(done => { enter = done })
  const response = new Promise<string>(done => { resolve = done })
  const provider = inference()
  provider.run = vi.fn(async () => { enter(); return response })
  return { provider, entered, resolve }
}

function promptSources(prompt: string): Array<Omit<SourceEvent, 'text'> & { excerpts: Array<{ ref: string; text: string }> }> {
  return JSON.parse(prompt.split('Captured source events: ')[1])
}

function originalSources(prompt: string): SourceEvent[] {
  return promptSources(prompt).map(({ excerpts, ...metadata }) => ({ ...metadata, text: excerpts.map(part => part.text).join('') }))
}

it('keeps the model wait reason across retry delays and restart without extra probes or losing queued evidence', async () => {
  const provider = inference()
  provider.target = vi.fn(async () => ({ state: 'waiting' as const, reason: 'companion_stopped' as const }))
  const waiting = { state: 'waiting_for_model', reason: 'companion_stopped' }
  const learner = new MemoryLearner(memory, provider)
  expect(await learner.tick()).toEqual(waiting)
  expect(await learner.tick()).toEqual(waiting)
  expect(provider.target).toHaveBeenCalledOnce()
  expect(provider.run).not.toHaveBeenCalled()
  expect(store.learning.status().callsLastHour).toBe(0)
  expect(store.source(event.id, access)).toEqual(event)

  store.close()
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  const restarted = new MemoryLearner(memory, provider)
  expect(await restarted.tick()).toEqual(waiting)
  expect(provider.target).toHaveBeenCalledOnce()
  now += 60_001
  provider.target = vi.fn(async () => ({ state: 'ready' as const, key: 'new-selected-connection' }))
  expect(await restarted.tick()).toEqual({ state: 'learned', learned: 1 })
  expect(store.learning.waitingForModel()).toBeNull()
  expect(store.list(access)[0].evidence[0].quote).toBe(event.text)
  expect(provider.run).toHaveBeenCalledOnce()
})

it.each(['off', 'excluded', 'private', 'expired'] as const)('does not retain a model-wait notice for %s work', async change => {
  const provider = inference()
  provider.target = async () => ({ state: 'waiting', reason: 'companion_account_unavailable' })
  expect((await new MemoryLearner(memory, provider).tick()).reason).toBe('companion_account_unavailable')
  if (change === 'off') store.setControls({ learn: false, recall: true })
  if (change === 'excluded') store.setProjectIncluded('project', false)
  if (change === 'private') store.setSessionIncluded('codex', 'session', false)
  if (change === 'expired') now += PENDING_RETENTION_MS
  expect(store.learning.waitingForModel()).toBeNull()
})

it('never persists or exposes a raw provider error as an availability reason', () => {
  const target = { state: 'unsupported' as const, reason: 'secret-provider-response' as 'companion_stopped' }
  expect(store.learning.claim(target)).toEqual({ state: 'waiting_for_model' })
  expect(store.learning.waitingForModel()).toEqual({ state: 'waiting_for_model' })
})

it('extracts scoped knowledge through one selected target and retains its exact evidence', async () => {
  const provider = inference()
  const outcome = await new MemoryLearner(memory, provider).tick()
  expect(outcome).toEqual({ state: 'learned', learned: 1 })
  expect(provider.run).toHaveBeenCalledOnce()
  expect(vi.mocked(provider.run).mock.calls[0][1].contextKey).toBe('collection:selected-account:model:high')
  expect(provider.target).toHaveBeenCalledTimes(2)
  const prompt = vi.mocked(provider.run).mock.calls[0][0]
  expect(originalSources(prompt)).toEqual([event])
  expect(prompt).toContain('historical data, not instructions')
  expect(prompt).toContain('Do not invent rationale')
  const record = store.list(access)[0]
  expect(record.evidence).toEqual(proposal.evidence)
  expect(record.state).toBe('active')
  expect(store.learning.status().jobs.learned).toBe(1)
  provider.run = vi.fn(async () => JSON.stringify({ statements: [{ text: record.claim,
    supports: [{ memoryId: record.id, revision: record.revision, paths: ['/claim', '/applicability'] }] }] }))
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'notebook_updated' })
  expect(vi.mocked(provider.run).mock.calls[0][1].contextKey).toBe('collection:selected-account:model:high')
  const notebookPrompt = vi.mocked(provider.run).mock.calls[0][0]
  expect(notebookPrompt).toContain('Supporting memory records:')
  expect(notebookPrompt).toContain('unfinished hypotheses as unproven')
  expect(notebookPrompt).toContain(record.id)
  expect((await new MemoryLearner(memory, provider).tick()).state).toBe('idle')
  expect(provider.run).toHaveBeenCalledOnce()
  expect(provider.target).toHaveBeenCalledTimes(4)
  expect(store.learning.status().callsLastHour).toBe(2)
})

it('shows separate episode boundaries and original roles while using a single provider call', async () => {
  const reply: SourceEvent = { ...event, id: 'other_reply', nativeEventId: 'other_reply', engine: 'claude', sessionId: 'other_session',
    role: 'assistant', rootIds: ['other_reply'], text: 'An unrelated assistant statement, not user acceptance.' }
  store.learning.capture({ streamId: 'other_stream', engine: 'claude', sessionId: 'other_session', projectId: 'project',
    episodeId: 'other_episode', from: null, to: '1', events: [reply], boundary: 'complete' })
  const provider = inference()
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'learned', learned: 1 })
  expect(provider.run).toHaveBeenCalledOnce()
  const prompt = vi.mocked(provider.run).mock.calls[0][0]
  const boundaries = JSON.parse(prompt.split('Episode boundaries: ')[1].split('\n')[0])
  const sources = originalSources(prompt)
  expect(boundaries).toEqual([{ episodeId: 'episode', sourceIndexes: [0], context: 'complete' },
    { episodeId: 'other_episode', sourceIndexes: [1], context: 'complete' }])
  expect(sources).toEqual([event, reply])
  expect(prompt).toContain('Never treat a reply in one episode as acceptance of a statement in another')
  expect(store.learning.status().jobs).toEqual({ learned: 1, no_useful_memory: 1 })
})

it('resolves a selected excerpt to its original spacing, newlines and Unicode before admission', async () => {
  const exact = { ...event, id: 'exact', nativeEventId: 'exact', rootIds: ['exact'],
    text: 'For debugging  start with a small failing test because it makes review easier.\n\nPreserve " a  b " in strings. 🌱' }
  store.learning.capture({ streamId: 'stream', engine: 'codex', sessionId: 'session', projectId: 'project', episodeId: 'exact',
    from: '1', to: '2', events: [exact], boundary: 'bounded' })
  const provider = inference()
  provider.run = vi.fn(async prompt => {
    const source = promptSources(prompt).find(source => source.id === exact.id)!
    return JSON.stringify({ proposals: [{ ...proposal, evidence: [{ ref: source.excerpts[0].ref, paths: proposal.evidence[0].paths }] }] })
  })
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'learned', learned: 1 })
  expect(store.list(access)[0].evidence).toEqual([{ sourceEventId: exact.id, quote: exact.text, paths: proposal.evidence[0].paths }])
  expect(originalSources(vi.mocked(provider.run).mock.calls[0][0])).toEqual([event, exact])
})

it('does not relax exact-quote matching for legacy model answers', async () => {
  const answer = { ...proposal, evidence: [{ ...proposal.evidence[0], quote: event.text.replace('debugging ', 'debugging  ') }] }
  expect(await new MemoryLearner(memory, inference(JSON.stringify({ proposals: [answer] }))).tick())
    .toEqual({ state: 'failed', reason: 'evidence_mismatch' })
  expect(store.list(access)).toEqual([])
})

it('rejects an unknown reference atomically, retaining sources without saving earlier valid proposals', async () => {
  const answer = [proposal, { ...proposal, evidence: [{ ref: 's9p0', paths: proposal.evidence[0].paths }] }]
  expect(await new MemoryLearner(memory, inference(JSON.stringify({ proposals: answer }))).tick())
    .toEqual({ state: 'failed', reason: 'evidence_reference' })
  expect(store.list(access)).toEqual([])
  expect(store.source(event.id, access)?.text).toBe(event.text)
  expect(store.learning.status().jobs).toEqual({ failed: 1 })
})

it('still requires applicability evidence when a reference is used', async () => {
  const answer = { ...proposal, applicability: {}, evidence: [{ ref: 's0p0', paths: ['/claim', '/futureAction', '/rationale'] }] }
  expect(await new MemoryLearner(memory, inference(JSON.stringify({ proposals: [answer] }))).tick())
    .toEqual({ state: 'failed', reason: 'evidence_coverage' })
  expect(store.list(access)).toEqual([])
})

it.each(['assistant', 'tool'] as const)('does not promote a %s excerpt into a user preference', async role => {
  const source = { ...event, id: 'nonuser', nativeEventId: 'nonuser', rootIds: ['nonuser'], role }
  store.learning.capture({ streamId: 'stream', engine: 'codex', sessionId: 'session', projectId: 'project', episodeId: 'nonuser',
    from: '1', to: '2', events: [source], boundary: 'complete' })
  const provider = inference()
  provider.run = vi.fn(async prompt => {
    const ref = promptSources(prompt).find(source => source.id === 'nonuser')!.excerpts[0].ref
    return JSON.stringify({ proposals: [{ ...proposal, evidence: [{ ref, paths: proposal.evidence[0].paths }] }] })
  })
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'failed', reason: 'unsupported_assertion' })
  expect(store.list(access)).toEqual([])
})

it('labels bounded context for extraction and rejects unsupported outcomes from it', async () => {
  const partial = { ...event, id: 'partial', nativeEventId: 'partial', rootIds: ['partial'] }
  store.learning.capture({ streamId: 'stream', engine: 'codex', sessionId: 'session', projectId: 'project', episodeId: 'partial',
    from: '1', to: '2', events: [partial], boundary: 'bounded' })
  const draft = { ...proposal, assertionType: 'temporary_state',
    evidence: [{ ...proposal.evidence[0], sourceEventId: partial.id }] }
  const provider = inference(JSON.stringify({ proposals: [draft] }))
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'failed', reason: 'bounded_context_evidence' })
  const prompt = vi.mocked(provider.run).mock.calls[0][0]
  expect(prompt).toContain('"context":"bounded"')
  expect(prompt).toContain('A user request establishes requested behavior, not implemented behavior')
  expect(store.list(access)).toEqual([])
})

it('records a no-useful-memory result separately from unavailable intelligence', async () => {
  const provider = inference(null)
  const learner = new MemoryLearner(memory, provider)
  expect(await learner.tick()).toEqual({ state: 'waiting_for_model' })
  expect(store.learning.status().jobs.no_useful_memory).toBeUndefined()
  expect(store.learning.status().jobs.waiting_for_model).toBe(1)
  expect((await learner.tick()).state).toBe('waiting_for_model')
  expect(provider.target).toHaveBeenCalledOnce()
  now += 60_001
  provider.run = vi.fn(async () => '{"proposals":[]}')
  expect(await learner.tick()).toEqual({ state: 'no_useful_memory', learned: 0 })
  expect(store.learning.status().jobs.no_useful_memory).toBe(1)
})

it('keeps sources pending when startup rejects a changed native context', async () => {
  const provider = inference()
  provider.run = vi.fn(async () => { throw new MemoryError('inference_context_changed') })
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'waiting_for_model', reason: 'inference_context_changed' })
  expect(store.learning.status().jobs).toEqual({ waiting_for_model: 1 })
  expect(store.learning.status().callsLastHour).toBe(1)
  expect(store.source(event.id, access)?.text).toBe(event.text)
  expect(store.list(access)).toEqual([])
})

it.each(['not JSON', JSON.stringify({ proposals: [{ ...proposal, state: 'active' }] }),
  JSON.stringify({ proposals: [{ ...proposal, evidence: [{ ...proposal.evidence[0], quote: 'An invented statement.' }] }] })])
('does not save malformed or unsupported output: %s', async answer => {
  expect((await new MemoryLearner(memory, inference(answer)).tick()).state).toBe('failed')
  expect(store.list(access)).toEqual([])
  expect(store.source(event.id, access)).not.toBeNull()
  expect(store.learning.status().jobs.failed).toBe(1)
})

it('coalesces overlapping ticks and promptly cancels a provider that ignores abort', async () => {
  const { provider, entered, resolve } = pendingInference()
  const learner = new MemoryLearner(memory, provider)
  const first = learner.tick()
  expect(learner.tick()).toBe(first)
  await entered
  learner.cancel()
  expect(await first).toEqual({ state: 'waiting_for_model', reason: 'inference_cancelled' })
  expect(vi.mocked(provider.run).mock.calls[0][1].signal.aborted).toBe(true)
  resolve(JSON.stringify({ proposals: [proposal] }))
  await Promise.resolve()
  expect(store.list(access)).toEqual([])
  expect(store.learning.status().jobs.waiting_for_model).toBe(1)
})

it('requeues an interrupted review for the next quiet window without calling it unavailable or accepting late output', async () => {
  const { provider, entered, resolve } = pendingInference()
  const learner = new MemoryLearner(memory, provider)
  const running = learner.tick()
  await entered
  learner.cancel('foreground_activity')
  expect(await running).toEqual({ state: 'waiting_for_quiet', reason: 'inference_interrupted' })
  expect(store.learning.status().jobs).toEqual({ queued: 1 })
  expect(store.learning.status().callsLastHour).toBe(1)
  expect(store.learning.pendingReview()).toBe('ready')
  resolve(JSON.stringify({ proposals: [proposal] }))
  await Promise.resolve()
  expect(store.list(access)).toEqual([])
  const resumed = inference(JSON.stringify({ proposals: [proposal] }))
  expect(await new MemoryLearner(memory, resumed).tick()).toEqual({ state: 'learned', learned: 1 })
  expect(store.learning.status().callsLastHour).toBe(2)
})

it('does not invoke a provider when cancellation happened while acquiring the lease', async () => {
  const request = memory.request.bind(memory)
  const provider = inference()
  const learner = new MemoryLearner(memory, provider)
  memory.request = async (operation, args) => {
    const result = await request(operation, args)
    if (operation === 'claim') learner.cancel()
    return result
  }
  expect((await learner.tick()).reason).toBe('inference_cancelled')
  expect(provider.run).not.toHaveBeenCalled()
  expect(store.learning.status().jobs.waiting_for_model).toBe(1)
})

it('rejects a response if the selected account or model changes during inference', async () => {
  const { provider, entered, resolve } = pendingInference()
  const running = new MemoryLearner(memory, provider).tick()
  await entered
  provider.target = async () => ({ state: 'ready', key: 'different-account' })
  resolve(JSON.stringify({ proposals: [proposal] }))
  expect(await running).toEqual({ state: 'stale', reason: 'context_changed' })
  expect(store.list(access)).toEqual([])
  expect(store.learning.status().jobs.queued).toBe(1)
})

it('keeps quota failures queued without falling back to another model', async () => {
  const provider = inference()
  provider.run = vi.fn(async () => { throw new MemoryError('inference_usage_limit') })
  expect(await new MemoryLearner(memory, provider).tick()).toEqual({ state: 'budget_deferred', reason: 'inference_usage_limit' })
  expect(provider.run).toHaveBeenCalledOnce()
  expect(store.learning.status().jobs.budget_deferred).toBe(1)
})

it('bounds a hung inference call and keeps the source for a later retry', async () => {
  const { provider, entered, resolve } = pendingInference()
  const running = new MemoryLearner(memory, provider, 20).tick()
  await entered
  expect(await running).toEqual({ state: 'failed', reason: 'inference_timeout' })
  resolve('{"proposals":[]}')
  expect(store.source(event.id, access)).not.toBeNull()
  expect(store.learning.status().jobs.failed).toBe(1)
})

async function seedNotebook(): Promise<void> {
  expect((await new MemoryLearner(memory, inference()).tick()).state).toBe('learned')
}

it('keeps notebook model waits through backoff and restart without probing or changing memories', async () => {
  await seedNotebook()
  const records = store.list(access)
  const provider = inference('{"statements":[]}')
  provider.target = vi.fn(async () => ({ state: 'waiting' as const, reason: 'companion_stopped' as const }))
  const waiting = { state: 'waiting_for_model', reason: 'companion_stopped' }
  const learner = new MemoryLearner(memory, provider)
  expect(await learner.tick()).toEqual(waiting)
  expect(await learner.tick()).toEqual(waiting)
  expect(provider.target).toHaveBeenCalledOnce()
  expect(provider.run).not.toHaveBeenCalled()

  store.close()
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  const restarted = new MemoryLearner(memory, provider)
  expect(await restarted.tick()).toEqual(waiting)
  expect(provider.target).toHaveBeenCalledOnce()
  expect(store.learning.status().callsLastHour).toBe(1)
  expect(store.list(access)).toEqual(records)
  now += 60_001
  provider.target = vi.fn(async () => ({ state: 'ready' as const, key: 'resumed-companion' }))
  expect(await restarted.tick()).toEqual({ state: 'notebook_empty' })
  expect(await restarted.tick()).toEqual({ state: 'idle' })
  expect(provider.run).toHaveBeenCalledOnce()
  expect(store.learning.status().callsLastHour).toBe(2)
})

it.each([false, true])('persists lease-time model and framework waits (notebook: %s)', async notebook => {
  if (notebook) await seedNotebook()
  const provider = inference()
  provider.run = vi.fn(async () => { throw new MemoryError('opencode_version_uncertified') })
  const waiting = { state: 'waiting_for_model', reason: 'opencode_version_uncertified' }
  expect(await new MemoryLearner(memory, provider).tick()).toEqual(waiting)
  vi.mocked(provider.target).mockClear()
  expect(await new MemoryLearner(memory, provider).tick()).toEqual(waiting)
  expect(provider.target).not.toHaveBeenCalled()
  expect(provider.run).toHaveBeenCalledOnce()
})

it('retains a refused notebook reason in a new learner without a provider probe', async () => {
  await seedNotebook()
  const provider = inference()
  provider.run = vi.fn(async () => { throw new MemoryError('inference_provider_restricted') })
  const waiting = { state: 'waiting_for_model', reason: 'inference_provider_restricted' }
  expect(await new MemoryLearner(memory, provider).tick()).toEqual(waiting)
  vi.mocked(provider.target).mockClear()
  expect(await new MemoryLearner(memory, provider).tick()).toEqual(waiting)
  expect(provider.target).not.toHaveBeenCalled()
  expect(provider.run).toHaveBeenCalledOnce()
})

it('cancels notebook work promptly and does not publish a late answer after foreground activity', async () => {
  await seedNotebook()
  const { provider, entered, resolve } = pendingInference()
  const learner = new MemoryLearner(memory, provider)
  const running = learner.tick()
  expect(learner.tick()).toBe(running)
  await entered
  learner.cancel('foreground_activity')
  expect(await running).toEqual({ state: 'waiting_for_quiet', reason: 'inference_interrupted' })
  resolve('{"statements":[]}')
  await Promise.resolve()
  expect(store.notebookPending().state).toBe('ready')
  expect(await new MemoryLearner(memory, inference('{"statements":[]}')).tick()).toEqual({ state: 'notebook_empty' })
  expect(store.learning.status().callsLastHour).toBe(3)
})

it.each(['model', 'privacy', 'learn_off'] as const)('rejects notebook output when %s changes during synthesis', async change => {
  await seedNotebook()
  const { provider, entered, resolve } = pendingInference()
  const running = new MemoryLearner(memory, provider).tick()
  await entered
  if (change === 'model') provider.target = async () => ({ state: 'ready', key: 'another-account' })
  if (change === 'privacy') store.setSessionIncluded('codex', 'session', false)
  if (change === 'learn_off') store.setControls({ learn: false, recall: true })
  resolve('{"statements":[]}')
  expect(await running).toEqual({ state: 'stale' })
})

it('keeps notebook quota failures pending and does not probe the selected account again during backoff', async () => {
  await seedNotebook()
  const provider = inference()
  provider.run = vi.fn(async () => { throw new MemoryError('inference_usage_limit') })
  const learner = new MemoryLearner(memory, provider)
  expect(await learner.tick()).toEqual({ state: 'budget_deferred', reason: 'inference_usage_limit' })
  expect(await learner.tick()).toEqual({ state: 'budget_deferred' })
  store.close()
  const reopened = CodingMemoryStore.open({ directory, profileId: 'owner', now: () => now })
  if (!reopened.ok) throw new Error(reopened.reason)
  store = reopened.store
  const restarted = new MemoryLearner(memory, provider)
  expect(await restarted.tick()).toEqual({ state: 'budget_deferred' })
  expect(provider.target).toHaveBeenCalledOnce()
  expect(provider.run).toHaveBeenCalledOnce()
  now += 3_600_001
  provider.run = vi.fn(async () => '{"statements":[]}')
  expect(await restarted.tick()).toEqual({ state: 'notebook_empty' })
  expect(provider.run).toHaveBeenCalledOnce()
})

it('keeps a refused notebook pending, respects pause, and resumes with a usable connection', async () => {
  await seedNotebook()
  const provider = inference('{"statements":[]}')
  provider.run = vi.fn(async () => { throw new MemoryError('inference_provider_restricted') })
  const learner = new MemoryLearner(memory, provider)
  const refused = { state: 'waiting_for_model', reason: 'inference_provider_restricted' }
  expect(await learner.tick()).toEqual(refused)
  provider.target = vi.fn<MemoryInference['target']>(async () => ({ state: 'unsupported', reason: 'inference_provider_restricted' }))
  expect(await learner.tick()).toEqual(refused)
  now += 60_001
  expect(await learner.tick()).toEqual(refused)
  expect(provider.run).toHaveBeenCalledOnce()
  expect(store.list(access)).toHaveLength(1)
  store.setControls({ learn: false, recall: true })
  vi.mocked(provider.target).mockClear()
  expect(await learner.tick()).toEqual({ state: 'learning_off' })
  expect(provider.target).not.toHaveBeenCalled()
  store.setControls({ learn: true, recall: true })
  provider.target = vi.fn<MemoryInference['target']>(async () => ({ state: 'ready', key: 'new-connection' }))
  provider.run = vi.fn(async () => '{"statements":[]}')
  expect(await learner.tick()).toEqual({ state: 'notebook_empty' })
  expect(provider.run).toHaveBeenCalledOnce()
})

it.each([null, 'not JSON', '{"statements":[],"decisions":[]}'])('distinguishes unavailable and malformed notebook output from empty synthesis: %s', async answer => {
  await seedNotebook()
  expect((await new MemoryLearner(memory, inference(answer)).tick()).state).toBe(answer === null ? 'waiting_for_model' : 'failed')
  now += 60_001
  expect(store.notebookPending().state).toBe('ready')
  expect(store.list(access)).toHaveLength(1)
})
