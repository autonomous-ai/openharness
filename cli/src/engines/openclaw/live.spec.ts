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

function store(scenario: string): { path: string; db: DatabaseLike } {
  const path = join(dir, `${scenario}.sqlite`)
  const db = new (builtinSqlite()!)(path, { readOnly: false })
  open.push(db)
  db.exec(fixture('schema'))
  db.exec(fixture(scenario))
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
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    expect(ended(tail.events)).toEqual([])
    // After a reconnect, the run's next row comes between two idle passes: still going.
    tail.stream.paneRead({ ready: false, gatewayLost: true })
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    db.exec(`INSERT INTO transcript_events SELECT * FROM later WHERE seq = 7`)
    await vi.waitFor(() => expect(tail.events.length).toBeGreaterThan(1))
    tail.stream.paneRead({ ready: true, gatewayLost: false })
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
    tail.stream.paneRead({ ready: false, gatewayLost: true })
    // An idle pass, then a busy one, then an idle one again: no close.
    tail.stream.paneRead({ ready: true, gatewayLost: true })
    tail.stream.paneRead({ ready: false, gatewayLost: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    expect(ended(tail.events)).toEqual([])
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    expect(ended(tail.events)).toEqual([{ type: 'turn_ended', payload: { aborted: true } }])
    expect(tail.stream.turnOpen).toBe(false)
    tail.stream.paneRead({ ready: true, gatewayLost: false })
    tail.stream.paneRead({ ready: true, gatewayLost: false })
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
      stream.paneRead({ ready: true, gatewayLost: false })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(stream.paneDue()).toBe(false)
      // A Gateway that dropped or a run going shows on the screen alone: read on every pass until it reads idle again.
      stream.paneRead({ ready: false, gatewayLost: true })
      expect(stream.paneDue()).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: true })
      expect(stream.paneDue()).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false })
      expect(stream.paneDue()).toBe(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(stream.paneDue(), 'half a minute').toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false })
      db.exec("UPDATE session_nodes SET updated_at = updated_at + 1 WHERE session_key = 'agent:main:plain'")
      await vi.advanceTimersByTimeAsync(10)
      expect(stream.paneDue(), 'the store changed').toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false })
      userRow(db, windowOf(db, 'agent:main:plain'), 100, 'next')
      await vi.advanceTimersByTimeAsync(10)
      expect(stream.turnOpen).toBe(true)
      stream.paneRead({ ready: true, gatewayLost: false })
      expect(stream.paneDue(), 'a turn is open').toBe(true)
      stream.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
