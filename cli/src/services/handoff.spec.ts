import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import type { HandoffDeps } from '../lib/agentHandoff.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { HANDOFF_REQUESTS, startHandoff } from './handoff.js'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const request = { agentId: 'agent', changeId: '0123456789abcdef0123456789abcdef', targetEngine: 'codex' }
const owner = { owner: true, local: true }

describe('the change-agent handoff service', () => {
  // The Swarm, which recorded the replacement for its host, was deleted (2026-11-14): a completed change is answered for its owner
  // and nothing of it is kept.
  it('answers a completed change for its owner alone, and keeps nothing of it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'handoff-complete-'))
    try {
      const resolve = vi.fn(async () => null)
      const handler = startHandoff(fakeCore({ dataDir, conversations: { resolve } })).agent_handoff_complete!
      const payload = { agentId: 'old', replacementId: 'new', changeId: '0123456789abcdef', targetEngine: 'claude' }
      expect(await handler(payload, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
      expect(await handler(payload, owner)).toEqual({ ok: true })
      const closed = new AbortController(); closed.abort()
      expect(await handler(payload, owner, closed.signal)).toMatchObject({ error: 'HANDOFF_UNAVAILABLE' })
      expect(resolve).not.toHaveBeenCalled()
      expect(readdirSync(dataDir)).toEqual([])
    } finally { rmSync(dataDir, { recursive: true, force: true }) }
  })
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

// A test on a loaded machine raises the limits; as shipped the request's permit and the preparation share
// HANDOFF_DEADLINE_MS (5 s, lib/handoffAuthority.ts), and git and discovery keep lib/agentHandoff.ts's.
it('holds its request to the preparation deadline, 5 s as shipped and the limits it is given', async () => {
  const result = { file: null, cwd: '/work', gitRepo: false, degraded: [] }
  const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
  try {
    for (const [limits, deadline] of [[undefined, 5_000], [{ deadlineMs: 60_000, gitTimeoutMs: 30_000, discoverMs: 20_000 }, 60_000]] as const) {
      let deps!: HandoffDeps
      const prepare = vi.fn(async (given: HandoffDeps) => { deps = given; return result })
      now.mockReturnValue(1_000)
      await startHandoff(fakeCore(), undefined, prepare, limits).agent_handoff_prepare!(request, owner)
      expect([deps.deadlineMs, deps.gitTimeoutMs, deps.discoverMs]).toEqual([limits?.deadlineMs, limits?.gitTimeoutMs, limits?.discoverMs])
      now.mockReturnValue(1_000 + deadline)
      expect(deps.permit!.current(request)).toBe(true)
      now.mockReturnValue(1_001 + deadline)
      expect(deps.permit!.current(request)).toBe(false)
    }
  } finally { now.mockRestore() }
})

it('retains the exact owner request and revokes publication when its connection closes', async () => {
  const result = { file: null, cwd: '/work', gitRepo: false, degraded: [] }
  const publish = vi.fn(async () => result), core = fakeCore({ conversations: { publish } })
  let deps!: HandoffDeps
  const prepare = vi.fn(async (given: HandoffDeps) => { deps = given; return result })
  const closed = new AbortController()
  await startHandoff(core, undefined, prepare).agent_handoff_prepare!({ ...request, requestId: 'routed' }, owner, closed.signal)
  expect(deps.permit!.requestId).toBe('routed')
  expect(deps.permit!.current(request)).toBe(true)
  for (const other of [{ ...request, agentId: 'other' }, { ...request, changeId: '2'.repeat(32) }, { ...request, targetEngine: 'claude' }]) {
    expect(deps.permit!.current(other)).toBe(false)
  }
  const prepared = { request } as never
  expect(await deps.publish!(prepared, { current: () => false })).toEqual(result)
  expect(publish).toHaveBeenCalledWith(prepared, deps.permit)
  closed.abort(); expect(deps.permit!.current(request)).toBe(false)
})
