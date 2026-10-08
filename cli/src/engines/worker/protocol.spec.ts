import { expect, it } from 'vitest'
import { EngineReadError, historyAnswer, lastTurnAnswer, readerEngine, record } from './protocol.js'

const page = (event: unknown) => ({ timestamp: '2026-10-07T00:00:00Z', events: [event] })
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
    expect(historyAnswer(page(event)), event.type).toBe(true)
    for (const key of Object.keys(event.payload)) {
      if (key === 'input') continue // An engine's tool input is intentionally unknown.
      expect(historyAnswer(page({ ...event, payload: { ...event.payload, [key]: null } })), `${event.type}.${key}`).toBe(false)
      if (optional.has(key)) expect(historyAnswer(page({ ...event, payload: { ...event.payload, [key]: undefined } }))).toBe(true)
    }
  }
  for (const images of [[null], [{ media_type: null, data: '' }], [{ media_type: '', data: false }]]) {
    expect(historyAnswer(page({ type: 'user_message', payload: { content: '', images } }))).toBe(false)
  }
  const tool = events[5]
  for (const field of ['agentId', 'agentType', 'totalTokens', 'totalDurationMs', 'totalToolUseCount']) {
    expect(historyAnswer(page({ ...tool, payload: { ...tool.payload, subagent: { [field]: null } } }))).toBe(false)
  }
  expect(historyAnswer(page({ ...tool, payload: { ...tool.payload, subagent: {} } }))).toBe(true)
  expect(historyAnswer(page({ ...tool, payload: { ...tool.payload, durationSeconds: Infinity } }))).toBe(false)
  for (const invalid of [null, [], {}, { type: 'done', payload: [] }, { type: 'turn_ended', payload: {} }]) expect(historyAnswer(page(invalid))).toBe(false)
})

it('validates the envelope, cursor fields and last-turn text without accepting live state', () => {
  const valid = { timestamp: '2026-10-07T00:00:00Z', events: [], hasMore: false, oldestCursor: 'cursor', staleCursor: true }
  expect(historyAnswer(valid)).toBe(true)
  expect(historyAnswer({ ...valid, oldestCursor: null })).toBe(true)
  for (const invalid of [null, {}, { ...valid, timestamp: 1 }, { ...valid, timestamp: 'invalid' }, { ...valid, events: {} },
    { ...valid, id: 'override-core-identity' }, { ...valid, engine: 'override' }, { ...valid, hasMore: 'yes' }, { ...valid, oldestCursor: 1 }, { ...valid, staleCursor: false }]) expect(historyAnswer(invalid)).toBe(false)
  expect(lastTurnAnswer(null)).toBe(true)
  expect(lastTurnAnswer({ userMessage: '', assistantText: '' })).toBe(true)
  for (const invalid of [[], undefined, {}, { userMessage: '', assistantText: '', state: 'working' }, { userMessage: '' }, { userMessage: false, assistantText: '' }]) expect(lastTurnAnswer(invalid)).toBe(false)
  for (const name of ['claude', 'codex']) expect(readerEngine(name)).toBe(true)
  for (const name of ['', 'constructor', '__proto__', 'pi']) expect(readerEngine(name)).toBe(false)
  expect(record([])).toBe(false)
  for (const code of ['ENGINE_INVALID_REQUEST', 'ENGINE_REPLY_TOO_LARGE'] as const) expect(new EngineReadError(code).retryable).toBe(false)
  expect(new EngineReadError('ENGINE_BUSY').retryable).toBe(true)
})
