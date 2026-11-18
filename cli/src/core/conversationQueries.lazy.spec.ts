/** The existing caller facade owns one deferred handoff composition, never an empty-read fallback. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { HandoffWiring } from '../lib/handoffDiscovery.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import type { ConversationReads } from './api.js'

const loading = vi.hoisted(() => ({ evaluated: vi.fn(), create: vi.fn(), gate: undefined as Promise<void> | undefined }))

const row = { agentId: 'selected', sessionId: 'conversation', engine: 'codex' } as RegisteredSession
const wiring = {} as HandoffWiring
const directory = '/private-fixture/handoff'
const dependencies = (): HandoffDeps => ({
  resolve: id => id === row.agentId ? row : undefined,
  readHistory: () => undefined, recentAsks: () => ['ask'], lastFullText: () => 'answer',
  recaps: () => ['recap'], discoverSession: async () => ({ engine: 'codex', sessionId: row.sessionId, transcriptPath: '/private-fixture/native' }),
  findTranscript: async () => '/private-fixture/native', transcriptOk: () => true,
})
const facade = async () => {
  const { conversationReads, answerConversationQuery } = await import('./conversationQueries.js')
  return { reads: conversationReads(wiring, directory), answerConversationQuery }
}

beforeEach(() => {
  vi.resetModules(); loading.evaluated.mockClear(); loading.create.mockReset(); loading.gate = undefined
  vi.doMock('./handoffDependencies.js', async () => {
    loading.evaluated()
    await loading.gate
    return { createHandoffDependencies: loading.create }
  })
})
afterEach(() => { vi.restoreAllMocks(); vi.doUnmock('./handoffDependencies.js'); vi.resetModules() })

it('keeps construction cold and shares one composition across concurrent first queries', async () => {
  const deps = dependencies(), selected: string[] = []
  deps.findTranscript = async (_engine, id) => { selected.push(id); return '/private-fixture/native' }
  deps.publish = vi.fn(async () => {
    expect(selected).toEqual([row.sessionId])
    return { cwd: '/private-fixture/project', file: null, gitRepo: false, degraded: [] }
  })
  loading.create.mockReturnValue(deps)
  const { reads } = await facade()
  expect(loading.evaluated).not.toHaveBeenCalled()
  expect(loading.create).not.toHaveBeenCalled()
  expect(await Promise.all([reads.resolve(row.agentId), reads.discover(row.agentId), reads.findTranscript('codex', row.sessionId, {})]))
    .toEqual([row, { engine: 'codex', sessionId: row.sessionId, transcriptPath: '/private-fixture/native' }, '/private-fixture/native'])
  expect(loading.evaluated).toHaveBeenCalledOnce()
  expect(loading.create).toHaveBeenCalledExactlyOnceWith(wiring, directory, undefined)
  expect(await reads.publish({} as never, { current: () => true })).toMatchObject({ file: null })
  expect(await reads.recentAsks(row.sessionId, 20)).toEqual(['ask'])
  expect(await reads.lastFullText(row.sessionId)).toBe('answer')
  expect(await reads.recaps(row.sessionId, 5)).toEqual(['recap'])
  expect(await reads.transcriptOk('codex', '/private-fixture/native', null)).toBe(true)
  expect(loading.create).toHaveBeenCalledOnce()
})

const transcript = (session: RegisteredSession) => `/private-fixture/${session.sessionId}`
const found = (session: RegisteredSession) => ({ engine: session.engine, sessionId: session.sessionId, transcriptPath: transcript(session) })
const published = (session: RegisteredSession) => ({ cwd: transcript(session), file: null, gitRepo: false, degraded: [] })
const queryCases: { name: string; ask: (reads: ConversationReads) => Promise<unknown>; value: (session: RegisteredSession) => unknown }[] = [
  { name: 'resolve', ask: reads => reads.resolve(row.agentId), value: session => session },
  { name: 'recentAsks', ask: reads => reads.recentAsks(row.sessionId, 1), value: session => [session.sessionId] },
  { name: 'lastFullText', ask: reads => reads.lastFullText(row.sessionId), value: session => session.sessionId },
  { name: 'recaps', ask: reads => reads.recaps(row.sessionId, 1), value: session => [session.sessionId] },
  { name: 'discover', ask: reads => reads.discover(row.agentId), value: found },
  { name: 'findTranscript', ask: reads => reads.findTranscript('codex', row.sessionId, {}), value: transcript },
  { name: 'transcriptOk', ask: reads => reads.transcriptOk('codex', transcript(row), null), value: session => session === row },
  { name: 'publish', ask: reads => reads.publish({} as never, { current: () => true }), value: published },
]

it.each(queryCases)('starts a warmed $name request before the next caller replaces its conversation', async ({ ask, value }) => {
  let current = row
  const deps: HandoffDeps = {
    resolve: () => current, readHistory: () => undefined,
    recentAsks: () => [current.sessionId], lastFullText: () => current.sessionId, recaps: () => [current.sessionId],
    discoverSession: async session => found(session), findTranscript: async () => transcript(current),
    transcriptOk: () => current === row, publish: async () => published(current),
  }
  loading.create.mockReturnValue(deps)
  const { reads } = await facade()
  expect(await ask(reads)).toEqual(value(row))
  const pending = ask(reads)
  current = { ...row, sessionId: 'replacement-conversation' }
  expect(await pending).toEqual(value(row))
  expect(await ask(reads)).toEqual(value(current))
  expect(loading.create).toHaveBeenCalledOnce()
})

it.each(queryCases)('preserves a cached cold $name method after initialization', async ({ ask, value }) => {
  let current = row
  const deps: HandoffDeps = {
    resolve: () => current, readHistory: () => undefined,
    recentAsks: () => [current.sessionId], lastFullText: () => current.sessionId, recaps: () => [current.sessionId],
    discoverSession: async session => found(session), findTranscript: async () => transcript(current),
    transcriptOk: () => current === row, publish: async () => published(current),
  }
  loading.create.mockReturnValue(deps)
  const { reads } = await facade()
  const saved = { ...reads }
  await reads.resolve(row.agentId)
  const pending = ask(saved)
  current = { ...row, sessionId: 'replacement-conversation' }
  expect(await pending).toEqual(value(row))
  expect(await ask(reads)).toEqual(value(current))
  expect(loading.create).toHaveBeenCalledOnce()
})

it('keeps synchronous dependency failures as rejected warm queries', async () => {
  const deps = dependencies(), failure = new Error('query unavailable')
  loading.create.mockReturnValue(deps)
  const { reads } = await facade()
  await reads.resolve(row.agentId)
  deps.lastFullText = () => { throw failure }
  let pending!: Promise<string | null>
  expect(() => { pending = reads.lastFullText(row.sessionId) }).not.toThrow()
  await expect(pending).rejects.toBe(failure)
  expect(loading.create).toHaveBeenCalledOnce()
})

it('fails visibly for every waiting caller and retries only on a later query', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  loading.create.mockImplementationOnce(() => { throw new Error('private path or content must not escape') }).mockReturnValue(dependencies())
  const { reads } = await facade()
  const results = await Promise.allSettled([reads.resolve(row.agentId), reads.discover(row.agentId), reads.findTranscript('codex', row.sessionId, {})])
  for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: { code: 'HANDOFF_UNAVAILABLE' } })
  expect(logged.mock.calls).toEqual([['[handoff] initialization failed: HANDOFF_UNAVAILABLE']])
  expect(loading.create).toHaveBeenCalledOnce()
  expect(await Promise.all([reads.resolve(row.agentId), reads.recentAsks(row.sessionId, 1)])).toEqual([row, ['ask']])
  expect(loading.create).toHaveBeenCalledTimes(2)
})

it('keeps the originating request check live while the first import waits', async () => {
  let release!: () => void
  loading.gate = new Promise(resolve => { release = resolve })
  const deps = dependencies()
  const publish = vi.fn(async (prepared, permit) => {
    if (!permit.current(prepared.request)) throw Object.assign(new Error('unavailable'), { code: 'HANDOFF_UNAVAILABLE' })
    return { cwd: '/private-fixture/project', file: null, gitRepo: false, degraded: [] }
  })
  deps.publish = publish
  loading.create.mockReturnValue(deps)
  const { reads, answerConversationQuery } = await facade()
  const current = vi.fn(() => true), core = fakeCore({ conversations: reads })
  const pending = answerConversationQuery(core, 'publish', {
    prepared: { request: { agentId: row.agentId, changeId: '1'.repeat(32), targetEngine: 'claude' } }, originRequestId: 'owner-request',
  }, { ownsRequest: current })
  await vi.waitFor(() => expect(loading.evaluated).toHaveBeenCalledOnce())
  expect(publish).not.toHaveBeenCalled()
  current.mockReturnValue(false); release()
  expect(await pending).toEqual({ error: 'HANDOFF_UNAVAILABLE', held: true, retryable: true })
  expect(publish).toHaveBeenCalledOnce()
  expect(current).toHaveBeenCalledWith('owner-request', 'agent_handoff_prepare', {
    agentId: row.agentId, changeId: '1'.repeat(32), targetEngine: 'claude',
  })
})


it('keeps shared live and stopped resolution independent of unavailable handoff code', async () => {
  loading.create.mockImplementation(() => { throw new Error('handoff component unavailable') })
  const live = { ...row, gridLaunch: { credential: 'synthetic-live-canary' } } as unknown as RegisteredSession
  const stopped = { ...row, agentId: 'stopped', gridLaunch: { credential: 'synthetic-stopped-canary' } } as unknown as RegisteredSession
  const shared = { registry: { resolve: (id: string) => id === row.agentId ? live : null },
    stopped: { get: async (id: string) => id === 'stopped' ? stopped : null } } as HandoffWiring
  const { conversationReads, answerConversationQuery } = await import('./conversationQueries.js')
  const reads = conversationReads(shared, directory), core = fakeCore({ conversations: reads })
  const authority = { current: () => true, ownsRequest: () => false }
  for (const original of [live, stopped]) {
    const reply = await answerConversationQuery(core, 'resolve', { id: original.agentId }, authority)
    expect(reply.value).toEqual({ agentId: original.agentId, sessionId: original.sessionId, engine: original.engine })
    expect(reply.value).not.toBe(original)
    expect(Object.hasOwn(reply.value as object, 'gridLaunch')).toBe(false)
    expect(original.gridLaunch).toBeDefined()
  }
  expect(await answerConversationQuery(core, 'resolve', { id: 'missing' }, authority)).toEqual({ value: null })
  expect(loading.evaluated).not.toHaveBeenCalled()
  expect(loading.create).not.toHaveBeenCalled()
})

it('keeps shared stopped resolution fenced to the requesting connection without opening handoff', async () => {
  loading.create.mockImplementation(() => { throw new Error('handoff component unavailable') })
  let finish!: (value: RegisteredSession) => void
  let connected = true
  const shared = { registry: { resolve: () => null },
    stopped: { get: () => new Promise<RegisteredSession>(resolve => { finish = resolve }) } } as HandoffWiring
  const { conversationReads, answerConversationQuery } = await import('./conversationQueries.js')
  const core = fakeCore({ conversations: conversationReads(shared, directory) })
  const pending = answerConversationQuery(core, 'resolve', { id: row.agentId },
    { current: () => connected, ownsRequest: () => false })
  // Observe rejection too: the old lazy wiring fails before it can start the shared archive read.
  const settled = pending.then(value => ({ value }), error => ({ error }))
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  connected = false; finish(row)
  expect(await settled).toEqual({ value: { error: 'SERVICE_UNAVAILABLE' } })
  expect(loading.evaluated).not.toHaveBeenCalled()
  expect(loading.create).not.toHaveBeenCalled()
})
