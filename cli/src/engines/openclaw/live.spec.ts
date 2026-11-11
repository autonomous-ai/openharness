/**
 * A bound OpenClaw session's live stream (live.ts) on stores built from the recorded fixtures (`__fixtures__/`,
 * OpenClaw 2026.11.2): when a turn the store never closes is closed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../../lib/normalize.js'
import { builtinSqlite, closeSqliteHandles, type DatabaseLike } from '../../lib/sqliteBuiltin.js'
import { OpenclawLive } from './live.js'

const FIXTURES = join(import.meta.dirname, '__fixtures__')
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.sql`), 'utf8')

let dir = ''
const open: DatabaseLike[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'openclaw-live-')) })
afterEach(() => {
  closeSqliteHandles()
  for (const db of open.splice(0)) db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A store holding a recorded scenario; with none, the schema alone, as before the Gateway wrote any session. */
function store(scenario?: string): { path: string; db: DatabaseLike } {
  const path = join(dir, `${scenario ?? 'empty'}.sqlite`)
  const db = new (builtinSqlite()!)(path, { readOnly: false })
  open.push(db)
  db.exec(fixture('schema'))
  if (scenario) db.exec(fixture(scenario))
  return { path, db }
}
const windowOf = (db: DatabaseLike, key: string): string =>
  String(db.prepare(`SELECT current_session_id AS id FROM session_nodes WHERE session_key = '${key}'`).all()[0].id)
/** Takes the rows of a window past `seq` away, as they were before OpenClaw wrote them. */
const truncate = (db: DatabaseLike, window: string, seq: number): void => db.exec(`
  DELETE FROM session_transcript_active_events WHERE session_id = '${window}' AND event_seq > ${seq};
  DELETE FROM transcript_events WHERE session_id = '${window}' AND seq > ${seq};`)
const status = (db: DatabaseLike, key: string, value: string): void =>
  db.exec(`UPDATE session_nodes SET status = '${value}' WHERE session_key = '${key}'`)
const userRow = (db: DatabaseLike, window: string, seq: number, text: string): void => db.exec(`
  INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES
  ('${window}', ${seq}, '{"type":"message","id":"u-${seq}","message":{"role":"user","content":"${text}"}}', 1)`)

function live(path: string, key: string) {
  const events: LiveEvent[] = []
  const deps = {
    db: path, key, pollMs: 10,
    onEvents: vi.fn((batch: LiveEvent[]) => { events.push(...batch) }),
    onFailed: vi.fn(), onFatal: vi.fn(),
  }
  return { stream: new OpenclawLive(deps), deps, events }
}
const types = (events: LiveEvent[]): string[] => events.map((event) => event.type)
const ended = (events: LiveEvent[]) => events.filter((event) => event.type === 'turn_ended')

describe('OpenclawLive', () => {
  it('attached mid-run, it opens the turn it never saw start; a run that is over opens nothing', async () => {
    const { path, db } = store('tool')
    // The user row and the assistant's tool call, with no answer yet.
    truncate(db, windowOf(db, 'agent:main:tool'), 6)
    status(db, 'agent:main:tool', 'running')
    const mid = live(path, 'agent:main:tool')
    await mid.stream.start()
    mid.stream.stop()
    expect(types(mid.events)).toEqual(['turn_started'])
    expect(mid.stream.turnOpen).toBe(true)
    for (const [scenario, key] of [['plain', 'agent:main:plain'], ['abort', 'agent:main:abort'], ['main-heartbeat', 'agent:main:main']]) {
      const done = live(store(scenario).path, key)
      await done.stream.start()
      done.stream.stop()
      expect(done.events, scenario).toEqual([])
      expect(done.stream.turnOpen, scenario).toBe(false)
    }
  })

  it('Esc within one poll: the status goes from killed to killed, and the turn still closes', async () => {
    // The `abort` recording: the user row, the assistant's unanswered call, and `killed`, written between two polls.
    const { path, db } = store('abort')
    const window = windowOf(db, 'agent:main:abort')
    const rows = db.prepare(`SELECT seq FROM transcript_events WHERE session_id = '${window}' AND message_role = 'user'`).all()
    const first = Math.min(...rows.map((row) => Number(row.seq)))
    db.exec(`CREATE TABLE later AS SELECT * FROM transcript_events WHERE session_id = '${window}' AND seq >= ${first}`)
    truncate(db, window, first - 1)
    const tail = live(path, 'agent:main:abort')
    await tail.stream.start()
    expect(tail.events).toEqual([])
    db.exec('INSERT INTO transcript_events SELECT * FROM later')
    await vi.waitFor(() => expect(ended(tail.events)).toEqual([{ type: 'turn_ended', payload: { aborted: true } }]))
    tail.stream.stop()
    expect(types(tail.events)[0]).toBe('turn_started')
    // The unanswered call's card ends as interrupted; nothing was failed, so nothing is told.
    expect(tail.events).toContainEqual(expect.objectContaining({ type: 'tool_end', payload: expect.objectContaining({ output: 'Tool interrupted' }) }))
    expect(tail.deps.onFailed).not.toHaveBeenCalled()
    expect(tail.stream.turnOpen).toBe(false)
  })

  it('a turn the read just opened is not closed by the run status it has not updated yet', async () => {
    vi.useFakeTimers()
    try {
      const { path, db } = store('plain')
      const window = windowOf(db, 'agent:main:plain')
      const tail = live(path, 'agent:main:plain')
      tail.deps.pollMs = 1_000
      const stream = new OpenclawLive(tail.deps)
      await stream.start()
      // The user row is read while the key still says the run before it is `done`.
      userRow(db, window, 8, 'next')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(types(tail.events)).toEqual(['turn_started'])
      status(db, 'agent:main:plain', 'running')
      await vi.advanceTimersByTimeAsync(3_000)
      stream.stop()
      expect(types(tail.events)).toEqual(['turn_started'])
    } finally { vi.useRealTimers() }
  })

  it('a run that failed or timed out with no row of its own closes as failed, and the person is told', async () => {
    const { path, db } = store('tool')
    truncate(db, windowOf(db, 'agent:main:tool'), 6)
    status(db, 'agent:main:tool', 'running')
    const tail = live(path, 'agent:main:tool')
    await tail.stream.start()
    status(db, 'agent:main:tool', 'timeout')
    await vi.waitFor(() => expect(ended(tail.events)).toEqual([{ type: 'turn_ended', payload: {} }]))
    tail.stream.stop()
    expect(tail.events).toContainEqual(expect.objectContaining({ type: 'tool_end', payload: expect.objectContaining({ output: 'Tool timed out', isError: true }) }))
    expect(tail.deps.onFailed).toHaveBeenCalledWith('The OpenClaw run timed out.')
  })

  it('a slow run the pane reads idle stays open while the status says `running` and its rows arrive', async () => {
    // A run this TUI did not start (another TUI, the Control UI, a channel message, cron) reads `connected | idle` until
    // its first delta: a model thinking with no deltas looks idle on every pass.
    const { path, db } = store('tool')
    const window = windowOf(db, 'agent:main:tool')
    db.exec(`CREATE TABLE later AS SELECT * FROM transcript_events WHERE session_id = '${window}' AND seq > 6`)
    truncate(db, window, 6)
    status(db, 'agent:main:tool', 'running')
    const tail = live(path, 'agent:main:tool')
    await tail.stream.start()
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    expect(ended(tail.events)).toEqual([])
    // After a reconnect, the run's next row comes between two idle passes: still going.
    tail.stream.paneRead({ ready: false, gatewayLost: true, running: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    db.exec(`INSERT INTO transcript_events SELECT * FROM later WHERE seq = 7`)
    await vi.waitFor(() => expect(tail.events.length).toBeGreaterThan(1))
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    tail.stream.stop()
    expect(ended(tail.events)).toEqual([])
    expect(tail.stream.turnOpen).toBe(true)
  })

  it('a Gateway restart that leaves `running` behind: the turn closes once the pane, after a disconnect, reads idle twice with no row', async () => {
    const { path, db } = store('tool')
    truncate(db, windowOf(db, 'agent:main:tool'), 6)
    status(db, 'agent:main:tool', 'running')
    const tail = live(path, 'agent:main:tool')
    await tail.stream.start()
    tail.stream.paneRead({ ready: false, gatewayLost: true, running: false })
    // An idle pass, then a busy one, then an idle one again: no close.
    tail.stream.paneRead({ ready: true, gatewayLost: true, running: false })
    tail.stream.paneRead({ ready: false, gatewayLost: false, running: true })
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    expect(ended(tail.events)).toEqual([])
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    expect(ended(tail.events)).toEqual([{ type: 'turn_ended', payload: { aborted: true } }])
    expect(tail.stream.turnOpen).toBe(false)
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false, running: false })
    tail.stream.stop()
    expect(ended(tail.events)).toHaveLength(1)
  })

  // The bind pass's captures were most of the +0.6% of a core one bound idle pane cost the daemon (E2E 2026-11-10).
  it('a quiet pane is read again once its store changes, a turn opens, the screen was not idle, or half a minute passed', async () => {
    vi.useFakeTimers()
    try {
      const { path, db } = store('plain')
      const { stream } = live(path, 'agent:main:plain')
      await stream.start()
      expect(stream.paneDue(), 'a pane never read').toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false, running: false })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(stream.paneDue()).toBe(false)
      // A Gateway that dropped or a run going shows on the screen alone: read on every pass until it reads idle again.
      stream.paneRead({ ready: false, gatewayLost: true, running: false })
      expect(stream.paneDue()).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: true, running: false })
      expect(stream.paneDue()).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false, running: false })
      expect(stream.paneDue()).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(stream.paneDue(), 'half a minute').toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false, running: false })
      db.exec("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = 'agent:main:plain'")
      await vi.advanceTimersByTimeAsync(10)
      expect(stream.paneDue(), 'the store changed').toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false, running: false })
      userRow(db, windowOf(db, 'agent:main:plain'), 100, 'next')
      await vi.advanceTimersByTimeAsync(10)
      expect(stream.turnOpen).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false, running: false })
      expect(stream.paneDue(), 'a turn is open').toBe(true)
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  // `openclaw tui --session main` binds `main` before the key has a row (E2E, 2026-11-10): the agent's newest window
  // names the workspace until the key's own header is read, and a store with no window names none.
  it('a key with no rows yet takes the workspace from the agent\'s newest window; its own header replaces it', async () => {
    const { path, db } = store('plain')
    const headers: unknown[] = []
    const stream = new OpenclawLive({ ...live(path, 'agent:main:main').deps, onHeader: (record) => { headers.push(record.cwd) } })
    await stream.start()
    expect(headers).toEqual(['/root/.openclaw/workspace'])
    const window = windowOf(db, 'agent:main:plain')
    db.exec(`PRAGMA foreign_keys = OFF; UPDATE transcript_events SET event_json = replace(event_json, '/root/.openclaw/workspace', '/root/own')
      WHERE session_id = '${window}' AND seq = 0; UPDATE session_nodes SET session_key = 'agent:main:main' WHERE current_session_id = '${window}'`)
    await vi.waitFor(() => expect(headers).toEqual(['/root/.openclaw/workspace', '/root/own']))
    stream.stop()

    db.exec('PRAGMA foreign_keys = OFF; DELETE FROM transcript_events; DELETE FROM session_windows; DELETE FROM session_nodes')
    const none = new OpenclawLive({ ...live(path, 'agent:main:main').deps, onHeader: (record) => { headers.push(record.cwd) } })
    await none.start()
    none.stop()
    expect(headers).toHaveLength(2)
  })

  // A TUI and a Gateway with different state folders (the lamp, 2026-11-11: the Gateway under systemd with its own
  // OPENCLAW_STATE_DIR, the TUI with harnessd's): the store Harness reads never gets the session, and the pane works on.
  describe('a run in progress with no session in the store', () => {
    const RUNNING = { ready: false, gatewayLost: false, running: true }
    const IDLE = { ready: true, gatewayLost: false, running: false }
    const CONNECTING = { ready: false, gatewayLost: false, running: false }
    const streams: OpenclawLive[] = []
    let started = 0
    beforeEach(() => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })
    afterEach(() => {
      for (const stream of streams.splice(0)) stream.stop()
      vi.useRealTimers()
    })

    async function watch(path: string) {
      const onSessionMissing = vi.fn()
      const onSessionFound = vi.fn()
      const stream = new OpenclawLive({ ...live(path, 'agent:main:plain').deps, pollMs: 1_000, onSessionMissing, onSessionFound })
      streams.push(stream)
      await stream.start()
      started = Date.now()
      return { stream, onSessionMissing, onSessionFound }
    }
    /** The clock on to `seconds` after the stream started; the reader polls on the way. */
    const at = (seconds: number) => vi.advanceTimersByTimeAsync(started + seconds * 1_000 - Date.now())

    async function saidOnceAfter30s(path: string): Promise<void> {
      const { stream, onSessionMissing } = await watch(path)
      stream.paneRead(RUNNING)
      await at(29)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).not.toHaveBeenCalled()
      await at(30)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).toHaveBeenCalledOnce()
      await at(35)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).toHaveBeenCalledOnce()
    }

    it('a run in progress for 30 s with no session in the store is said once', () => saidOnceAfter30s(store().path))

    it('a store file that is not there counts as no session', () => saidOnceAfter30s(join(dir, 'missing.sqlite')))

    it('connecting or ready with no session says nothing', async () => {
      // A fresh session reads `ready` before its first message, and `connecting` is no run yet: no node is due.
      const { stream, onSessionMissing } = await watch(store().path)
      for (let seconds = 0; seconds <= 60; seconds += 5) {
        await at(seconds)
        stream.paneRead(seconds % 10 ? CONNECTING : IDLE)
      }
      expect(onSessionMissing).not.toHaveBeenCalled()
    })

    it('a pass that reads no run starts the 30 s again', async () => {
      const { stream, onSessionMissing } = await watch(store().path)
      stream.paneRead(RUNNING)
      await at(20)
      stream.paneRead(IDLE)
      await at(25)
      stream.paneRead(RUNNING)
      await at(50)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).not.toHaveBeenCalled()
      await at(55)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).toHaveBeenCalledOnce()
    })

    it('a Gateway that is only slow writes the session within 30 s', async () => {
      const { path, db } = store()
      const { stream, onSessionMissing } = await watch(path)
      stream.paneRead(RUNNING)
      await at(20)
      stream.paneRead(RUNNING)
      db.exec(fixture('plain'))
      await at(30)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).not.toHaveBeenCalled()
    })

    it('it clears once the store shows the session', async () => {
      const { path, db } = store()
      const { stream, onSessionMissing, onSessionFound } = await watch(path)
      stream.paneRead(RUNNING)
      await at(30)
      stream.paneRead(RUNNING)
      expect(onSessionMissing).toHaveBeenCalledOnce()
      db.exec(fixture('plain'))
      await at(31)
      stream.paneRead(RUNNING)
      expect(onSessionFound).toHaveBeenCalledOnce()
      await at(65)
      stream.paneRead(RUNNING)
      expect(onSessionFound).toHaveBeenCalledOnce()
      expect(onSessionMissing).toHaveBeenCalledOnce()
    })
  })
})
