/** The existing caller facade owns one deferred handoff composition, never an empty-read fallback. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { HandoffWiring } from '../lib/handoffDiscovery.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'

const loading = vi.hoisted(() => ({ evaluated: vi.fn(), create: vi.fn(), gate: undefined as Promise<void> | undefined }))
vi.mock('./handoffDependencies.js', async () => {
  loading.evaluated()
  await loading.gate
  return { createHandoffDependencies: loading.create }
})

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

beforeEach(() => { vi.resetModules(); loading.evaluated.mockClear(); loading.create.mockReset(); loading.gate = undefined })
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

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
