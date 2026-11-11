/**
 * OpenClaw through the core, on stores built from the recorded fixtures (`engines/openclaw/__fixtures__/`, OpenClaw
 * 2026.11.2): a bound pane's live stream, a phone message's acceptance, and the history and last turn a window and a
 * recap read. The engine's code is the real one, loaded as the core loads it. The fixtures need a Node whose SQLite
 * has fts5 (22.23 or 24; 23.11 lacks it).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { liveFor } from '../../engines/live.js'
import { OPENCLAW_STATES } from '../../engines/openclaw/contract.js'
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
// A test may run the reader on a Node with no `node:sqlite`; the stores are built with the real one first.
vi.mock('../../lib/sqliteBuiltin.js', async (real) => {
  const actual = await real<typeof import('../../lib/sqliteBuiltin.js')>()
  return { ...actual, builtinSqlite: vi.fn(actual.builtinSqlite) }
})

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
  vi.mocked(builtinSqlite).mockReset()
  closeSqliteHandles()
  for (const db of open.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A store from the schema and one scenario (with none, the schema alone, as before the Gateway wrote any session), with a
 *  writer handle the test changes it through, as the Gateway would. */
function store(scenario?: string): { path: string; db: DatabaseLike } {
  const Database = builtinSqlite()
  if (!Database) throw new Error('these specs need node:sqlite')
  const path = join(dir, 'openclaw-agent.sqlite')
  const db = new Database(path, { readOnly: false })
  open.push(db)
  db.exec(fixture('schema'))
  if (scenario) db.exec(fixture(scenario))
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

/** A bind pass's reading of a pane that shows a run in progress. */
const RUNNING = { ready: false, gatewayLost: false, running: true }

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
  const opened = vi.fn(async (_key: string, _pane: { pid: number }): Promise<string | null> => db)
  const setIdentityHold = vi.fn((_id: string, reason?: string) => {
    if (row.identityHold === reason) return false
    if (reason) row.identityHold = reason
    else delete row.identityHold
    return true
  })
  const announceTurnAborted = vi.fn(), announceSession = vi.fn()
  const attach = createAttach({
    liveFor, resolve: (id) => (id === row.agentId ? row : undefined), terminalGone: async () => false, normalizers,
    watcher: { addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}), pollSession: vi.fn(async () => {}), hold: vi.fn(async () => null), tails: vi.fn(() => false) },
    setInterpretationHold: () => false, setIdentityHold, announceSession, cursorDiscovery: { add: vi.fn(async () => {}) }, device: () => undefined,
    runtimeProfiles: runtimeProfiles as unknown as AttachDeps['runtimeProfiles'], captureTerminal: vi.fn(async () => null), emit,
    announceTurnAborted, questionWatcher: { start: vi.fn() }, terminalLabel: () => 'tmux:%1',
    dbs: { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db', openclaw: opened },
    devinHome: '/devin', hermesDb: async () => '/db/hermes.db', concurrency: 1,
  })
  return { attach, normalizers, runtimeProfiles, opened, setIdentityHold, announceTurnAborted, announceSession }
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

  it('a store this OpenClaw cannot be read from is said on the agent, and cleared once an upgrade makes it readable', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label TO label_renamed')
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    expect(row.identityHold).toBe('This OpenClaw version is not supported yet.')
    expect(run.announceSession).toHaveBeenCalledWith(row)
    // Another schema change that still lacks the column: the same state, not said again.
    db.exec('CREATE TABLE unrelated (id INTEGER)')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(row.identityHold).toBe('This OpenClaw version is not supported yet.')
    expect(run.announceSession).toHaveBeenCalledOnce()
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label_renamed TO label')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(row).not.toHaveProperty('identityHold')
    expect(run.announceSession).toHaveBeenCalledTimes(2)
    run.normalizers.forget('agent:main:plain')
  })

  it('an unreadable store never replaces or clears a state another reason said on the agent', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label TO label_renamed')
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    expect(row.identityHold).toBe('This OpenClaw version is not supported yet.')
    // The bind pass could not read the pane: its own reason replaces the store's.
    const other = 'the pane could not be read'
    row.identityHold = other
    // OpenClaw changed its schema and still lacks the column, then gained it back.
    db.exec('CREATE TABLE unrelated (id INTEGER)')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(row.identityHold).toBe(other)
    db.exec('ALTER TABLE session_nodes RENAME COLUMN label_renamed TO label')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(row.identityHold).toBe(other)
    expect(run.announceSession).toHaveBeenCalledTimes(1)
    run.normalizers.forget('agent:main:plain')
  })

  it('a pane working for 30 s on a store with no session says so on the agent, and clears once the session shows', async () => {
    vi.useFakeTimers()
    const { path, db } = store()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    const stream = run.normalizers.openclawReaders.get('agent:main:plain')!
    stream.paneRead(RUNNING)
    await vi.advanceTimersByTimeAsync(30_000)
    stream.paneRead(RUNNING)
    expect(run.setIdentityHold).toHaveBeenCalledWith('claw-agent', OPENCLAW_STATES.noSessions)
    expect(run.announceSession).toHaveBeenCalledWith(row)
    const said = warn.mock.calls.filter(([line]) => String(line).includes(OPENCLAW_STATES.noSessions))
    expect(said).toHaveLength(1)
    expect(said[0][0]).toContain(dirname(path))
    // The Gateway writes the session after all: the next poll finds it, and the next pass clears the state.
    db.exec(fixture('plain'))
    await vi.advanceTimersByTimeAsync(1_500)
    stream.paneRead(RUNNING)
    expect(run.setIdentityHold).toHaveBeenLastCalledWith('claw-agent', undefined)
    expect(row).not.toHaveProperty('identityHold')
    run.normalizers.forget('agent:main:plain')
  })

  it('a store with no session never replaces or clears a state another reason said', async () => {
    vi.useFakeTimers()
    const { path, db } = store()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    // The bind pass could not read the pane: its own reason is on the agent before the store's.
    const other = 'the pane could not be read'
    row.identityHold = other
    const stream = run.normalizers.openclawReaders.get('agent:main:plain')!
    stream.paneRead(RUNNING)
    await vi.advanceTimersByTimeAsync(30_000)
    stream.paneRead(RUNNING)
    expect(row.identityHold).toBe(other)
    db.exec(fixture('plain'))
    await vi.advanceTimersByTimeAsync(1_500)
    stream.paneRead(RUNNING)
    expect(row.identityHold).toBe(other)
    expect(run.announceSession).not.toHaveBeenCalled()
    run.normalizers.forget('agent:main:plain')
  })

  it('a Harness whose Node cannot read the store says so on the agent', async () => {
    const { path } = store('plain')
    vi.mocked(builtinSqlite).mockReturnValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    expect(row.identityHold).toBe('This Harness needs Node 24 to read OpenClaw.')
    expect(run.announceSession).toHaveBeenCalledWith(row)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[openclaw\] \S+ This Harness needs Node 24 to read OpenClaw\.$/))
    run.normalizers.forget('agent:main:plain')
  })

  it('a reader left on a key the agent moved off says nothing on the agent', async () => {
    vi.useFakeTimers()
    const { path, db } = store('plain')
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    await run.attach.attachSession(row)
    // `/new` moved the pane to another key; the old key's store then stops being readable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    row.sessionId = 'agent:main:tui-next'
    db.exec('ALTER TABLE session_nodes RENAME COLUMN status TO status_renamed')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[openclaw\] \S+ This OpenClaw version is not supported yet\.$/))
    expect(row).not.toHaveProperty('identityHold')
    expect(run.announceSession).not.toHaveBeenCalled()
    run.normalizers.forget('agent:main:plain')
  })

  it('a key that names no OpenClaw agent, on a pane with no process, is not read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const row = { ...pane('not-a-key'), processIdentity: undefined } as unknown as RegisteredSession
    const run = attachTo(join(dir, 'unused.sqlite'), row, () => {})
    run.opened.mockResolvedValueOnce(null)
    expect(await run.attach.attachSession(row)).toBe(true)
    expect(run.opened).toHaveBeenCalledWith('not-a-key', { pid: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[openclaw\] \S+ not an OpenClaw session key · not read$/))
    expect(run.normalizers.openclawReaders.has('not-a-key')).toBe(false)
  })

  it('an attach whose pane changed while its store was being found reads nothing', async () => {
    const { path } = store('plain')
    const row = pane('agent:main:plain')
    const run = attachTo(path, row, () => {})
    let found!: (db: string) => void
    run.opened.mockReturnValueOnce(new Promise((resolve) => { found = resolve }))
    const attached = run.attach.attachSession(row)
    await vi.waitFor(() => expect(run.opened).toHaveBeenCalled())
    row.cwd = '/work/elsewhere'
    found(path)
    expect(await attached).toBe(false)
    expect(run.normalizers.openclawReaders.has('agent:main:plain')).toBe(false)
  })

  it('stopping the pollers stops an openclaw reader: a run written after is not read', async () => {
    vi.useFakeTimers()
    const { path, db } = store('tool')
    const writeRun = holdBack(db, 'agent:main:tool')
    const events: LiveEvent[] = []
    const row = pane('agent:main:tool')
    const run = attachTo(path, row, (_sessionId, batch) => { events.push(...batch) })
    await run.attach.attachSession(row)
    run.normalizers.stopPollers()
    writeRun()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(events).toEqual([])
    run.normalizers.forget('agent:main:tool')
  })

  it('a run that timed out with no row of its own is told to the person, and its turn ends', async () => {
    vi.useFakeTimers()
    const { path, db } = store('tool')
    const window = String(db.prepare("SELECT current_session_id AS id FROM session_nodes WHERE session_key = 'agent:main:tool'").all()[0].id)
    db.exec(`DELETE FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > 6;
      DELETE FROM transcript_events WHERE session_id = '${window}' AND seq > 6;
      UPDATE session_nodes SET status = 'running' WHERE session_key = 'agent:main:tool'`)
    const events: LiveEvent[] = []
    const row = pane('agent:main:tool')
    const run = attachTo(path, row, (_sessionId, batch) => { events.push(...batch) })
    await run.attach.attachSession(row)
    db.exec("UPDATE session_nodes SET status = 'timeout' WHERE session_key = 'agent:main:tool'")
    await vi.advanceTimersByTimeAsync(1_000)
    expect(events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(run.announceTurnAborted).toHaveBeenCalledWith('agent:main:tool', 'openclaw', 'The OpenClaw run timed out.')
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

  it('history and last turn of a key with no store, on a pane with no process, are empty', async () => {
    const row = { ...pane('not-a-key'), processIdentity: undefined } as unknown as RegisteredSession
    const opened = vi.fn(async () => null)
    const dbs = { opencode: '/db/opencode.db', kilo: '/db/kilo.db', devin: '/db/devin.db', openclaw: opened }
    const history = createHistory({ resolve: (id) => (id === row.sessionId ? row : undefined), stopped: () => [], pages: new TranscriptPager(),
      readerFor: () => undefined, dbs, hermesDb: async () => '/db/hermes.db' })
    // Nothing but the end of the history.
    expect((await history.sessionGet({ sessionId: 'not-a-key' })).events).toEqual([{ type: 'done', payload: { result: 'success' } }])
    const lastTurn = createLastTurnReader({ bySession: () => row, readerFor: () => undefined, dbs, hermesDb: async () => '/db/hermes.db' })
    expect(await lastTurn('not-a-key')).toBeNull()
    expect(opened).toHaveBeenCalledWith('not-a-key', { pid: 0 })
  })
})
