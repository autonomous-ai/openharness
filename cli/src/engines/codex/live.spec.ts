import { describe, expect, it } from 'vitest'
import { live } from './live.js'

const line = (timestamp: string | undefined, payload: object) => JSON.stringify({ ...(timestamp ? { timestamp } : {}), type: 'event_msg', payload })
const time = (iso: string) => Date.parse(iso)

describe('the Codex live parser', () => {
  // A Stop or Interrupt Codex ran before the next turn's opening record is about the turn before it (kit/stopHook.ts).
  it('a read says when its record was written, and a turn when it opened', () => {
    const parser = live.create({ engine: 'codex', codexHome: undefined })
    expect(parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'go' })).at).toBe(time('2026-11-17T01:02:03.000Z'))
    expect(parser.snapshot().openedAt).toBe(time('2026-11-17T01:02:03.000Z'))
    expect(parser.ingest(line('2026-11-17T01:02:09.000Z', { type: 'agent_message', message: 'working' })).at).toBe(time('2026-11-17T01:02:09.000Z'))
    expect(parser.snapshot().openedAt).toBe(time('2026-11-17T01:02:03.000Z'))
  })

  it('a record with no timestamp says none, and the turn it opens has no opening time', () => {
    const parser = live.create({ engine: 'codex', codexHome: undefined })
    parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'one' }))
    expect(parser.ingest(line(undefined, { type: 'user_message', message: 'two' })).at).toBeUndefined()
    expect(parser.snapshot().openedAt).toBeUndefined()
    expect(parser.ingest(line('soon', { type: 'agent_message', message: 'x' })).at).toBeUndefined()
    expect(parser.ingest('not json').at).toBeUndefined()
  })
})
