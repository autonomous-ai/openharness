import { expect, it } from 'vitest'
import { gridAssignmentProcess, gridAssignmentProcessesIn, gridAssignmentAnswersIn } from './gridAssignmentWire.js'

it('forwards only the classifier variables and argument fragments, never unrelated keys or prompts', () => {
  expect(gridAssignmentProcess('a', 'claude', { ANTHROPIC_BASE_URL: 'https://grid.example/relay', ANTHROPIC_MODEL: 'm',
    ANTHROPIC_AUTH_TOKEN: 'secret', HOME: '/private-home' }, 'claude -m secret --prompt private')).toEqual({
    key: 'a', engine: 'claude', env: { ANTHROPIC_BASE_URL: 'https://grid.example/relay', ANTHROPIC_MODEL: 'm' }, args: '',
  })
  const input = gridAssignmentProcess('a', 'codex', { GRID_API_KEY: 'secret' }, 'codex --prompt private -c model_providers.grid.base_url="https://grid.example/relay/v1" -m m')!
  expect(input).toEqual({ key: 'a', engine: 'codex', env: {}, args: 'model_providers.grid.base_url="https://grid.example/relay/v1"  -m m' })
  expect(gridAssignmentProcessesIn([input])).toEqual([input])
  expect(gridAssignmentProcess('a', 'pi', {}, '--model grid/m')).toBeNull()
  expect(gridAssignmentProcess('a', 'opencode', { OPENAI_BASE_URL: 'https://grid.example/relay' }, '-m grid/m')).toBeNull()
})

it('rejects malformed, duplicate or mismatched batches instead of turning them into no assignment', () => {
  const input = gridAssignmentProcess('a', 'claude', { ANTHROPIC_BASE_URL: 'https://grid.example/relay' }, '')!
  for (const value of [null, {}, Array(4097).fill(input), [null], [{ ...input, engine: 'unknown' }],
    [{ ...input, key: 1 }], [{ ...input, args: 1 }], [{ ...input, env: null }], [{ ...input, env: { ANTHROPIC_BASE_URL: 1 } }],
    [{ ...input, env: {} }], [input, input]]) expect(gridAssignmentProcessesIn(value)).toBeNull()
  for (const value of [null, [], [null], [{ key: 'wrong', assignment: null }], [{ key: 'a' }],
    [{ key: 'a', assignment: { baseUrl: 1, model: null } }], [{ key: 'a', assignment: { baseUrl: 'url', model: 1 } }]]) {
    expect(gridAssignmentAnswersIn(value, [input])).toBeNull()
  }
  expect(gridAssignmentAnswersIn([{ key: 'a', assignment: null }], [input])).toEqual([{ key: 'a', assignment: null }])
})
