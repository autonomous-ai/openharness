import { mkdtempSync, rmSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { CodingMemoryRuntime, type MemoryHostContext, type MemoryHostSession } from './runtime.js'
import { CodingMemoryStore } from './store.js'
import { QUEUE_OPERATIONS, type Arguments, type MemoryPort, type Operation, type Result } from './operations.js'
import type { ProjectContext } from './project.js'
import type { MemoryInference } from './learner.js'
import type { InferenceTarget } from './queue.js'
import type { MemoryDraft, SourceEvent } from './types.js'

let directory: string, runtime: CodingMemoryRuntime, now: number, context: MemoryHostContext
let sessions: MemoryHostSession[], inference: MemoryInference, target: InferenceTarget
let locate: Mock<(workspace: string) => Promise<ProjectContext>>
let create: Mock<(profileId: string) => MemoryPort & { close(): Promise<void> }>
let intercept: ((operation: Operation, value: unknown) => Promise<void>) | undefined
const stores = new Map<string, CodingMemoryStore>()
const opened: CodingMemoryStore[] = []
function open(profileId: string): CodingMemoryStore {
  const result = CodingMemoryStore.open({ directory: join(directory, profileId), profileId, now: () => now })
  if (!result.ok) throw new Error(result.reason)
  opened.push(result.store)
  return result.store
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const preference = 'I prefer small coding changes.'
function lines(text = preference, id = 'first'): string {
  return JSON.stringify({ type: 'user', uuid: id, timestamp: new Date(now + 1).toISOString(), message: { content: text } }) + '\n'
    + JSON.stringify({ type: 'assistant', uuid: `${id}_reply`, timestamp: new Date(now + 2).toISOString(),
      message: { content: [{ type: 'text', text: 'Understood.' }], stop_reason: 'end_turn' } }) + '\n'
}
function proposal(source: SourceEvent): MemoryDraft {
  return { kind: 'working_preference', facet: 'changes', assertionType: 'stated_preference',
    scope: { profileId: source.profileId, ...(source.projectId ? { projectId: source.projectId } : {}) }, claim: preference, rationale: null,
    futureAction: 'Keep coding changes small.', applicability: {}, exceptions: [], retrievalCues: ['coding', 'changes'],
    evidenceClass: 'user_stated', evidence: [{ sourceEventId: source.id, quote: preference, paths: ['/claim', '/futureAction', '/applicability'] }],
    conflictKey: 'change_size', validity: { validFrom: null, validUntil: null, recheckWhen: [] } }
}
async function learn(): Promise<void> {
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines())
  now += 20_000
  await runtime.tick()
  await vi.waitFor(() => expect(runtime.status().learning?.state).toBe('learned'), { interval: 5 })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-runtime-'))
  now = 1_000
  context = { experimental: true, watching: true, profileId: 'owner_a' }
  sessions = [{ agentId: 'agent', engine: 'claude', cliVersion: '2.1.286', sessionId: 'native', workspace: '/authorized/project',
    transcriptPath: join(directory, 'conversation.jsonl'), busy: false, coding: true }]
  target = { state: 'ready', key: 'selected' }
  inference = { target: vi.fn(async () => target), run: vi.fn(async prompt => {
    const sources = JSON.parse(prompt.split('Captured source events: ')[1]) as SourceEvent[]
    return JSON.stringify({ proposals: [proposal(sources.find(source => source.role === 'user')!)] })
  }) }
  locate = vi.fn(async workspace => ({ locator: { kind: 'directory' as const, path: workspace }, workspacePath: workspace, branchRef: null, revision: null }))
  create = vi.fn((profileId: string) => {
    const store = open(profileId)
    stores.set(profileId, store)
    return { async request<K extends Operation>(operation: K, args: Arguments<K>): Promise<Result<K>> {
      const receiver = (QUEUE_OPERATIONS as readonly string[]).includes(operation) ? store.learning : store
      const value = (receiver as unknown as Record<string, (...args: unknown[]) => unknown>)[operation].apply(receiver, args) as Result<K>
      await intercept?.(operation, value)
      return value
    }, async close() { store.close() } }
  })
  runtime = new CodingMemoryRuntime({ directory, context: () => context, sessions: () => sessions, inference, locate, create, now: () => now })
})
afterEach(async () => {
  intercept = undefined
  await runtime.close()
  for (const store of opened.splice(0)) store.close()
  stores.clear()
  rmSync(directory, { recursive: true, force: true })
})

it('opens no store and invokes no model while experimental, watching consent or identity is absent', async () => {
  context.experimental = false
  await runtime.tick()
  expect(runtime.status().state).toBe('off')
  context.experimental = true; context.watching = false
  await runtime.tick()
  expect(runtime.status().state).toBe('off')
  context.watching = true; context.profileId = null
  await runtime.tick()
  expect(runtime.status().state).toBe('waiting_for_identity')
  expect(create).not.toHaveBeenCalled()
  expect(inference.run).not.toHaveBeenCalled()
})

it('changes memory consent without requiring or starting a companion conversation', async () => {
  sessions = []
  await runtime.tick()
  await runtime.configure({ learn: true, recall: false })
  expect(runtime.status().preferences).toMatchObject({ learn: true, recall: false })
  expect(inference.target).not.toHaveBeenCalled()
  expect(inference.run).not.toHaveBeenCalled()
  await runtime.configure({ learn: false, recall: true })
  expect(runtime.status().preferences).toMatchObject({ learn: false, recall: true })
  context.watching = false
  expect(runtime.status().state).toBe('off')
  await runtime.pause()
  expect(inference.run).not.toHaveBeenCalled()
})

it.each(['replace', 'mutate'] as const)('binds activity to open host sessions and rejects a native-session %s during the read', async mode => {
  await learn()
  sessions[0].name = 'Parser fixes'
  const prepared = await runtime.preparePromptRecall('agent', { query: 'coding' })
  expect(prepared.receipt).not.toBeNull()
  const calls = vi.mocked(inference.run).mock.calls.length
  expect(await runtime.libraryActivity('owner_a')).toMatchObject({
    sessions: [{ agentId: 'agent', name: 'Parser fixes' }], items: [{ record: { claim: preference } }] })
  expect(vi.mocked(inference.run).mock.calls.length).toBe(calls)
  sessions[0].present = false
  expect((await runtime.libraryActivity('owner_a')).sessions).toEqual([])
  await expect(runtime.libraryActivity('owner_a', { agentId: 'agent' })).rejects.toThrow('session_unavailable')
  sessions[0].present = true
  intercept = async operation => {
    if (operation !== 'libraryActivity') return
    if (mode === 'replace') sessions[0] = { ...sessions[0], sessionId: 'replacement' }
    else sessions[0].sessionId = 'replacement'
  }
  await expect(runtime.libraryActivity('owner_a')).rejects.toThrow('session_changed')
  intercept = undefined
  expect((await runtime.libraryActivity('owner_a')).items).toEqual([])
})

it('lets the explicit owner inspect and change saved preferences with watching off without starting capture', async () => {
  context.watching = false
  expect(runtime.ownerKey()).toBe('owner_a')
  expect((await runtime.libraryPage('owner_a')).items).toEqual([])
  expect((await runtime.libraryNotebooks('owner_a')).items).toEqual([])
  expect(await runtime.libraryNotebook('owner_a', 'missing')).toBeNull()
  const preview = await runtime.libraryPreview('owner_a', { kind: 'configure', preferences: { learn: false, recall: true }, expected: { learn: true, recall: true } })
  expect(await runtime.libraryApply('owner_a', preview)).toMatchObject({ preferences: { learn: false, recall: true } })
  const status = await runtime.libraryStatus('owner_a')
  expect(status.runtime.state).toBe('off')
  expect(status.preferences).toEqual({ learn: false, recall: true })
  expect(locate).not.toHaveBeenCalled()
  expect(inference.run).not.toHaveBeenCalled()
  const check = open('owner_a')
  expect(check.controls()).toMatchObject({ learn: false, recall: false })
  expect(check.learning.status().capturedStreams).toBe(0)
})

it.each(['libraryPage', 'libraryNotebooks', 'libraryNotebook'])('drops an owner %s read when the account changes during the worker request', async action => {
  await learn()
  intercept = async operation => { if (operation === action) context.profileId = 'replacement' }
  const read = () => action === 'libraryNotebook' ? runtime.libraryNotebook('owner_a', 'missing')
    : action === 'libraryNotebooks' ? runtime.libraryNotebooks('owner_a') : runtime.libraryPage('owner_a')
  await expect(read()).rejects.toThrow('owner_changed')
  expect(create).toHaveBeenCalledTimes(1)
  await expect(read()).rejects.toThrow('owner_changed')
})

it('shares one inspection worker while watching is off and bounds concurrent owner requests', async () => {
  context.watching = false
  const hold = deferred<void>()
  intercept = async operation => { if (operation === 'libraryPage') await hold.promise }
  const requests = Array.from({ length: 8 }, () => runtime.libraryPage('owner_a'))
  expect(create).toHaveBeenCalledTimes(1)
  await expect(runtime.libraryPage('owner_a')).rejects.toThrow('memory_busy')
  hold.resolve()
  expect((await Promise.all(requests)).every(page => page.items.length === 0)).toBe(true)
  expect(inference.run).not.toHaveBeenCalled()
})

it('reuses the selected collection across engines for scoped MCP recall, with a receipt and strict arguments', async () => {
  sessions[0].scope = 'profile'
  await learn()
  const reply = await runtime.recallCollection('agent', { query: 'coding changes' })
  expect(reply).toMatchObject({ ok: true, status: 'ok', context: expect.stringContaining(preference), receipt: { delivery: 'unverified' } })
  sessions[0] = { ...sessions[0], engine: 'codex', cliVersion: '0.159.0', sessionId: 'codex_collection' }
  expect(await runtime.recallCollection('agent', { query: 'coding changes' })).toMatchObject({ status: 'ok', context: expect.stringContaining(preference) })
  sessions[0] = { ...sessions[0], engine: 'opencode', cliVersion: '1.18.34', sessionId: 'opencode_collection' }
  expect(await runtime.recallCollection('agent', { query: 'coding changes' })).toMatchObject({ status: 'ok', context: expect.stringContaining(preference) })
  expect((await runtime.libraryActivity('owner_a')).sessions).toMatchObject([{ engine: 'opencode', name: 'OpenCode session' }])
  await expect(runtime.recallCollection('agent', { query: 'coding', profileId: 'foreign' })).rejects.toThrow('invalid_input')
  await expect(runtime.recallCollection('agent', { query: 'coding', projectId: 'foreign' })).rejects.toThrow('invalid_input')
  sessions[0].scope = 'project'
  await expect(runtime.recallCollection('agent', { query: 'coding' })).rejects.toThrow('scope_denied')
})

it('captures from the first eligible turn while waiting for the selected model, then learns and recalls across engines', async () => {
  target = { state: 'waiting' }
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines())
  now += 20_000
  await runtime.tick()
  await vi.waitFor(() => expect(runtime.status().learning?.state).toBe('waiting_for_model'), { interval: 5 })
  expect(stores.get('owner_a')!.learning.status().jobs.waiting_for_model).toBe(1)
  expect(inference.run).not.toHaveBeenCalled()
  target = { state: 'ready', key: 'selected' }
  now += 60_000
  await runtime.tick()
  await vi.waitFor(() => expect(runtime.status().learning?.state).toBe('learned'), { interval: 5 })
  sessions.push({ ...sessions[0], agentId: 'codex', engine: 'codex', sessionId: 'codex_native', transcriptPath: join(directory, 'codex.jsonl') })
  expect((await runtime.recall('codex', { query: 'coding changes' })).items[0].claim).toBe(preference)
  expect((await runtime.recall('unregistered_agent', { query: 'coding changes' })).status).toBe('denied')
})

it('never captures an unclassified general-domain DSH and does not resolve its workspace', async () => {
  sessions[0].coding = false
  await writeFile(sessions[0].transcriptPath, lines('Unrelated personal context.'))
  now += 20_000
  await runtime.tick()
  expect(stores.get('owner_a')!.learning.status().capturedStreams).toBe(0)
  expect(locate).not.toHaveBeenCalled()
  expect((await runtime.recall('agent', { query: 'coding' })).status).toBe('denied')
})

it.each(['2.1.286', '2.1.287'])('prepares a Claude %s host-bound prompt receipt and rejects a native-session replacement acknowledging it', async cliVersion => {
  sessions[0].cliVersion = cliVersion
  await learn()
  const prepared = await runtime.preparePromptRecall('agent', { query: 'coding changes' })
  expect(prepared.packet.items).toHaveLength(1)
  expect(JSON.parse(prepared.packet.text)).toMatchObject({ type: 'coding_memory_sources', version: 1,
    sources: [{ role: 'user', engine: 'claude', excerpts: [{ text: preference }] }] })
  expect(JSON.parse(prepared.packet.text).items[0]).not.toHaveProperty('futureAction')
  expect(prepared.receipt?.delivery).toBe('unverified')
  expect((await runtime.promptRecallReceipts('agent'))[0].emittedAt).toBeNull()
  expect(await runtime.promptRecallEmitted('agent', prepared.receipt!.id)).toBe(true)
  expect((await runtime.promptRecallReceipts('agent'))[0].emittedAt).toBe(now)
  sessions[0] = { ...sessions[0], sessionId: 'replacement' }
  expect(await runtime.promptRecallEmitted('agent', prepared.receipt!.id)).toBe(false)
  expect(await runtime.promptRecallReceipts('agent')).toEqual([])
})

it.each(['claude', 'codex', 'opencode'] as const)('keeps %s prompt delivery unavailable on an unverified release while preserving explicit scoped recall', async engine => {
  await learn()
  sessions[0] = { ...sessions[0], engine, cliVersion: '2.99.0' }
  expect((await runtime.preparePromptRecall('agent', { query: 'coding changes' })).packet.status).toBe('unavailable')
  expect(await runtime.promptRecallReceipts('agent')).toEqual([])
  expect((await runtime.recall('agent', { query: 'coding changes' })).items).toHaveLength(1)
})

it.each(['0.159.0', '0.159.3', '0.160.0'])('prepares Codex prompt memory for tested native release %s', async cliVersion => {
  await learn()
  sessions[0] = { ...sessions[0], engine: 'codex', cliVersion }
  const prepared = await runtime.preparePromptRecall('agent', { query: 'coding changes' })
  expect(prepared.packet.items).toHaveLength(1)
  expect(prepared.receipt?.delivery).toBe('unverified')
  expect(await runtime.promptRecallEmitted('agent', prepared.receipt!.id)).toBe(true)
  sessions[0].cliVersion = undefined
  expect((await runtime.preparePromptRecall('agent', { query: 'coding changes' })).packet.status).toBe('unavailable')
})

it.each([{ engine: 'codex', cliVersion: '0.160.0' }, { engine: 'opencode', cliVersion: '1.18.34' }] as const)(
  'recalls a Claude lesson through a verified $engine adapter without changing ownership or requiring learning', async adapter => {
  await learn()
  sessions[0] = { ...sessions[0], engine: adapter.engine, sessionId: `${adapter.engine}_native`, cliVersion: null }
  await runtime.configure({ learn: false, recall: true })
  expect((await runtime.preparePromptRecall('agent', { query: 'coding changes' })).packet.status).toBe('unavailable')
  const prepared = await runtime.preparePromptRecall('agent', { query: 'coding changes' }, adapter)
  expect(prepared.packet.items[0]).toMatchObject({ claim: preference, sources: [{ engine: 'claude' }] })
  expect(prepared.receipt?.delivery).toBe('unverified')
  expect(await runtime.promptRecallEmitted('agent', prepared.receipt!.id)).toBe(true)
  expect((await runtime.preparePromptRecall('agent', { query: 'coding' }, { engine: 'claude', cliVersion: '2.1.287' })).packet.status).toBe('unavailable')
  await runtime.configure({ learn: false, recall: false })
  expect((await runtime.preparePromptRecall('agent', { query: 'coding' }, adapter)).packet.status).toBe('off')
  expect(sessions[0].cliVersion).toBeNull()
})

it('shares a correction and deletion across Codex and OpenCode without copying the memory', async () => {
  await learn()
  const first = (await runtime.recall('agent', { query: 'coding changes' })).items[0]
  const store = stores.get('owner_a')!, access = { profileId: 'owner_a', projectIds: [first.scope.projectId!], includeProfile: true }
  const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated,
    evidence: _evidence, evidenceClass: _class, ...draft } = store.read(first.id, access)!
  const corrected = store.correctFromUser(first.id, first.revision,
    { ...draft, claim: 'Group related coding changes together.', futureAction: 'Group related coding changes together.' }, access)
  for (const [engine, cliVersion] of [['claude', '2.1.287'], ['codex', '0.160.0'], ['opencode', '1.18.34']] as const) {
    sessions[0] = { ...sessions[0], engine, cliVersion, sessionId: `${engine}_native` }
    const prepared = await runtime.preparePromptRecall('agent', { query: 'coding changes' })
    expect(prepared.packet.items).toHaveLength(1)
    expect(prepared.packet.items[0]).toMatchObject({ id: first.id, revision: corrected.revision, claim: corrected.claim })
    expect(JSON.parse(prepared.packet.text)).toMatchObject({ type: 'coding_memory_sources', version: 1,
      sources: [{ engine: 'harness_viewer', role: 'user' }] })
    expect(prepared.packet.text).toContain(corrected.claim)
    expect(prepared.packet.text).not.toContain(preference)
  }
  expect(store.list(access)).toHaveLength(1)
  store.forget(first.id, corrected.revision, access)
  for (const [engine, cliVersion] of [['claude', '2.1.287'], ['codex', '0.160.0'], ['opencode', '1.18.34']] as const) {
    sessions[0] = { ...sessions[0], engine, cliVersion, sessionId: `${engine}_native` }
    expect((await runtime.preparePromptRecall('agent', { query: 'coding changes' })).packet.items).toEqual([])
  }
})

it('withholds prepared context when privacy changes before the hook response', async () => {
  await learn()
  intercept = async operation => { if (operation === 'prepareRecall') stores.get('owner_a')!.setSessionIncluded('claude', 'native', false) }
  const result = await runtime.preparePromptRecall('agent', { query: 'coding changes' })
  expect(result.packet.status).toBe('denied')
  expect(result.receipt).toBeNull()
  expect(await runtime.promptRecallReceipts('agent')).toEqual([])
})

it.each(['forgotten', 'corrected'] as const)('withholds a prepared packet when its memory is %s before the response', async change => {
  await learn()
  intercept = async (operation, value) => {
    if (operation !== 'prepareRecall') return
    const item = (value as import('./receipts.js').PreparedRecall).packet.items[0]
    const access = { profileId: 'owner_a', projectIds: [item.scope.projectId!], includeProfile: true }
    const store = stores.get('owner_a')!
    if (change === 'forgotten') store.forget(item.id, item.revision, access)
    else {
      const { schemaVersion: _schema, id: _id, revision: _revision, state: _state, createdAt: _created, updatedAt: _updated,
        evidence: _evidence, evidenceClass: _class, ...draft } = store.read(item.id, access)!
      store.correctFromUser(item.id, item.revision, { ...draft, claim: 'Group related coding changes together.' }, access)
    }
  }
  // October 6 full CI hit the separate recall deadline during SQLite writes. Hold that clock
  // here so this test reaches the policy recheck after the memory changes.
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  try {
    const result = await runtime.preparePromptRecall('agent', { query: 'coding changes' })
    expect(result.packet.status).toBe('denied')
    expect(result.receipt).toBeNull()
  } finally { clock.mockRestore() }
})

it('learns explicit personal coding preferences in the collection conversation and recalls them in other projects', async () => {
  sessions[0].scope = 'profile'
  await learn()
  expect(locate).not.toHaveBeenCalled()
  const store = stores.get('owner_a')!
  expect(store.list({ profileId: 'owner_a', projectIds: [], includeProfile: true })[0].scope).toEqual({ profileId: 'owner_a' })
  sessions.push(...['one', 'two'].map(name => ({ ...sessions[0], agentId: name, scope: 'project' as const,
    workspace: `/projects/${name}`, sessionId: name, transcriptPath: join(directory, `${name}.jsonl`) })))
  await runtime.tick()
  for (const agentId of ['one', 'two']) expect((await runtime.recall(agentId, { query: 'coding changes' })).items[0].claim).toBe(preference)
  await expect(runtime.setProjectIncluded('agent', false)).rejects.toThrow('project_unavailable')
})

it('keeps personal and project identity caches separate even if two agents use the same folder', async () => {
  sessions[0].scope = 'profile'
  await runtime.tick()
  sessions.push({ ...sessions[0], agentId: 'ordinary', scope: 'project', sessionId: 'ordinary', transcriptPath: join(directory, 'ordinary.jsonl') })
  await runtime.tick()
  await runtime.setProjectIncluded('ordinary', false)
  expect((await runtime.recall('ordinary', { query: 'changes' })).status).toBe('denied')
  expect((await runtime.recall('agent', { query: 'changes' })).status).toBe('ok')
})

it('learns a completed turn while other project work continues, leaving the unfinished turn open', async () => {
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines() + JSON.stringify({ type: 'user', uuid: 'next',
    timestamp: new Date(now + 3).toISOString(), message: { content: 'Continue the implementation.' } }) + '\n')
  sessions[0].busy = true
  now += 20_000
  await runtime.tick()
  await vi.waitFor(() => expect(runtime.status().learning?.state).toBe('learned'), { interval: 5 })
  expect(inference.run).toHaveBeenCalledOnce()
  const store = stores.get('owner_a')!
  expect(store.learning.status().jobs).toEqual({ learned: 1, open: 1 })
  expect(store.learning.status().callsLastHour).toBe(1)
})

it('waits for its companion to be free and cancels background inference when a new user turn starts', async () => {
  sessions[0].scope = 'profile'
  const running = deferred<string>()
  inference.run = vi.fn(() => running.promise)
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines())
  sessions[0].busy = true
  now += 20_000
  await runtime.tick()
  expect(inference.run).not.toHaveBeenCalled()
  expect(runtime.status().learning?.state).toBe('foreground_busy')
  sessions[0].busy = false
  now += 14_999
  await runtime.tick()
  expect(inference.run).not.toHaveBeenCalled()
  expect(runtime.status().learning?.state).toBe('waiting_for_quiet')
  now++
  await runtime.tick()
  await vi.waitFor(() => expect(inference.run).toHaveBeenCalledTimes(1), { interval: 5 })
  const signal = vi.mocked(inference.run).mock.calls[0][1].signal
  runtime.activity()
  expect(signal.aborted).toBe(true)
  running.resolve(JSON.stringify({ proposals: [] }))
  await vi.waitFor(() => expect(runtime.status().learning?.reason).toBe('inference_interrupted'), { interval: 5 })
  expect(stores.get('owner_a')!.learning.status().jobs).toEqual({ queued: 1 })
  expect(stores.get('owner_a')!.learning.pendingReview()).toBe('ready')
})

it('preserves separate learning/recall preferences through off/on and account switches', async () => {
  await runtime.tick()
  await runtime.configure({ learn: false, recall: true })
  context.experimental = false
  await runtime.tick()
  expect(runtime.status().state).toBe('off')
  context.experimental = true
  await runtime.tick()
  expect(runtime.status().preferences).toEqual({ learn: false, recall: true })
  expect(stores.get('owner_a')!.controls()).toMatchObject({ learn: false, recall: true })
  context.profileId = 'owner_b'
  await runtime.tick()
  expect(runtime.status().preferences).toEqual({ learn: true, recall: true })
  context.profileId = 'owner_a'
  await runtime.tick()
  expect(runtime.status().preferences).toEqual({ learn: false, recall: true })
})

it('starts a fresh capture boundary after an account change instead of copying another owner’s history', async () => {
  target = { state: 'waiting' }
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines('Owner A work.', 'a'))
  await runtime.tick()
  now += 1_000
  context.profileId = 'owner_b'
  await runtime.tick()
  expect(stores.get('owner_b')!.learning.status().jobs).toEqual({})
  await appendFile(sessions[0].transcriptPath, lines('Owner B work.', 'b'))
  await runtime.tick()
  const b = stores.get('owner_b')!.learning.claim({ state: 'ready', key: 'selected' })
  expect(b.state === 'claimed' ? b.lease.sources.map(source => source.text) : b.state).toEqual(['Owner B work.', 'Understood.'])
  now += 1_000
  context.profileId = 'owner_a'
  await runtime.tick()
  expect(stores.get('owner_a')!.learning.status().jobs).toEqual({ queued: 1 })
})

it('rejects a late extraction after ownership changes, even when the provider ignores cancellation', async () => {
  const running = deferred<string>()
  inference.run = vi.fn(() => running.promise)
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines())
  now += 20_000
  await runtime.tick()
  await vi.waitFor(() => expect(inference.run).toHaveBeenCalledOnce(), { interval: 5 })
  context.profileId = 'owner_b'
  await runtime.tick()
  running.resolve(JSON.stringify({ proposals: [] }))
  const previous = open('owner_a')
  expect(previous.controls()).toMatchObject({ learn: false, recall: false })
  expect(previous.learning.status().jobs.no_useful_memory).toBeUndefined()
  expect(stores.get('owner_b')!.learning.status().jobs.no_useful_memory).toBeUndefined()
})

it.each(['owner', 'watching', 'experimental'] as const)('rechecks %s authorization before launch without waiting for another host tick', async change => {
  const entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>()
  const launch = vi.fn()
  inference.run = vi.fn(async (_prompt, options) => {
    entered.resolve()
    await release.promise // Native startup can yield while the host account or consent changes.
    try {
      options.assertAuthorized?.()
      launch()
      return '{"proposals":[]}'
    } finally { finished.resolve() }
  })
  await runtime.tick()
  await writeFile(sessions[0].transcriptPath, lines())
  now += 20_000
  await runtime.tick()
  await entered.promise
  if (change === 'owner') context.profileId = 'owner_b'
  else context[change] = false
  release.resolve()
  await finished.promise
  expect(launch).not.toHaveBeenCalled()
  await runtime.tick()
  const previous = open('owner_a')
  expect(previous.controls()).toMatchObject({ learn: false, recall: false })
  expect(previous.learning.status().jobs.no_useful_memory).toBeUndefined()
})

it('withholds recall if the session becomes private while the packet is being read', async () => {
  await learn()
  const delivered = deferred<void>(), release = deferred<void>()
  intercept = async operation => { if (operation === 'recall') { delivered.resolve(); await release.promise } }
  const recall = runtime.recall('agent', { query: 'coding changes' })
  await delivered.promise
  await runtime.setSessionIncluded('agent', false)
  release.resolve()
  expect((await recall).status).toBe('denied')
  intercept = undefined
  expect((await runtime.recall('agent', { query: 'coding changes' })).items).toEqual([])
})

it('withholds a completed packet if the native session rotates before delivery', async () => {
  await learn()
  intercept = async operation => { if (operation === 'recall') sessions = [{ ...sessions[0], sessionId: 'rotated' }] }
  expect((await runtime.recall('agent', { query: 'coding changes' })).status).toBe('denied')
})

it('closes cleanly if consent changes while the store is still initializing', async () => {
  const waiting = deferred<void>(), release = deferred<void>()
  intercept = async operation => { if (operation === 'preferences') { waiting.resolve(); await release.promise } }
  const tick = runtime.tick()
  await waiting.promise
  context.watching = false
  const closing = runtime.close()
  release.resolve()
  await Promise.all([tick, closing])
  expect(runtime.status().state).toBe('off')
  expect(open('owner_a').controls()).toMatchObject({ learn: false, recall: false })
})

it('stops its host timer when paused and resumes with the saved user preferences', async () => {
  const timer = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  try {
    runtime.start()
    await runtime.tick()
    await runtime.configure({ learn: false, recall: true })
    const handle = timer.mock.results[0].value as ReturnType<typeof setInterval>
    await runtime.pause()
    expect(clear).toHaveBeenCalledWith(handle)
    expect(open('owner_a').controls()).toMatchObject({ learn: false, recall: false })
    runtime.start()
    await runtime.tick()
    expect(runtime.status().preferences).toEqual({ learn: false, recall: true })
  } finally { timer.mockRestore(); clear.mockRestore() }
})
