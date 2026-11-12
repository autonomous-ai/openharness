import { describe, expect, it } from 'vitest'
import { createToolWatches, TOOL_WATCH_MAX_AGENTS, TOOL_WATCHES_MAX } from './toolWatches.js'

function setup() {
  const sent: Array<{ connId: string; frame: Record<string, unknown> }> = []
  let open = true
  const watches = createToolWatches({ sendTo: (connId, frame) => { sent.push({ connId, frame }); return open } })
  return { watches, sent, close: () => { open = false } }
}

const activity = (agentId: string, state: string, type = 'agent_activity') =>
  ({ type, agentId, dbSessionId: `s-${agentId}`, payload: { agentId, sessionId: `s-${agentId}`, activity: { state, epoch: 'e', revision: 1, validForMs: 0 } } })

describe('a tool\'s watch on the harnesses it named', () => {
  it('gets the state events of the harnesses it named, and nothing of any other', () => {
    const { watches, sent } = setup()
    expect(watches.watch('local:t', true, ['a', 'b'])).toEqual({ ok: true })
    watches.tell(activity('a', 'idle'))
    watches.tell(activity('other', 'idle'))
    watches.tell({ type: 'turn_ended', agentId: 'b', payload: { agentId: 'b', activity: { state: 'idle' }, outputTail: 'secret' } })
    watches.tell({ type: 'commander_question', agentId: 'a', payload: { requestId: 'q1', questions: [{ q: 'Delete it?' }] } })
    watches.tell({ type: 'commander_question_close', agentId: 'a', payload: { requestId: 'q1' } })
    watches.tell({ type: 'agent_deleted', payload: { agentId: 'b', retained: false } })
    expect(sent).toEqual([
      { connId: 'local:t', frame: { type: 'agent_activity', agentId: 'a', payload: { agentId: 'a', state: 'idle' } } },
      { connId: 'local:t', frame: { type: 'turn_ended', agentId: 'b', payload: { agentId: 'b', state: 'idle' } } },
      { connId: 'local:t', frame: { type: 'commander_question', agentId: 'a', payload: { agentId: 'a', requestId: 'q1' } } },
      { connId: 'local:t', frame: { type: 'commander_question_close', agentId: 'a', payload: { agentId: 'a', requestId: 'q1' } } },
      { connId: 'local:t', frame: { type: 'agent_deleted', agentId: 'b', payload: { agentId: 'b' } } },
    ])
  })

  it('never gets a harness\'s words: no text, tool output or anything else a window streams', () => {
    const { watches, sent } = setup()
    watches.watch('local:t', true, ['a'])
    for (const type of ['text_delta', 'tool_start', 'tool_end', 'thinking_delta', 'agent_synced', 'turn_started', 'error']) {
      watches.tell({ type, agentId: 'a', payload: { agentId: 'a', content: 'PRIVATE' } })
    }
    expect(sent).toEqual([])
  })

  it('hears a harness start working from its heartbeat, once a change, as an agent_activity', () => {
    const { watches, sent } = setup()
    watches.watch('local:t', true, ['a'])
    // A working harness beats every 5 s as turn_heartbeat alone (core/turns/heartbeats.ts): one change, one frame.
    for (let i = 0; i < 5; i++) watches.tell(activity('a', 'working', 'turn_heartbeat'))
    watches.tell(activity('a', 'unknown'))
    watches.tell(activity('a', 'unknown'))
    watches.tell(activity('a', 'working', 'turn_heartbeat'))
    // A turn's end says idle itself: the agent_activity after it, idle too, is not news.
    watches.tell({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a', activity: { state: 'idle' } } })
    watches.tell(activity('a', 'idle'))
    // Without a reading, a turn's end is idle.
    watches.tell({ type: 'turn_ended', agentId: 'a', payload: { agentId: 'a' } })
    watches.tell({ type: 'turn_heartbeat', agentId: 'a', payload: { agentId: 'a' } })
    expect(sent.map((s) => `${String(s.frame.type)}:${String((s.frame.payload as { state?: string }).state)}`))
      .toEqual(['agent_activity:working', 'agent_activity:unknown', 'agent_activity:working', 'turn_ended:idle', 'turn_ended:idle'])
  })

  it('hears a question and its close once, though the daemon sends each down several paths', () => {
    const { watches, sent } = setup()
    watches.watch('local:t', true, ['a'])
    const asked = { type: 'commander_question', agentId: 'a', payload: { requestId: 'q1' } }
    watches.tell(asked); watches.tell(asked)
    watches.tell({ type: 'commander_question', agentId: 'a', payload: { requestId: 'q2' } })
    watches.tell({ type: 'commander_question_close', agentId: 'a', payload: { requestId: 'q2' } })
    watches.tell({ type: 'commander_question_close', agentId: 'a', payload: { requestId: 'q2' } })
    watches.tell({ type: 'agent_deleted', payload: { agentId: 'a' } })
    watches.tell({ type: 'agent_deleted', payload: { agentId: 'a' } })
    expect(sent.map((s) => [s.frame.type, (s.frame.payload as { requestId?: string }).requestId]))
      .toEqual([['commander_question', 'q1'], ['commander_question', 'q2'], ['commander_question_close', 'q2'], ['agent_deleted', undefined]])
  })

  it('is for tools: a window already gets every event, and is refused', () => {
    const { watches, sent } = setup()
    expect(watches.watch('local:w', false, ['a'])).toMatchObject({ error: 'UNSUPPORTED' })
    watches.tell(activity('a', 'idle'))
    expect(sent).toEqual([])
  })

  it('is bounded: names, how many, one a connection, and each connection\'s ends with it', () => {
    const { watches, sent } = setup()
    expect(watches.watch('local:t', true, 'a')).toMatchObject({ error: 'BAD_REQUEST' })
    expect(watches.watch('local:t', true, ['a', 7])).toMatchObject({ error: 'BAD_REQUEST' })
    expect(watches.watch('local:t', true, ['a', ''])).toMatchObject({ error: 'BAD_REQUEST' })
    expect(watches.watch('local:t', true, ['x'.repeat(129)])).toMatchObject({ error: 'BAD_REQUEST' })
    const many = Array.from({ length: TOOL_WATCH_MAX_AGENTS + 1 }, (_, i) => `h${i}`)
    expect(watches.watch('local:t', true, many)).toMatchObject({ error: 'TOO_MANY' })
    // The same name twice is one.
    expect(watches.watch('local:t', true, [...many.slice(0, TOOL_WATCH_MAX_AGENTS), 'h0'])).toEqual({ ok: true })
    // Asked again, the new names replace the old.
    expect(watches.watch('local:t', true, ['b'])).toEqual({ ok: true })
    watches.tell(activity('h0', 'idle'))
    watches.tell(activity('b', 'idle'))
    expect(sent.map((s) => s.frame.agentId)).toEqual(['b'])
    // None: no watch at all.
    expect(watches.watch('local:t', true, [])).toEqual({ ok: true })
    watches.tell(activity('b', 'working'))
    expect(sent).toHaveLength(1)
    for (let i = 0; i < TOOL_WATCHES_MAX; i++) expect(watches.watch(`local:${i}`, true, ['a'])).toEqual({ ok: true })
    expect(watches.watch('local:more', true, ['a'])).toMatchObject({ error: 'TOO_MANY' })
    // One already watching may change what it watches at the bound.
    expect(watches.watch('local:0', true, ['b'])).toEqual({ ok: true })
    watches.closed('local:1')
    expect(watches.watch('local:more', true, ['a'])).toEqual({ ok: true })
  })

  it('forgets a connection that closed, or that a frame could not reach', () => {
    const { watches, sent, close } = setup()
    watches.watch('local:t', true, ['a'])
    watches.watch('local:u', true, ['a'])
    watches.closed('local:u')
    watches.closed('local:never')
    close()
    watches.tell(activity('a', 'idle'))
    watches.tell(activity('a', 'working', 'turn_heartbeat'))
    expect(sent.map((s) => s.connId)).toEqual(['local:t'])
  })

  it('says whether a tool follows a harness, so the daemon looks for its question (core/questions.ts)', () => {
    const { watches } = setup()
    expect(watches.follows('a')).toBe(false)
    watches.watch('local:t', true, ['a'])
    expect(watches.follows('a')).toBe(true)
    expect(watches.follows('b')).toBe(false)
    watches.closed('local:t')
    expect(watches.follows('a')).toBe(false)
  })

  it('takes no frame that names no harness', () => {
    const { watches, sent } = setup()
    watches.watch('local:t', true, ['a'])
    watches.tell({ type: 'agent_deleted', payload: {} })
    watches.tell({ type: 'turn_ended' })
    expect(sent).toEqual([])
  })
})
