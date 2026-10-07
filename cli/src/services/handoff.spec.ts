import { describe, expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { HANDOFF_REQUESTS, startHandoff } from './handoff.js'

const request = { agentId: 'agent', changeId: '0123456789abcdef0123456789abcdef', targetEngine: 'codex' }
const owner = { owner: true, local: true }

describe('the change-agent handoff service', () => {
  it('uses the real provider by default and preserves its unknown-agent answer', async () => {
    const handlers = startHandoff(fakeCore())
    expect(Object.keys(handlers)).toEqual([...HANDOFF_REQUESTS])
    expect(await handlers.agent_handoff_prepare!(request, owner)).toEqual({ error: 'UNKNOWN_AGENT' })
    expect(await handlers.agent_handoff_prepare!(request, { owner: false, local: false })).toEqual({ error: 'OWNER_REQUIRED' })
  })

  it('gives the provider every fact through CoreApi, including database history and stopped ancestors', async () => {
    const session = { agentId: 'agent', sessionId: 's', engine: 'claude' } as RegisteredSession
    const reader = async () => []
    const core = fakeCore({
      conversations: {
        resolve: vi.fn(async () => session), recentAsks: vi.fn(async () => ['ask']), lastFullText: vi.fn(async () => 'answer'),
        recaps: vi.fn(async () => ['recap']), discover: vi.fn(async () => ({ engine: 'claude' as const, sessionId: 's', transcriptPath: '/s.jsonl' })),
        findTranscript: vi.fn(async () => '/s.jsonl'), transcriptOk: vi.fn(async () => true),
      },
      transcripts: { databaseHistory: vi.fn(() => reader) },
    })
    let deps!: HandoffDeps
    const prepare = vi.fn(async (given: HandoffDeps) => { deps = given; return { file: '/handoff', cwd: '/work', gitRepo: true, degraded: [] } })
    const answer = await startHandoff(core, emptyPorts(), prepare).agent_handoff_prepare!(request, owner)
    expect(answer).toEqual({ agentId: 'agent', file: '/handoff', cwd: '/work', gitRepo: true, degraded: [] })
    expect(prepare).toHaveBeenCalledWith(expect.anything(), request)
    expect(await deps.resolve('agent')).toBe(session)
    expect(core.conversations.resolve).toHaveBeenCalledWith('agent')
    expect(deps.readHistory(session)).toBe(reader)
    expect(core.transcripts.databaseHistory).toHaveBeenCalledWith(session)
    expect(await deps.recentAsks('s', 20)).toEqual(['ask'])
    expect(core.conversations.recentAsks).toHaveBeenCalledWith('s', 20)
    expect(await deps.lastFullText('s')).toBe('answer')
    vi.mocked(core.conversations.lastFullText).mockResolvedValueOnce(null)
    expect(await deps.lastFullText('missing')).toBeUndefined()
    expect(await deps.recaps!('s', 5)).toEqual(['recap'])
    expect(core.conversations.recaps).toHaveBeenCalledWith('s', 5)
    expect(await deps.discoverSession!(session)).toEqual({ engine: 'claude', sessionId: 's', transcriptPath: '/s.jsonl' })
    expect(core.conversations.discover).toHaveBeenCalledWith('agent')
    expect(await deps.findTranscript!('claude', 's', {})).toBe('/s.jsonl')
    expect(core.conversations.findTranscript).toHaveBeenCalledWith('claude', 's', {})
    expect(await deps.transcriptOk!('claude', '/s.jsonl', null)).toBe(true)
    expect(core.conversations.transcriptOk).toHaveBeenCalledWith('claude', '/s.jsonl', null)
  })
})
