import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseClaudeStream } from './lib/parse.js'

const sample = readFileSync(join(import.meta.dirname, 'test-data', 'claude-stream.jsonl'), 'utf8')

/** The sample with its `result` event swapped for another, as a run that ended differently would print it. */
function withResult(result: Record<string, unknown>): string {
  const lines = sample.trimEnd().split('\n')
  lines[lines.length - 1] = JSON.stringify({ type: 'result', session_id: 's', ...result })
  return `${lines.join('\n')}\n`
}

// The sample is a real `claude -p` 2.1.326 run of api-key-missing with the dial skill, sanitized (pilot, 2026-11-17).
describe('parseClaudeStream', () => {
  it('turns the stream into turns in order; system, rate-limit and permission events make none', () => {
    const run = parseClaudeStream(sample)
    expect(run.transcript.map((t) => `${t.role}${t.name ? `:${t.name}` : ''}`)).toEqual([
      'tool_call:Bash', 'tool_result:Bash', 'tool_call:Bash', 'tool_result:Bash', 'tool_call:Bash', 'tool_result:Bash',
      'tool_call:Bash', 'tool_result:Bash', 'tool_call:Bash', 'tool_result:Bash', 'tool_call:Read', 'tool_result:Read',
      'assistant', 'tool_call:Skill', 'tool_result:Skill', 'user', 'tool_call:Bash', 'tool_result:Bash', 'assistant',
    ])
    expect(JSON.parse(run.transcript[0].content)).toEqual({ command: 'cat package.json; ls', description: 'Show package scripts and repo files' })
    // A compound command -p refused: the refusal reaches the agent as the call's result.
    expect(run.transcript[5].content).toContain('require approval')
    expect(JSON.parse(run.transcript[13].content).skill).toBe('dial')
    expect(run.transcript[16].content).toContain('harness device notify')
    expect(run.transcript[17].content).toBe('shown')
  })

  it('takes the model, answer, usage and stop reason from the init and result events', () => {
    const run = parseClaudeStream(sample)
    expect(run.model).toBe('claude-opus-5-5')
    expect(run.answer).toMatch(/^I couldn't generate this week's report\./)
    expect(run.answer).toContain('WEATHER_API_KEY')
    expect(run.usage).toEqual({ input_tokens: 20, output_tokens: 1429, cache_read_input_tokens: 225042, cache_creation_input_tokens: 16204 })
    expect(run.stop_reason).toBe('end_turn')
    expect(run.tool_calls).toBe(8)
    expect(run.status).toBe('ok')
    expect(run.limited).toBe(false)
  })

  it('drops the empty thinking Claude Code prints when thinking is not shown, and makes no turn of it', () => {
    expect(parseClaudeStream(sample).transcript.filter((t) => 'thinking' in t)).toEqual([])
    const lines = sample.trimEnd().split('\n')
    const empty = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }] } })
    expect(parseClaudeStream([...lines.slice(0, -1), empty, lines.at(-1)].join('\n')).transcript).toHaveLength(19)
  })

  it('folds shown thinking into the turn after it', () => {
    const turn = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } })
    const run = parseClaudeStream([
      turn([{ type: 'thinking', thinking: 'Only the person can get the key.', signature: 's' }]),
      turn([{ type: 'text', text: 'I need the key.' }]),
    ].join('\n'))
    expect(run.transcript).toEqual([{ role: 'assistant', content: 'I need the key.', thinking: 'Only the person can get the key.' }])
  })

  it('marks a run stopped at --max-turns truncated', () => {
    const run = parseClaudeStream(withResult({ subtype: 'error_max_turns', is_error: true, num_turns: 41, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } }))
    expect(run.status).toBe('truncated')
    expect(run.answer).toBe('')
    expect(run.limited).toBe(false)
  })

  it('marks a run that hit the account limit limited', () => {
    const run = parseClaudeStream(withResult({ subtype: 'success', is_error: true, result: "You've hit your limit · resets 6pm", usage: { input_tokens: 0, output_tokens: 0 } }))
    expect(run.limited).toBe(true)
  })

  it('ignores a torn last line', () => {
    const run = parseClaudeStream(`${sample}{"type":"assistant","message":{"con`)
    expect(run.transcript).toHaveLength(19)
    expect(run.answer).toContain('WEATHER_API_KEY')
  })

  it('throws on a broken line before the last, naming it', () => {
    const lines = sample.trimEnd().split('\n')
    lines.splice(2, 0, '{"type":')
    expect(() => parseClaudeStream(lines.join('\n'))).toThrow(/line 3/)
  })
})
