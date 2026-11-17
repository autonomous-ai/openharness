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

describe('parseClaudeStream', () => {
  it('turns the stream into turns in order, with thinking on the turn after it', () => {
    const run = parseClaudeStream(sample)
    expect(run.transcript.map((t) => t.role)).toEqual([
      'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant',
    ])
    expect(run.transcript[0]).toEqual({ role: 'assistant', content: "I'll run the report.", thinking: 'Run the report script first.' })
    expect(run.transcript[1]).toEqual({ role: 'tool_call', name: 'Bash', content: JSON.stringify({ command: 'npm run report', description: 'Run the weekly report' }, null, 2) })
    expect(run.transcript[2]).toEqual({ role: 'tool_result', name: 'Bash', content: 'Error: WEATHER_API_KEY is not set' })
    expect(run.transcript[4].content).toBe('# Get it from the Weatherly team dashboard\nWEATHER_API_KEY=')
    expect(run.transcript[5].thinking).toBe('Only the person can get the key.')
    expect(run.transcript[5].content).toContain('harness device notify')
  })

  it('takes the model, answer, usage and stop reason from the init and result events', () => {
    const run = parseClaudeStream(sample)
    expect(run.model).toBe('claude-opus-5-5')
    expect(run.answer).toBe('The report needs WEATHER_API_KEY. Get it from the Weatherly team dashboard, set it in .env, then run npm run report.')
    expect(run.usage).toEqual({ input_tokens: 130, output_tokens: 95, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 })
    expect(run.stop_reason).toBe('end_turn')
    expect(run.tool_calls).toBe(3)
    expect(run.status).toBe('ok')
    expect(run.limited).toBe(false)
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
    expect(run.transcript).toHaveLength(8)
    expect(run.answer).toContain('WEATHER_API_KEY')
  })

  it('throws on a broken line before the last, naming it', () => {
    const lines = sample.trimEnd().split('\n')
    lines.splice(2, 0, '{"type":')
    expect(() => parseClaudeStream(lines.join('\n'))).toThrow(/line 3/)
  })
})
