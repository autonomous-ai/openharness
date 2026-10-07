import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type CoreApi } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { SessionSearchIndexOptions } from '../lib/sessionSearch/indexer.js'
import { fakeCore } from '../testing/fakeCore.js'
import { SessionSearchStore, SESSION_SEARCH_FILE } from '../lib/sessionSearch/store.js'
import { SEARCH_REQUESTS, searchRequests, startSearch } from './search.js'

vi.mock('../lib/sessionSearch/store.js', () => ({ SESSION_SEARCH_FILE: 'session-search.db', SessionSearchStore: { open: vi.fn() } }))
// The index, recording what it was built with so its callbacks can be driven directly.
vi.mock('../lib/sessionSearch/indexer.js', async (real) => {
  const actual = await real<typeof import('../lib/sessionSearch/indexer.js')>()
  return {
    ...actual,
    SessionSearchIndex: class {
      started = false
      constructor(readonly opts: SessionSearchIndexOptions) {}
      start() { this.started = true }
    },
  }
})

type Recorded = { opts: SessionSearchIndexOptions; started: boolean }
const row = (over: Partial<RegisteredSession>) =>
  ({ agentId: 'a1', sessionId: 's1', engine: 'claude', registeredAt: 1, ...over }) as RegisteredSession
const reader = async () => []

const ASKER = { local: false, owner: true }

function setup(agents: RegisteredSession[] = [], external: unknown[] = [], owned: string[] = []) {
  const store = { ownedSessionIds: vi.fn(() => new Set(owned)) }
  vi.mocked(SessionSearchStore.open).mockReturnValue(store as never)
  const core = fakeCore({
    agents: { all: vi.fn(() => agents), displayName: vi.fn((s: RegisteredSession) => `name of ${s.agentId}`) },
    transcripts: { databaseHistory: vi.fn((s: RegisteredSession) => (s.engine === 'opencode' ? reader : undefined)) },
    external: {
      sessions: { list: vi.fn(() => external), scan: vi.fn(async () => []) } as unknown as CoreApi['external']['sessions'],
      open: { known: vi.fn(), fresh: vi.fn() } as unknown as CoreApi['external']['open'],
    },
  })
  const ports = emptyPorts()
  const requests = startSearch(core, ports)
  return { core, ports, store, requests, index: ports.search as unknown as Recorded }
}

describe('the session search service', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  describe('starting', () => {
    it('opens the index in the core\'s data folder, starts it, and answers the core through its port and the apps through its requests', () => {
      const { core, index, requests } = setup()
      expect(SessionSearchStore.open).toHaveBeenCalledWith(join('/data', SESSION_SEARCH_FILE))
      expect(index.started).toBe(true)
      expect(index.opts.openSessions).toBe(core.external.open)
      expect(Object.keys(requests ?? {})).toEqual([...SEARCH_REQUESTS])
    })

    it('leaves the port empty, and says so, on a Node without node:sqlite', () => {
      const { core } = setup()
      vi.mocked(SessionSearchStore.open).mockReturnValueOnce(null)
      const ports = emptyPorts()
      expect(startSearch(core, ports)).toBeUndefined()
      expect(ports.search).toBeNull()
      expect(console.warn).toHaveBeenCalledWith('[search] node:sqlite is not available on this Node — session search is off')
    })

    it('leaves the port empty, and says why, when the index cannot be opened', () => {
      const ports = emptyPorts()
      const { core } = setup()
      vi.mocked(SessionSearchStore.open).mockImplementationOnce(() => { throw new Error('disk I/O error') })
      startSearch(core, ports)
      expect(ports.search).toBeNull()
      expect(console.error).toHaveBeenCalledWith('[search] could not open the session index:', 'disk I/O error')
      vi.mocked(SessionSearchStore.open).mockImplementationOnce(() => { throw 'locked' })
      startSearch(core, ports)
      expect(console.error).toHaveBeenLastCalledWith('[search] could not open the session index:', 'locked')
    })
  })

  describe('the requests it answers', () => {
    const index = () => {
      const searched: Array<[string, unknown]> = []
      const tailed: Array<[string, unknown]> = []
      const tail = { sessionId: 'sess-1', rows: [{ turn: 4, at: 1, ask: 'fix the dial', answer: 'Done.', tools: '' }], hasMore: true, total: 5, lastAt: 1 }
      return {
        searched,
        tailed,
        tail,
        index: {
          search: (query: string, options: unknown) => { searched.push([query, options]); return { hits: [], indexed: 3, pending: 0, ready: true, tookMs: 1 } },
          tail: async (sessionId: string, options: unknown) => { tailed.push([sessionId, options]); return sessionId === 'sess-1' ? tail : null },
        },
      }
    }

    it('session_search: the words cut to 500 characters, and only finite numbers for the limit and the window', () => {
      const { index: idx, searched } = index()
      const requests = searchRequests(idx as never)
      expect(requests.session_search({ query: 'dial scroll', limit: 12, from: 5, to: 9 }, ASKER)).toEqual({ hits: [], indexed: 3, pending: 0, ready: true, tookMs: 1 })
      requests.session_search({ query: 'x'.repeat(600), limit: Number.NaN, from: '5', to: Infinity }, ASKER)
      requests.session_search({ query: 7 }, ASKER)
      expect(searched).toEqual([
        ['dial scroll', { limit: 12, from: 5, to: 9 }],
        ['x'.repeat(500), { limit: undefined, from: undefined, to: undefined }],
        ['', { limit: undefined, from: undefined, to: undefined }],
      ])
    })

    it('session_tail: a session\'s rows, paged by whole numbers only, and says what it cannot', async () => {
      const { index: idx, tailed, tail } = index()
      const requests = searchRequests(idx as never)
      expect(await requests.session_tail({ sessionId: 'sess-1', beforeTurn: 9, maxChars: 8000 }, ASKER)).toEqual(tail)
      await requests.session_tail({ sessionId: 'sess-1', beforeTurn: '9', maxChars: 1.5 }, ASKER)
      expect(tailed).toEqual([['sess-1', { beforeTurn: 9, maxChars: 8000 }], ['sess-1', { beforeTurn: undefined, maxChars: undefined }]])
      expect(await requests.session_tail({ sessionId: 'nope' }, ASKER)).toEqual({ error: 'NOT_INDEXED', sessionId: 'nope' })
      expect(await requests.session_tail({}, ASKER)).toEqual({ error: 'BAD_SESSION' })
      await requests.session_tail({ sessionId: 's'.repeat(300) }, ASKER)
      expect(tailed.at(-1)?.[0]).toBe('s'.repeat(200))
    })
  })

  describe('what it indexes', () => {
    it('every agent with a transcript or a database history, named and stamped by its conversation', () => {
      const agents = [
        row({ agentId: 'file', sessionId: 's-file', transcriptPath: '/t/file.jsonl', title: 'Fix login', cwd: '/work/app/api', lastTranscriptAt: 50, lastHookAt: 70 }),
        row({ agentId: 'db', sessionId: 's-db', engine: 'opencode', boundAt: 40 }),
        row({ agentId: 'fresh', sessionId: 's-fresh', transcriptPath: '/t/fresh.jsonl', registeredAt: 30 }),
        row({ agentId: 'unstamped', sessionId: 's-un', transcriptPath: '/t/un.jsonl', registeredAt: 0 }),
        row({ agentId: 'no-session', sessionId: '', transcriptPath: '/t/x.jsonl' }),
        row({ agentId: 'nothing-to-read', sessionId: 's-none' }),
      ]
      const { index } = setup(agents)
      expect(index.opts.sources()).toEqual([
        { agentId: 'file', sessionId: 's-file', engine: 'claude', transcriptPath: '/t/file.jsonl', header: 'name of file · Fix login · api app', changedAt: 70, readHistory: undefined },
        { agentId: 'db', sessionId: 's-db', engine: 'opencode', transcriptPath: null, header: 'name of db', changedAt: 40, readHistory: reader },
        { agentId: 'fresh', sessionId: 's-fresh', engine: 'claude', transcriptPath: '/t/fresh.jsonl', header: 'name of fresh', changedAt: 30, readHistory: undefined },
        { agentId: 'unstamped', sessionId: 's-un', engine: 'claude', transcriptPath: '/t/un.jsonl', header: 'name of unstamped', changedAt: 0, readHistory: undefined },
      ])
    })

    it('conversations Harness did not start, unless Harness holds them under any of their ids', () => {
      const external = [
        { sessionId: 'mine-now', engine: 'claude', transcriptPath: '/t/a.jsonl', mtime: 1 },
        { sessionId: 'mine-before', engine: 'claude', transcriptPath: '/t/b.jsonl', mtime: 1 },
        { sessionId: 'forked', aliases: ['s1'], engine: 'claude', transcriptPath: '/t/c.jsonl', mtime: 1 },
        { sessionId: 'unreadable', engine: 'codex', transcriptPath: null, mtime: 1 },
        { sessionId: 'theirs', engine: 'codex', transcriptPath: '/t/d.jsonl', mtime: 9, cwd: '/work/tool', origin: 'terminal', title: 'Refactor', aliases: ['other'] },
        { sessionId: 'their-db', engine: 'opencode', transcriptPath: null, readHistory: reader, mtime: 8, cwd: '/w', origin: 'app' },
      ]
      const { index } = setup([row({ sessionId: 'mine-now', transcriptPath: '/t/a.jsonl' }), row({ agentId: 'a2', sessionId: '' })], external, ['mine-before', 's1'])
      expect(index.opts.sources().filter((s) => !s.agentId)).toEqual([
        { agentId: '', sessionId: 'theirs', engine: 'codex', transcriptPath: '/t/d.jsonl', header: '', changedAt: 9, external: { cwd: '/work/tool', origin: 'terminal', title: 'Refactor' } },
        { agentId: '', sessionId: 'their-db', engine: 'opencode', transcriptPath: null, header: '', changedAt: 8, external: { cwd: '/w', origin: 'app', title: undefined }, readHistory: reader },
      ])
    })

    it('keeps every agent\'s sessions while the agent exists, looks again for others, and logs as the daemon does', async () => {
      const { core, index } = setup([row({ agentId: 'a1' }), row({ agentId: 'a2' })])
      expect([...index.opts.agents!()]).toEqual(['a1', 'a2'])
      await index.opts.discover!()
      expect(core.external.sessions.scan).toHaveBeenCalled()
      index.opts.log!('[search] indexed 3 sessions')
      expect(console.log).toHaveBeenCalledWith('[search] indexed 3 sessions')
    })
  })
})
