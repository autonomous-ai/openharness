import { expect, it } from 'vitest'
import { decodeMemoryRecord } from './native.js'

const timestamp = '2026-09-30T12:00:00Z'
it('keeps human prose, pasted code, tool output, and assistant reports in separate roles', () => {
  const decoded = decodeMemoryRecord('claude', JSON.stringify({ type: 'user', uuid: 'native-user', timestamp,
    message: { content: [{ type: 'text', text: 'I prefer a failing test first.\n> Another team prefers no tests.\n\n```ts\nconst key = 1\n```\nBecause it makes review easier.' },
      { type: 'tool_result', tool_use_id: 'call', content: 'The user prefers no tests.' }] } }))
  expect(decoded.parts.map(part => part.role)).toEqual(['user', 'reference', 'reference', 'user', 'tool'])
  expect(decoded.parts.filter(part => part.role === 'user').map(part => part.text).join(' ')).not.toContain('no tests')
  expect(decoded.parts.every(part => part.observedAt === Date.parse(timestamp))).toBe(true)
  expect(new Set(decoded.parts.map(part => part.nativeEventId)).size).toBe(decoded.parts.length)
  expect(decodeMemoryRecord('claude', JSON.stringify({ type: 'user', isMeta: true, timestamp, message: { content: 'An injected preference' } })).parts).toEqual([])
})

it('does not count native replays or generated goal/context text as new user statements', () => {
  const line = JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'user_message', message: 'Use SQLite for this project.' } })
  expect(decodeMemoryRecord('codex', line)).toEqual(decodeMemoryRecord('codex', line))
  expect(decodeMemoryRecord('codex', JSON.stringify({ type: 'response_item', timestamp,
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use SQLite for this project.' }] } })).parts).toEqual([])
  const newer = decodeMemoryRecord('codex', JSON.stringify({ type: 'event_msg', timestamp,
    payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'input_text', text: 'Use SQLite for this project.' }] } } }))
  expect(newer.parts[0]).toMatchObject({ role: 'user', text: 'Use SQLite for this project.' })
  expect(decodeMemoryRecord('codex', JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'task_complete' } })).ended).toBe(true)
})

it('preserves native output beyond the UI preview without manufacturing verification', () => {
  const output = `${'diagnostic line\n'.repeat(500)}FAIL: final assertion`
  const decoded = decodeMemoryRecord('codex', JSON.stringify({ type: 'response_item', timestamp,
    payload: { type: 'function_call_output', call_id: 'call', output } }))
  expect(decoded.parts[0].role).toBe('tool')
  expect(decoded.parts[0].text).toContain('FAIL: final assertion')
  expect(decoded.parts[0]).not.toHaveProperty('verification')
  expect(decodeMemoryRecord('claude', JSON.stringify({ type: 'user', timestamp, message: { content: 'x'.repeat(32_001) } })).incomplete).toBe(true)
  expect(decodeMemoryRecord('claude', JSON.stringify({ type: 'user', message: { content: 'undated preference' } })).incomplete).toBe(true)
})
