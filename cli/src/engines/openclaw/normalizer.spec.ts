/**
 * The OpenClaw normalizer on the rows recorded from OpenClaw 2026.11.2 (`__fixtures__/`). The fixtures need a Node
 * whose SQLite has fts5 (22.23 or 24; 23.11 lacks it).
 */
import { readFileSync } from 'node:fs'
import * as zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { builtinSqlite } from '../../lib/sqliteBuiltin.js'
import type { LiveEvent } from '../../lib/normalize.js'
import {
  OpenclawNormalizer,
  lastOpenclawTurnText,
  openclawMessagesToEvents,
  windowOpenclawEvents,
} from './normalizer.js'
import type { OpenclawEvent } from './reader.js'

const FIXTURES = new URL('./__fixtures__/', import.meta.url)
// This Node's types predate zstd.
const { zstdDecompressSync } = zlib as unknown as { zstdDecompressSync(data: Uint8Array): Buffer }

type Row = { seq: number; event_json: string | null; event_zstd: Uint8Array | null }

/** Every row of a key's current window, hidden rows included, decoded as the reader decodes them. */
function fixture(name: string, key?: string): OpenclawEvent[] {
  const Database = builtinSqlite()
  if (!Database) throw new Error('these specs need node:sqlite')
  const db = new Database(':memory:', { readOnly: false })
  try {
    db.exec(readFileSync(new URL('schema.sql', FIXTURES), 'utf8'))
    db.exec(readFileSync(new URL(`${name}.sql`, FIXTURES), 'utf8'))
    const [node] = (key
      ? db.prepare('SELECT current_session_id FROM session_nodes WHERE session_key = ?').all(key)
      : db.prepare('SELECT current_session_id FROM session_nodes ORDER BY created_at LIMIT 1').all()) as Array<{ current_session_id: string }>
    const rows = db.prepare('SELECT seq, event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq')
      .all(node.current_session_id) as Row[]
    return rows.map((row) => ({
      windowId: node.current_session_id,
      seq: row.seq,
      record: JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd!).toString('utf8')) as Record<string, unknown>,
    }))
  } finally {
    db.close()
  }
}

function live(events: OpenclawEvent[]): { normalizer: OpenclawNormalizer; out: LiveEvent[] } {
  const normalizer = new OpenclawNormalizer('live')
  return { normalizer, out: normalizer.push(events) }
}

const types = (events: LiveEvent[]): string[] => events.map((event) => event.type)

function role(event: OpenclawEvent): string {
  const message = event.record.message as { role?: string } | undefined
  return event.record.type === 'message' ? message?.role ?? '' : ''
}

describe('OpenclawNormalizer: turns from the recorded fixtures', () => {
  it('plain: one turn, from the user row to the stop', () => {
    const { normalizer, out } = live(fixture('plain'))
    expect(types(out)).toEqual(['turn_started', 'thinking_delta', 'text_delta', 'turn_ended'])
    expect(out[0]).toEqual({ type: 'turn_started', payload: { userMessage: 'Reply with exactly: hello there' } })
    expect(out[2]).toEqual({ type: 'text_delta', payload: { content: 'hello there' } })
    expect(out[3]).toEqual({ type: 'turn_ended', payload: {} })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('tool: the exec call and its result, joined by the call id', () => {
    const { normalizer, out } = live(fixture('tool'))
    expect(types(out)).toEqual(['turn_started', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'turn_ended'])
    expect(out[2]).toEqual({
      type: 'tool_start',
      payload: { id: 'call_39a0131906834a80b825bf27', tool: 'Bash', input: { command: 'echo probe-ok', title: 'Run echo probe' } },
    })
    expect(out[3]).toEqual({
      type: 'tool_end',
      payload: { id: 'call_39a0131906834a80b825bf27', tool: 'Bash', output: 'probe-ok', isError: false, summary: 'probe-ok' },
    })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('multi-tool: two calls in one row; the turn stays open until both are answered and the model stops', () => {
    const normalizer = new OpenclawNormalizer('live')
    const out: LiveEvent[] = []
    const openAfter: boolean[] = []
    for (const event of fixture('multi-tool')) {
      out.push(...normalizer.push([event]))
      if (role(event) === 'toolResult') openAfter.push(normalizer.turnOpen)
    }
    expect(types(out)).toEqual(['turn_started', 'thinking_delta', 'tool_start', 'tool_start', 'tool_end', 'tool_end', 'text_delta', 'turn_ended'])
    expect(out.filter((e) => e.type === 'tool_end').map((e) => e.type === 'tool_end' && e.payload.output)).toEqual(['alpha', 'beta'])
    expect(openAfter).toEqual([true, true])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('model-switch: every run is its own turn across the model changes, and the failed one closes on its run-failed row', () => {
    const { normalizer, out } = live(fixture('model-switch'))
    expect(types(out)).toEqual([
      'turn_started', 'thinking_delta', 'text_delta', 'turn_ended',
      'turn_started', 'text_delta', 'turn_ended',
      'turn_started', 'thinking_delta', 'text_delta', 'turn_ended',
    ])
    expect(out.filter((e) => e.type === 'turn_started').map((e) => e.type === 'turn_started' && e.payload.userMessage))
      .toEqual(['Reply with exactly: one', 'Reply with exactly: two', 'Reply with exactly: three'])
    expect(out[5]).toMatchObject({ type: 'text_delta', payload: { content: expect.stringContaining('This model was not found') } })
    // A failed run was not interrupted: its failure is the turn's text, and it ends as a turn does.
    expect(out[6]).toEqual({ type: 'turn_ended', payload: {} })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('fail: the error row and the run-failed row close the turn; closeTurn then leaves nothing open', () => {
    const { normalizer, out } = live(fixture('fail'))
    expect(types(out)).toEqual(['turn_started', 'text_delta', 'turn_ended'])
    expect(out[1]).toEqual({
      type: 'text_delta',
      payload: { content: "Your request couldn't be completed: ⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`." },
    })
    expect(out[2]).toEqual({ type: 'turn_ended', payload: {} })
    expect(normalizer.closeTurn('failed')).toEqual([])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('abort: Esc leaves the call unanswered; closeTurn ends the card and the turn, and nothing is left open', () => {
    const { normalizer, out } = live(fixture('abort'))
    expect(types(out)).toEqual(['turn_started', 'thinking_delta', 'tool_start'])
    expect(normalizer.turnOpen).toBe(true)
    expect(normalizer.closeTurn('aborted')).toEqual([
      { type: 'tool_end', payload: { id: 'call_2bd16342000645babeda8cba', tool: 'Bash', output: 'Tool interrupted', isError: false, summary: 'Bash interrupted' } },
      { type: 'turn_ended', payload: { aborted: true } },
    ])
    expect(normalizer.turnOpen).toBe(false)
    expect(normalizer.closeTurn('aborted')).toEqual([])
  })

  it('a timeout ends an unanswered card as an error', () => {
    const { normalizer } = live(fixture('abort'))
    const closed = normalizer.closeTurn('timeout')
    expect(closed[0]).toMatchObject({ type: 'tool_end', payload: { output: 'Tool timed out', isError: true } })
    expect(closed.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('main-heartbeat: the heartbeat run gives no events at all', () => {
    const events = fixture('main-heartbeat')
    const poll = events.findIndex((event) => role(event) === 'user' && (event.record.message as { content?: unknown }).content === '[OpenClaw heartbeat poll]')
    expect(poll).toBeGreaterThan(0)

    const before = live(events.slice(0, poll))
    expect(before.normalizer.push(events.slice(poll))).toEqual([])
    expect(before.normalizer.turnOpen).toBe(false)

    const { normalizer, out } = live(events)
    expect(out).toEqual(before.out)
    expect(types(out).filter((type) => type === 'turn_started')).toHaveLength(1)
    expect(normalizer.turnOpen).toBe(false)
  })

  it('a message after a heartbeat opens its own turn', () => {
    const { out } = live(fixture('two-panes-main'))
    expect(out.filter((e) => e.type === 'turn_started').map((e) => e.type === 'turn_started' && e.payload.userMessage)).toEqual([
      'Run the shell command ls -la in the current directory and tell me how many files there are.',
      'Reply with exactly: both panes',
    ])
    expect(JSON.stringify(out)).not.toContain('NO_REPLY')
    expect(JSON.stringify(out)).not.toContain('heartbeat_respond')
  })

  it('hidden rows never become turns', () => {
    const scenarios = ['plain', 'tool', 'multi-tool', 'abort', 'fail', 'model-switch', 'reset', 'rewind', 'approval', 'main-heartbeat']
    const hidden = scenarios.flatMap((name) => fixture(name)).filter((event) =>
      event.record.type !== 'message' && event.record.customType !== 'run-failed-before-reply')
    // Each kind the fixtures hold: the header, thinking level, custom rows, runtime context, reset and leaf.
    expect(new Set(hidden.map((event) => `${String(event.record.type)}:${String(event.record.customType ?? '')}`))).toEqual(new Set([
      'session:', 'thinking_level_change:', 'reset:', 'leaf:',
      'custom:model-snapshot', 'custom:openclaw.system-prompt', 'custom:openclaw.cache-ttl', 'custom:openclaw:bootstrap-context:full',
      'custom_message:openclaw.runtime-context',
    ]))
    const { normalizer, out } = live(hidden)
    expect(out).toEqual([])
    expect(normalizer.turnOpen).toBe(false)
  })

  it('reset: the reset row ends nothing and starts nothing; the turns on both sides are whole', () => {
    const { out } = live(fixture('reset', 'agent:main:reset'))
    expect(types(out).filter((type) => type.startsWith('turn_'))).toEqual(['turn_started', 'turn_ended', 'turn_started', 'turn_ended'])
  })

  it('two user messages before an answer make one turn', () => {
    const [header, user, ...rest] = fixture('plain')
    const again: OpenclawEvent = {
      ...user,
      seq: user.seq + 0.5,
      record: { ...user.record, id: 'second', message: { ...(user.record.message as object), content: 'and say it twice' } },
    }
    const { normalizer, out } = live([header, user, again, ...rest])
    expect(types(out)).toEqual(['turn_started', 'user_message', 'thinking_delta', 'text_delta', 'turn_ended'])
    expect(out[1]).toEqual({ type: 'user_message', payload: { content: 'and say it twice' } })
    expect(normalizer.turnOpen).toBe(false)
  })

  it('a new run after an unanswered call closes the old turn first', () => {
    const { out } = live([...fixture('abort'), ...fixture('plain')])
    expect(types(out)).toEqual([
      'turn_started', 'thinking_delta', 'tool_start', 'tool_end', 'turn_ended',
      'turn_started', 'thinking_delta', 'text_delta', 'turn_ended',
    ])
    expect(out[3]).toMatchObject({ type: 'tool_end', payload: { output: 'Tool interrupted', isError: false } })
    expect(out[4]).toEqual({ type: 'turn_ended', payload: { aborted: true } })
  })
})

describe('OpenClaw history', () => {
  it('replays a session as messages, with no turn markers', () => {
    expect(types(openclawMessagesToEvents(fixture('tool')))).toEqual(['user_message', 'thinking_delta', 'tool_start', 'tool_end', 'text_delta', 'done'])
  })

  it('leaves the heartbeat run out of the history and of the last turn', () => {
    const events = fixture('main-heartbeat')
    const history = openclawMessagesToEvents(events)
    expect(types(history).filter((type) => type === 'user_message')).toHaveLength(1)
    expect(JSON.stringify(history)).not.toContain('NO_REPLY')
    expect(lastOpenclawTurnText(events)).toEqual({
      userMessage: 'Run the shell command ls -la in the current directory and tell me how many files there are.',
      assistantText: expect.stringContaining('ls -la'),
    })
  })

  it('reads the last turn after a reset', () => {
    expect(lastOpenclawTurnText(fixture('reset', 'agent:main:reset'))).toEqual({ userMessage: 'Reply with exactly: after', assistantText: 'after' })
  })

  it('has no last turn before the model answered', () => {
    expect(lastOpenclawTurnText(fixture('abort'))).toBeNull()
    expect(lastOpenclawTurnText(fixture('reset', 'agent:main:tui-652cc362-2631-416e-bf1c-6ac369311a20'))).toBeNull()
  })

  it('windows the history back to a user row, so a window never starts mid-turn', () => {
    const events = fixture('model-switch')
    const { window, hasMore, oldestCursor } = windowOpenclawEvents(events, { limit: 3 })
    expect(role(window[0])).toBe('user')
    expect(window.at(-1)).toBe(events.at(-1))
    expect((window[0].record.message as { content: string }).content).toBe('Reply with exactly: three')
    expect(hasMore).toBe(true)
    const older = windowOpenclawEvents(events, { limit: 3, before: oldestCursor! })
    expect(older.window.at(-1)).toBe(events[events.indexOf(window[0]) - 1])
    expect(windowOpenclawEvents(events, { limit: 1000 })).toEqual({ window: events, hasMore: false, oldestCursor: 'openclaw:0' })
    expect(windowOpenclawEvents(events, { limit: 3, before: 'opencode:2' })).toMatchObject({ window: [], staleCursor: true })
  })
})
