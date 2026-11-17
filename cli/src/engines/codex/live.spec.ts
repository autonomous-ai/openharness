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

  // Codex runs its Stop and waits for it before it writes the end, and an errored or prompt-hook-stopped
  // turn ends the same with no Stop: the core must never hold a Codex end for one (facts-codex §5).
  it('every turn end is marked over: finished, errored, aborted, or closed by the next prompt', () => {
    const parser = live.create({ engine: 'codex', codexHome: undefined })
    const opened = parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'go' }))
    expect(opened.over).toBeUndefined()
    expect(parser.ingest(line('2026-11-17T01:02:04.000Z', { type: 'agent_message', message: 'done' })).over).toBeUndefined()
    const finished = parser.ingest(line('2026-11-17T01:02:05.000Z', { type: 'task_complete', turn_id: 't1', last_agent_message: null }))
    expect(finished.events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(finished.over).toBe(true)

    parser.ingest(line('2026-11-17T01:02:06.000Z', { type: 'user_message', message: 'fail' }))
    const errored = parser.ingest(line('2026-11-17T01:02:07.000Z', { type: 'task_complete', turn_id: 't2', error: { message: 'usage limit' } }))
    expect(errored.events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(errored.over).toBe(true)

    parser.ingest(line('2026-11-17T01:02:08.000Z', { type: 'user_message', message: 'stop me' }))
    const aborted = parser.ingest(line('2026-11-17T01:02:09.000Z', { type: 'turn_aborted', reason: 'interrupted' }))
    expect(aborted.events.at(-1)).toEqual({ type: 'turn_ended', payload: { aborted: true } })
    expect(aborted.over).toBe(true)

    parser.ingest(line('2026-11-17T01:02:10.000Z', { type: 'user_message', message: 'left open' }))
    const next = parser.ingest(line('2026-11-17T01:02:11.000Z', { type: 'user_message', message: 'next' }))
    expect(next.events.map((event) => event.type)).toEqual(['turn_ended', 'turn_started'])
    expect(next.over).toBe(true)
  })

  it.each(['replaced', 'review_ended', 'budget_limited'])('a turn Codex ended for %s is a plain end, marked over', (reason) => {
    const parser = live.create({ engine: 'codex', codexHome: undefined })
    parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'user_message', message: 'go' }))
    const ended = parser.ingest(line('2026-11-17T01:02:04.000Z', { type: 'turn_aborted', reason }))
    expect(ended.events.at(-1)).toEqual({ type: 'turn_ended', payload: {} })
    expect(ended.over).toBe(true)
  })

  it('an end read with no turn open ends nothing and is not marked', () => {
    const parser = live.create({ engine: 'codex', codexHome: undefined })
    const stray = parser.ingest(line('2026-11-17T01:02:03.000Z', { type: 'task_complete', turn_id: 't0', last_agent_message: null }))
    expect(stray.events).toEqual([])
    expect(stray.over).toBeUndefined()
  })
})
