import { describe, expect, it } from 'vitest'
import { live } from './live.js'

const at = (record: object, timestamp?: string) => JSON.stringify({ ...record, ...(timestamp === undefined ? {} : { timestamp }) })
const prompt = (text: string) => ({ type: 'user', message: { role: 'user', content: text } })
const answer = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }
const continuation = { type: 'attachment', attachment: { type: 'goal_status', met: false, condition: 'finish' } }
const duration = { type: 'system', subtype: 'turn_duration', durationMs: 1 }
const time = (iso: string) => Date.parse(iso)

describe('the Claude Code live parser', () => {
  // The core's turn rules compare a read with the hooks' own times (core/turns/turnHooks.ts).
  it('a read says when its record was written', () => {
    const parser = live.create({ engine: 'claude' })
    expect(parser.ingest(at(prompt('go'), '2026-11-17T01:02:03.000Z')).at).toBe(time('2026-11-17T01:02:03.000Z'))
    expect(parser.ingest(at(answer)).at).toBeUndefined()
    expect(parser.ingest(at(answer, 'soon')).at).toBeUndefined()
    expect(parser.ingest('not json').at).toBeUndefined()
  })

  // A paused `/goal` pass ends with `turn_duration` and no Stop follows it: the core must not hold that end for one.
  it('turn_duration on a continued pass ends the turn and is marked over; an end_turn is not', () => {
    const parser = live.create({ engine: 'claude' })
    parser.ingest(at(prompt('go')))
    const ended = parser.ingest(at(answer))
    expect(ended.events).toContainEqual({ type: 'turn_ended', payload: {} })
    expect(ended.over).toBeUndefined()
    expect(parser.ingest(at(duration)).over).toBeUndefined()
    parser.ingest(at(continuation))
    const over = parser.ingest(at(duration))
    expect(over.events).toEqual([{ type: 'turn_ended', payload: {} }])
    expect(over.over).toBe(true)
    expect(parser.ingest(at(prompt('next'))).over).toBeUndefined()
  })

  it('a turn\'s opening time is still its opening record\'s', () => {
    const parser = live.create({ engine: 'claude' })
    parser.ingest(at(prompt('go'), '2026-11-17T01:00:00.000Z'))
    parser.ingest(at(answer, '2026-11-17T01:00:05.000Z'))
    expect(parser.snapshot().openedAt).toBe(time('2026-11-17T01:00:00.000Z'))
    parser.ingest(at(prompt('next')))
    expect(parser.snapshot().openedAt).toBeUndefined()
  })
})
