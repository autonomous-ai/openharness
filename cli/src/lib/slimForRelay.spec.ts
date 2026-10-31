import { describe, expect, it } from 'vitest'
import { slimForRelay } from './slimForRelay.js'

const activity = { state: 'working', epoch: 'e', revision: 4, validForMs: 30_000 }
/** A transcript event as the core sends it: its envelope, and a payload carrying the ids every app reads. */
const event = (type: string, payload: Record<string, unknown>, envelope: Record<string, unknown> = {}) => ({
  type, agentId: 'a1', dbSessionId: 's1', replay: false, ...envelope,
  payload: { ...payload, activity, agentId: 'a1', sessionId: 's1', replay: false },
})
const ids = { activity, agentId: 'a1', sessionId: 's1', replay: false }

describe('slimForRelay', () => {
  it('keeps turn_started and turn_ended whole, and any frame that is not a transcript event', () => {
    for (const frame of [event('turn_started', { userMessage: 'Fix it' }), event('turn_ended', { aborted: true }),
      { type: 'agent_synced', payload: { agent: { id: 'a1' } } }, { type: 'turn_heartbeat', payload: { activity } }]) {
      expect(slimForRelay(frame)).toBe(frame)
    }
  })

  it('keeps what each event\'s readers read, and the ids, activity and replay of every one', () => {
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['user_message', { content: 'Look', images: [{ media_type: 'image/png', data: 'x'.repeat(10_000) }] }, { content: 'Look' }],
      ['text_delta', { content: 'Done.' }, { content: 'Done.' }],
      ['thinking_delta', { content: 'private thoughts', thinkingId: 't1' }, {}],
      ['thinking_title', { title: 'Planning', thinkingId: 't1', extra: 1 }, { title: 'Planning', thinkingId: 't1' }],
      ['tool_end', { id: 'u1', tool: 'Bash', output: 'secret output', outputTail: 'tail', isError: false, summary: 'ok', parentToolUseId: 'p1',
        subagent: { totalTokens: 9 }, durationSeconds: 3 }, { id: 'u1', tool: 'Bash', parentToolUseId: 'p1', isError: false }],
      ['subagent_finished', { id: 'u2', status: 'completed', summary: 'what the sub-agent said' }, { id: 'u2', status: 'completed' }],
      ['done', { result: 'r'.repeat(600) }, { result: 'r'.repeat(500) }],
      ['context_compact', { message: 'Compacted 40k tokens', trigger: 'auto' }, {}],
    ]
    for (const [type, payload, kept] of cases) {
      expect(slimForRelay(event(type, payload)), type).toEqual({ type, agentId: 'a1', dbSessionId: 's1', replay: false, payload: { ...kept, ...ids } })
    }
  })

  it('bounds a tool\'s input: strings to 200 characters, lists to 50 items, objects to 50 keys and nesting to 4 levels', () => {
    const deep = { a: { b: { c: { d: 'gone' }, kept: 'yes' } } }
    const slim = slimForRelay(event('tool_start', { id: 'u1', tool: 'Grep', parentToolUseId: 'p1',
      input: { pattern: 'p'.repeat(300), paths: Array.from({ length: 80 }, (_, i) => `f${i}`), deep, n: 3, ok: true, none: null,
        wide: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`k${i}`, i])) } }))
    const input = (slim.payload as { input: Record<string, unknown> }).input
    expect(input.pattern).toBe('p'.repeat(200))
    expect(input.paths).toEqual(Array.from({ length: 50 }, (_, i) => `f${i}`))
    expect(input.deep).toEqual({ a: { b: { kept: 'yes' } } })
    expect([input.n, input.ok, input.none]).toEqual([3, true, null])
    expect(Object.keys(input.wide as object)).toHaveLength(50)
    expect(slim.payload).toMatchObject({ id: 'u1', tool: 'Grep', parentToolUseId: 'p1', ...ids })
  })

  it('sends a 2 MB Write in under 2 KB, keeps a TodoWrite\'s list whole, and never cuts a character in half', () => {
    const write = slimForRelay(event('tool_start', { id: 'u1', tool: 'Write', input: { file_path: '/repo/big.txt', content: 'x'.repeat(2 * 1024 * 1024) } }))
    expect(JSON.stringify(write).length).toBeLessThan(2_048)
    expect((write.payload as { input: { file_path: string } }).input.file_path).toBe('/repo/big.txt')
    const todos = Array.from({ length: 10 }, (_, i) => ({ content: `Step ${i}`, status: i < 3 ? 'completed' : 'pending', activeForm: `Doing step ${i}` }))
    expect((slimForRelay(event('tool_start', { id: 'u2', tool: 'TodoWrite', input: { todos } })).payload as { input: unknown }).input).toEqual({ todos })
    const emoji = `${'a'.repeat(199)}😀tail`
    expect((slimForRelay(event('tool_start', { id: 'u3', tool: 'Bash', input: { command: emoji } })).payload as { input: { command: string } }).input.command)
      .toBe('a'.repeat(199))
  })

  it('keeps the end of a long path, where its file name is', () => {
    const path = `/Users/dev/${'deep/'.repeat(60)}src/handler.ts`
    const input = (slimForRelay(event('tool_start', { id: 'u1', tool: 'Edit', input: { file_path: path, notebook_path: path, path, old_string: path } }))
      .payload as { input: Record<string, string> }).input
    for (const key of ['file_path', 'notebook_path', 'path']) expect(input[key], key).toBe(path.slice(-200))
    expect(input.old_string).toBe(path.slice(0, 200))
  })

  it('passes on a frame whose type is a name every object has', () => {
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const frame = { type, payload: { agentId: 'a1' } }
      expect(slimForRelay(frame)).toBe(frame)
    }
  })

  it('keeps a tool input that is not an object as it is, bounded', () => {
    expect((slimForRelay(event('tool_start', { id: 'u1', tool: 'Raw', input: 'z'.repeat(500) })).payload as { input: unknown }).input).toBe('z'.repeat(200))
    expect(slimForRelay(event('tool_start', { id: 'u1', tool: 'None' })).payload).toEqual({ id: 'u1', tool: 'None', ...ids })
  })

  it('never touches the envelope, never changes what it was given, and passes a frame without a payload on', () => {
    const given = event('tool_end', { id: 'u1', tool: 'Bash', output: 'out', isError: true, summary: 's' }, { subagent: 'u0', replay: true })
    const copy = structuredClone(given)
    const slim = slimForRelay(given)
    expect(given).toEqual(copy)
    expect({ ...slim, payload: undefined }).toEqual({ ...given, payload: undefined })
    const bare = { type: 'text_delta' }
    expect(slimForRelay(bare)).toBe(bare)
  })
})
