import { describe, expect, it, vi } from 'vitest'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { HandoffWiring } from '../lib/handoffDiscovery.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CONVERSATIONS_OFF } from './api.js'
import { answerConversationQuery, conversationReads } from './conversationQueries.js'
import { handoffSessionFact } from '../lib/handoffAuthority.js'

const create = vi.hoisted(() => vi.fn())
vi.mock('./handoffDependencies.js', () => ({ createHandoffDependencies: create }))
const readsOf = (deps: HandoffDeps) => {
  create.mockReturnValueOnce(deps)
  return conversationReads({} as HandoffWiring, '/private-fixture/handoff')
}

const session = { agentId: 'retained', sessionId: 's1', engine: 'claude' } as RegisteredSession
const source = { engine: 'claude', sessionId: 's1', transcriptPath: '/claude/s1.jsonl' }

describe('the conversation reads the handoff asks of the core', () => {
  it('bounds a shared single-agent resolve and discards an answer after its original connection ends', async () => {
    let resolve!: (value: typeof session) => void
    let connected = true
    const core = fakeCore({ conversations: { resolve: vi.fn(() => new Promise<typeof session>(done => { resolve = done })) } })
    const authority = { current: () => connected, ownsRequest: () => false }
    for (const id of ['', 'a'.repeat(201)]) expect(await answerConversationQuery(core, 'resolve', { id }, authority)).toEqual({ error: 'BAD_QUERY' })
    expect(core.conversations.resolve).not.toHaveBeenCalled()
    const pending = answerConversationQuery(core, 'resolve', { id: 'retained' }, authority)
    connected = false; resolve(session)
    expect(await pending).toEqual({ error: 'SERVICE_UNAVAILABLE' })
  })

  it('has explicit empty fallbacks, including a refused transcript path', async () => {
    const reads = CONVERSATIONS_OFF
    expect(await reads.resolve('a')).toBeNull()
    expect(await reads.recentAsks('s', 20)).toEqual([])
    expect(await reads.lastFullText('s')).toBeNull()
    expect(await reads.recaps('s', 5)).toEqual([])
    expect(await reads.discover('a')).toBeNull()
    expect(await reads.findTranscript('codex', 's', {})).toBeNull()
    expect(await reads.transcriptOk('codex', '/x', null)).toBe(false)
  })

  const deps = (): HandoffDeps => ({
    resolve: vi.fn(id => id === 'retained' ? session : null), readHistory: () => undefined,
    recentAsks: vi.fn(() => ['ask']), lastFullText: vi.fn(() => 'answer'), recaps: vi.fn(() => ['recap']),
    discoverSession: vi.fn(async () => source), findTranscript: vi.fn(async () => '/codex/s.jsonl'), transcriptOk: vi.fn(() => true),
  })

  it('reads retained agents and their recaps now, and discovers from the core record alone', async () => {
    const d = deps(), reads = readsOf(d)
    expect(await reads.resolve('retained')).toEqual(session)
    expect(await reads.resolve('missing')).toBeNull()
    expect(await reads.recentAsks('s', 20)).toEqual(['ask'])
    expect(d.recentAsks).toHaveBeenCalledWith('s', 20)
    expect(await reads.lastFullText('s')).toBe('answer')
    expect(d.lastFullText).toHaveBeenCalledWith('s')
    expect(await reads.recaps('s', 5)).toEqual(['recap'])
    expect(d.recaps).toHaveBeenCalledWith('s', 5)
    expect(await reads.discover('retained')).toEqual(source)
    expect(d.discoverSession).toHaveBeenCalledWith(session)
    expect(await reads.discover('missing')).toBeNull()
    expect(await reads.findTranscript('codex', 's', { codexHome: '/home' })).toBe('/codex/s.jsonl')
    expect(d.findTranscript).toHaveBeenCalledWith('codex', 's', { codexHome: '/home' })
    expect(await reads.transcriptOk('codex', '/path', '/home')).toBe(true)
    expect(d.transcriptOk).toHaveBeenCalledWith('codex', '/path', '/home')
  })

  it('withholds live and stopped launch credentials from the handoff while discovery keeps the authoritative row', async () => {
    const override = storedGridFixture({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-handoff-canary' })
    const live = { ...session, agentId: 'live', gridLaunch: override }
    const stopped = { ...session, agentId: 'stopped', gridLaunch: override }
    const records = [live, stopped]
    const d = { ...deps(), resolve: vi.fn(id => records.find(row => row.agentId === id) ?? null) }
    const reads = readsOf(d)
    const core = fakeCore({ conversations: reads })
    for (const original of records) {
      const view = await reads.resolve(original.agentId)
      expect(view).not.toBeNull()
      expect(view).not.toBe(original)
      expect(Object.hasOwn(view!, 'gridLaunch')).toBe(false)
      expect(handoffSessionFact(view!)).toEqual(handoffSessionFact(original))
      const reply = await answerConversationQuery(core, 'resolve', { id: original.agentId })
      expect(JSON.stringify(reply)).not.toContain(override.credential.binding)
      await reads.discover(original.agentId)
      expect(d.discoverSession).toHaveBeenLastCalledWith(original)
      expect(vi.mocked(d.discoverSession!).mock.lastCall?.[0]).toBe(original)
      expect(original.gridLaunch).toBe(override)
    }
    expect(await reads.resolve('missing')).toBeNull()
    d.resolve.mockImplementationOnce(() => { throw new Error('fixture unreadable record') })
    await expect(reads.resolve('stopped')).rejects.toThrow('fixture unreadable record')
  })

  it('keeps missing and optional data empty instead of guessing a conversation or a path', async () => {
    const d = deps()
    const reads = readsOf({ ...d, lastFullText: () => undefined, recaps: undefined, discoverSession: undefined, findTranscript: undefined, transcriptOk: undefined })
    expect(await reads.lastFullText('s')).toBeNull()
    expect(await reads.recaps('s', 5)).toEqual([])
    expect(await reads.discover('retained')).toBeNull()
    expect(await reads.findTranscript('claude', 's', {})).toBeNull()
    expect(await reads.transcriptOk('claude', '/x', null)).toBe(false)
    expect(await readsOf({ ...d, discoverSession: async () => ({ engine: 'claude', sessionId: 's', transcriptPath: null }) }).discover('retained'))
      .toEqual({ engine: 'claude', sessionId: 's', transcriptPath: null })
  })

  it('answers only the declared read queries, preserving all arguments', async () => {
    const core = fakeCore({ conversations: readsOf(deps()) })
    const ask = (query: string, payload: Record<string, unknown>) => answerConversationQuery(core, query, payload)
    expect(await ask('resolve', { id: 'retained' })).toEqual({ value: session })
    expect(await ask('discover', { id: 'retained' })).toEqual({ value: source })
    expect(await ask('lastFullText', { id: 's' })).toEqual({ value: 'answer' })
    expect(await ask('recentAsks', { id: 's', n: 20 })).toEqual({ value: ['ask'] })
    expect(await ask('recaps', { id: 's', n: 5 })).toEqual({ value: ['recap'] })
    for (const codexHome of [undefined, null, '/home']) {
      expect(await ask('findTranscript', { engine: 'codex', id: 's', codexHome })).toEqual({ value: '/codex/s.jsonl' })
      expect(await ask('transcriptOk', { engine: 'codex', path: '/path', codexHome })).toEqual({ value: true })
    }
    expect(await ask('credentials', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    for (const query of ['resolve', 'discover', 'lastFullText', 'recentAsks', 'recaps', 'findTranscript', 'transcriptOk']) {
      expect(await ask(query, {}), query).toEqual({ error: 'BAD_QUERY' })
    }
    for (const n of [undefined, '5', 0, -1, 21, 1.5]) expect(await ask('recaps', { id: 's', n })).toEqual({ error: 'BAD_QUERY' })
    for (const payload of [{ engine: 'unknown', id: 's' }, { engine: 'codex', id: 's', codexHome: 5 }, { engine: 'codex' }]) {
      expect(await ask('findTranscript', payload)).toEqual({ error: 'BAD_QUERY' })
    }
    expect(await ask('transcriptOk', { engine: 'claude', path: '' })).toEqual({ error: 'BAD_QUERY' })
  })
})

it('publishes only with a live core-owned originating request and preserves held failures', async () => {
  const { HandoffError } = await import('../lib/handoffAuthority.js')
  await expect(CONVERSATIONS_OFF.publish({} as never, { current: () => true })).rejects.toThrow()
  const empty = readsOf({ resolve: () => null, readHistory: () => undefined, recentAsks: () => [], lastFullText: () => undefined })
  await expect(empty.publish({} as never, { current: () => true })).rejects.toMatchObject({ code: 'HANDOFF_UNAVAILABLE' })
  const request = { agentId: 'a', changeId: '1'.repeat(32), targetEngine: 'claude' }
  const prepared = { request }, ownsRequest = vi.fn(() => true)
  const publish = vi.fn(async (_prepared, permit) => {
    if (!permit.current(request)) throw new HandoffError('HANDOFF_UNAVAILABLE')
    return { cwd: '/work', file: null, gitRepo: false, degraded: [] }
  })
  const core = fakeCore({ conversations: readsOf({ resolve: () => null, readHistory: () => undefined,
    recentAsks: () => [], lastFullText: () => undefined, publish }) })
  const payload = { prepared, originRequestId: 'routed-request' }, authority = { ownsRequest }
  expect(await answerConversationQuery(core, 'publish', payload, authority)).toEqual({ value: { cwd: '/work', file: null, gitRepo: false, degraded: [] } })
  expect(ownsRequest).toHaveBeenCalledWith('routed-request', 'agent_handoff_prepare', request)
  for (const [body, witness] of [[{}, authority], [payload, undefined], [{ prepared, originRequestId: '' }, authority]] as const) {
    expect(await answerConversationQuery(core, 'publish', body, witness)).toMatchObject({ error: 'HANDOFF_UNAVAILABLE', held: true })
  }
  ownsRequest.mockReturnValue(false)
  expect(await answerConversationQuery(core, 'publish', payload, authority)).toMatchObject({ error: 'HANDOFF_UNAVAILABLE', held: true })
  publish.mockRejectedValueOnce(new Error('private failure detail'))
  expect(await answerConversationQuery(core, 'publish', payload, authority)).toEqual({ error: 'HANDOFF_UNAVAILABLE', held: true, retryable: true })
})
import { storedGridFixture } from '../testing/gridCredentials.js'
