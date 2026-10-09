import { EngineReadError } from '../../engines/worker/protocol.js'
import { engineTranscriptFor } from '../../engines/transcripts.js'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAmpThread } from '../../engines/amp/threadExport.js'
import { codexMessagesToEvents } from '../../engines/codex/normalizer.js'
import { codexSubagentResolverFor } from '../../engines/codex/subagent.js'
import { cursorMessagesToEvents, windowCursorLines } from '../../engines/cursor/normalizer.js'
import { loadCursorReplayTaskLinks } from '../../engines/cursor/subagent.js'
import { devinMessagesToEvents, windowDevinMessages } from '../../engines/devin/normalizer.js'
import { readDevinMessages } from '../../engines/devin/reader.js'
import { readHermesMessages } from '../../engines/hermes/reader.js'
import { readKiloMessages } from '../../engines/kilo/reader.js'
import { readOpencodeMessages } from '../../engines/opencode/reader.js'
import { piMessagesToEvents } from '../../engines/pi/normalizer.js'
import { lastActivityAt } from '../../lib/agentFrame.js'
import { sid } from '../../lib/log.js'
import { messagesToEvents, windowRawLines } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { HistoryPage, ThreadPages } from '../../lib/transcriptPages.js'
import { tailFileCapped } from '../../lib/transcriptTail.js'
import { createHistory, wholeHistoryPage } from './history.js'
import { loadEngine } from '../../engines/inProcess.js'

/**
 * `session_get`, answered by the core: which reader, replay and window each engine's history goes
 * through, and the reply that comes back, field for field.
 *
 * The engines' own readers, replays and windows are tested with each engine; here each is a fake that
 * says who answered. A replay names itself in every event it makes and ends with the end marker, as
 * every real replay does; a window names its engine and the record a page starts at in its cursors, and
 * reads `stale` as a cursor it cannot find. Transcript reading and sub-agent totals are the real ones.
 * The whole path through the socket, with the real engines, is in backendSocket.history.spec.ts and
 * backendSocket.cappedHistory.spec.ts.
 */
const fake = vi.hoisted(() => {
  const replay = (from: string) => (records: unknown[]) => [
    ...records.map((record) => ({ type: 'text_delta', payload: { content: `${from}: ${String(record)}` } })),
    { type: 'done', payload: { result: 'success' } },
  ]
  const windowOf = (from: string) => (records: unknown[], { limit, before }: { limit: number; before?: string }) => {
    if (before === 'stale') return { window: [], hasMore: false, oldestCursor: null, staleCursor: true }
    const end = before ? Number(before.slice(from.length + 1)) : records.length
    const start = Math.max(0, end - limit)
    return { window: records.slice(start, end), hasMore: start > 0, oldestCursor: `${from}:${start}` }
  }
  const resolver = (): null => null
  return { replay, windowOf, resolver }
})
vi.mock('../../engines/devin/reader.js', async (real) => ({ ...await real<object>(), readDevinMessages: vi.fn(async () => ['d0', 'd1', 'd2', 'd3']) }))
vi.mock('../../engines/hermes/reader.js', async (real) => ({ ...await real<object>(), readHermesMessages: vi.fn(async () => ['h0', 'h1', 'h2', 'h3']) }))
vi.mock('../../engines/opencode/reader.js', async (real) => ({ ...await real<object>(), readOpencodeMessages: vi.fn(async () => ['o0', 'o1', 'o2', 'o3']) }))
vi.mock('../../engines/kilo/reader.js', async (real) => ({ ...await real<object>(), readKiloMessages: vi.fn(async () => ['k0', 'k1', 'k2', 'k3']) }))
vi.mock('../../engines/devin/normalizer.js', async (real) => ({ ...await real<object>(), devinMessagesToEvents: vi.fn(fake.replay('devin')), windowDevinMessages: vi.fn(fake.windowOf('devin')) }))
vi.mock('../../engines/hermes/normalizer.js', async (real) => ({ ...await real<object>(), hermesMessagesToEvents: vi.fn(fake.replay('hermes')), windowHermesMessages: vi.fn(fake.windowOf('hermes')) }))
vi.mock('../../engines/opencode/normalizer.js', async (real) => ({ ...await real<object>(), opencodeMessagesToEvents: vi.fn(fake.replay('opencode')), windowOpencodeMessages: vi.fn(fake.windowOf('opencode')) }))
vi.mock('../../engines/kilo/normalizer.js', async (real) => ({ ...await real<object>(), kiloMessagesToEvents: vi.fn(fake.replay('kilo')), windowKiloMessages: vi.fn(fake.windowOf('kilo')) }))
vi.mock('../../engines/muse/normalizer.js', async (real) => ({ ...await real<object>(), museMessagesToEvents: vi.fn(fake.replay('muse')) }))
vi.mock('../../engines/amp/normalizer.js', async (real) => ({ ...await real<object>(), ampMessagesToEvents: vi.fn(fake.replay('amp')) }))
vi.mock('../../engines/amp/threadExport.js', async (real) => ({ ...await real<object>(), readAmpThread: vi.fn(async () => null), ampThreadToEvents: vi.fn(fake.replay('amp export')) }))
vi.mock('../../engines/grok/normalizer.js', async (real) => ({ ...await real<object>(), grokMessagesToEvents: vi.fn(fake.replay('grok')) }))
vi.mock('../../engines/agy/normalizer.js', async (real) => ({ ...await real<object>(), agyMessagesToEvents: vi.fn(fake.replay('agy')) }))
vi.mock('../../engines/copilot/normalizer.js', async (real) => ({ ...await real<object>(), copilotMessagesToEvents: vi.fn(fake.replay('copilot')) }))
vi.mock('../../engines/pi/normalizer.js', async (real) => ({ ...await real<object>(), piMessagesToEvents: vi.fn(fake.replay('pi')), windowPiLines: vi.fn(fake.windowOf('pi')) }))
vi.mock('../../engines/commandcode/normalizer.js', async (real) => ({ ...await real<object>(), commandcodeMessagesToEvents: vi.fn(fake.replay('commandcode')), windowCommandCodeLines: vi.fn(fake.windowOf('commandcode')) }))
vi.mock('../../engines/cursor/normalizer.js', async (real) => ({
  ...await real<object>(),
  cursorMessagesToEvents: vi.fn((lines: unknown[]) => fake.replay('cursor')(lines)),
  windowCursorLines: vi.fn((lines: unknown[], opts: { limit: number; before?: string }) => ({ ...fake.windowOf('cursor')(lines, opts), startIndex: 7, initialTodos: ['a todo carried in'] })),
}))
vi.mock('../../engines/cursor/subagent.js', async (real) => ({ ...await real<object>(), loadCursorReplayTaskLinks: vi.fn(async () => ['a task link']) }))
vi.mock('../../engines/cursor/home.js', async (real) => ({ ...await real<object>(), cursorConfigDir: vi.fn(() => '/cursor/config'), cursorDataDir: vi.fn(() => '/cursor/data') }))
vi.mock('../../engines/codex/normalizer.js', async (real) => ({ ...await real<object>(), codexMessagesToEvents: vi.fn((lines: unknown[]) => fake.replay('codex')(lines)) }))
vi.mock('../../engines/codex/subagent.js', async (real) => ({ ...await real<object>(), codexSubagentResolverFor: vi.fn(() => fake.resolver) }))
vi.mock('../../engines/claude/normalize.js', async (real) => ({ ...await real<object>(), messagesToEvents: vi.fn(fake.replay('claude')), windowRawLines: vi.fn(fake.windowOf('raw')) }))
vi.mock('../../lib/agentFrame.js', async (real) => ({ ...await real<object>(), lastActivityAt: vi.fn(async () => Date.parse('2026-10-05T08:45:00.000Z')) }))
vi.mock('../../lib/transcriptTail.js', async (real) => {
  const actual = await real<typeof import('../../lib/transcriptTail.js')>()
  return { ...actual, tailFileCapped: vi.fn(actual.tailFileCapped) }
})

// Each engine's readers are its own code, loaded in this process; a test may say one could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, loadEngine: vi.fn(actual.loadEngine) }
})

const MTIME = new Date('2026-10-04T12:00:00.000Z')
const TOUCHED = Date.parse('2026-10-05T08:30:00.000Z')
const NOW = Date.parse('2026-10-05T09:00:00.000Z')
const replayed = (from: string, records: readonly unknown[]) => fake.replay(from)([...records])
/** A page that is not the newest: what a replay made of it, without the end marker. */
const older = (from: string, records: readonly unknown[]) => replayed(from, records).slice(0, -1)
const page = (lines: string[], hasMore: boolean, oldestCursor: string | null, staleCursor?: true): HistoryPage =>
  ({ lines, hasMore, oldestCursor, clipped: false, ...(staleCursor ? { staleCursor } : {}) })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'history-')) })
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

const session = (engine: string, over: Partial<RegisteredSession> = {}) => ({
  agentId: `agent-${engine}`, sessionId: `${engine}-session`, engine, defaultName: 'Release notes', cwd: '/work/app',
  transcriptPath: null, touchedAt: TOUCHED, codexHome: null, ...over,
}) as RegisteredSession

/** A transcript of these lines, last written at MTIME. */
function transcript(lines: string[], name = 'session.jsonl'): string {
  const file = join(dir, name)
  writeFileSync(file, lines.map((line) => `${line}\n`).join(''))
  utimesSync(file, MTIME, MTIME)
  return file
}

function setup(s?: RegisteredSession, kept: RegisteredSession[] = [], readerFor = engineTranscriptFor) {
  // The pager pages a thread by the rules its engine's reader hands it: a record's cursor (Claude Code's) or a
  // line count (Codex's). Each kind is its own mock, so what each engine asked for is checked by kind.
  const claude = vi.fn(async (_path: string, _opts: { limit?: number; before?: string }) => page([], false, null))
  const codex = vi.fn(async (_path: string, _opts: { limit?: number; before?: string }) => page([], false, null))
  const pages = {
    claude, codex,
    page: vi.fn(async (path: string, rules: ThreadPages, opts: { limit?: number; before?: string }) => rules.cursor === 'record' ? claude(path, opts) : codex(path, opts)),
    lineCount: vi.fn(async (_path: string) => 0),
  }
  const deps = {
    resolve: vi.fn((id: string) => (s && (id === s.sessionId || id === s.agentId) ? s : undefined)),
    stopped: vi.fn(() => kept),
    pages,
    readerFor,
    dbs: { opencode: '/stores/opencode.db', kilo: '/stores/kilo.db', devin: '/stores/sessions.db' },
    hermesDb: vi.fn(async () => '/profiles/work/state.db'),
  }
  return { ...createHistory(deps), deps, pages }
}

/** The fields every reply about a session carries. Their order on the wire is checked on its own. */
const about = (s: RegisteredSession, timestamp: number | Date) =>
  ({ id: s.sessionId, title: 'Release notes', timestamp: new Date(timestamp).toISOString(), engine: s.engine })

describe('an engine whose code could not be loaded', () => {
  it('shows an empty conversation, from a store or a transcript, and reads nothing of it', async () => {
    const { readDevinMessages } = await import('../../engines/devin/reader.js')
    vi.mocked(loadEngine).mockResolvedValue(null as never)
    const db = session('devin')
    expect(await setup(db).sessionGet({ sessionId: db.sessionId, limit: 5 })).toStrictEqual({ ...about(db, TOUCHED), events: [], hasMore: false, oldestCursor: null })
    expect(readDevinMessages).not.toHaveBeenCalled()
    const file = session('grok', { transcriptPath: transcript(['g0']) })
    expect(await setup(file).sessionGet({ sessionId: file.sessionId })).toStrictEqual({ ...about(file, MTIME), events: [], hasMore: false, oldestCursor: null })
  })

  // Core reads no engine's lines itself: Claude Code's and Codex's replays are their readers'. A shell keeps no
  // transcript (registry.engineKeepsTranscriptFile), so this is only what a row that somehow had one would get.
  it('so does an engine with neither a reader nor code of its own here', async () => {
    const s = session('terminal', { transcriptPath: transcript(['l0', 'l1']) })
    for (const ask of [{}, { limit: 2 }, { limit: 2, before: 'raw:1' }]) {
      expect(await setup(s, [], () => undefined).sessionGet({ sessionId: s.sessionId, ...ask })).toStrictEqual({ ...about(s, MTIME), events: [], hasMore: false, oldestCursor: null })
    }
    const claude = session('claude', { transcriptPath: transcript(['c0']) })
    expect(await setup(claude, [], () => undefined).sessionGet({ sessionId: claude.sessionId, limit: 2 })).toStrictEqual({ ...about(claude, MTIME), events: [], hasMore: false, oldestCursor: null })
    expect(messagesToEvents).not.toHaveBeenCalled()
    expect(windowRawLines).not.toHaveBeenCalled()
  })
})

describe('what cannot be served', () => {
  it('asks for a session id, and reads only a session the registry knows', async () => {
    const { sessionGet, deps } = setup()
    expect(await sessionGet({})).toStrictEqual({ error: 'MISSING_SESSION_ID' })
    expect(await sessionGet({ sessionId: '' })).toStrictEqual({ error: 'MISSING_SESSION_ID' })
    expect(deps.resolve).not.toHaveBeenCalled()
    // Never a path: an id that names no registered session names nothing to read.
    expect(await sessionGet({ sessionId: '../../outside/secret.jsonl', limit: 5 })).toStrictEqual({ error: 'NOT_FOUND' })
    expect(deps.resolve).toHaveBeenCalledWith('../../outside/secret.jsonl')
  })

  it('answers a session whose engine has written nothing yet with an empty thread, stamped when it was last touched', async () => {
    const s = session('claude')
    const { sessionGet, pages } = setup(s)
    const reply = await sessionGet({ sessionId: s.sessionId, limit: 50 })
    expect(reply).toStrictEqual({ ...about(s, TOUCHED), events: [], hasMore: false, oldestCursor: null })
    expect(Object.keys(reply)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor'])
    expect(pages.claude).not.toHaveBeenCalled()
  })

  it('a conversation kept as a stopped harness, once nothing live holds it, but never by its harness\'s id', async () => {
    const live = session('claude')
    const kept = { ...session('claude'), agentId: 'kept-agent', sessionId: 'kept-session' } as RegisteredSession
    const { sessionGet, deps } = setup(live, [kept])
    expect(await sessionGet({ sessionId: 'kept-session', limit: 50 })).toMatchObject({ id: 'kept-session', engine: 'claude', events: [] })
    expect(deps.resolve).toHaveBeenCalledWith('kept-session')
    // What is live is answered from the registry, without reading the saved ones.
    deps.stopped.mockClear()
    expect(await sessionGet({ sessionId: live.sessionId, limit: 50 })).toMatchObject({ id: live.sessionId })
    expect(deps.stopped).not.toHaveBeenCalled()
    expect(await sessionGet({ sessionId: 'kept-agent', limit: 50 })).toStrictEqual({ error: 'NOT_FOUND' })
  })

  it('found by agent id too, and still answers with the id it was asked for', async () => {
    const s = session('claude')
    const { sessionGet } = setup(s)
    expect(await sessionGet({ sessionId: s.agentId })).toMatchObject({ id: s.agentId, engine: 'claude' })
  })
})

describe('the engines that keep a conversation in a database', () => {
  const engines = [
    ['devin', readDevinMessages, '/stores/sessions.db', ['d0', 'd1', 'd2', 'd3']],
    ['hermes', readHermesMessages, '/profiles/work/state.db', ['h0', 'h1', 'h2', 'h3']],
    ['opencode', readOpencodeMessages, '/stores/opencode.db', ['o0', 'o1', 'o2', 'o3']],
    ['kilo', readKiloMessages, '/stores/kilo.db', ['k0', 'k1', 'k2', 'k3']],
  ] as const

  it.each(engines)('%s: the whole conversation, read from its own store and replayed', async (engine, reader, store, messages) => {
    const s = session(engine)
    const { sessionGet, deps } = setup(s)
    const reply = await sessionGet({ sessionId: s.sessionId })
    expect(reply).toStrictEqual({ ...about(s, TOUCHED), events: replayed(engine, messages) })
    expect(Object.keys(reply)).toEqual(['id', 'title', 'events', 'timestamp', 'engine'])
    expect(reader).toHaveBeenCalledWith(store, s.sessionId)
    // Hermes keeps a store per profile, and reads the one its session lives in.
    if (engine === 'hermes') expect(deps.hermesDb).toHaveBeenCalledWith(s)
    else expect(deps.hermesDb).not.toHaveBeenCalled()
  })

  it.each(engines)('%s: the newest page, the page before it, and a cursor it cannot find', async (engine, _reader, _store, messages) => {
    const s = session(engine)
    const { sessionGet } = setup(s)
    const newest = await sessionGet({ sessionId: s.sessionId, limit: 2 })
    // The newest page ends the thread, so it keeps the end marker; an older page must not carry one.
    expect(newest).toStrictEqual({ ...about(s, TOUCHED), events: replayed(engine, messages.slice(2)), hasMore: true, oldestCursor: `${engine}:2` })
    expect(Object.keys(newest)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor'])
    expect(await sessionGet({ sessionId: s.sessionId, limit: 2, before: `${engine}:2` }))
      .toStrictEqual({ ...about(s, TOUCHED), events: older(engine, messages.slice(0, 2)), hasMore: false, oldestCursor: `${engine}:0` })
    const stale = await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'stale' })
    expect(stale).toStrictEqual({ ...about(s, TOUCHED), events: [], hasMore: false, oldestCursor: null, staleCursor: true })
    expect(Object.keys(stale)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor', 'staleCursor'])
  })

  it('reads a limit that makes no sense as none, the most a page may hold, or rounded down', async () => {
    const s = session('devin')
    const { sessionGet } = setup(s)
    for (const limit of [0, -5, 'ten', null]) expect(await sessionGet({ sessionId: s.sessionId, limit })).not.toHaveProperty('hasMore')
    expect(windowDevinMessages).not.toHaveBeenCalled()
    await sessionGet({ sessionId: s.sessionId, limit: 10_000 })
    expect(windowDevinMessages).toHaveBeenLastCalledWith(['d0', 'd1', 'd2', 'd3'], { limit: 500, before: undefined })
    await sessionGet({ sessionId: s.sessionId, limit: 2.7, before: 7 })
    expect(windowDevinMessages).toHaveBeenLastCalledWith(['d0', 'd1', 'd2', 'd3'], { limit: 2, before: undefined })
  })

  it('an older page drops only an end marker: a page that ends otherwise, or holds nothing, is kept as it is', async () => {
    const s = session('devin')
    const { sessionGet } = setup(s)
    const text = { type: 'text_delta', payload: { content: 'mid-turn' } }
    vi.mocked(devinMessagesToEvents).mockReturnValueOnce([text] as never).mockReturnValueOnce([])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'devin:2' })).events).toEqual([text])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'devin:2' })).events).toEqual([])
  })

  it('a store that cannot be read fails the request, for the socket to answer', async () => {
    const s = session('kilo')
    const { sessionGet } = setup(s)
    vi.mocked(readKiloMessages).mockRejectedValueOnce(new Error('no sqlite3'))
    await expect(sessionGet({ sessionId: s.sessionId, limit: 2 })).rejects.toThrow('no sqlite3')
  })
})

describe('Claude Code and Codex: only the page asked for is read', () => {
  it('Claude Code: a page from the pager, replayed, stamped with the transcript\'s last write', async () => {
    const file = transcript(['c1', 'c2', 'c3'])
    const s = session('claude', { transcriptPath: file })
    const { sessionGet, pages } = setup(s)
    pages.claude.mockResolvedValueOnce(page(['c2', 'c3'], true, 'uuid-2'))
    const reply = await sessionGet({ sessionId: s.sessionId, limit: 2 })
    expect(reply).toStrictEqual({ ...about(s, MTIME), events: replayed('claude', ['c2', 'c3']), hasMore: true, oldestCursor: 'uuid-2' })
    expect(Object.keys(reply)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor'])
    expect(pages.claude).toHaveBeenCalledWith(file, { limit: 2, before: undefined })
    expect(pages.codex).not.toHaveBeenCalled()
  })

  it('an older page drops its end marker and nothing else; a read with no limit ignores a cursor and keeps it', async () => {
    const file = transcript(['c1', 'c2', 'c3'])
    const s = session('claude', { transcriptPath: file })
    const { sessionGet, pages } = setup(s)
    pages.claude.mockResolvedValueOnce(page(['c1'], false, 'uuid-1'))
    expect(await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'uuid-2' }))
      .toStrictEqual({ ...about(s, MTIME), events: older('claude', ['c1']), hasMore: false, oldestCursor: 'uuid-1' })
    expect(pages.claude).toHaveBeenLastCalledWith(file, { limit: 2, before: 'uuid-2' })
    // Without a limit, the newest lines that fit a page: a cursor means nothing then, and the reply is the
    // full-transcript one, with no cursor while every line fit.
    pages.claude.mockResolvedValueOnce(page(['c1', 'c2', 'c3'], false, 'uuid-1'))
    const whole = await sessionGet({ sessionId: s.sessionId, before: 'uuid-2' })
    expect(whole).toStrictEqual({ ...about(s, MTIME), events: replayed('claude', ['c1', 'c2', 'c3']) })
    expect(Object.keys(whole)).toEqual(['id', 'title', 'events', 'timestamp', 'engine'])
    expect(pages.claude).toHaveBeenLastCalledWith(file, {})
    // Only an end marker is dropped: an older page that ends otherwise, or holds nothing, is kept as it is.
    const text = { type: 'text_delta', payload: { content: 'mid-turn' } }
    vi.mocked(messagesToEvents).mockReturnValueOnce([text] as never).mockReturnValueOnce([])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'uuid-1' })).events).toEqual([text])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'uuid-1' })).events).toEqual([])
  })

  it('without a limit, a thread longer than a page holds answers with the cursor to the rest', async () => {
    const s = session('claude', { transcriptPath: transcript(['c1', 'c2', 'c3']) })
    const { sessionGet, pages } = setup(s)
    pages.claude.mockResolvedValueOnce({ ...page(['c3'], true, 'uuid-3'), clipped: true })
    expect(await sessionGet({ sessionId: s.sessionId })).toStrictEqual({ ...about(s, MTIME), events: replayed('claude', ['c3']), hasMore: true, oldestCursor: 'uuid-3' })
  })

  it('a cursor the pager cannot find is stale, so the client reloads', async () => {
    const s = session('claude', { transcriptPath: transcript(['c1']) })
    const { sessionGet, pages } = setup(s)
    pages.claude.mockResolvedValueOnce(page([], false, null, true))
    const reply = await sessionGet({ sessionId: s.sessionId, limit: 5, before: 'not-in-this-file' })
    expect(reply).toStrictEqual({ ...about(s, MTIME), events: [], hasMore: false, oldestCursor: null, staleCursor: true })
    expect(messagesToEvents).not.toHaveBeenCalled()
  })

  it('Codex: its own pager and replay, which finds sub-agents under the home the session runs in', async () => {
    const file = transcript(['x1', 'x2'])
    const s = session('codex', { transcriptPath: file, codexHome: '/homes/codex-work' })
    const { sessionGet, pages } = setup(s)
    pages.codex.mockResolvedValueOnce(page(['x1', 'x2'], false, 'codex:0'))
    expect(await sessionGet({ sessionId: s.sessionId, limit: 5 })).toStrictEqual({ ...about(s, MTIME), events: replayed('codex', ['x1', 'x2']), hasMore: false, oldestCursor: 'codex:0' })
    expect(pages.codex).toHaveBeenCalledWith(file, { limit: 5, before: undefined })
    expect(codexSubagentResolverFor).toHaveBeenCalledWith('/homes/codex-work')
    expect(codexMessagesToEvents).toHaveBeenCalledWith(['x1', 'x2'], fake.resolver)
    expect(pages.claude).not.toHaveBeenCalled()
  })

  it('a transcript that is gone is stamped now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const s = session('claude', { transcriptPath: join(dir, 'gone.jsonl') })
    const { sessionGet } = setup(s)
    expect(await sessionGet({ sessionId: s.sessionId, limit: 5 })).toStrictEqual({ ...about(s, NOW), events: replayed('claude', []), hasMore: false, oldestCursor: null })
  })
})

describe('sub-agent totals, joined from their own transcripts', () => {
  // What an async sub-agent wrote: three tool calls over a minute, 22 tokens.
  const subagent = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-04T10:00:00.000Z', message: { role: 'user', content: 'go' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:00:05.000Z', message: { content: [{ type: 'tool_use', id: 'a' }, { type: 'tool_use', id: 'b' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
    '',
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-04T10:01:00.000Z', message: { content: [{ type: 'tool_use', id: 'c' }], usage: { cache_read_input_tokens: 7 } } }),
  ]
  const end = (subagentSummary?: Record<string, unknown>) =>
    ({ type: 'tool_end', payload: { id: 't', tool: 'Task', output: '', isError: false, summary: '', ...(subagentSummary ? { subagent: subagentSummary } : {}) } })
  const writeSubagent = (id: string, lines: string[]) => {
    mkdirSync(join(dir, 'session', 'subagents'), { recursive: true })
    writeFileSync(join(dir, 'session', 'subagents', `agent-${id}.jsonl`), lines.join('\r\n'))
  }

  it('fills in only what a launch left out, read a line at a time; a sub-agent with no transcript yet is left as it is', async () => {
    writeSubagent('agent7', subagent)
    // Counted already: its transcript must not be read again (this one would count one call).
    writeSubagent('agent8', [subagent[1]])
    const s = session('claude', { transcriptPath: transcript(['c1']) })
    const { sessionGet, pages } = setup(s)
    pages.claude.mockResolvedValueOnce(page(['c1'], false, null))
    vi.mocked(messagesToEvents).mockReturnValueOnce([
      { type: 'text_delta', payload: { content: 'not a tool' } },
      end(),
      end({ agentType: 'Explore' }),
      end({ agentId: 'agent7' }),
      end({ agentId: 'agent7', totalDurationMs: 5, totalTokens: 9 }),
      end({ agentId: 'agent8', totalToolUseCount: 4 }),
      end({ agentId: 'missing' }),
    ] as never)
    const { events } = await sessionGet({ sessionId: s.sessionId, limit: 50 }) as { events: Array<{ payload: { subagent?: unknown } }> }
    expect(events.map((event) => event.payload.subagent)).toEqual([
      undefined,
      undefined,
      { agentType: 'Explore' },
      { agentId: 'agent7', totalToolUseCount: 3, totalDurationMs: 60_000, totalTokens: 22 },
      { agentId: 'agent7', totalToolUseCount: 3, totalDurationMs: 5, totalTokens: 9 },
      { agentId: 'agent8', totalToolUseCount: 4 },
      { agentId: 'missing' },
    ])
  })

  it('only Claude Code\'s reader joins them: an engine with its own replay is not joined', async () => {
    writeSubagent('agent7', subagent)
    const lines = ['l0', 'l1']
    for (const limit of [5, undefined]) {
      const s = session('pi', { transcriptPath: transcript(lines) })
      vi.mocked(piMessagesToEvents).mockReturnValueOnce([end({ agentId: 'agent7' })] as never)
      const { events } = await setup(s).sessionGet({ sessionId: s.sessionId, limit }) as { events: Array<{ payload: { subagent?: Record<string, unknown> } }> }
      expect(events[0].payload.subagent?.totalToolUseCount, `limit ${limit}`).toBeUndefined()
    }
  })
})

describe('the other file engines: read from the end, bounded', () => {
  const lines = ['l0', 'l1', 'l2', 'l3']

  it.each([
    ['cursor', 'cursor'], ['muse', 'muse'], ['amp', 'amp'], ['grok', 'grok'], ['agy', 'agy'], ['copilot', 'copilot'],
    ['pi', 'pi'], ['commandcode', 'commandcode'],
  ])('%s: the whole transcript, through its own replay', async (engine, from) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const file = transcript(lines)
    const s = session(engine, { transcriptPath: file })
    const { sessionGet } = setup(s)
    const reply = await sessionGet({ sessionId: s.sessionId })
    expect(reply).toStrictEqual({ ...about(s, MTIME), events: replayed(from, lines) })
    expect(Object.keys(reply)).toEqual(['id', 'title', 'events', 'timestamp', 'engine'])
    expect(tailFileCapped).toHaveBeenCalledWith(file)
    if (engine === 'cursor') {
      expect(loadCursorReplayTaskLinks).toHaveBeenCalledWith('/cursor/config', s.sessionId, '/cursor/data')
      expect(cursorMessagesToEvents).toHaveBeenCalledWith(lines, s.sessionId, ['a task link'])
    }
  })

  it.each(['muse', 'amp', 'grok', 'agy', 'copilot'])('%s has no windower: a page is the whole transcript, and says there is no more', async (engine) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = session(engine, { transcriptPath: transcript(lines) })
    const { sessionGet } = setup(s)
    const reply = await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'anything' })
    expect(reply).toStrictEqual({ ...about(s, MTIME), events: replayed(engine, lines), hasMore: false, oldestCursor: null })
    expect(Object.keys(reply)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor'])
    // Never the raw window: its cursor and Claude Code's replay would make nothing of these lines.
    expect(windowRawLines).not.toHaveBeenCalled()
    expect(messagesToEvents).not.toHaveBeenCalled()
  })

  it('amp: from amp\'s own store when the thread exports, else the local transcript, and the log says which', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = session('amp', { sessionId: 'T-0123456789abcdef', transcriptPath: transcript(lines) })
    const { sessionGet } = setup(s)
    vi.mocked(readAmpThread).mockResolvedValueOnce(['e1', 'e2'] as never).mockResolvedValueOnce(['e3'] as never)
    expect((await sessionGet({ sessionId: s.sessionId })).events).toEqual(replayed('amp export', ['e1', 'e2']))
    expect((await sessionGet({ sessionId: s.sessionId, limit: 5 })).events).toEqual(replayed('amp export', ['e3']))
    expect(readAmpThread).toHaveBeenCalledWith('T-0123456789abcdef')
    expect(log).toHaveBeenCalledWith('[history] T-0123456789 amp · 2 message(s) from amp\'s own store')
    expect(log).toHaveBeenCalledWith('[history] T-0123456789 amp · 1 message(s) from amp\'s own store')
    expect((await sessionGet({ sessionId: s.sessionId, limit: 5 })).events).toEqual(replayed('amp', lines))
    expect(warn).toHaveBeenCalledWith('[history] T-0123456789 amp · export unavailable — falling back to the local transcript')
  })

  it.each([
    ['cursor', 'cursor', 'cursor'], ['pi', 'pi', 'pi'], ['commandcode', 'commandcode', 'commandcode'],
  ])('%s: the newest page, the page before it, and a cursor it cannot find, through its own window', async (engine, window, from) => {
    const s = session(engine, { transcriptPath: transcript(lines) })
    const { sessionGet } = setup(s)
    const newest = await sessionGet({ sessionId: s.sessionId, limit: 2 })
    expect(newest).toStrictEqual({ ...about(s, MTIME), events: replayed(from, ['l2', 'l3']), hasMore: true, oldestCursor: `${window}:2` })
    expect(Object.keys(newest)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor'])
    expect(await sessionGet({ sessionId: s.sessionId, limit: 2, before: `${window}:2` }))
      .toStrictEqual({ ...about(s, MTIME), events: older(from, ['l0', 'l1']), hasMore: false, oldestCursor: `${window}:0` })
    const stale = await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'stale' })
    expect(stale).toStrictEqual({ ...about(s, MTIME), events: [], hasMore: false, oldestCursor: null, staleCursor: true })
    expect(Object.keys(stale)).toEqual(['id', 'title', 'events', 'timestamp', 'engine', 'hasMore', 'oldestCursor', 'staleCursor'])
    if (engine === 'cursor') {
      // A window begins mid-conversation: its replay is told where, and which todos were open there.
      expect(cursorMessagesToEvents).toHaveBeenCalledWith(['l2', 'l3'], s.sessionId, ['a task link'], 7, ['a todo carried in'])
    }
  })

  it('cursor: a window that names no start or open todos replays as from the start', async () => {
    const s = session('cursor', { transcriptPath: transcript(lines) })
    const { sessionGet } = setup(s)
    vi.mocked(windowCursorLines).mockReturnValueOnce({ window: ['l3'], hasMore: true, oldestCursor: 'cursor:3' } as never)
    await sessionGet({ sessionId: s.sessionId, limit: 1 })
    expect(cursorMessagesToEvents).toHaveBeenCalledWith(['l3'], s.sessionId, ['a task link'], 0, [])
  })

  it('an older page drops only an end marker', async () => {
    const s = session('pi', { transcriptPath: transcript(lines) })
    const { sessionGet } = setup(s)
    const text = { type: 'text_delta', payload: { content: 'mid-turn' } }
    vi.mocked(piMessagesToEvents).mockReturnValueOnce([text] as never).mockReturnValueOnce([])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'pi:2' })).events).toEqual([text])
    expect((await sessionGet({ sessionId: s.sessionId, limit: 2, before: 'pi:2' })).events).toEqual([])
  })

  it('past the cap: the newest history, and every reply says so, as does the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(tailFileCapped).mockResolvedValue({ lines: ['l3'], truncated: true })
    const ask = async (engine: string, payload: Record<string, unknown>) => {
      const s = session(engine, { transcriptPath: transcript(lines) })
      return { s, reply: await setup(s).sessionGet({ sessionId: s.sessionId, ...payload }) }
    }
    const whole = await ask('muse', {})
    expect(whole.reply).toStrictEqual({ ...about(whole.s, MTIME), events: replayed('muse', ['l3']), truncated: true })
    const wholePage = await ask('grok', { limit: 5 })
    expect(wholePage.reply).toStrictEqual({ ...about(wholePage.s, MTIME), events: replayed('grok', ['l3']), hasMore: false, oldestCursor: null, truncated: true })
    const windowed = await ask('pi', { limit: 5 })
    expect(windowed.reply).toStrictEqual({ ...about(windowed.s, MTIME), events: replayed('pi', ['l3']), hasMore: false, oldestCursor: 'pi:0', truncated: true })
    const stale = await ask('commandcode', { limit: 5, before: 'stale' })
    expect(stale.reply).toStrictEqual({ ...about(stale.s, MTIME), events: [], hasMore: false, oldestCursor: null, staleCursor: true, truncated: true })
    expect(warn).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalledWith(`[backend] session_get ${sid('muse-session')}: the transcript is over 64 MB · its oldest history is not shown`)
  })

  it('a transcript that is gone reads as an empty one, stamped now', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const s = session('muse', { transcriptPath: join(dir, 'gone.jsonl') })
    const { sessionGet } = setup(s)
    expect(await sessionGet({ sessionId: s.sessionId })).toStrictEqual({ ...about(s, NOW), events: replayed('muse', []) })
  })
})

describe('the replays with no windower answer both shapes', () => {
  it('a whole page for a legacy request, and one that says it is the last for a paginated one', () => {
    const events = replayed('grok', ['l0']) as Parameters<typeof wholeHistoryPage>[0]
    expect(wholeHistoryPage(events, false)).toStrictEqual({ events })
    expect(wholeHistoryPage(events, true)).toStrictEqual({ events, hasMore: false, oldestCursor: null })
  })
})

describe('the conversation an agent holds (sessions_list)', () => {
  it('asks for an agent, and lists nothing for one it does not know or one whose engine has not bound a conversation', async () => {
    const pending = session('claude', { sessionId: '' })
    const { sessionsList, pages } = setup(pending)
    expect(await sessionsList({})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    expect(await sessionsList({ agentId: 'nobody' })).toStrictEqual({ sessions: [] })
    expect(await sessionsList({ agentId: pending.agentId })).toStrictEqual({ sessions: [] })
    expect(pages.lineCount).not.toHaveBeenCalled()
  })

  it('the one conversation, its lines counted by the pager rather than read whole, in the fields it always had', async () => {
    const file = transcript(['c1', 'c2'])
    const s = session('codex', { transcriptPath: file, registeredAt: Date.parse('2026-10-05T07:00:00.000Z') })
    const { sessionsList, pages } = setup(s)
    pages.lineCount.mockResolvedValueOnce(42)
    const reply = await sessionsList({ agentId: s.agentId }) as { sessions: Array<Record<string, unknown>> }
    expect(reply).toStrictEqual({ sessions: [{
      id: s.sessionId, title: 'Release notes', timestamp: '2026-10-05T07:00:00.000Z', messageCount: 42,
      lastActivity: '2026-10-05T08:45:00.000Z', participants: [],
    }] })
    expect(Object.keys(reply)).toEqual(['sessions'])
    expect(Object.keys(reply.sessions[0])).toEqual(['id', 'title', 'timestamp', 'messageCount', 'lastActivity', 'participants'])
    expect(pages.lineCount).toHaveBeenCalledWith(file)
    expect(lastActivityAt).toHaveBeenCalledWith(s)
  })

  it('a conversation kept in a database has no file to count', async () => {
    const s = session('opencode', { registeredAt: Date.parse('2026-10-05T07:00:00.000Z') })
    const { sessionsList, pages } = setup(s)
    expect(await sessionsList({ agentId: s.agentId })).toMatchObject({ sessions: [{ id: s.sessionId, messageCount: 0 }] })
    expect(pages.lineCount).not.toHaveBeenCalled()
  })
})

describe('asked by agent id', () => {
  // The registry finds an agent by its agent id as well as by its session id, and the reply still names
  // the id it was asked for. What is read must be the conversation's own, though: an engine's store, its
  // export and its task links know the session id alone, and with the agent id read nothing at all.
  it('reads a database engine\'s store under the session id', async () => {
    const s = session('opencode')
    const { sessionGet } = setup(s)
    expect(await sessionGet({ sessionId: s.agentId, limit: 2 })).toMatchObject({ id: s.agentId, events: replayed('opencode', ['o2', 'o3']) })
    expect(readOpencodeMessages).toHaveBeenCalledWith('/stores/opencode.db', s.sessionId)
  })

  it('reads Cursor\'s task links, and replays its tasks, under the session id', async () => {
    const s = session('cursor', { transcriptPath: transcript(['l0', 'l1']) })
    const { sessionGet } = setup(s)
    await sessionGet({ sessionId: s.agentId })
    await sessionGet({ sessionId: s.agentId, limit: 1 })
    expect(loadCursorReplayTaskLinks).toHaveBeenNthCalledWith(1, '/cursor/config', s.sessionId, '/cursor/data')
    expect(loadCursorReplayTaskLinks).toHaveBeenNthCalledWith(2, '/cursor/config', s.sessionId, '/cursor/data')
    expect(cursorMessagesToEvents).toHaveBeenNthCalledWith(1, ['l0', 'l1'], s.sessionId, ['a task link'])
    expect(cursorMessagesToEvents).toHaveBeenNthCalledWith(2, ['l1'], s.sessionId, ['a task link'], 7, ['a todo carried in'])
  })

  it('exports an Amp thread under the session id', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const s = session('amp', { sessionId: 'T-0123456789abcdef', transcriptPath: transcript(['l0']) })
    const { sessionGet } = setup(s)
    await sessionGet({ sessionId: s.agentId })
    await sessionGet({ sessionId: s.agentId, limit: 5 })
    expect(readAmpThread).toHaveBeenNthCalledWith(1, 'T-0123456789abcdef')
    expect(readAmpThread).toHaveBeenNthCalledWith(2, 'T-0123456789abcdef')
  })
})


describe('history crossing a reader boundary', () => {
  it('rejects results for a changed or removed binding, including an in-place mutation', async () => {
    for (const change of ['mutate', 'remove']) {
      const s = session('claude', { transcriptPath: '/read.jsonl' })
      let finish!: () => void
      const waiting = new Promise<void>((r) => { finish = r })
      const adapter = { historyPage: async () => { await waiting; return { events: [], timestamp: MTIME.toISOString() } }, lastTurnText: async () => null }
      const h = setup(s, [], () => adapter)
      const result = h.sessionGet({ sessionId: s.sessionId })
      if (change === 'mutate') s.transcriptPath = '/replacement.jsonl'
      else h.deps.resolve.mockReturnValue(undefined)
      finish()
      expect(await result).toEqual({ error: 'ENGINE_STALE_REPLY', retryable: true })
    }
  })

  it('returns explicit retry guidance and never invokes the inline pager on a failed worker read', async () => {
    for (const error of [new EngineReadError('ENGINE_REPLY_TOO_LARGE'), new Error('socket failed')]) {
      const h = setup(session('codex', { transcriptPath: '/read.jsonl' }), [], () => ({
        historyPage: async () => { throw error }, lastTurnText: async () => null,
      }))
      expect(await h.sessionGet({ sessionId: 'codex-session' })).toEqual(error instanceof EngineReadError
        ? { error: 'ENGINE_REPLY_TOO_LARGE', retryable: false } : { error: 'ENGINE_UNAVAILABLE', retryable: true })
      expect(h.pages.codex).not.toHaveBeenCalled()
    }
  })
})
