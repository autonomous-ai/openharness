import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { newFold } from '../testing/transcriptOracle.js'
import { liveFor } from './live.js'
import { engineFor } from './registry.js'

const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
const continuation = JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', met: false, condition: 'finish' } })

describe('the live engine facet', () => {
  it.each(['claude', 'codex'] as const)('%s preserves every recorded live event and turn state', (engine) => {
    const fixture = engine === 'claude' ? '../lib/__fixtures__/transcript-async-subagents.jsonl' : '../lib/fixtures/session-work-codex.jsonl'
    const lines = readFileSync(new URL(fixture, import.meta.url), 'utf8').split('\n')
    const parser = liveFor(engine)!.create({ engine, codexHome: '/nonexistent/engine-live-oracle' })
    expect(engineFor(engine)!.live).toBe(liveFor(engine))
    const oracle = newFold(engine)
    parser.windowStart(128); oracle.name(128)
    for (const line of lines) {
      expect(parser.ingest(line).events).toEqual(oracle.ingest(line))
      expect(parser.turnOpen).toBe(oracle.turnOpen())
    }
    parser.closeTurn('abandoned')
    expect(parser.turnOpen).toBe(false)
    expect(parser.snapshot().turnOpen).toBe(false)
  })

  it('reports a Codex failure separately so its reason can precede its closing event', () => {
    const parser = liveFor('codex')!.create({ engine: 'codex' })
    const before = parser.snapshot()
    parser.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }))
    const open = parser.snapshot()
    expect(open.identity).not.toBe(before.identity)
    expect(open.turnOpen).toBe(true)
    const read = parser.ingest(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', error: { message: 'rate limited' } } }))
    expect(read.failure).toBe('rate limited')
    expect(read.events.some(event => event.type === 'turn_ended')).toBe(true)
    expect(parser.snapshot().turnOpen).toBe(false)
    expect(parser.ingest('{}').failure).toBeUndefined()
  })

  it('gives each parser and each turn a distinct immutable identity, including a continuation', () => {
    const parser = liveFor('claude')!.create({ engine: 'claude' })
    const idle = parser.snapshot()
    parser.ingest(prompt('one'))
    const one = parser.snapshot()
    expect(one.turnOpen).toBe(true)
    expect(one.identity).not.toBe(idle.identity)
    parser.ingest(prompt('two'))
    const two = parser.snapshot()
    expect(two.identity).not.toBe(one.identity)
    expect(one).toEqual({ identity: one.identity, turnOpen: true, continued: false })
    parser.closeTurn('hook')
    expect(two.turnOpen).toBe(true)
    parser.ingest(continuation)
    const continued = parser.snapshot()
    expect(continued.continued).toBe(true)
    expect(continued.identity).not.toBe(two.identity)
    expect(liveFor('claude')!.create({ engine: 'claude' }).snapshot().identity).not.toBe(idle.identity)
    expect(idle.turnOpen).toBe(false)
  })

  it('keeps the previous cancel semantics, but clears abandoned tools on relaunch or Stop', () => {
    const call = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } })
    const end = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } })
    for (const reason of ['cancel', 'abandoned', 'hook'] as const) {
      const parser = liveFor('claude')!.create({ engine: 'claude' })
      parser.ingest(prompt('go')); parser.ingest(call); parser.closeTurn(reason)
      expect(parser.turnOpen).toBe(false)
      // A continuation reopens without replacing the parser. Pending calls are cleared by its own
      // opener too; cancellation must still preserve the old tool-name link for a late result.
      const result = parser.ingest(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'late' }] } }))
      expect(result.events.find(event => event.type === 'tool_end')?.payload).toMatchObject({ tool: 'Read', output: 'late' })
      expect(parser.ingest(end).failure).toBeUndefined()
    }
  })

  it('retains the terminal fallback without end-first rules and refuses unknown/prototype names', () => {
    expect(liveFor('terminal')?.attachRules).toBeUndefined()
    expect(liveFor('terminal')!.create({ engine: 'terminal' }).ingest(prompt('go')).events.some(event => event.type === 'turn_started')).toBe(true)
    for (const engine of ['cursor', 'future', '__proto__', 'constructor', 'toString']) expect(liveFor(engine)).toBeUndefined()
  })
})
