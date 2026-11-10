/**
 * OpenClaw through the core, on stores built from the recorded fixtures (`engines/openclaw/__fixtures__/`, OpenClaw
 * 2026.11.2): a bound pane's live stream, a phone message's acceptance, and the history and last turn a window and a
 * recap read. The engine's code is the real one, loaded as the core loads it. The fixtures need a Node whose SQLite
 * has fts5 (22.23 or 24; 23.11 lacks it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveFor } from '../../engines/live.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { SessionInputController } from '../../lib/sessionInput.js'
import { TranscriptPager } from '../../lib/transcriptPages.js'
import { readInlineScreen } from '../../testing/inlineScreen.js'
import { inlineSubmission } from '../../testing/inlineSubmission.js'
import { createAttach, type AttachDeps } from './attach.js'
import { createHistory } from './history.js'
import { createLastTurnReader } from './lastTurn.js'
import { createSessionNormalizers } from './normalizers.js'

vi.mock('../../lib/deletedSessions.js', () => ({ isRecentlyDeleted: () => false }))

const FIXTURES = join(import.meta.dirname, '../../engines/openclaw/__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.sql`), 'utf8')

let dir = ''
const open: DatabaseLike[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openclaw-core-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  closeSqliteHandles()
  for (const db of open.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A store from the schema and one scenario, with a writer handle the test changes it through, as the Gateway would. */
function store(scenario: string): { path: string; db: DatabaseLike } {
  const Database = builtinSqlite()
  if (!Database) throw new Error('these specs need node:sqlite')
  const path = join(dir, 'openclaw-agent.sqlite')
  const db = new Database(path, { readOnly: false })
  open.push(db)
  db.exec(fixture('schema'))
  db.exec(fixture(scenario))
  return { path, db }
}

/** Moves a key's rows past its header aside; the returned call writes them back, as OpenClaw writes a run. */
function holdBack(db: DatabaseLike, key: string): () => void {
  const window = String(db.prepare(`SELECT current_session_id AS id FROM session_nodes WHERE session_key = '${key}'`).all()[0].id)
  db.exec(`CREATE TABLE held_events AS SELECT * FROM transcript_events WHERE session_id = '${window}' AND seq > 0;
    CREATE TABLE held_active AS SELECT * FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > 0;
    DELETE FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > 0;
    DELETE FROM transcript_events WHERE session_id = '${window}' AND seq > 0;`)
  return () => db.exec(`BEGIN; INSERT INTO transcript_events SELECT * FROM held_events;
    INSERT INTO session_transcript_active_events SELECT * FROM held_active; COMMIT;`)
}

const pane = (key: string): RegisteredSession => ({
  agentId: 'claw-agent', sessionId: key, engine: 'openclaw', cwd: '/work/proj', active: true,
  processIdentity: { pid: 7714, startMarker: '2026-11-10T07:40:00Z' }, runtimes: [], primaryRuntimeKey: 'tmux:%1',
  registeredAt: 1, touchedAt: 1, lastHookAt: 0,
}) as unknown as RegisteredSession

function attachTo(db: string, row: RegisteredSession, emit: AttachDeps['emit']) {
  const profile = { ingest: vi.fn(), commit: vi.fn() }
  const runtimeProfiles = {
    transcriptFields: vi.fn(() => []), beginHydrate: vi.fn(() => profile), hydrate: vi.fn(), ingest: vi.fn(() => false),
    ingestConfig: vi.fn(async () => false), ingestPane: vi.fn(() => false), capturePane: vi.fn(async () => null),
  }
  const normalizers = createSessionNormalizers()
  const opened = vi.fn(async (_key: string, _pane: { pid: number }) => db)
  const attach = createAttach({
    liveFor, resolve: (id) => (id === row.agentId ? row : undefined), terminalGone: async () => false, normalizers,
    watcher: { addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}), hold: vi.fn(async () => null), tails: vi.fn(() => false) },
    setInterpretationHold: () => false, announceSession: vi.fn(), cursorDiscovery: { add: vi.fn(async () => {}) }, device: () => undefined,
    runtimeProfiles: runtimeProfiles as unknown as AttachDeps['runtimeProfiles'], captureTerminal: vi.fn(async () => null), emit,
    announceTurnAborted: vi.fn(), questionWatcher: { start: vi.fn() }, terminalLabel: () => 'tmux:%1',
    dbs: { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db', openclaw: opened },
    devinHome: '/devin', hermesDb: async () => '/db/hermes.db', concurrency: 1,
  })
  return { attach, normalizers, runtimeProfiles, opened }
}

describe('an OpenClaw pane, through the core', () => {
  it('a bound openclaw pane streams the tool fixture end to end', async () => {
    vi.useFakeTimers()
    const { path, db } = store('tool')
    const writeRun = holdBack(db, 'agent:main:tool')
    const events: LiveEvent[] = []
    const row = pane('agent:main:tool')
    const run = attachTo(path, row, (_sessionId, batch) => { events.push(...batch) })
    expect(await run.attach.attachSession(row)).toBe(true)
    // The store is found from the TUI's process, and the session header feeds the workspace label.
    expect(run.opened).toHaveBeenCalledWith('agent:main:tool', { pid: 7714 })
    expect(run.runtimeProfiles.ingest).toHaveBeenCalledWith(row, expect.stringContaining('"type":"session"'), true)
    expect(run.normalizers.hasState('agent:main:tool')).toBe(true)
    expect(events).toEqual([])
    writeRun()
    // The reader's next poll reads the whole run.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events.map((event) => event.type).filter((type) => type !== 'thinking_delta'))
      .toEqual(['turn_started', 'tool_start', 'tool_end', 'text_delta', 'turn_ended'])
    expect(events.find((event) => event.type === 'tool_start')?.payload).toMatchObject({ tool: 'Bash' })
    expect(run.normalizers.sessionTurnOpen('agent:main:tool')).toBe(false)
    run.normalizers.forget('agent:main:tool')
  })

  it('a phone message to an openclaw agent is accepted on the reader\'s turn_started', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    const writeRun = holdBack(db, 'agent:main:plain')
    const row = pane('agent:main:plain')
    const sendKey = vi.fn(async () => true), onError = vi.fn(), onDelivery = vi.fn()
    const input = new SessionInputController({
      readScreen: readInlineScreen, submission: inlineSubmission, getSession: () => row, validateRuntime: async () => true,
      // Enter reaches the TUI; the Gateway writes the run's rows a moment later.
      inject: async () => { setTimeout(writeRun, 1_200); return true },
      sendKey, capture: async () => null, onError, onDelivery,
    })
    const run = attachTo(path, row, (sessionId, batch) => {
      for (const event of batch) if (event.type === 'turn_started') input.onTurnStarted(sessionId, String(event.payload.userMessage))
    })
    await run.attach.attachSession(row)
    input.submit('agent:main:plain', 'Reply with exactly: plain', 'phone:1')
    // The reader's second poll after the write sees the user row: within the window, so Enter is never pressed again.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(sendKey).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    expect(onDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'phone:1', state: 'delivered' }))
    input.forget('agent:main:plain')
    run.normalizers.forget('agent:main:plain')
  })

  it('history and last turn read across a reset', async () => {
    const { path } = store('reset')
    const row = pane('agent:main:reset')
    const opened = vi.fn(async () => path)
    const dbs = { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db', openclaw: opened }
    const history = createHistory({ resolve: (id) => (id === row.sessionId ? row : undefined), stopped: () => [], pages: new TranscriptPager(),
      readerFor: () => undefined, dbs, hermesDb: async () => '/db/hermes.db' })
    const users = (events: unknown) => (events as LiveEvent[]).filter((event) => event.type === 'user_message').map((event) => event.payload.content)
    const whole = await history.sessionGet({ sessionId: 'agent:main:reset' })
    expect(users(whole.events)).toEqual(['Reply with exactly: before', 'Reply with exactly: after'])
    expect((whole.events as LiveEvent[]).at(-1)?.type).toBe('done')
    // A page from the end starts at a user row, and its cursor reaches back across the reset.
    const last = await history.sessionGet({ sessionId: 'agent:main:reset', limit: 2 })
    expect(users(last.events)).toEqual(['Reply with exactly: after'])
    expect(last).toMatchObject({ hasMore: true, oldestCursor: expect.stringMatching(/^openclaw:\d+$/) })
    const before = await history.sessionGet({ sessionId: 'agent:main:reset', limit: 2, before: last.oldestCursor })
    expect(users(before.events)).toEqual(['Reply with exactly: before'])
    expect(opened).toHaveBeenCalledWith('agent:main:reset', { pid: 7714 })
    const lastTurn = createLastTurnReader({ bySession: () => row, readerFor: () => undefined, dbs, hermesDb: async () => '/db/hermes.db' })
    expect(await lastTurn('agent:main:reset')).toEqual({ userMessage: 'Reply with exactly: after', assistantText: 'after' })
  })
})
