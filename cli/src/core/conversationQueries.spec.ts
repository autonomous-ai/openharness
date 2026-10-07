import { describe, expect, it, vi } from 'vitest'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { CONVERSATIONS_OFF } from './api.js'
import { answerConversationQuery, conversationReads } from './conversationQueries.js'

const session = { agentId: 'retained', sessionId: 's1', engine: 'claude' } as RegisteredSession
const source = { engine: 'claude', sessionId: 's1', transcriptPath: '/claude/s1.jsonl' }

describe('the conversation reads the handoff asks of the core', () => {
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
    const d = deps(), reads = conversationReads(d)
    expect(await reads.resolve('retained')).toBe(session)
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

  it('keeps missing and optional data empty instead of guessing a conversation or a path', async () => {
    const d = deps()
    const reads = conversationReads({ ...d, lastFullText: () => undefined, recaps: undefined, discoverSession: undefined, findTranscript: undefined, transcriptOk: undefined })
    expect(await reads.lastFullText('s')).toBeNull()
    expect(await reads.recaps('s', 5)).toEqual([])
    expect(await reads.discover('retained')).toBeNull()
    expect(await reads.findTranscript('claude', 's', {})).toBeNull()
    expect(await reads.transcriptOk('claude', '/x', null)).toBe(false)
    expect(await conversationReads({ ...d, discoverSession: async () => ({ engine: 'claude', sessionId: 's', transcriptPath: null }) }).discover('retained'))
      .toEqual({ engine: 'claude', sessionId: 's', transcriptPath: null })
  })

  it('answers only the declared read queries, preserving all arguments', async () => {
    const core = fakeCore({ conversations: conversationReads(deps()) })
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
