// The session an unbound, live agent runs, found for the handoff (lib/handoffDiscovery.ts): read-only, born-only,
// and never a guess: each refusal below is a case where a Change agent must not pick a conversation.
import { describe, expect, it, vi } from 'vitest'

import { handoffProviderDeps, ownedByOther, sessionDiscovery, type DiscoveryDeps, type HandoffWiring } from './handoffDiscovery.js'
import type { RegisteredSession } from './registry.js'

const MARKER = 'Fri Oct  2 16:58:26 2026'

const agent = (over: Record<string, unknown> = {}): RegisteredSession => ({
  agentId: 'a1', sessionId: '', engine: 'codex', cwd: '/w', transcriptPath: null, registeredAt: 1_790_000_000_000,
  processIdentity: { pid: 4242, executable: 'claude', startMarker: MARKER }, ...over,
}) as unknown as RegisteredSession

type Spied = DiscoveryDeps & { findLiveSession: ReturnType<typeof vi.fn>; processSession: ReturnType<typeof vi.fn> }
/** Codex is the default engine here: Claude is looked for through its process record only (its own block below). */
function deps(over: Partial<DiscoveryDeps> = {}): Spied {
  const findLiveSession = vi.fn(async () => ({ sessionId: 's9', transcriptPath: '/t/s9.jsonl' }))
  const processSession = vi.fn(async () => ({ sessionId: 's9', transcriptPath: '/t/s9.jsonl' }))
  return { findLiveSession, processSession, isLive: () => true, ownedByOther: () => false, isRecentlyDeleted: () => false, ...over } as Spied
}

describe('sessionDiscovery', () => {
  it('finds the unique born session and passes the process start and pid, born-only', async () => {
    const d = deps()
    expect(await sessionDiscovery(d)(agent())).toEqual({ engine: 'codex', sessionId: 's9', transcriptPath: '/t/s9.jsonl' })
    expect(d.findLiveSession).toHaveBeenCalledWith('codex', '/w', Date.parse(MARKER), { bornOnly: true, pid: 4242, codexHome: undefined })
  })

  it('passes a codex agent its own CODEX_HOME', async () => {
    const d = deps()
    await sessionDiscovery(d)(agent({ codexHome: '/h' }))
    expect(d.findLiveSession).toHaveBeenCalledWith('codex', '/w', Date.parse(MARKER), { bornOnly: true, pid: 4242, codexHome: '/h' })
  })

  describe('needs the process itself, as the repair sweep does: a valid start marker and a pid', () => {
    const cases: Array<[string, unknown]> = [
      ['no process identity', null],
      ['an unparseable start marker', { pid: 4242, executable: 'x', startMarker: 'garbage' }],
      ['an empty start marker', { pid: 4242, executable: 'x', startMarker: '' }],
      ['no pid', { executable: 'x', startMarker: MARKER }],
      ['a zero pid', { pid: 0, executable: 'x', startMarker: MARKER }],
      ['a fractional pid', { pid: 1.5, executable: 'x', startMarker: MARKER }],
    ]
    for (const engine of ['codex', 'claude']) {
      for (const [name, processIdentity] of cases) {
        it(`${engine}: ${name} looks nowhere, never falling back to registeredAt`, async () => {
          const d = deps()
          expect(await sessionDiscovery(d)(agent({ engine, processIdentity }))).toBeNull()
          expect(d.findLiveSession).not.toHaveBeenCalled()
          expect(d.processSession).not.toHaveBeenCalled()
        })
      }
    }
  })

  describe('Claude is identified by its process record alone', () => {
    it('accepts only the session the record names, and never scans the project folder', async () => {
      const d = deps()
      expect(await sessionDiscovery(d)(agent({ engine: 'claude' }))).toEqual({ engine: 'claude', sessionId: 's9', transcriptPath: '/t/s9.jsonl' })
      expect(d.processSession).toHaveBeenCalledWith('claude', 4242, '/w', Date.parse(MARKER))
      expect(d.findLiveSession).not.toHaveBeenCalled()
    })
    it('answers nothing, with no scan to fall back on, when the record matches no session or does not exist', async () => {
      const d = deps({ processSession: async () => null })
      expect(await sessionDiscovery(d)(agent({ engine: 'claude' }))).toBeNull()
      expect(d.findLiveSession).not.toHaveBeenCalled()
    })
    it('still refuses a record whose session has no path, is a subagent file, is owned or deleted, or whose read throws', async () => {
      const claude = (over: Partial<DiscoveryDeps>) => sessionDiscovery(deps(over))(agent({ engine: 'claude' }))
      expect(await claude({ processSession: async () => ({ sessionId: 's9' }) })).toBeNull()
      expect(await claude({ processSession: async () => ({ sessionId: 'a', transcriptPath: '/p/s/subagents/agent-a.jsonl' }) })).toBeNull()
      expect(await claude({ ownedByOther: () => true })).toBeNull()
      expect(await claude({ isRecentlyDeleted: () => true })).toBeNull()
      expect(await claude({ processSession: async () => { throw new Error('boom') } })).toBeNull()
    })
  })

  describe('never looks', () => {
    const cases: Array<[string, Record<string, unknown>, Partial<DiscoveryDeps>?]> = [
      ['a bound session', { sessionId: 's1' }],
      ['a fork', { forkedFrom: { agentId: 'p', name: 'P' } }],
      ['a malformed fork record', { forkedFrom: 'x' }],
      ['an agent with no folder', { cwd: '' }],
      ['opencode', { engine: 'opencode' }],
      ['kilo', { engine: 'kilo' }],
      ['hermes', { engine: 'hermes' }],
      ['devin', { engine: 'devin' }],
      ['an agent that is not live (stopped)', {}, { isLive: () => false }],
    ]
    for (const [name, over, depOver] of cases) {
      it(name, async () => {
        const d = deps(depOver)
        expect(await sessionDiscovery(d)(agent(over))).toBeNull()
        expect(d.findLiveSession).not.toHaveBeenCalled()
      })
    }
  })

  describe('refuses a match', () => {
    it('with no transcript path', async () => {
      expect(await sessionDiscovery(deps({ findLiveSession: async () => ({ sessionId: 's9' }) }))(agent())).toBeNull()
    })
    it('that is a subagent transcript', async () => {
      expect(await sessionDiscovery(deps({ findLiveSession: async () => ({ sessionId: 'agent-a', transcriptPath: '/p/proj/s/subagents/agent-a.jsonl' }) }))(agent())).toBeNull()
    })
    it('owned by another agent', async () => {
      const ownedByOther = vi.fn(() => true)
      expect(await sessionDiscovery(deps({ ownedByOther }))(agent())).toBeNull()
      expect(ownedByOther).toHaveBeenCalledWith('s9', 'a1')
    })
    it('that was recently deleted', async () => {
      expect(await sessionDiscovery(deps({ isRecentlyDeleted: () => true }))(agent())).toBeNull()
    })
    it('when nothing is found, or the search throws, or an ownership check throws', async () => {
      expect(await sessionDiscovery(deps({ findLiveSession: async () => null }))(agent())).toBeNull()
      expect(await sessionDiscovery(deps({ findLiveSession: async () => { throw new Error('boom') } }))(agent())).toBeNull()
      expect(await sessionDiscovery(deps({ ownedByOther: () => { throw new Error('boom') } }))(agent())).toBeNull()
    })
  })

  // Verifier additions (unit-INT-a3-r1): the edges of each refusal.
  it('treats an explicit `forkedFrom: null` as no fork, and still looks', async () => {
    const d = deps()
    expect(await sessionDiscovery(d)(agent({ forkedFrom: null }))).toEqual({ engine: 'codex', sessionId: 's9', transcriptPath: '/t/s9.jsonl' })
    expect(d.findLiveSession).toHaveBeenCalledTimes(1)
  })

  describe('never looks, for any fork record that is not null, however malformed', () => {
    for (const forkedFrom of ['', false, 0, {}, [], { agentId: '' }]) {
      it(JSON.stringify(forkedFrom), async () => {
        const d = deps()
        expect(await sessionDiscovery(d)(agent({ forkedFrom }))).toBeNull()
        expect(d.findLiveSession).not.toHaveBeenCalled()
      })
    }
  })

  it('never looks for an agent whose folder is missing altogether', async () => {
    const d = deps()
    expect(await sessionDiscovery(d)(agent({ cwd: undefined }))).toBeNull()
    expect(d.findLiveSession).not.toHaveBeenCalled()
  })

  it('never looks when the liveness check throws', async () => {
    const d = deps({ isLive: () => { throw new Error('boom') } })
    expect(await sessionDiscovery(d)(agent())).toBeNull()
    expect(d.findLiveSession).not.toHaveBeenCalled()
  })

  it('refuses a match with an empty session id', async () => {
    expect(await sessionDiscovery(deps({ findLiveSession: async () => ({ sessionId: '', transcriptPath: '/t/x.jsonl' }) }))(agent())).toBeNull()
  })

  it('refuses a subagent transcript written with backslashes, and accepts a folder that only contains the word', async () => {
    expect(await sessionDiscovery(deps({ findLiveSession: async () => ({ sessionId: 'agent-a', transcriptPath: 'C:\\p\\s\\subagents\\agent-a.jsonl' }) }))(agent())).toBeNull()
    expect(await sessionDiscovery(deps({ findLiveSession: async () => ({ sessionId: 's9', transcriptPath: '/p/my-subagents/s9.jsonl' }) }))(agent()))
      .toEqual({ engine: 'codex', sessionId: 's9', transcriptPath: '/p/my-subagents/s9.jsonl' })
  })

  it('checks deletion and ownership against the found session, and refuses when the deletion check throws', async () => {
    const isRecentlyDeleted = vi.fn(() => false)
    const ownedByOther = vi.fn(() => false)
    await sessionDiscovery(deps({ isRecentlyDeleted, ownedByOther }))(agent())
    expect(isRecentlyDeleted).toHaveBeenCalledWith('s9')
    expect(ownedByOther).toHaveBeenCalledWith('s9', 'a1')
    expect(await sessionDiscovery(deps({ isRecentlyDeleted: () => { throw new Error('boom') } }))(agent())).toBeNull()
  })

  it('answers with the agent\'s own engine, whatever else the match carries', async () => {
    const d = deps({ findLiveSession: async () => ({ sessionId: 's9', transcriptPath: '/t/s9.jsonl', engine: 'opencode' }) as never })
    expect(await sessionDiscovery(d)(agent({ engine: 'pi' }))).toEqual({ engine: 'pi', sessionId: 's9', transcriptPath: '/t/s9.jsonl' })
  })

  it('hands concurrent callers the very same promise', async () => {
    const findLiveSession = vi.fn(() => new Promise<null>(() => {}))
    const discover = sessionDiscovery(deps({ findLiveSession } as Partial<DiscoveryDeps>))
    expect(discover(agent())).toBe(discover(agent()))
    expect(findLiveSession).toHaveBeenCalledTimes(1)
  })

  it('forgets a search that threw (async or not), so the next call searches again', async () => {
    for (const findLiveSession of [vi.fn(async () => { throw new Error('boom') }), vi.fn(() => { throw new Error('sync boom') })]) {
      const discover = sessionDiscovery(deps({ findLiveSession } as Partial<DiscoveryDeps>))
      expect(await discover(agent())).toBeNull()
      expect(await discover(agent())).toBeNull()
      expect(findLiveSession).toHaveBeenCalledTimes(2)
    }
  })

  it('shares one search between concurrent calls for an agent, and searches again once it settled', async () => {
    let release!: (v: { sessionId: string; transcriptPath: string }) => void
    const findLiveSession = vi.fn(() => new Promise<{ sessionId: string; transcriptPath: string }>((resolve) => { release = resolve }))
    const discover = sessionDiscovery(deps({ findLiveSession } as Partial<DiscoveryDeps>))
    const first = discover(agent())
    const second = discover(agent())
    expect(findLiveSession).toHaveBeenCalledTimes(1)
    release({ sessionId: 's9', transcriptPath: '/t/s9.jsonl' })
    expect(await first).toEqual(await second)
    release = () => {}
    void discover(agent())
    await Promise.resolve()
    expect(findLiveSession).toHaveBeenCalledTimes(2)
    // Another agent is not held up by the first.
    void discover(agent({ agentId: 'a2' }))
    expect(findLiveSession).toHaveBeenCalledTimes(3)
  })
})

describe('ownedByOther: another agent holds the session, running or stopped, failing closed', () => {
  const wiring = (over: Partial<Parameters<typeof ownedByOther>[0]> = {}) => ({
    bySession: () => undefined,
    stoppedIds: () => [] as string[],
    stopped: () => null,
    ...over,
  }) as Parameters<typeof ownedByOther>[0]
  const stoppedRow = (agentId: string, sessionId: string) => ({ agentId, sessionId }) as unknown as RegisteredSession

  it('is false for a session nobody holds, or only the agent itself holds', () => {
    expect(ownedByOther(wiring(), 's1', 'a1')).toBe(false)
    expect(ownedByOther(wiring({ bySession: () => ({ agentId: 'a1' }) as never }), 's1', 'a1')).toBe(false)
    expect(ownedByOther(wiring({ stoppedIds: () => ['a1'], stopped: () => stoppedRow('a1', 's1') }), 's1', 'a1')).toBe(false)
  })
  it('is true when a running agent holds it', () => {
    expect(ownedByOther(wiring({ bySession: () => ({ agentId: 'b' }) as never }), 's1', 'a1')).toBe(true)
  })
  it('is true when a stopped agent holds it', () => {
    expect(ownedByOther(wiring({ stoppedIds: () => ['b', 'c'], stopped: (id) => stoppedRow(id, id === 'c' ? 's1' : 'sx') }), 's1', 'a1')).toBe(true)
  })
  it('is true when ONE stopped record cannot be read, even though the others are fine and do not hold it', () => {
    const stopped = (id: string) => { if (id === 'bad') throw new Error('Could not read the saved stopped harness.'); return stoppedRow(id, 'sx') }
    expect(ownedByOther(wiring({ stoppedIds: () => ['b', 'bad', 'c'], stopped }), 's1', 'a1')).toBe(true)
  })
  it('is true when a stopped record exists but is unusable (get answers null), or the stopped folder cannot be listed', () => {
    expect(ownedByOther(wiring({ stoppedIds: () => ['b'], stopped: () => null }), 's1', 'a1')).toBe(true)
    expect(ownedByOther(wiring({ stoppedIds: () => { throw new Error('EACCES') } }), 's1', 'a1')).toBe(true)
  })
  it('is true when the running registry cannot answer', () => {
    expect(ownedByOther(wiring({ bySession: () => { throw new Error('boom') } }), 's1', 'a1')).toBe(true)
  })
})

describe('handoffProviderDeps: each dependency reaches the right function with the right arguments', () => {
  const fork = { agentId: 'f1' } as unknown as RegisteredSession
  const live = { agentId: 'a1', sessionId: '', engine: 'claude', cwd: '/w', registeredAt: 1, processIdentity: { pid: 7, executable: 'c', startMarker: MARKER } } as unknown as RegisteredSession
  function fakes(over: Partial<HandoffWiring> = {}): HandoffWiring {
    return {
      registry: { resolve: () => undefined, byAgent: () => undefined, bySession: () => undefined },
      stopped: { get: () => null, ids: () => [] },
      mirror: { recentAsks: vi.fn(() => ['ask']), lastFullText: vi.fn(() => 'full'), recent: vi.fn(() => []) } as never,
      databaseHistory: vi.fn(() => undefined),
      findLiveSession: vi.fn(async () => null),
      processSession: vi.fn(async () => null),
      isRecentlyDeleted: vi.fn(() => false),
      findResumedTranscript: vi.fn(async () => '/t/x.jsonl'),
      validTranscriptPath: vi.fn(() => true),
      ...over,
    }
  }

  it('resolves a running agent first, then a stopped one', () => {
    const run = { agentId: 'run' } as unknown as RegisteredSession
    const stoppedGet = vi.fn((id: string) => (id === 'gone' ? fork : null))
    const d = handoffProviderDeps(fakes({ registry: { resolve: (id) => (id === 'run' ? run : undefined), byAgent: () => undefined, bySession: () => undefined }, stopped: { get: stoppedGet, ids: () => [] } }))
    expect(d.resolve('run')).toBe(run)
    expect(d.resolve('gone')).toBe(fork)
    expect(stoppedGet).toHaveBeenCalledWith('gone')
    expect(stoppedGet).not.toHaveBeenCalledWith('run')
  })

  it('passes the mirror its session id and count, in that order, and keeps only summary recaps (recap, else text)', () => {
    const recent = vi.fn(() => [
      { kind: 'summary', recap: 'R1', text: 'T1' }, { kind: 'ask', text: 'not a recap' }, { kind: 'summary', recap: '', text: 'T3' }, { kind: 'summary', recap: '', text: '' },
    ])
    const f = fakes({ mirror: { recentAsks: vi.fn(() => ['a']), lastFullText: vi.fn(() => 'full'), recent } as never })
    const d = handoffProviderDeps(f)
    expect(d.recaps?.('sid', 3)).toEqual(['R1', 'T3'])
    expect(recent).toHaveBeenCalledWith('sid', 3)
    expect(d.recentAsks('sid', 4)).toEqual(['a'])
    expect(f.mirror.recentAsks).toHaveBeenCalledWith('sid', 4)
    expect(d.lastFullText('sid')).toBe('full')
    expect(f.mirror.lastFullText).toHaveBeenCalledWith('sid')
  })

  it('hands the database history reader through as is', () => {
    const f = fakes()
    expect(handoffProviderDeps(f).readHistory(live)).toBeUndefined()
    expect(f.databaseHistory).toHaveBeenCalledWith(live)
  })

  it('looks a transcript up by (engine, session id, {codexHome}) and vouches for a path with (engine, path, codexHome or undefined)', async () => {
    const f = fakes()
    const d = handoffProviderDeps(f)
    expect(await d.findTranscript?.('codex', 'sid', { codexHome: '/h' })).toBe('/t/x.jsonl')
    expect(f.findResumedTranscript).toHaveBeenCalledWith('codex', 'sid', { codexHome: '/h' })
    expect(d.transcriptOk?.('codex', '/t/x.jsonl', '/h')).toBe(true)
    expect(f.validTranscriptPath).toHaveBeenLastCalledWith('codex', '/t/x.jsonl', '/h')
    d.transcriptOk?.('claude', '/t/y.jsonl', null)
    expect(f.validTranscriptPath).toHaveBeenLastCalledWith('claude', '/t/y.jsonl', undefined)
  })

  it('discovery: live means a running agent; the deleted check gets the found session id; Claude goes by its process record', async () => {
    const byAgent = vi.fn(() => ({}))
    const isRecentlyDeleted = vi.fn(() => false)
    const processSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: '/t/sx.jsonl' }))
    const f = fakes({ registry: { resolve: () => undefined, byAgent, bySession: () => undefined } as never, processSession, isRecentlyDeleted })
    expect(await handoffProviderDeps(f).discoverSession?.(live)).toEqual({ engine: 'claude', sessionId: 'sx', transcriptPath: '/t/sx.jsonl' })
    expect(byAgent).toHaveBeenCalledWith('a1')
    expect(isRecentlyDeleted).toHaveBeenCalledWith('sx')
    expect(processSession).toHaveBeenCalledWith('claude', 7, '/w', Date.parse(MARKER))
  })

  it('discovery owns the session check against the running registry and the stopped store', async () => {
    const processSession = vi.fn(async () => ({ sessionId: 'sx', transcriptPath: '/t/sx.jsonl' }))
    const running = fakes({ registry: { resolve: () => undefined, byAgent: () => ({}), bySession: (sid: string) => (sid === 'sx' ? { agentId: 'other' } : undefined) } as never, processSession })
    expect(await handoffProviderDeps(running).discoverSession?.(live)).toBeNull()
    const stopped = fakes({ registry: { resolve: () => undefined, byAgent: () => ({}), bySession: () => undefined }, stopped: { ids: () => ['old'], get: () => ({ agentId: 'old', sessionId: 'sx' }) as never }, processSession })
    expect(await handoffProviderDeps(stopped).discoverSession?.(live)).toBeNull()
  })

  it('creates the discovery once: two prepares for the same agent share one search while it is pending', async () => {
    let release!: (v: null) => void
    const processSession = vi.fn(() => new Promise<null>((resolve) => { release = resolve }))
    const d = handoffProviderDeps(fakes({ registry: { resolve: () => undefined, byAgent: () => ({}), bySession: () => undefined } as never, processSession }))
    // The same deps object serves every request: what the provider in cli.ts does.
    const first = d.discoverSession?.(live)
    const second = d.discoverSession?.(live)
    expect(processSession).toHaveBeenCalledTimes(1)
    release(null)
    await Promise.all([first, second])
  })
})
