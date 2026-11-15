import { expect, it } from 'vitest'
import { checkedHistory, EngineReadError, historyEvent, lastTurnAnswer, readerEngine, record } from './protocol.js'

const events: Array<{ type: string; payload: Record<string, unknown> }> = [
  { type: 'user_message', payload: { content: 'hello', images: [{ media_type: 'image/png', data: 'data' }] } },
  { type: 'thinking_delta', payload: { content: 'thinking', thinkingId: 'id' } },
  { type: 'thinking_title', payload: { title: 'title', thinkingId: 'id' } },
  { type: 'text_delta', payload: { content: 'answer' } },
  { type: 'tool_start', payload: { id: 'id', tool: 'Read', input: {}, parentToolUseId: 'parent' } },
  { type: 'tool_end', payload: { id: 'id', tool: 'Read', output: 'output', summary: 'summary', isError: false,
    parentToolUseId: 'parent', subagent: { agentId: 'id', agentType: 'type', totalTokens: 1, totalDurationMs: 2, totalToolUseCount: 3 }, durationSeconds: 2 } },
  { type: 'context_compact', payload: { message: 'compacted', trigger: 'auto' } },
  { type: 'done', payload: { result: 'done' } },
]

it('accepts replay events, including absent optional fields, and rejects malformed fields', () => {
  const optional = new Set(['images', 'thinkingId', 'parentToolUseId', 'subagent', 'durationSeconds', 'trigger'])
  for (const event of events) {
    expect(historyEvent(event), event.type).toBe(true)
    for (const key of Object.keys(event.payload)) {
      if (key === 'input') continue // An engine's tool input is intentionally unknown.
      expect(historyEvent({ ...event, payload: { ...event.payload, [key]: null } }), `${event.type}.${key}`).toBe(false)
      if (optional.has(key)) expect(historyEvent({ ...event, payload: { ...event.payload, [key]: undefined } })).toBe(true)
    }
  }
  for (const images of [[null], [{ media_type: null, data: '' }], [{ media_type: '', data: false }]]) {
    expect(historyEvent({ type: 'user_message', payload: { content: '', images } })).toBe(false)
  }
  const tool = events[5]
  for (const field of ['agentId', 'agentType', 'totalTokens', 'totalDurationMs', 'totalToolUseCount']) {
    expect(historyEvent({ ...tool, payload: { ...tool.payload, subagent: { [field]: null } } })).toBe(false)
  }
  expect(historyEvent({ ...tool, payload: { ...tool.payload, subagent: {} } })).toBe(true)
  expect(historyEvent({ ...tool, payload: { ...tool.payload, durationSeconds: Infinity } })).toBe(false)
  for (const invalid of [null, [], {}, { type: 'done', payload: [] }, { type: 'turn_ended', payload: {} }]) expect(historyEvent(invalid)).toBe(false)
})

it('validates the envelope, cursor fields and last-turn text without accepting live state', () => {
  const valid = { timestamp: '2026-10-07T00:00:00Z', events: [], hasMore: false, oldestCursor: 'cursor', staleCursor: true }
  expect(checkedHistory(valid)).toEqual({ answer: valid, dropped: 0 })
  expect(checkedHistory({ ...valid, oldestCursor: null, truncated: true })).toEqual({ answer: { ...valid, oldestCursor: null, truncated: true }, dropped: 0 })
  for (const invalid of [null, {}, { ...valid, timestamp: 1 }, { ...valid, timestamp: 'invalid' }, { ...valid, events: {} },
    { ...valid, id: 'override-core-identity' }, { ...valid, engine: 'override' }, { ...valid, hasMore: 'yes' }, { ...valid, oldestCursor: 1 },
    { ...valid, staleCursor: false }, { ...valid, truncated: false }]) expect(checkedHistory(invalid)).toBeNull()
  // An event it cannot check is left out and counted; the rest of the page is kept, live turn changes never.
  const kept = events[3], odd = { type: 'tool_end', payload: { id: 'id', tool: 'Read', output: 7, summary: '', isError: false } }
  expect(checkedHistory({ ...valid, events: [odd, kept, { type: 'turn_started', payload: { userMessage: 'live' } }] }))
    .toEqual({ answer: { ...valid, events: [kept] }, dropped: 2 })
  expect(lastTurnAnswer(null)).toBe(true)
  expect(lastTurnAnswer({ userMessage: '', assistantText: '' })).toBe(true)
  for (const invalid of [[], undefined, {}, { userMessage: '', assistantText: '', state: 'working' }, { userMessage: '' }, { userMessage: false, assistantText: '' }]) expect(lastTurnAnswer(invalid)).toBe(false)
  for (const name of ['claude', 'codex']) expect(readerEngine(name)).toBe(true)
  for (const name of ['', 'constructor', '__proto__', 'pi']) expect(readerEngine(name)).toBe(false)
  expect(record([])).toBe(false)
  for (const code of ['ENGINE_INVALID_REQUEST', 'ENGINE_REPLY_TOO_LARGE'] as const) expect(new EngineReadError(code).retryable).toBe(false)
  expect(new EngineReadError('ENGINE_BUSY').retryable).toBe(true)
})
